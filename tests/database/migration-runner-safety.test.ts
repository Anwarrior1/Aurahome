import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
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
  cancelMigrationRecovery,
  finalizeMigrationRecovery,
  getMigrationRecoveryPaths,
  readMigrationRecoveryMarker,
  recoverInterruptedMigration
} from '@main/migrations/migration-recovery'
import {
  closeDatabase,
  getDatabase,
  getRawConnection,
  setDatabasePath
} from '@main/db/connection'

const MIGRATIONS = resolve('drizzle/migrations')

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

interface Journal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

const canonicalJournal = JSON.parse(
  readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')
) as Journal

const migration0001Statements = readMigrationFiles({ migrationsFolder: MIGRATIONS })
  .find((migration) => migration.folderMillis === canonicalJournal.entries[1]?.when)
  ?.sql.filter((statement) => statement.trim())

if (!migration0001Statements) throw new Error('Migration 0001 is missing from the canonical history')

function makeCase(): { dir: string; db: Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), 'aura-migration-safety-'))
  const db = new Database(join(dir, 'erp.db'))
  applyPragmas(db)
  return { dir, db }
}

function cleanup(testCase: { dir: string; db: Database.Database }): void {
  testCase.db.close()
  rmSync(testCase.dir, { recursive: true, force: true })
}

function prefixFolder(dir: string, throughIdx: number): string {
  const folder = join(dir, `migrations-through-${throughIdx}`)
  mkdirSync(join(folder, 'meta'), { recursive: true })
  const entries = canonicalJournal.entries.filter((entry) => entry.idx <= throughIdx)
  writeFileSync(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...canonicalJournal, entries })
  )
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  return folder
}

function assertHealthy(db: Database.Database): void {
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(db.pragma('foreign_key_check')).toEqual([])
}

function journalRows(db: Database.Database): Array<{ hash: string; created_at: number }> {
  return db
    .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')
    .all() as Array<{ hash: string; created_at: number }>
}

function seedSingleLegacyAssignment(db: Database.Database): void {
  db.exec(`
    INSERT INTO customers (id, name, created_at)
      VALUES (1, 'عميل الترقية', '2026-01-01');
    INSERT INTO workers (id, name, created_at)
      VALUES (1, 'عامل الترقية', '2026-01-01');
    INSERT INTO orders
      (id, document_number, customer_id, status, total_minor, paid_minor, remaining_minor, created_at)
      VALUES (1, 'SO-MIGRATION-1', 1, 'confirmed', 1000000, 0, 1000000, '2026-01-01');
    INSERT INTO work_sheets
      (id, document_number, order_id, issued_at, created_at)
      VALUES (1, 'MO-MIGRATION-1', 1, '2026-01-02', '2026-01-02');
    INSERT INTO work_sheet_workers (work_sheet_id, worker_id) VALUES (1, 1);
  `)
}

