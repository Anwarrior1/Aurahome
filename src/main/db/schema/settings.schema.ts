import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/**
 * Business-level configurable settings that must live in the database
 * (not config.json) because they are audited and snapshotted:
 * the Savings & Investment rate (BR-110), the default deposit
 * percentage (BR-42), and the editable Terms & Conditions (BR-79).
 */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON-encoded
  updatedAt: text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedBy: text('updated_by')
})
