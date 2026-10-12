import { randomUUID } from 'node:crypto'
import BetterSqlite3 from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { closeDatabase, getDatabase, getDatabasePath, getRawConnection } from '../db/connection'
import { validateBackupToCandidate } from '../backup/backup.service'
import { runIntegrityCheck } from '../db/integrity'
import { runPendingMigrations, getMigrationsFolder, type PendingMigrationHooks } from '../migrations/migration-runner'
import { readMigrationRecoveryMarker, finalizeMigrationRecovery } from '../migrations/migration-recovery'
import { loadMigrationBundle } from '../migrations/compatibility'
import { verifyCurrentDatabase } from '../migrations/migration-verification'
import { initializeFinishedGoodsValuationCutovers } from '../services/production/finished-goods.service'
import { destroyAllSessions } from '../auth/session'
import { clearRememberTokenFromDisk } from '../auth/remember-file'
import { getConfigRoot } from '../files/paths'
import {
  advanceRestoreMarker, finishRestoreMarker, fsyncRestoreDirectory, fsyncRestoreFile,
  getRestoreRecoveryPaths, publishRestoreMarker, readRestoreMarker,
  recoverInterruptedRestore, sha256RestoreFile, validateRestoreFile, type RestoreMarker
} from './restore-recovery'
import { AppError } from '../utils/errors'
import { logger } from '../utils/logger'
import { recordAuditEvent } from '../audit/audit-log.service'
import { nowIso, type ServiceContext } from '../services/base/service.types'
import { acquireRestoreExclusivity, captureRestoreGeneration } from './restore-lifecycle'

/** Test-only deterministic interruption at an actual restore durability boundary. */
export class SimulatedRestoreInterruption extends Error {}

export interface RestoreHooks {
  migration?: PendingMigrationHooks
  lifecycleDrainTimeoutMs?: number
  afterCandidateValidated?: () => void
  afterSafetySnapshotPublished?: () => void
  afterProtectedMarker?: () => void
  afterInstallingMarker?: () => void
  afterDatabaseClose?: () => void
  afterSidecarQuarantine?: () => void
  afterAtomicInstall?: () => void
  afterInstalledMarker?: () => void
  afterPostInstallVerification?: () => void
  afterSessionInvalidation?: () => void
  afterVerifiedMarker?: () => void
}

function purgeCandidateRememberTokens(path: string): void {
  const candidate = new BetterSqlite3(path, { fileMustExist: true })
  try {
    candidate.pragma('journal_mode = DELETE')
    candidate.pragma('synchronous = FULL')
    const hasTokens = candidate.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'remember_tokens'"
    ).get()
    if (hasTokens) candidate.exec('DELETE FROM remember_tokens')
  } finally { candidate.close() }
}

