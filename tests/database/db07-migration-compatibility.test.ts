import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyPragmas } from '@main/db/pragmas'
import {
  runMigrationsFromFolder,
  runPendingMigrations
} from '@main/migrations/migration-runner'
import {
  closeDatabase,
  getDatabase,
  getRawConnection,
  setDatabasePath
} from '@main/db/connection'
import {
  finalizeMigrationRecovery,
  getMigrationRecoveryPaths,
  readMigrationRecoveryMarker,
  recoverInterruptedMigration
} from '@main/migrations/migration-recovery'

const MIGRATIONS = resolve('drizzle/migrations')
const journal = JSON.parse(
  readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')
) as { entries: Array<{ idx: number; when: number; tag: string }> }

function withDatabase(run: (raw: Database.Database) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'aura-db07-compatibility-'))
  const raw = new Database(join(dir, 'erp.db'))
  applyPragmas(raw)
  try {
    run(raw)
  } finally {
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function migrationRows(raw: Database.Database): unknown[] {
  return raw.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at').all()
}

function prefixFolder(dir: string, throughIdx: number): string {
  const folder = join(dir, `prefix-${throughIdx}`)
  mkdirSync(join(folder, 'meta'), { recursive: true })
  const entries = journal.entries.filter(({ idx }) => idx <= throughIdx)
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({
    version: '7',
    dialect: 'sqlite',
    entries: entries.map((entry) => ({ ...entry, version: '6', breakpoints: true }))
  }))
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  return folder
}

function useDatabasePath<T>(databasePath: string, run: (raw: Database.Database) => T): T {
  setDatabasePath(databasePath)
  try {
    return run(getRawConnection())
  } finally {
    closeDatabase()
    setDatabasePath(undefined)
  }
}

