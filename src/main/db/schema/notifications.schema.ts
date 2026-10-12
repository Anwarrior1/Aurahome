import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { users } from './users.schema'

/**
 * The Notifications Bell never stores the alert itself — every active
 * notification (low stock, incomplete order) is derived live, each
 * time, straight from the same authoritative materials/orders data
 * every other screen already reads (see notifications.service.ts).
 * This table only remembers which of those (inherently stable, keyed
 * by material/order id) notifications a given user has already seen,
 * so the unread badge can go quiet without ever hiding the underlying
 * alert. A row is meaningless once its condition is no longer active
 * and is pruned the next time the list is computed — so if the same
 * condition returns later, it is unread again, never stuck "already
 * read" forever from an unrelated earlier occurrence.
 */
export const notificationReads = sqliteTable(
  'notification_reads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** e.g. "low_stock:42" or "incomplete_order:17" — see notifications.service.ts. */
    notificationKey: text('notification_key').notNull(),
    readAt: text('read_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    uniquePerUser: uniqueIndex('notification_reads_unique').on(t.userId, t.notificationKey)
  })
)

/**
 * A dismissal hides one currently-active derived alert for one user.
 * It deliberately stores only the deterministic alert key, never a
 * material/order snapshot and never any mutable business data. Stale
 * rows are pruned when the condition resolves, which lets the same
 * material/order produce a fresh alert if the condition later recurs.
 */
export const notificationDismissals = sqliteTable(
  'notification_dismissals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** e.g. "low_stock:42" or "incomplete_order:17". */
    notificationKey: text('notification_key').notNull(),
    dismissedAt: text('dismissed_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    uniquePerUser: uniqueIndex('notification_dismissals_unique').on(t.userId, t.notificationKey)
  })
)
