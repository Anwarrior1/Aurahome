import { createRequire } from 'node:module'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open } from 'node:fs/promises'
import { join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { ARCHIVE_LIMITS, extractArchiveBounded, sha256File } from '../backup/archive'
import type { BackupManifest } from '../backup/manifest'
import { assertSchemaCompatible, inspectDatabaseMigrationState, loadMigrationBundle } from '../migrations/compatibility'
import { assertHistoricalDatabaseStructure, verifyCurrentDatabase } from '../migrations/migration-verification'
import { reconcileDatabase, type ReconciliationReport } from '../db/reconciliation'

interface SqliteStatement {
  all(...args: unknown[]): unknown[]
  get(...args: unknown[]): unknown
  iterate(...args: unknown[]): Iterable<unknown>
}

interface SqliteConnection {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  close(): void
}

const require = createRequire(import.meta.url)

function openReadOnly(path: string): SqliteConnection {
  const runtime = require('node:sqlite') as { DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteConnection }
  return new runtime.DatabaseSync(path, { readOnly: true })
}

/** Surface only the read operations consumed by the existing authoritative checks. */
function existingReadApi(connection: SqliteConnection): BetterSqlite3.Database {
  let transactionOpen = false
  const prepare = (sql: string): unknown => {
    const statement = connection.prepare(sql)
    const facade = {
      all: (...args: unknown[]) => statement.all(...args),
      get: (...args: unknown[]) => statement.get(...args),
      iterate: (...args: unknown[]) => statement.iterate(...args),
      pluck: () => ({
        all: (...args: unknown[]) => statement.all(...args).map((row) => Object.values(row as Record<string, unknown>)[0]),
        get: (...args: unknown[]) => {
          const row = statement.get(...args)
          return row === undefined ? undefined : Object.values(row as Record<string, unknown>)[0]
        },
        iterate: function* (...args: unknown[]) {
          for (const row of statement.iterate(...args)) yield Object.values(row as Record<string, unknown>)[0]
        }
      })
    }
    return facade
  }
  const api = {
    prepare,
    pragma: (sql: string) => connection.prepare(`PRAGMA ${sql}`).all(),
    get inTransaction() { return transactionOpen },
    transaction: (run: () => unknown) => ({
      deferred: () => {
        connection.exec('BEGIN DEFERRED')
        transactionOpen = true
        try {
          const result = run()
          connection.exec('COMMIT')
          return result
        } catch (error) {
          connection.exec('ROLLBACK')
          throw error
        } finally { transactionOpen = false }
      }
    })
  }
  return api as unknown as BetterSqlite3.Database
}

function parseManifest(raw: Buffer): BackupManifest | undefined {
  let value: unknown
  try { value = JSON.parse(raw.toString('utf8')) } catch { return undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const m = value as Partial<BackupManifest>
  if (typeof m.appVersion !== 'string' || !Number.isInteger(m.schemaVersion) ||
      typeof m.createdAt !== 'string' || typeof m.machineName !== 'string' ||
      !m.recordCounts || typeof m.recordCounts !== 'object' || Array.isArray(m.recordCounts) ||
      Object.values(m.recordCounts).some((count) => !Number.isInteger(count) || count < -1) ||
      !/^[a-f0-9]{64}$/.test(m.databaseSha256 ?? '') ||
      (m.migration !== undefined && (!Number.isInteger(m.migration.appliedCount) || m.migration.appliedCount < 1 ||
        (m.migration.headCreatedAt !== null && !Number.isInteger(m.migration.headCreatedAt)) ||
        !/^[a-f0-9]{64}$/.test(m.migration.fingerprint ?? '')))) return undefined
  return m as BackupManifest
}

export interface OfflineInspection {
  valid: boolean
  reason?: string
  archiveSha256: string
  archiveBytes: number
  origin: 'UNKNOWN ORIGIN'
  manifest?: BackupManifest
  reconciliation?: ReconciliationReport
}

/** A selected external file is never parsed in place. The caller must protect stageRoot. */
export async function pinLegacyArchive(
  selectedPath: string, stageRoot: string
): Promise<{ path: string; sha256: string; bytes: number }> {
  const before = await lstat(selectedPath)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 12 || before.size > ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new Error('ملف النسخة المختار غير صالح')
  }
  await mkdir(stageRoot, { recursive: true, mode: 0o700 })
  const caseRoot = await mkdtemp(join(stageRoot, 'case-'))
  const pinnedPath = join(caseRoot, 'selected.aurabak')
  const firstHash = await sha256File(selectedPath)
  await copyFile(selectedPath, pinnedPath, constants.COPYFILE_EXCL)
  const pinnedHash = await sha256File(pinnedPath)
  const finalHash = await sha256File(selectedPath)
  const after = await lstat(selectedPath)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      firstHash !== finalHash || firstHash !== pinnedHash) {
    throw new Error('تغير ملف النسخة أثناء نسخه؛ توقفت الاستعادة')
  }
  const pinned = await open(pinnedPath, 'r')
  try { await pinned.sync() } finally { await pinned.close() }
  const directory = await open(caseRoot, 'r')
  try { await directory.sync() } finally { await directory.close() }
  return { path: pinnedPath, sha256: pinnedHash, bytes: before.size }
}

