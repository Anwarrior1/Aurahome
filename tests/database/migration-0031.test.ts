import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function statements(file: string): string[] { return readFileSync(join('drizzle/migrations', file), 'utf8').split('--> statement-breakpoint').filter(s => s.trim()) }
function apply(db: Database.Database, file: string): void { for (const sql of statements(file)) db.exec(sql) }
function legacyDatabase(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const file of readdirSync('drizzle/migrations').filter(f => /^\d{4}.*\.sql$/.test(f) && f < '0030').sort()) apply(db, file)
  db.exec(`INSERT INTO customers (id, name) VALUES (1, 'Historical customer');
    INSERT INTO material_categories (id, name) VALUES (1, 'Wood');
    INSERT INTO materials (id, sku, name, category_id, unit, pricing_rule) VALUES
      (1, 'CONTOUR', 'Live renamed contour', 1, 'لوح', 'exact'), (2, 'MDF', 'MDF live name', 1, 'لوح', 'exact'), (3, 'HDF', 'HDF', 1, 'لوح', 'exact');
    INSERT INTO color_finish_catalog (id, code, name, related_material_id) VALUES
      (1, '405', 'RED current', 1), (2, '410', 'Walnut current', 1), (3, 'DEMO-G', 'Grey current', 2), (4, 'UNLINKED', 'Unlinked', NULL), (5, 'HDF-COLOR', 'White', 3);
    INSERT INTO quotations (id, document_number, customer_id) VALUES (1, 'QT-OLD', 1);
    INSERT INTO final_invoices (id, document_number, customer_id, status, snapshot) VALUES (1, 'FI-OLD', 1, 'approved', '{"lines":[{"colorCode":"405","accessories":"Historical hinge"}]}');
    INSERT INTO orders (id, document_number, customer_id) VALUES (1, 'SO-OLD', 1);`)
  for (const [parent, owner] of [['quotation_lines', 'quotation_id'], ['final_invoice_lines', 'final_invoice_id'], ['order_lines', 'order_id']]) {
    db.prepare(`INSERT INTO ${parent} (${owner}, line_kind, description, material_type_material_id, material_type, color_code, quantity_micro, unit_price_minor, line_total_minor) VALUES (1, 'custom', 'Historical item', 1, 'Contour 18 historical', '405', 1000000, 200000, 200000)`).run()
    db.prepare(`INSERT INTO ${parent} (${owner}, line_kind, description, quantity_micro, unit_price_minor, line_total_minor) VALUES (1, 'custom', 'Independent second item', 1000000, 100000, 100000)`).run()
  }
  apply(db, '0030_invoice_item_selections.sql')
  return db
}
function addFlat0030Selections(db: Database.Database): void {
  for (const prefix of ['quotation_line', 'final_invoice_line', 'order_line']) {
    db.exec(`INSERT INTO ${prefix}_materials (id, line_id, material_id, position, name_snapshot) VALUES
      (2, 1, 2, 1, 'MDF 16 historical'), (3, 2, 1, 0, 'Contour second item'), (4, 1, NULL, 2, 'HDF');
      UPDATE ${prefix}_colors SET name_snapshot = 'RED historical' WHERE id = 1;
      INSERT INTO ${prefix}_colors (line_id, color_id, position, code_snapshot, name_snapshot) VALUES
      (1, 2, 1, '410', 'Walnut historical'), (1, 3, 2, 'DEMO-G', 'Grey historical'), (1, 4, 3, 'UNLINKED', 'Unlinked historical'),
      (1, 5, 4, 'HDF-COLOR', 'White historical'), (1, NULL, 5, 'UNKNOWN-OLD', NULL), (2, 1, 0, '405', 'RED second item');`)
  }
}
const colorProjection = 'id, line_id, color_id, position, code_snapshot, name_snapshot'

