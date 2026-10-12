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

function previousBundle(dir: string): string {
  const previous = join(dir, 'previous')
  mkdirSync(join(previous, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(`${FOLDER}meta/_journal.json`, 'utf8'))
  writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify({
    ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 45)
  }))
  for (const file of readdirSync(FOLDER).filter((file) => file.endsWith('.sql') && file < '0045'))
    copyFileSync(`${FOLDER}${file}`, join(previous, file))
  return previous
}

describe('0045 DB-10 delivery-by-permit index', () => {
  it('is appended to the pinned history without changing any released identity', () => {
    expect(CURRENT_MIGRATION_INDEX).toBeGreaterThanOrEqual(45)
    expect(CANONICAL_MIGRATION_HISTORY[45]).toMatchObject({ idx: 45, tag: '0045_db10_delivery_release_index', hash: '68996ce0ff203be75862deb3ac46d800a200213abdd7a290221c306cde221846' })
    expect(CANONICAL_MIGRATION_HISTORY[44]).toMatchObject({ idx: 44, hash: 'c7fc0b32be9639ab5f935c00d293f52d7347e52da871ca80fcdf2f8b9d4cb418' })
    expect(REQUIRED_APPLICATION_INDEXES).toContain('deliveries_release_idx')
    expect(() => loadMigrationBundle(FOLDER, true)).not.toThrow()
  })

  it('upgrades a populated 0044 database, preserves every delivery, and serves permit lookups by index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db10-upgrade-'))
    const raw = new Database(join(dir, 'upgrade.db'))
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, previousBundle(dir))
      raw.exec(`
        INSERT INTO customers (id, name, created_at) VALUES (1, 'c', '2026-01-01T00:00:00.000Z');
        INSERT INTO orders (id, document_number, customer_id, created_at) VALUES (1, 'O-1', 1, '2026-01-01T00:00:00.000Z');
        INSERT INTO releases (id, document_number, order_id, kind, authorized_at, created_at) VALUES (1, 'R-1', 1, 'delivery', '2026-01-02', '2026-01-02T00:00:00.000Z');
        INSERT INTO deliveries (id, order_id, kind, release_id, created_at) VALUES (1, 1, 'handover', 1, '2026-01-03T00:00:00.000Z');
        INSERT INTO deliveries (id, order_id, kind, release_id, created_at) VALUES (2, 1, 'delivery', NULL, '2026-01-03T00:00:00.000Z');
      `)
      const before = raw.prepare('SELECT * FROM deliveries ORDER BY id').all()
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'deliveries_release_idx'").get()).toBeUndefined()
      expect((raw.prepare('EXPLAIN QUERY PLAN SELECT id FROM deliveries WHERE release_id = 1').all() as Array<{ detail: string }>).map((row) => row.detail).join(' ')).toMatch(/SCAN deliveries/)

      runMigrationsFromFolder(raw, FOLDER)
      expect(raw.prepare('SELECT * FROM deliveries ORDER BY id').all()).toEqual(before)
      expect(raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'deliveries_release_idx'").get()).toEqual({
        sql: 'CREATE INDEX `deliveries_release_idx` ON `deliveries` (`release_id`)'
      })
      expect((raw.prepare('EXPLAIN QUERY PLAN SELECT id FROM deliveries WHERE release_id = 1').all() as Array<{ detail: string }>).map((row) => row.detail).join(' '))
        .toMatch(/USING (COVERING )?INDEX deliveries_release_idx/)
      expect(raw.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get()).toEqual({ c: CURRENT_MIGRATION_INDEX + 1 })
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])
    } finally {
      raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
