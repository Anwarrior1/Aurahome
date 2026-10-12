import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { join } from 'node:path'
import { applyPragmas } from './pragmas'
import { getDataRoot } from '../files/paths'
import * as schema from './schema'

let sqlite: Database.Database | undefined
let db: BetterSQLite3Database<typeof schema> | undefined
let pathOverride: string | undefined

export function getDatabasePath(): string {
  return pathOverride ?? join(getDataRoot(), 'erp.db')
}

/**
 * Points the connection at an explicit file instead of the default
 * %APPDATA% location. Used by the restore flow (which reopens a
 * swapped-in database) and by tests, which run the real services
 * against a real throwaway SQLite file.
 */
export function setDatabasePath(path: string | undefined): void {
  closeDatabase()
  pathOverride = path
}

/**
 * One connection for the process lifetime (Step 2 §6). Repositories
 * and services always call getDatabase() — nothing else constructs a
 * Database, so the pragma set is guaranteed to be applied.
 */
export function getDatabase(): BetterSQLite3Database<typeof schema> {
  if (!db) {
    const dbPath = getDatabasePath()
    sqlite = new Database(dbPath)
    applyPragmas(sqlite)
    db = drizzle(sqlite, { schema })
  }
  return db
}

export function getRawConnection(): Database.Database {
  if (!sqlite) getDatabase()
  return sqlite as Database.Database
}

export function closeDatabase(): void {
  sqlite?.close()
  sqlite = undefined
  db = undefined
}
