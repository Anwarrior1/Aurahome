import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrationsFromFolder } from '@main/migrations/migration-runner'
import { CANONICAL_MIGRATION_HISTORY, CURRENT_MIGRATION_INDEX } from '@main/migrations/migration-history'
import { loadMigrationBundle } from '@main/migrations/compatibility'
import { REQUIRED_APPLICATION_INDEXES } from '@main/migrations/current-schema-identity'

const FOLDER = 'drizzle/migrations/'
const LOOKUP = "EXPLAIN QUERY PLAN SELECT id FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = 1"

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
const plan = (raw: Database.Database) => (raw.prepare(LOOKUP).all() as Array<{ detail: string }>).map((row) => row.detail).join(' ')

describe('0046 DB-13 cash mirror reference index', () => {
  it('remains unchanged in the pinned history after later migrations', () => {
    expect(CURRENT_MIGRATION_INDEX).toBe(53)
    expect(CANONICAL_MIGRATION_HISTORY[46]).toMatchObject({
      idx: 46,
      tag: '0046_db13_cash_mirror_ref_index',
      hash: 'd570092b26f58bb53383252690ebbeb0ce06fdb29e55c69842e2f92360c05ddc'
    })
    expect(CANONICAL_MIGRATION_HISTORY[45]).toMatchObject({ idx: 45, hash: '68996ce0ff203be75862deb3ac46d800a200213abdd7a290221c306cde221846' })
    expect(REQUIRED_APPLICATION_INDEXES).toContain('cash_transactions_ref_idx')
    expect(() => loadMigrationBundle(FOLDER, true)).not.toThrow()
  })

  it.each([45, 44, 41])('upgrades a populated database at migration %i, preserves every cash row, and serves mirror lookups by index', (idx) => {
    const dir = mkdtempSync(join(tmpdir(), 'db13-upgrade-'))
    const raw = new Database(join(dir, 'upgrade.db'))
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, bundleBefore(dir, idx))
      raw.exec(`
        INSERT INTO cash_accounts (id, name, created_at) VALUES (1, 'cash', '2026-01-01T00:00:00.000Z');
        INSERT INTO cash_transactions (account_id, direction, amount_minor, kind, ref_table, ref_id, occurred_at, created_at)
          VALUES (1, 'out', 5, 'expense', 'expenses', 1, '2026-01-01', '2026-01-01T00:00:00.000Z'),
                 (1, 'in', 7, 'balance_adjustment', NULL, NULL, '2026-01-02', '2026-01-02T00:00:00.000Z');
      `)
      const before = raw.prepare('SELECT * FROM cash_transactions ORDER BY id').all()
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'cash_transactions_ref_idx'").get()).toBeUndefined()
      expect(plan(raw)).toMatch(/SCAN cash_transactions/)

      runMigrationsFromFolder(raw, FOLDER)
      expect(raw.prepare('SELECT * FROM cash_transactions ORDER BY id').all()).toEqual(before)
      expect(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'cash_transactions_ref_idx'").get()).toEqual({
        sql: 'CREATE INDEX `cash_transactions_ref_idx` ON `cash_transactions` (`ref_table`,`ref_id`)'
      })
      expect(plan(raw)).toMatch(/USING (COVERING )?INDEX cash_transactions_ref_idx \(ref_table=\? AND ref_id=\?\)/)
      expect(raw.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get()).toEqual({ c: 54 })
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])
    } finally {
      raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
