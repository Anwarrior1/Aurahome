import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import {
  closeDatabase,
  getDatabase,
  getRawConnection,
  setDatabasePath
} from '@main/db/connection'
import { runMigrationsFromFolder, runPendingMigrations } from '@main/migrations/migration-runner'
import { finalizeMigrationRecovery, readMigrationRecoveryMarker } from '@main/migrations/migration-recovery'

const MIGRATIONS = resolve('drizzle/migrations')
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
  version: string
  dialect: string
  entries: Array<{ idx: number; tag: string }>
}

afterEach(() => {
  closeDatabase()
  setDatabasePath(undefined)
})

function prefixFolder(dir: string, throughIdx: number): string {
  const folder = join(dir, 'migrations')
  mkdirSync(join(folder, 'meta'), { recursive: true })
  const entries = journal.entries.filter(({ idx }) => idx <= throughIdx)
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  return folder
}

describe('DB-07 realistic migration measurement', () => {
  it('measures recovery, DB-03-era upgrade, and full verification on 100,000 business rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-db07-performance-'))
    const databasePath = join(dir, 'erp.db')
    try {
      setDatabasePath(databasePath)
      const raw = getRawConnection()
      runMigrationsFromFolder(raw, prefixFolder(dir, 40))
      const insertCustomer = raw.prepare('INSERT INTO customers (name, created_at) VALUES (?, ?)')
      const insertExpense = raw.prepare(
        "INSERT INTO expenses (kind, amount_minor, description, spent_at, created_at) VALUES ('variable', ?, ?, '2026-01-01', ?)"
      )
      raw.transaction(() => {
        for (let index = 0; index < 50_000; index += 1) {
          insertCustomer.run(`Migration customer ${index}`, '2026-01-01')
          insertExpense.run(index + 1, `Migration expense ${index}`, '2026-01-01')
        }
      })()
      raw.pragma('wal_checkpoint(TRUNCATE)')

      const sizeBeforeBytes = statSync(databasePath).size
      const rssBeforeBytes = process.memoryUsage().rss
      let snapshotStartedAt = 0
      let snapshotCompletedAt = 0
      let migrationCommittedAt = 0
      let verificationCompletedAt = 0
      const startedAt = performance.now()
      runPendingMigrations(getDatabase(), {
        beforeRecoveryPreparation: () => {
          snapshotStartedAt = performance.now()
        },
        afterRecoveryPrepared: () => {
          snapshotCompletedAt = performance.now()
        },
        afterMigrationCommitted: () => {
          migrationCommittedAt = performance.now()
        },
        afterStructuralVerification: () => {
          verificationCompletedAt = performance.now()
        }
      })
      const completedAt = performance.now()
      const marker = readMigrationRecoveryMarker(databasePath)
      const measurement = {
        databaseSizeBytes: sizeBeforeBytes,
        customers: 50_000,
        expenses: 50_000,
        totalRowsSeeded: 100_000,
        compatibilityAndHistoricalStructureMs: Number((snapshotStartedAt - startedAt).toFixed(1)),
        recoverySnapshotMs: Number((snapshotCompletedAt - snapshotStartedAt).toFixed(1)),
        migrationMs: Number((migrationCommittedAt - snapshotCompletedAt).toFixed(1)),
        postMigrationVerificationMs: Number((verificationCompletedAt - migrationCommittedAt).toFixed(1)),
        totalUpgradeMs: Number((completedAt - startedAt).toFixed(1)),
        rssBeforeBytes,
        rssAfterBytes: process.memoryUsage().rss,
        processMaxRssKilobytes: process.resourceUsage().maxRSS
      }
      console.info(`DB07_PERFORMANCE ${JSON.stringify(measurement)}`)

      expect(marker?.phase).toBe('verified')
      expect(marker?.version).toBe(2)
      expect(raw.prepare('SELECT COUNT(*) AS count FROM customers').get()).toEqual({ count: 50_000 })
      expect(raw.prepare('SELECT COUNT(*) AS count FROM expenses').get()).toEqual({ count: 50_000 })
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])
      finalizeMigrationRecovery(raw)
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
