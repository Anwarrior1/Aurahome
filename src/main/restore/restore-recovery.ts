import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync,
  openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getBackupsRoot, getDataRoot } from '../files/paths'
import { loadMigrationBundle, inspectDatabaseMigrationState } from '../migrations/compatibility'
import { getMigrationsFolder } from '../migrations/migration-runner'
import {
  assertDatabaseHealthy, assertHistoricalDatabaseStructure, verifyCurrentDatabaseSchema
} from '../migrations/migration-verification'
import { cancelMigrationRecovery, readMigrationRecoveryMarker } from '../migrations/migration-recovery'
import { logger } from '../utils/logger'

export type RestorePhase = 'protected' | 'installing' | 'installed' | 'verified'

export interface RestoreMarker {
  version: 1
  operationId: string
  phase: RestorePhase
  databasePath: string
  candidatePath: string
  candidateSha256: string
  safetyPath: string
  safetySha256: string
  candidateMigrationCount: number
  candidateMigrationFingerprint: string
  verifiedSha256?: string
  createdAt: string
  updatedAt: string
}

export function getRestoreRecoveryPaths(databasePath: string): { root: string; marker: string } {
  const normalized = resolve(databasePath)
  const production = resolve(getDataRoot())
  const child = relative(production, normalized)
  const inProduction = child === '' || (!child.startsWith('..') && !isAbsolute(child))
  const base = inProduction ? join(getBackupsRoot(), 'pre-restore') : join(dirname(normalized), '.restore-recovery')
  const identity = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  const root = join(base, identity)
  return { root, marker: join(root, 'active.json') }
}

export function fsyncRestoreFile(path: string): void {
  // Windows requires a writable file handle for FlushFileBuffers.
  const fd = openSync(path, 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function fsyncRestoreDirectory(path: string): void {
  try {
    const fd = openSync(path, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  } catch (error) {
    // Windows may reject directory handles/fsync. On platforms that support
    // directory fsync, failure means the durable transition is not proven.
    if (process.platform !== 'win32') throw error
  }
}

export function sha256RestoreFile(path: string): string {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    const size = statSync(path).size
    for (let offset = 0; offset < size;) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset)
      if (read === 0) throw new Error(`Incomplete restore file read: ${path}`)
      hash.update(buffer.subarray(0, read))
      offset += read
    }
  } finally { closeSync(fd) }
  return hash.digest('hex')
}

function inspect(path: string, requireCurrent: boolean): { count: number; fingerprint: string } {
  const raw = new Database(path, { readonly: true, fileMustExist: true })
  try {
    assertDatabaseHealthy(raw)
    const bundle = loadMigrationBundle(getMigrationsFolder(), true)
    const state = inspectDatabaseMigrationState(raw, bundle)
    if (state.status === 'fresh') throw new Error('Restore file has no supported migration history')
    // Read-only probe already proven healthy above; no second O(size) pass.
    if (requireCurrent || state.status === 'current') verifyCurrentDatabaseSchema(raw, bundle)
    else assertHistoricalDatabaseStructure(raw, bundle, state)
    return { count: state.appliedCount, fingerprint: state.fingerprint }
  } finally { raw.close() }
}

export function validateRestoreFile(path: string, hash: string, requireCurrent = false): { count: number; fingerprint: string } {
  if (!existsSync(path) || sha256RestoreFile(path) !== hash) {
    throw new Error(`Restore file missing or checksum mismatch: ${path}`)
  }
  return inspect(path, requireCurrent)
}

