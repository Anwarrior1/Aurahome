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

const insertUser = (db: Database.Database, id: number, username: string, deletedAt: string | null, roleId: number | null) =>
  db.prepare('INSERT INTO users (id, username, password_hash, full_name, role_id, active, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, username, 'hash', username, roleId, deletedAt ? 0 : 1, deletedAt)

describe('0050 CC03 username unique among live users', () => {
  it('appends one pinned migration and swaps the required username index', () => {
    expect(CURRENT_MIGRATION_INDEX).toBeGreaterThanOrEqual(50)
    expect(CANONICAL_MIGRATION_HISTORY[50]).toMatchObject({ idx: 50, tag: '0050_cc03_username_unique_among_live_users' })
    expect(CANONICAL_MIGRATION_HISTORY[49]).toMatchObject({
      idx: 49,
      tag: '0049_db06_repository_integer_guards',
      hash: '3eeb6c711f525a0dd10a5f551ebd6b4bfb3a891035a7aa445c03ab02b04a1734'
    })
    expect(REQUIRED_APPLICATION_INDEXES).toContain('users_username_live_unique')
    expect(REQUIRED_APPLICATION_INDEXES).not.toContain('users_username_unique')
    expect(() => loadMigrationBundle(FOLDER, true)).not.toThrow()
  })

  it('upgrades a populated 0049 database, preserves every user row, frees tombstoned usernames and keeps live ones unique', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc03-upgrade-'))
    const dbPath = join(dir, 'upgrade.db')
    const raw = new Database(dbPath)
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, bundleBefore(dir, 50))
      raw.exec("INSERT INTO roles (id, name, is_admin) VALUES (501, 'CC03 role', 0)")
      insertUser(raw, 501, 'hadi', '2026-09-01T00:00:00.000Z', null)
      insertUser(raw, 502, 'sara', null, 501)
      raw.prepare("INSERT INTO audit_log (user_id, action, entity, created_at) VALUES (501, 'auth.login', 'session', '2026-08-01T00:00:00.000Z')").run()
      expect(() => insertUser(raw, 503, 'hadi', null, 501)).toThrow(/UNIQUE/)
      const usersBefore = raw.prepare('SELECT * FROM users ORDER BY id').all()
      const auditBefore = raw.prepare('SELECT * FROM audit_log ORDER BY id').all()
      raw.close()

      setDatabasePath(dbPath)
      openVerifiedDatabase()
      closeDatabase()

      const verified = new Database(dbPath)
      try {
        verified.pragma('foreign_keys = ON')
        expect(verified.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(usersBefore)
        expect(verified.prepare('SELECT * FROM audit_log ORDER BY id').all()).toEqual(auditBefore)
        expect(verified.prepare("SELECT name FROM sqlite_master WHERE name = 'users_username_unique'").get()).toBeUndefined()
        expect(verified.prepare("SELECT sql FROM sqlite_master WHERE name = 'users_username_live_unique'").get())
          .toEqual({ sql: 'CREATE UNIQUE INDEX `users_username_live_unique` ON `users` (`username`) WHERE "users"."deleted_at" IS NULL' })
        insertUser(verified, 503, 'hadi', null, 501)
        expect(() => insertUser(verified, 504, 'hadi', null, 501)).toThrow(/UNIQUE/)
        expect(() => insertUser(verified, 505, 'sara', null, 501)).toThrow(/UNIQUE/)
        expect(verified.prepare("SELECT id FROM users WHERE username = 'hadi' ORDER BY id").all()).toEqual([{ id: 501 }, { id: 503 }])
        expect(verified.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get()).toEqual({ c: 54 })
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
