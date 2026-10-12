import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrationsFromFolder } from '@main/migrations/migration-runner'
import { scanIntegerDomainStorage } from '@main/db/integer-domain-scan'

describe('0044 DB-06 upgrade and exact before-fix reproduction', () => {
  it('demonstrates REAL expense persistence on 0043, preserves history, and rejects subsequent malformed writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db06-upgrade-'))
    const folder = 'drizzle/migrations/'
    const previous = join(dir, 'previous')
    const through0044 = join(dir, 'through-0044')
    mkdirSync(join(previous, 'meta'), { recursive: true })
    mkdirSync(join(through0044, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(`${folder}meta/_journal.json`, 'utf8'))
    writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify({
      ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 44)
    }))
    writeFileSync(join(through0044, 'meta/_journal.json'), JSON.stringify({
      ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 45)
    }))
    for (const file of readdirSync(folder).filter((file) => file.endsWith('.sql') && file < '0044'))
      copyFileSync(`${folder}${file}`, join(previous, file))
    for (const file of readdirSync(folder).filter((file) => file.endsWith('.sql') && file < '0045'))
      copyFileSync(`${folder}${file}`, join(through0044, file))
    const raw = new Database(join(dir, 'upgrade.db'))
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, previous)
      raw.prepare("INSERT INTO expenses (id, kind, amount_minor, description, spent_at) VALUES (101, 'variable', ?, 'before-fix', '2026-09-01')").run(1000.5)
      expect(raw.prepare('SELECT amount_minor, typeof(amount_minor) AS type FROM expenses WHERE id = 101').get())
        .toEqual({ amount_minor: 1000.5, type: 'real' })
      expect(scanIntegerDomainStorage(raw)).toContainEqual({ table: 'expenses', column: 'amount_minor', count: 1 })
      runMigrationsFromFolder(raw, through0044)
      expect(raw.prepare('SELECT amount_minor, typeof(amount_minor) AS type FROM expenses WHERE id = 101').get())
        .toEqual({ amount_minor: 1000.5, type: 'real' })
      expect(scanIntegerDomainStorage(raw)).toContainEqual({ table: 'expenses', column: 'amount_minor', count: 1 })
      expect(() => raw.prepare("INSERT INTO expenses (kind, amount_minor, description, spent_at) VALUES ('variable', ?, 'after-fix', '2026-09-01')").run(1000.5))
        .toThrow(/DB-06 invalid expense amount/)
      expect(() => raw.prepare('UPDATE expenses SET amount_minor = ? WHERE id = 101').run(2000.5))
        .toThrow(/DB-06 invalid expense amount/)
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])
    } finally {
      raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
