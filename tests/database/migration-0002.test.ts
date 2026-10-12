import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Migration safety for 0002 (item 25).
 *
 * It adds the planned-line tables and drops work_sheet_stages. The drop
 * is the sensitive part: these tests prove it runs on a database that
 * already has stage rows, and that every production order — with its
 * number, order link, status and timestamps — survives untouched.
 */
function applyFile(db: Database.Database, file: string): void {
  const sql = readFileSync(join('drizzle/migrations', file), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed) db.exec(trimmed)
  }
}

/** A database at 0001 with production orders and stage progress on them. */
function databaseAt0001(): Database.Database {
  const db = new Database(':memory:')
  applyFile(db, '0000_overconfident_doctor_octopus.sql')
  applyFile(db, '0001_big_lyja.sql')

  db.exec(`
    INSERT INTO customers (id, name, created_at) VALUES (1, 'عميل', '2026-01-01');
    INSERT INTO material_categories (id, name, created_at) VALUES (1, 'أخشاب', '2026-01-01');
    INSERT INTO materials (id, sku, name, category_id, unit, current_market_price_micro, pricing_rule, created_at)
      VALUES (1, 'M-1', 'لوح', 1, 'لوح', 150000000, 'exact', '2026-01-01');
    INSERT INTO products (id, code, name, default_price_minor, created_at) VALUES (1, 'P1', 'منتج', 0, '2026-01-01');
    INSERT INTO workers (id, name, created_at) VALUES (1, 'عامل', '2026-01-01');
    INSERT INTO orders (id, document_number, customer_id, status, total_minor, paid_minor, remaining_minor, created_at)
      VALUES (1, 'SO-2026-0001', 1, 'confirmed', 6000000, 3600000, 2400000, '2026-01-02');

    INSERT INTO work_sheets (id, document_number, order_id, quantity_micro, status, issued_at, started_at, notes, created_by, created_at)
      VALUES (1, 'MO-2026-0001', 1, 0, 'in_production', '2026-01-10T08:00:00Z', '2026-01-10T09:00:00Z', 'ملاحظة مصنع', 1, '2026-01-10');

    -- Stage progress that the drop must not take anything else with.
    INSERT INTO work_sheet_stages (work_sheet_id, sequence, code, label, status, worker_id)
      VALUES (1, 1, 'cutting', 'القص', 'done', 1);
    INSERT INTO work_sheet_stages (work_sheet_id, sequence, code, label, status)
      VALUES (1, 2, 'assembly', 'التجميع', 'in_progress');

    INSERT INTO order_material_lines (id, order_id, work_sheet_id, material_id, physical_qty_micro, actual_cost_minor, commercial_qty_micro, commercial_value_minor, pricing_rule_used, created_at)
      VALUES (1, 1, 1, 1, 10000000, 1000000, 10000000, 1500000, 'exact', '2026-01-10');
  `)
  return db
}

describe('Migration 0002 — planned materials, stages removed (item 25)', () => {
  it('applies cleanly over a database that already has stage rows', () => {
    const db = databaseAt0001()
    expect(db.prepare('SELECT COUNT(*) c FROM work_sheet_stages').get()).toEqual({ c: 2 })

    expect(() => applyFile(db, '0002_planned_materials.sql')).not.toThrow()

    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
  })

  it('drops work_sheet_stages and nothing else', () => {
    const db = databaseAt0001()
    applyFile(db, '0002_planned_materials.sql')

    const exists = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { c: number }).c
    expect(exists('work_sheet_stages')).toBe(0)
    for (const kept of ['work_sheets', 'work_sheet_workers', 'order_material_lines', 'releases', 'deliveries', 'final_invoices']) {
      expect(exists(kept), `${kept} must survive`).toBe(1)
    }
  })

  it('leaves every production order intact, with its link, status and timestamps', () => {
    const db = databaseAt0001()
    applyFile(db, '0002_planned_materials.sql')

    const sheet = db.prepare('SELECT * FROM work_sheets WHERE id = 1').get() as Record<string, unknown>
    expect(sheet.document_number).toBe('MO-2026-0001')
    expect(sheet.order_id).toBe(1)
    expect(sheet.status).toBe('in_production')
    expect(sheet.started_at).toBe('2026-01-10T09:00:00Z')
    expect(sheet.notes).toBe('ملاحظة مصنع')

    // Actual FIFO consumption on it is untouched.
    const line = db.prepare('SELECT * FROM order_material_lines WHERE id = 1').get() as Record<string, number>
    expect(line.work_sheet_id).toBe(1)
    expect(line.actual_cost_minor).toBe(1000000)
  })

  it('adds the three planned tables, each accepting its own scope', () => {
    const db = databaseAt0001()
    applyFile(db, '0002_planned_materials.sql')

    expect(() => db.exec(`
      INSERT INTO quotations (id, document_number, customer_id, created_at)
        VALUES (1, 'QT-2026-0001', 1, '2026-01-01');
      INSERT INTO planned_materials (quotation_id, material_id, material_name, qty_micro, unit, thickness, estimated_unit_cost_micro, estimated_total_minor, created_at)
        VALUES (1, 1, 'لوح MDF', 12000000, 'لوح', '18مم', 240000000, 2880000, '2026-01-01');
      INSERT INTO planned_materials (order_id, material_name, qty_micro, created_at)
        VALUES (1, 'لوح MDF', 12000000, '2026-01-02');
      INSERT INTO planned_materials (work_sheet_id, material_name, qty_micro, created_at)
        VALUES (1, 'لوح MDF', 13000000, '2026-01-10');
      INSERT INTO planned_machines (quotation_id, machine_name, estimated_cost_minor, created_at)
        VALUES (1, 'آلة القص', 400000, '2026-01-01');
      INSERT INTO planned_workers (quotation_id, worker_id, worker_name, estimated_cost_minor, created_at)
        VALUES (1, 1, 'نجار', 600000, '2026-01-01');
    `)).not.toThrow()

    expect(db.prepare('SELECT COUNT(*) c FROM planned_materials').get()).toEqual({ c: 3 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
  })

  it('cascades a planned line away with the document that owns it', () => {
    const db = databaseAt0001()
    applyFile(db, '0002_planned_materials.sql')
    db.exec('PRAGMA foreign_keys=ON')
    db.exec(`
      INSERT INTO quotations (id, document_number, customer_id, created_at)
        VALUES (1, 'QT-2026-0001', 1, '2026-01-01');
      INSERT INTO planned_materials (quotation_id, material_name, qty_micro, created_at)
        VALUES (1, 'لوح MDF', 12000000, '2026-01-01');
    `)

    db.exec('DELETE FROM quotations WHERE id = 1')

    expect(db.prepare('SELECT COUNT(*) c FROM planned_materials').get()).toEqual({ c: 0 })
  })
})
