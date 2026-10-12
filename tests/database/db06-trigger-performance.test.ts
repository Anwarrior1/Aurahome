import Database from 'better-sqlite3'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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

function medianWriteMilliseconds(raw: Database.Database, rows = 5_000): number {
  const accountId = Number(raw.prepare("INSERT INTO cash_accounts (name, created_at) VALUES ('bench', '2026-09-16T00:00:00.000Z')").run().lastInsertRowid)
  const insert = raw.prepare(`INSERT INTO cash_transactions
    (account_id, direction, amount_minor, kind, occurred_at, created_at)
    VALUES (?, 'in', ?, 'balance_adjustment', '2026-09-16', '2026-09-16T00:00:00.000Z')`)
  const samples: number[] = []
  for (let round = 0; round < 5; round += 1) {
    const start = performance.now()
    raw.exec('BEGIN')
    for (let index = 0; index < rows; index += 1) insert.run(accountId, index + 1)
    raw.exec('ROLLBACK')
    samples.push(performance.now() - start)
  }
  return samples.sort((a, b) => a - b)[2]!
}

describe('DB-06 durable-guard performance', () => {
  it('keeps representative write overhead bounded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db06-performance-'))
    const baseline = new Database(':memory:')
    const guarded = new Database(':memory:')
    try {
      baseline.pragma('foreign_keys = ON')
      guarded.pragma('foreign_keys = ON')
      runMigrationsFromFolder(baseline, bundleBefore(dir, 49))
      runMigrationsFromFolder(guarded, FOLDER)

      const baselineMs = medianWriteMilliseconds(baseline)
      const guardedMs = medianWriteMilliseconds(guarded)
      const ratio = guardedMs / baselineMs
      console.info('DB06_TRIGGER_PERFORMANCE', { rows: 5_000, baselineMs, guardedMs, ratio })

      expect(ratio).toBeLessThan(2.5)
    } finally {
      baseline.close()
      guarded.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
