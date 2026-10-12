import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openVerifiedDatabase } from '@main/app/database-startup'
import { closeDatabase, getDatabase, getDatabasePath, getRawConnection, setDatabasePath } from '@main/db/connection'
import { applyPragmas } from '@main/db/pragmas'
import { runMigrationsFromFolder, runPendingMigrations } from '@main/migrations/migration-runner'
import {
  finalizeMigrationRecovery, getMigrationRecoveryPaths, readMigrationRecoveryMarker
} from '@main/migrations/migration-recovery'
import { createBackup } from '@main/backup/backup.service'
import { restoreFromBackup, SimulatedRestoreInterruption } from '@main/restore/restore.service'
import { readRestoreMarker } from '@main/restore/restore-recovery'
import { createCustomer } from '@main/services/parties/parties.service'
import { setupTestDatabase } from '../helpers/test-db'
import { seedDb10Fixture } from '../helpers/db10-fixtures'

/**
 * DB-14: production startup proves integrity/FK once per unchanged database,
 * never once per layer. Exceptional states (migration, restore, recovery) keep
 * their deeper O(size) verification. DB14_BENCH=1 runs 10k/100k timings; default is a 1k smoke.
 */
const MIGRATIONS = resolve('drizzle/migrations')
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>
}

function prefixFolder(dir: string, throughIdx: number): string {
  const folder = join(dir, `prefix-${throughIdx}`)
  mkdirSync(join(folder, 'meta'), { recursive: true })
  const entries = journal.entries.filter(({ idx }) => idx <= throughIdx)
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({
    version: '7', dialect: 'sqlite', entries: entries.map((entry) => ({ ...entry, version: '6', breakpoints: true }))
  }))
  for (const entry of entries) copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  return folder
}

/** Every O(size) pass on any connection, including read-only recovery probes. */
function countFullChecks(): { integrity: () => number; fk: () => number; quick: () => number } {
  const spy = vi.spyOn(Database.prototype, 'pragma')
  const count = (name: string) => () => spy.mock.calls.filter(([source]) => String(source).trim() === name).length
  return { integrity: count('integrity_check'), fk: count('foreign_key_check'), quick: count('quick_check') }
}

function fileSha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A checkpointed, closed, current application database file. */
function currentDatabaseFile(dir: string, seed?: (raw: Database.Database) => void): string {
  const path = join(dir, 'erp.db')
  const raw = new Database(path)
  applyPragmas(raw)
  runMigrationsFromFolder(raw, MIGRATIONS)
  seed?.(raw)
  raw.pragma('wal_checkpoint(TRUNCATE)')
  raw.close()
  return path
}

