import type Database from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { app } from 'electron'
import type * as schema from '../db/schema'
import { getRawConnection } from '../db/connection'
import { logger } from '../utils/logger'
import {
  inspectDatabaseMigrationState,
  loadMigrationBundle,
  type MigrationBundle
} from './compatibility'
import { CANONICAL_MIGRATION_HISTORY } from './migration-history'
import {
  assertDatabaseHealthy,
  assertHistoricalDatabaseStructure,
  assertDb03RebuiltTableIdentities,
  captureDb03RebuiltTableIdentities,
  verifyCurrentDatabase,
  verifyCurrentDatabaseSchema
} from './migration-verification'
import {
  markMigrationRecoveryPhase,
  prepareMigrationRecovery,
  readMigrationRecoveryMarker,
  type MigrationRecoveryMarker
} from './migration-recovery'

const MIGRATIONS_TABLE = '__drizzle_migrations'
// Immutable timestamp from meta/_journal.json. It identifies the released
// production-workflow migration without changing that migration's SQL/hash.
const MIGRATION_0001_CREATED_AT = 1_788_632_761_265
const MIGRATION_0042_CREATED_AT = 1_792_169_600_000
const MIGRATION_0001_VERIFIED_ACTION = 'migration.0001.workSheetWorkers.verified'
const MIGRATION_0001_UNVERIFIABLE_ACTION = 'migration.0001.workSheetWorkers.unverifiable'

interface WorkSheetWorkerKey {
  work_sheet_id: number
  worker_id: number
}

interface PreservedSchemaObject {
  name: string
  sql: string
}

export interface MigrationExecutionHooks {
  afterStatement?: (event: {
    migrationCreatedAt: number
    statementIndex: number
    statement: string
  }) => void
  afterCommit?: () => void
}

export interface PendingMigrationHooks {
  beforeRecoveryPreparation?: () => void
  afterRecoveryPrepared?: (marker: MigrationRecoveryMarker) => void
  afterMigrationStarted?: (marker: MigrationRecoveryMarker) => void
  afterMigrationCommitted?: (marker: MigrationRecoveryMarker | undefined) => void
  afterStructuralVerification?: (marker: MigrationRecoveryMarker | undefined) => void
  afterMigrationVerified?: (marker: MigrationRecoveryMarker) => void
  execution?: MigrationExecutionHooks
}

export function getMigrationsFolder(): string {
  // Packaged builds carry the SQL files alongside the app resources.
  const packaged = join(process.resourcesPath ?? '', 'drizzle/migrations')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return join(app.getAppPath(), 'drizzle/migrations')
}

function foreignKeysEnabled(raw: Database.Database): boolean {
  return Number(raw.pragma('foreign_keys', { simple: true })) === 1
}

function tableExists(raw: Database.Database, table: string): boolean {
  return Boolean(
    raw
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
  )
}

function workSheetWorkerKeys(raw: Database.Database): WorkSheetWorkerKey[] | undefined {
  if (!tableExists(raw, 'work_sheet_workers')) return undefined
  return raw
    .prepare(
      'SELECT work_sheet_id, worker_id FROM work_sheet_workers ORDER BY work_sheet_id, worker_id'
    )
    .all() as WorkSheetWorkerKey[]
}

function db03DependentSchemaObjects(raw: Database.Database): PreservedSchemaObject[] {
  return raw
    .prepare(
      `SELECT child.name, child.sql
         FROM sqlite_master parent
         JOIN sqlite_master child ON child.tbl_name = parent.name
        WHERE parent.type = 'table'
          AND parent.sql LIKE '%DEFAULT ''CURRENT_TIMESTAMP''%'
          AND child.type IN ('index', 'trigger')
          AND child.sql IS NOT NULL
          AND child.name NOT LIKE 'db03_reject_%'
        ORDER BY child.type, child.name`
    )
    .all() as PreservedSchemaObject[]
}

function restoreMissingSchemaObjects(
  raw: Database.Database,
  objects: PreservedSchemaObject[]
): void {
  const exists = raw.prepare('SELECT 1 FROM sqlite_master WHERE name = ?')
  for (const object of objects) {
    if (!exists.get(object.name)) raw.exec(object.sql)
  }
}

