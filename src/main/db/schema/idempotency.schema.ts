import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/**
 * Durable receipt for an externally initiated financial command.
 *
 * The unique (commandScope, requestKey) pair is the database-enforced
 * idempotency boundary. The row is inserted, completed with the result, and
 * committed in the same transaction as the command's economic effects.
 */
export const financialCommandRequests = sqliteTable(
  'financial_command_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    commandScope: text('command_scope').notNull(),
    requestKey: text('request_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    resultJson: text('result_json').notNull(),
    createdBy: integer('created_by').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    completedAt: text('completed_at').notNull()
  },
  (t) => ({
    scopeRequestUnique: uniqueIndex('financial_command_requests_scope_key_uq').on(
      t.commandScope,
      t.requestKey
    ),
    createdAtIdx: index('financial_command_requests_created_at_idx').on(t.createdAt)
  })
)
