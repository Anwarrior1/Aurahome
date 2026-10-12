import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

const folder = 'drizzle/migrations/'
function apply(db: Database.Database, file: string) {
  for (const statement of readFileSync(folder + file, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }
}
describe('0037 reversible order steps migration', () => {
  it('adds orthogonal lifecycle metadata without changing a single legacy financial/inventory identity or amount', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const file of readdirSync(folder).filter((f) => /^\d{4}.*\.sql$/.test(f) && f < '0037').sort()) apply(db, file)
    db.exec(`
      INSERT INTO customers (id,name) VALUES (1,'Historical customer');
      INSERT INTO orders (id,document_number,customer_id,status,total_minor,paid_minor,remaining_minor,created_at,completed_at)
        VALUES (42,'SO-HIST-42',1,'completed',10000000,3000000,7000000,'2025-01-01','2025-02-01');
      INSERT INTO final_invoices (id,document_number,customer_id,order_id,status,created_at)
        VALUES (17,'FI-HIST-17',1,42,'approved','2025-01-01');
      UPDATE orders SET final_invoice_id=17 WHERE id=42;
      INSERT INTO customer_payments (id,order_id,customer_id,amount_minor,paid_at,created_at,approved_invoice_id)
        VALUES (8,42,1,3000000,'2025-01-01','2025-01-01',17);
      INSERT INTO work_sheets (id,document_number,order_id,status,created_at,issued_at)
        VALUES (6,'MO-HIST-6',42,'completed','2025-01-01','2025-01-01');
      INSERT INTO releases (id,document_number,order_id,kind,authorized_at,created_at)
        VALUES (7,'EP-HIST-7',42,'delivery','2025-01-01','2025-01-01');
      INSERT INTO workers (id,name) VALUES (1,'Historical worker');
      INSERT INTO worker_transactions (id,worker_id,order_id,kind,amount_minor,created_at)
        VALUES (2,1,42,'earning',50000,'2025-01-01');
    `)
    const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name)
    const before = Object.fromEntries(tableNames.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    apply(db, '0037_reversible_order_steps.sql')
    for (const table of tableNames) {
      const old = before[table] as Array<Record<string, unknown>>
      const after = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>
      expect(after.map((row, index) => Object.fromEntries(Object.keys(old[index]).map((key) => [key, row[key]])))).toEqual(old)
    }
    expect(db.prepare('SELECT archived_at,archived_by FROM orders WHERE id=42').get()).toEqual({ archived_at: null, archived_by: null })
    expect(db.prepare('SELECT status,reversed_at FROM releases WHERE id=7').get()).toEqual({ status: 'active', reversed_at: null })
    expect(db.prepare('SELECT approval_revision FROM final_invoices WHERE id=17').get()).toEqual({ approval_revision: 0 })
    db.exec("INSERT INTO invoice_approval_history (invoice_id,revision,snapshot,created_by,created_at) VALUES (17,0,'{}',1,'2026-01-01')")
    expect(() => db.exec("INSERT INTO invoice_approval_history (invoice_id,revision,snapshot,created_by,created_at) VALUES (17,0,'{}',1,'2026-01-01')")).toThrow(/UNIQUE/)
    db.exec("INSERT INTO worker_transactions (worker_id,order_id,kind,amount_minor,reversal_of_transaction_id,created_at) VALUES (1,42,'adjustment',-50000,2,'2026-01-01')")
    expect(() => db.exec("INSERT INTO worker_transactions (worker_id,order_id,kind,amount_minor,reversal_of_transaction_id,created_at) VALUES (1,42,'adjustment',-50000,2,'2026-01-01')")).toThrow(/UNIQUE/)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })
  it('has complete current Drizzle metadata and a new strictly monotonic journal entry', () => {
    const journal = JSON.parse(readFileSync(folder + 'meta/_journal.json', 'utf8')) as { entries: Array<{ idx: number; when: number; tag: string }> }
    // Position is not the invariant — later features add later entries.
    // What must hold is that THIS entry exists at its own index and the
    // journal stays strictly increasing, or the migrator silently skips.
    expect(journal.entries.find((entry) => entry.idx === 37)).toMatchObject({ tag: '0037_reversible_order_steps' })
    journal.entries.forEach((entry, index) => { if (index) expect(entry.when).toBeGreaterThan(journal.entries[index - 1].when) })
    const previous = JSON.parse(readFileSync(folder + 'meta/0036_snapshot.json', 'utf8'))
    const current = JSON.parse(readFileSync(folder + 'meta/0037_snapshot.json', 'utf8'))
    expect(current.prevId).toBe(previous.id)
    expect(current.tables.orders.columns.archived_at).toMatchObject({ type: 'text', notNull: false })
    expect(current.tables.releases.columns.status).toMatchObject({ default: "'active'" })
    expect(current.tables.invoice_approval_history).toBeDefined()
    expect(current.tables.worker_transactions.indexes.worker_transactions_reversal_unique.isUnique).toBe(true)
  })
})
