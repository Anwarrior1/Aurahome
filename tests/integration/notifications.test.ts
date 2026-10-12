import { fulfillOrder } from '../helpers/sales-flow'
import { issueWorkSheet as issueLifecycleWorkSheet, completeProduction as completeLifecycleProduction } from '@main/services/production/production.service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { closeDatabase, getRawConnection } from '@main/db/connection'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { recordOpeningStock, adjustStock } from '@main/services/inventory/inventory.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder } from '@main/services/sales/orders.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import {
  clearAllNotifications,
  dismissNotification,
  listNotifications,
  markAllNotificationsRead
} from '@main/services/notifications/notifications.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * Notifications Bell: every item is DERIVED live from the ERP's own
 * existing authoritative data — stockLevels()'s own low-stock rule
 * (same one /inventory already uses) for materials, and orders.status
 * for customer orders — nothing here stores or recomputes inventory
 * or order state on its own. Per-user read and dismissal state is
 * persisted separately from the business records.
 */
let env: TestEnv
let seq = 0
beforeEach(() => { env = setupTestDatabase(); seq = 0 })
afterEach(() => env.cleanup())

function unique(prefix: string): string { return `${prefix}-${++seq}` }

function seedMaterial(reorderMajor: number, openingMajor: number) {
  const categoryId = createCategory({ name: unique('أخشاب') }, env.ctx)
  const materialId = createMaterial({
    sku: unique('MDF'), name: 'خشب MDF', categoryId, unit: 'لوح',
    currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact',
    reorderLevelMicro: quantityFromDisplay(reorderMajor)
  } as never, env.ctx)
  if (openingMajor > 0) {
    recordOpeningStock({ materialId, qtyMicro: quantityFromDisplay(openingMajor), unitCostMicro: unitCostFromMajor(100) }, env.ctx)
  }
  return materialId
}