describe('0031 refines applied 0030 Material → Colors tables', () => {
  it('maps only exact catalog material IDs, preserves all snapshots and parents, leaves ambiguous data readable, and enforces ownership/cascade', () => {
    const db = legacyDatabase()
    try {
      addFlat0030Selections(db)
      const parents = ['quotations', 'final_invoices', 'orders', 'quotation_lines', 'final_invoice_lines', 'order_lines']
      const oldParents = parents.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())
      const oldColors = ['quotation_line', 'final_invoice_line', 'order_line'].map(p => db.prepare(`SELECT ${colorProjection} FROM ${p}_colors ORDER BY id`).all())
      db.transaction(() => apply(db, '0031_material_color_groups.sql'))()
      expect(parents.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())).toEqual(oldParents)
      expect(['quotation_line', 'final_invoice_line', 'order_line'].map(p => db.prepare(`SELECT ${colorProjection} FROM ${p}_colors ORDER BY id`).all())).toEqual(oldColors)
      for (const prefix of ['quotation_line', 'final_invoice_line', 'order_line']) {
        expect(db.prepare(`SELECT material_selection_id FROM ${prefix}_colors ORDER BY id`).all()).toEqual([1, 1, 2, null, null, null, 3].map(material_selection_id => ({ material_selection_id })))
        // A same-named HDF legacy text row must not receive HDF's catalog color.
        expect(db.prepare(`SELECT material_selection_id FROM ${prefix}_colors WHERE code_snapshot = 'HDF-COLOR'`).get()).toEqual({ material_selection_id: null })
        expect(() => db.prepare(`UPDATE ${prefix}_colors SET material_selection_id = 3 WHERE id = 1`).run()).toThrow(/FOREIGN KEY/)
        expect(() => db.prepare(`UPDATE ${prefix}_colors SET material_selection_id = 99999 WHERE id = 1`).run()).toThrow(/FOREIGN KEY/)
        expect(() => db.prepare(`INSERT INTO ${prefix}_colors (line_id, material_selection_id, color_id, position, code_snapshot) VALUES (1, 1, 1, 9, 'duplicate')`).run()).toThrow(/UNIQUE/)
        db.prepare(`DELETE FROM ${prefix}_materials WHERE id = 1`).run()
        expect(db.prepare(`SELECT code_snapshot FROM ${prefix}_colors WHERE line_id = 1 ORDER BY position`).all()).toEqual(['DEMO-G', 'UNLINKED', 'HDF-COLOR', 'UNKNOWN-OLD'].map(code_snapshot => ({ code_snapshot })))
        expect(db.prepare(`SELECT code_snapshot FROM ${prefix}_colors WHERE line_id = 2`).all()).toEqual([{ code_snapshot: '405' }])
      }
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally { db.close() }
  })

  it('supports pre-0030 historical single selections without inventing missing color names', () => {
    const db = legacyDatabase()
    try {
      db.transaction(() => apply(db, '0031_material_color_groups.sql'))()
      expect(db.prepare('SELECT material_selection_id, code_snapshot, name_snapshot FROM quotation_line_colors').all()).toEqual([{ material_selection_id: 1, code_snapshot: '405', name_snapshot: null }])
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally { db.close() }
  })

  it('rolls back all table/schema/data changes if migration fails midway', () => {
    const db = legacyDatabase()
    try {
      addFlat0030Selections(db)
      const before = db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
      const rows = db.prepare('SELECT * FROM quotation_line_colors ORDER BY id').all()
      expect(() => db.transaction(() => {
        for (const sql of statements('0031_material_color_groups.sql')) {
          if (sql.includes('DROP TABLE `final_invoice_line_colors`')) throw new Error('forced migration failure')
          db.exec(sql)
        }
      })()).toThrow(/forced migration failure/)
      expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual(before)
      expect(db.prepare('SELECT * FROM quotation_line_colors ORDER BY id').all()).toEqual(rows)
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally { db.close() }
  })

  it('is a new strictly ordered migration following unchanged 0030 history', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as { entries: Array<{ idx: number; when: number; tag: string }> }
    expect(journal.entries.find(e => e.idx === 30)!.tag).toBe('0030_invoice_item_selections')
    const current = journal.entries.find(e => e.idx === 31)!
    expect(current.tag).toBe('0031_material_color_groups')
    expect(current.when).toBeGreaterThan(journal.entries.find(e => e.idx === 30)!.when)
  })
})