function writeMarker(path: string, marker: RestoreMarker): void {
  const root = dirname(path)
  mkdirSync(root, { recursive: true })
  const temporary = join(root, `.active-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(marker, null, 2), { encoding: 'utf8', mode: 0o600 })
    fsyncRestoreFile(temporary)
    renameSync(temporary, path)
    fsyncRestoreDirectory(root)
  } finally { rmSync(temporary, { force: true }) }
}

function parseMarker(path: string, databasePath: string): RestoreMarker {
  let marker: RestoreMarker
  try { marker = JSON.parse(readFileSync(path, 'utf8')) as RestoreMarker }
  catch { throw new Error(`Restore recovery marker unreadable: ${path}`) }
  const normalized = resolve(databasePath)
  const paths = getRestoreRecoveryPaths(normalized)
  const expectedSafety = join(paths.root, `pre-restore-${marker.operationId}.db`)
  const expectedCandidate = join(dirname(normalized), `.${basename(normalized)}-restore-${marker.operationId}.candidate`)
  if (
    marker.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(marker.operationId) ||
    !(['protected', 'installing', 'installed', 'verified'] as string[]).includes(marker.phase) ||
    marker.databasePath !== normalized ||
    marker.safetyPath !== expectedSafety ||
    marker.candidatePath !== expectedCandidate ||
    !/^[a-f0-9]{64}$/.test(marker.safetySha256) ||
    !/^[a-f0-9]{64}$/.test(marker.candidateSha256) ||
    !Number.isInteger(marker.candidateMigrationCount) || marker.candidateMigrationCount < 1 ||
    !/^[a-f0-9]{64}$/.test(marker.candidateMigrationFingerprint) ||
    (marker.phase === 'verified' && !/^[a-f0-9]{64}$/.test(marker.verifiedSha256 ?? '')) ||
    (marker.phase !== 'verified' && marker.verifiedSha256 !== undefined)
  ) throw new Error(`Restore recovery marker invalid: ${path}`)
  return marker
}

export function readRestoreMarker(databasePath: string): RestoreMarker | undefined {
  const normalized = resolve(databasePath)
  const path = getRestoreRecoveryPaths(normalized).marker
  return existsSync(path) ? parseMarker(path, normalized) : undefined
}

export function restoreRecoveryPending(databasePath: string): boolean {
  return existsSync(getRestoreRecoveryPaths(databasePath).marker)
}

export function publishRestoreMarker(marker: RestoreMarker): void {
  const path = getRestoreRecoveryPaths(marker.databasePath).marker
  if (existsSync(path)) throw new Error('Another restore operation is unfinished')
  validateRestoreFile(marker.safetyPath, marker.safetySha256)
  const candidate = validateRestoreFile(marker.candidatePath, marker.candidateSha256)
  if (candidate.count !== marker.candidateMigrationCount || candidate.fingerprint !== marker.candidateMigrationFingerprint) {
    throw new Error('Candidate migration identity changed during restore preparation')
  }
  writeMarker(path, marker)
}

export function advanceRestoreMarker(marker: RestoreMarker, phase: Exclude<RestorePhase, 'protected'>, verifiedSha256?: string): RestoreMarker {
  const path = getRestoreRecoveryPaths(marker.databasePath).marker
  const current = parseMarker(path, marker.databasePath)
  if (current.operationId !== marker.operationId || current.safetySha256 !== marker.safetySha256) {
    throw new Error('Restore recovery marker changed unexpectedly')
  }
  if (
    (phase === 'installing' && current.phase !== 'protected') ||
    (phase === 'installed' && current.phase !== 'installing') ||
    (phase === 'verified' && current.phase !== 'installed')
  ) throw new Error(`Invalid restore transition: ${current.phase} -> ${phase}`)
  if (phase === 'installed') {
    // The candidate rename is durable; no other database epoch's sidecars may be present.
    if (sha256RestoreFile(current.databasePath) !== current.candidateSha256) throw new Error('Installed candidate checksum mismatch')
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${current.databasePath}${suffix}`)) throw new Error('Stale SQLite sidecar after restore installation')
    }
  }
  if (phase === 'verified') {
    if (!verifiedSha256 || sha256RestoreFile(current.databasePath) !== verifiedSha256) {
      throw new Error('Verified restore checksum mismatch')
    }
    inspect(current.databasePath, true)
  }
  const next: RestoreMarker = { ...current, phase, verifiedSha256, updatedAt: new Date().toISOString() }
  writeMarker(path, next)
  return next
}