function assertWorkSheetWorkersPreserved(
  before: WorkSheetWorkerKey[] | undefined,
  raw: Database.Database
): void {
  if (before === undefined) return
  const after = workSheetWorkerKeys(raw)
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(
      'Migration 0001 did not preserve every work_sheet_workers assignment; rolling back the upgrade'
    )
  }
}

function recordMigration0001Evidence(
  raw: Database.Database,
  status: 'verified' | 'preexisting_unverifiable'
): boolean {
  if (!tableExists(raw, 'audit_log')) return false
  const existing = raw
    .prepare(
      'SELECT 1 FROM audit_log WHERE action IN (?, ?) AND entity_id = ? LIMIT 1'
    )
    .get(
      MIGRATION_0001_VERIFIED_ACTION,
      MIGRATION_0001_UNVERIFIABLE_ACTION,
      '0001_big_lyja'
    )
  if (existing) return false

  const workSheetCount = tableExists(raw, 'work_sheets')
    ? Number(raw.prepare('SELECT COUNT(*) AS count FROM work_sheets').pluck().get())
    : 0
  const workerAssignmentCount = tableExists(raw, 'work_sheet_workers')
    ? Number(raw.prepare('SELECT COUNT(*) AS count FROM work_sheet_workers').pluck().get())
    : 0
  const workSheetsWithoutAssignments =
    tableExists(raw, 'work_sheets') && tableExists(raw, 'work_sheet_workers')
      ? Number(
          raw
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM work_sheets ws
                WHERE NOT EXISTS (
                  SELECT 1 FROM work_sheet_workers wsw WHERE wsw.work_sheet_id = ws.id
                )`
            )
            .pluck()
            .get()
        )
      : 0

  raw
    .prepare(
      `INSERT INTO audit_log
         (user_id, action, entity, entity_id, details, created_at)
       VALUES (NULL, ?, 'migration', '0001_big_lyja', ?, ?)`
    )
    .run(
      status === 'verified'
        ? MIGRATION_0001_VERIFIED_ACTION
        : MIGRATION_0001_UNVERIFIABLE_ACTION,
      JSON.stringify({
        status,
        workSheetCount,
        workerAssignmentCount,
        workSheetsWithoutAssignments,
        assignmentsWereInferred: false
      }),
      new Date().toISOString()
    )
  return true
}

/**
 * The production migration executor, exported so upgrade tests can exercise
 * exactly the code used at startup against isolated files and journal prefixes.
 *
 * Drizzle 0.33 starts BEGIN before it executes a migration's SQL. SQLite then
 * ignores PRAGMA foreign_keys=OFF inside migration 0001, so DROP work_sheets
 * cascades into work_sheet_workers. Foreign-key enforcement must therefore be
 * suspended before BEGIN, only for this controlled migration transaction.
 *
 * The connection must enter and leave with foreign keys enabled. Pending SQL,
 * its journal entries, the 0001 preservation guard, and foreign_key_check all
 * share one transaction. Any failure rolls everything back.
 */
export function runMigrationsFromFolder(
  raw: Database.Database,
  folder: string,
  hooks?: MigrationExecutionHooks
): void {
  assertMigrationEntryState(raw)
  assertDatabaseHealthy(raw)
  const bundle = loadMigrationBundle(folder)
  const isCurrentApplicationBundle = bundle.history.length === CANONICAL_MIGRATION_HISTORY.length
  if (
    isCurrentApplicationBundle &&
    inspectDatabaseMigrationState(raw, bundle).status === 'current'
  ) {
    verifyCurrentDatabaseSchema(raw, bundle)
  }
  if (applyPendingMigrations(raw, bundle, hooks) && isCurrentApplicationBundle) {
    verifyCurrentDatabase(raw, bundle)
  }
}

function assertMigrationEntryState(raw: Database.Database): void {
  if (raw.inTransaction) {
    throw new Error('Migrations cannot start inside an existing transaction')
  }
  if (!foreignKeysEnabled(raw)) {
    throw new Error('Migrations require PRAGMA foreign_keys=ON on entry')
  }
}

/**
 * Applies pending SQL in one transaction. The caller must already have proven
 * assertDatabaseHealthy on this connection. Returns whether a migration was
 * committed; a committed migration still requires full verifyCurrentDatabase.
 */
function applyPendingMigrations(
  raw: Database.Database,
  bundle: MigrationBundle,
  hooks?: MigrationExecutionHooks
): boolean {
  assertMigrationEntryState(raw)
  const initialState = inspectDatabaseMigrationState(raw, bundle)
  const migrations = bundle.migrations

  raw.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `)

  const lastCreatedAt = initialState.headCreatedAt ?? undefined
  const migration0001IsInHistory = migrations.some(
    (migration) => migration.folderMillis === MIGRATION_0001_CREATED_AT
  )
  const migration0001AlreadyApplied =
    migration0001IsInHistory &&
    lastCreatedAt !== undefined &&
    lastCreatedAt >= MIGRATION_0001_CREATED_AT
  const pending = migrations.filter(
    (migration) => lastCreatedAt === undefined || lastCreatedAt < migration.folderMillis
  )
  if (pending.length === 0) {
    if (
      migration0001AlreadyApplied &&
      recordMigration0001Evidence(raw, 'preexisting_unverifiable')
    ) {
      logger.warn(
        'Migration 0001 was already journaled before worksheet-worker preservation could be verified; no assignments were inferred or changed'
      )
    }
    return false
  }

  const migration0001WillRun = pending.some(
    (migration) => migration.folderMillis === MIGRATION_0001_CREATED_AT
  )
  const migration0042WillRun = pending.some(
    (migration) => migration.folderMillis === MIGRATION_0042_CREATED_AT
  )
  const workersBefore0001 = migration0001WillRun ? workSheetWorkerKeys(raw) : undefined
  // Migration 0042 must rebuild timestamp-default tables. Preserve any runtime
  // indexes/triggers that are not represented by Drizzle's static snapshot.
  const schemaObjectsBefore0042 = migration0042WillRun
    ? db03DependentSchemaObjects(raw)
    : []
  let db03IdentitiesBefore0042 = [] as ReturnType<typeof captureDb03RebuiltTableIdentities>

  let failure: unknown
  let recordedUnverifiableEvidence = false
  raw.pragma('foreign_keys = OFF')
  if (foreignKeysEnabled(raw)) {
    throw new Error('Could not suspend foreign-key actions before the migration transaction')
  }

  try {
    raw.exec('BEGIN')
    for (const migration of pending) {
      if (migration.folderMillis === MIGRATION_0042_CREATED_AT) {
        db03IdentitiesBefore0042 = captureDb03RebuiltTableIdentities(raw)
      }
      let statementIndex = 0
      for (const statement of migration.sql) {
        if (statement.trim()) {
          raw.exec(statement)
          hooks?.afterStatement?.({
            migrationCreatedAt: migration.folderMillis,
            statementIndex,
            statement
          })
          statementIndex += 1
        }
      }
      raw
        .prepare(
          `INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`
        )
        .run(migration.hash, migration.folderMillis)
      if (migration.folderMillis === MIGRATION_0042_CREATED_AT) {
        assertDb03RebuiltTableIdentities(raw, db03IdentitiesBefore0042)
      }
    }

    if (migration0042WillRun) {
      restoreMissingSchemaObjects(raw, schemaObjectsBefore0042)
    }

    if (migration0001WillRun) {
      recordMigration0001Evidence(raw, 'verified')
    } else if (migration0001AlreadyApplied) {
      recordedUnverifiableEvidence = recordMigration0001Evidence(
        raw,
        'preexisting_unverifiable'
      )
    }

    // Keep this as the final data-preservation assertion before structural
    // verification and COMMIT, so no later migration/evidence write can alter
    // the legacy assignment set unnoticed.
    if (migration0001WillRun) assertWorkSheetWorkersPreserved(workersBefore0001, raw)

    assertDatabaseHealthy(raw)
    raw.exec('COMMIT')
    hooks?.afterCommit?.()
  } catch (error) {
    failure = error
    if (raw.inTransaction) {
      try {
        raw.exec('ROLLBACK')
      } catch (rollbackError) {
        logger.error('Migration rollback failed', rollbackError)
      }
    }
  } finally {
    try {
      raw.pragma('foreign_keys = ON')
    } catch (restoreError) {
      if (failure === undefined) failure = restoreError
      else logger.error('Could not restore foreign-key enforcement after migration failure', restoreError)
    }
  }

  if (!foreignKeysEnabled(raw)) {
    const restoreError = new Error('Foreign-key enforcement was not restored after migration')
    if (failure === undefined) failure = restoreError
    else logger.error(restoreError.message)
  }
  if (failure !== undefined) throw failure

  const finalState = inspectDatabaseMigrationState(raw, bundle)
  if (finalState.status !== 'current') {
    throw new Error('[DB_MIGRATION_STRUCTURAL] Migration journal did not reach the requested head')
  }

  if (recordedUnverifiableEvidence) {
    logger.warn(
      'Migration 0001 was already journaled before worksheet-worker preservation could be verified; no assignments were inferred or changed'
    )
  }
  return true
}