function seedDenseLegacyProduction(db: Database.Database): void {
  db.exec(`
    INSERT INTO customers (id, name, created_at)
      VALUES (1, 'عميل أول', '2026-01-01'), (2, 'عميل ثان', '2026-01-01');
    INSERT INTO material_categories (id, name, created_at)
      VALUES (1, 'أخشاب', '2026-01-01');
    INSERT INTO materials
      (id, sku, name, category_id, unit, current_market_price_micro, pricing_rule, created_at)
      VALUES (1, 'MAT-1', 'لوح', 1, 'لوح', 150000000, 'exact', '2026-01-01');
    INSERT INTO machines
      (id, name, costing_unit, default_rate_micro, created_at)
      VALUES (1, 'آلة قص', 'ساعة', 30000000, '2026-01-01');
    INSERT INTO workers (id, name, created_at)
      VALUES
        (1, 'عامل 1', '2026-01-01'),
        (2, 'عامل 2', '2026-01-01'),
        (3, 'عامل 3', '2026-01-01');
    INSERT INTO orders
      (id, document_number, customer_id, status, total_minor, paid_minor, remaining_minor,
       completed_at, created_at)
      VALUES
        (1, 'SO-MIGRATION-10', 1, 'completed', 5000000, 5000000, 0,
         '2026-02-01T10:00:00Z', '2026-01-02'),
        (2, 'SO-MIGRATION-11', 2, 'confirmed', 6000000, 1000000, 5000000,
         NULL, '2026-01-03');
    INSERT INTO work_sheets
      (id, document_number, order_id, issued_at, notes, created_by, created_at)
      VALUES
        (10, 'MO-MIGRATION-10', 1, '2026-01-10', 'ورقة أولى', 7, '2026-01-10'),
        (11, 'MO-MIGRATION-11', 2, '2026-01-11', 'ورقة ثانية', 8, '2026-01-11');
    INSERT INTO work_sheet_workers (work_sheet_id, worker_id)
      VALUES (10, 1), (10, 2), (11, 2), (11, 3);
    INSERT INTO order_material_lines
      (id, order_id, material_id, physical_qty_micro, actual_cost_minor,
       commercial_qty_micro, commercial_value_minor, pricing_rule_used, notes, created_at)
      VALUES
        (20, 1, 1, 1000000, 150000, 1000000, 200000, 'exact', 'خامة 1', '2026-01-10'),
        (21, 2, 1, 2000000, 300000, 2000000, 400000, 'exact', 'خامة 2', '2026-01-11');
    INSERT INTO order_machine_usage
      (id, order_id, machine_id, usage_qty_micro, rate_micro, calculated_minor,
       final_amount_minor, notes, created_at)
      VALUES
        (30, 1, 1, 1000000, 30000000, 30000, 30000, 'آلة 1', '2026-01-10'),
        (31, 2, 1, 2000000, 30000000, 60000, 65000, 'آلة 2', '2026-01-11');
    INSERT INTO order_worker_assignments
      (id, order_id, worker_id, method, amount_minor, earned, earned_at, notes)
      VALUES
        (40, 1, 1, 'fixed', 50000, 1, '2026-02-01', 'أجر 1'),
        (41, 2, 3, 'fixed', 70000, 0, NULL, 'أجر 2');
  `)
}

function seedStableSentinel(db: Database.Database, suffix: number): void {
  const base = 10_000 + suffix * 10
  db.prepare('INSERT INTO customers (id, name, created_at) VALUES (?, ?, ?)').run(
    base,
    `Customer ${suffix}`,
    '2026-01-01'
  )
  db.prepare('INSERT INTO workers (id, name, created_at) VALUES (?, ?, ?)').run(
    base,
    `Worker ${suffix}`,
    '2026-01-01'
  )
  db.prepare(`
    INSERT INTO orders
      (id, document_number, customer_id, status, total_minor, paid_minor, remaining_minor, created_at)
      VALUES (?, ?, ?, 'confirmed', 1000, 0, 1000, '2026-01-01')
  `).run(base, `SO-PREFIX-${suffix}`, base)
  db.prepare(`
    INSERT INTO work_sheets (id, document_number, order_id, issued_at, created_at)
      VALUES (?, ?, ?, '2026-01-02', '2026-01-02')
  `).run(base, `MO-PREFIX-${suffix}`, base)
  db.prepare('INSERT INTO work_sheet_workers (work_sheet_id, worker_id) VALUES (?, ?)').run(
    base,
    base
  )
}

