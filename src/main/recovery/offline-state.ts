import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, rename, stat, statfs } from 'node:fs/promises'
import { createReadStream, lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const TUPLE = ['erp.db', 'erp.db-wal', 'erp.db-shm'] as const
export type RecoveryState =
  | 'candidate_validated' | 'exception_authorized' | 'preservation_started'
  | 'preservation_verified' | 'replacement_staged' | 'activation_pending' | 'activation_in_progress'
  | 'replacement_activated' | 'validation_pending' | 'review_pending'
  | 'complete' | 'rollback_pending' | 'failed'

export interface PreservedFile {
  name: typeof TUPLE[number]
  present: boolean
  size?: number
  sha256?: string
}

export interface PreservationReceipt { files: PreservedFile[] }

interface Hold { version: 1; operationId: string }
interface Journal {
  version: 1
  operationId: string
  state: RecoveryState
  archiveSha256: string
  financialReviewApproved: boolean
}

const STATES = new Set<RecoveryState>([
  'candidate_validated', 'exception_authorized', 'preservation_started',
  'preservation_verified', 'replacement_staged', 'activation_pending', 'activation_in_progress',
  'replacement_activated', 'validation_pending', 'review_pending',
  'complete', 'rollback_pending', 'failed'
])

function parseState(path: string): Record<string, unknown> | undefined {
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 64 * 1024) return undefined
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

function pathPresent(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    // Permission or I/O uncertainty is suspicious, never a clean absence.
    return true
  }
}

/** Must run before the ordinary database is opened. Absence is normal only when both files are absent. */
export function evaluateRecoveryAdmission(root: string): { allowed: boolean; reason: string } {
  try {
    const directory = lstatSync(root)
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      return { allowed: false, reason: 'unsafe-recovery-directory' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { allowed: false, reason: 'unreadable-recovery-directory' }
    }
  }
  const holdPath = join(root, 'hold.json')
  const journalPath = join(root, 'journal.json')
  const holdExists = pathPresent(holdPath)
  const journalExists = pathPresent(journalPath)
  if (!holdExists && !journalExists) return { allowed: true, reason: 'no-recovery' }
  if (!holdExists || !journalExists) return { allowed: false, reason: 'incomplete-recovery-state' }
  const hold = parseState(holdPath) as Hold | undefined
  const journal = parseState(journalPath) as Journal | undefined
  if (!hold || !journal || hold.version !== 1 || journal.version !== 1 ||
      typeof hold.operationId !== 'string' || !hold.operationId ||
      hold.operationId !== journal.operationId || !STATES.has(journal.state)) {
    return { allowed: false, reason: 'invalid-recovery-state' }
  }
  // Phase 2B has no Windows-qualified owner review release path yet. Even a
  // syntactically complete journal must not admit normal business startup.
  return { allowed: false, reason: journal.state }
}

/** Planned transitions only. Metadata does not activate files or release the startup hold. */
export const plannedRecoveryTransitions = {
  candidate_validated: ['exception_authorized', 'failed'],
  exception_authorized: ['preservation_started', 'failed'],
  preservation_started: ['preservation_verified', 'failed'],
  preservation_verified: ['replacement_staged', 'failed'],
  replacement_staged: ['activation_pending', 'failed'],
  activation_pending: ['activation_in_progress', 'failed'],
  activation_in_progress: ['replacement_activated', 'rollback_pending', 'failed'],
  replacement_activated: ['validation_pending', 'rollback_pending', 'failed'],
  validation_pending: ['review_pending', 'rollback_pending', 'failed'],
  review_pending: ['complete', 'rollback_pending', 'failed'],
  complete: [], rollback_pending: ['failed'], failed: []
} as const satisfies Record<RecoveryState, readonly RecoveryState[]>

export function isPlannedRecoveryTransition(current: RecoveryState, next: RecoveryState): boolean {
  return (plannedRecoveryTransitions[current] as readonly RecoveryState[]).includes(next)
}

