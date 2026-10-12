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

describe('Migration 0022 — planned machine rate snapshot', () => {
  it('adds the nullable rate without changing legacy machine totals', () => {
    const db = new Database(':memory:')
    const earlier = readdirSync('drizzle/migrations')
      .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0022')
      .sort()
    for (const file of earlier) applyFile(db, file)
    db.prepare(`INSERT INTO planned_machines (machine_name, usage_qty_micro, usage_unit, estimated_cost_minor)
      VALUES ('آلة تاريخية', 2000000, 'ساعة', 777000)`).run()

    expect(() => applyFile(db, '0022_quick_raza.sql')).not.toThrow()
    expect(db.prepare(`SELECT machine_name, rate_micro, estimated_cost_minor FROM planned_machines`).get()).toEqual({
      machine_name: 'آلة تاريخية', rate_micro: null, estimated_cost_minor: 777000
    })
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('keeps the migration journal strictly increasing', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    const previous = journal.entries.find((entry) => entry.idx === 21)!
    const current = journal.entries.find((entry) => entry.idx === 22)!
    expect(current.when).toBeGreaterThan(previous.when)
    expect(current.tag).toBe('0022_quick_raza')
  })
})
