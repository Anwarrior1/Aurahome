import { createMachine, addMachineUsage } from '@main/services/production/machines.service'
import { createWorker, assignWorkerToOrder } from '@main/services/production/workers.service'
import { createExpense } from '@main/services/finance/expenses.service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import Database from 'better-sqlite3'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createAccount } from '@main/services/finance/cash.service'
import { createFinalInvoice, approveFinalInvoice, orderPaymentPosition } from '@main/services/sales/final-invoices.service'
import { cancelOrder, getOrder, recordPayment, archiveOrder, completeOrder } from '@main/services/sales/orders.service'
import { issueWorkSheet, completeProduction, consumeForOrder, getProductionOrder, issueRelease, recordDelivery, listOperationalWorkSheets, reverseWorkSheet } from '@main/services/production/production.service'
import { resumeOriginalOrder, productsFromOrder, availableUncollectedProducts, listUncollectedProducts, getUncollectedProduct, assertSellable } from '@main/services/sales/uncollected-products.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { moneyFromMajor as m } from '@shared/money/money'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 76000
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
function fixture(count = 1, withPermit = false) {
  const customerId = createCustomer({ name: 'Original customer' }, env.ctx)
  const otherCustomerId = createCustomer({ name: 'Resale customer' }, env.ctx)
  const accountId = createAccount({ name: 'Cash', kind: 'cash' }, env.ctx)
  const materialId = createMaterial({ name: 'Board', sku: 'RESUME-'+crypto.randomUUID(), categoryId: createCategory({ name: 'Board '+crypto.randomUUID() }, env.ctx), unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(100) }, env.ctx)
  createPurchase({ supplierId: createSupplier({ name: 'Supplier' }, env.ctx), lines: [{ materialId, qtyMicro: q(100), unitCostMicro: c(100) }] }, env.ctx)
  const invoice = createFinalInvoice({ customerId, paidAmountMinor: m(5400), initialCashAccountId: accountId, depositPercentBp: 0, requiresDelivery: true,
    lines: Array.from({ length: count }, (_, i) => ({ lineKind: 'custom' as const, description: 'Product '+i, quantityMicro: q(1), unitPriceMinor: m(9000 / count) })) }, env.ctx)
  const approval = approveFinalInvoice(invoice.id, env.ctx)
  const sheet = issueWorkSheet({ orderId: approval.orderId }, env.ctx)
  consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: q(10) }, env.ctx)
  addMachineUsage({ workSheetId: sheet.id, machineId: createMachine({ name: 'Machine', costingUnit: 'board', defaultRateMicro: c(30) }, env.ctx), usageQtyMicro: q(2) }, env.ctx)
  assignWorkerToOrder({ workSheetId: sheet.id, workerId: createWorker({ name: 'Worker' }, env.ctx), method: 'fixed', amountMinor: m(200) }, env.ctx)
  createExpense({ kind: 'variable', amountMinor: m(150), orderId: approval.orderId, cashAccountId: accountId, description: 'Original order expense' }, env.ctx)
  completeProduction(sheet.id, env.ctx)
  if (withPermit) {
    recordPayment({ orderId: approval.orderId, amountMinor: m(3600), cashAccountId: accountId }, env.ctx)
    issueRelease({ orderId: approval.orderId, kind: 'transport' }, env.ctx)
  }
  cancelOrder({ orderId: approval.orderId, reason: 'Not collected' }, env.ctx)
  const products = productsFromOrder(approval.orderId)
  return { ...approval, invoiceId: invoice.id, sheet, products, productId: products[0]!.id, accountId, otherCustomerId }
}
function input(f: ReturnType<typeof fixture>, id = f.productId, requestKey = crypto.randomUUID()) {
  return { id, confirmation: f.orderNumber, requestKey, expectedProductIds: f.products.map(product => product.id) }
}
function financialManufacturingHistory() {
  const tables = ['final_invoices', 'final_invoice_lines', 'order_lines', 'work_sheets', 'order_material_lines', 'inventory_movements', 'fifo_layers', 'fifo_allocations', 'order_machine_usage', 'order_worker_assignments', 'worker_transactions', 'expenses', 'customer_payments', 'customer_payment_refunds', 'customer_payment_refund_allocations', 'cash_transactions', 'material_returns', 'uncollected_product_materials', 'uncollected_product_colors', 'uncollected_product_accessories']
  return Object.fromEntries(tables.map(table => [table, getRawConnection().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}
function authenticate(permissions: string[]) {
  const roleId = createRole({ name: 'Resume role', permissions }, env.ctx)
  createUser({ username: 'resumeuser', password: 'secret123', fullName: 'Resume user', roleId }, env.ctx)
  return { session: login('resumeuser', 'secret123', windowId).session }
}
function resale(f: ReturnType<typeof fixture>, id = f.productId) {
  return createFinalInvoice({ customerId: f.otherCustomerId, depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'Resale', quantityMicro: q(1), unitPriceMinor: m(1000), uncollectedProductId: id }] }, env.ctx)
}
function call(channel: string, request: unknown) { return handlers.get(channel)!(event, request) }

describe('resume an already manufactured product to its original Customer Order', () => {
  it('reactivates the same ID/number and preserves original manufacture, material, cost, price, invoice, payment and cancellation history', () => {
    const f = fixture()
    expect(getOrder(f.orderId).order.status).toBe('cancelled')
    expect(listUncollectedProducts({ status: 'available' }).items[0]).toMatchObject({ id: f.productId, canResume: true })
    const raw = getRawConnection()
    const history = financialManufacturingHistory(), cost = orderCostBreakdown(f.orderId)
    expect(cost.machineCostMinor).toBeGreaterThan(0)
    expect(cost.workerCostMinor).toBeGreaterThan(0)
    expect(cost.linkedExpensesMinor).toBeGreaterThan(0)
    const cancelAudit = raw.prepare("SELECT * FROM audit_log WHERE action = 'orders.cancel'").all()
    const product = getUncollectedProduct(f.productId)
    // Resume refreshes stale caches from the unchanged receipt/refund ledger.
    raw.prepare('UPDATE orders SET paid_minor = 0, remaining_minor = 9000000 WHERE id = ?').run(f.orderId)
    expect(resumeOriginalOrder(input(f), env.ctx)).toMatchObject({ orderId: f.orderId, documentNumber: f.orderNumber, resumedProductIds: [f.productId] })
    expect(getOrder(f.orderId)).toMatchObject({ order: { id: f.orderId, documentNumber: f.orderNumber, status: 'confirmed', totalMinor: m(9000), paidMinor: m(5400), remainingMinor: m(3600) }, workflow: { manufacturingIssued: true, resumeFulfilmentBlocked: false } })
    expect(financialManufacturingHistory()).toEqual(history)
    // Resumption preserves every cost component; realized retained margin
    // gives way to the live order's contractual profit projection.
    expect(orderCostBreakdown(f.orderId)).toEqual({ ...cost, actualProfitMinor: cost.sellingPriceMinor - cost.totalActualCostMinor })
    expect(orderPaymentPosition(f.orderId)).toMatchObject({ paidMinor: m(5400), remainingMinor: m(3600) })
    expect(listUncollectedProducts({ status: 'available' }).items).toEqual([])
    expect(availableUncollectedProducts()).toEqual([])
    const resumed = getUncollectedProduct(f.productId)
    for (const field of ['sourceOrderId', 'sourceOrderLineId', 'sourceWorkSheetId', 'costBasisMinor', 'costBasisMethod', 'cancelReason', 'transferredAt']) expect(resumed[field]).toEqual(product[field])
    expect(resumed).toMatchObject({ status: 'resumed', resumedBy: env.ctx.session.user.id, canResume: false })
    expect(raw.prepare("SELECT * FROM audit_log WHERE action = 'orders.cancel'").all()).toEqual(cancelAudit)
    const audit = raw.prepare("SELECT details, user_id AS userId FROM audit_log WHERE action = 'uncollectedProducts.resume'").get() as { details: string; userId: number }
    expect(JSON.parse(audit.details)).toMatchObject({ productId: f.productId, sourceOrderId: f.orderId, sourceWorkSheetId: f.sheet.id, previousStatus: 'available', resultingStatus: 'resumed', resumedAt: expect.any(String), sourceOrderLineId: resumed.sourceOrderLineId })
    expect(audit.userId).toBe(env.ctx.session.user.id)
    expect(raw.prepare("SELECT entity_id FROM audit_log WHERE action = 'orders.resume'").all()).toEqual([{ entity_id: String(f.orderId) }])
    expect(listOperationalWorkSheets({}).items.map(row => row.id)).toContain(f.sheet.id)
    expect(() => issueWorkSheet({ orderId: f.orderId }, env.ctx)).toThrow(/صدر أمر تصنيع/)
    expect(() => reverseWorkSheet({ id: f.sheet.id, confirmation: f.sheet.documentNumber, expectedToken: getProductionOrder(f.sheet.id).reversalToken, reason: 'Cannot erase physical output' }, env.ctx)).toThrow(/سجل في المنتجات/)
    expect(() => assertSellable(f.productId, null)).toThrow(/استئناف/)
  })
  it('continues existing remaining-payment, Exit Permit and delivery without remanufacturing', () => {
    const f = fixture()
    resumeOriginalOrder(input(f), env.ctx)
    const balanceBefore = getOrder(f.orderId).order.remainingMinor
    const release = issueRelease({ orderId: f.orderId, kind: 'transport' }, env.ctx)
    recordDelivery({ orderId: f.orderId, releaseId: release.id, kind: 'delivery' }, env.ctx)
    expect(getOrder(f.orderId).order.status).toBe('completed')
    expect(getOrder(f.orderId).order.remainingMinor).toBe(balanceBefore)
    expect(getRawConnection().prepare('SELECT id FROM work_sheets WHERE order_id = ?').all(f.orderId)).toHaveLength(1)
    expect(getRawConnection().prepare('SELECT id FROM order_material_lines WHERE order_id = ?').all(f.orderId)).toHaveLength(1)
  })
  it('retries the same request idempotently, rejects a different double-click, and never duplicates audit or stock', () => {
    const f = fixture(), request = input(f)
    resumeOriginalOrder(request, env.ctx)
    const history = financialManufacturingHistory()
    expect(resumeOriginalOrder(request, env.ctx).idempotent).toBe(true)
    expect(() => resumeOriginalOrder(input(f), env.ctx)).toThrow(/متاح/)
    expect(financialManufacturingHistory()).toEqual(history)
    expect(getRawConnection().prepare("SELECT id FROM audit_log WHERE action = 'uncollectedProducts.resume'").all()).toHaveLength(1)
  })
  it('later explicit cancellation returns the same row to the shelf and rejects stale retries across multiple cycles', () => {
    const f = fixture(), old = input(f)
    const history = financialManufacturingHistory()
    resumeOriginalOrder(old, env.ctx)
    cancelOrder({ orderId: f.orderId, reason: 'Changed mind again' }, env.ctx)
    expect(getUncollectedProduct(f.productId)).toMatchObject({ status: 'available', canResume: true })
    expect(() => resumeOriginalOrder(old, env.ctx)).toThrow(/سبق استخدامه/)
    resumeOriginalOrder(input(f), env.ctx)
    cancelOrder({ orderId: f.orderId, reason: 'Third visit' }, env.ctx)
    expect(() => resumeOriginalOrder(old, env.ctx)).toThrow(/سبق استخدامه/)
    expect(productsFromOrder(f.orderId)).toHaveLength(1)
    expect(financialManufacturingHistory()).toEqual(history)
  })
  it('resumes all historical siblings atomically and continues existing whole-order fulfilment', () => {
    const f = fixture(2), raw = getRawConnection(), request = input(f, f.products[1]!.id)
    const history = financialManufacturingHistory(), cost = orderCostBreakdown(f.orderId)
    const cancelAudit = raw.prepare("SELECT * FROM audit_log WHERE action = 'orders.cancel'").all()
    expect(getUncollectedProduct(f.productId)).toMatchObject({ canResume: true,
      resumeProducts: f.products.map(product => ({ id: product.id, name: product.name })) })
    expect(resumeOriginalOrder(request, env.ctx)).toMatchObject({ resumedProductIds: f.products.map(product => product.id) })
    expect(productsFromOrder(f.orderId).map(product => product.status)).toEqual(['resumed', 'resumed'])
    expect(listUncollectedProducts({ status: 'available' }).items).toEqual([])
    expect(getOrder(f.orderId).workflow.resumeFulfilmentBlocked).toBe(false)
    expect(financialManufacturingHistory()).toEqual(history)
    expect(orderCostBreakdown(f.orderId)).toEqual({ ...cost, actualProfitMinor: cost.sellingPriceMinor - cost.totalActualCostMinor })
    expect(raw.prepare("SELECT * FROM audit_log WHERE action = 'orders.cancel'").all()).toEqual(cancelAudit)
    expect(raw.prepare("SELECT id FROM audit_log WHERE action = 'uncollectedProducts.resume'").all()).toHaveLength(2)
    expect(raw.prepare("SELECT id FROM audit_log WHERE action = 'orders.resume'").all()).toHaveLength(1)
    expect(resumeOriginalOrder(request, env.ctx).idempotent).toBe(true)
    expect(raw.prepare("SELECT id FROM audit_log WHERE action = 'uncollectedProducts.resume'").all()).toHaveLength(2)
    recordPayment({ orderId: f.orderId, amountMinor: m(3600), cashAccountId: f.accountId }, env.ctx)
    const release = issueRelease({ orderId: f.orderId, kind: 'transport' }, env.ctx)
    recordDelivery({ orderId: f.orderId, releaseId: release.id, kind: 'delivery' }, env.ctx)
    expect(getOrder(f.orderId).order.status).toBe('completed')
  })
  it('retains a defensive whole-order guard for incomplete legacy ownership states', () => {
    const f = fixture(2, true), raw = getRawConnection()
    raw.prepare("UPDATE uncollected_products SET status = 'resumed' WHERE id = ?").run(f.productId)
    raw.prepare("UPDATE orders SET status = 'confirmed' WHERE id = ?").run(f.orderId)
    expect(getUncollectedProduct(f.products[1]!.id).canResume).toBe(false)
    expect(() => resumeOriginalOrder(input(f, f.products[1]!.id), env.ctx)).toThrow()
    expect(() => recordDelivery({ orderId: f.orderId, kind: 'delivery' }, env.ctx)).toThrow(/غير مكتملة/)
    expect(() => completeOrder({ orderId: f.orderId }, env.ctx)).toThrow(/غير مكتملة/)
    expect(() => issueRelease({ orderId: f.orderId, kind: 'transport' }, env.ctx)).toThrow(/غير مكتملة/)
    expect(raw.prepare('SELECT id FROM deliveries WHERE order_id = ?').all(f.orderId)).toEqual([])
  })
  it('a request key cannot reclaim a different product', () => {
    const f = fixture(2), first = input(f)
    resumeOriginalOrder(first, env.ctx)
    expect(() => resumeOriginalOrder(input(f, f.products[1]!.id, first.requestKey), env.ctx)).toThrow(/سبق استخدامه/)
    expect(getUncollectedProduct(f.products[1]!.id).status).toBe('resumed')
  })
  it.each(['reserved', 'sold'])('rejects a %s product and keeps the original order cancelled', (state) => {
    const f = fixture()
    const invoice = resale(f)
    if (state === 'sold') approveFinalInvoice(invoice.id, env.ctx)
    expect(getUncollectedProduct(f.productId).canResume).toBe(false)
    expect(() => resumeOriginalOrder(input(f), env.ctx)).toThrow(/حجزه أو بيعه/)
    expect(getOrder(f.orderId).order.status).toBe('cancelled')
  })
  it('the resumed physical product cannot be sold through the existing Approved Invoice path', () => {
    const f = fixture()
    resumeOriginalOrder(input(f), env.ctx)
    expect(() => resale(f)).toThrow(/استئناف/)
    expect(getUncollectedProduct(f.productId).status).toBe('resumed')
  })
  it.each(['reserved', 'sold'])('a %s sibling blocks the entire resume without changing the available product or cancelled order', state => {
    const f = fixture(2), siblingId = f.products[1]!.id, invoice = resale(f, siblingId)
    if (state === 'sold') approveFinalInvoice(invoice.id, env.ctx)
    const products = productsFromOrder(f.orderId), history = financialManufacturingHistory()
    expect(getUncollectedProduct(f.productId)).toMatchObject({ canResume: false, resumeProducts: [] })
    expect(listUncollectedProducts({ status: 'available' }).items[0]).toMatchObject({ canResume: false })
    expect(() => resumeOriginalOrder(input(f), env.ctx)).toThrow(/حجزه أو بيعه/)
    expect(productsFromOrder(f.orderId)).toEqual(products)
    expect(getOrder(f.orderId).order.status).toBe('cancelled')
    expect(financialManufacturingHistory()).toEqual(history)
  })
  it.each(['wrong_sheet', 'wrong_line', 'already_resumed'])('an invalid sibling (%s) blocks every product transition', state => {
    const f = fixture(2), raw = getRawConnection(), sibling = f.products[1]!
    if (state === 'wrong_sheet') raw.prepare('UPDATE uncollected_products SET source_work_sheet_id = NULL WHERE id = ?').run(sibling.id)
    if (state === 'wrong_line') raw.prepare('UPDATE order_lines SET superseded_at = ? WHERE id = (SELECT source_order_line_id FROM uncollected_products WHERE id = ?)').run('2026-09-15', sibling.id)
    if (state === 'already_resumed') raw.prepare("UPDATE uncollected_products SET status = 'resumed' WHERE id = ?").run(sibling.id)
    expect(getUncollectedProduct(f.productId).canResume).toBe(false)
    expect(() => resumeOriginalOrder(input(f), env.ctx)).toThrow()
    expect(getUncollectedProduct(f.productId).status).toBe('available')
    expect(getOrder(f.orderId).order.status).toBe('cancelled')
  })
  it('rejects a stale or duplicate confirmation product list', () => {
    const f = fixture(2)
    expect(() => resumeOriginalOrder({ ...input(f), expectedProductIds: [f.productId] }, env.ctx)).toThrow(/قائمة منتجات/)
    expect(() => resumeOriginalOrder({ ...input(f), expectedProductIds: [f.productId, f.productId] }, env.ctx)).toThrow(/قائمة منتجات/)
    expect(productsFromOrder(f.orderId).every(product => product.status === 'available')).toBe(true)
  })
  it('rejects missing manufactured-product coverage without changing historical lines', () => {
    const f = fixture(2), raw = getRawConnection()
    raw.prepare('DELETE FROM uncollected_products WHERE id = ?').run(f.products[1]!.id)
    const history = financialManufacturingHistory()
    expect(getUncollectedProduct(f.productId).canResume).toBe(false)
    expect(() => resumeOriginalOrder({ ...input(f), expectedProductIds: [f.productId] }, env.ctx)).toThrow(/جميع منتجاته/)
    expect(financialManufacturingHistory()).toEqual(history)
    expect(getOrder(f.orderId).order.status).toBe('cancelled')
  })
  it('does not claim products from another original order', () => {
    const first = fixture(), second = fixture()
    resumeOriginalOrder(input(first), env.ctx)
    expect(getUncollectedProduct(second.productId).status).toBe('available')
    expect(getOrder(second.orderId).order.status).toBe('cancelled')
  })
  it('does not unarchive an original order; an explicit existing restore is required', () => {
    const f = fixture()
    archiveOrder({ id: f.orderId, archive: true }, env.ctx)
    expect(getUncollectedProduct(f.productId).canResume).toBe(false)
    expect(() => resumeOriginalOrder(input(f), env.ctx)).toThrow(/مؤرشف/)
    archiveOrder({ id: f.orderId, archive: false }, env.ctx)
    expect(resumeOriginalOrder(input(f), env.ctx).orderId).toBe(f.orderId)
  })
  it.each(['wrong_line', 'wrong_sheet', 'reversed_sheet', 'invalid_invoice', 'delivered'])('rejects authoritative invalid source state %s without mutation', (state) => {
    const f = fixture(), raw = getRawConnection()
    if (state === 'wrong_line') raw.prepare('UPDATE order_lines SET superseded_at = ? WHERE order_id = ?').run('2026-09-15', f.orderId)
    if (state === 'wrong_sheet') raw.prepare('UPDATE uncollected_products SET source_work_sheet_id = NULL WHERE id = ?').run(f.productId)
    if (state === 'reversed_sheet') raw.prepare("UPDATE work_sheets SET status = 'reversed' WHERE id = ?").run(f.sheet.id)
    if (state === 'invalid_invoice') raw.prepare("UPDATE final_invoices SET status = 'cancelled' WHERE id = ?").run(f.invoiceId)
    if (state === 'delivered') raw.prepare("INSERT INTO deliveries (order_id, kind, status) VALUES (?, 'delivery', 'recorded')").run(f.orderId)
    const history = financialManufacturingHistory()
    expect(getUncollectedProduct(f.productId).canResume).toBe(false)
    expect(() => resumeOriginalOrder(input(f), env.ctx)).toThrow()
    expect(getOrder(f.orderId).order.status).toBe('cancelled')
    expect(financialManufacturingHistory()).toEqual(history)
  })
  it('requires the original order number as confirmation', () => {
    const f = fixture()
    expect(() => resumeOriginalOrder({ ...input(f), confirmation: 'wrong' }, env.ctx)).toThrow(/رقم الطلب الأصلي/)
    expect(getUncollectedProduct(f.productId).status).toBe('available')
  })
  it('rolls back product and order reactivation if audit fails', () => {
    const f = fixture(2), raw = getRawConnection()
    raw.exec("CREATE TRIGGER fail_resume_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'uncollectedProducts.resume' AND NEW.entity_id = '" + f.products[1]!.id + "' BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END")
    expect(() => resumeOriginalOrder(input(f), env.ctx)).toThrow(/forced audit failure/)
    expect(productsFromOrder(f.orderId).every(product => product.status === 'available')).toBe(true)
    expect(raw.prepare("SELECT id FROM audit_log WHERE action IN ('orders.resume', 'uncollectedProducts.resume')").all()).toEqual([])
    expect(getOrder(f.orderId).order.status).toBe('cancelled')
  })
  it('enforces a narrow permission in service, availability DTO and direct IPC', async () => {
    const f = fixture(), ctx = authenticate([P.uncollectedProducts.view, P.uncollectedProducts.sell, P.orders.manage])
    expect(getUncollectedProduct(f.productId, ctx.session).canResume).toBe(false)
    expect(() => resumeOriginalOrder(input(f), ctx)).toThrow(/صلاحية/)
    expect(await call(C.uncollectedProducts.resume, input(f))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
  it('an authorized direct IPC request still revalidates current resale state', async () => {
    const f = fixture()
    authenticate([P.uncollectedProducts.resume])
    const request = input(f)
    resale(f)
    expect(await call(C.uncollectedProducts.resume, request)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
  })
  it('an authorized resume-only IPC caller succeeds without manufacturing/payment permissions', async () => {
    const f = fixture()
    authenticate([P.uncollectedProducts.resume])
    expect(await call(C.uncollectedProducts.resume, input(f))).toMatchObject({ ok: true, data: { orderId: f.orderId, documentNumber: f.orderNumber } })
  })
  it('serializes whole-order resume against a second SQLite writer reserving a sibling', () => {
    const f = fixture(2), raw = getRawConnection()
    const file = (raw.pragma('database_list') as Array<{ name: string; file: string }>).find(row => row.name === 'main')!.file
    const competing = new Database(file)
    raw.pragma('busy_timeout = 1')
    try {
      competing.exec('BEGIN IMMEDIATE')
      competing.prepare("UPDATE uncollected_products SET status = 'reserved' WHERE id = ?").run(f.products[1]!.id)
      expect(() => resumeOriginalOrder(input(f), env.ctx)).toThrow(/locked/)
      competing.exec('COMMIT')
      expect(() => resumeOriginalOrder(input(f), env.ctx)).toThrow(/حجزه أو بيعه/)
      expect(getOrder(f.orderId).order.status).toBe('cancelled')
    } finally { if (competing.inTransaction) competing.exec('ROLLBACK'); competing.close() }
  })
  it('a resale writer with a stale sibling snapshot cannot overwrite a committed whole-order resume', () => {
    const f = fixture(2), raw = getRawConnection()
    const file = (raw.pragma('database_list') as Array<{ name: string; file: string }>).find(row => row.name === 'main')!.file
    const competing = new Database(file)
    competing.pragma('busy_timeout = 1')
    try {
      competing.exec('BEGIN')
      expect(competing.prepare('SELECT status FROM uncollected_products WHERE id = ?').get(f.products[1]!.id)).toEqual({ status: 'available' })
      resumeOriginalOrder(input(f), env.ctx)
      expect(() => competing.prepare("UPDATE uncollected_products SET status = 'reserved' WHERE id = ?").run(f.products[1]!.id)).toThrow(/locked/)
      competing.exec('ROLLBACK')
      expect(getUncollectedProduct(f.productId).status).toBe('resumed')
    } finally { if (competing.inTransaction) competing.exec('ROLLBACK'); competing.close() }
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
