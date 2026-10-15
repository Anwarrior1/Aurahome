import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrationsFromFolder } from '@main/migrations/migration-runner'
import { CANONICAL_MIGRATION_HISTORY, CURRENT_MIGRATION_INDEX } from '@main/migrations/migration-history'
import { loadMigrationBundle } from '@main/migrations/compatibility'

const FOLDER = 'drizzle/migrations/'
const BALANCE_PLAN = `
  EXPLAIN QUERY PLAN
  SELECT account_id,
    SUM(CASE WHEN direction = 'in' THEN amount_minor ELSE 0 END),
    SUM(CASE WHEN direction = 'out' THEN amount_minor ELSE 0 END),
    COUNT(*)
  FROM cash_transactions
  GROUP BY account_id
`

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

const plan = (raw: Database.Database) =>
  (raw.prepare(BALANCE_PLAN).all() as Array<{ detail: string }>).map((row) => row.detail).join(' ')

describe('0047 DB-16 cash balance covering index', () => {
  it('is appended to the pinned history without changing any released identity', () => {
    expect(CURRENT_MIGRATION_INDEX).toBe(53)
    expect(CANONICAL_MIGRATION_HISTORY[47]).toMatchObject({
      idx: 47,
      tag: '0047_db16_cash_balance_covering_index'
    })
    expect(CANONICAL_MIGRATION_HISTORY[46]).toMatchObject({
      idx: 46,
      hash: 'd570092b26f58bb53383252690ebbeb0ce06fdb29e55c69842e2f92360c05ddc'
    })
    expect(() => loadMigrationBundle(FOLDER, true)).not.toThrow()
  })

  it('upgrades a populated 0046 database, preserves every cash row, and covers balance aggregation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db16-upgrade-'))
    const raw = new Database(join(dir, 'upgrade.db'))
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, bundleBefore(dir, 47))
      raw.exec(`
        INSERT INTO cash_accounts (id, name, created_at) VALUES (1, 'cash', '2026-01-01T00:00:00.000Z');
        INSERT INTO cash_transactions (account_id, direction, amount_minor, kind, occurred_at, created_at)
          VALUES (1, 'out', 5, 'expense', '2026-01-01', '2026-01-01T00:00:00.000Z'),
                 (1, 'in', 7, 'balance_adjustment', '2026-01-02', '2026-01-02T00:00:00.000Z');
      `)
      const before = raw.prepare('SELECT * FROM cash_transactions ORDER BY id').all()
      expect(plan(raw)).toMatch(/USING INDEX cash_transactions_account_idx/)
      expect(plan(raw)).not.toMatch(/COVERING INDEX cash_transactions_account_idx/)

      runMigrationsFromFolder(raw, FOLDER)

      expect(raw.prepare('SELECT * FROM cash_transactions ORDER BY id').all()).toEqual(before)
      expect(
        (raw.pragma("index_xinfo('cash_transactions_account_idx')") as Array<{ key: number; name: string }> )
          .filter((column) => column.key === 1)
          .map((column) => column.name)
      ).toEqual(['account_id', 'occurred_at', 'direction', 'amount_minor'])
      expect(plan(raw)).toMatch(/USING COVERING INDEX cash_transactions_account_idx/)
      expect(raw.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get()).toEqual({ c: 54 })
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])
    } finally {
      raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
