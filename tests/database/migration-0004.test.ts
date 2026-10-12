import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function applyFile(db: Database.Database, file: string): void {
  const source = readFileSync(join('drizzle/migrations', file), 'utf8')
  for (const statement of source.split('--> statement-breakpoint')) {
    const sql = statement.trim()
    if (sql) db.exec(sql)
  }
}

function databaseAt0003(): Database.Database {
  const db = new Database(':memory:')
  for (const file of [
    '0000_overconfident_doctor_octopus.sql',
    '0001_big_lyja.sql',
    '0002_planned_materials.sql',
    '0003_generic_materials.sql'
  ]) applyFile(db, file)
  db.pragma('foreign_keys = ON')
  db.exec(`
    INSERT INTO material_categories (id, name) VALUES (1, 'أخشاب');
    INSERT INTO materials (id, sku, name, category_id, unit, current_market_price_micro, pricing_rule)
      VALUES (1, 'M1', 'لوح', 1, 'لوح', 100000000, 'exact');
    INSERT INTO suppliers (id, name) VALUES (1, 'مورد');
    INSERT INTO purchases (id, document_number, supplier_id, purchase_date, total_minor)
      VALUES (1, 'PO-2026-0001', 1, '2026-09-01', 1000000);
    INSERT INTO purchase_lines (id, purchase_id, material_id, qty_micro, unit_cost_micro, line_total_minor)
      VALUES (1, 1, 1, 10000000, 100000000, 1000000);
    INSERT INTO fifo_layers (id, material_id, source_kind, source_ref_id, qty_received_micro, qty_remaining_micro, unit_cost_micro, received_at, seq)
      VALUES (1, 1, 'purchase', 1, 10000000, 10000000, 100000000, '2026-09-01T00:00:00.000Z', 1);
    INSERT INTO inventory_movements (id, material_id, kind, qty_micro, actual_cost_minor, created_at)
      VALUES (1, 1, 'purchase', 10000000, 1000000, '2026-09-01T00:00:00.000Z');
    INSERT INTO order_material_lines (id, material_id, movement_id, physical_qty_micro, actual_cost_minor, commercial_qty_micro, commercial_value_minor, pricing_rule_used)
      VALUES (1, 1, 1, 1000000, 100000, 1000000, 100000, 'exact');
  `)
  return db
}

describe('Migration 0004 — safe correction metadata', () => {
  it('has a forward-only journal timestamp so an existing 0003 database receives it', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number }>
    }
    const previous = journal.entries.find((entry) => entry.idx === 3)!
    const current = journal.entries.find((entry) => entry.idx === 4)!
    expect(current.when).toBeGreaterThan(previous.when)
  })

  it('preserves rows, backfills unambiguous purchase links, and passes SQLite checks', () => {
    const db = databaseAt0003()
    const before = {
      movements: db.prepare('SELECT COUNT(*) c FROM inventory_movements').get(),
      consumption: db.prepare('SELECT COUNT(*) c FROM order_material_lines').get()
    }
    applyFile(db, '0004_medical_centennial.sql')

    expect(db.prepare('SELECT COUNT(*) c FROM inventory_movements').get()).toEqual(before.movements)
    expect(db.prepare('SELECT COUNT(*) c FROM order_material_lines').get()).toEqual(before.consumption)
    expect(db.prepare('SELECT source_kind sourceKind, source_ref_id sourceRefId FROM inventory_movements WHERE id = 1').get())
      .toEqual({ sourceKind: 'purchase', sourceRefId: 1 })
    expect(db.prepare('SELECT status FROM order_material_lines WHERE id = 1').get()).toEqual({ status: 'active' })
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db.pragma('foreign_key_check')).toHaveLength(0)
    db.close()
  })
})
