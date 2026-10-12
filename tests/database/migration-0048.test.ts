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
const CANDIDATE = 'final_invoice_terms_invoice_idx'
const RETAINED = 'final_invoice_terms_unique'

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
  (raw.prepare('EXPLAIN QUERY PLAN SELECT * FROM final_invoice_terms WHERE final_invoice_id = 1 ORDER BY term_index').all() as Array<{ detail: string }>)
    .map(({ detail }) => detail)
    .join(' ')

describe('0048 DB-17 redundant final-invoice-terms index removal', () => {
  it('appends one pinned migration and removes the candidate from the current structural contract', () => {
    expect(CURRENT_MIGRATION_INDEX).toBe(52)
    expect(CANONICAL_MIGRATION_HISTORY[48]).toMatchObject({
      idx: 48,
      tag: '0048_db17_remove_redundant_invoice_terms_index'
    })
    expect(CANONICAL_MIGRATION_HISTORY[47]).toMatchObject({
      idx: 47,
      tag: '0047_db16_cash_balance_covering_index',
      hash: '4fe633a014b7f0b38a2ec1566a26a533e034c816f492f9302169c7916078a7ae'
    })
    expect(REQUIRED_APPLICATION_INDEXES).not.toContain(CANDIDATE)
    expect(REQUIRED_APPLICATION_INDEXES).toContain(RETAINED)
    expect(() => loadMigrationBundle(FOLDER, true)).not.toThrow()
  })

  it('upgrades a populated 0047 database through openVerifiedDatabase and preserves rows and uniqueness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db17-upgrade-'))
    const dbPath = join(dir, 'upgrade.db')
    const raw = new Database(dbPath)
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, bundleBefore(dir, 48))
      raw.exec(`
        INSERT INTO customers (id, name, created_at) VALUES (1, 'DB17', '2026-09-16T00:00:00.000Z');
        INSERT INTO final_invoices (id, document_number, customer_id, status, created_at)
          VALUES (1, 'DB17-1', 1, 'draft', '2026-09-16T00:00:00.000Z');
        INSERT INTO final_invoice_terms (final_invoice_id, term_index, term_text, created_at)
          VALUES (1, 1, 'one', '2026-09-16T00:00:00.000Z'),
                 (1, 2, 'two', '2026-09-16T00:00:00.000Z');
      `)
      const before = raw.prepare('SELECT * FROM final_invoice_terms ORDER BY id').all()
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(CANDIDATE)).toBeDefined()
      raw.close()

      setDatabasePath(dbPath)
      openVerifiedDatabase()
      closeDatabase()

      const verified = new Database(dbPath)
      try {
        verified.pragma('foreign_keys = ON')
        expect(verified.prepare('SELECT * FROM final_invoice_terms ORDER BY id').all()).toEqual(before)
        expect(verified.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(CANDIDATE)).toBeUndefined()
        expect(plan(verified)).toMatch(/USING INDEX final_invoice_terms_unique/)
        expect(() => verified.prepare(`INSERT INTO final_invoice_terms
          (final_invoice_id, term_index, term_text, created_at)
          VALUES (1, 1, 'duplicate', '2026-09-16T00:00:00.000Z')`).run()).toThrow(/UNIQUE/)
        expect(verified.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get()).toEqual({ c: 53 })
        expect(verified.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
        expect(verified.pragma('foreign_key_check')).toEqual([])
      } finally {
        verified.close()
      }

      setDatabasePath(dbPath)
      openVerifiedDatabase()
      closeDatabase()
    } finally {
      if (raw.open) raw.close()
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