async function publishJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.incomplete`
  const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
  await rename(temp, path)
  await syncDirectory(join(path, '..'))
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try { await directory.sync() } catch (error) {
    // Windows does not permit FlushFileBuffers on a directory handle.
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  } finally { await directory.close() }
}

/** Publish the blocking marker first; a crash between the two writes remains blocked. */
export async function beginRecoveryHold(root: string, operationId: string, archiveSha256: string): Promise<void> {
  if (!operationId || !/^[a-f0-9]{64}$/.test(archiveSha256)) throw new Error('Invalid recovery identity')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await lstat(root)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe recovery directory')
  if (pathPresent(join(root, 'hold.json')) || pathPresent(join(root, 'journal.json'))) {
    throw new Error('A recovery operation already exists')
  }
  await publishJson(join(root, 'hold.json'), { version: 1, operationId } satisfies Hold)
  await publishJson(join(root, 'journal.json'), {
    version: 1, operationId, state: 'exception_authorized', archiveSha256, financialReviewApproved: false
  } satisfies Journal)
}

export async function advanceRecoveryState(
  root: string, operationId: string, state: RecoveryState
): Promise<void> {
  const hold = parseState(join(root, 'hold.json')) as Hold | undefined
  const current = parseState(join(root, 'journal.json')) as Journal | undefined
  if (!hold || !current || hold.version !== 1 || current.version !== 1 ||
      hold.operationId !== operationId || current.operationId !== operationId ||
      !/^[a-f0-9]{64}$/.test(current.archiveSha256) || !STATES.has(current.state)) {
    throw new Error('Recovery state is incomplete or contradictory')
  }
  if (state === 'complete') throw new Error('Financial review release is not implemented')
  if (!isPlannedRecoveryTransition(current.state, state)) throw new Error('Invalid recovery transition')
  await publishJson(join(root, 'journal.json'), {
    ...current, state, financialReviewApproved: false
  } satisfies Journal)
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function sameIdentity(a: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  b: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

/** A preflight only; a later copy error still aborts without activation. */
export function hasPreservationCapacity(requiredBytes: bigint, availableBytes: bigint): boolean {
  return requiredBytes >= 0n && availableBytes >= requiredBytes
}

/** Raw, no-replace tuple capture. Caller must establish exclusive ownership first. */
export async function preserveOriginalTuple(
  dataRoot: string, retentionRoot: string,
  hooks: { afterCopy?: (name: typeof TUPLE[number]) => void; beforeFlush?: (name: typeof TUPLE[number]) => void } = {}
): Promise<PreservationReceipt> {
  let requiredBytes = 0n
  for (const name of TUPLE) {
    let entry
    try { entry = await lstat(join(dataRoot, name)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || name === 'erp.db') throw error
      continue
    }
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Unsafe original file: ${name}`)
    requiredBytes += BigInt(entry.size)
  }
  const available = await statfs(dirname(retentionRoot), { bigint: true })
  if (!hasPreservationCapacity(requiredBytes, available.bavail * available.bsize)) {
    throw new Error('Insufficient space to preserve original database tuple')
  }
  await mkdir(retentionRoot, { recursive: false, mode: 0o700 })
  const files: PreservedFile[] = []
  for (const name of TUPLE) {
    const source = join(dataRoot, name)
    const destination = join(retentionRoot, name)
    let before
    try { before = await lstat(source) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || name === 'erp.db') throw error
      files.push({ name, present: false })
      continue
    }
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Unsafe original file: ${name}`)
    const sourceHashBefore = await sha256File(source)
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    hooks.afterCopy?.(name)
    const copied = await lstat(destination)
    if (!copied.isFile() || copied.isSymbolicLink()) throw new Error(`Unsafe retained file: ${name}`)
    const retainedHash = await sha256File(destination)
    const sourceHashAfter = await sha256File(source)
    const after = await lstat(source)
    if (!sameIdentity(before, after) || sourceHashBefore !== sourceHashAfter ||
        sourceHashBefore !== retainedHash || copied.size !== before.size) {
      throw new Error(`Original file changed during preservation: ${name}`)
    }
    const handle = await open(destination, 'r+')
    try { hooks.beforeFlush?.(name); await handle.sync() } finally { await handle.close() }
    files.push({ name, present: true, size: before.size, sha256: retainedHash })
  }
  for (const entry of files.filter((item) => !item.present)) {
    try { await stat(join(dataRoot, entry.name)); throw new Error(`Sidecar appeared during preservation: ${entry.name}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await syncDirectory(retentionRoot)
  return { files }
}
