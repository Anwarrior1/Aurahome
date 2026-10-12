import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
const folder = 'drizzle/migrations/'
function apply(db: Database.Database, file: string): void { for (const sql of readFileSync(folder + file, 'utf8').split('--> statement-breakpoint').filter(s => s.trim())) db.exec(sql) }
describe('0033 customer lifecycle and missing preliminary snapshot protection', () => {
  it('preserves active=false, historical finance and existing snapshots; freezes best available legacy issued identity while keeping drafts live', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    try {
      for (const file of readdirSync(folder).filter(f => /^\d{4}.*\.sql$/.test(f) && f < '0033').sort()) apply(db, file)
      db.exec(`INSERT INTO customers (id, name, phone, address, active) VALUES (1, 'Legacy archived', '091', 'Address', 0), (2, 'Active', NULL, NULL, 1);
      INSERT INTO quotations (id, document_number, customer_id, status, total_minor) VALUES (1, 'QT-OLD', 1, 'issued', 10000000), (2, 'QT-DRAFT', 2, 'draft', 5000000);
      INSERT INTO final_invoices (id, document_number, customer_id, status, total_minor, snapshot) VALUES (1, 'FI-OLD', 1, 'approved', 10000000, '{"customer":{"name":"Frozen original","phone":"090","address":"Frozen address"}}');
      INSERT INTO orders (id, document_number, customer_id, total_minor, paid_minor, remaining_minor) VALUES (1, 'SO-OLD', 1, 10000000, 8000000, 2000000);
      INSERT INTO customer_payments (order_id, customer_id, amount_minor, paid_at) VALUES (1, 1, 8000000, '2026-09-14');`)
      const tables = ['customers', 'final_invoices', 'orders', 'customer_payments']
      const before = tables.map(t => db.prepare(`SELECT * FROM ${t}`).all())
      db.transaction(() => apply(db, '0033_customer_archive_snapshot.sql'))()
      expect(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before)
      expect(JSON.parse((db.prepare('SELECT customer_snapshot AS value FROM quotations WHERE id = 1').get() as { value: string }).value)).toEqual({ name: 'Legacy archived', phone: '091', address: 'Address' })
      expect(db.prepare('SELECT customer_snapshot AS value FROM quotations WHERE id = 2').get()).toEqual({ value: null })
      expect(db.prepare('SELECT total_minor, paid_minor, remaining_minor FROM orders').get()).toEqual({ total_minor: 10000000, paid_minor: 8000000, remaining_minor: 2000000 })
      const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM customers WHERE active = 1 ORDER BY name').all() as Array<{ detail: string }>
      expect(plan.map(p => p.detail).join(' ')).toContain('customers_lifecycle_name_idx')
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally { db.close() }
  })
  it('keeps a new strictly ordered migration without changing earlier tags', () => {
    const j = JSON.parse(readFileSync(folder + 'meta/_journal.json', 'utf8')) as { entries: Array<{ idx: number; when: number; tag: string }> }
    const migration = j.entries.find(e => e.idx === 33)!
    expect(migration).toMatchObject({ idx: 33, tag: '0033_customer_archive_snapshot' })
    expect(migration.when).toBeGreaterThan(j.entries.find(e => e.idx === 32)!.when)
    expect(j.entries.find(e => e.idx === 32)!.tag).toBe('0032_approved_invoice_initial_payment')
  })
})
