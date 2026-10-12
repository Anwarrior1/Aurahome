import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { getDatabase } from '../../db/connection'
import type * as schema from '../../db/schema'

/**
 * Every repository extends this for its `db` handle. A repository may
 * ONLY read/write rows, optionally inside a transaction handed to it
 * by a service — it never contains a business rule (a discount
 * calculation, a permission check, a FIFO decision). That belongs in
 * the matching service (src/main/services).
 */
export abstract class BaseRepository {
  protected get db(): BetterSQLite3Database<typeof schema> {
    return getDatabase()
  }
}
