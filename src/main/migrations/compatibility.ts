import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { AppError } from '../utils/errors'
import { CURRENT_SCHEMA_VERSION } from './schema-version'
import {
  CANONICAL_MIGRATION_HISTORY,
  type CanonicalMigrationIdentity
} from './migration-history'

const MIGRATIONS_TABLE = '__drizzle_migrations'

export type MigrationCompatibilityCode =
  | 'DB_MIGRATION_BUNDLE_MISMATCH'
  | 'DB_MIGRATION_NEWER'
  | 'DB_MIGRATION_UNKNOWN'
  | 'DB_MIGRATION_HISTORY_MISMATCH'
  | 'DB_MIGRATION_CORRUPT'

export class MigrationCompatibilityError extends Error {
  constructor(
    readonly code: MigrationCompatibilityCode,
    message: string
  ) {
    super(`[${code}] ${message}`)
    this.name = 'MigrationCompatibilityError'
  }
}

export interface DatabaseMigrationRow {
  hash: string
  createdAt: number
}

export interface MigrationBundle {
  folder: string
  history: readonly CanonicalMigrationIdentity[]
  fingerprint: string
  migrations: ReturnType<typeof readMigrationFiles>
}

export type DatabaseMigrationStatus = 'fresh' | 'historical' | 'current'

export interface DatabaseMigrationState {
  status: DatabaseMigrationStatus
  appliedCount: number
  headCreatedAt: number | null
  fingerprint: string
  targetCount: number
  targetCreatedAt: number
  targetFingerprint: string
}

interface JournalFile {
  dialect: string
  entries: Array<{ idx: number; version: string; when: number; tag: string }>
}

function fail(code: MigrationCompatibilityCode, message: string): never {
  throw new MigrationCompatibilityError(code, message)
}

export function migrationRowsFingerprint(rows: readonly DatabaseMigrationRow[]): string {
  const hash = createHash('sha256')
  for (const row of rows) hash.update(`${row.createdAt}\0${row.hash}\n`)
  return hash.digest('hex')
}

export function migrationHistoryFingerprint(
  history: readonly CanonicalMigrationIdentity[]
): string {
  const hash = createHash('sha256')
  for (const entry of history) {
    hash.update(`${entry.idx}\0${entry.version}\0${entry.when}\0${entry.tag}\0${entry.hash}\n`)
  }
  return hash.digest('hex')
}

/**
 * Validates both the Drizzle journal metadata and every released SQL hash.
 * Prefix bundles are accepted for isolated historical fixtures; production
 * startup additionally requires the complete pinned history.
 */
export function loadMigrationBundle(folder: string, requireCurrent = false): MigrationBundle {
  let journal: JournalFile
  try {
    journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as JournalFile
  } catch {
    fail('DB_MIGRATION_BUNDLE_MISMATCH', 'Application migration journal is missing or unreadable')
  }
  if (
    journal.dialect !== 'sqlite' ||
    journal.entries.length === 0 ||
    journal.entries.length > CANONICAL_MIGRATION_HISTORY.length ||
    (requireCurrent && journal.entries.length !== CANONICAL_MIGRATION_HISTORY.length)
  ) {
    fail('DB_MIGRATION_BUNDLE_MISMATCH', 'Application migration journal has an unsupported length or dialect')
  }

  const migrations = readMigrationFiles({ migrationsFolder: folder })
  if (migrations.length !== journal.entries.length) {
    fail('DB_MIGRATION_BUNDLE_MISMATCH', 'Application migration SQL files do not match its journal')
  }
  const history = CANONICAL_MIGRATION_HISTORY.slice(0, journal.entries.length)
  for (let index = 0; index < journal.entries.length; index += 1) {
    const actual = journal.entries[index]
    const expected = history[index]
    const migration = migrations[index]
    if (!actual || !expected || !migration) {
      fail('DB_MIGRATION_BUNDLE_MISMATCH', `Application migration entry ${index} is incomplete`)
    }
    if (
      actual.idx !== expected.idx ||
      actual.version !== expected.version ||
      actual.when !== expected.when ||
      actual.tag !== expected.tag
    ) {
      fail(
        'DB_MIGRATION_BUNDLE_MISMATCH',
        `Migration journal entry ${index} does not match pinned released history`
      )
    }
    if (migration.folderMillis !== expected.when || migration.hash !== expected.hash) {
      fail(
        'DB_MIGRATION_BUNDLE_MISMATCH',
        `Released migration ${expected.tag} has changed identity`
      )
    }
  }

  return {
    folder,
    history,
    fingerprint: migrationHistoryFingerprint(history),
    migrations
  }
}

function migrationTableExists(raw: Database.Database): boolean {
  return Boolean(
    raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATIONS_TABLE)
  )
}

