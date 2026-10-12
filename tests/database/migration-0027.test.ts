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

describe('Migration 0027 — customer-order raw-material returns', () => {
  it('adds immutable return history and frozen-cost allocation tables without rebuilding existing ledgers', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    const earlier = readdirSync('drizzle/migrations')
      .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0027')
      .sort()
    for (const file of earlier) applyFile(db, file)

    const movementSqlBefore = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory_movements'"
    ).get() as { sql: string }).sql
    expect(() => applyFile(db, '0027_noisy_the_order.sql')).not.toThrow()
    const movementSqlAfter = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory_movements'"
    ).get() as { sql: string }).sql
    expect(movementSqlAfter).toBe(movementSqlBefore)

    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'material_return%' ORDER BY name"
    ).all() as Array<{ name: string }>).map((row) => row.name)
    expect(tables).toEqual([
      'material_return_allocations', 'material_return_events', 'material_returns'
    ])
    expect(db.pragma('index_list(material_return_events)')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'material_return_events_request_key_unique', unique: 1 })])
    )
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('keeps the migration journal strictly increasing', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    const previous = journal.entries.find((entry) => entry.idx === 26)!
    const current = journal.entries.find((entry) => entry.idx === 27)!
    expect(current.when).toBeGreaterThan(previous.when)
    expect(current.tag).toBe('0027_noisy_the_order')
  })
})
