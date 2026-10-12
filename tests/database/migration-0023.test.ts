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

describe('Migration 0023 — release paid-sentence visibility', () => {
  it('adds a checked-compatible default without changing a legacy permit', () => {
    const db = new Database(':memory:')
    const earlier = readdirSync('drizzle/migrations')
      .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0023')
      .sort()
    for (const file of earlier) applyFile(db, file)

    db.prepare("INSERT INTO customers (name) VALUES ('عميل تاريخي')").run()
    db.prepare("INSERT INTO orders (document_number, customer_id) VALUES ('SO-LEGACY', 1)").run()
    db.prepare(`INSERT INTO releases (document_number, order_id, kind, authorized_at)
      VALUES ('IA-LEGACY', 1, 'installation', '2026-01-01T00:00:00.000Z')`).run()

    expect(() => applyFile(db, '0023_dark_tyrannus.sql')).not.toThrow()
    expect(db.prepare(`SELECT document_number, show_paid_exit_sentence FROM releases`).get()).toEqual({
      document_number: 'IA-LEGACY',
      show_paid_exit_sentence: 1
    })
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('keeps the migration journal strictly increasing', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    const previous = journal.entries.find((entry) => entry.idx === 22)!
    const current = journal.entries.find((entry) => entry.idx === 23)!
    expect(current.when).toBeGreaterThan(previous.when)
    expect(current.tag).toBe('0023_dark_tyrannus')
  })
})
