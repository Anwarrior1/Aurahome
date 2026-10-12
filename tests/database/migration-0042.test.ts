import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrationsFromFolder } from '@main/migrations/migration-runner'

const folder = 'drizzle/migrations/'
const malformed = ['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME']
interface SnapshotColumn { default?: unknown; [key: string]: unknown }
interface SnapshotTable {
  columns: Record<string, SnapshotColumn>
  indexes: unknown
  foreignKeys: unknown
  compositePrimaryKeys: unknown
  uniqueConstraints: unknown
  checkConstraints: unknown
}

function previousMigrationFolder(dir: string): string {
  const oldFolder = join(dir, 'migrations')
  mkdirSync(join(oldFolder, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(`${folder}meta/_journal.json`, 'utf8'))
  writeFileSync(
    join(oldFolder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 42) })
  )
  for (const file of readdirSync(folder).filter((file) => file.endsWith('.sql') && file < '0042')) {
    copyFileSync(`${folder}${file}`, join(oldFolder, file))
  }
  return oldFolder
}

describe('0042 DB-03 timestamp-integrity migration', () => {
  it('upgrades the previous schema, preserves historical uncertainty and unrelated data, and fixes every default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db03-migration-'))
    const oldFolder = previousMigrationFolder(dir)
    const raw = new Database(join(dir, 'upgrade.db'))
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, oldFolder)
      raw.exec(`
        INSERT INTO customers (id, name, created_at) VALUES (101, 'valid history', '2025-01-02T03:04:05.006Z');
        INSERT INTO customers (id, name) VALUES (102, 'unknown history');
        INSERT INTO audit_log (id, action, entity) VALUES (1001, 'db03.historical', 'audit_log');
      `)
      const materialColumns = raw.pragma('table_info(materials)')
      const validCustomer = raw.prepare('SELECT * FROM customers WHERE id = 101').get()

      runMigrationsFromFolder(raw, folder)

      expect(raw.prepare('SELECT * FROM customers WHERE id = 101').get()).toEqual(validCustomer)
      expect(raw.prepare('SELECT created_at FROM customers WHERE id = 102').pluck().get()).toBe('CURRENT_TIMESTAMP')
      expect(raw.prepare('SELECT created_at FROM audit_log WHERE id = 1001').pluck().get()).toBe('CURRENT_TIMESTAMP')
      const migratedMaterialColumns = raw.pragma('table_info(materials)') as Array<{ name: string; dflt_value: unknown }>
      expect(migratedMaterialColumns.map(({ name }) => name)).toEqual(
        (materialColumns as Array<{ name: string }>).map(({ name }) => name)
      )
      expect(migratedMaterialColumns.find((column) => column.name === 'created_at')?.dflt_value)
        .toBe("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")

      const tableSql = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>
      expect(tableSql.filter((table) => table.sql.includes("DEFAULT 'CURRENT_TIMESTAMP'"))).toEqual([])
      // DB-03 fixed 55 existing defaults; forward migrations may add further
      // correctly expressed timestamp defaults (DB-05 adds one here).
      expect(tableSql.filter((table) => table.sql.includes("DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"))).toHaveLength(56)
      expect(raw.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'db03_reject_%'").pluck().get()).toBe(110)

      raw.prepare("INSERT INTO audit_log(action, entity) VALUES ('db03.default', 'audit_log')").run()
      const directDefault = raw.prepare("SELECT created_at FROM audit_log WHERE action = 'db03.default'").pluck().get() as string
      expect(directDefault).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(malformed).not.toContain(directDefault)
      expect(() => raw.prepare("INSERT INTO audit_log(action, entity, created_at) VALUES ('db03.blocked', 'audit_log', 'CURRENT_TIMESTAMP')").run())
        .toThrow(/DB-03 invalid literal timestamp/)
      expect(() => raw.prepare("UPDATE customers SET created_at = 'CURRENT_DATE' WHERE id = 101").run())
        .toThrow(/DB-03 invalid literal timestamp/)

      expect(raw.pragma('foreign_key_check')).toEqual([])
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally {
      raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records only the 55 timestamp defaults and keeps migration identity monotonic', () => {
    const previous = JSON.parse(readFileSync(`${folder}meta/0041_snapshot.json`, 'utf8'))
    const current = JSON.parse(readFileSync(`${folder}meta/0042_snapshot.json`, 'utf8'))
    expect(current.prevId).toBe(previous.id)

    let changedDefaults = 0
    for (const [tableName, oldTable] of Object.entries(previous.tables) as Array<[string, SnapshotTable]>) {
      const nextTable = current.tables[tableName] as SnapshotTable
      expect(nextTable).toBeTruthy()
      for (const [columnName, oldColumn] of Object.entries(oldTable.columns)) {
        const nextColumn = nextTable.columns[columnName]
        if (oldColumn.default === "'CURRENT_TIMESTAMP'") {
          expect(nextColumn).toEqual({
            ...oldColumn,
            default: "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
          })
          changedDefaults += 1
        } else {
          expect(nextColumn).toEqual(oldColumn)
        }
      }
      expect(nextTable.indexes).toEqual(oldTable.indexes)
      expect(nextTable.foreignKeys).toEqual(oldTable.foreignKeys)
      expect(nextTable.compositePrimaryKeys).toEqual(oldTable.compositePrimaryKeys)
      expect(nextTable.uniqueConstraints).toEqual(oldTable.uniqueConstraints)
      expect(nextTable.checkConstraints).toEqual(oldTable.checkConstraints)
    }
    expect(changedDefaults).toBe(55)

    const journal = JSON.parse(readFileSync(`${folder}meta/_journal.json`, 'utf8'))
    const entry = journal.entries.find((item: { idx: number }) => item.idx === 42)
    const prior = journal.entries.find((item: { idx: number }) => item.idx === 41)
    expect(entry).toMatchObject({ idx: 42, tag: '0042_omniscient_night_thrasher' })
    expect(entry.when).toBeGreaterThan(prior.when)
  })
})
