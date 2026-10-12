import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openVerifiedDatabase } from '@main/app/database-startup'
import { closeDatabase, getRawConnection, setDatabasePath } from '@main/db/connection'
import { applyPragmas } from '@main/db/pragmas'
import { runMigrationsFromFolder } from '@main/migrations/migration-runner'
import { finalizeMigrationRecovery, readMigrationRecoveryMarker } from '@main/migrations/migration-recovery'
import {
  REQUIRED_APPLICATION_INDEXES,
  REQUIRED_APPLICATION_TABLES,
  REQUIRED_MIGRATION_TRIGGERS
} from '@main/migrations/current-schema-identity'

/**
 * `assertHistoricalDatabaseStructure` verifies an old database against the
 * released Drizzle snapshot for its journal head, so EVERY journal entry needs
 * a snapshot: a missing one fails startup closed with DB_MIGRATION_BUNDLE_MISMATCH
 * and blocks the upgrade entirely (the 0019/0028/0044/0045 defect).
 */
const MIGRATIONS = resolve('drizzle/migrations')
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; version: string; when: number; tag: string }>
}

interface Snapshot {
  tables: Record<string, { columns: Record<string, unknown>; indexes?: Record<string, unknown> }>
}

function snapshotPath(idx: number): string {
  return join(MIGRATIONS, 'meta', `${String(idx).padStart(4, '0')}_snapshot.json`)
}

/** Replays released SQL through migration `idx` — the authority on that prefix's real schema. */
function schemaAt(idx: number, dir: string): Record<string, string[]> {
  const raw = new Database(join(dir, `at-${idx}.db`))
  raw.pragma('foreign_keys = OFF')
  try {
    for (const entry of journal.entries.filter((e) => e.idx <= idx)) {
      for (const statement of readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
        if (statement.trim()) raw.exec(statement.trim())
      }
    }
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name")
      .all() as Array<{ name: string }>
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        (raw.pragma(`table_info("${name.replaceAll('"', '""')}")`) as Array<{ name: string }>).map((c) => c.name).sort()
      ])
    )
  } finally {
    raw.close()
  }
}

function prefixFolder(dir: string, throughIdx: number): string {
  const folder = join(dir, `prefix-${throughIdx}`)
  mkdirSync(join(folder, 'meta'), { recursive: true })
  const entries = journal.entries.filter(({ idx }) => idx <= throughIdx)
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({
    version: '7', dialect: 'sqlite',
    entries: entries.map((entry) => ({ ...entry, version: '6', breakpoints: true }))
  }))
  for (const entry of entries) copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  return folder
}

afterEach(() => {
  closeDatabase()
  setDatabasePath(undefined)
  vi.restoreAllMocks()
})

