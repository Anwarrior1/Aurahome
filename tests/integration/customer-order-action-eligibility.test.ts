import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { savePlannedMaterials } from '@main/services/planning/planning.service'
import { createFinalInvoice, approveFinalInvoice, orderPaymentPosition } from '@main/services/sales/final-invoices.service'
import { archiveOrder, cancelOrder, deleteOrder, fullDeleteOrder, fullDeletePreview, getOrder, listOrders, recordPayment, refundPayment } from '@main/services/sales/orders.service'
import { issueWorkSheet, completeProduction, issueRelease, recordDelivery, reverseWorkSheet, getProductionOrder, deleteProductionOrder } from '@main/services/production/production.service'
import { createAccount } from '@main/services/finance/cash.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import type { ServiceContext } from '@main/services/base/service.types'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 29000
let event: IpcMainInvokeEvent
beforeEach(async () => {
  env = setupTestDatabase()
  event = { sender: { id: ++windowId } } as IpcMainInvokeEvent
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})
afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})
function authenticate(permissions: string[]): ServiceContext {
  const roleId = createRole({ name: 'Action eligibility', permissions }, env.ctx)
  createUser({ username: 'actions', fullName: 'Actions', password: 'secret123', roleId }, env.ctx)
  const { session } = login('actions', 'secret123', windowId)
  return { session }
}
function call(channel: string, request: unknown) { return handlers.get(channel)!(event, request) }
function seed(paidMinor = 0) {
  const customerId = createCustomer({ name: 'Action matrix customer' }, env.ctx)
  const accountId = createAccount({ name: 'Action matrix cash', kind: 'cash' }, env.ctx)
  const invoice = createFinalInvoice({ customerId, paidAmountMinor: paidMinor, initialCashAccountId: accountId, requiresDelivery: true, depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'Order', quantityMicro: q(1), unitPriceMinor: m(10000) }] }, env.ctx)
  const approval = approveFinalInvoice(invoice.id, env.ctx)
  return { ...approval, accountId, invoiceId: invoice.id }
}
function richOrder(status: 'completed' | 'cancelled') {
  const f = seed(status === 'completed' ? m(3000) : 0)
  const categoryId = createCategory({ name: 'Archive material' }, env.ctx)
  const materialId = createMaterial({ sku: 'ARCHIVE', name: 'Board', categoryId, unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(10) }, env.ctx)
  const supplierId = createSupplier({ name: 'Archive supplier' }, env.ctx)
  createPurchase({ supplierId, customerOrderId: f.orderId, lines: [{ materialId, qtyMicro: q(10), unitCostMicro: c(10) }] }, env.ctx)
  savePlannedMaterials({ orderId: f.orderId }, [{ materialId, materialName: 'Board', qtyMicro: q(5), estimatedUnitCostMicro: c(10) }], env.ctx)
  const sheet = issueWorkSheet({ orderId: f.orderId }, env.ctx)
  if (status === 'completed') {
    recordPayment({ orderId: f.orderId, amountMinor: m(7000), cashAccountId: f.accountId }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    const release = issueRelease({ orderId: f.orderId, kind: 'transport' }, env.ctx)
    recordDelivery({ orderId: f.orderId, releaseId: release.id, kind: 'delivery', actualCostMinor: m(50) }, env.ctx)
  } else {
    completeProduction(sheet.id, env.ctx)
    cancelOrder({ orderId: f.orderId, reason: 'Customer cancellation' }, env.ctx)
  }
  expect(getOrder(f.orderId).order.status).toBe(status)
  return f
}
/** Every database table except lifecycle metadata and its append-only audit. */
function history() {
  const raw = getRawConnection()
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('orders', 'audit_log', 'sqlite_sequence') ORDER BY name").all() as { name: string }[]
  return Object.fromEntries(tables.map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}

describe('Customer Order canonical action matrix', () => {
  it.each([1, m(3000), m(10000) - 1])('blocks pre-manufacturing cancellation and deletion for positive net payment (paid=%i)', (paid) => {
    const f = seed(paid)
    expect(listOrders({}).items[0]).toMatchObject({ canDeleteCancel: false, canCancel: false, canArchive: false })
    const before = history()
    expect(() => cancelOrder({ orderId: f.orderId, reason: 'Blocked money' }, env.ctx)).toThrow(/قبل (إصدار|اكتمال)/)
    expect(() => deleteOrder(f.orderId, env.ctx)).toThrow(/استرداد كامل/)
    expect(() => fullDeleteOrder({ id: f.orderId, confirmation: f.orderNumber }, env.ctx)).toThrow(/استرداد كامل/)
    expect(history()).toEqual(before)
  })
  it('allows cancellation only after manufacturing completion despite a stale payment cache', async () => {
    const f = seed()
    getRawConnection().prepare('UPDATE orders SET paid_minor = ?, deposit_required_minor = ?, deposit_percent_bp = 3000 WHERE id = ?').run(m(3000), m(3000), f.orderId)
    expect(orderPaymentPosition(f.orderId)).toMatchObject({ paidMinor: 0, remainingMinor: m(10000) })
    expect(listOrders({}).items[0]).toMatchObject({ canCancel: false, canDeleteCancel: false, canArchive: false })
    expect(getOrder(f.orderId).actions.canCancel).toBe(false)
    const sheet = issueWorkSheet({ orderId: f.orderId, overrideDepositRequirement: true }, env.ctx)
    expect(getOrder(f.orderId).actions.canCancel).toBe(false)
    completeProduction(sheet.id, env.ctx)
    expect(listOrders({}).items[0]).toMatchObject({ canCancel: true, canDeleteCancel: false })
    expect(getOrder(f.orderId).actions.canCancel).toBe(true)
    authenticate([P.orders.cancel])
    expect(await call(C.orders.cancel, { orderId: f.orderId, reason: 'Ledger is unpaid', paidMinor: m(3000), remainingMinor: m(7000) })).toMatchObject({ ok: true })
    expect(getOrder(f.orderId).order.status).toBe('cancelled')
  })
  it('blocks pre-manufacturing cancellation even when the cached paid amount is zero', () => {
    const f = seed(m(3000))
    getRawConnection().prepare('UPDATE orders SET paid_minor = 0 WHERE id = ?').run(f.orderId)
    expect(getOrder(f.orderId).actions.canCancel).toBe(false)
    expect(() => cancelOrder({ orderId: f.orderId, reason: 'Real posted payment' }, env.ctx)).toThrow(/قبل (إصدار|اكتمال)/)
  })
  it('removes only the payment blocker after a full refund and does not cancel or delete automatically', () => {
    const f = seed(m(3000))
    refundPayment({ orderId: f.orderId, amountMinor: m(3000), cashAccountId: f.accountId, requestKey: crypto.randomUUID() }, env.ctx)
    expect(orderPaymentPosition(f.orderId).paidMinor).toBe(0)
    expect(getOrder(f.orderId)).toMatchObject({ order: { status: 'confirmed' }, actions: { canCancel: false, canDeleteCancel: false, canRefundPayment: false, refundableMinor: 0 } })
    expect(() => cancelOrder({ orderId: f.orderId, reason: 'Explicit action after refund' }, env.ctx)).toThrow(/قبل إصدار/)
    expect(() => fullDeleteOrder({ id: f.orderId, confirmation: f.orderNumber }, env.ctx)).toThrow(/سجل تجاري مُرحّل/)
    expect(getOrder(f.orderId).order.id).toBe(f.orderId)
  })
  it('preserves an unpaid confirmed order because approval is posted history', () => {
    const f = seed()
    expect(() => deleteOrder(f.orderId, env.ctx)).toThrow(/سجل تجاري مُرحّل/)
    expect(getOrder(f.orderId).order.id).toBe(f.orderId)
  })
  it.each(['confirmed', 'completed', 'cancelled', 'awaiting_approval', 'archived'])('rejects all destructive entries for ineligible %s orders', (state) => {
    const f = seed(state === 'confirmed' ? m(10000) : 0)
    const raw = getRawConnection()
    if (state === 'archived') raw.prepare("UPDATE orders SET archived_at = '2026-09-14' WHERE id = ?").run(f.orderId)
    else if (state !== 'confirmed') raw.prepare('UPDATE orders SET status = ? WHERE id = ?').run(state, f.orderId)
    const before = history(), order = getOrder(f.orderId).order
    // CC02B: an unapproved invoice's order is not in the active list at all.
    if (state === 'awaiting_approval') expect(listOrders({ includeArchived: true }).items).toHaveLength(0)
    else expect(listOrders({ includeArchived: true }).items[0].canDeleteCancel).toBe(false)
    for (const operation of [() => cancelOrder({ orderId: f.orderId, reason: 'Bypass' }, env.ctx), () => deleteOrder(f.orderId, env.ctx), () => fullDeleteOrder({ id: f.orderId, confirmation: f.orderNumber }, env.ctx)]) expect(operation).toThrow(/لا يمكن (حذف|إلغاء) الطلب/)
    expect(getOrder(f.orderId).order).toEqual(order)
    expect(history()).toEqual(before)
  })
  it('uses ledger totals despite stale order payment caches, including overpayment', () => {
    const f = seed(m(10000))
    getRawConnection().prepare("UPDATE orders SET paid_minor = 0, remaining_minor = ?, payment_status = 'unpaid' WHERE id = ?").run(m(10000), f.orderId)
    expect(orderPaymentPosition(f.orderId).remainingMinor).toBe(0)
    expect(listOrders({}).items[0]).toMatchObject({ canDeleteCancel: false, canCancel: false })
    expect(() => cancelOrder({ orderId: f.orderId, reason: 'Stale cache' }, env.ctx)).toThrow()
    getRawConnection().prepare('UPDATE customer_payments SET amount_minor = amount_minor + 1 WHERE order_id = ?').run(f.orderId)
    expect(orderPaymentPosition(f.orderId).remainingMinor).toBe(-1)
    expect(listOrders({}).items[0]).toMatchObject({ canDeleteCancel: false, canCancel: false })
    expect(() => deleteOrder(f.orderId, env.ctx)).toThrow()
  })
  it('fully paying remains confirmed, active, and operational, with neither lifecycle action', () => {
    const f = seed(m(3000))
    recordPayment({ orderId: f.orderId, amountMinor: m(7000), cashAccountId: f.accountId }, env.ctx)
    expect(getOrder(f.orderId).order).toMatchObject({ status: 'confirmed', completedAt: null, archivedAt: null })
    expect(listOrders({}).items[0]).toMatchObject({ id: f.orderId, canDeleteCancel: false, canArchive: false })
    expect(() => archiveOrder({ id: f.orderId, archive: true }, env.ctx)).toThrow(/مكتمل أو ملغى/)
    expect(issueWorkSheet({ orderId: f.orderId }, env.ctx).id).toBeGreaterThan(0)
    expect(getOrder(f.orderId).order.status).toBe('confirmed')
  })
  it.each(['completed', 'cancelled'] as const)('archives/restores %s via the same implementation without any historical, financial, inventory or cost effect', (status) => {
    const f = richOrder(status)
    const before = history(), order = getOrder(f.orderId).order, costs = orderCostBreakdown(f.orderId)
    expect(listOrders({}).items[0]).toMatchObject({ canDeleteCancel: false, canArchive: true })
    archiveOrder({ id: f.orderId, archive: true }, env.ctx)
    expect(listOrders({}).items).toEqual([])
    expect(listOrders({ archived: true }).items[0]).toMatchObject({ id: f.orderId, documentNumber: f.orderNumber, canDeleteCancel: false, canArchive: false })
    expect(getOrder(f.orderId).order).toEqual({ ...order, archivedAt: expect.any(String), archivedBy: env.ctx.session.user.id })
    expect(history()).toEqual(before)
    expect(orderCostBreakdown(f.orderId)).toEqual(costs)
    archiveOrder({ id: f.orderId, archive: false }, env.ctx)
    expect(getOrder(f.orderId).order).toEqual(order)
    expect(listOrders({}).items[0].id).toBe(f.orderId)
    expect(history()).toEqual(before)
  })
  it.each(['confirmed', 'awaiting_approval'])('rejects archive of %s regardless of payment', (status) => {
    const f = seed()
    getRawConnection().prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, f.orderId)
    expect(() => archiveOrder({ id: f.orderId, archive: true }, env.ctx)).toThrow()
    expect(listOrders({}).items).toHaveLength(status === 'awaiting_approval' ? 0 : 1)
  })
  it.each(['confirmed', 'completed', 'cancelled', 'archived', 'awaiting_approval'])('direct IPC cannot reach destructive operations/dialog previews for ineligible %s', async (state) => {
    const f = seed(state === 'confirmed' ? m(10000) : 0)
    if (state === 'archived') getRawConnection().prepare("UPDATE orders SET archived_at = '2026-09-14' WHERE id = ?").run(f.orderId)
    else if (state !== 'confirmed') getRawConnection().prepare('UPDATE orders SET status = ? WHERE id = ?').run(state, f.orderId)
    authenticate([P.orders.cancel, P.orders.fullDelete, P.orders.view, P.orders.archive])
    const before = history(), order = getOrder(f.orderId).order
    for (const [channel, request] of [[C.orders.cancel, { orderId: f.orderId, reason: 'Bypass', remainingMinor: m(10000), status: 'confirmed' }], [C.orders.remove, { id: f.orderId }], [C.orders.fullDelete, { id: f.orderId, confirmation: f.orderNumber }], [C.orders.deletionBlockers, { id: f.orderId }], [C.orders.fullDeletePreview, { id: f.orderId }]] as const) {
      expect(await call(channel, request)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    }
    expect(history()).toEqual(before)
    expect(getOrder(f.orderId).order).toEqual(order)
  })
  it('direct IPC rejects archive for fully paid confirmed orders', async () => {
    const f = seed(m(10000))
    authenticate([P.orders.archive])
    expect(await call(C.orders.archive, { id: f.orderId, status: 'completed' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(listOrders({}).items).toHaveLength(1)
  })
  it.each(['completed', 'cancelled'] as const)('authorized direct IPC archives %s', async (status) => {
    const f = richOrder(status)
    authenticate([P.orders.archive])
    const before = history()
    expect(await call(C.orders.archive, { id: f.orderId })).toMatchObject({ ok: true })
    expect(history()).toEqual(before)
  })
  it('business eligibility never replaces service or IPC authorization', async () => {
    const f = seed()
    const ctx = authenticate([P.orders.view, P.orders.manage])
    for (const operation of [() => cancelOrder({ orderId: f.orderId, reason: 'No permission' }, ctx), () => deleteOrder(f.orderId, ctx), () => fullDeleteOrder({ id: f.orderId, confirmation: f.orderNumber }, ctx)]) expect(operation).toThrow(/صلاحية/)
    for (const [channel, request] of [[C.orders.cancel, { orderId: f.orderId, reason: 'No permission' }], [C.orders.remove, { id: f.orderId }], [C.orders.fullDelete, { id: f.orderId, confirmation: f.orderNumber }]] as const) expect(await call(channel, request)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    completeProduction(issueWorkSheet({ orderId: f.orderId }, env.ctx).id, env.ctx)
    cancelOrder({ orderId: f.orderId, reason: 'Owner permitted' }, env.ctx)
    expect(() => archiveOrder({ id: f.orderId, archive: true }, ctx)).toThrow(/صلاحية/)
    expect(await call(C.orders.archive, { id: f.orderId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
  it('direct IPC requires the exact order number and then uses the canonical guarded full delete', async () => {
    const wrong = seed()
    authenticate([P.orders.fullDelete])
    expect(await call(C.orders.fullDelete, { id: wrong.orderId, confirmation: ` ${wrong.orderNumber} ` })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
    expect(getOrder(wrong.orderId).order.id).toBe(wrong.orderId)

    expect(await call(C.orders.fullDelete, { id: wrong.orderId, confirmation: wrong.orderNumber })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(getOrder(wrong.orderId).order.id).toBe(wrong.orderId)
  })
  it('revalidates stale delete previews after issuance and rejects direct IPC regardless of delete permission', async () => {
    const f = seed()
    expect(getOrder(f.orderId).actions).toMatchObject({ canCancel: false, canDeleteCancel: false, canRefundPayment: false })
    fullDeletePreview(f.orderId)
    const sheet = issueWorkSheet({ orderId: f.orderId }, env.ctx)
    expect(getOrder(f.orderId).actions).toMatchObject({ canCancel: false, canDeleteCancel: false, canRefundPayment: false })
    authenticate([P.orders.fullDelete, P.orders.cancel])
    expect(await call(C.orders.cancel, { orderId: f.orderId, reason: 'Stale renderer', status: 'completed', paidMinor: 0, manufacturingCompleted: true })).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringMatching(/قبل بدء/) } })
    for (const [channel, request] of [[C.orders.fullDelete, { id: f.orderId, confirmation: f.orderNumber }], [C.orders.remove, { id: f.orderId }], [C.orders.fullDeletePreview, { id: f.orderId }]] as const)
      expect(await call(channel, request)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    completeProduction(sheet.id, env.ctx)
    expect(getOrder(f.orderId).actions).toMatchObject({ canCancel: true, canDeleteCancel: false })
    expect(await call(C.orders.cancel, { orderId: f.orderId, reason: 'After production completion' })).toMatchObject({ ok: true })
  })
  it('retains the issuance boundary after real Manufacturing Order reversal and blocks worksheet deletion', () => {
    const f = seed()
    const sheet = issueWorkSheet({ orderId: f.orderId }, env.ctx)
    expect(() => deleteProductionOrder(sheet.id, env.ctx)).toThrow(/مستند تشغيلي مُصدر/)
    reverseWorkSheet({ id: sheet.id, expectedToken: getProductionOrder(sheet.id).reversalToken, confirmation: sheet.documentNumber, reason: 'Explicit reversal' }, env.ctx)
    expect(getProductionOrder(sheet.id).sheet.status).toBe('reversed')
    expect(getOrder(f.orderId).actions).toMatchObject({ canCancel: false, canDeleteCancel: false, canRefundPayment: false })
    expect(() => fullDeleteOrder({ id: f.orderId, confirmation: f.orderNumber }, env.ctx)).toThrow(/بعد إصدار/)
  })
  it.each([0, 1, m(3000), m(10000)])('allows completed-manufacturing cancellation regardless of net payment (paid=%i) without financial/history changes', async (paid) => {
    const f = seed(paid)
    const sheet = issueWorkSheet({ orderId: f.orderId }, env.ctx)
    expect(getOrder(f.orderId).actions).toMatchObject({ canCancel: false, canDeleteCancel: false, canRefundPayment: false })
    completeProduction(sheet.id, env.ctx)
    expect(getOrder(f.orderId).order.status).toBe('confirmed')
    expect(getOrder(f.orderId).actions).toMatchObject({ canCancel: true, canDeleteCancel: false, canRefundPayment: false })
    expect(listOrders({}).items[0].canCancel).toBe(true)
    const raw = getRawConnection()
    const tables = ['work_sheets', 'customer_payments', 'customer_payment_refunds', 'customer_payment_refund_allocations', 'cash_transactions', 'final_invoices', 'final_invoice_lines', 'order_material_lines', 'inventory_movements', 'fifo_layers', 'fifo_allocations', 'material_returns']
    const rows = () => tables.map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = rows(), cost = orderCostBreakdown(f.orderId), position = orderPaymentPosition(f.orderId)
    authenticate([P.orders.cancel])
    expect(await call(C.orders.cancel, { orderId: f.orderId, reason: 'Completed undelivered cancellation' })).toMatchObject({ ok: true })
    expect(getOrder(f.orderId).order).toMatchObject({ status: 'cancelled', paidMinor: paid })
    expect(rows()).toEqual(before)
    expect(orderPaymentPosition(f.orderId)).toEqual(position)
    expect(orderCostBreakdown(f.orderId)).toEqual({ ...cost,
      actualProfitMinor: Math.max(paid - cost.totalActualCostMinor, 0) })
    expect(raw.prepare("SELECT action FROM audit_log WHERE action = 'orders.cancel' AND entity_id = ?").all(String(f.orderId))).toHaveLength(1)
    expect(await call(C.orders.cancel, { orderId: f.orderId, reason: 'Replay' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
  })
  it('completion eligibility does not grant cancellation permission', async () => {
    const f = seed(m(3000))
    completeProduction(issueWorkSheet({ orderId: f.orderId }, env.ctx).id, env.ctx)
    expect(getOrder(f.orderId).actions.canCancel).toBe(true)
    const ctx = authenticate([P.orders.fullDelete, P.orders.view])
    expect(() => cancelOrder({ orderId: f.orderId, reason: 'No cancel permission' }, ctx)).toThrow(/صلاحية/)
    expect(await call(C.orders.cancel, { orderId: f.orderId, reason: 'No cancel permission' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(() => fullDeleteOrder({ id: f.orderId, confirmation: f.orderNumber }, ctx)).toThrow(/لا يمكن حذف/)
  })
  it('recorded physical fulfilment completes the order and blocks cancellation', async () => {
    const f = seed(m(10000))
    completeProduction(issueWorkSheet({ orderId: f.orderId }, env.ctx).id, env.ctx)
    const release = issueRelease({ orderId: f.orderId, kind: 'transport' }, env.ctx)
    recordDelivery({ orderId: f.orderId, releaseId: release.id, kind: 'delivery' }, env.ctx)
    expect(getOrder(f.orderId).order.status).toBe('completed')
    expect(getOrder(f.orderId).actions.canCancel).toBe(false)
    expect(listOrders({}).items[0].canCancel).toBe(false)
    authenticate([P.orders.cancel])
    const before = history()
    expect(await call(C.orders.cancel, { orderId: f.orderId, reason: 'Already partially fulfilled' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(history()).toEqual(before)
  })
  it('serializes delete against a second SQLite writer issuing a linked Manufacturing Order', () => {
    const f = seed()
    const raw = getRawConnection()
    const file = (raw.pragma('database_list') as Array<{ name: string; file: string }>).find(row => row.name === 'main')!.file
    const issuer = new Database(file)
    issuer.pragma('foreign_keys = ON')
    raw.pragma('busy_timeout = 1')
    try {
      issuer.exec('BEGIN IMMEDIATE')
      issuer.prepare("INSERT INTO work_sheets (document_number, order_id, status, issued_at) VALUES (?, ?, 'ready', ?)").run('CONCURRENT-MO', f.orderId, new Date().toISOString())
      // The renderer/initial preflight cannot see the uncommitted issuance.
      expect(getOrder(f.orderId).actions.canDeleteCancel).toBe(false)
      expect(() => fullDeleteOrder({ id: f.orderId, confirmation: f.orderNumber }, env.ctx)).toThrow(/locked/)
      issuer.exec('COMMIT')
      expect(() => fullDeleteOrder({ id: f.orderId, confirmation: f.orderNumber }, env.ctx)).toThrow(/بعد إصدار/)
      expect(getOrder(f.orderId).actions.canDeleteCancel).toBe(false)
    } finally {
      if (issuer.inTransaction) issuer.exec('ROLLBACK')
      issuer.close()
    }
  })
  it('a stale reader cannot turn the posted-history guard into a deletion', () => {
    const f = seed()
    const raw = getRawConnection()
    const file = (raw.pragma('database_list') as Array<{ name: string; file: string }>).find(row => row.name === 'main')!.file
    const issuer = new Database(file)
    issuer.pragma('foreign_keys = ON')
    issuer.pragma('busy_timeout = 1')
    try {
      issuer.exec('BEGIN')
      expect(issuer.prepare('SELECT id FROM orders WHERE id = ?').get(f.orderId)).toEqual({ id: f.orderId })
      expect(() => fullDeleteOrder({ id: f.orderId, confirmation: f.orderNumber }, env.ctx)).toThrow(/سجل تجاري مُرحّل/)
      issuer.prepare("INSERT INTO work_sheets (document_number, order_id, status, issued_at) VALUES (?, ?, 'ready', ?)").run('STALE-MO', f.orderId, new Date().toISOString())
      issuer.exec('COMMIT')
      expect(raw.prepare('SELECT id FROM orders WHERE id = ?').get(f.orderId)).toEqual({ id: f.orderId })
      expect(raw.prepare('SELECT id FROM work_sheets WHERE order_id = ?').all(f.orderId)).toHaveLength(1)
    } finally {
      if (issuer.inTransaction) issuer.exec('ROLLBACK')
      issuer.close()
    }
  })
  it('issuance can continue after a refused permanent delete because the order survives', () => {
    const f = seed()
    expect(() => fullDeleteOrder({ id: f.orderId, confirmation: f.orderNumber }, env.ctx)).toThrow(/سجل تجاري مُرحّل/)
    expect(issueWorkSheet({ orderId: f.orderId }, env.ctx).id).toBeGreaterThan(0)
    expect(getRawConnection().prepare('SELECT id FROM work_sheets WHERE order_id = ?').all(f.orderId)).toHaveLength(1)
  })
  it('opening and closing the delete dialog is a read-only preview with no audit or business mutation', () => {
    const f = seed()
    const orderBefore = getOrder(f.orderId)
    const historyBefore = history()
    const auditBefore = (getRawConnection().prepare('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number }).count

    expect(fullDeletePreview(f.orderId)).toMatchObject({ orderId: f.orderId, documentNumber: f.orderNumber })
    // Closing is renderer-local state only; no mutation endpoint is called.
    expect(getOrder(f.orderId)).toEqual(orderBefore)
    expect(history()).toEqual(historyBefore)
    expect((getRawConnection().prepare('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number }).count).toBe(auditBefore)
  })
  it('authorized IPC rejects pre-manufacturing cancellation', async () => {
    const f = seed()
    authenticate([P.orders.cancel])
    const before = history()
    expect(await call(C.orders.cancel, { orderId: f.orderId, reason: 'Canonical unpaid cancellation' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(getOrder(f.orderId).order.status).toBe('confirmed')
    expect(history()).toEqual(before)
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
