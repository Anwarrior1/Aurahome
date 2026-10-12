import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function apply(db: Database.Database, file: string): void {
  for (const sql of readFileSync(join('drizzle/migrations', file), 'utf8').split(
    '--> statement-breakpoint'
  ))
    if (sql.trim()) db.exec(sql)
}

describe('Migration 0030 — structured invoice item selections', () => {
  it('preserves historical parent/line rows and frozen JSON, backfills single selections without inventing color names', () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      for (const file of readdirSync('drizzle/migrations')
        .filter((f) => /^\d{4}.*\.sql$/.test(f) && f < '0030')
        .sort())
        apply(db, file)
      db.exec(`INSERT INTO customers (id, name) VALUES (1, 'Historical customer');
        INSERT INTO material_categories (id, name) VALUES (1, 'Wood');
        INSERT INTO materials (id, sku, name, category_id, unit, pricing_rule) VALUES (1, 'MDF', 'Live renamed MDF', 1, 'لوح', 'exact');
        INSERT INTO color_finish_catalog (id, code, name) VALUES (1, '405', 'Current renamed grey');
        INSERT INTO quotations (id, document_number, customer_id) VALUES (1, 'QT-OLD', 1);
        INSERT INTO final_invoices (id, document_number, customer_id, status, snapshot) VALUES (1, 'FI-OLD', 1, 'approved', '{"lines":[{"colorCode":"405","accessories":"Historical hinge"}]}');
        INSERT INTO orders (id, document_number, customer_id) VALUES (1, 'SO-OLD', 1);`)
      for (const [parent, owner] of [
        ['quotation_lines', 'quotation_id'],
        ['final_invoice_lines', 'final_invoice_id'],
        ['order_lines', 'order_id']
      ]) {
        db.prepare(
          `INSERT INTO ${parent} (${owner}, line_kind, description, specifications, material_type_material_id, material_type, color_code, accessory_material_id, accessories, quantity_micro, unit_price_minor, line_total_minor) VALUES (1, 'custom', 'Historical item', 'Old notes', 1, 'Historical MDF', '405', 1, 'Historical hinge', 1000000, 200000, 200000)`
        ).run()
        db.prepare(
          `INSERT INTO ${parent} (${owner}, line_kind, description, material_type, color_code, accessories, quantity_micro, unit_price_minor, line_total_minor) VALUES (1, 'custom', 'Legacy text item', 'Unlinked historical wood', 'MISSING-CODE', 'Old unlinked accessory', 1000000, 100000, 100000)`
        ).run()
      }
      const parentTables = [
        'quotations',
        'final_invoices',
        'orders',
        'quotation_lines',
        'final_invoice_lines',
        'order_lines'
      ]
      const before = parentTables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())
      db.transaction(() => apply(db, '0030_invoice_item_selections.sql'))()
      expect(parentTables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all())).toEqual(
        before
      )
      for (const prefix of ['quotation_line', 'final_invoice_line', 'order_line']) {
        expect(
          db
            .prepare(`SELECT material_id, name_snapshot FROM ${prefix}_materials ORDER BY line_id`)
            .all()
        ).toEqual([
          { material_id: 1, name_snapshot: 'Historical MDF' },
          { material_id: null, name_snapshot: 'Unlinked historical wood' }
        ])
        expect(
          db
            .prepare(
              `SELECT color_id, code_snapshot, name_snapshot FROM ${prefix}_colors ORDER BY line_id`
            )
            .all()
        ).toEqual([
          { color_id: 1, code_snapshot: '405', name_snapshot: null },
          { color_id: null, code_snapshot: 'MISSING-CODE', name_snapshot: null }
        ])
        expect(
          db.prepare(`SELECT name_snapshot FROM ${prefix}_accessories ORDER BY line_id`).all()
        ).toEqual([
          { name_snapshot: 'Historical hinge' },
          { name_snapshot: 'Old unlinked accessory' }
        ])
        expect(() =>
          db
            .prepare(
              `INSERT INTO ${prefix}_materials (line_id, material_id, position, name_snapshot) VALUES (1, 1, 9, 'duplicate')`
            )
            .run()
        ).toThrow(/UNIQUE/)
        expect(() =>
          db
            .prepare(
              `INSERT INTO ${prefix}_colors (line_id, color_id, position, code_snapshot) VALUES (1, 1, 9, 'duplicate')`
            )
            .run()
        ).toThrow(/UNIQUE/)
        expect(() =>
          db
            .prepare(
              `INSERT INTO ${prefix}_accessories (line_id, material_id, position, name_snapshot) VALUES (1, 1, 9, 'duplicate')`
            )
            .run()
        ).toThrow(/UNIQUE/)
        expect(() =>
          db
            .prepare(
              `INSERT INTO ${prefix}_materials (line_id, material_id, position, name_snapshot) VALUES (99999, 1, 9, 'orphan')`
            )
            .run()
        ).toThrow(/FOREIGN KEY/)
      }
      db.prepare('DELETE FROM color_finish_catalog WHERE id = 1').run()
      expect(
        db
          .prepare('SELECT color_id, code_snapshot FROM quotation_line_colors WHERE line_id = 1')
          .get()
      ).toEqual({ color_id: null, code_snapshot: '405' })
      db.prepare('DELETE FROM quotation_lines WHERE id = 1').run()
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM quotation_line_materials WHERE line_id = 1').get()
      ).toEqual({ count: 0 })
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM quotation_line_materials WHERE line_id = 2').get()
      ).toEqual({ count: 1 })
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally {
      db.close()
    }
  })

  it('follows the existing installation migration timestamp', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>
    }
    const current = journal.entries.find((e) => e.idx === 30)!
    expect(current.tag).toBe('0030_invoice_item_selections')
    expect(current.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 29)!.when)
  })
})
