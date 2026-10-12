import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice, unapproveFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder, recordPayment, transferCancelledOrderOutput } from '@main/services/sales/orders.service'
import { issueWorkSheet, startProduction, consumeForOrder, completeProduction, issueRelease, recordDelivery } from '@main/services/production/production.service'
import * as uncollected from '@main/services/sales/uncollected-products.service'
import { monthlyProfitSummary, cumulativeNetProfitMinor, availableProfitMinor } from '@main/services/finance/profit.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'
let env: TestEnv
let material: number
let previousTz: string | undefined
const raw = () => getRawConnection()
function snapshot() {
  return Object.fromEntries((raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
beforeEach(() => {
  previousTz = process.env.TZ; process.env.TZ = 'Africa/Tripoli'
  env = setupTestDatabase(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-30T22:30:00.000Z'))
  material = createMaterial({ sku: 'BOARD', name: 'Board', unit: 'board', pricingRule: 'exact', categoryId: createCategory({ name: 'Boards' }, env.ctx), currentMarketPriceMicro: c(100) }, env.ctx)
  createPurchase({ supplierId: createSupplier({ name: 'Supplier' }, env.ctx), lines: [{ materialId: material, qtyMicro: q(1000), unitCostMicro: c(100) }] }, env.ctx)
})
afterEach(() => {
  vi.useRealTimers()
  try { expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); expect(raw().pragma('foreign_key_check')).toEqual([]) } finally { env.cleanup(); if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz }
})
function source(cost = 1000, retained = 0) {
  const invoice = createFinalInvoice({ customerId: createCustomer({ name: 'Source' }, env.ctx), depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'Cabinet', quantityMicro: q(1), unitPriceMinor: m(10000) }] }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  if (retained) recordPayment({ orderId: order.id, amountMinor: m(retained) }, env.ctx)
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx); startProduction(sheet.id, env.ctx)
  consumeForOrder({ workSheetId: sheet.id, materialId: material, physicalQtyMicro: q(cost / 100) }, env.ctx)
  return { order: order.id, sheet: sheet.id }
}
function transferInput(orderId: number) {
  return { orderId, cancelReason: 'Forged transfer', actualCostMinor: 0, costComponents: { materialMinor: 0, machineMinor: 0, workerMinor: 0, deliveryMinor: 0, expenseMinor: 0 } }
}
function product(f: ReturnType<typeof source>) { return uncollected.productsFromOrder(f.order)[0]!.id }
function sell(id: number) {
  const invoice = createFinalInvoice({ customerId: createCustomer({ name: 'Buyer' }, env.ctx), lines: [{ lineKind: 'custom', description: 'Existing cabinet', quantityMicro: q(1), unitPriceMinor: m(5000), uncollectedProductId: id }] }, env.ctx)
  return { invoice: invoice.id, order: approveToOrder(invoice.id, env.ctx).id }
}
function denied(invoke: () => unknown) { const before = snapshot(); expect(invoke).toThrow(); expect(snapshot()).toEqual(before) }

describe('NEW-BL-05 Uncollected physical lifecycle ownership', () => {
  it('rejects confirmed completed source transfer with caller-supplied zero cost, including caller-created transactions', () => {
    const f = source(); completeProduction(f.sheet, env.ctx)
    denied(() => uncollected.transferManufacturedProducts(transferInput(f.order), env.ctx, () => []))
    denied(() => withTransaction(() => uncollected.transferManufacturedProducts(transferInput(f.order), env.ctx, () => [])))
    expect(uncollected.productsFromOrder(f.order)).toEqual([])
  })
  it('rejects early independent transfer; normal cancelled manufacturing completion freezes real 1,000 cost once', () => {
    const f = source(); cancelOrder({ orderId: f.order, reason: 'Abandoned' }, env.ctx)
    denied(() => uncollected.transferManufacturedProducts(transferInput(f.order), env.ctx, () => []))
    expect(uncollected.productsFromOrder(f.order)).toEqual([])
    completeProduction(f.sheet, env.ctx)
    expect(uncollected.productEconomics(product(f))?.actualCostMinor).toBe(m(1000))
    expect(raw().prepare('SELECT source_order_id AS source, source_work_sheet_id AS sheet, status FROM uncollected_products').get()).toEqual({ source: f.order, sheet: f.sheet, status: 'available' })
    denied(() => completeProduction(f.sheet, env.ctx)); denied(() => cancelOrder({ orderId: f.order, reason: 'Retry' }, env.ctx))
    const before = snapshot(); withTransaction(() => transferCancelledOrderOutput(f.order, 'Replay', env.ctx)); expect(snapshot()).toEqual(before)
  })
  it('completed-before-cancellation transfers correct cost once and ignores forged extra cost fields on valid replay', () => {
    const f = source(); completeProduction(f.sheet, env.ctx); cancelOrder({ orderId: f.order, reason: 'After completion' }, env.ctx)
    const before = snapshot()
    withTransaction(() => uncollected.transferManufacturedProducts(transferInput(f.order), env.ctx, () => []))
    expect(snapshot()).toEqual(before); expect(uncollected.productsFromOrder(f.order)).toHaveLength(1)
    expect(uncollected.productEconomics(product(f))?.actualCostMinor).toBe(m(1000))
  })
  it('rejects sold/delivered restoration without clearing ownership or changing economics', () => {
    const f = source(); cancelOrder({ orderId: f.order, reason: 'Abandoned' }, env.ctx); completeProduction(f.sheet, env.ctx)
    const id = product(f); const buyer = sell(id)
    const permit = issueRelease({ orderId: buyer.order, kind: 'delivery' }, env.ctx)
    recordDelivery({ orderId: buyer.order, releaseId: permit.id, kind: 'handover' }, env.ctx)
    const profit = cumulativeNetProfitMinor()
    denied(() => uncollected.releaseCancelledResale(buyer.order, 'Forged release', env.ctx))
    denied(() => withTransaction(() => uncollected.releaseCancelledResale(buyer.order, 'Forged release', env.ctx)))
    expect(raw().prepare('SELECT status, sold_order_id AS buyer FROM uncollected_products WHERE id=?').get(id)).toEqual({ status: 'sold', buyer: buyer.order })
    expect(() => uncollected.assertSellable(id, null)).toThrow(); expect(cumulativeNetProfitMinor()).toBe(profit)
    denied(() => cancelOrder({ orderId: buyer.order, reason: 'Delivered' }, env.ctx))
    expect(['releaseInvoiceProducts', 'markProductsSold', 'syncInvoiceReservations'].filter(name => name in uncollected)).toEqual([])
  })
  it('pre-delivery cancellation releases the same row once; Buyer B can later receive that physical item', () => {
    const f = source(); cancelOrder({ orderId: f.order, reason: 'Abandoned' }, env.ctx); completeProduction(f.sheet, env.ctx)
    const id = product(f); const a = sell(id); issueRelease({ orderId: a.order, kind: 'delivery' }, env.ctx)
    denied(() => withTransaction(() => uncollected.releaseCancelledResale(a.order, 'Independent', env.ctx)))
    cancelOrder({ orderId: a.order, reason: 'Before delivery' }, env.ctx)
    expect(raw().prepare('SELECT status, sold_order_id AS buyer FROM uncollected_products').get()).toEqual({ status: 'available', buyer: null })
    denied(() => cancelOrder({ orderId: a.order, reason: 'Repeat' }, env.ctx))
    const b = sell(id); const permit = issueRelease({ orderId: b.order, kind: 'delivery' }, env.ctx)
    recordDelivery({ orderId: b.order, releaseId: permit.id, kind: 'handover' }, env.ctx)
    expect(uncollected.productsFromOrder(f.order)).toHaveLength(1)
    expect(raw().prepare('SELECT id, status, sold_order_id AS buyer FROM uncollected_products').get()).toEqual({ id, status: 'sold', buyer: b.order })
  })
  it.each([[7000, 6000, 6000, 0, 1000], [6000, 8000, 6000, 2000, 0]])('preserves retained %i / actual %i economics', (retained, cost, covered, factory, margin) => {
    const f = source(cost, retained); cancelOrder({ orderId: f.order, reason: 'Abandoned' }, env.ctx); completeProduction(f.sheet, env.ctx)
    expect(uncollected.productEconomics(product(f))).toMatchObject({ actualCostMinor: m(cost), customerCoveredMinor: m(covered), factoryBorneMinor: m(factory) })
    expect(monthlyProfitSummary(2026, 9).netProfitMinor).toBe(0); expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(m(margin))
    expect(cumulativeNetProfitMinor()).toBe(m(margin)); expect(availableProfitMinor()).toBe(m(margin))
    expect(raw().prepare('SELECT COUNT(*) AS n FROM customer_payment_refunds').get()).toEqual({ n: 0 })
  })
  it('failure in transfer audit rolls back manufacturing completion and creation; retry yields one product', () => {
    const f = source(); cancelOrder({ orderId: f.order, reason: 'Abandoned' }, env.ctx)
    raw().exec("CREATE TRIGGER fail_transfer BEFORE INSERT ON audit_log WHEN NEW.action='uncollectedProducts.transfer' BEGIN SELECT RAISE(ABORT, 'injected transfer failure'); END")
    denied(() => completeProduction(f.sheet, env.ctx))
    expect(uncollected.productsFromOrder(f.order)).toEqual([])
    raw().exec('DROP TRIGGER fail_transfer'); completeProduction(f.sheet, env.ctx)
    expect(uncollected.productsFromOrder(f.order)).toHaveLength(1)
  })
  it('invoice unapproval/reapproval retains ownership; helper exports cannot bypass that owner', () => {
    const f = source(); cancelOrder({ orderId: f.order, reason: 'Abandoned' }, env.ctx); completeProduction(f.sheet, env.ctx)
    const id = product(f); const buyer = sell(id)
    unapproveFinalInvoice({ id: buyer.invoice, expectedRevision: 1 }, env.ctx)
    expect(raw().prepare('SELECT status, reserved_invoice_id AS invoice FROM uncollected_products').get()).toEqual({ status: 'reserved', invoice: buyer.invoice })
    approveFinalInvoice(buyer.invoice, env.ctx, 1)
    expect(raw().prepare('SELECT status, sold_order_id AS buyer FROM uncollected_products').get()).toEqual({ status: 'sold', buyer: buyer.order })
  })
  it('normal IPC cancellation/completion remains valid; forbidden IPC cannot mutate Uncollected', async () => {
    const f = source(); const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>()
    const electron = await import('electron'); const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
    const role = createRole({ name: 'Restricted', permissions: [] }, env.ctx); createUser({ username: 'restricted', password: 'secret123', fullName: 'Restricted', roleId: role }, env.ctx); login('restricted', 'secret123', 92)
    const invoke = (channel: string, input: unknown, id = 1) => handlers.get(channel)!({ sender: { id } } as IpcMainInvokeEvent, input)
    const before = snapshot()
    expect(await invoke(C.orders.cancel, { orderId: f.order, reason: 'Denied' }, 92)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(snapshot()).toEqual(before)
    expect(await invoke(C.orders.cancel, { orderId: f.order, reason: 'Abandoned' })).toMatchObject({ ok: true })
    expect(await invoke(C.production.completeProduction, { id: f.sheet })).toMatchObject({ ok: true })
    expect(uncollected.productsFromOrder(f.order)).toHaveLength(1)
    const buyer = sell(product(f)); const permit = issueRelease({ orderId: buyer.order, kind: 'delivery' }, env.ctx)
    recordDelivery({ orderId: buyer.order, releaseId: permit.id, kind: 'handover' }, env.ctx)
    const fulfilled = snapshot()
    expect(await invoke(C.orders.cancel, { orderId: buyer.order, reason: 'Invalid after delivery' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(snapshot()).toEqual(fulfilled)
    expect([...handlers.keys()].some(key => /transferManufacturedProducts|releaseCancelledResale|releaseInvoiceProducts/.test(key))).toBe(false)
  })
  it.each(['cancellation', 'completion'])('preserves the minimum legitimate %s owner permission', owner => {
    const f = source()
    const context = (permissions: string[]) => ({ ...env.ctx, session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions } })
    if (owner === 'cancellation') {
      completeProduction(f.sheet, env.ctx)
      cancelOrder({ orderId: f.order, reason: 'Cancelled by owner' }, context(['orders.cancel']))
    } else {
      cancelOrder({ orderId: f.order, reason: 'Abandoned' }, env.ctx)
      completeProduction(f.sheet, context(['worksheets.issue']))
    }
    expect(uncollected.productsFromOrder(f.order)).toHaveLength(1)
    expect(uncollected.productEconomics(product(f))?.actualCostMinor).toBe(m(1000))
  })
  it('rejects restricted direct transfer/release before any mutation even inside a caller transaction', () => {
    const f = source(); cancelOrder({ orderId: f.order, reason: 'Abandoned' }, env.ctx); completeProduction(f.sheet, env.ctx)
    const buyer = sell(product(f))
    const restricted = { ...env.ctx, session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [] } }
    const before = snapshot()
    for (const invoke of [() => uncollected.transferManufacturedProducts(transferInput(f.order), restricted, () => []), () => uncollected.releaseCancelledResale(buyer.order, 'Denied', restricted)]) {
      expect(() => withTransaction(invoke)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
      expect(snapshot()).toEqual(before)
    }
  })

})
