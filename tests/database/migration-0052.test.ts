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

describe('0052 BL-03 resale-preparation expense ↔ Uncollected Product link', () => {
  it('appends one pinned migration after 0051 and requires its index', () => {
    expect(CURRENT_MIGRATION_INDEX).toBe(53)
    expect(CANONICAL_MIGRATION_HISTORY[52]).toMatchObject({ idx: 52, tag: '0052_bl03_uncollected_resale_preparation_cost' })
    expect(CANONICAL_MIGRATION_HISTORY[51]).toMatchObject({ idx: 51, hash: '9ae8fdec6a5086f3b7b92091e93c4ee95a1e8effbe18e46290e88a94d3315e8f' })
    expect(REQUIRED_APPLICATION_INDEXES).toContain('expenses_uncollected_product_idx')
    expect(() => loadMigrationBundle(FOLDER, true)).not.toThrow()
  })

  it('upgrades a populated 0051 database: every expense unchanged and unlinked, the link is FK-enforced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bl03-upgrade-'))
    const dbPath = join(dir, 'upgrade.db')
    const raw = new Database(dbPath)
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, bundleBefore(dir, 52))
      raw.exec(`
        INSERT INTO customers (id, name, created_at) VALUES (1, 'BL03', '2026-09-18T00:00:00.000Z');
        INSERT INTO orders (id, document_number, customer_id, status, created_at) VALUES (1, 'BL03-ORD', 1, 'cancelled', '2026-09-18T00:00:00.000Z');
        INSERT INTO order_lines (id, order_id, line_kind, description, quantity_micro, unit_price_minor, line_total_minor) VALUES (1, 1, 'custom', 'x', 1000000, 1000, 1000);
        INSERT INTO uncollected_products (id, source_order_id, source_order_number, source_order_line_id, name, cost_basis_minor, cost_basis_method, status, transferred_at, created_at)
          VALUES (1, 1, 'BL03-ORD', 1, 'x', 6000000, 'sole_manufactured_item', 'available', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z');
        INSERT INTO expenses (id, kind, amount_minor, order_id, description, spent_at, created_at) VALUES
          (1, 'variable', 70000, NULL, 'electricity', '2026-09-10', '2026-09-10T00:00:00.000Z'),
          (2, 'variable', 50000, 1, 'order cost', '2026-09-11', '2026-09-11T00:00:00.000Z');
      `)
      const before = raw.prepare('SELECT * FROM expenses ORDER BY id').all() as Array<Record<string, unknown>>
      raw.close()

      setDatabasePath(dbPath)
      openVerifiedDatabase()
      closeDatabase()

      const verified = new Database(dbPath)
      try {
        verified.pragma('foreign_keys = ON')
        expect(verified.prepare('SELECT * FROM expenses ORDER BY id').all()).toEqual(before.map((row) => ({ ...row, uncollected_product_id: null })))
        verified.prepare("INSERT INTO expenses (kind, amount_minor, uncollected_product_id, description, spent_at, created_at) VALUES ('variable', 500000, 1, 'repaint', '2026-09-18', '2026-09-18T00:00:00.000Z')").run()
        expect(() => verified.prepare("INSERT INTO expenses (kind, amount_minor, uncollected_product_id, description, spent_at, created_at) VALUES ('variable', 1, 999, 'x', '2026-09-18', '2026-09-18T00:00:00.000Z')").run()).toThrow(/FOREIGN KEY/)
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
