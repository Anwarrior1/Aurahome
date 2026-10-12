import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { advanceRecoveryState, beginRecoveryHold, evaluateRecoveryAdmission, preserveOriginalTuple,
  type RecoveryState } from '../../src/main/recovery/offline-state'

// This harness owns its mkdtemp root. No caller-supplied destination or production activation path exists.
const STEPS: RecoveryState[] = [
  'exception_authorized', 'preservation_started', 'preservation_verified', 'replacement_staged',
  'activation_pending', 'activation_in_progress', 'replacement_activated', 'validation_pending', 'review_pending'
]
const TUPLE = ['erp.db', 'erp.db-wal', 'erp.db-shm'] as const
const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }

async function syntheticCase(stopAt: RecoveryState) {
  const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-synthetic-')); roots.push(root)
  writeFileSync(join(root, '.fictional-only'), 'AURA test fixture')
  const data = join(root, 'data'); const candidate = join(root, 'candidate.db')
  const retention = join(root, 'retention'); const staged = join(root, 'staged')
  const quarantine = join(root, 'quarantine'); const attempted = join(root, 'attempted.db')
  mkdirSync(data)
  writeFileSync(join(data, 'erp.db'), 'corrupt fictional database')
  writeFileSync(join(data, 'erp.db-wal'), Buffer.from([1, 2, 3, 4]))
  writeFileSync(join(data, 'erp.db-shm'), Buffer.from([5, 6, 7, 8]))
  const originalHashes = Object.fromEntries(TUPLE.map((name) => [name, hash(join(data, name))]))
  const db = new Database(candidate)
  db.exec('CREATE TABLE fictional (id INTEGER PRIMARY KEY, amount_minor INTEGER); INSERT INTO fictional VALUES (1, 50000)')
  db.close()
  const candidateHash = hash(candidate)
  const hold = join(root, 'recovery')
  await beginRecoveryHold(hold, 'synthetic-case', 'a'.repeat(64))
  if (stopAt !== STEPS[0]) {
    await advanceRecoveryState(hold, 'synthetic-case', 'preservation_started')
    if (stopAt !== 'preservation_started') {
      const receipt = await preserveOriginalTuple(data, retention)
      expect(receipt.files.map((file) => file.present)).toEqual([true, true, true])
      await advanceRecoveryState(hold, 'synthetic-case', 'preservation_verified')
      if (stopAt !== 'preservation_verified') {
        mkdirSync(staged); copyFileSync(candidate, join(staged, 'erp.db'))
        await advanceRecoveryState(hold, 'synthetic-case', 'replacement_staged')
        if (stopAt !== 'replacement_staged') {
          await advanceRecoveryState(hold, 'synthetic-case', 'activation_pending')
          if (stopAt !== 'activation_pending') {
            await advanceRecoveryState(hold, 'synthetic-case', 'activation_in_progress')
            if (stopAt !== 'activation_in_progress') {
              mkdirSync(quarantine)
              for (const name of TUPLE) renameSync(join(data, name), join(quarantine, name))
              renameSync(join(staged, 'erp.db'), join(data, 'erp.db'))
              await advanceRecoveryState(hold, 'synthetic-case', 'replacement_activated')
              if (stopAt !== 'replacement_activated') {
                await advanceRecoveryState(hold, 'synthetic-case', 'validation_pending')
                if (stopAt === 'review_pending') await advanceRecoveryState(hold, 'synthetic-case', 'review_pending')
              }
            }
          }
        }
      }
    }
  }
  return { root, data, candidate, candidateHash, retention, quarantine, attempted, hold, originalHashes }
}

async function syntheticRollback(f: Awaited<ReturnType<typeof syntheticCase>>): Promise<void> {
  if (!f.root.startsWith(join(tmpdir(), 'aura-bdr01-synthetic-')) ||
      !existsSync(join(f.root, '.fictional-only')) || !existsSync(join(f.retention, 'erp.db')) ||
      f.data !== join(f.root, 'data') || f.retention !== join(f.root, 'retention') ||
      f.quarantine !== join(f.root, 'quarantine') || f.attempted !== join(f.root, 'attempted.db') ||
      f.hold !== join(f.root, 'recovery')) {
    throw new Error('Refusing rollback outside an initialized fictional test root')
  }
  await advanceRecoveryState(f.hold, 'synthetic-case', 'rollback_pending')
  if (existsSync(join(f.data, 'erp.db')) && hash(join(f.data, 'erp.db')) === f.candidateHash) {
    copyFileSync(join(f.data, 'erp.db'), f.attempted)
  }
  for (const name of TUPLE) {
    if (hash(join(f.retention, name)) !== f.originalHashes[name]) throw new Error('Retained original changed')
    copyFileSync(join(f.retention, name), join(f.data, name))
  }
  await advanceRecoveryState(f.hold, 'synthetic-case', 'failed')
}