/**
 * Runs all pending drizzle/migrations/*.sql in one transaction, matching the
 * journal ordering used by Drizzle while handling SQLite FK rebuilds safely.
 */
export function runPendingMigrations(
  db: BetterSQLite3Database<typeof schema>,
  hooks?: PendingMigrationHooks
): { migrated: boolean } {
  const folder = getMigrationsFolder()
  // getDatabase() owns the sole process connection. Keep the existing
  // parameter as an API guard for startup/restore callers, while migration SQL
  // is deliberately executed through that connection's raw transaction API.
  void db

  try {
    const raw = getRawConnection()
    if (raw.name && raw.name !== ':memory:') {
      const active = readMigrationRecoveryMarker(raw.name)
      if (active && active.phase !== 'verified') {
        throw new Error(
          'An interrupted migration must be recovered before opening the database'
        )
      }
    }

    // DB-14: the one full integrity/FK proof for this unchanged connection.
    // Nothing below repeats it unless a migration commits.
    assertDatabaseHealthy(raw)
    const bundle = loadMigrationBundle(folder, true)
    const initialState = inspectDatabaseMigrationState(raw, bundle)
    if (initialState.status === 'current') verifyCurrentDatabaseSchema(raw, bundle)
    else if (initialState.status === 'historical') {
      assertHistoricalDatabaseStructure(raw, bundle, initialState)
    }
    const pending = bundle.migrations.slice(initialState.appliedCount)
    const targetCreatedAt = pending.at(-1)?.folderMillis
    let recovery: MigrationRecoveryMarker | undefined

    if (targetCreatedAt !== undefined && initialState.status === 'historical') {
      hooks?.beforeRecoveryPreparation?.()
      recovery = prepareMigrationRecovery(raw, {
        fromMigrationCreatedAt: initialState.headCreatedAt,
        targetMigrationCreatedAt: targetCreatedAt,
        fromMigrationCount: initialState.appliedCount,
        targetMigrationCount: bundle.history.length,
        fromMigrationFingerprint: initialState.fingerprint,
        targetMigrationFingerprint: initialState.targetFingerprint
      })
      hooks?.afterRecoveryPrepared?.(recovery)
      recovery = markMigrationRecoveryPhase(recovery, 'migrating')
      hooks?.afterMigrationStarted?.(recovery)
    }

    // prepareMigrationRecovery only reads the live database (checkpoint, VACUUM
    // INTO, its own health check), so the entry proof above still holds here.
    const migrated = applyPendingMigrations(raw, bundle, {
      ...hooks?.execution,
      afterCommit: () => {
        if (recovery) recovery = markMigrationRecoveryPhase(recovery, 'migrated')
        hooks?.execution?.afterCommit?.()
        hooks?.afterMigrationCommitted?.(recovery)
      }
    })
    if (migrated) verifyCurrentDatabase(raw, bundle)
    hooks?.afterStructuralVerification?.(recovery)

    if (recovery) {
      recovery = markMigrationRecoveryPhase(recovery, 'verified')
      hooks?.afterMigrationVerified?.(recovery)
    }
    return { migrated }
  } catch (error) {
    logger.error('Migration failed', error)
    throw error
  }
}
