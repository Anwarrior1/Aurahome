import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function applyFile(db: Database.Database, file: string): void {
  const source = readFileSync(join('drizzle/migrations', file), 'utf8')
  for (const statement of source.split('--> statement-breakpoint')) {
    const sql = statement.trim()
    if (sql) db.exec(sql)
  }
}

describe('Migration 0025 — purchase invoice customer-order attribution', () => {
  it('preserves legacy purchases as general purchases and enforces the nullable order FK', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    const earlier = readdirSync('drizzle/migrations')
      .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0025')
      .sort()
    for (const file of earlier) applyFile(db, file)

    db.prepare("INSERT INTO suppliers (name) VALUES ('مورد تاريخي')").run()
    db.prepare(`INSERT INTO purchases
      (document_number, supplier_id, purchase_date, total_minor)
      VALUES ('PO-LEGACY', 1, '2026-01-01', 1000000)`).run()

    expect(() => applyFile(db, '0025_mushy_fallen_one.sql')).not.toThrow()
    expect(db.prepare("SELECT customer_order_id FROM purchases WHERE document_number = 'PO-LEGACY'").get())
      .toEqual({ customer_order_id: null })
    expect(db.pragma('foreign_key_list(purchases)')).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'orders', from: 'customer_order_id', to: 'id' })
    ]))
    expect(() => db.prepare('UPDATE purchases SET customer_order_id = 999999 WHERE document_number = ?')
      .run('PO-LEGACY')).toThrow(/FOREIGN KEY/)
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('keeps the migration journal strictly increasing', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    const previous = journal.entries.find((entry) => entry.idx === 24)!
    const current = journal.entries.find((entry) => entry.idx === 25)!
    expect(current.when).toBeGreaterThan(previous.when)
    expect(current.tag).toBe('0025_mushy_fallen_one')
  })
})