describe('released historical schema snapshots', () => {
  it('exist for every journal entry', () => {
    const missing = journal.entries.filter((entry) => !existsSync(snapshotPath(entry.idx))).map((e) => e.tag)
    expect(missing).toEqual([])
  })

  it('describe exactly the schema the released migrations produce', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-snapshot-truth-'))
    try {
      for (const entry of journal.entries) {
        const actual = schemaAt(entry.idx, dir)
        const snapshot = JSON.parse(readFileSync(snapshotPath(entry.idx), 'utf8')) as Snapshot
        for (const [table, definition] of Object.entries(snapshot.tables)) {
          expect(Object.keys(actual), `${entry.tag}: snapshot table ${table}`).toContain(table)
          expect(Object.keys(definition.columns).sort(), `${entry.tag}: ${table} columns`).toEqual(actual[table])
        }
        expect(Object.keys(snapshot.tables).sort(), `${entry.tag}: table set`).toEqual(Object.keys(actual).sort())
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 600_000)

  it('claim no index the released migrations do not create', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-snapshot-index-'))
    try {
      for (const idx of [19, 28, 43, 44, 45, 46]) {
        const raw = new Database(join(dir, `idx-${idx}.db`))
        raw.pragma('foreign_keys = OFF')
        try {
          for (const entry of journal.entries.filter((e) => e.idx <= idx)) {
            for (const statement of readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
              if (statement.trim()) raw.exec(statement.trim())
            }
          }
          const real = new Set(
            (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as Array<{ name: string }>).map((r) => r.name)
          )
          const snapshot = JSON.parse(readFileSync(snapshotPath(idx), 'utf8')) as Snapshot
          const claimed = Object.values(snapshot.tables).flatMap((t) => Object.keys(t.indexes ?? {}))
          expect(claimed.filter((name) => !real.has(name)), `snapshot ${idx} phantom indexes`).toEqual([])
        } finally {
          raw.close()
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})

describe('historical database upgrade through production startup', () => {
  // 19/28/44/45 were blocked by missing snapshots; 43 and 46 are the boundaries.
  it.each([19, 28, 43, 44, 45, 46])('upgrades a populated database at migration %i to current', (idx) => {
    const dir = mkdtempSync(join(tmpdir(), `aura-upgrade-${idx}-`))
    const path = join(dir, 'erp.db')
    try {
      const seed = new Database(path)
      applyPragmas(seed)
      runMigrationsFromFolder(seed, prefixFolder(dir, idx))
      seed.prepare("INSERT INTO customers (id, name) VALUES (9101, 'upgrade sentinel')").run()
      seed.prepare("INSERT INTO cash_accounts (id, name, created_at) VALUES (9102, 'حساب', '2026-01-01T00:00:00.000Z')").run()
      seed.pragma('wal_checkpoint(TRUNCATE)')
      seed.close()

      setDatabasePath(path)
      openVerifiedDatabase()
      const raw = getRawConnection()

      expect(Number(raw.prepare('SELECT COUNT(*) FROM __drizzle_migrations').pluck().get())).toBe(journal.entries.length)
      expect(raw.prepare('SELECT name FROM customers WHERE id = 9101').get()).toEqual({ name: 'upgrade sentinel' })
      expect(raw.prepare('SELECT name FROM cash_accounts WHERE id = 9102').get()).toEqual({ name: 'حساب' })
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])

      const names = (type: string) =>
        new Set((raw.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as Array<{ name: string }>).map((r) => r.name))
      const tables = names('table')
      const indexes = names('index')
      const triggers = names('trigger')
      expect(REQUIRED_APPLICATION_TABLES.filter((t) => !tables.has(t))).toEqual([])
      expect(REQUIRED_APPLICATION_INDEXES.filter((i) => !indexes.has(i))).toEqual([])
      expect(REQUIRED_MIGRATION_TRIGGERS.filter((t) => !triggers.has(t))).toEqual([])

      // DB-01 protects a real upgrade only; an already-current database migrates
      // nothing and must not create a recovery marker at all.
      const isUpgrade = idx < journal.entries.length - 1
      expect(readMigrationRecoveryMarker(path)?.phase).toBe(isUpgrade ? 'verified' : undefined)
      finalizeMigrationRecovery(raw)
      expect(readMigrationRecoveryMarker(path)).toBeUndefined()
      closeDatabase()

      // A second startup is an ordinary current startup: DB-14's single-pass gate.
      const spy = vi.spyOn(Database.prototype, 'pragma')
      setDatabasePath(path)
      openVerifiedDatabase()
      const passes = (name: string) => spy.mock.calls.filter(([source]) => String(source).trim() === name).length
      expect(passes('integrity_check')).toBe(1)
      expect(passes('foreign_key_check')).toBe(1)
      expect(passes('quick_check')).toBe(0)
      expect(readMigrationRecoveryMarker(path)).toBeUndefined()
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)

  // 44/45 previously failed at the snapshot read, before any structural or
  // identity gate ran. Now that they reach those gates, prove they still reject.
  it.each([
    [44, 'structure', /STRUCTURAL/],
    [45, 'structure', /STRUCTURAL/],
    [44, 'history', /HISTORY_MISMATCH/],
    [45, 'history', /HISTORY_MISMATCH/]
  ])('fails closed on a %i database with tampered %s', (idx, kind, pattern) => {
    const dir = mkdtempSync(join(tmpdir(), `aura-upgrade-tampered-${idx}-${kind}-`))
    const path = join(dir, 'erp.db')
    try {
      const seed = new Database(path)
      applyPragmas(seed)
      runMigrationsFromFolder(seed, prefixFolder(dir, idx))
      seed.prepare("INSERT INTO customers (id, name) VALUES (9104, 'tamper sentinel')").run()
      if (kind === 'structure') seed.exec('DROP TABLE financial_command_requests')
      else seed.prepare('UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?').run('tampered', journal.entries[5]!.when)
      seed.pragma('wal_checkpoint(TRUNCATE)')
      seed.close()
      const before = createHash('sha256').update(readFileSync(path)).digest('hex')

      setDatabasePath(path)
      expect(() => openVerifiedDatabase()).toThrow(pattern)
      closeDatabase()

      expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before)
      expect(readMigrationRecoveryMarker(path)).toBeUndefined()
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still fails closed, without mutation, when a required snapshot is unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-upgrade-missing-snapshot-'))
    const path = join(dir, 'erp.db')
    try {
      const seed = new Database(path)
      applyPragmas(seed)
      runMigrationsFromFolder(seed, prefixFolder(dir, 44))
      seed.prepare("INSERT INTO customers (id, name) VALUES (9103, 'fail closed sentinel')").run()
      seed.pragma('wal_checkpoint(TRUNCATE)')
      seed.close()
      const before = createHash('sha256').update(readFileSync(path)).digest('hex')

      // The historical structure gate must stay mandatory: no silent skip.
      vi.spyOn(JSON, 'parse').mockImplementation(() => {
        throw new Error('unreadable snapshot')
      })
      setDatabasePath(path)
      expect(() => openVerifiedDatabase()).toThrow()
      vi.restoreAllMocks()
      closeDatabase()

      expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before)
      expect(readMigrationRecoveryMarker(path)).toBeUndefined()
    } finally {
      closeDatabase()
      setDatabasePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
