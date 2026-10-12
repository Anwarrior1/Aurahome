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

describe('Migration 0021 — commission modes and planned order expenses', () => {
  it('migrates an isolated 0020 database without changing legacy commission values', () => {
    const db = new Database(':memory:')
    const earlier = readdirSync('drizzle/migrations')
      .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0021')
      .sort()
    for (const file of earlier) applyFile(db, file)
    db.pragma('foreign_keys = ON')
    db.prepare(`INSERT INTO planned_workers (worker_name, estimated_cost_minor) VALUES ('عمولة قديمة', ?)`).run(275_000)

    expect(() => applyFile(db, '0021_condemned_namora.sql')).not.toThrow()

    expect(db.prepare(`
      SELECT worker_name, commission_mode, meter_rate_micro, meter_qty_micro, estimated_cost_minor
      FROM planned_workers
    `).get()).toEqual({
      worker_name: 'عمولة قديمة',
      commission_mode: 'estimated',
      meter_rate_micro: null,
      meter_qty_micro: null,
      estimated_cost_minor: 275_000
    })
    const expenseColumns = (db.prepare('PRAGMA table_info(planned_order_expenses)').all() as Array<{ name: string }>).map((row) => row.name)
    expect(expenseColumns).toEqual(expect.arrayContaining(['order_id', 'work_sheet_id', 'expense_name', 'amount_minor']))
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('keeps the migration journal strictly increasing', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    const previous = journal.entries.find((entry) => entry.idx === 20)!
    const current = journal.entries.find((entry) => entry.idx === 21)!
    expect(current.when).toBeGreaterThan(previous.when)
    expect(current.tag).toBe('0021_condemned_namora')
  })
})