function journalRows(path: string): unknown[] {
  const raw = new Database(path, { readonly: true })
  try { return raw.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at').all() }
  finally { raw.close() }
}

function withStartupFile(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'aura-db14-'))
  try { run(dir) } finally {
    closeDatabase()
    setDatabasePath(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Startup must throw, and the authoritative file must be byte-identical afterwards. */
function expectFailClosed(path: string, pattern: RegExp): void {
  const before = fileSha(path)
  setDatabasePath(path)
  expect(() => openVerifiedDatabase()).toThrow(pattern)
  closeDatabase()
  expect(fileSha(path)).toBe(before)
  expect(existsSync(getMigrationRecoveryPaths(path).marker)).toBe(false)
}

afterEach(() => { vi.restoreAllMocks() })

describe('DB-14 startup verification matrix', () => {
  it('normal current startup runs exactly one integrity_check and one foreign_key_check', () => {
    withStartupFile((dir) => {
      const path = currentDatabaseFile(dir)
      setDatabasePath(path)
      const checks = countFullChecks()
      openVerifiedDatabase()
      expect(checks.integrity()).toBe(1)
      expect(checks.fk()).toBe(1)
      expect(checks.quick()).toBe(0)
      finalizeMigrationRecovery(getRawConnection())
      expect(checks.integrity()).toBe(1)
    })
  })

  it('normal startup statement count does not grow with business history', () => {
    const statements = [0, 2_000].map((orders) => {
      const env = setupTestDatabase()
      try {
        if (orders) seedDb10Fixture(orders)
        const path = getDatabasePath()
        closeDatabase()
        setDatabasePath(path)
        const raw = getRawConnection()
        let executed = 0
        const prepare = raw.prepare.bind(raw)
        raw.prepare = ((source: string) => {
          const statement = prepare(source)
          for (const name of ['all', 'get', 'run', 'iterate'] as const) {
            const original = statement[name].bind(statement) as (...args: unknown[]) => unknown
            ;(statement as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => { executed += 1; return original(...args) }
          }
          return statement
        }) as typeof raw.prepare
        const pragma = raw.pragma.bind(raw)
        raw.pragma = ((source: string, options?: Database.PragmaOptions) => { executed += 1; return pragma(source, options) }) as typeof raw.pragma
        openVerifiedDatabase()
        return executed
      } finally { env.cleanup() }
    })
    expect(statements[1]).toBe(statements[0])
  })

  it('fresh startup migrates, then re-verifies the changed database', () => {
    withStartupFile((dir) => {
      setDatabasePath(join(dir, 'erp.db'))
      const checks = countFullChecks()
      openVerifiedDatabase()
      // entry + in-transaction + post-commit gate + post-initialization recheck
      expect(checks.integrity()).toBe(4)
      expect(journalRows(join(dir, 'erp.db'))).toHaveLength(journal.entries.length)
    })
  })

  it('post-migration startup keeps DB-01/DB-07 protection and full post-commit verification', () => {
    withStartupFile((dir) => {
      const path = join(dir, 'erp.db')
      const raw = new Database(path)
      applyPragmas(raw)
      runMigrationsFromFolder(raw, prefixFolder(dir, 43))
      raw.prepare("INSERT INTO customers (id, name) VALUES (1401, 'DB-14 sentinel')").run()
      raw.close()

      setDatabasePath(path)
      const checks = countFullChecks()
      openVerifiedDatabase()
      expect(readMigrationRecoveryMarker(path)?.phase).toBe('verified')
      // live entry, snapshot prep live + copy + copy validation, in-transaction,
      // post-commit gate, post-migration startup recheck
      expect(checks.integrity()).toBe(7)
      finalizeMigrationRecovery(getRawConnection())
      expect(readMigrationRecoveryMarker(path)).toBeUndefined()
      expect(getRawConnection().prepare('SELECT name FROM customers WHERE id = 1401').get()).toEqual({ name: 'DB-14 sentinel' })
      expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    })
  })

  it('a startup write (new valuation cutovers) triggers the post-initialization recheck', () => {
    withStartupFile((dir) => {
      const path = currentDatabaseFile(dir, (raw) => {
        raw.prepare("INSERT INTO products (id, code, name) VALUES (1402, 'DB14', 'DB-14 product')").run()
        raw.prepare(
          `INSERT INTO finished_goods_movements (product_id, kind, qty_micro, unit_cost_minor, total_cost_minor, created_at)
           VALUES (1402, 'production_in', 1000000, 500, 500, '2026-01-01T00:00:00.000Z')`
        ).run()
      })
      setDatabasePath(path)
      const checks = countFullChecks()
      openVerifiedDatabase()
      expect(getRawConnection().prepare('SELECT status FROM finished_goods_valuation_cutovers WHERE product_id = 1402').get())
        .toBeDefined()
      expect(checks.integrity()).toBe(2)
      expect(checks.fk()).toBe(2)
    })
  })

  it('interrupted migration startup restores the pre-migration copy, then migrates and fully verifies', () => {
    withStartupFile((dir) => {
      const path = join(dir, 'erp.db')
      setDatabasePath(path)
      runMigrationsFromFolder(getRawConnection(), prefixFolder(dir, 43))
      getRawConnection().prepare("INSERT INTO customers (id, name) VALUES (1403, 'before interruption')").run()
      expect(() => runPendingMigrations(getDatabase(), {
        afterMigrationCommitted: () => { throw new Error('simulated process loss') }
      })).toThrow(/simulated process loss/)
      expect(readMigrationRecoveryMarker(path)?.phase).toBe('migrated')
      closeDatabase()

      openVerifiedDatabase()
      expect(readMigrationRecoveryMarker(path)?.phase).toBe('verified')
      finalizeMigrationRecovery(getRawConnection())
      expect(getRawConnection().prepare('SELECT name FROM customers WHERE id = 1403').get()).toEqual({ name: 'before interruption' })
      expect(journalRows(path)).toHaveLength(journal.entries.length)
    })
  })

  it.each([
    ['afterInstalledMarker', 'A-only customer'],
    ['afterVerifiedMarker', 'B-only customer']
  ] as const)('interrupted restore at %s resolves before the normal single-pass startup gate', async (boundary, expected) => {
    const env = setupTestDatabase()
    try {
      createCustomer({ name: 'B-only customer' }, env.ctx)
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'b.aurabak'), includeConfig: false }, env.ctx)
      getRawConnection().prepare("DELETE FROM customers WHERE name = 'B-only customer'").run()
      createCustomer({ name: 'A-only customer' }, env.ctx)
      const livePath = getRawConnection().name
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx, {
        [boundary]: () => { throw new SimulatedRestoreInterruption(boundary) }
      })).rejects.toThrow(SimulatedRestoreInterruption)
      closeDatabase()
      expect(readRestoreMarker(livePath)).toBeDefined()

      openVerifiedDatabase()
      expect(readRestoreMarker(livePath)).toBeUndefined()
      expect((getRawConnection().prepare('SELECT name FROM customers ORDER BY name').all() as Array<{ name: string }>)
        .map(({ name }) => name)).toEqual([expected])
      expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    } finally { env.cleanup() }
  })
})