function applicationTableCount(raw: Database.Database): number {
  return Number(
    raw
      .prepare(
        `SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ?`
      )
      .pluck()
      .get(MIGRATIONS_TABLE)
  )
}

export function readDatabaseMigrationRows(raw: Database.Database): DatabaseMigrationRow[] {
  if (!migrationTableExists(raw)) return []
  const columns = raw.pragma(`table_info(${MIGRATIONS_TABLE})`) as Array<{ name: string }>
  const names = new Set(columns.map(({ name }) => name))
  if (!names.has('hash') || !names.has('created_at')) {
    fail('DB_MIGRATION_HISTORY_MISMATCH', 'Migration journal table has an unrecognized shape')
  }

  let rows: Array<{ hash: unknown; created_at: unknown }>
  try {
    rows = raw
      .prepare(`SELECT hash, created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at, rowid`)
      .all() as Array<{ hash: unknown; created_at: unknown }>
  } catch {
    fail('DB_MIGRATION_CORRUPT', 'Migration journal cannot be read')
  }
  return rows.map((row, index) => {
    const createdAt = Number(row.created_at)
    if (typeof row.hash !== 'string' || row.hash.length === 0 || !Number.isFinite(createdAt)) {
      fail('DB_MIGRATION_HISTORY_MISMATCH', `Migration journal row ${index} is invalid`)
    }
    return { hash: row.hash, createdAt }
  })
}

export function inspectDatabaseMigrationState(
  raw: Database.Database,
  bundle: MigrationBundle
): DatabaseMigrationState {
  const hasJournal = migrationTableExists(raw)
  const rows = readDatabaseMigrationRows(raw)
  const appTables = applicationTableCount(raw)
  const targetCreatedAt = bundle.history.at(-1)?.when
  if (targetCreatedAt === undefined) fail('DB_MIGRATION_BUNDLE_MISMATCH', 'Application has no migration head')

  if (rows.length === 0) {
    if (appTables > 0) {
      fail(
        'DB_MIGRATION_UNKNOWN',
        `Nonempty database has ${hasJournal ? 'an empty' : 'no'} trustworthy migration journal`
      )
    }
    return {
      status: 'fresh',
      appliedCount: 0,
      headCreatedAt: null,
      fingerprint: migrationRowsFingerprint([]),
      targetCount: bundle.history.length,
      targetCreatedAt,
      targetFingerprint: migrationRowsFingerprint(
        bundle.history.map(({ hash, when }) => ({ hash, createdAt: when }))
      )
    }
  }

  if (rows.length > bundle.history.length) {
    const prefixMatches = bundle.history.every(
      (expected, index) => rows[index]?.createdAt === expected.when && rows[index]?.hash === expected.hash
    )
    if (prefixMatches && rows[bundle.history.length]!.createdAt > targetCreatedAt) {
      fail('DB_MIGRATION_NEWER', 'Database migration history is newer than this application')
    }
    fail('DB_MIGRATION_HISTORY_MISMATCH', 'Database migration history is not a canonical prefix')
  }

  for (let index = 0; index < rows.length; index += 1) {
    const actual = rows[index]!
    const expected = bundle.history[index]!
    if (actual.createdAt > targetCreatedAt) {
      fail('DB_MIGRATION_NEWER', 'Database migration history is newer than this application')
    }
    if (actual.createdAt !== expected.when || actual.hash !== expected.hash) {
      fail(
        'DB_MIGRATION_HISTORY_MISMATCH',
        `Database migration row ${index} does not match released history`
      )
    }
  }

  const status: DatabaseMigrationStatus = rows.length === bundle.history.length ? 'current' : 'historical'
  return {
    status,
    appliedCount: rows.length,
    headCreatedAt: rows.at(-1)?.createdAt ?? null,
    fingerprint: migrationRowsFingerprint(rows),
    targetCount: bundle.history.length,
    targetCreatedAt,
    targetFingerprint: migrationRowsFingerprint(
      bundle.history.map(({ hash, when }) => ({ hash, createdAt: when }))
    )
  }
}

/** Retained for backup-format compatibility; journal identity is authoritative at startup. */
export function assertSchemaCompatible(storedVersion: number): void {
  if (!Number.isInteger(storedVersion) || storedVersion < 1) {
    throw new AppError('INTERNAL_ERROR', 'إصدار مخطط قاعدة البيانات غير معروف')
  }
  if (storedVersion > CURRENT_SCHEMA_VERSION) {
    throw new AppError(
      'INTERNAL_ERROR',
      'قاعدة البيانات من إصدار أحدث من التطبيق. الرجاء تحديث التطبيق أولاً'
    )
  }
}