describe('production migration runner — SQLite table rebuild safety', () => {
  it('migrates a fresh database, records the canonical journal, and is idempotent', () => {
    const testCase = makeCase()
    try {
      runMigrationsFromFolder(testCase.db, MIGRATIONS)
      const expected = readMigrationFiles({ migrationsFolder: MIGRATIONS }).map((migration) => ({
        hash: migration.hash,
        created_at: migration.folderMillis
      }))
      const firstJournal = journalRows(testCase.db)

      expect(firstJournal).toEqual(expected)
      expect(firstJournal).toHaveLength(canonicalJournal.entries.length)
      expect(
        testCase.db
          .prepare(
            "SELECT action FROM audit_log WHERE entity_id='0001_big_lyja' ORDER BY id"
          )
          .all()
      ).toEqual([{ action: 'migration.0001.workSheetWorkers.verified' }])
      expect(
        testCase.db.prepare(
          "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='work_sheets'"
        ).get()
      ).toEqual({ c: 1 })
      assertHealthy(testCase.db)

      runMigrationsFromFolder(testCase.db, MIGRATIONS)
      expect(journalRows(testCase.db)).toEqual(firstJournal)
      expect(
        testCase.db
          .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity_id='0001_big_lyja'")
          .get()
      ).toEqual({ c: 1 })
      assertHealthy(testCase.db)
    } finally {
      cleanup(testCase)
    }
  })

  it('closes the exact audit reproduction: 1 sheet + 1 worker remains 1 + 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-production-runner-reproduction-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 0))
      seedSingleLegacyAssignment(raw)
      expect(raw.prepare('SELECT COUNT(*) AS c FROM work_sheets').get()).toEqual({ c: 1 })
      expect(
        raw.prepare('SELECT COUNT(*) AS c FROM work_sheet_workers').get()
      ).toEqual({ c: 1 })

      // This is the exact high-level runner called by application startup.
      runPendingMigrations(getDatabase())

      expect(raw.prepare('SELECT COUNT(*) AS c FROM work_sheets').get()).toEqual({ c: 1 })
      expect(
        raw.prepare('SELECT COUNT(*) AS c FROM work_sheet_workers').get()
      ).toEqual({ c: 1 })
      expect(
        raw.prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers').all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      const recovery = readMigrationRecoveryMarker(databasePath)
      expect(recovery).toMatchObject({
        phase: 'verified',
        fromMigrationCreatedAt: canonicalJournal.entries[0]?.when,
        targetMigrationCreatedAt: canonicalJournal.entries.at(-1)?.when
      })
      expect(existsSync(recovery?.backupPath ?? '')).toBe(true)
      const backup = new Database(recovery?.backupPath as string, { readonly: true })
      try {
        expect(
          backup.prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers').all()
        ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
        expect(journalRows(backup)).toHaveLength(1)
        assertHealthy(backup)
      } finally {
        backup.close()
      }
      const retainedBackup = finalizeMigrationRecovery(raw)
      expect(retainedBackup).toBe(recovery?.backupPath)
      expect(readMigrationRecoveryMarker(databasePath)).toBeUndefined()
      expect(existsSync(retainedBackup as string)).toBe(true)
      assertHealthy(raw)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recovers an interruption after the durable backup is prepared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-migration-prepared-recovery-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 0))
      seedSingleLegacyAssignment(raw)

      expect(() =>
        runPendingMigrations(getDatabase(), {
          afterRecoveryPrepared: () => {
            throw new Error('simulated interruption after recovery preparation')
          }
        })
      ).toThrow(/simulated interruption/)
      expect(readMigrationRecoveryMarker(databasePath)?.phase).toBe('prepared')
      expect(journalRows(raw)).toHaveLength(1)

      raw.prepare('DELETE FROM work_sheet_workers').run()
      closeDatabase()
      const recovered = recoverInterruptedMigration(databasePath)
      expect(recovered.action).toBe('restored')
      expect(readMigrationRecoveryMarker(databasePath)).toBeUndefined()

      const restored = getRawConnection()
      expect(journalRows(restored)).toHaveLength(1)
      expect(
        restored.prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers').all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(restored)

      runPendingMigrations(getDatabase())
      finalizeMigrationRecovery(restored)
      expect(journalRows(restored)).toHaveLength(canonicalJournal.entries.length)
      assertHealthy(restored)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restores the pre-upgrade database after interruption immediately after commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-migration-post-commit-recovery-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 0))
      seedSingleLegacyAssignment(raw)

      expect(() =>
        runPendingMigrations(getDatabase(), {
          afterMigrationCommitted: () => {
            throw new Error('simulated process loss after migration commit')
          }
        })
      ).toThrow(/simulated process loss/)
      expect(journalRows(raw)).toHaveLength(canonicalJournal.entries.length)
      expect(readMigrationRecoveryMarker(databasePath)?.phase).toBe('migrated')

      closeDatabase()
      const recovered = recoverInterruptedMigration(databasePath)
      expect(recovered.action).toBe('restored')

      const restored = getRawConnection()
      expect(journalRows(restored)).toHaveLength(1)
      expect(
        restored.prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers').all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(restored)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a verified committed database after restart and retains its backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-migration-verified-reopen-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 0))
      seedSingleLegacyAssignment(raw)

      expect(() =>
        runPendingMigrations(getDatabase(), {
          afterMigrationVerified: () => {
            throw new Error('simulated process loss after migration verification')
          }
        })
      ).toThrow(/simulated process loss/)
      const marker = readMigrationRecoveryMarker(databasePath)
      expect(marker?.phase).toBe('verified')
      closeDatabase()

      const recovered = recoverInterruptedMigration(databasePath)
      expect(recovered).toEqual({ action: 'verified', backupPath: marker?.backupPath })
      expect(readMigrationRecoveryMarker(databasePath)?.phase).toBe('verified')
      expect(existsSync(marker?.backupPath ?? '')).toBe(true)

      const reopened = getRawConnection()
      runPendingMigrations(getDatabase())
      finalizeMigrationRecovery(reopened)
      expect(readMigrationRecoveryMarker(databasePath)).toBeUndefined()
      expect(journalRows(reopened)).toHaveLength(canonicalJournal.entries.length)
      expect(
        reopened.prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers').all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(reopened)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed without changing the live database when the recovery copy is corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-migration-corrupt-recovery-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 0))
      seedSingleLegacyAssignment(raw)

      expect(() =>
        runPendingMigrations(getDatabase(), {
          afterRecoveryPrepared: () => {
            throw new Error('stop after backup')
          }
        })
      ).toThrow(/stop after backup/)
      const marker = readMigrationRecoveryMarker(databasePath)
      writeFileSync(marker?.backupPath as string, 'corrupt recovery copy')
      closeDatabase()

      expect(() => recoverInterruptedMigration(databasePath)).toThrow(/checksum failed/)
      expect(existsSync(getMigrationRecoveryPaths(databasePath).marker)).toBe(true)

      const unchanged = getRawConnection()
      expect(journalRows(unchanged)).toHaveLength(1)
      expect(
        unchanged.prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers').all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(unchanged)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lets a higher-level rollback cancel only the active marker and retain the recovery copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-migration-higher-rollback-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 0))
      seedSingleLegacyAssignment(raw)

      expect(() =>
        runPendingMigrations(getDatabase(), {
          afterRecoveryPrepared: () => {
            throw new Error('higher-level operation will roll back')
          }
        })
      ).toThrow(/higher-level operation/)
      const marker = readMigrationRecoveryMarker(databasePath)
      expect(cancelMigrationRecovery(databasePath)).toBe(marker?.backupPath)
      expect(readMigrationRecoveryMarker(databasePath)).toBeUndefined()
      expect(existsSync(marker?.backupPath ?? '')).toBe(true)
      expect(journalRows(raw)).toHaveLength(1)
      expect(
        raw.prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers').all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(raw)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not start migration when durable recovery storage cannot be created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-migration-backup-storage-failure-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 0))
      seedSingleLegacyAssignment(raw)
      const oldJournal = journalRows(raw)
      writeFileSync(join(dir, '.migration-recovery'), 'blocks recovery directory creation')

      expect(() => runPendingMigrations(getDatabase())).toThrow()
      expect(journalRows(raw)).toEqual(oldJournal)
      expect(
        raw.prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers').all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(raw)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recovers a transaction failure after the migration marker enters migrating phase', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-migration-transaction-recovery-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 0))
      seedSingleLegacyAssignment(raw)

      expect(() =>
        runPendingMigrations(getDatabase(), {
          execution: {
            afterStatement: (event) => {
              if (
                event.migrationCreatedAt === canonicalJournal.entries[1]?.when &&
                event.statementIndex === 20
              ) {
                throw new Error('simulated migration statement failure')
              }
            }
          }
        })
      ).toThrow(/simulated migration statement failure/)
      expect(readMigrationRecoveryMarker(databasePath)?.phase).toBe('migrating')
      expect(journalRows(raw)).toHaveLength(1)
      expect(
        raw.prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers').all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      closeDatabase()

      expect(recoverInterruptedMigration(databasePath).action).toBe('restored')
      const restored = getRawConnection()
      expect(journalRows(restored)).toHaveLength(1)
      expect(
        restored.prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers').all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(restored)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restores the backup if a verified migrated file is corrupt when reopened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-migration-verified-corruption-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 0))
      seedSingleLegacyAssignment(raw)

      expect(() =>
        runPendingMigrations(getDatabase(), {
          afterMigrationVerified: () => {
            throw new Error('stop with verified marker')
          }
        })
      ).toThrow(/stop with verified marker/)
      expect(readMigrationRecoveryMarker(databasePath)?.phase).toBe('verified')
      closeDatabase()
      writeFileSync(databasePath, 'corrupt migrated database')

      const recovered = recoverInterruptedMigration(databasePath)
      expect(recovered.action).toBe('restored')
      const restored = getRawConnection()
      expect(journalRows(restored)).toHaveLength(1)
      expect(
        restored.prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers').all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(restored)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('orders startup recovery before opening and verifies again after migration', () => {
    // DB-14: the pre-migration full check is runPendingMigrations' own entry gate.
    const source = readFileSync(resolve('src/main/app/database-startup.ts'), 'utf8')
    const index = readFileSync(resolve('src/main/index.ts'), 'utf8')
    const recoverAt = source.indexOf('recoverInterruptedMigration(getDatabasePath())')
    const migrateAt = source.indexOf('runPendingMigrations(getDatabase())')
    const integrityChecks = [...source.matchAll(/runIntegrityCheck\(\)/g)].map(
      (match) => match.index
    )

    expect(recoverAt).toBeGreaterThan(-1)
    expect(recoverAt).toBeLessThan(migrateAt)
    expect(integrityChecks).toHaveLength(1)
    expect(integrityChecks[0]).toBeGreaterThan(migrateAt)
    // DB-15 added recurring-expense posting to the same "startup wrote" rule.
    expect(source).toContain(
      'if (migrated || cutovers.initialized > 0 || recurring.created > 0) runIntegrityCheck()'
    )
    expect(index.indexOf('openVerifiedDatabase()')).toBeLessThan(
      index.indexOf('finalizeMigrationRecovery(getRawConnection())')
    )
    expect(index).not.toMatch(/getDatabase\(\)|runPendingMigrations|runIntegrityCheck/)
  })

  it('preserves every dependent assignment and every rebuilt production row from 0000', () => {
    const testCase = makeCase()
    try {
      runMigrationsFromFolder(testCase.db, prefixFolder(testCase.dir, 0))
      seedDenseLegacyProduction(testCase.db)

      const before = {
        workers: testCase.db
          .prepare(
            'SELECT work_sheet_id, worker_id FROM work_sheet_workers ORDER BY work_sheet_id, worker_id'
          )
          .all(),
        sheets: testCase.db
          .prepare(
            'SELECT id, document_number, order_id, issued_at, notes, created_by, created_at FROM work_sheets ORDER BY id'
          )
          .all(),
        materials: testCase.db
          .prepare(
            'SELECT id, order_id, material_id, physical_qty_micro, actual_cost_minor, commercial_qty_micro, commercial_value_minor, pricing_rule_used, notes, created_at FROM order_material_lines ORDER BY id'
          )
          .all(),
        machines: testCase.db
          .prepare(
            'SELECT id, order_id, machine_id, usage_qty_micro, rate_micro, calculated_minor, final_amount_minor, notes, created_at FROM order_machine_usage ORDER BY id'
          )
          .all(),
        labour: testCase.db
          .prepare(
            'SELECT id, order_id, worker_id, method, amount_minor, earned, earned_at, notes FROM order_worker_assignments ORDER BY id'
          )
          .all()
      }

      runMigrationsFromFolder(testCase.db, MIGRATIONS)

      expect(
        testCase.db
          .prepare(
            'SELECT work_sheet_id, worker_id FROM work_sheet_workers ORDER BY work_sheet_id, worker_id'
          )
          .all()
      ).toEqual(before.workers)
      expect(
        testCase.db
          .prepare(
            'SELECT id, document_number, order_id, issued_at, notes, created_by, created_at FROM work_sheets ORDER BY id'
          )
          .all()
      ).toEqual(before.sheets)
      expect(
        testCase.db
          .prepare(
            'SELECT id, order_id, material_id, physical_qty_micro, actual_cost_minor, commercial_qty_micro, commercial_value_minor, pricing_rule_used, notes, created_at FROM order_material_lines ORDER BY id'
          )
          .all()
      ).toEqual(before.materials)
      expect(
        testCase.db
          .prepare(
            'SELECT id, order_id, machine_id, usage_qty_micro, rate_micro, calculated_minor, final_amount_minor, notes, created_at FROM order_machine_usage ORDER BY id'
          )
          .all()
      ).toEqual(before.machines)
      expect(
        testCase.db
          .prepare(
            'SELECT id, order_id, worker_id, method, amount_minor, earned, earned_at, notes FROM order_worker_assignments ORDER BY id'
          )
          .all()
      ).toEqual(before.labour)
      expect(
        testCase.db
          .prepare('SELECT id, work_sheet_id FROM order_material_lines ORDER BY id')
          .all()
      ).toEqual([
        { id: 20, work_sheet_id: 10 },
        { id: 21, work_sheet_id: 11 }
      ])
      expect(
        testCase.db
          .prepare('SELECT id, work_sheet_id FROM order_machine_usage ORDER BY id')
          .all()
      ).toEqual([
        { id: 30, work_sheet_id: 10 },
        { id: 31, work_sheet_id: 11 }
      ])
      expect(
        testCase.db
          .prepare('SELECT id, work_sheet_id FROM order_worker_assignments ORDER BY id')
          .all()
      ).toEqual([
        { id: 40, work_sheet_id: 10 },
        { id: 41, work_sheet_id: 11 }
      ])
      assertHealthy(testCase.db)
    } finally {
      cleanup(testCase)
    }
  })

  it('continues an existing Drizzle journal already past 0001 without replaying it', () => {
    const testCase = makeCase()
    try {
      const through0002 = prefixFolder(testCase.dir, 2)
      migrate(drizzle(testCase.db), { migrationsFolder: through0002 })
      seedStableSentinel(testCase.db, 2)
      const oldJournal = journalRows(testCase.db)

      runMigrationsFromFolder(testCase.db, MIGRATIONS)

      expect(journalRows(testCase.db).slice(0, oldJournal.length)).toEqual(oldJournal)
      expect(
        testCase.db
          .prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers')
          .all()
      ).toEqual([{ work_sheet_id: 10020, worker_id: 10020 }])
      expect(
        testCase.db
          .prepare("SELECT action, details FROM audit_log WHERE entity_id='0001_big_lyja'")
          .get()
      ).toMatchObject({ action: 'migration.0001.workSheetWorkers.unverifiable' })
      assertHealthy(testCase.db)
    } finally {
      cleanup(testCase)
    }
  })

  it('leaves an already-current legacy Drizzle database unchanged and records uncertainty once', () => {
    const testCase = makeCase()
    try {
      migrate(drizzle(testCase.db), { migrationsFolder: MIGRATIONS })
      seedStableSentinel(testCase.db, 40)
      const oldJournal = journalRows(testCase.db)

      runMigrationsFromFolder(testCase.db, MIGRATIONS)
      runMigrationsFromFolder(testCase.db, MIGRATIONS)

      expect(journalRows(testCase.db)).toEqual(oldJournal)
      expect(
        testCase.db
          .prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers')
          .all()
      ).toEqual([{ work_sheet_id: 10400, worker_id: 10400 }])
      expect(
        testCase.db
          .prepare("SELECT action FROM audit_log WHERE entity_id='0001_big_lyja'")
          .all()
      ).toEqual([{ action: 'migration.0001.workSheetWorkers.unverifiable' }])
      assertHealthy(testCase.db)
    } finally {
      cleanup(testCase)
    }
  })

  it('does not invent assignments for an already-journaled database with none left', () => {
    const testCase = makeCase()
    try {
      const through0002 = prefixFolder(testCase.dir, 2)
      migrate(drizzle(testCase.db), { migrationsFolder: through0002 })
      testCase.db.exec(`
        INSERT INTO customers (id, name, created_at) VALUES (1, 'عميل', '2026-01-01');
        INSERT INTO workers (id, name, created_at) VALUES (1, 'عامل', '2026-01-01');
        INSERT INTO orders
          (id, document_number, customer_id, status, total_minor, paid_minor, remaining_minor, created_at)
          VALUES (1, 'SO-NO-INFERENCE', 1, 'confirmed', 1000, 0, 1000, '2026-01-01');
        INSERT INTO work_sheets
          (id, document_number, order_id, status, issued_at, created_at)
          VALUES (1, 'MO-NO-INFERENCE', 1, 'in_production', '2026-01-02', '2026-01-02');
        INSERT INTO order_worker_assignments
          (id, order_id, work_sheet_id, worker_id, method, amount_minor, earned)
          VALUES (1, 1, 1, 1, 'fixed', 100, 0);
      `)

      runMigrationsFromFolder(testCase.db, MIGRATIONS)

      expect(
        testCase.db.prepare('SELECT COUNT(*) AS c FROM work_sheet_workers').get()
      ).toEqual({ c: 0 })
      expect(
        testCase.db.prepare('SELECT COUNT(*) AS c FROM order_worker_assignments').get()
      ).toEqual({ c: 1 })
      const evidence = testCase.db
        .prepare("SELECT action, details FROM audit_log WHERE entity_id='0001_big_lyja'")
        .get() as { action: string; details: string }
      expect(evidence.action).toBe('migration.0001.workSheetWorkers.unverifiable')
      expect(JSON.parse(evidence.details)).toMatchObject({
        status: 'preexisting_unverifiable',
        workSheetCount: 1,
        workerAssignmentCount: 0,
        workSheetsWithoutAssignments: 1,
        assignmentsWereInferred: false
      })
      assertHealthy(testCase.db)
    } finally {
      cleanup(testCase)
    }
  })

  it('rolls back if any migration-side effect changes a legacy worker assignment', () => {
    const testCase = makeCase()
    try {
      runMigrationsFromFolder(testCase.db, prefixFolder(testCase.dir, 0))
      seedSingleLegacyAssignment(testCase.db)
      const oldJournal = journalRows(testCase.db)
      testCase.db.exec(`
        CREATE TRIGGER test_discard_worker_assignment
        AFTER INSERT ON audit_log
        WHEN NEW.action = 'migration.0001.workSheetWorkers.verified'
        BEGIN
          DELETE FROM work_sheet_workers WHERE work_sheet_id = 1 AND worker_id = 1;
        END
      `)

      expect(() => runMigrationsFromFolder(testCase.db, MIGRATIONS)).toThrow(
        /did not preserve every work_sheet_workers assignment/
      )
      expect(journalRows(testCase.db)).toEqual(oldJournal)
      expect(
        testCase.db
          .prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers')
          .all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(testCase.db)

      testCase.db.exec('DROP TRIGGER test_discard_worker_assignment')
      runMigrationsFromFolder(testCase.db, MIGRATIONS)
      expect(
        testCase.db
          .prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers')
          .all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(testCase.db)
    } finally {
      cleanup(testCase)
    }
  })

  it('rolls back rebuilt tables, dependent rows, and journal entries on a late 0001 failure', () => {
    const testCase = makeCase()
    try {
      runMigrationsFromFolder(testCase.db, prefixFolder(testCase.dir, 0))
      seedSingleLegacyAssignment(testCase.db)
      const oldSheetSql = (
        testCase.db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_sheets'")
          .get() as { sql: string }
      ).sql
      const oldJournal = journalRows(testCase.db)
      // 0001 creates this after all four rebuilds, so this collision injects
      // failure late enough to prove the rebuild and journal both roll back.
      testCase.db.exec('CREATE TABLE work_sheet_stages (id integer PRIMARY KEY)')

      expect(() => runMigrationsFromFolder(testCase.db, MIGRATIONS)).toThrow()

      expect(
        (
          testCase.db
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_sheets'")
            .get() as { sql: string }
        ).sql
      ).toBe(oldSheetSql)
      expect(journalRows(testCase.db)).toEqual(oldJournal)
      expect(
        testCase.db
          .prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers')
          .all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(testCase.db)

      testCase.db.exec('DROP TABLE work_sheet_stages')
      runMigrationsFromFolder(testCase.db, MIGRATIONS)
      expect(
        testCase.db
          .prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers')
          .all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(testCase.db)
    } finally {
      cleanup(testCase)
    }
  })

  it('rolls back when final verification finds a foreign-key violation created with enforcement off', () => {
    const testCase = makeCase()
    try {
      runMigrationsFromFolder(testCase.db, prefixFolder(testCase.dir, 0))
      seedSingleLegacyAssignment(testCase.db)
      const oldJournal = journalRows(testCase.db)

      expect(() =>
        runMigrationsFromFolder(testCase.db, MIGRATIONS, {
          afterStatement: (event) => {
            if (
              event.migrationCreatedAt === canonicalJournal.entries[1]?.when &&
              event.statementIndex === migration0001Statements.length - 1
            ) {
              testCase.db
                .prepare(
                  'INSERT INTO delivery_workers (delivery_id, worker_id) VALUES (999999, 1)'
                )
                .run()
            }
          }
        })
      ).toThrow(/foreign-key violation/)

      expect(journalRows(testCase.db)).toEqual(oldJournal)
      expect(
        testCase.db
          .prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers')
          .all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(testCase.db)
    } finally {
      cleanup(testCase)
    }
  })

  it('accounts for every incoming child relation at every table-rebuild migration', () => {
    const rebuildFiles = readdirSync(MIGRATIONS)
      .filter((file) => file.endsWith('.sql'))
      .filter((file) => readFileSync(join(MIGRATIONS, file), 'utf8').includes('CREATE TABLE `__new_'))
      .sort()
    expect(rebuildFiles).toEqual([
      '0001_big_lyja.sql',
      '0009_approved_invoice_starts_workflow.sql',
      '0013_users_role_id_nullable.sql',
      '0031_material_color_groups.sql'
    ])

    const incoming = (
      snapshot: string,
      targets: string[]
    ): Array<{ from: string; to: string; onDelete: string }> => {
      const parsed = JSON.parse(
        readFileSync(join(MIGRATIONS, `meta/${snapshot}_snapshot.json`), 'utf8')
      ) as {
        tables: Record<
          string,
          {
            foreignKeys: Record<
              string,
              { tableFrom: string; tableTo: string; onDelete: string }
            >
          }
        >
      }
      return Object.values(parsed.tables)
        .flatMap((table) => Object.values(table.foreignKeys ?? {}))
        .filter((fk) => targets.includes(fk.tableTo))
        .map((fk) => ({ from: fk.tableFrom, to: fk.tableTo, onDelete: fk.onDelete }))
        .sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`))
    }

    expect(
      incoming('0000', [
        'work_sheets',
        'order_material_lines',
        'order_machine_usage',
        'order_worker_assignments'
      ])
    ).toEqual([{ from: 'work_sheet_workers', to: 'work_sheets', onDelete: 'cascade' }])
    expect(incoming('0008', ['final_invoices'])).toEqual([])
    expect(incoming('0012', ['users'])).toEqual([])
    expect(incoming('0001', ['work_sheet_stages'])).toEqual([])
    expect(
      incoming('0030', [
        'quotation_line_colors',
        'final_invoice_line_colors',
        'order_line_colors'
      ])
    ).toEqual([])

    for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
      const executableSql = readFileSync(join(MIGRATIONS, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/--.*$/gm, '')
      expect(executableSql, `${file} must not depend on FK cascades for migration DML`)
        .not.toMatch(/\bDELETE\s+FROM\b/i)
    }
  })
})

describe.each(canonicalJournal.entries)(
  'production migration runner from journal prefix $tag',
  (entry) => {
    it('preserves stable business keys and upgrades exactly once to current', () => {
      const testCase = makeCase()
      try {
        runMigrationsFromFolder(testCase.db, prefixFolder(testCase.dir, entry.idx))
        seedStableSentinel(testCase.db, entry.idx)
        const prefixJournal = journalRows(testCase.db)

        runMigrationsFromFolder(testCase.db, MIGRATIONS)
        runMigrationsFromFolder(testCase.db, MIGRATIONS)

        expect(journalRows(testCase.db)).toHaveLength(canonicalJournal.entries.length)
        expect(journalRows(testCase.db).slice(0, prefixJournal.length)).toEqual(prefixJournal)
        expect(
          testCase.db
            .prepare(
              'SELECT ws.document_number, wsw.work_sheet_id, wsw.worker_id FROM work_sheets ws JOIN work_sheet_workers wsw ON wsw.work_sheet_id = ws.id WHERE ws.id = ?'
            )
            .get(10_000 + entry.idx * 10)
        ).toEqual({
          document_number: `MO-PREFIX-${entry.idx}`,
          work_sheet_id: 10_000 + entry.idx * 10,
          worker_id: 10_000 + entry.idx * 10
        })
        assertHealthy(testCase.db)
      } finally {
        cleanup(testCase)
      }
    })
  }
)

describe.each(
  migration0001Statements.map((statement, statementIndex) => ({
    statementIndex,
    statement: statement.trim().replace(/\s+/g, ' ').slice(0, 72)
  }))
)('migration 0001 rollback after statement $statementIndex — $statement', ({ statementIndex }) => {
  it('restores the exact pre-migration schema, journal, and worker links', () => {
    const testCase = makeCase()
    try {
      runMigrationsFromFolder(testCase.db, prefixFolder(testCase.dir, 0))
      seedSingleLegacyAssignment(testCase.db)
      const journalBefore = journalRows(testCase.db)
      const sheetSqlBefore = (
        testCase.db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_sheets'")
          .get() as { sql: string }
      ).sql

      expect(() =>
        runMigrationsFromFolder(testCase.db, MIGRATIONS, {
          afterStatement: (event) => {
            if (
              event.migrationCreatedAt === canonicalJournal.entries[1]?.when &&
              event.statementIndex === statementIndex
            ) {
              throw new Error(`forced failure after 0001 statement ${statementIndex}`)
            }
          }
        })
      ).toThrow(`forced failure after 0001 statement ${statementIndex}`)

      expect(journalRows(testCase.db)).toEqual(journalBefore)
      expect(
        (
          testCase.db
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_sheets'")
            .get() as { sql: string }
        ).sql
      ).toBe(sheetSqlBefore)
      expect(
        testCase.db
          .prepare('SELECT work_sheet_id, worker_id FROM work_sheet_workers')
          .all()
      ).toEqual([{ work_sheet_id: 1, worker_id: 1 }])
      assertHealthy(testCase.db)
    } finally {
      cleanup(testCase)
    }
  })
})