describe('DB-14 startup failure injection', () => {
  it('rejects a newer database without mutation', () => {
    withStartupFile((dir) => {
      const path = currentDatabaseFile(dir, (raw) => {
        raw.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('future', journal.entries.at(-1)!.when + 1)
      })
      expectFailClosed(path, /DB_MIGRATION_NEWER/)
    })
  })

  it('rejects altered migration identity without mutation', () => {
    withStartupFile((dir) => {
      const path = currentDatabaseFile(dir, (raw) => {
        raw.prepare('UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?').run('altered', journal.entries[5]!.when)
      })
      expectFailClosed(path, /DB_MIGRATION_HISTORY_MISMATCH/)
    })
  })

  it('rejects unknown history on a nonempty database without mutation', () => {
    withStartupFile((dir) => {
      const path = join(dir, 'erp.db')
      const raw = new Database(path)
      applyPragmas(raw)
      raw.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO customers VALUES (1, 'unknown')")
      raw.pragma('wal_checkpoint(TRUNCATE)')
      raw.close()
      expectFailClosed(path, /DB_MIGRATION_UNKNOWN/)
    })
  })

  it.each([
    ['DB-13 index', 'DROP INDEX cash_transactions_ref_idx', /STRUCTURAL.*cash_transactions_ref_idx/],
    ['DB-06 trigger', 'DROP TRIGGER db06_expenses_amount_insert', /STRUCTURAL.*trigger/],
    ['DB-05 table', 'DROP TABLE financial_command_requests', /STRUCTURAL/]
  ])('rejects a missing critical %s without mutation', (_label, sql, pattern) => {
    withStartupFile((dir) => {
      const path = currentDatabaseFile(dir, (raw) => raw.exec(sql))
      expectFailClosed(path, pattern)
    })
  })

  it('rejects invalid DB-02 business shape without mutation', () => {
    withStartupFile((dir) => {
      const path = currentDatabaseFile(dir, (raw) => {
        raw.prepare("INSERT INTO products (id, code, name) VALUES (1404, 'DB14B', 'bad cutover')").run()
        raw.prepare(
          `INSERT INTO finished_goods_valuation_cutovers
            (product_id, movement_id_through, opening_qty_micro, opening_value_minor, status, classification,
             affected_movement_count, historical_cogs_delta_minor, evidence, created_at)
           VALUES (1404, 0, 0, 0, 'ready', 'unaffected', 0, 0, 'not-json', '2026-01-01')`
        ).run()
      })
      expectFailClosed(path, /DB_MIGRATION_BUSINESS/)
    })
  })

  it('rejects a foreign-key violation written with enforcement off, without repair', () => {
    withStartupFile((dir) => {
      const path = currentDatabaseFile(dir, (raw) => {
        raw.pragma('foreign_keys = OFF')
        raw.prepare('INSERT INTO work_sheet_workers (work_sheet_id, worker_id) VALUES (999991, 999992)').run()
      })
      expectFailClosed(path, /DB_MIGRATION_CORRUPT.*foreign-key violation/)
    })
  })

  it('rejects index/table divergence that quick_check would accept', () => {
    withStartupFile((dir) => {
      const path = currentDatabaseFile(dir, (raw) => {
        raw.prepare("INSERT INTO customers (id, name, phone) VALUES (1405, 'index victim', '0500')").run()
        // Swap an index definition under existing rows: B-tree pages stay valid.
        const index = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'customers' AND sql IS NOT NULL LIMIT 1").get() as { name: string; sql: string }
        raw.unsafeMode(true)
        raw.pragma('writable_schema = ON')
        raw.prepare('UPDATE sqlite_master SET sql = ? WHERE name = ?').run(
          `CREATE INDEX "${index.name}" ON customers (phone)`, index.name
        )
        raw.pragma('writable_schema = OFF')
      })
      const probe = new Database(path, { readonly: true })
      try {
        expect(probe.pragma('quick_check')).toEqual([{ quick_check: 'ok' }])
        expect(probe.pragma('integrity_check')).not.toEqual([{ integrity_check: 'ok' }])
      } finally { probe.close() }
      expectFailClosed(path, /DB_MIGRATION_CORRUPT.*integrity_check.*missing from index/)
    })
  })

  it('rejects physical page corruption without destructive repair', () => {
    withStartupFile((dir) => {
      const path = currentDatabaseFile(dir, (raw) => {
        const insert = raw.prepare('INSERT INTO customers (name, phone) VALUES (?, ?)')
        for (let i = 0; i < 2_000; i += 1) insert.run(`customer ${i}`, `05${i}`)
      })
      const probe = new Database(path, { readonly: true })
      const { rootpage } = probe.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'customers'").get() as { rootpage: number }
      const pageSize = Number(probe.pragma('page_size', { simple: true }))
      probe.close()
      const bytes = readFileSync(path)
      // Interior root page: zero its cell-pointer array so child pages become unreachable.
      bytes.fill(0, (rootpage - 1) * pageSize + 12, (rootpage - 1) * pageSize + 40)
      writeFileSync(path, bytes)
      expectFailClosed(path, /corrupt|malformed|integrity_check/i)
    })
  })

  it('an unexpected verification exception stops startup without mutation', () => {
    withStartupFile((dir) => {
      const path = currentDatabaseFile(dir)
      const original = Database.prototype.pragma
      vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
        if (String(source).trim() === 'integrity_check') throw new Error('disk I/O error')
        return original.call(this, source, options)
      })
      expectFailClosed(path, /disk I\/O error/)
    })
  })
})

