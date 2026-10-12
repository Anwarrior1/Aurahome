import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/**
 * Append-only. Nothing in this codebase ever UPDATEs or DELETEs a row
 * here (Step 2 §6) — corrections are new rows, never edits. Every
 * sensitive action (permission changes, price/snapshot-affecting
 * edits, stock adjustments, waste, profit withdrawals, restore) writes
 * one row through src/main/audit/audit-log.service.ts.
 */
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  details: text('details'), // JSON string, optional
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})
