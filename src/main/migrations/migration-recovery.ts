import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  chmodSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getBackupsRoot, getDataRoot } from '../files/paths'
import { logger } from '../utils/logger'
import { migrationRowsFingerprint } from './compatibility'

export type MigrationRecoveryPhase = 'prepared' | 'migrating' | 'migrated' | 'verified'

export interface MigrationRecoveryMarker {
  version: 1 | 2
  phase: MigrationRecoveryPhase
  databasePath: string
  backupPath: string
  backupSha256: string
  createdAt: string
  updatedAt: string
  fromMigrationCreatedAt: number | null
  targetMigrationCreatedAt: number
  fromMigrationCount?: number
  targetMigrationCount?: number
  fromMigrationFingerprint?: string
  targetMigrationFingerprint?: string
}

export interface MigrationRecoveryPreparation {
  fromMigrationCreatedAt: number | null
  targetMigrationCreatedAt: number
  fromMigrationCount: number
  targetMigrationCount: number
  fromMigrationFingerprint: string
  targetMigrationFingerprint: string
}

export interface MigrationRecoveryPaths {
  root: string
  marker: string
}

function fsyncFile(path: string): void {
  // Windows requires a writable file handle for FlushFileBuffers.
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Some Windows filesystems do not permit opening/fsyncing directories.
    // Files themselves are still fsynced before every atomic rename.
  }
}

