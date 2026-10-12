import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Migration safety for 0003 (item 23/25).
 *
 * It renames conversion_unit/conversion_factor_micro to
 * purchase_unit/purchase_unit_factor_micro and adds tracks_dimensions,
 * backfilled from whichever existing rows already carry a dimension or
 * thickness value. These tests run it against a database seeded with
 * realistic pre-migration materials — including one with legacy
 * conversion data — and prove every row and its FIFO history survive
 * with the correct backfilled capability flag.
 */
function applyFile(db: Database.Database, file: string): void {
  const sql = readFileSync(join('drizzle/migrations', file), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed) db.exec(trimmed)
  }
}

function databaseAt0002(): Database.Database {
  const db = new Database(':memory:')
  applyFile(db, '0000_overconfident_doctor_octopus.sql')
  applyFile(db, '0001_big_lyja.sql')
  applyFile(db, '0002_planned_materials.sql')

  db.exec(`
    INSERT INTO material_categories (id, name, created_at) VALUES (1, 'أخشاب', '2026-01-01');
    -- A board material that already carries dimensions/thickness.
    INSERT INTO materials (id, sku, name, category_id, unit, dimensions, thickness, current_market_price_micro, pricing_rule, created_at)
      VALUES (1, 'MDF-001', 'mdf', 1, 'لوح', '1.5 meter', '18mm', 150000000, 'exact', '2026-01-01');
    -- A material with legacy (unused) conversion_unit/conversion_factor_micro data.
    INSERT INTO materials (id, sku, name, category_id, unit, conversion_unit, conversion_factor_micro, current_market_price_micro, pricing_rule, created_at)
      VALUES (2, 'HNG-001', 'hinge', 1, 'قطعة', 'box', 50000000, 5000000, 'exact', '2026-01-01');
    -- A material with neither dimensions nor conversion data.
    INSERT INTO materials (id, sku, name, category_id, unit, current_market_price_micro, pricing_rule, created_at)
      VALUES (3, 'GLU-001', 'glue', 1, 'لتر', 20000000, 'exact', '2026-01-01');

    INSERT INTO fifo_layers (id, material_id, source_kind, qty_received_micro, qty_remaining_micro, unit_cost_micro, received_at, seq, created_at)
      VALUES (1, 1, 'purchase', 10000000, 10000000, 150000000, '2026-01-02', 1, '2026-01-02');
  `)
  return db
}

describe('Migration 0003 — generic material master (item 23/25)', () => {
  it('applies cleanly and passes integrity/foreign-key checks', () => {
    const db = databaseAt0002()
    expect(() => applyFile(db, '0003_generic_materials.sql')).not.toThrow()
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
  })

  it('preserves every material row and its FIFO layer', () => {
    const db = databaseAt0002()
    const before = db.prepare('SELECT COUNT(*) c FROM materials').get()
    const beforeLayers = db.prepare('SELECT COUNT(*) c FROM fifo_layers').get()

    applyFile(db, '0003_generic_materials.sql')

    expect(db.prepare('SELECT COUNT(*) c FROM materials').get()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) c FROM fifo_layers').get()).toEqual(beforeLayers)
    const layer = db.prepare('SELECT * FROM fifo_layers WHERE id = 1').get() as Record<string, number>
    expect(layer.unit_cost_micro).toBe(150000000)
    expect(layer.qty_remaining_micro).toBe(10000000)
  })

  it('renames conversion_unit/conversion_factor_micro to purchase_unit/purchase_unit_factor_micro, carrying legacy values across', () => {
    const db = databaseAt0002()
    applyFile(db, '0003_generic_materials.sql')

    const columns = (db.prepare('PRAGMA table_info(materials)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(columns).not.toContain('conversion_unit')
    expect(columns).not.toContain('conversion_factor_micro')
    expect(columns).toContain('purchase_unit')
    expect(columns).toContain('purchase_unit_factor_micro')
    expect(columns).toContain('tracks_dimensions')

    // The material that had legacy conversion data keeps it, renamed.
    const hinge = db.prepare('SELECT purchase_unit, purchase_unit_factor_micro FROM materials WHERE id = 2').get() as Record<string, unknown>
    expect(hinge.purchase_unit).toBe('box')
    expect(hinge.purchase_unit_factor_micro).toBe(50000000)
  })

  it('backfills tracks_dimensions=true only for rows that already had dimensions/thickness', () => {
    const db = databaseAt0002()
    applyFile(db, '0003_generic_materials.sql')

    const rows = db.prepare('SELECT id, tracks_dimensions FROM materials ORDER BY id').all() as Array<{ id: number; tracks_dimensions: number }>
    expect(rows.find((r) => r.id === 1)?.tracks_dimensions).toBe(1) // mdf: had dimensions+thickness
    expect(rows.find((r) => r.id === 2)?.tracks_dimensions).toBe(0) // hinge: no dimensions
    expect(rows.find((r) => r.id === 3)?.tracks_dimensions).toBe(0) // glue: no dimensions
  })

  it('a material with no legacy conversion data ends up with purchase_unit still null (no invented conversion)', () => {
    const db = databaseAt0002()
    applyFile(db, '0003_generic_materials.sql')

    const glue = db.prepare('SELECT purchase_unit, purchase_unit_factor_micro FROM materials WHERE id = 3').get() as Record<string, unknown>
    expect(glue.purchase_unit).toBeNull()
    expect(glue.purchase_unit_factor_micro).toBeNull()
  })
})
