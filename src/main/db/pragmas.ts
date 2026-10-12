import type Database from 'better-sqlite3'

/**
 * Step 2 §6 pragma set — durability and integrity over throughput,
 * appropriate for a low-volume single-PC financial application.
 * synchronous=FULL is deliberate: a furniture factory's write volume
 * is low, and a financial write surviving a power loss outranks
 * throughput here.
 */
export function applyPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = FULL')
  db.pragma('busy_timeout = 5000')
  db.pragma('trusted_schema = OFF')
}
