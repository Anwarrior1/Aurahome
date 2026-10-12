import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  inspectDatabaseMigrationState,
  type DatabaseMigrationState,
  type MigrationBundle
} from './compatibility'
import {
  REQUIRED_APPLICATION_INDEXES,
  REQUIRED_APPLICATION_TABLES,
  REQUIRED_MIGRATION_TRIGGERS,
  REQUIRED_TABLE_SQL_FRAGMENTS
} from './current-schema-identity'

export interface PreservedTableIdentity {
  table: string
  rowCount: number
  keyFingerprint: string
}

export interface MigrationVerificationReport {
  migrationCount: number
  migrationFingerprint: string
  tableCount: number
  indexCount: number
  triggerCount: number
}

interface DrizzleSnapshot {
  tables: Record<string, { columns: Record<string, unknown> }>
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * Full physical/index/constraint (integrity_check) and referential
 * (foreign_key_check) proof. O(database size): DB-14 requires it once per
 * unchanged connection, never repeated before an intervening write.
 */
export function assertDatabaseHealthy(raw: Database.Database): void {
  const integrity = raw.pragma('integrity_check') as Array<{ integrity_check: string }>
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(
      `[DB_MIGRATION_CORRUPT] SQLite integrity_check did not return ok: ${integrity
        .slice(0, 5)
        .map((row) => row.integrity_check)
        .join('; ')}`
    )
  }
  const violations = raw.pragma('foreign_key_check') as unknown[]
  if (violations.length > 0) {
    throw new Error(
      `[DB_MIGRATION_CORRUPT] Migration produced ${violations.length} foreign-key violation(s)`
    )
  }
}

function objectNames(raw: Database.Database, type: 'table' | 'index' | 'trigger'): Set<string> {
  return new Set(
    (
      raw
        .prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
        .all(type) as Array<{ name: string }>
    ).map(({ name }) => name)
  )
}

function assertRequiredObjects(
  actual: Set<string>,
  expected: readonly string[],
  label: string
): void {
  const missing = expected.filter((name) => !actual.has(name))
  if (missing.length > 0) {
    throw new Error(
      `[DB_MIGRATION_STRUCTURAL] Required ${label} missing: ${missing.slice(0, 8).join(', ')}`
    )
  }
}

function assertRequiredConstraints(raw: Database.Database): void {
  for (const [table, fragments] of Object.entries(REQUIRED_TABLE_SQL_FRAGMENTS)) {
    const row = raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string | null } | undefined
    const sql = row?.sql?.toLowerCase() ?? ''
    const missing = fragments.filter((fragment) => !sql.includes(fragment.toLowerCase()))
    if (missing.length > 0) {
      throw new Error(
        `[DB_MIGRATION_STRUCTURAL] Required constraints/columns missing from ${table}: ${missing.join(', ')}`
      )
    }
  }
}

/**
 * Pre-migration structural proof for a canonical historical prefix. The
 * released Drizzle snapshot supplies table/column expectations without
 * duplicating every historical schema in application code.
 */
export function assertHistoricalDatabaseStructure(
  raw: Database.Database,
  bundle: MigrationBundle,
  state: DatabaseMigrationState
): void {
  if (state.status !== 'historical' || state.appliedCount < 1) return
  const applied = bundle.history[state.appliedCount - 1]
  if (!applied) {
    throw new Error('[DB_MIGRATION_STRUCTURAL] Historical migration snapshot is unavailable')
  }
  let snapshot: DrizzleSnapshot
  try {
    snapshot = JSON.parse(
      readFileSync(join(bundle.folder, 'meta', `${String(applied.idx).padStart(4, '0')}_snapshot.json`), 'utf8')
    ) as DrizzleSnapshot
  } catch {
    throw new Error(
      `[DB_MIGRATION_BUNDLE_MISMATCH] Historical schema snapshot ${applied.idx} is missing or unreadable`
    )
  }

  const actualTables = objectNames(raw, 'table')
  for (const [table, definition] of Object.entries(snapshot.tables)) {
    if (!actualTables.has(table)) {
      throw new Error(`[DB_MIGRATION_STRUCTURAL] Historical database is missing table ${table}`)
    }
    const actualColumns = new Set(
      (raw.pragma(`table_info(${quoteIdentifier(table)})`) as Array<{ name: string }>).map(
        ({ name }) => name
      )
    )
    const missingColumns = Object.keys(definition.columns).filter((name) => !actualColumns.has(name))
    if (missingColumns.length > 0) {
      throw new Error(
        `[DB_MIGRATION_STRUCTURAL] Historical table ${table} is missing column(s): ${missingColumns.join(', ')}`
      )
    }
  }
}

