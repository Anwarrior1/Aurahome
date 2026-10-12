import { describe, it } from 'vitest'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createBackup, validateBackup } from '@main/backup/backup.service'
import { getRawConnection } from '@main/db/connection'
import { setupTestDatabase } from '../helpers/test-db'

describe('DB-09 bounded scale benchmark', () => {
  for (const mib of [8, 32, 64]) it(`${mib} MiB incompressible fixture`, async () => {
    const env = setupTestDatabase()
    try {
      const raw = getRawConnection()
      raw.exec('CREATE TABLE db09_fixture (payload BLOB NOT NULL)')
      const insert = raw.prepare('INSERT INTO db09_fixture VALUES (randomblob(1048576))')
      for (let index = 0; index < mib; index += 1) insert.run()
      raw.pragma('wal_checkpoint(TRUNCATE)')
      const probeDir = join(env.dir, 'baseline')
      mkdirSync(probeDir)
      const snapshot = join(probeDir, 'standalone.db')
      const snapshotStart = performance.now()
      raw.prepare('VACUUM INTO ?').run(snapshot)
      const snapshotMs = performance.now() - snapshotStart
      rmSync(snapshot)
      if (global.gc) global.gc()
      const rssBefore = process.memoryUsage().rss
      let peakRss = rssBefore
      let maxEventLoopLagMs = 0
      let expectedTick = performance.now() + 10
      const timer = setInterval(() => {
        const now = performance.now()
        maxEventLoopLagMs = Math.max(maxEventLoopLagMs, now - expectedTick)
        expectedTick = now + 10
        peakRss = Math.max(peakRss, process.memoryUsage().rss)
      }, 10)
      const archive = join(probeDir, 'baseline.aurabak')
      const times: Record<string, number> = {}
      const createStart = performance.now()
      await createBackup({ destinationFilePath: archive, includeConfig: false }, env.ctx, {
        afterSnapshot: () => { times.snapshotDone = performance.now() },
        duringArchive: () => { times.archiveStart = performance.now() },
        duringValidation: () => { times.validationStart = performance.now() },
        beforePublication: () => { times.validationDone = performance.now() }
      })
      const createMs = performance.now() - createStart
      const rssAfterCreate = process.memoryUsage().rss
      const validateStart = performance.now()
      const validation = await validateBackup(archive)
      const validateMs = performance.now() - validateStart
      const rssAfterValidate = process.memoryUsage().rss
      await new Promise((resolve) => setImmediate(resolve))
      clearInterval(timer)
      console.log(JSON.stringify({ fixtureMiB: mib, snapshotBytes: statSync(archive).size > 0 ? statSync(join(raw.name)).size : 0,
        archiveBytes: statSync(archive).size, standaloneSnapshotMs: snapshotMs,
        snapshotMs: times.snapshotDone - createStart, hashAndManifestMs: times.archiveStart - times.snapshotDone,
        compressionMs: times.validationStart - times.archiveStart,
        internalValidationMs: times.validationDone - times.validationStart,
        createMs, externalValidationMs: validateMs, valid: validation.valid,
        rssBefore, peakRss, rssAfterCreate, rssAfterValidate, memoryDelta: peakRss - rssBefore, maxEventLoopLagMs }))
    } finally { env.cleanup() }
  }, 120_000)
})
