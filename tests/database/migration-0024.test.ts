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

describe('Migration 0024 — authorised unpaid release snapshot', () => {
  it('adds only nullable snapshot fields and leaves legacy permits unclassified', () => {
    const db = new Database(':memory:')
    const earlier = readdirSync('drizzle/migrations')
      .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0024')
      .sort()
    for (const file of earlier) applyFile(db, file)

    db.prepare("INSERT INTO customers (name) VALUES ('عميل تاريخي')").run()
    db.prepare("INSERT INTO orders (document_number, customer_id) VALUES ('SO-LEGACY', 1)").run()
    db.prepare(`INSERT INTO releases (document_number, order_id, kind, authorized_at)
      VALUES ('IA-LEGACY', 1, 'installation', '2026-01-01T00:00:00.000Z')`).run()

    expect(() => applyFile(db, '0024_fast_madame_web.sql')).not.toThrow()
    expect(db.prepare(`SELECT authorization_type, order_total_minor_at_issue,
      paid_minor_at_issue, remaining_minor_at_issue, unpaid_override_reason
      FROM releases WHERE document_number = 'IA-LEGACY'`).get()).toEqual({
      authorization_type: null,
      order_total_minor_at_issue: null,
      paid_minor_at_issue: null,
      remaining_minor_at_issue: null,
      unpaid_override_reason: null
    })
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('keeps the migration journal strictly increasing', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    const previous = journal.entries.find((entry) => entry.idx === 23)!
    const current = journal.entries.find((entry) => entry.idx === 24)!
    expect(current.when).toBeGreaterThan(previous.when)
    expect(current.tag).toBe('0024_fast_madame_web')
  })
})
