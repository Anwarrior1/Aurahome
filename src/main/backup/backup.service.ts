import { app } from 'electron'
import BetterSqlite3 from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { existsSync, fsyncSync, mkdirSync, openSync, closeSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'
import { getRawConnection } from '../db/connection'
import { getDataRoot, getTempRoot, getConfigRoot } from '../files/paths'
import { CURRENT_SCHEMA_VERSION } from '../migrations/schema-version'
import {
  assertSchemaCompatible, inspectDatabaseMigrationState, loadMigrationBundle, MigrationCompatibilityError
} from '../migrations/compatibility'
import { getMigrationsFolder } from '../migrations/migration-runner'
import { assertHistoricalDatabaseStructure, verifyCurrentDatabase } from '../migrations/migration-verification'
import {
  backupFileName, backupStagingPath, extractArchiveBounded, joinBackupPath, publishArchive,
  sha256File, writeArchiveStreaming, type ArchiveFileEntry
} from './archive'
import { MANIFEST_ENTRY, DATABASE_ENTRY, type BackupManifest } from './manifest'
import { logger } from '../utils/logger'
import { AppError } from '../utils/errors'
import { recordAuditEvent } from '../audit/audit-log.service'
import { nowIso, type ServiceContext } from '../services/base/service.types'

const COUNTED_TABLES = [
  'users', 'customers', 'suppliers', 'materials', 'fifo_layers', 'inventory_movements',
  'quotations', 'orders', 'customer_payments', 'customer_payment_refunds', 'expenses', 'cash_transactions'
]

export interface BackupHooks {
  beforeSnapshot?: () => void
  duringSnapshot?: () => void
  afterSnapshot?: () => void
  afterSnapshotAsync?: () => Promise<void>
  duringHash?: () => void
  duringArchive?: () => void
  duringArchiveHeader?: () => void
  duringDatabaseStream?: () => void
  duringCompression?: () => void
  duringOutputWrite?: () => void
  duringFinalization?: () => void
  duringFsync?: () => void
  duringValidation?: () => void
  beforePublication?: () => void
  afterPublication?: () => void
}

function recordCounts(snapshotPath: string): Record<string, number> {
  const counts: Record<string, number> = {}
  const snapshot = new BetterSqlite3(snapshotPath, { readonly: true, fileMustExist: true })
  try {
    for (const table of COUNTED_TABLES) {
      try {
        const row = snapshot.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | undefined
        counts[table] = row?.c ?? 0
      } catch { counts[table] = -1 }
    }
  } finally { snapshot.close() }
  return counts
}

function fsyncFile(path: string): void {
  // Windows requires a writable file handle for FlushFileBuffers.
  const descriptor = openSync(path, 'r+')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function assertSnapshotHealthy(path: string): void {
  const probe = new BetterSqlite3(path, { readonly: true, fileMustExist: true })
  try {
    const integrity = probe.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (integrity[0]?.integrity_check !== 'ok' || (probe.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error('SQLite snapshot validation failed')
    }
  } finally { probe.close() }
}

/** VACUUM INTO is the coherent WAL-aware boundary; the returned file stays on disk. */
function snapshotDatabase(path: string, hooks?: BackupHooks): void {
  mkdirSync(getTempRoot(), { recursive: true })
  hooks?.beforeSnapshot?.()
  const raw = getRawConnection()
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  hooks?.duringSnapshot?.()
  raw.prepare('VACUUM INTO ?').run(path)
  fsyncFile(path)
  assertSnapshotHealthy(path)
  hooks?.afterSnapshot?.()
}

/** Remove only old DB-09 scratch names in the app tmp directory. */
export function cleanupStaleBackupTemps(maxAgeMs = 24 * 60 * 60 * 1000): string[] {
  const root = getTempRoot(); if (!existsSync(root)) return []
  const removed: string[] = []; const cutoff = Date.now() - maxAgeMs
  for (const name of readdirSync(root)) {
    if (!/^db09-(snapshot|verify)-[a-f0-9-]+\.(db|candidate)$/.test(name)) continue
    const path = join(root, name)
    try {
      if (statSync(path).mtimeMs < cutoff) { rmSync(path, { force: true }); removed.push(path) }
    } catch { /* a concurrent operation owns it */ }
  }
  return removed
}

/** Clean crash-left archive staging only when its destination is selected again. */
export function cleanupStaleDestinationBackupTemps(
  directory: string, maxAgeMs = 24 * 60 * 60 * 1000
): string[] {
  if (!existsSync(directory)) return []
  const removed: string[] = []; const cutoff = Date.now() - maxAgeMs
  for (const name of readdirSync(directory)) {
    if (!/^\..+\.[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.aurabak-incomplete$/.test(name)) continue
    const candidate = join(directory, name)
    try {
      if (statSync(candidate).mtimeMs < cutoff) { rmSync(candidate, { force: true }); removed.push(candidate) }
    } catch { /* a concurrent operation owns it */ }
  }
  return removed
}

/** BR-29/BR-59: bounded manual backup to a local folder, USB, or external drive. */
export async function createBackup(
  input: { destinationDirectory?: string; destinationFilePath?: string; includeConfig?: boolean },
  ctx?: ServiceContext,
  hooks?: BackupHooks
): Promise<{ path: string; manifest: BackupManifest }> {
  if (!input.destinationDirectory && !input.destinationFilePath) throw new AppError('VALIDATION_ERROR', 'يجب اختيار ملف الوجهة')
  const migrationBundle = loadMigrationBundle(getMigrationsFolder(), true)
  const migrationState = inspectDatabaseMigrationState(getRawConnection(), migrationBundle)
  if (migrationState.status !== 'current') throw new AppError('CONFLICT', 'لا يمكن إنشاء نسخة احتياطية أثناء ترقية مخطط قاعدة البيانات')

  cleanupStaleBackupTemps()
  const selected = input.destinationFilePath ?? joinBackupPath(input.destinationDirectory as string, backupFileName())
  const path = selected.toLowerCase().endsWith('.aurabak') ? selected : `${selected}.aurabak`
  mkdirSync(dirname(path), { recursive: true })
  cleanupStaleDestinationBackupTemps(dirname(path))
  if (existsSync(path)) throw new AppError('CONFLICT', 'يوجد ملف نسخة احتياطية بهذا الاسم بالفعل')
  const id = randomUUID()
  const snapshotPath = join(getTempRoot(), `db09-snapshot-${id}.db`)
  const stagingPath = backupStagingPath(path)
  try {
    snapshotDatabase(snapshotPath, hooks)
    await hooks?.afterSnapshotAsync?.()
    hooks?.duringHash?.()
    const databaseSha256 = await sha256File(snapshotPath)
    const manifest: BackupManifest = {
      appVersion: app.getVersion(), schemaVersion: CURRENT_SCHEMA_VERSION, createdAt: nowIso(), machineName: hostname(),
      recordCounts: recordCounts(snapshotPath), databaseSha256,
      migration: { appliedCount: migrationState.appliedCount, headCreatedAt: migrationState.headCreatedAt, fingerprint: migrationState.fingerprint }
    }
    const entries: ArchiveFileEntry[] = [
      { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      { name: DATABASE_ENTRY, path: snapshotPath }
    ]
    const configPath = join(getConfigRoot(), 'config.json')
    if (input.includeConfig !== false && existsSync(configPath)) entries.push({ name: 'config/config.json', path: configPath })
    hooks?.duringArchive?.()
    let databaseChunkObserved = false
    await writeArchiveStreaming(stagingPath, entries, {
      afterHeader: hooks?.duringArchiveHeader,
      beforeEntry: (name) => { if (name === DATABASE_ENTRY) hooks?.duringDatabaseStream?.() },
      afterCompressedChunk: (name) => {
        if (name === DATABASE_ENTRY && !databaseChunkObserved) {
          databaseChunkObserved = true
          hooks?.duringCompression?.()
          hooks?.duringOutputWrite?.()
        }
      },
      beforeFsync: () => { hooks?.duringFinalization?.(); hooks?.duringFsync?.() }
    })
    hooks?.duringValidation?.()
    const validation = await validateBackup(stagingPath)
    if (!validation.valid || validation.manifest?.databaseSha256 !== manifest.databaseSha256) {
      throw new Error(validation.reason ?? 'فشل التحقق من النسخة الاحتياطية المكتملة')
    }
    hooks?.beforePublication?.()
    await publishArchive(stagingPath, path)
    hooks?.afterPublication?.()
    logger.info('Backup created', { path, counts: manifest.recordCounts })
    try {
      recordAuditEvent({ userId: ctx?.session.user.id, action: 'backup.create', entity: 'backup', entityId: path,
        details: { schemaVersion: manifest.schemaVersion } })
    } catch (error) { logger.error('Backup succeeded but its audit event could not be recorded', error) }
    return { path, manifest }
  } finally {
    await Promise.allSettled([rm(snapshotPath, { force: true }), rm(stagingPath, { force: true })])
  }
}

export interface BackupValidation { valid: boolean; reason?: string; manifest?: BackupManifest }

function parseManifest(raw: Buffer): BackupManifest | undefined {
  let manifest: BackupManifest
  try { manifest = JSON.parse(raw.toString('utf8')) as BackupManifest } catch { return undefined }
  if (!manifest || typeof manifest.appVersion !== 'string' || !Number.isInteger(manifest.schemaVersion) ||
    typeof manifest.createdAt !== 'string' || typeof manifest.machineName !== 'string' ||
    !manifest.recordCounts || typeof manifest.recordCounts !== 'object' || Array.isArray(manifest.recordCounts) ||
    Object.values(manifest.recordCounts).some((count) => !Number.isInteger(count) || count < -1) ||
    !/^[a-f0-9]{64}$/.test(manifest.databaseSha256 ?? '') ||
    (manifest.migration !== undefined && (!Number.isInteger(manifest.migration.appliedCount) || manifest.migration.appliedCount < 1 ||
      (manifest.migration.headCreatedAt !== null && !Number.isInteger(manifest.migration.headCreatedAt)) ||
      !/^[a-f0-9]{64}$/.test(manifest.migration.fingerprint ?? '')))) return undefined
  return manifest
}

async function validateStagedDatabase(stagedPath: string, manifest: BackupManifest): Promise<BackupValidation> {
  try { assertSchemaCompatible(manifest.schemaVersion) } catch {
    return { valid: false, reason: 'النسخة الاحتياطية من إصدار أحدث أو غير معروف. الرجاء تحديث التطبيق أولاً', manifest }
  }
  let probe: BetterSqlite3.Database | undefined
  try {
    probe = new BetterSqlite3(stagedPath, { readonly: true, fileMustExist: true })
    const integrity = probe.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (integrity[0]?.integrity_check !== 'ok') return { valid: false, reason: 'قاعدة البيانات داخل النسخة الاحتياطية تالفة', manifest }
    if ((probe.pragma('foreign_key_check') as unknown[]).length > 0) return { valid: false, reason: 'النسخة الاحتياطية تحتوي على تناقضات في البيانات', manifest }
    try {
      const bundle = loadMigrationBundle(getMigrationsFolder(), true)
      const state = inspectDatabaseMigrationState(probe, bundle)
      if (state.status === 'fresh') return { valid: false, reason: 'قاعدة بيانات النسخة الاحتياطية لا تحتوي على سجل ترحيل صالح', manifest }
      if (state.status === 'current') verifyCurrentDatabase(probe, bundle)
      else assertHistoricalDatabaseStructure(probe, bundle, state)
      if (manifest.migration && (manifest.migration.appliedCount !== state.appliedCount ||
        manifest.migration.headCreatedAt !== state.headCreatedAt || manifest.migration.fingerprint !== state.fingerprint)) {
        return { valid: false, reason: 'بيانات هوية ترحيل النسخة الاحتياطية لا تطابق قاعدة البيانات', manifest }
      }
    } catch (error) {
      return { valid: false, reason: error instanceof MigrationCompatibilityError && error.code === 'DB_MIGRATION_NEWER'
        ? 'النسخة الاحتياطية من إصدار ترحيل أحدث من التطبيق' : 'سجل ترحيل النسخة الاحتياطية غير معروف أو غير متسق', manifest }
    }
    return { valid: true, manifest }
  } finally { probe?.close() }
}

/** Extract once into a caller-owned candidate and validate without a DB-sized Buffer. */
export async function validateBackupToCandidate(filePath: string, candidatePath: string): Promise<BackupValidation> {
  try {
    const extracted = await extractArchiveBounded(filePath, candidatePath)
    const manifest = parseManifest(extracted.manifest)
    if (!manifest) return { valid: false, reason: 'بيانات وصف النسخة الاحتياطية غير صالحة' }
    if (extracted.databaseSha256 !== manifest.databaseSha256) return { valid: false, reason: 'فشل التحقق من سلامة الملف (اختلاف البصمة). النسخة تالفة' }
    return await validateStagedDatabase(candidatePath, manifest)
  } catch (error) {
    logger.error('Backup validation failed', error)
    return { valid: false, reason: 'تعذر قراءة ملف النسخة الاحتياطية' }
  }
}

export async function validateBackup(filePath: string): Promise<BackupValidation> {
  mkdirSync(getTempRoot(), { recursive: true })
  const stagedPath = join(getTempRoot(), `db09-verify-${randomUUID()}.candidate`)
  try { return await validateBackupToCandidate(filePath, stagedPath) }
  finally { await rm(stagedPath, { force: true }) }
}

export function inspectBackup(filePath: string): Promise<BackupValidation> { return validateBackup(filePath) }
export function getLiveDatabasePath(): string { return join(getDataRoot(), 'erp.db') }