describe('DB-14 SQLite verification semantics', () => {
  it('integrity_check proves CHECK constraints; foreign_key_check alone proves references', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db14-semantics-'))
    try {
      const raw = new Database(join(dir, 'semantics.db'))
      raw.pragma('foreign_keys = OFF')
      raw.exec(`CREATE TABLE p (id INTEGER PRIMARY KEY);
        CREATE TABLE c (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id), n INTEGER);
        INSERT INTO c VALUES (1, 42, -1);`)
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('quick_check')).toEqual([{ quick_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toHaveLength(1)
      raw.unsafeMode(true)
      raw.pragma('writable_schema = ON')
      raw.prepare("UPDATE sqlite_master SET sql = 'CREATE TABLE c (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id), n INTEGER CHECK (n >= 0))' WHERE name = 'c'").run()
      raw.close()
      const reopened = new Database(join(dir, 'semantics.db'))
      expect(JSON.stringify(reopened.pragma('integrity_check'))).toMatch(/CHECK constraint failed/)
      reopened.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

const benchScales = process.env.DB14_BENCH === '1' ? [10_000, 100_000] : [1_000]

describe('DB-14 startup scale qualification', () => {
  for (const scale of benchScales) it(`${scale} orders`, () => {
    const env = setupTestDatabase()
    const runs = 7
    try {
      seedDb10Fixture(scale)
      getRawConnection().pragma('wal_checkpoint(TRUNCATE)')
      const fixture = getDatabasePath()
      closeDatabase()
      const measure = (label: string, prepare: (path: string) => void) => {
        const durations: number[] = []
        const finalize: number[] = []
        let integrity = 0
        for (let run = 0; run < runs; run += 1) {
          const live = join(env.dir, `${label}-${run}`, 'erp.db')
          mkdirSync(join(env.dir, `${label}-${run}`))
          copyFileSync(fixture, live)
          prepare(live)
          setDatabasePath(live)
          const checks = countFullChecks()
          const start = performance.now()
          openVerifiedDatabase()
          durations.push(performance.now() - start)
          integrity = checks.integrity()
          vi.restoreAllMocks()
          const finalizeStart = performance.now()
          finalizeMigrationRecovery(getRawConnection())
          finalize.push(performance.now() - finalizeStart)
          closeDatabase()
          rmSync(join(env.dir, `${label}-${run}`), { recursive: true, force: true })
        }
        durations.sort((a, b) => a - b)
        finalize.sort((a, b) => a - b)
        const result = {
          scenario: label, scale, bytes: statSync(fixture).size, integrityChecks: integrity,
          medianMs: +durations[3]!.toFixed(1), p95Ms: +durations[runs - 1]!.toFixed(1),
          finalizeMedianMs: +finalize[3]!.toFixed(1), rss: process.memoryUsage().rss
        }
        console.log(`DB14_MEASURE ${JSON.stringify(result)}`)
        return result
      }
      expect(measure('normal-current', () => undefined).integrityChecks).toBe(1)
      // Same history rewound to supported prefix 0043 (0044-0052 are triggers, indexes and two
      // nullable columns): DB-01 recovery snapshot + migration + DB-07 gate.
      expect(measure('post-migration-from-0043', (live) => {
        const raw = new Database(live)
        for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'db06_integer_%'").all() as Array<{ name: string }>) {
          raw.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`)
        }
        raw.exec(`DROP INDEX cash_transactions_ref_idx; DROP INDEX deliveries_release_idx;
          DROP TRIGGER db06_expenses_amount_insert; DROP TRIGGER db06_expenses_amount_update;
          DROP TRIGGER db06_recurring_amount_insert; DROP TRIGGER db06_recurring_amount_update;
          DROP INDEX users_username_live_unique; CREATE UNIQUE INDEX users_username_unique ON users (username);
          DROP INDEX worker_transactions_assignment_earning_unique; ALTER TABLE worker_transactions DROP COLUMN assignment_id;
          DROP INDEX expenses_uncollected_product_idx; ALTER TABLE expenses DROP COLUMN uncollected_product_id;`)
        raw.prepare('DELETE FROM __drizzle_migrations WHERE created_at > ?').run(journal.entries[43]!.when)
        raw.close()
      }).integrityChecks).toBe(7)
    } finally {
      setDatabasePath(undefined)
      env.cleanup()
    }
  }, 3_600_000)
})
