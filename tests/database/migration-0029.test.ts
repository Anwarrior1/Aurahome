import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function apply(db: Database.Database, file: string): void {
  for (const statement of readFileSync(join('drizzle/migrations', file), 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }
}

describe('Color material reference migration', () => {
  it('preserves legacy records and backfills only exact unique material names with a valid nullable FK', () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      for (const file of readdirSync('drizzle/migrations').filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0029').sort()) apply(db, file)
      db.exec(`INSERT INTO material_categories (id, name) VALUES (1, 'Wood');
        INSERT INTO materials (id, sku, name, category_id, unit, current_market_price_micro, pricing_rule) VALUES
          (1, 'MDF-18', 'MDF 18mm', 1, 'لوح', 100000000, 'exact'),
          (2, 'SAME-A', 'Ambiguous', 1, 'لوح', 100000000, 'exact'),
          (3, 'SAME-B', 'Ambiguous', 1, 'لوح', 100000000, 'exact');
        INSERT INTO color_finish_catalog (code, name, related_material_type, notes) VALUES
          ('101', 'White', 'MDF 18mm', 'keep notes'),
          ('102', 'Black', 'Ambiguous', 'keep notes'),
          ('103', 'Grey', 'Unknown legacy', 'keep notes'),
          ('104', 'None', NULL, 'keep notes');`)
      const old = db.prepare('SELECT * FROM color_finish_catalog ORDER BY id').all() as Array<Record<string, unknown>>
      apply(db, '0029_color_material_reference.sql')
      const migrated = db.prepare('SELECT * FROM color_finish_catalog ORDER BY id').all() as Array<Record<string, unknown>>
      expect(migrated).toEqual(old.map((row, index) => ({ ...row, related_material_id: index === 0 ? 1 : null })))
      expect(() => db.prepare('UPDATE color_finish_catalog SET related_material_id = 99999 WHERE code = ?').run('101')).toThrow(/FOREIGN KEY/)
      db.prepare('DELETE FROM materials WHERE id = 1').run()
      expect(db.prepare('SELECT related_material_id, related_material_type FROM color_finish_catalog WHERE code = ?').get('101'))
        .toEqual({ related_material_id: null, related_material_type: 'MDF 18mm' })
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally { db.close() }
  })

  it('is ordered after the previous migration so existing installations apply it', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as { entries: Array<{ idx: number; when: number; tag: string }> }
    const previous = journal.entries.find((entry) => entry.idx === 28)!
    const current = journal.entries.find((entry) => entry.idx === 29)!
    expect(current.when).toBeGreaterThan(previous.when)
    expect(current.tag).toBe('0029_color_material_reference')
  })
})
