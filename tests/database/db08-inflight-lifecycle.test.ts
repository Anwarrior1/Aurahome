import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createHandler } from '@main/ipc/guard'
import { createBackup, validateBackup } from '@main/backup/backup.service'
import { restoreFromBackup } from '@main/restore/restore.service'
import {
  acquireRestoreExclusivity,
  admitRestoreProtectedOperation,
  captureRestoreGeneration,
  restoreLifecycleState
} from '@main/restore/restore-lifecycle'
import { readRestoreMarker } from '@main/restore/restore-recovery'
import { getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase } from '../helpers/test-db'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for lifecycle state')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

afterEach(() => {
  expect(restoreLifecycleState()).toEqual({
    generation: expect.any(Number), activeOperations: 0, restorePending: false
  })
})

describe('DB-08 in-flight restore lifecycle', () => {
  it('drains an admitted real backup before replacement and blocks new admission', async () => {
    const env = setupTestDatabase()
    const paused = deferred()
    const resume = deferred()
    try {
      createCustomer({ name: 'B-only customer' }, env.ctx)
      const restoreSource = await createBackup({
        destinationFilePath: join(env.dir, 'restore-source.aurabak'), includeConfig: false
      }, env.ctx)
      getRawConnection().prepare('DELETE FROM customers').run()
      createCustomer({ name: 'A-only customer' }, env.ctx)

      const backupHandler = createHandler(
        { permission: P.backup.create },
        (request: { destinationFilePath: string }, ctx) => createBackup(request, ctx, {
          afterSnapshotAsync: async () => { paused.resolve(); await resume.promise }
        })
      )
      const inFlightBackupPath = join(env.dir, 'admitted-a.aurabak')
      const inFlightBackup = backupHandler(
        { sender: { id: 1 } } as never,
        { destinationFilePath: inFlightBackupPath }
      )
      await paused.promise
      expect(restoreLifecycleState().activeOperations).toBe(1)

      const restoreHandler = createHandler(
        { permission: P.backup.restore, restoreExclusive: true },
        (request: { backupFilePath: string }, ctx) => restoreFromBackup(request, ctx)
      )
      let restoreSettled = false
      const restore = restoreHandler(
        { sender: { id: 1 } } as never,
        { backupFilePath: restoreSource.path }
      ).finally(() => { restoreSettled = true })
      await waitUntil(() => restoreLifecycleState().restorePending)

      expect(restoreSettled).toBe(false)
      expect(readRestoreMarker(getRawConnection().name)).toBeUndefined()
      let newlyAdmittedRan = false
      const blocked = await createHandler({}, () => { newlyAdmittedRan = true; return true })(
        { sender: { id: 99 } } as never, {}
      )
      expect(blocked).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      expect(newlyAdmittedRan).toBe(false)

      resume.resolve()
      expect(await inFlightBackup).toMatchObject({ ok: true })
      expect(await restore).toMatchObject({ ok: true })
      expect(existsSync(inFlightBackupPath)).toBe(true)
      expect(await validateBackup(inFlightBackupPath)).toMatchObject({ valid: true })
      expect((getRawConnection().prepare('SELECT name FROM customers').all() as Array<{ name: string }>))
        .toEqual([{ name: 'B-only customer' }])
    } finally {
      resume.resolve()
      env.cleanup()
    }
  })

  it('times out before marker publication when an admitted operation cannot drain', async () => {
    const env = setupTestDatabase()
    const paused = deferred()
    const resume = deferred()
    try {
      const restoreSource = await createBackup({
        destinationFilePath: join(env.dir, 'timeout-source.aurabak'), includeConfig: false
      }, env.ctx)
      createCustomer({ name: 'A-only customer' }, env.ctx)
      const pending = createHandler({}, async () => {
        paused.resolve()
        await resume.promise
        return true
      })({ sender: { id: 41 } } as never, {})
      await paused.promise
      const generation = captureRestoreGeneration()

      await expect(restoreFromBackup(
        { backupFilePath: restoreSource.path }, env.ctx, { lifecycleDrainTimeoutMs: 20 }
      )).rejects.toThrow(/تعذر بدء الاستعادة لأن عملية أخرى لم تنته بعد/)

      expect(restoreLifecycleState()).toMatchObject({
        activeOperations: 1, restorePending: false
      })
      expect(captureRestoreGeneration()).toBeGreaterThan(generation)
      expect(readRestoreMarker(getRawConnection().name)).toBeUndefined()
      expect((getRawConnection().prepare('SELECT name FROM customers').all() as Array<{ name: string }>))
        .toEqual([{ name: 'A-only customer' }])
      resume.resolve()
      expect(await pending).toMatchObject({ ok: true })
    } finally {
      resume.resolve()
      env.cleanup()
    }
  })

  it('keeps admission and release overhead bounded', async () => {
    const directIterations = 100_000
    const directStarted = performance.now()
    for (let index = 0; index < directIterations; index += 1) {
      admitRestoreProtectedOperation()()
    }
    const directElapsedMs = performance.now() - directStarted

    const exclusiveIterations = 5_000
    const exclusiveStarted = performance.now()
    for (let index = 0; index < exclusiveIterations; index += 1) {
      const release = await acquireRestoreExclusivity(captureRestoreGeneration())
      release()
    }
    const exclusiveElapsedMs = performance.now() - exclusiveStarted

    const iterations = 20_000
    const handler = createHandler({}, () => true)
    const started = performance.now()
    for (let index = 0; index < iterations; index += 1) {
      const result = await handler({ sender: { id: index + 1 } } as never, {})
      expect(result.ok).toBe(true)
    }
    const elapsedMs = performance.now() - started
    console.info('DB08_LIFECYCLE_PERFORMANCE', {
      directIterations,
      directElapsedMs,
      nanosecondsPerDirectAdmissionRelease: directElapsedMs * 1_000_000 / directIterations,
      exclusiveIterations,
      exclusiveElapsedMs,
      microsecondsPerExclusiveAcquireRelease: exclusiveElapsedMs * 1_000 / exclusiveIterations,
      guardedIterations: iterations,
      guardedElapsedMs: elapsedMs,
      microsecondsPerGuardedAdmission: elapsedMs * 1_000 / iterations
    })
    expect(directElapsedMs).toBeLessThan(250)
    expect(exclusiveElapsedMs).toBeLessThan(1_000)
    expect(elapsedMs).toBeLessThan(2_000)
  })
})
