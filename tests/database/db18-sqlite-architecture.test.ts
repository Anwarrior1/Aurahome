import Database from 'better-sqlite3'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import {
  closeDatabase,
  getDatabase,
  getDatabasePath,
  getRawConnection
} from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { setupTestDatabase } from '../helpers/test-db'

function pragma(raw: Database.Database, name: string): string | number {
  return raw.pragma(name, { simple: true }) as string | number
}

function fileBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

function median(values: number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
}

describe('DB-18 SQLite and single-connection qualification', () => {
  it('opens one authoritative production-style connection with the intended durability settings', () => {
    const env = setupTestDatabase()
    try {
      const raw = getRawConnection()
      expect(getRawConnection()).toBe(raw)
      expect(getDatabase()).toBe(getDatabase())
      const attached = raw.pragma('database_list') as Array<{ seq: number; name: string; file: string }>
      expect(attached.filter(({ file }) => file !== '')).toEqual([
        { seq: 0, name: 'main', file: realpathSync(getDatabasePath()) }
      ])
      expect(attached.filter(({ file }) => file === '').map(({ name }) => name)).toEqual(['temp'])

      const settings = {
        journalMode: pragma(raw, 'journal_mode'),
        synchronous: pragma(raw, 'synchronous'),
        foreignKeys: pragma(raw, 'foreign_keys'),
        busyTimeout: pragma(raw, 'busy_timeout'),
        trustedSchema: pragma(raw, 'trusted_schema'),
        tempStore: pragma(raw, 'temp_store'),
        cacheSize: pragma(raw, 'cache_size'),
        walAutocheckpoint: pragma(raw, 'wal_autocheckpoint'),
        lockingMode: pragma(raw, 'locking_mode'),
        readUncommitted: pragma(raw, 'read_uncommitted')
      }

      expect(settings).toMatchObject({
        journalMode: 'wal',
        synchronous: 2,
        foreignKeys: 1,
        busyTimeout: 5_000,
        trustedSchema: 0,
        walAutocheckpoint: 1_000,
        lockingMode: 'normal',
        readUncommitted: 0
      })
      expect(typeof settings.tempStore).toBe('number')
      expect(typeof settings.cacheSize).toBe('number')
      console.log(`DB18_PRAGMAS ${JSON.stringify({ ...settings, attached })}`)
    } finally {
      env.cleanup()
    }
  })

  it('uses savepoints for nested work and preserves outer/whole-transaction rollback boundaries', () => {
    const env = setupTestDatabase()
    try {
      const raw = getRawConnection()
      const insert = raw.prepare('INSERT INTO customers (name) VALUES (?)')

      withTransaction(() => {
        insert.run('db18-outer-before')
        expect(() => withTransaction(() => {
          insert.run('db18-inner-rolled-back')
          throw new Error('inner failure')
        })).toThrow(/inner failure/)
        insert.run('db18-outer-after')
      })

      expect(
        raw.prepare("SELECT name FROM customers WHERE name LIKE 'db18-%' ORDER BY id").pluck().all()
      ).toEqual(['db18-outer-before', 'db18-outer-after'])

      expect(() => withTransaction(() => {
        insert.run('db18-whole-transaction-rolled-back')
        throw new Error('outer failure')
      })).toThrow(/outer failure/)
      expect(
        raw.prepare("SELECT COUNT(*) FROM customers WHERE name = 'db18-whole-transaction-rolled-back'").pluck().get()
      ).toBe(0)
    } finally {
      env.cleanup()
    }
  })

  it('keeps WAL readers available while a synthetic second writer fails busy and leaves no partial row', () => {
    const env = setupTestDatabase()
    const competing = new Database(getDatabasePath())
    try {
      competing.pragma('journal_mode = WAL')
      competing.pragma('busy_timeout = 1')
      const raw = getRawConnection()
      const before = Number(competing.prepare('SELECT COUNT(*) FROM customers').pluck().get())

      raw.exec('BEGIN IMMEDIATE')
      raw.prepare("INSERT INTO customers (name) VALUES ('db18-uncommitted')").run()
      expect(competing.prepare('SELECT COUNT(*) FROM customers').pluck().get()).toBe(before)

      let lockError: unknown
      const lockStart = performance.now()
      try {
        competing.prepare("INSERT INTO customers (name) VALUES ('db18-competing')").run()
      } catch (error) {
        lockError = error
      }
      const busyMs = performance.now() - lockStart
      expect((lockError as { code?: string } | undefined)?.code).toBe('SQLITE_BUSY')
      raw.exec('ROLLBACK')

      expect(raw.prepare("SELECT COUNT(*) FROM customers WHERE name = 'db18-uncommitted'").pluck().get()).toBe(0)
      competing.prepare("INSERT INTO customers (name) VALUES ('db18-after-lock')").run()
      expect(raw.prepare("SELECT COUNT(*) FROM customers WHERE name = 'db18-after-lock'").pluck().get()).toBe(1)
      console.log(`DB18_LOCK ${JSON.stringify({ syntheticSecondConnection: true, busyMs: Number(busyMs.toFixed(3)) })}`)
    } finally {
      if (getRawConnection().inTransaction) getRawConnection().exec('ROLLBACK')
      competing.close()
      env.cleanup()
    }
  })

  it('bounds WAL work through autocheckpoint and explicit truncate boundaries, then closes cleanly', () => {
    const env = setupTestDatabase()
    try {
      const raw = getRawConnection()
      const databasePath = getDatabasePath()
      const walPath = `${databasePath}-wal`
      const insert = raw.prepare('INSERT INTO customers (name) VALUES (?)')
      raw.transaction(() => {
        for (let row = 0; row < 5_000; row += 1) insert.run(`db18-wal-${row}`)
      })()

      const beforeCheckpointBytes = fileBytes(walPath)
      const passive = raw.pragma('wal_checkpoint(PASSIVE)') as Array<{
        busy: number
        log: number
        checkpointed: number
      }>
      const truncate = raw.pragma('wal_checkpoint(TRUNCATE)') as Array<{
        busy: number
        log: number
        checkpointed: number
      }>
      const afterTruncateBytes = fileBytes(walPath)

      expect(beforeCheckpointBytes).toBeGreaterThan(0)
      expect(passive[0]?.busy).toBe(0)
      expect(truncate[0]?.busy).toBe(0)
      expect(afterTruncateBytes).toBe(0)
      closeDatabase()
      expect(fileBytes(walPath)).toBe(0)
      expect(getRawConnection().prepare("SELECT COUNT(*) FROM customers WHERE name LIKE 'db18-wal-%'").pluck().get()).toBe(5_000)
      console.log(`DB18_WAL ${JSON.stringify({
        writes: 5_000,
        beforeCheckpointBytes,
        passive: passive[0],
        truncate: truncate[0],
        afterTruncateBytes,
        afterCloseBytes: fileBytes(walPath)
      })}`)
    } finally {
      env.cleanup()
    }
  })

  it('measures FULL versus NORMAL commit cost and restores the production durability level', () => {
    const env = setupTestDatabase()
    try {
      const raw = getRawConnection()
      raw.exec('CREATE TABLE db18_commit_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
      const insert = raw.prepare('INSERT INTO db18_commit_probe (value) VALUES (?)')
      const measure = (mode: 'FULL' | 'NORMAL'): number => {
        raw.pragma(`synchronous = ${mode}`)
        raw.pragma('wal_checkpoint(TRUNCATE)')
        const values: number[] = []
        for (let attempt = 0; attempt < 31; attempt += 1) {
          const start = performance.now()
          raw.transaction(() => insert.run(`${mode}-${attempt}`))()
          if (attempt > 0) values.push(performance.now() - start)
        }
        return median(values)
      }

      const fullMedianMs = measure('FULL')
      const normalMedianMs = measure('NORMAL')
      raw.pragma('synchronous = FULL')

      expect(pragma(raw, 'synchronous')).toBe(2)
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      console.log(`DB18_SYNC ${JSON.stringify({
        transactionsPerMode: 30,
        fullMedianMs: Number(fullMedianMs.toFixed(3)),
        normalMedianMs: Number(normalMedianMs.toFixed(3)),
        absoluteMedianDeltaMs: Number((fullMedianMs - normalMedianMs).toFixed(3))
      })}`)
    } finally {
      env.cleanup()
    }
  })
})
