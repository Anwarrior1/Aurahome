import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function applyFile(db: Database.Database, file: string): void {
  const source = readFileSync(join('drizzle/migrations', file), 'utf8')
  for (const statement of source.split('--> statement-breakpoint')) {
    const sql = statement.trim()
    if (sql) db.exec(sql)
  }
}

describe('Migration 0026 — hierarchy-backed Raw Materials', () => {
  it('adds nullable identity columns without converting or changing legacy inventory history', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    const earlier = readdirSync('drizzle/migrations')
      .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0026')
      .sort()
    for (const file of earlier) applyFile(db, file)

    db.prepare("INSERT INTO material_categories (name) VALUES ('Wood')").run()
    db.prepare("INSERT INTO material_categories (name, parent_id) VALUES ('Legacy child', 1)").run()
    db.prepare(
      "INSERT INTO materials (sku, name, category_id, unit, current_market_price_micro, pricing_rule) VALUES ('LEG-1', 'Legacy material', 2, 'لوح', 0, 'exact')"
    ).run()
    db.prepare(
      "INSERT INTO fifo_layers (material_id, source_kind, qty_received_micro, qty_remaining_micro, unit_cost_micro, received_at, seq) VALUES (1, 'opening', 5000000, 5000000, 10000000, '2025-01-01', 1)"
    ).run()
    db.prepare(
      "INSERT INTO inventory_movements (material_id, kind, qty_micro, source_kind, reason) VALUES (1, 'opening', 5000000, 'opening', 'historical')"
    ).run()

    expect(() => applyFile(db, '0026_smiling_mikhail_rasputin.sql')).not.toThrow()
    expect(
      db.prepare('SELECT hierarchy_node_id, creation_key FROM materials WHERE id = 1').get()
    ).toEqual({ hierarchy_node_id: null, creation_key: null })
    expect(db.pragma('foreign_key_list(materials)')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'material_categories',
          from: 'hierarchy_node_id',
          to: 'id'
        })
      ])
    )
    expect(
      (db.pragma('index_list(materials)') as Array<{ name: string; unique: number }>).filter(
        (index) =>
          ['materials_hierarchy_node_unique', 'materials_creation_key_unique'].includes(index.name)
      )
    ).toEqual([expect.objectContaining({ unique: 1 }), expect.objectContaining({ unique: 1 })])
    expect(
      db.prepare('SELECT kind, qty_micro FROM inventory_movements WHERE material_id = 1').get()
    ).toEqual({ kind: 'opening', qty_micro: 5000000 })
    expect(
      db
        .prepare('SELECT source_kind, qty_remaining_micro FROM fifo_layers WHERE material_id = 1')
        .get()
    ).toEqual({ source_kind: 'opening', qty_remaining_micro: 5000000 })
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('keeps the migration journal strictly increasing', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    const previous = journal.entries.find((entry) => entry.idx === 25)!
    const current = journal.entries.find((entry) => entry.idx === 26)!
    expect(current.when).toBeGreaterThan(previous.when)
    expect(current.tag).toBe('0026_smiling_mikhail_rasputin')
  })
})