function quarantineLive(marker: RestoreMarker): string {
  const paths = getRestoreRecoveryPaths(marker.databasePath)
  const quarantine = join(paths.root, `interrupted-${marker.operationId}-${randomUUID()}`)
  mkdirSync(quarantine, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${marker.databasePath}${suffix}`
    if (existsSync(source)) renameSync(source, join(quarantine, `${basename(marker.databasePath)}${suffix}`))
  }
  fsyncRestoreDirectory(dirname(marker.databasePath))
  fsyncRestoreDirectory(quarantine)
  return quarantine
}

function rollback(marker: RestoreMarker): string {
  validateRestoreFile(marker.safetyPath, marker.safetySha256)
  const staged = join(dirname(marker.databasePath), `.${basename(marker.databasePath)}-rollback-${randomUUID()}.tmp`)
  try {
    copyFileSync(marker.safetyPath, staged)
    chmodSync(staged, 0o600)
    fsyncRestoreFile(staged)
    validateRestoreFile(staged, marker.safetySha256)
    const quarantine = quarantineLive(marker)
    renameSync(staged, marker.databasePath)
    fsyncRestoreDirectory(dirname(marker.databasePath))
    validateRestoreFile(marker.databasePath, marker.safetySha256)
    // DB-07 is subordinate to this general restore. Cancel only after A is durable again.
    cancelMigrationRecovery(marker.databasePath)
    finishRestoreMarker(marker)
    logger.warn('Interrupted restore recovered from protected pre-restore snapshot', { quarantine })
    return quarantine
  } finally { rmSync(staged, { force: true }) }
}

export function finishRestoreMarker(marker: RestoreMarker): void {
  const path = getRestoreRecoveryPaths(marker.databasePath).marker
  const current = parseMarker(path, marker.databasePath)
  if (current.operationId !== marker.operationId) throw new Error('Restore marker identity changed')
  // This is the last authoritative transition. Cleanup is noncritical:
  // deleting a candidate first would leave a protected marker that could no
  // longer be replayed after a crash between unlink and marker removal.
  rmSync(path)
  fsyncRestoreDirectory(dirname(path))
  try {
    rmSync(marker.candidatePath, { force: true })
    fsyncRestoreDirectory(dirname(marker.databasePath))
  } catch (error) {
    logger.warn('Restore candidate cleanup deferred; safety state is already finalized', error)
  }
}

/** Run before DB-07 recovery and before the first normal SQLite open. */
export function recoverInterruptedRestore(databasePath: string):
  | { action: 'none' }
  | { action: 'restored'; quarantinePath: string }
  | { action: 'verified' } {
  const marker = readRestoreMarker(databasePath)
  if (!marker) return { action: 'none' }
  validateRestoreFile(marker.safetyPath, marker.safetySha256)
  if (marker.phase === 'protected' || (marker.phase === 'installing' && existsSync(marker.candidatePath))) {
    validateRestoreFile(marker.candidatePath, marker.candidateSha256)
  }
  // If installing consumed the candidate, the published live tuple is still
  // unverified. rollback() quarantines it and restores the verified A snapshot.
  if (marker.phase === 'installed' && existsSync(marker.candidatePath)) {
    validateRestoreFile(marker.candidatePath, marker.candidateSha256)
  }
  if (marker.phase === 'verified') {
    const migrationMarker = readMigrationRecoveryMarker(marker.databasePath)
    if (migrationMarker && migrationMarker.phase !== 'verified') {
      throw new Error('Verified restore has contradictory migration recovery state')
    }
    validateRestoreFile(marker.databasePath, marker.verifiedSha256 as string, true)
    finishRestoreMarker(marker)
    logger.info('Verified interrupted restore accepted', { databasePath: marker.databasePath })
    return { action: 'verified' }
  }
  return { action: 'restored', quarantinePath: rollback(marker) }
}