describe('DB-07 migration compatibility gate', () => {
  it('rejects a newer journal without mutating data or history', () => {
    withDatabase((raw) => {
      runMigrationsFromFolder(raw, MIGRATIONS)
      raw.prepare("INSERT INTO customers (id, name) VALUES (7001, 'future sentinel')").run()
      raw.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
        'future-migration-hash',
        (journal.entries.at(-1)?.when ?? 0) + 86_400_000
      )
      const rowsBefore = migrationRows(raw)
      const schemaBefore = raw
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
        .all()

      expect(() => runMigrationsFromFolder(raw, MIGRATIONS)).toThrow(/newer|future/i)
      expect(migrationRows(raw)).toEqual(rowsBefore)
      expect(raw.prepare('SELECT name FROM customers WHERE id = 7001').get()).toEqual({
        name: 'future sentinel'
      })
      expect(
        raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all()
      ).toEqual(schemaBefore)
    })
  })

  it('rejects a changed historical journal hash before mutation', () => {
    withDatabase((raw) => {
      runMigrationsFromFolder(raw, MIGRATIONS)
      raw.prepare('UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?').run(
        'altered-history',
        journal.entries[10]?.when
      )
      const rowsBefore = migrationRows(raw)

      expect(() => runMigrationsFromFolder(raw, MIGRATIONS)).toThrow(/history|hash|inconsistent/i)
      expect(migrationRows(raw)).toEqual(rowsBefore)
    })
  })

  it('rejects an unjournaled nonempty application database', () => {
    withDatabase((raw) => {
      raw.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
      raw.prepare("INSERT INTO customers (id, name) VALUES (7002, 'unknown sentinel')").run()

      expect(() => runMigrationsFromFolder(raw, MIGRATIONS)).toThrow(/unknown|journal|version/i)
      expect(raw.prepare('SELECT name FROM customers WHERE id = 7002').get()).toEqual({
        name: 'unknown sentinel'
      })
      expect(
        raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'").get()
      ).toBeUndefined()
    })
  })

  it('rejects current journal state when required schema is missing', () => {
    withDatabase((raw) => {
      runMigrationsFromFolder(raw, MIGRATIONS)
      raw.exec('DROP TABLE financial_command_requests')

      expect(() => runMigrationsFromFolder(raw, MIGRATIONS)).toThrow(/schema|table|structural/i)
    })
  })

  it('rejects a changed released SQL file before creating a journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db07-bundle-drift-'))
    const folder = join(dir, 'migrations')
    mkdirSync(join(folder, 'meta'), { recursive: true })
    try {
      copyFileSync(join(MIGRATIONS, 'meta/_journal.json'), join(folder, 'meta/_journal.json'))
      for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
        copyFileSync(join(MIGRATIONS, file), join(folder, file))
      }
      writeFileSync(
        join(folder, `${journal.entries[10]!.tag}.sql`),
        `${readFileSync(join(folder, `${journal.entries[10]!.tag}.sql`), 'utf8')}\n-- drift`
      )
      const raw = new Database(join(dir, 'erp.db'))
      applyPragmas(raw)
      try {
        expect(() => runMigrationsFromFolder(raw, folder)).toThrow(/BUNDLE_MISMATCH|changed identity/)
        expect(
          raw.prepare("SELECT 1 FROM sqlite_master WHERE name='__drizzle_migrations'").get()
        ).toBeUndefined()
      } finally {
        raw.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('production startup path blocks newer history without creating recovery state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db07-newer-startup-'))
    const databasePath = join(dir, 'erp.db')
    try {
      useDatabasePath(databasePath, (raw) => {
        runMigrationsFromFolder(raw, MIGRATIONS)
        raw.prepare("INSERT INTO customers (id, name) VALUES (7101, 'future startup')").run()
        raw.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
          'future-startup-hash',
          journal.entries.at(-1)!.when + 1
        )
        const before = migrationRows(raw)
        expect(() => runPendingMigrations(getDatabase())).toThrow(/DB_MIGRATION_NEWER/)
        expect(migrationRows(raw)).toEqual(before)
        expect(raw.prepare('SELECT name FROM customers WHERE id=7101').get()).toEqual({
          name: 'future startup'
        })
        expect(existsSync(getMigrationRecoveryPaths(databasePath).marker)).toBe(false)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('production startup path blocks inconsistent history without creating recovery state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db07-inconsistent-startup-'))
    const databasePath = join(dir, 'erp.db')
    try {
      useDatabasePath(databasePath, (raw) => {
        runMigrationsFromFolder(raw, MIGRATIONS)
        raw.prepare('UPDATE __drizzle_migrations SET hash=? WHERE created_at=?').run(
          'inconsistent-startup-hash',
          journal.entries[20]!.when
        )
        const before = migrationRows(raw)
        expect(() => runPendingMigrations(getDatabase())).toThrow(/HISTORY_MISMATCH/)
        expect(migrationRows(raw)).toEqual(before)
        expect(existsSync(getMigrationRecoveryPaths(databasePath).marker)).toBe(false)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('production startup blocks a structurally inconsistent historical prefix before recovery or migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db07-historical-structure-'))
    const databasePath = join(dir, 'erp.db')
    try {
      useDatabasePath(databasePath, (raw) => {
        runMigrationsFromFolder(raw, prefixFolder(dir, 43))
        raw.exec('DROP TABLE financial_command_requests')
        const before = migrationRows(raw)
        expect(() => runPendingMigrations(getDatabase())).toThrow(/STRUCTURAL.*financial_command_requests/)
        expect(migrationRows(raw)).toEqual(before)
        expect(existsSync(getMigrationRecoveryPaths(databasePath).marker)).toBe(false)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('current database business-shape corruption is rejected before normal startup', () => {
    withDatabase((raw) => {
      runMigrationsFromFolder(raw, MIGRATIONS)
      raw.prepare("INSERT INTO products (id, code, name) VALUES (7201, 'DB07', 'DB07 product')").run()
      raw.prepare(
        `INSERT INTO finished_goods_valuation_cutovers
          (product_id, movement_id_through, opening_qty_micro, opening_value_minor, status,
           classification, affected_movement_count, historical_cogs_delta_minor, evidence, created_at)
         VALUES (7201, 0, 0, 0, 'ready', 'unaffected', 0, 0, 'not-json', '2026-01-01')`
      ).run()
      expect(() => runMigrationsFromFolder(raw, MIGRATIONS)).toThrow(/DB_MIGRATION_BUSINESS/)
    })
  })

  it('foreign-key corruption is blocked before recovery snapshot or migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db07-corrupt-old-'))
    const databasePath = join(dir, 'erp.db')
    try {
      useDatabasePath(databasePath, (raw) => {
        runMigrationsFromFolder(raw, prefixFolder(dir, 43))
        raw.pragma('foreign_keys = OFF')
        raw.prepare('INSERT INTO work_sheet_workers (work_sheet_id, worker_id) VALUES (?, ?)').run(
          999_991,
          999_992
        )
        raw.pragma('foreign_keys = ON')
        expect(() => runPendingMigrations(getDatabase())).toThrow(/foreign-key violation/)
        expect(migrationRows(raw)).toHaveLength(44)
        expect(existsSync(getMigrationRecoveryPaths(databasePath).marker)).toBe(false)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('post-migration verification failure leaves migrated state and restores on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db07-post-verify-failure-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 43))
      raw.prepare("INSERT INTO customers (id, name) VALUES (7102, 'verification sentinel')").run()

      expect(() =>
        runPendingMigrations(getDatabase(), {
          afterMigrationCommitted: () => raw.exec('DROP TRIGGER db06_expenses_amount_insert')
        })
      ).toThrow(/Required migration trigger/)
      expect(readMigrationRecoveryMarker(databasePath)?.phase).toBe('migrated')
      closeDatabase()

      expect(recoverInterruptedMigration(databasePath).action).toBe('restored')
      const restored = getRawConnection()
      expect(migrationRows(restored)).toHaveLength(44)
      expect(restored.prepare('SELECT name FROM customers WHERE id=7102').get()).toEqual({
        name: 'verification sentinel'
      })
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('crash after structural verification but before verified publication restores conservatively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db07-after-structural-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 43))
      expect(() =>
        runPendingMigrations(getDatabase(), {
          afterStructuralVerification: () => {
            throw new Error('crash after structural verification')
          }
        })
      ).toThrow(/crash after structural verification/)
      expect(readMigrationRecoveryMarker(databasePath)?.phase).toBe('migrated')
      closeDatabase()
      expect(recoverInterruptedMigration(databasePath).action).toBe('restored')
      expect(migrationRows(getRawConnection())).toHaveLength(44)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects recovery metadata associated with a different source history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db07-recovery-identity-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 43))
      expect(() =>
        runPendingMigrations(getDatabase(), {
          afterRecoveryPrepared: () => {
            throw new Error('stop after preparation')
          }
        })
      ).toThrow(/stop after preparation/)
      const paths = getMigrationRecoveryPaths(databasePath)
      const marker = JSON.parse(readFileSync(paths.marker, 'utf8')) as Record<string, unknown>
      marker.fromMigrationFingerprint = 'a'.repeat(64)
      writeFileSync(paths.marker, JSON.stringify(marker))
      closeDatabase()

      expect(() => recoverInterruptedMigration(databasePath)).toThrow(/fingerprint/)
      expect(existsSync(paths.marker)).toBe(true)
      expect(migrationRows(getRawConnection())).toHaveLength(44)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('continues to recover a DB-01 version-1 prepared marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db07-v1-marker-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 43))
      expect(() =>
        runPendingMigrations(getDatabase(), {
          afterRecoveryPrepared: () => {
            throw new Error('leave prepared marker')
          }
        })
      ).toThrow(/leave prepared marker/)
      const paths = getMigrationRecoveryPaths(databasePath)
      const marker = JSON.parse(readFileSync(paths.marker, 'utf8')) as Record<string, unknown>
      marker.version = 1
      delete marker.fromMigrationCount
      delete marker.targetMigrationCount
      delete marker.fromMigrationFingerprint
      delete marker.targetMigrationFingerprint
      writeFileSync(paths.marker, JSON.stringify(marker))
      closeDatabase()

      expect(recoverInterruptedMigration(databasePath).action).toBe('restored')
      expect(migrationRows(getRawConnection())).toHaveLength(44)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('interruption before recovery preparation leaves the canonical source untouched and retries safely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db07-before-recovery-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 43))
      raw.prepare("INSERT INTO customers (id, name) VALUES (7103, 'pre-recovery sentinel')").run()
      const before = migrationRows(raw)

      expect(() =>
        runPendingMigrations(getDatabase(), {
          beforeRecoveryPreparation: () => {
            throw new Error('crash before recovery preparation')
          }
        })
      ).toThrow(/crash before recovery preparation/)
      expect(migrationRows(raw)).toEqual(before)
      expect(raw.prepare('SELECT name FROM customers WHERE id=7103').get()).toEqual({
        name: 'pre-recovery sentinel'
      })
      expect(readMigrationRecoveryMarker(databasePath)).toBeUndefined()

      runPendingMigrations(getDatabase())
      expect(readMigrationRecoveryMarker(databasePath)?.phase).toBe('verified')
      finalizeMigrationRecovery(raw)
      expect(migrationRows(raw)).toHaveLength(journal.entries.length)
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([0, 40, 41, 42, 43])(
    'production runner upgrades representative canonical prefix %i with recovery and exact head',
    (prefix) => {
      const dir = mkdtempSync(join(tmpdir(), `aura-db07-upgrade-${prefix}-`))
      const databasePath = join(dir, 'erp.db')
      try {
        setDatabasePath(databasePath)
        const raw = getRawConnection()
        runMigrationsFromFolder(raw, prefixFolder(dir, prefix))
        runPendingMigrations(getDatabase())
        expect(migrationRows(raw)).toHaveLength(journal.entries.length)
        expect(readMigrationRecoveryMarker(databasePath)?.phase).toBe('verified')
        finalizeMigrationRecovery(raw)
        expect(readMigrationRecoveryMarker(databasePath)).toBeUndefined()
        expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
        expect(raw.pragma('foreign_key_check')).toEqual([])
      } finally {
        closeDatabase()
        setDatabasePath(undefined)
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it('fresh and already-current production paths do not create migration recovery markers', () => {
    for (const mode of ['fresh', 'current'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `aura-db07-${mode}-`))
      const databasePath = join(dir, 'erp.db')
      try {
        setDatabasePath(databasePath)
        const raw = getRawConnection()
        if (mode === 'current') runMigrationsFromFolder(raw, MIGRATIONS)
        runPendingMigrations(getDatabase())
        expect(migrationRows(raw)).toHaveLength(journal.entries.length)
        expect(existsSync(getMigrationRecoveryPaths(databasePath).marker)).toBe(false)
      } finally {
        closeDatabase()
        setDatabasePath(undefined)
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})
