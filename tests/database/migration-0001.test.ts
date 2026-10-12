import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Migration safety (item 40).
 *
 * 0001 relaxes four `order_id` columns from NOT NULL to nullable, which
 * SQLite can only do by rebuilding the table. These tests prove the
 * rebuild carries every existing row across unchanged, backfills the new
 * production-order lifecycle from the order it belongs to, and leaves no
 * foreign key dangling — run against a database seeded with pre-migration
 * data, the way a real installation would be.
 */
function applyFile(db: Database.Database, file: string): void {
  const sql = readFileSync(join('drizzle/migrations', file), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed) db.exec(trimmed)
  }
}

/** A database at migration 0000 holding realistic business data. */
function seededLegacyDatabase(): Database.Database {
  const db = new Database(':memory:')
  applyFile(db, '0000_overconfident_doctor_octopus.sql')

  db.exec(`
    INSERT INTO customers (id, name, created_at) VALUES (1, 'عميل قديم', '2026-01-01');
    INSERT INTO material_categories (id, name, created_at) VALUES (1, 'أخشاب', '2026-01-01');
    INSERT INTO materials (id, sku, name, category_id, unit, current_market_price_micro, pricing_rule, created_at)
      VALUES (1, 'M-1', 'لوح', 1, 'لوح', 150000000, 'exact', '2026-01-01');
    INSERT INTO machines (id, name, costing_unit, default_rate_micro, created_at)
      VALUES (1, 'آلة', 'لوح', 30000000, '2026-01-01');
    INSERT INTO workers (id, name, created_at) VALUES (1, 'عامل', '2026-01-01');

    -- Three orders in three different states, each with a work sheet.
    INSERT INTO orders (id, document_number, customer_id, status, total_minor, paid_minor, remaining_minor, completed_at, cancelled_at, cancel_reason, created_at)
      VALUES (1, 'SO-2026-0001', 1, 'completed', 10000000, 10000000, 0, '2026-02-01T10:00:00Z', NULL, NULL, '2026-01-02');
    INSERT INTO orders (id, document_number, customer_id, status, total_minor, paid_minor, remaining_minor, completed_at, cancelled_at, cancel_reason, created_at)
      VALUES (2, 'SO-2026-0002', 1, 'confirmed', 5000000, 3000000, 2000000, NULL, NULL, NULL, '2026-01-03');
    INSERT INTO orders (id, document_number, customer_id, status, total_minor, paid_minor, remaining_minor, completed_at, cancelled_at, cancel_reason, created_at)
      VALUES (3, 'SO-2026-0003', 1, 'cancelled', 4000000, 1000000, 3000000, NULL, '2026-02-05T09:00:00Z', 'طلب العميل', '2026-01-04');

    INSERT INTO work_sheets (id, document_number, order_id, issued_at, notes, created_by, created_at)
      VALUES (1, 'MO-2026-0001', 1, '2026-01-10T08:00:00Z', 'ملاحظة قديمة', 1, '2026-01-10');
    INSERT INTO work_sheets (id, document_number, order_id, issued_at, notes, created_by, created_at)
      VALUES (2, 'MO-2026-0002', 2, '2026-01-11T08:00:00Z', NULL, 1, '2026-01-11');
    INSERT INTO work_sheets (id, document_number, order_id, issued_at, notes, created_by, created_at)
      VALUES (3, 'MO-2026-0003', 3, '2026-01-12T08:00:00Z', NULL, 1, '2026-01-12');

    INSERT INTO order_material_lines (id, order_id, material_id, physical_qty_micro, actual_cost_minor, commercial_qty_micro, commercial_value_minor, pricing_rule_used, created_at)
      VALUES (1, 1, 1, 10000000, 1000000, 10000000, 1500000, 'exact', '2026-01-10');
    INSERT INTO order_machine_usage (id, order_id, machine_id, usage_qty_micro, rate_micro, calculated_minor, final_amount_minor, created_at)
      VALUES (1, 1, 1, 10000000, 30000000, 300000, 300000, '2026-01-10');
    INSERT INTO order_worker_assignments (id, order_id, worker_id, method, amount_minor, earned, earned_at)
      VALUES (1, 1, 1, 'fixed', 500000, 1, '2026-02-01T10:00:00Z');
  `)
  return db
}