describe('test-only synthetic activation/interruption/rollback', () => {
  it.each(STEPS)('blocks AURA startup after interruption at %s', async (state) => {
    const f = await syntheticCase(state)
    expect(evaluateRecoveryAdmission(f.hold).allowed).toBe(false)
    if (STEPS.indexOf(state) >= STEPS.indexOf('preservation_verified')) {
      for (const name of TUPLE) expect(hash(join(f.retention, name))).toBe(f.originalHashes[name])
    } else for (const name of TUPLE) expect(hash(join(f.data, name))).toBe(f.originalHashes[name])
    await expect(advanceRecoveryState(f.hold, 'synthetic-case', 'complete')).rejects.toThrow()
  })

  it('restores fictional original bytes after simulated activation while retaining both versions', async () => {
    const f = await syntheticCase('review_pending')
    expect(hash(join(f.data, 'erp.db'))).toBe(f.candidateHash)
    await syntheticRollback(f)
    for (const name of TUPLE) {
      expect(hash(join(f.data, name))).toBe(f.originalHashes[name])
      expect(hash(join(f.retention, name))).toBe(f.originalHashes[name])
      expect(hash(join(f.quarantine, name))).toBe(f.originalHashes[name])
    }
    expect(hash(f.attempted)).toBe(f.candidateHash)
    expect(JSON.parse(readFileSync(join(f.hold, 'journal.json'), 'utf8')).state).toBe('failed')
    expect(evaluateRecoveryAdmission(f.hold).allowed).toBe(false)
  })

  it('resumes a synthetic pending stage after restart without clearing the hold', async () => {
    const f = await syntheticCase('activation_pending')
    expect(hash(join(f.root, 'staged', 'erp.db'))).toBe(f.candidateHash)
    await advanceRecoveryState(f.hold, 'synthetic-case', 'activation_in_progress')
    mkdirSync(f.quarantine)
    for (const name of TUPLE) renameSync(join(f.data, name), join(f.quarantine, name))
    renameSync(join(f.root, 'staged', 'erp.db'), join(f.data, 'erp.db'))
    await advanceRecoveryState(f.hold, 'synthetic-case', 'replacement_activated')
    expect(hash(join(f.data, 'erp.db'))).toBe(f.candidateHash)
    expect(evaluateRecoveryAdmission(f.hold).allowed).toBe(false)
    for (const name of TUPLE) expect(hash(join(f.retention, name))).toBe(f.originalHashes[name])
  })

  it('recovers a synthetic mid-tuple interruption from retained copies, keeping quarantine evidence', async () => {
    const f = await syntheticCase('activation_in_progress')
    mkdirSync(f.quarantine)
    renameSync(join(f.data, 'erp.db'), join(f.quarantine, 'erp.db'))
    expect(evaluateRecoveryAdmission(f.hold).allowed).toBe(false)
    await syntheticRollback(f)
    for (const name of TUPLE) expect(hash(join(f.data, name))).toBe(f.originalHashes[name])
    expect(hash(join(f.quarantine, 'erp.db'))).toBe(f.originalHashes['erp.db'])
    expect(evaluateRecoveryAdmission(f.hold).allowed).toBe(false)
  })

  it('rejects any rollback without the created fictional root marker', async () => {
    const f = await syntheticCase('preservation_verified')
    writeFileSync(join(f.root, '.fictional-only'), '')
    await expect(syntheticRollback({ ...f, root: '/Users/real-aura-data' })).rejects.toThrow(/fictional test root/)
    await expect(syntheticRollback({ ...f, data: join(f.root, 'wrong') })).rejects.toThrow(/fictional test root/)
  })
})
