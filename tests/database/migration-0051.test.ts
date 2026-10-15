import Database from 'better-sqlite3'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openVerifiedDatabase } from '@main/app/database-startup'
import { closeDatabase, setDatabasePath } from '@main/db/connection'
import { loadMigrationBundle } from '@main/migrations/compatibility'
import { CANONICAL_MIGRATION_HISTORY, CURRENT_MIGRATION_INDEX } from '@main/migrations/migration-history'
import { REQUIRED_APPLICATION_INDEXES } from '@main/migrations/current-schema-identity'
import { runMigrationsFromFolder } from '@main/migrations/migration-runner'

const FOLDER = 'drizzle/migrations/'

function bundleBefore(dir: string, idx: number): string {
  const previous = join(dir, 'previous')
  mkdirSync(join(previous, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(`${FOLDER}meta/_journal.json`, 'utf8'))
  writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify({
    ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < idx)
  }))
  for (const file of readdirSync(FOLDER).filter((file) => file.endsWith('.sql') && file < String(idx).padStart(4, '0')))
    copyFileSync(`${FOLDER}${file}`, join(previous, file))
  return previous
}

describe('0051 CC04 worker commission earning ↔ assignment link', () => {
  it('appends one pinned migration and requires the exactly-once earning index', () => {
    expect(CURRENT_MIGRATION_INDEX).toBe(53)
    expect(CANONICAL_MIGRATION_HISTORY[51]).toMatchObject({ idx: 51, tag: '0051_cc04_worker_commission_assignment_link' })
    expect(CANONICAL_MIGRATION_HISTORY[50]).toMatchObject({
      idx: 50,
      tag: '0050_cc03_username_unique_among_live_users',
      hash: '2019129596fc53fbbe2649e6e7725bb5d0929bc37b18d16749c0074bfa5c8e8c'
    })
    expect(REQUIRED_APPLICATION_INDEXES).toContain('worker_transactions_assignment_earning_unique')
    expect(() => loadMigrationBundle(FOLDER, true)).not.toThrow()
  })

  it('upgrades a populated 0050 database: historical worker rows unchanged and unlinked, balances unreinterpreted, one earning per assignment enforced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc04-upgrade-'))
    const dbPath = join(dir, 'upgrade.db')
    const raw = new Database(dbPath)
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, bundleBefore(dir, 51))
      raw.exec(`
        INSERT INTO customers (id, name, created_at) VALUES (1, 'CC04', '2026-09-17T00:00:00.000Z');
        INSERT INTO orders (id, document_number, customer_id, status, created_at) VALUES (1, 'CC04-ORD', 1, 'completed', '2026-09-17T00:00:00.000Z');
        INSERT INTO workers (id, name, created_at) VALUES (1, 'legacy worker', '2026-09-17T00:00:00.000Z');
        INSERT INTO order_worker_assignments (id, order_id, worker_id, method, amount_minor, earned) VALUES (1, 1, 1, 'fixed', 200000, 1);
        INSERT INTO worker_transactions (id, worker_id, kind, amount_minor, order_id, created_at) VALUES
          (1, 1, 'earning', 200000, 1, '2026-09-10T00:00:00.000Z'),
          (2, 1, 'withdrawal', 50000, NULL, '2026-09-11T00:00:00.000Z'),
          (3, 1, 'adjustment', -200000, 1, '2026-09-12T00:00:00.000Z');
      `)
      const before = raw.prepare('SELECT * FROM worker_transactions ORDER BY id').all() as Array<Record<string, unknown>>
      raw.close()

      setDatabasePath(dbPath)
      openVerifiedDatabase()
      closeDatabase()

      const verified = new Database(dbPath)
      try {
        verified.pragma('foreign_keys = ON')
        expect(verified.prepare('SELECT * FROM worker_transactions ORDER BY id').all()).toEqual(before.map((row) => ({ ...row, assignment_id: null })))
        expect(verified.prepare("SELECT sql FROM sqlite_master WHERE name = 'worker_transactions_assignment_earning_unique'").get())
          .toEqual({ sql: 'CREATE UNIQUE INDEX `worker_transactions_assignment_earning_unique` ON `worker_transactions` (`assignment_id`) WHERE "worker_transactions"."assignment_id" IS NOT NULL' })
        const link = verified.prepare("INSERT INTO worker_transactions (worker_id, kind, amount_minor, assignment_id, created_at) VALUES (1, 'earning', 1000, 1, '2026-09-17T00:00:00.000Z')")
        link.run()
        expect(() => link.run()).toThrow(/UNIQUE/)
        expect(() => verified.prepare("INSERT INTO worker_transactions (worker_id, kind, amount_minor, assignment_id, created_at) VALUES (1, 'earning', 1, 999, '2026-09-17T00:00:00.000Z')").run()).toThrow(/FOREIGN KEY/)
        expect(verified.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get()).toEqual({ c: 54 })
        expect(verified.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
        expect(verified.pragma('foreign_key_check')).toEqual([])
      } finally {
        verified.close()
      }
    } finally {
      if (raw.open) raw.close()
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
