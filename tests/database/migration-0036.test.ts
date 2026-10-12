import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

const folder = 'drizzle/migrations/'
function apply(db: Database.Database, file: string): void {
  for (const statement of readFileSync(folder + file, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }
}

describe('0036 material classification leaf semantics', () => {
  it('classifies only stable legacy facts and preserves every inventory/history row', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const file of readdirSync(folder)
      .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0036')
      .sort())
      apply(db, file)

    db.exec(`
      INSERT INTO material_categories (id,name,parent_id) VALUES
        (1,'Wood',NULL), (2,'MDF',1), (3,'MDF 18',2),
        (4,'خام',3), (5,'Deep unknown',4),
        (6,'Legacy material parent',1), (7,'Its child',6);
      INSERT INTO materials
        (id,sku,name,category_id,hierarchy_node_id,unit,current_market_price_micro,pricing_rule)
      VALUES
        (1,'RAW-1','خام',4,4,'لوح',0,'exact'),
        (2,'LEG-P','Legacy material parent',6,6,'لوح',0,'exact');
      INSERT INTO inventory_movements
        (material_id,kind,qty_micro,source_kind,reason)
      VALUES (1,'opening',5000000,'opening','historical');
    `)
    const materialsBefore = db
      .prepare('SELECT id,sku,name,category_id,hierarchy_node_id FROM materials ORDER BY id')
      .all()
    const movementsBefore = db.prepare('SELECT * FROM inventory_movements ORDER BY id').all()

    apply(db, '0036_material_classification_leaf.sql')

    expect(db.prepare('SELECT id,node_kind FROM material_categories ORDER BY id').all()).toEqual([
      { id: 1, node_kind: 'main_category' },
      { id: 2, node_kind: 'material_family' },
      { id: 3, node_kind: 'material_type' },
      { id: 4, node_kind: 'legacy_ambiguous' },
      { id: 5, node_kind: 'legacy_ambiguous' },
      { id: 6, node_kind: 'legacy_ambiguous' },
      { id: 7, node_kind: 'legacy_ambiguous' }
    ])
    // Node 4 is linked but has a child, so migration deliberately refuses
    // to guess whether it is organizational or stockable.
    expect(
      db
        .prepare(
          'SELECT id,sku,name,category_id,hierarchy_node_id,color_id FROM materials ORDER BY id'
        )
        .all()
    ).toEqual(materialsBefore.map((row) => ({ ...row, color_id: null })))
    expect(db.prepare('SELECT * FROM inventory_movements ORDER BY id').all()).toEqual(
      movementsBefore
    )
    expect(db.pragma('foreign_key_list(materials)')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'color_finish_catalog', from: 'color_id', to: 'id' })
      ])
    )
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('recognizes an existing linked node with no children as a real legacy inventory leaf', () => {
    const db = new Database(':memory:')
    for (const file of readdirSync(folder)
      .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0036')
      .sort())
      apply(db, file)
    db.exec(`
      INSERT INTO material_categories (id,name,parent_id) VALUES (1,'Wood',NULL),(2,'Legacy leaf',1);
      INSERT INTO materials
        (sku,name,category_id,hierarchy_node_id,unit,current_market_price_micro,pricing_rule)
      VALUES ('LEG-1','Legacy leaf',2,2,'لوح',0,'exact');
    `)
    apply(db, '0036_material_classification_leaf.sql')
    expect(db.prepare('SELECT node_kind FROM material_categories WHERE id=2').get()).toEqual({
      node_kind: 'inventory_leaf'
    })
    db.close()
  })

  it('retains its own monotonic journal entry after later migrations', () => {
    const journal = JSON.parse(readFileSync(folder + 'meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    expect(journal.entries.find((entry) => entry.idx === 36)).toMatchObject({
      idx: 36,
      tag: '0036_material_classification_leaf'
    })
    expect(journal.entries.at(-1)!.when).toBeGreaterThan(journal.entries.at(-2)!.when)
  })
})