/** Validation never opens the live database and never upgrades or repairs a candidate. */
export async function inspectLegacyBackup(
  archivePath: string, candidatePath: string, migrationsFolder: string, expectedArchiveSha256: string
): Promise<OfflineInspection> {
  const { size } = await import('node:fs/promises').then((fs) => fs.stat(archivePath))
  const archiveSha256 = await sha256File(archivePath)
  const base: OfflineInspection = { valid: false, archiveSha256, archiveBytes: size, origin: 'UNKNOWN ORIGIN' }
  if (!/^[a-f0-9]{64}$/.test(expectedArchiveSha256) || archiveSha256 !== expectedArchiveSha256) {
    return { ...base, reason: 'تغير ملف النسخة المحددة بعد اختياره' }
  }
  let connection: SqliteConnection | undefined
  try {
    const extracted = await extractArchiveBounded(archivePath, candidatePath)
    const manifest = parseManifest(extracted.manifest)
    if (!manifest) return { ...base, reason: 'بيانات وصف النسخة الاحتياطية غير صالحة' }
    if (manifest.databaseSha256 !== extracted.databaseSha256) return { ...base, manifest, reason: 'بصمة قاعدة البيانات لا تطابق الأرشيف' }
    assertSchemaCompatible(manifest.schemaVersion)
    connection = openReadOnly(candidatePath)
    const raw = existingReadApi(connection)
    const integrity = raw.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') return { ...base, manifest, reason: 'قاعدة البيانات داخل النسخة تالفة' }
    if ((raw.pragma('foreign_key_check') as unknown[]).length !== 0) return { ...base, manifest, reason: 'مخالفة لعلاقات قاعدة البيانات' }
    const bundle = loadMigrationBundle(migrationsFolder, true)
    const state = inspectDatabaseMigrationState(raw, bundle)
    if (state.status === 'fresh') return { ...base, manifest, reason: 'سجل الترحيل غير صالح' }
    if (state.status === 'current') verifyCurrentDatabase(raw, bundle)
    else assertHistoricalDatabaseStructure(raw, bundle, state)
    if (manifest.migration && (manifest.migration.appliedCount !== state.appliedCount ||
        manifest.migration.headCreatedAt !== state.headCreatedAt || manifest.migration.fingerprint !== state.fingerprint)) {
      return { ...base, manifest, reason: 'هوية الترحيل لا تطابق قاعدة البيانات' }
    }
    for (const table of [
      'users', 'customers', 'suppliers', 'materials', 'fifo_layers', 'inventory_movements',
      'quotations', 'orders', 'customer_payments', 'customer_payment_refunds', 'expenses', 'cash_transactions'
    ]) {
      const declared = manifest.recordCounts[table]
      if (declared === undefined || declared === -1) continue
      const actual = connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
      if (actual.count !== declared) return { ...base, manifest, reason: `عدد السجلات لا يطابق وصف النسخة: ${table}` }
    }
    const reconciliation = reconcileDatabase(raw)
    if (reconciliation.checksRun !== 73 || reconciliation.errorCount > 0 || reconciliation.warningCount > 0) {
      return { ...base, manifest, reconciliation, reason: 'فشل التحقق المالي' }
    }
    if (await sha256File(archivePath) !== archiveSha256) return { ...base, manifest, reconciliation, reason: 'تغير ملف النسخة أثناء الفحص' }
    return { ...base, valid: true, manifest, reconciliation }
  } catch (error) {
    return { ...base, reason: error instanceof Error ? error.message : 'فشل فحص النسخة' }
  } finally { connection?.close() }
}
