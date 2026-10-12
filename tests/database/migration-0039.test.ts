import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

const folder = 'drizzle/migrations/'
function apply(db: Database.Database, file: string): void {
  for (const statement of readFileSync(folder + file, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }
}

describe('0039 customer payment refunds migration', () => {
  it('adds append-only refund relationships without altering legacy payments or material columns', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const file of readdirSync(folder).filter((f) => /^\d{4}.*\.sql$/.test(f) && f < '0039').sort()) apply(db, file)
    db.exec(`
      INSERT INTO customers (id,name) VALUES (1,'عميل قديم');
      INSERT INTO orders (id,document_number,customer_id,status,total_minor,paid_minor,remaining_minor,created_at)
        VALUES (42,'SO-HIST-42',1,'confirmed',9000000,5400000,3600000,'2025-01-01');
      INSERT INTO customer_payments (id,order_id,customer_id,amount_minor,paid_at,created_at)
        VALUES (7,42,1,5400000,'2025-01-01','2025-01-01');
    `)
    const paymentBefore = db.prepare('SELECT * FROM customer_payments WHERE id = 7').get()
    apply(db, '0039_chief_lord_hawal.sql')
    expect(db.prepare('SELECT * FROM customer_payments WHERE id = 7').get()).toEqual(paymentBefore)
    expect(db.prepare('SELECT COUNT(*) AS c FROM customer_payment_refunds').get()).toEqual({ c: 0 })
    expect(db.prepare('PRAGMA table_info(materials)').all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'allows_remainder' }),
      expect.objectContaining({ name: 'track_batches' }),
      expect.objectContaining({ name: 'supports_color' })
    ]))
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('enforces request idempotency and exact source foreign keys', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const file of readdirSync(folder).filter((f) => /^\d{4}.*\.sql$/.test(f) && f < '0040').sort()) apply(db, file)
    db.exec("INSERT INTO customers (id,name) VALUES (1,'عميل'); INSERT INTO orders (id,document_number,customer_id,status,created_at) VALUES (1,'SO-1',1,'confirmed','2026-01-01'); INSERT INTO customer_payments (id,order_id,customer_id,amount_minor,paid_at) VALUES (1,1,1,1000,'2026-01-01'); INSERT INTO customer_payment_refunds (id,order_id,customer_id,amount_minor,cash_account_id,refunded_at,reason,request_key) VALUES (1,1,1,500,1,'2026-01-02','سبب','request-1'); INSERT INTO customer_payment_refund_allocations (refund_id,payment_id,amount_minor) VALUES (1,1,500)")
    expect(() => db.exec("INSERT INTO customer_payment_refunds (order_id,customer_id,amount_minor,cash_account_id,refunded_at,reason,request_key) VALUES (1,1,1,1,'2026-01-02','سبب','request-1')")).toThrow(/UNIQUE/i)
    expect(() => db.exec('INSERT INTO customer_payment_refund_allocations (refund_id,payment_id,amount_minor) VALUES (1,999,1)')).toThrow(/FOREIGN KEY/i)
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })
})