function sha256File(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let offset = 0
    const size = statSync(path).size
    while (offset < size) {
      const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset)
      if (bytesRead === 0) throw new Error(`Could not completely read ${path}`)
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function isPathInside(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path))
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function writeMarker(path: string, marker: MigrationRecoveryMarker): void {
  const root = dirname(path)
  mkdirSync(root, { recursive: true })
  const temporary = join(root, `.active-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600 })
    fsyncFile(temporary)
    renameSync(temporary, path)
    fsyncDirectory(root)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function removeMarker(path: string): void {
  rmSync(path, { force: true })
  fsyncDirectory(dirname(path))
}

function assertDatabaseHealthy(raw: Database.Database, label: string): void {
  const integrity = raw.pragma('integrity_check') as Array<{ integrity_check: string }>
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`${label} failed SQLite integrity_check`)
  }
  const violations = raw.pragma('foreign_key_check') as unknown[]
  if (violations.length > 0) {
    throw new Error(`${label} has ${violations.length} foreign-key violation(s)`)
  }
}

function inspectDatabase(path: string, label: string): void {
  const probe = new Database(path, { readonly: true, fileMustExist: true })
  try {
    assertDatabaseHealthy(probe, label)
  } finally {
    probe.close()
  }
}

function databaseMigrationIdentity(path: string): {
  createdAt: number | undefined
  count: number
  fingerprint: string
} {
  const probe = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const journalExists = probe
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get()
    if (!journalExists) {
      return { createdAt: undefined, count: 0, fingerprint: migrationRowsFingerprint([]) }
    }
    const rows = probe
      .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, rowid')
      .all() as Array<{ hash: string; created_at: number | string | null }>
    const normalized = rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }))
    if (normalized.some((row) => !row.hash || !Number.isFinite(row.createdAt))) {
      throw new Error('Migration recovery database has an invalid journal row')
    }
    return {
      createdAt: normalized.at(-1)?.createdAt,
      count: normalized.length,
      fingerprint: migrationRowsFingerprint(normalized)
    }
  } finally {
    probe.close()
  }
}

function parseMarker(path: string, databasePath: string): MigrationRecoveryMarker {
  let marker: MigrationRecoveryMarker
  try {
    marker = JSON.parse(readFileSync(path, 'utf8')) as MigrationRecoveryMarker
  } catch {
    throw new Error(`Migration recovery marker is unreadable: ${path}`)
  }
  const phases: MigrationRecoveryPhase[] = ['prepared', 'migrating', 'migrated', 'verified']
  const expectedDatabasePath = resolve(databasePath)
  const paths = getMigrationRecoveryPaths(expectedDatabasePath)
  if (
    ![1, 2].includes(marker.version) ||
    !phases.includes(marker.phase) ||
    resolve(marker.databasePath) !== expectedDatabasePath ||
    !isPathInside(marker.backupPath, paths.root) ||
    !/^[a-f0-9]{64}$/.test(marker.backupSha256) ||
    !Number.isFinite(marker.targetMigrationCreatedAt)
  ) {
    throw new Error(`Migration recovery marker is invalid: ${path}`)
  }
  if (
    marker.version === 2 &&
    (!Number.isInteger(marker.fromMigrationCount) ||
      !Number.isInteger(marker.targetMigrationCount) ||
      (marker.fromMigrationCount as number) < 1 ||
      (marker.targetMigrationCount as number) <= (marker.fromMigrationCount as number) ||
      !/^[a-f0-9]{64}$/.test(marker.fromMigrationFingerprint ?? '') ||
      !/^[a-f0-9]{64}$/.test(marker.targetMigrationFingerprint ?? ''))
  ) {
    throw new Error(`Migration recovery marker migration identity is invalid: ${path}`)
  }
  return marker
}

function validateBackup(marker: MigrationRecoveryMarker): void {
  if (!existsSync(marker.backupPath)) {
    throw new Error(`Pre-migration recovery copy is missing: ${marker.backupPath}`)
  }
  if (sha256File(marker.backupPath) !== marker.backupSha256) {
    throw new Error(`Pre-migration recovery copy checksum failed: ${marker.backupPath}`)
  }
  inspectDatabase(marker.backupPath, 'Pre-migration recovery copy')
  const backupIdentity = databaseMigrationIdentity(marker.backupPath)
  if (backupIdentity.createdAt !== (marker.fromMigrationCreatedAt ?? undefined)) {
    throw new Error('Pre-migration recovery copy journal does not match its marker')
  }
  if (
    marker.version === 2 &&
    (backupIdentity.count !== marker.fromMigrationCount ||
      backupIdentity.fingerprint !== marker.fromMigrationFingerprint)
  ) {
    throw new Error('Pre-migration recovery copy history fingerprint does not match its marker')
  }
}

/**
 * Uses the application backup tree for the real database and an adjacent
 * isolated directory for explicit test/restore paths.
 */
export function getMigrationRecoveryPaths(databasePath: string): MigrationRecoveryPaths {
  const normalized = resolve(databasePath)
  const productionDataRoot = resolve(getDataRoot())
  const root = isPathInside(normalized, productionDataRoot)
    ? join(getBackupsRoot(), 'pre-migration')
    : join(dirname(normalized), '.migration-recovery')
  const identity = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  const databaseRoot = join(root, identity)
  return { root: databaseRoot, marker: join(databaseRoot, 'active.json') }
}

export function readMigrationRecoveryMarker(
  databasePath: string
): MigrationRecoveryMarker | undefined {
  const path = getMigrationRecoveryPaths(databasePath).marker
  return existsSync(path) ? parseMarker(path, databasePath) : undefined
}

/**
 * Creates and validates a standalone SQLite snapshot, fsyncs it, and only then
 * publishes the durable recovery marker. The source connection must not be in
 * a transaction; VACUUM INTO provides a transactionally consistent copy even
 * when the live database uses WAL.
 */
export function prepareMigrationRecovery(
  raw: Database.Database,
  preparation: MigrationRecoveryPreparation
): MigrationRecoveryMarker {
  if (raw.inTransaction) {
    throw new Error('Cannot prepare migration recovery inside a transaction')
  }
  if (!raw.name || raw.name === ':memory:') {
    throw new Error('Migration recovery requires a file-backed database')
  }
  const databasePath = resolve(raw.name)
  const paths = getMigrationRecoveryPaths(databasePath)
  if (existsSync(paths.marker)) {
    throw new Error('An unfinished migration recovery marker already exists')
  }
  mkdirSync(paths.root, { recursive: true })
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  const temporary = join(paths.root, `.snapshot-${id}.tmp`)
  const backupPath = join(paths.root, `pre-migration-${id}.db`)

  try {
    raw.pragma('wal_checkpoint(TRUNCATE)')
    raw.prepare('VACUUM INTO ?').run(temporary)
    chmodSync(temporary, 0o600)
    assertDatabaseHealthy(raw, 'Live pre-migration database')
    inspectDatabase(temporary, 'Pre-migration recovery copy')
    fsyncFile(temporary)
    renameSync(temporary, backupPath)
    fsyncDirectory(paths.root)

    const now = new Date().toISOString()
    const marker: MigrationRecoveryMarker = {
      version: 2,
      phase: 'prepared',
      databasePath,
      backupPath,
      backupSha256: sha256File(backupPath),
      createdAt: now,
      updatedAt: now,
      ...preparation
    }
    validateBackup(marker)
    writeMarker(paths.marker, marker)
    logger.info('Pre-migration recovery copy prepared', {
      backupPath,
      fromMigrationCreatedAt: marker.fromMigrationCreatedAt,
      targetMigrationCreatedAt: marker.targetMigrationCreatedAt,
      fromMigrationFingerprint: marker.fromMigrationFingerprint,
      targetMigrationFingerprint: marker.targetMigrationFingerprint
    })
    return marker
  } catch (error) {
    rmSync(temporary, { force: true })
    if (!existsSync(paths.marker)) rmSync(backupPath, { force: true })
    throw error
  }
}

export function markMigrationRecoveryPhase(
  marker: MigrationRecoveryMarker,
  phase: Exclude<MigrationRecoveryPhase, 'prepared'>
): MigrationRecoveryMarker {
  const paths = getMigrationRecoveryPaths(marker.databasePath)
  const current = parseMarker(paths.marker, marker.databasePath)
  if (current.backupSha256 !== marker.backupSha256) {
    throw new Error('Migration recovery marker changed unexpectedly')
  }
  if (
    (phase === 'migrating' && current.phase !== 'prepared') ||
    (phase === 'migrated' && current.phase !== 'migrating') ||
    (phase === 'verified' && current.phase !== 'migrated')
  ) {
    throw new Error(`Invalid migration recovery phase transition: ${current.phase} -> ${phase}`)
  }
  const next = { ...current, phase, updatedAt: new Date().toISOString() }
  writeMarker(paths.marker, next)
  return next
}

function quarantineLiveDatabase(databasePath: string, root: string): string {
  const quarantine = join(
    root,
    `interrupted-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  )
  mkdirSync(quarantine, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${databasePath}${suffix}`
    if (existsSync(source)) renameSync(source, join(quarantine, `${basename(databasePath)}${suffix}`))
  }
  fsyncDirectory(dirname(databasePath))
  fsyncDirectory(quarantine)
  return quarantine
}

function restorePreMigrationCopy(marker: MigrationRecoveryMarker): string {
  validateBackup(marker)
  const databasePath = resolve(marker.databasePath)
  const paths = getMigrationRecoveryPaths(databasePath)
  mkdirSync(dirname(databasePath), { recursive: true })
  const staged = join(dirname(databasePath), `.${basename(databasePath)}-recovery-${randomUUID()}.tmp`)
  let quarantine = ''
  try {
    copyFileSync(marker.backupPath, staged)
    fsyncFile(staged)
    inspectDatabase(staged, 'Staged migration recovery copy')
    quarantine = quarantineLiveDatabase(databasePath, paths.root)
    renameSync(staged, databasePath)
    fsyncDirectory(dirname(databasePath))
    inspectDatabase(databasePath, 'Recovered database')
    removeMarker(paths.marker)
    logger.warn('Interrupted migration recovered from pre-migration copy', {
      databasePath,
      backupPath: marker.backupPath,
      quarantine
    })
    return quarantine
  } finally {
    rmSync(staged, { force: true })
  }
}

/**
 * Must run before opening the live SQLite connection. Prepared/migrating means
 * the previous process did not prove success, so the known-good copy wins.
 */
export function recoverInterruptedMigration(databasePath: string):
  | { action: 'none' }
  | { action: 'verified'; backupPath: string }
  | { action: 'restored'; backupPath: string; quarantinePath: string } {
  const normalized = resolve(databasePath)
  const paths = getMigrationRecoveryPaths(normalized)
  if (!existsSync(paths.marker)) return { action: 'none' }

  const marker = parseMarker(paths.marker, normalized)
  validateBackup(marker)
  if (marker.phase === 'verified' && existsSync(normalized)) {
    try {
      inspectDatabase(normalized, 'Verified migrated database')
      const identity = databaseMigrationIdentity(normalized)
      const targetMatches =
        marker.version === 2
          ? identity.count === marker.targetMigrationCount &&
            identity.fingerprint === marker.targetMigrationFingerprint
          : identity.createdAt === marker.targetMigrationCreatedAt
      if (targetMatches) {
        logger.info('Verified migration recovery state accepted for startup verification', {
          databasePath: normalized,
          backupPath: marker.backupPath
        })
        return { action: 'verified', backupPath: marker.backupPath }
      }
    } catch (error) {
      logger.error('Verified migrated database failed reopen checks; restoring backup', error)
    }
  }

  const quarantinePath = restorePreMigrationCopy(marker)
  return { action: 'restored', backupPath: marker.backupPath, quarantinePath }
}

/** Called after the application window is successfully created. */
export function finalizeMigrationRecovery(raw: Database.Database): string | undefined {
  if (!raw.name || raw.name === ':memory:') return undefined
  const databasePath = resolve(raw.name)
  const paths = getMigrationRecoveryPaths(databasePath)
  if (!existsSync(paths.marker)) return undefined
  const marker = parseMarker(paths.marker, databasePath)
  if (marker.phase !== 'verified') {
    throw new Error(`Cannot finalize migration recovery in phase ${marker.phase}`)
  }
  assertDatabaseHealthy(raw, 'Migrated database')
  const rows = raw
    .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, rowid')
    .all() as Array<{ hash: string; created_at: number | string | null }>
  const normalizedRows = rows.map((row) => ({
    hash: row.hash,
    createdAt: Number(row.created_at)
  }))
  const targetMatches =
    marker.version === 2
      ? normalizedRows.length === marker.targetMigrationCount &&
        migrationRowsFingerprint(normalizedRows) === marker.targetMigrationFingerprint
      : normalizedRows.at(-1)?.createdAt === marker.targetMigrationCreatedAt
  if (!targetMatches) {
    throw new Error('Cannot finalize migration recovery before the target migration is journaled')
  }
  removeMarker(paths.marker)
  logger.info('Migration recovery finalized after successful application startup', {
    databasePath,
    backupPath: marker.backupPath
  })
  return marker.backupPath
}

/**
 * Used only when a higher-level operation (currently staged restore) has put
 * its own known-good database back. The recovery copy is retained; only the
 * now-obsolete active marker is removed.
 */
export function cancelMigrationRecovery(databasePath: string): string | undefined {
  const normalized = resolve(databasePath)
  const paths = getMigrationRecoveryPaths(normalized)
  if (!existsSync(paths.marker)) return undefined
  try {
    const marker = parseMarker(paths.marker, normalized)
    validateBackup(marker)
    removeMarker(paths.marker)
    logger.warn('Migration recovery marker cancelled after higher-level rollback', {
      databasePath: normalized,
      backupPath: marker.backupPath
    })
    return marker.backupPath
  } catch (error) {
    // The higher-level restore owns the authoritative rollback copy. Never let
    // a damaged subordinate marker prevent that rollback, but retain the bad
    // marker for diagnosis instead of silently deleting it.
    const retained = join(paths.root, `cancelled-invalid-${Date.now()}-${randomUUID()}.json`)
    renameSync(paths.marker, retained)
    fsyncDirectory(paths.root)
    logger.error('Invalid migration recovery marker retained during higher-level rollback', {
      databasePath: normalized,
      retained,
      error
    })
    return undefined
  }
}