describe('Migration 0001 — production workflow (item 40)', () => {
  it('applies cleanly on top of an existing seeded database', () => {
    const db = seededLegacyDatabase()
    expect(() => applyFile(db, '0001_big_lyja.sql')).not.toThrow()
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
  })

  it('preserves every existing row through the table rebuilds', () => {
    const db = seededLegacyDatabase()
    const before = {
      orders: db.prepare('SELECT COUNT(*) c FROM orders').get(),
      sheets: db.prepare('SELECT COUNT(*) c FROM work_sheets').get(),
      materials: db.prepare('SELECT COUNT(*) c FROM order_material_lines').get(),
      machines: db.prepare('SELECT COUNT(*) c FROM order_machine_usage').get(),
      workers: db.prepare('SELECT COUNT(*) c FROM order_worker_assignments').get()
    }

    applyFile(db, '0001_big_lyja.sql')

    expect(db.prepare('SELECT COUNT(*) c FROM orders').get()).toEqual(before.orders)
    expect(db.prepare('SELECT COUNT(*) c FROM work_sheets').get()).toEqual(before.sheets)
    expect(db.prepare('SELECT COUNT(*) c FROM order_material_lines').get()).toEqual(before.materials)
    expect(db.prepare('SELECT COUNT(*) c FROM order_machine_usage').get()).toEqual(before.machines)
    expect(db.prepare('SELECT COUNT(*) c FROM order_worker_assignments').get()).toEqual(before.workers)

    // Values, not just counts, survive intact.
    const line = db.prepare('SELECT * FROM order_material_lines WHERE id = 1').get() as Record<string, number>
    expect(line.order_id).toBe(1)
    expect(line.actual_cost_minor).toBe(1000000)
    expect(line.physical_qty_micro).toBe(10000000)
    const sheet = db.prepare('SELECT * FROM work_sheets WHERE id = 1').get() as Record<string, string>
    expect(sheet.document_number).toBe('MO-2026-0001')
    expect(sheet.notes).toBe('ملاحظة قديمة')
  })

  it('backfills each historical work sheet with the lifecycle its order implies', () => {
    const db = seededLegacyDatabase()
    applyFile(db, '0001_big_lyja.sql')

    const rows = db.prepare('SELECT id, status, completed_at, cancel_reason FROM work_sheets ORDER BY id').all() as Array<Record<string, string | null>>
    // Completed order → completed production carrying the order's date.
    expect(rows[0]?.status).toBe('completed')
    expect(rows[0]?.completed_at).toBe('2026-02-01T10:00:00Z')
    // Live order → in production, so it is not stranded behind a gate.
    expect(rows[1]?.status).toBe('in_production')
    expect(rows[1]?.completed_at).toBeNull()
    // Cancelled order → cancelled production, with the reason carried.
    expect(rows[2]?.status).toBe('cancelled')
    expect(rows[2]?.cancel_reason).toBe('طلب العميل')
  })

  it('links historical postings to the production order of their own order', () => {
    const db = seededLegacyDatabase()
    applyFile(db, '0001_big_lyja.sql')

    // Order 1's material/machine/labour rows now also point at MO-2026-0001.
    expect((db.prepare('SELECT work_sheet_id w FROM order_material_lines WHERE id = 1').get() as { w: number }).w).toBe(1)
    expect((db.prepare('SELECT work_sheet_id w FROM order_machine_usage WHERE id = 1').get() as { w: number }).w).toBe(1)
    expect((db.prepare('SELECT work_sheet_id w FROM order_worker_assignments WHERE id = 1').get() as { w: number }).w).toBe(1)
  })

  it('makes order_id nullable on the four rebuilt tables, and adds the new tables', () => {
    const db = seededLegacyDatabase()
    applyFile(db, '0001_big_lyja.sql')

    for (const table of ['work_sheets', 'order_material_lines', 'order_machine_usage', 'order_worker_assignments']) {
      const orderIdColumn = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
        .find((column) => column.name === 'order_id')
      expect(orderIdColumn?.notnull, `${table}.order_id must be nullable`).toBe(0)
    }

    for (const table of ['work_sheet_stages', 'finished_goods_movements', 'final_invoices', 'delivery_workers']) {
      const exists = db.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { c: number }
      expect(exists.c, `${table} must exist`).toBe(1)
    }

    // A stock production order — no customer order — is now storable.
    expect(() => db.exec(`
      INSERT INTO products (id, code, name, default_price_minor, created_at) VALUES (1, 'P1', 'منتج', 0, '2026-01-01');
      INSERT INTO work_sheets (document_number, product_id, quantity_micro, status, issued_at, created_at)
        VALUES ('MO-2026-0099', 1, 2000000, 'ready', '2026-03-01', '2026-03-01');
    `)).not.toThrow()
  })
})