function assertBusinessInvariants(raw: Database.Database): void {
  const invalidCutovers = Number(
    raw
      .prepare(
        `SELECT COUNT(*) FROM finished_goods_valuation_cutovers
          WHERE status NOT IN ('ready', 'blocked')
             OR classification NOT IN ('unaffected', 'provably_affected', 'potentially_affected')
             OR opening_qty_micro < 0 OR opening_value_minor < 0
             OR affected_movement_count < 0
             OR json_valid(evidence) <> 1`
      )
      .pluck()
      .get()
  )
  if (invalidCutovers > 0) {
    throw new Error(
      `[DB_MIGRATION_BUSINESS] ${invalidCutovers} finished-goods valuation cutover row(s) are invalid`
    )
  }

  const invalidRequests = Number(
    raw
      .prepare(
        `SELECT COUNT(*) FROM financial_command_requests
          WHERE length(command_scope) = 0 OR length(request_key) = 0
             OR length(payload_hash) = 0 OR json_valid(result_json) <> 1`
      )
      .pluck()
      .get()
  )
  if (invalidRequests > 0) {
    throw new Error(
      `[DB_MIGRATION_BUSINESS] ${invalidRequests} financial idempotency row(s) have invalid migration-required shape`
    )
  }
}

/** Full post-migration gate. Normal application use may begin only after this passes. */
export function verifyCurrentDatabase(
  raw: Database.Database,
  bundle: MigrationBundle
): MigrationVerificationReport {
  assertDatabaseHealthy(raw)
  return verifyCurrentDatabaseSchema(raw, bundle)
}

/**
 * The current gate without its O(size) health half. Only for a caller that has
 * itself just run assertDatabaseHealthy on this connection with no write since.
 */
export function verifyCurrentDatabaseSchema(
  raw: Database.Database,
  bundle: MigrationBundle
): MigrationVerificationReport {
  const state = inspectDatabaseMigrationState(raw, bundle)
  if (state.status !== 'current') {
    throw new Error('[DB_MIGRATION_STRUCTURAL] Database did not reach the expected migration head')
  }

  const tables = objectNames(raw, 'table')
  const indexes = objectNames(raw, 'index')
  const triggers = objectNames(raw, 'trigger')
  assertRequiredObjects(tables, REQUIRED_APPLICATION_TABLES, 'application table(s)')
  assertRequiredObjects(indexes, REQUIRED_APPLICATION_INDEXES, 'application index(es)')
  assertRequiredObjects(triggers, REQUIRED_MIGRATION_TRIGGERS, 'migration trigger(s)')
  assertRequiredConstraints(raw)
  assertBusinessInvariants(raw)

  return {
    migrationCount: state.appliedCount,
    migrationFingerprint: state.fingerprint,
    tableCount: REQUIRED_APPLICATION_TABLES.length,
    indexCount: REQUIRED_APPLICATION_INDEXES.length,
    triggerCount: REQUIRED_MIGRATION_TRIGGERS.length
  }
}

function primaryKeyFingerprint(raw: Database.Database, table: string): string {
  const columns = (
    raw.pragma(`table_info(${quoteIdentifier(table)})`) as Array<{
      name: string
      pk: number
    }>
  )
    .filter(({ pk }) => pk > 0)
    .sort((left, right) => left.pk - right.pk)
  if (columns.length === 0) return 'no-primary-key'
  const selection = columns.map(({ name }) => quoteIdentifier(name)).join(', ')
  const ordering = columns.map(({ name }) => quoteIdentifier(name)).join(', ')
  const hash = createHash('sha256')
  for (const row of raw.prepare(`SELECT ${selection} FROM ${quoteIdentifier(table)} ORDER BY ${ordering}`).iterate()) {
    hash.update(JSON.stringify(row))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/**
 * Migration 0042 rebuilds every table that had the historical quoted timestamp
 * default. Capture row counts and ordered primary-key fingerprints before it.
 */
export function captureDb03RebuiltTableIdentities(
  raw: Database.Database
): PreservedTableIdentity[] {
  const tables = raw
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND sql LIKE '%DEFAULT ''CURRENT_TIMESTAMP''%'
        ORDER BY name`
    )
    .all() as Array<{ name: string }>
  return tables.map(({ name }) => ({
    table: name,
    rowCount: Number(
      raw.prepare(`SELECT COUNT(*) FROM ${quoteIdentifier(name)}`).pluck().get()
    ),
    keyFingerprint: primaryKeyFingerprint(raw, name)
  }))
}

export function assertDb03RebuiltTableIdentities(
  raw: Database.Database,
  before: readonly PreservedTableIdentity[]
): void {
  for (const expected of before) {
    const actualCount = Number(
      raw.prepare(`SELECT COUNT(*) FROM ${quoteIdentifier(expected.table)}`).pluck().get()
    )
    const actualFingerprint = primaryKeyFingerprint(raw, expected.table)
    if (actualCount !== expected.rowCount || actualFingerprint !== expected.keyFingerprint) {
      throw new Error(
        `[DB_MIGRATION_BUSINESS] Migration 0042 did not preserve row identity for ${expected.table}`
      )
    }
  }
}