/** General restore as a durable recoverable state transition. */
export async function restoreFromBackup(
  input: { backupFilePath: string }, ctx: ServiceContext, hooks?: RestoreHooks
): Promise<{ restoredFrom: string; safetyCopyPath: string }> {
  const expectedGeneration = captureRestoreGeneration()
  const livePath = resolve(getDatabasePath())
  if (readRestoreMarker(livePath) || readMigrationRecoveryMarker(livePath)) {
    throw new AppError('CONFLICT', 'توجد عملية استعادة أو ترحيل غير مكتملة')
  }
  const id = randomUUID()
  const paths = getRestoreRecoveryPaths(livePath)
  const candidatePath = join(dirname(livePath), `.${basename(livePath)}-restore-${id}.candidate`)
  const snapshotTemporary = join(paths.root, `.snapshot-${id}.tmp`)
  const safetyCopyPath = join(paths.root, `pre-restore-${id}.db`)
  mkdirSync(dirname(livePath), { recursive: true })
  mkdirSync(paths.root, { recursive: true })
  const validation = await validateBackupToCandidate(input.backupFilePath, candidatePath)
  if (!validation.valid || !validation.manifest) {
    rmSync(candidatePath, { force: true })
    throw new AppError('CONFLICT', validation.reason ?? 'النسخة الاحتياطية غير صالحة')
  }
  let marker: RestoreMarker | undefined
  let releaseExclusive: (() => void) | undefined
  try {
    // Staging is adjacent to live: rename cannot silently become a cross-volume copy.
    chmodSync(candidatePath, 0o600)
    fsyncRestoreFile(candidatePath)
    fsyncRestoreDirectory(dirname(livePath))
    const originalCandidateHash = sha256RestoreFile(candidatePath)
    if (originalCandidateHash !== validation.manifest.databaseSha256) throw new Error('Candidate checksum changed')
    validateRestoreFile(candidatePath, originalCandidateHash)
    // Authentication tokens from a backup are never trusted in a new DB
    // epoch, including if restore metadata is lost on a platform without
    // durable directory fsync. Revalidate this transformed candidate.
    purgeCandidateRememberTokens(candidatePath)
    fsyncRestoreFile(candidatePath)
    fsyncRestoreDirectory(dirname(livePath))
    const candidateHash = sha256RestoreFile(candidatePath)
    const candidateIdentity = validateRestoreFile(candidatePath, candidateHash)
    hooks?.afterCandidateValidated?.()

    releaseExclusive = await acquireRestoreExclusivity(expectedGeneration, hooks?.lifecycleDrainTimeoutMs)

    const raw = getRawConnection()
    if (raw.inTransaction || resolve(raw.name) !== livePath) {
      throw new Error('Restore requires the authoritative idle live SQLite connection')
    }
    raw.pragma('wal_checkpoint(TRUNCATE)')
    raw.prepare('VACUUM INTO ?').run(snapshotTemporary)
    chmodSync(snapshotTemporary, 0o600)
    fsyncRestoreFile(snapshotTemporary)
    const safetyHash = sha256RestoreFile(snapshotTemporary)
    validateRestoreFile(snapshotTemporary, safetyHash)
    renameSync(snapshotTemporary, safetyCopyPath)
    fsyncRestoreDirectory(paths.root)
    validateRestoreFile(safetyCopyPath, safetyHash)
    hooks?.afterSafetySnapshotPublished?.()

    const now = nowIso()
    marker = {
      version: 1, operationId: id, phase: 'protected', databasePath: livePath,
      candidatePath, candidateSha256: candidateHash,
      safetyPath: safetyCopyPath, safetySha256: safetyHash,
      candidateMigrationCount: candidateIdentity.count,
      candidateMigrationFingerprint: candidateIdentity.fingerprint,
      createdAt: now, updatedAt: now
    }
    publishRestoreMarker(marker)
    hooks?.afterProtectedMarker?.()
    marker = advanceRestoreMarker(marker, 'installing')
    hooks?.afterInstallingMarker?.()

    closeDatabase()
    hooks?.afterDatabaseClose?.()
    const quarantine = join(paths.root, `sidecars-${id}`)
    mkdirSync(quarantine, { recursive: true })
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${livePath}${suffix}`
      if (existsSync(sidecar)) renameSync(sidecar, join(quarantine, `${basename(livePath)}${suffix}`))
    }
    fsyncRestoreDirectory(dirname(livePath))
    fsyncRestoreDirectory(quarantine)
    hooks?.afterSidecarQuarantine?.()

    // libuv rename replaces destination where supported; a Windows sharing
    // or AV lock throws, without exposing a partly copied live database.
    renameSync(candidatePath, livePath)
    fsyncRestoreDirectory(dirname(livePath))
    hooks?.afterAtomicInstall?.()
    marker = advanceRestoreMarker(marker, 'installed')
    hooks?.afterInstalledMarker?.()

    runIntegrityCheck()
    runPendingMigrations(getDatabase(), hooks?.migration)
    initializeFinishedGoodsValuationCutovers()
    runIntegrityCheck()
    verifyCurrentDatabase(getRawConnection(), loadMigrationBundle(getMigrationsFolder(), true))
    // Purge B's persisted remember-token hashes, so an OS file surviving an
    // unlink/power loss still cannot resume an A-epoch credential.
    getRawConnection().exec('DELETE FROM remember_tokens')
    clearRememberTokenFromDisk()
    fsyncRestoreDirectory(getConfigRoot())
    runIntegrityCheck()
    verifyCurrentDatabase(getRawConnection(), loadMigrationBundle(getMigrationsFolder(), true))
    hooks?.afterPostInstallVerification?.()
    destroyAllSessions()
    hooks?.afterSessionInvalidation?.()
    finalizeMigrationRecovery(getRawConnection())
    getRawConnection().pragma('wal_checkpoint(TRUNCATE)')
    closeDatabase()
    fsyncRestoreFile(livePath)
    fsyncRestoreDirectory(dirname(livePath))
    marker = advanceRestoreMarker(marker, 'verified', sha256RestoreFile(livePath))
    hooks?.afterVerifiedMarker?.()
    finishRestoreMarker(marker)

    runIntegrityCheck()
    runPendingMigrations(getDatabase())
    initializeFinishedGoodsValuationCutovers()
    runIntegrityCheck()

    try {
      // The initiating user belongs to A's identity epoch. Never attach that
      // numeric ID to a potentially different user in restored database B.
      recordAuditEvent({ action: 'backup.restore', entity: 'backup',
        entityId: input.backupFilePath, details: {
          safetyCopyPath,
          at: nowIso(),
          initiatedByPreviousEpoch: {
            id: ctx.session.user.id,
            username: ctx.session.user.username
          }
        } })
    } catch (error) {
      logger.error('Restore succeeded but its audit event could not be recorded', error)
    }
    return { restoredFrom: input.backupFilePath, safetyCopyPath }
  } catch (error) {
    if (error instanceof SimulatedRestoreInterruption) throw error
    closeDatabase()
    if (readRestoreMarker(livePath)) {
      let recovery: ReturnType<typeof recoverInterruptedRestore>
      try { recovery = recoverInterruptedRestore(livePath) }
      catch (recoveryError) {
        logger.error('Restore recovery failed; marker retained and IPC fails closed', recoveryError)
        throw new AppError('INTERNAL_ERROR', 'فشلت الاستعادة وتعذر تأكيد حالة قاعدة البيانات. أعد تشغيل التطبيق وراجع نسخة الأمان')
      }
      if (recovery.action === 'verified') {
        throw new AppError('INTERNAL_ERROR', 'الاستعادة تحققت وثُبتت، لكن إنهاءها تعثر. أعد تشغيل التطبيق قبل المتابعة')
      }
    } else if (marker?.phase === 'verified') {
      throw new AppError('INTERNAL_ERROR', 'قاعدة البيانات المستعادة تحققت، لكن إعادة فتحها تعثرت. أعد تشغيل التطبيق')
    } else {
      rmSync(candidatePath, { force: true })
      rmSync(snapshotTemporary, { force: true })
    }
    if (!marker && error instanceof AppError) {
      logger.warn('Restore stopped before its destructive transition', error)
      throw error
    }
    logger.error('Restore failed; protected pre-restore state recovered', error)
    throw new AppError('INTERNAL_ERROR', 'فشلت الاستعادة وأعيدت قاعدة البيانات السابقة من نسخة الأمان')
  } finally {
    releaseExclusive?.()
  }
}
