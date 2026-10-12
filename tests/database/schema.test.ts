import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

/**
 * Verifies the pragma/integrity foundation independent of Electron's
 * userData path (which only exists inside a running app) — opens a
 * throwaway in-memory database and applies the same pragmas main uses
 * in src/main/db/pragmas.ts (Step 2 §6).
 */
describe('sqlite foundation', () => {
  it('enforces foreign keys and passes integrity_check on a fresh db', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])

    db.close()
  })
})
