import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
const folder = 'drizzle/migrations/'
function apply(db: Database.Database, file: string): void {
  for (const sql of readFileSync(folder + file, 'utf8').split('--> statement-breakpoint').filter(s => s.trim())) db.exec(sql)
}
describe('0032 actual Approved Invoice initial payment', () => {
  it('preserves historical invoices/payments, defaults drafts to zero, enforces unique sources, and allows canonical full-delete ordering', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    try {
      for (const file of readdirSync(folder).filter(f => /^\d{4}.*\.sql$/.test(f) && f < '0032').sort()) apply(db, file)
      db.exec("INSERT INTO customers (id, name) VALUES (1, 'History'); INSERT INTO final_invoices (id, document_number, customer_id, status, total_minor, snapshot) VALUES (1, 'FI-OLD', 1, 'approved', 10000000, '{\"historical\":true}'), (2, 'FI-DRAFT', 1, 'draft', 10000000, NULL); INSERT INTO orders (id, document_number, customer_id) VALUES (1, 'SO-OLD', 1); INSERT INTO customer_payments (id, order_id, customer_id, amount_minor, paid_at) VALUES (1, 1, 1, 3000000, '2026-09-14')")
      const invoices = db.prepare('SELECT * FROM final_invoices').all() as Array<Record<string, unknown>>
      const payments = db.prepare('SELECT * FROM customer_payments').all() as Array<Record<string, unknown>>
      db.transaction(() => apply(db, '0032_approved_invoice_initial_payment.sql'))()
      expect(db.prepare('SELECT * FROM final_invoices').all()).toEqual(invoices.map(i => ({ ...i, paid_amount_minor: 0, initial_cash_account_id: null })))
      expect(db.prepare('SELECT * FROM customer_payments').all()).toEqual(payments.map(p => ({ ...p, approved_invoice_id: null })))
      db.exec('UPDATE customer_payments SET approved_invoice_id = 1 WHERE id = 1')
      expect(() => db.exec("INSERT INTO customer_payments (order_id, customer_id, amount_minor, paid_at, approved_invoice_id) VALUES (1, 1, 1000, '2026-09-14', 1)")).toThrow(/UNIQUE/)
      expect(() => db.exec('UPDATE customer_payments SET approved_invoice_id = 999 WHERE id = 1')).toThrow(/FOREIGN KEY/)
      db.exec('DELETE FROM final_invoices WHERE id = 1')
      expect(db.prepare('SELECT approved_invoice_id FROM customer_payments').get()).toEqual({ approved_invoice_id: null })
      expect(db.pragma('foreign_key_check')).toEqual([])
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally { db.close() }
  })
  it('keeps migration history strictly ordered after 0031', () => {
    const journal = JSON.parse(readFileSync(folder + 'meta/_journal.json', 'utf8')) as { entries: Array<{ idx: number; when: number; tag: string }> }
    const current = journal.entries.find(entry => entry.idx === 32)!
    expect(current).toMatchObject({ idx: 32, tag: '0032_approved_invoice_initial_payment' })
    expect(current.when).toBeGreaterThan(journal.entries.find(entry => entry.idx === 31)!.when)
  })
})