function seedConfirmedOrder() {
  const customerId = createCustomer({ name: unique('عميل') }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    lines: [{ lineKind: 'custom', description: 'منتج', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
  }, env.ctx)
  return approveToOrder(invoice.id, env.ctx)
}

describe('1 — no active conditions means no notifications', () => {
  it('returns an empty list and zero unread when nothing is low/incomplete', () => {
    const result = listNotifications(env.ctx.session)
    expect(result.items).toEqual([])
    expect(result.unreadCount).toBe(0)
  })
})

describe('2 — low-stock material produces exactly one active alert', () => {
  it('appears once stock is at or below the configured reorder level', () => {
    const materialId = seedMaterial(10, 5) // 5 boards on hand, reorder at 10
    const { items } = listNotifications(env.ctx.session)

    const alert = items.find((i) => i.key === `low_stock:${materialId}`)
    expect(alert).toBeDefined()
    expect(alert!.category).toBe('low_stock')
    expect(alert!.title).toBe('تنبيه مخزون منخفض')
    expect(alert!.description).toContain('خشب MDF')
    expect(alert!.route).toBe('/inventory')
  })

  it('a material with no configured reorder level (0, the default) never alerts, even at zero stock', () => {
    seedMaterial(0, 0)
    const { items } = listNotifications(env.ctx.session)
    expect(items.filter((i) => i.category === 'low_stock')).toEqual([])
  })

  it('resolves (disappears) once stock is brought back above the threshold', () => {
    const materialId = seedMaterial(10, 5)
    expect(listNotifications(env.ctx.session).items.some((i) => i.key === `low_stock:${materialId}`)).toBe(true)

    adjustStock({ materialId, qtyMicro: quantityFromDisplay(20), direction: 'in', reason: 'تجديد المخزون', ctx: env.ctx })

    expect(listNotifications(env.ctx.session).items.some((i) => i.key === `low_stock:${materialId}`)).toBe(false)
  })
})

describe('3 — incomplete-order notifications follow orders.status exactly', () => {
  it('a confirmed (not yet completed) order shows as incomplete', () => {
    const order = seedConfirmedOrder()
    const { items } = listNotifications(env.ctx.session)

    const alert = items.find((i) => i.key === `incomplete_order:${order.id}`)
    expect(alert).toBeDefined()
    expect(alert!.category).toBe('incomplete_order')
    expect(alert!.title).toBe('طلب غير مكتمل')
    expect(alert!.description).toContain(order.documentNumber)
    expect(alert!.route).toBe(`/orders/${order.id}`)
  })

  it('a completed order no longer appears', () => {
    const order = seedConfirmedOrder()
    fulfillOrder(order.id, env.ctx)
    const { items } = listNotifications(env.ctx.session)
    expect(items.some((i) => i.key === `incomplete_order:${order.id}`)).toBe(false)
  })

  it('a cancelled order is never treated as incomplete', () => {
    const order = seedConfirmedOrder()
    completeLifecycleProduction(issueLifecycleWorkSheet({ orderId: order.id, overrideDepositRequirement: true }, env.ctx).id, env.ctx)
    cancelOrder({ orderId: order.id, reason: 'طلب العميل' }, env.ctx)
    const { items } = listNotifications(env.ctx.session)
    expect(items.some((i) => i.key === `incomplete_order:${order.id}`)).toBe(false)
  })
})

describe('4 — no duplicate notifications across repeated calls (refresh/relogin)', () => {
  it('the same active condition always maps to exactly one notification, every time', () => {
    const materialId = seedMaterial(10, 5)
    const order = seedConfirmedOrder()

    for (let i = 0; i < 3; i++) {
      const { items } = listNotifications(env.ctx.session)
      expect(items.filter((it2) => it2.key === `low_stock:${materialId}`)).toHaveLength(1)
      expect(items.filter((it2) => it2.key === `incomplete_order:${order.id}`)).toHaveLength(1)
    }
  })
})

describe('5 — read vs active are separate: opening/reading never hides an active alert', () => {
  it('markAllNotificationsRead clears the unread count but the item remains in the list', () => {
    seedMaterial(10, 5)
    seedConfirmedOrder()
    const before = listNotifications(env.ctx.session)
    expect(before.unreadCount).toBe(2)
    expect(before.items.every((i) => !i.read)).toBe(true)

    markAllNotificationsRead(env.ctx.session)

    const after = listNotifications(env.ctx.session)
    expect(after.unreadCount).toBe(0)
    expect(after.items).toHaveLength(2) // still shown — the condition is still active
    expect(after.items.every((i) => i.read)).toBe(true)
  })

  it('a resolved-then-recurring condition becomes unread again, never stuck "already read" forever', () => {
    const materialId = seedMaterial(10, 5)
    markAllNotificationsRead(env.ctx.session)
    expect(listNotifications(env.ctx.session).items.find((i) => i.key === `low_stock:${materialId}`)?.read).toBe(true)

    // Resolves...
    adjustStock({ materialId, qtyMicro: quantityFromDisplay(20), direction: 'in', reason: 'تجديد', ctx: env.ctx })
    expect(listNotifications(env.ctx.session).items.some((i) => i.key === `low_stock:${materialId}`)).toBe(false)

    // ...and becomes active again later.
    adjustStock({ materialId, qtyMicro: quantityFromDisplay(20), direction: 'out', reason: 'استهلاك', ctx: env.ctx })
    const recurred = listNotifications(env.ctx.session).items.find((i) => i.key === `low_stock:${materialId}`)
    expect(recurred).toBeDefined()
    expect(recurred!.read).toBe(false)
  })
})

describe('6 — RBAC: a category only ever appears for a caller who holds its own existing permission', () => {
  it('a role without inventory.view never sees low-stock alerts, even though they exist', () => {
    seedMaterial(10, 5)
    const roleId = createRole({ name: unique('sales-only'), permissions: [P.orders.view] }, env.ctx)
    const username = unique('salesuser')
    createUser({ username, password: 'secret789', fullName: 'مندوب مبيعات', roleId }, env.ctx)
    const { session } = login(username, 'secret789', 2)

    const { items } = listNotifications(session)
    expect(items.some((i) => i.category === 'low_stock')).toBe(false)
  })

  it('a role without orders.view never sees incomplete-order alerts, even though they exist', () => {
    seedConfirmedOrder()
    const roleId = createRole({ name: unique('inventory-only'), permissions: [P.inventory.view] }, env.ctx)
    const username = unique('storekeeper')
    createUser({ username, password: 'secret789', fullName: 'أمين مخزن', roleId }, env.ctx)
    const { session } = login(username, 'secret789', 3)

    const { items } = listNotifications(session)
    expect(items.some((i) => i.category === 'incomplete_order')).toBe(false)
  })

  it('a role with neither permission sees nothing at all', () => {
    seedMaterial(10, 5)
    seedConfirmedOrder()
    const roleId = createRole({ name: unique('no-access'), permissions: [] }, env.ctx)
    const username = unique('outsider')
    createUser({ username, password: 'secret789', fullName: 'بدون صلاحيات', roleId }, env.ctx)
    const { session } = login(username, 'secret789', 4)

    expect(listNotifications(session).items).toEqual([])
  })

  it('read state is per-user — one user marking read never affects another user\'s badge', () => {
    seedMaterial(10, 5)
    const roleId = createRole({ name: unique('inv-role'), permissions: [P.inventory.view] }, env.ctx)
    const userA = unique('userA')
    const userB = unique('userB')
    createUser({ username: userA, password: 'secret789', fullName: 'أ', roleId }, env.ctx)
    createUser({ username: userB, password: 'secret789', fullName: 'ب', roleId }, env.ctx)
    const sessionA = login(userA, 'secret789', 5).session
    const sessionB = login(userB, 'secret789', 6).session

    markAllNotificationsRead(sessionA)

    expect(listNotifications(sessionA).unreadCount).toBe(0)
    expect(listNotifications(sessionB).unreadCount).toBe(1)
  })
})

describe('7 — database integrity', () => {
  it('leaves foreign_key_check clean and integrity_check ok after a full notification lifecycle', () => {
    const materialId = seedMaterial(10, 5)
    seedConfirmedOrder()
    markAllNotificationsRead(env.ctx.session)
    adjustStock({ materialId, qtyMicro: quantityFromDisplay(20), direction: 'in', reason: 'تجديد', ctx: env.ctx })
    listNotifications(env.ctx.session)

    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})

describe('8 — persistent, data-safe dismissal', () => {
  it('individual dismissal removes only the selected notification and updates the count', () => {
    const materialId = seedMaterial(10, 5)
    const order = seedConfirmedOrder()
    const before = listNotifications(env.ctx.session)
    expect(before.items).toHaveLength(2)

    expect(dismissNotification(env.ctx.session, `low_stock:${materialId}`)).toBe(true)

    const after = listNotifications(env.ctx.session)
    expect(after.items.map((item) => item.key)).toEqual([`incomplete_order:${order.id}`])
    expect(after.unreadCount).toBe(1)
  })

  it('dismissing the final notification produces the empty state data contract', () => {
    const materialId = seedMaterial(10, 5)
    expect(dismissNotification(env.ctx.session, `low_stock:${materialId}`)).toBe(true)
    expect(listNotifications(env.ctx.session)).toEqual({ items: [], unreadCount: 0 })
  })

  it('clear all dismisses every current notification', () => {
    seedMaterial(10, 5)
    seedConfirmedOrder()
    expect(clearAllNotifications(env.ctx.session)).toBe(2)
    expect(listNotifications(env.ctx.session)).toEqual({ items: [], unreadCount: 0 })
  })

  it('a dismissal survives closing and reopening the SQLite connection (renderer/app restart)', () => {
    const materialId = seedMaterial(10, 5)
    dismissNotification(env.ctx.session, `low_stock:${materialId}`)

    closeDatabase()

    expect(listNotifications(env.ctx.session)).toEqual({ items: [], unreadCount: 0 })
  })

  it('never changes the material, stock, reorder level, or inventory ledger', () => {
    const materialId = seedMaterial(10, 5)
    const db = getRawConnection()
    const beforeMaterial = db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId)
    const beforeMovements = db.prepare('SELECT * FROM inventory_movements WHERE material_id = ? ORDER BY id').all(materialId)
    const beforeLayers = db.prepare('SELECT * FROM fifo_layers WHERE material_id = ? ORDER BY id').all(materialId)

    dismissNotification(env.ctx.session, `low_stock:${materialId}`)

    expect(db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId)).toEqual(beforeMaterial)
    expect(db.prepare('SELECT * FROM inventory_movements WHERE material_id = ? ORDER BY id').all(materialId)).toEqual(beforeMovements)
    expect(db.prepare('SELECT * FROM fifo_layers WHERE material_id = ? ORDER BY id').all(materialId)).toEqual(beforeLayers)
  })

  it('is scoped per user', () => {
    const materialId = seedMaterial(10, 5)
    const roleId = createRole({ name: unique('inv-dismiss-role'), permissions: [P.inventory.view] }, env.ctx)
    const userA = unique('dismissA')
    const userB = unique('dismissB')
    createUser({ username: userA, password: 'secret789', fullName: 'أ', roleId }, env.ctx)
    createUser({ username: userB, password: 'secret789', fullName: 'ب', roleId }, env.ctx)
    const sessionA = login(userA, 'secret789', 7).session
    const sessionB = login(userB, 'secret789', 8).session

    dismissNotification(sessionA, `low_stock:${materialId}`)

    expect(listNotifications(sessionA).items).toEqual([])
    expect(listNotifications(sessionB).items.map((item) => item.key)).toEqual([`low_stock:${materialId}`])
  })

  it('allows a genuinely new occurrence after the prior condition resolves', () => {
    const materialId = seedMaterial(10, 5)
    dismissNotification(env.ctx.session, `low_stock:${materialId}`)
    expect(listNotifications(env.ctx.session).items).toEqual([])

    adjustStock({ materialId, qtyMicro: quantityFromDisplay(20), direction: 'in', reason: 'حل النقص', ctx: env.ctx })
    expect(listNotifications(env.ctx.session).items).toEqual([])

    adjustStock({ materialId, qtyMicro: quantityFromDisplay(20), direction: 'out', reason: 'حدث نقص جديد', ctx: env.ctx })
    const recurred = listNotifications(env.ctx.session)
    expect(recurred.items.map((item) => item.key)).toEqual([`low_stock:${materialId}`])
    expect(recurred.unreadCount).toBe(1)
  })

  it('detects resolution between polls, so recurrence returns after app inactivity', () => {
    const materialId = seedMaterial(10, 5)
    dismissNotification(env.ctx.session, `low_stock:${materialId}`)

    // Both business events happen without listNotifications() observing
    // the healthy interval in between (as when the app is closed).
    adjustStock({ materialId, qtyMicro: quantityFromDisplay(20), direction: 'in', reason: 'حل النقص أثناء الإغلاق', ctx: env.ctx })
    adjustStock({ materialId, qtyMicro: quantityFromDisplay(20), direction: 'out', reason: 'نقص جديد أثناء الإغلاق', ctx: env.ctx })

    expect(listNotifications(env.ctx.session).items.map((item) => item.key)).toEqual([`low_stock:${materialId}`])
  })
})
