import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { listIntegerDomainColumns, scanIntegerDomainStorage } from '@main/db/integer-domain-scan'
import { runMigrationsFromFolder } from '@main/migrations/migration-runner'

const FOLDER = 'drizzle/migrations/'

function bundleBefore(dir: string, idx: number): string {
  const previous = join(dir, 'previous')
  mkdirSync(join(previous, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(`${FOLDER}meta/_journal.json`, 'utf8'))
  writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify({
    ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < idx)
  }))
  for (const file of readdirSync(FOLDER).filter((file) => file.endsWith('.sql') && file < String(idx).padStart(4, '0')))
    copyFileSync(`${FOLDER}${file}`, join(previous, file))
  return previous
}

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => { env.cleanup() })

describe('0049 repository-wide DB-06 integer-domain guards', () => {
  it('covers the complete authoritative domain inventory without guarding ordinary INTEGER columns', () => {
    const raw = getRawConnection()
    const columns = listIntegerDomainColumns(raw)
    expect(columns).toHaveLength(140)
    expect(new Set(columns.map(({ table }) => table)).size).toBe(49)

    const triggers = raw.prepare("SELECT name, tbl_name AS tableName, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'db06_%' ORDER BY name")
      .all() as { name: string; tableName: string; sql: string }[]
    for (const { table, column } of columns) {
      for (const operation of ['insert', 'update'] as const) {
        expect(
          triggers.some((trigger) =>
            trigger.tableName === table &&
            trigger.name.endsWith(`_${operation}`) &&
            trigger.sql.includes(column)
          ),
          `${table}.${column} ${operation}`
        ).toBe(true)
      }
    }
    expect(triggers.some((trigger) => trigger.sql.includes('created_at'))).toBe(false)
    expect(triggers.some((trigger) => trigger.sql.includes('created_by'))).toBe(false)
  })

  it('rejects fractional direct inserts for every authoritative column', () => {
    const raw = getRawConnection()
    for (const { table, column } of listIntegerDomainColumns(raw)) {
      const q = (name: string) => `"${name.replaceAll('"', '""')}"`
      expect(() => raw.prepare(`INSERT INTO ${q(table)} (${q(column)}) VALUES (?)`).run(1.5), `${table}.${column}`)
        .toThrow(/DB-06/)
    }
  })

  it('rejects fractional, numeric-text, and unsafe direct updates while preserving valid signed corrections', () => {
    const raw = getRawConnection()
    const account = raw.prepare("SELECT id FROM cash_accounts ORDER BY id LIMIT 1").get() as { id: number }
    expect(() => raw.prepare('UPDATE cash_accounts SET opening_balance_minor = ? WHERE id = ?').run(1.5, account.id)).toThrow(/DB-06/)
    expect(() => raw.prepare('UPDATE cash_accounts SET opening_balance_minor = ? WHERE id = ?').run('1.5', account.id)).toThrow(/DB-06/)
    expect(() => raw.prepare('UPDATE cash_accounts SET opening_balance_minor = ? WHERE id = ?').run(9_007_199_254_740_992n, account.id)).toThrow(/DB-06/)
    expect(() => raw.prepare('UPDATE cash_accounts SET opening_balance_minor = ? WHERE id = ?').run(-1_000, account.id)).not.toThrow()
    expect(raw.prepare('SELECT opening_balance_minor, typeof(opening_balance_minor) AS type FROM cash_accounts WHERE id = ?').get(account.id))
      .toEqual({ opening_balance_minor: -1_000, type: 'integer' })
  })

  it('reports no historical storage violations in the current disposable fixture', () => {
    const raw = getRawConnection()
    expect(listIntegerDomainColumns(raw)).toHaveLength(140)
    expect(scanIntegerDomainStorage(raw)).toEqual([])
  })

  it('upgrades a valid 0048 database, is idempotent, and preserves integrity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db06-valid-upgrade-'))
    const raw = new Database(join(dir, 'valid.db'))
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, bundleBefore(dir, 49))
      raw.prepare("INSERT INTO cash_accounts (name, opening_balance_minor, created_at) VALUES ('valid', -1000, '2026-09-16T00:00:00.000Z')").run()

      runMigrationsFromFolder(raw, FOLDER)
      runMigrationsFromFolder(raw, FOLDER)

      expect(scanIntegerDomainStorage(raw)).toEqual([])
      expect(raw.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: 53 })
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'db06_integer_cash_accounts_insert'").get()).toBeDefined()
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])
    } finally {
      raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports historical corruption and aborts 0049 without changing or rounding it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db06-invalid-upgrade-'))
    const raw = new Database(join(dir, 'invalid.db'))
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, bundleBefore(dir, 49))
      raw.prepare("INSERT INTO cash_accounts (name, opening_balance_minor, created_at) VALUES ('invalid', 1.5, '2026-09-16T00:00:00.000Z')").run()
      expect(scanIntegerDomainStorage(raw)).toEqual([
        { table: 'cash_accounts', column: 'opening_balance_minor', count: 1 }
      ])

      expect(() => runMigrationsFromFolder(raw, FOLDER)).toThrow(/DB-06 historical integer-domain violation/)
      expect(raw.prepare("SELECT opening_balance_minor, typeof(opening_balance_minor) AS type FROM cash_accounts WHERE name = 'invalid'").get())
        .toEqual({ opening_balance_minor: 1.5, type: 'real' })
      expect(raw.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: 49 })
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'db06_integer_cash_accounts_insert'").get()).toBeUndefined()
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])
    } finally {
      raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
