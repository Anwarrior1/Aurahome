import { and, eq, sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { notificationDismissals, notificationReads } from '../../db/schema/notifications.schema'
import { stockLevels } from '../inventory/valuation.service'
import { openOrderAlertRows } from '../sales/orders.service'
import { hasPermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { formatQuantity, quantity } from '@shared/quantity/quantity'
import type { AuthSession } from '@shared/types/user.types'
import { nowIso } from '../base/service.types'
import { withTransaction } from '../../db/transactions'

export type NotificationCategory = 'low_stock' | 'incomplete_order'

export interface NotificationItem {
  /** Stable per-condition id ("low_stock:<materialId>",
   *  "incomplete_order:<orderId>") — the SAME live condition always
   *  produces the SAME key, so nothing is ever duplicated across
   *  repeated calls, refreshes, or logins (item 7). */
  key: string
  category: NotificationCategory
  title: string
  description: string
  /** The date most relevant to the alert — the order's own creation
   *  date for an incomplete order, or "now" for a stock level, which
   *  has no owning event of its own. */
  occurredAt: string
  read: boolean
  /** An existing route this alert can safely open — never a new page. */
  route: string
}

/**
 * Customer Orders that are not yet fully completed — reusing the
 * EXACT same authoritative status field every order screen already
 * reads (orders.status: confirmed | completed | cancelled, see
 * sales.schema.ts). Only 'confirmed' means "still open": 'completed'
 * and 'cancelled' are both excluded by construction, never by a
 * second, separately-maintained rule.
 */
function incompleteOrderNotifications(): NotificationItem[] {
  // Every open order produces an alert; eligibility enrichment is irrelevant here.
  const activeOrders = openOrderAlertRows()
  return activeOrders.map((order) => ({
    key: `incomplete_order:${order.id}`,
    category: 'incomplete_order' as const,
    title: 'طلب غير مكتمل',
    description: `طلب العميل ${order.documentNumber} (${order.customerName}) ما زال قيد التنفيذ`,
    occurredAt: order.createdAt,
    read: false,
    route: `/orders/${order.id}`
  }))
}

/**
 * Materials at or below their own configured reorder level — the
 * EXACT same stockLevels() query (and the same qtyMicro <=
 * reorderLevelMicro rule) already used by /inventory's own "منخفض"
 * filter, so this can never drift from the ERP's one stock authority.
 * A reorder level of 0 means "not configured" (materials.schema.ts's
 * own default), so it is never treated as an active threshold —
 * matching the exact guard InventoryPage.tsx already applies.
 */
function lowStockNotifications(): NotificationItem[] {
  return stockLevels({})
    .filter((row) => row.reorderLevelMicro > 0 && row.qtyMicro <= row.reorderLevelMicro)
    .map((row) => ({
      key: `low_stock:${row.materialId}`,
      category: 'low_stock' as const,
      title: 'تنبيه مخزون منخفض',
      description:
        `المادة: ${row.name} — الكمية الحالية (${formatQuantity(quantity(row.qtyMicro), row.unit)}) ` +
        `أقل من أو تساوي حد إعادة الطلب (${formatQuantity(quantity(row.reorderLevelMicro), row.unit)})`,
      occurredAt: nowIso(),
      read: false,
      route: '/inventory'
    }))
}

/**
 * Every currently-active alert, permission-filtered per category
 * (item 8) — a category is included only for a caller who already
 * holds the exact same permission its own dedicated screen requires,
 * never a blanket "notifications" permission of its own. Read state
 * is per-user (notification_reads); a key with no matching row is
 * unread. Read rows for keys that are no longer active are pruned
 * first, so a resolved-then-recurring condition is unread again
 * rather than permanently stuck "already seen" (item 6/7).
 */
export function listNotifications(session: AuthSession): { items: NotificationItem[]; unreadCount: number } {
  const items: NotificationItem[] = [
    ...(hasPermission(session, P.inventory.view) ? lowStockNotifications() : []),
    ...(hasPermission(session, P.orders.view) ? incompleteOrderNotifications() : [])
  ]

  const db = getDatabase()
  const activeKeys = items.map((item) => item.key)
  pruneStaleNotificationState(session.user.id, activeKeys)

  const readKeys = new Set(
    activeKeys.length === 0
      ? []
      : db
          .select({ key: notificationReads.notificationKey })
          .from(notificationReads)
          .where(eq(notificationReads.userId, session.user.id))
          .all()
          .map((row) => row.key)
  )

  const dismissedKeys = new Set(
    activeKeys.length === 0
      ? []
      : db
          .select({ key: notificationDismissals.notificationKey })
          .from(notificationDismissals)
          .where(eq(notificationDismissals.userId, session.user.id))
          .all()
          .map((row) => row.key)
  )

  const withReadState = items
    .filter((item) => !dismissedKeys.has(item.key))
    .map((item) => ({ ...item, read: readKeys.has(item.key) }))
  const unreadCount = withReadState.filter((item) => !item.read).length
  return { items: withReadState, unreadCount }
}

/** Removes this user's read-marks for any key that is no longer part
 *  of the current active set — a resolved condition's read-mark is
 *  meaningless, and pruning it is what lets the SAME key be unread
 *  again if that condition ever becomes active a second time. */
function pruneStaleNotificationState(userId: number, activeKeys: string[]): void {
  const db = getDatabase()
  if (activeKeys.length === 0) {
    db.delete(notificationReads).where(eq(notificationReads.userId, userId)).run()
    db.delete(notificationDismissals).where(eq(notificationDismissals.userId, userId)).run()
    return
  }
  // One JSON parameter: the active set grows with open work and can exceed
  // SQLite's bound-variable limit if every key were bound separately.
  const active = sql`(SELECT value FROM json_each(${JSON.stringify(activeKeys)}))`
  db.delete(notificationReads)
    .where(and(eq(notificationReads.userId, userId), sql`${notificationReads.notificationKey} NOT IN ${active}`))
    .run()
  db.delete(notificationDismissals)
    .where(and(eq(notificationDismissals.userId, userId), sql`${notificationDismissals.notificationKey} NOT IN ${active}`))
    .run()
}

/**
 * Marks every currently-active, permission-visible notification as
 * read for this user (called once when the dropdown is opened) — the
 * business condition itself is completely untouched; only the badge
 * count changes (item 6). listNotifications() already prunes stale
 * reads first, so every remaining unread item here is guaranteed to
 * have no existing row yet — a plain insert, never an upsert.
 */
export function markAllNotificationsRead(session: AuthSession): void {
  const { items } = listNotifications(session)
  const unread = items.filter((item) => !item.read)
  if (unread.length === 0) return

  const db = getDatabase()
  const now = nowIso()
  withTransaction(() => {
    for (const item of unread) {
      db.insert(notificationReads).values({ userId: session.user.id, notificationKey: item.key, readAt: now }).run()
    }
  })
}

/**
 * Dismisses exactly one alert visible to the authenticated user. The
 * server resolves the active/permission-visible set itself, so a
 * renderer cannot dismiss another user's alert or a forbidden category.
 */
export function dismissNotification(session: AuthSession, notificationKey: string): boolean {
  const item = listNotifications(session).items.find((candidate) => candidate.key === notificationKey)
  if (!item) return false

  getDatabase()
    .insert(notificationDismissals)
    .values({ userId: session.user.id, notificationKey: item.key, dismissedAt: nowIso() })
    .onConflictDoNothing()
    .run()
  return true
}

/** Dismisses the caller's complete current visible set atomically. */
export function clearAllNotifications(session: AuthSession): number {
  const items = listNotifications(session).items
  if (items.length === 0) return 0

  const now = nowIso()
  withTransaction(() => {
    for (const item of items) {
      getDatabase().insert(notificationDismissals)
        .values({ userId: session.user.id, notificationKey: item.key, dismissedAt: now })
        .onConflictDoNothing()
        .run()
    }
  })
  return items.length
}

/** Largest alert list sent to the renderer; counts always describe the full set. */
export const NOTIFICATION_FEED_LIMIT = 100

/**
 * The bell's IPC payload. Alerts are derived from open work, which can grow,
 * so only the first NOTIFICATION_FEED_LIMIT visible alerts are serialized
 * while unread/total counts stay authoritative for the complete set.
 */
export function notificationFeed(session: AuthSession): { items: NotificationItem[]; unreadCount: number; totalCount: number } {
  const { items, unreadCount } = listNotifications(session)
  return { items: items.slice(0, NOTIFICATION_FEED_LIMIT), unreadCount, totalCount: items.length }
}
