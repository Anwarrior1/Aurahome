import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder, recordPayment } from '@main/services/sales/orders.service'
import { issueWorkSheet, startProduction, consumeForOrder, completeProduction, issueRelease, recordDelivery } from '@main/services/production/production.service'
import { productEconomics, productsFromOrder, resumeOriginalOrder } from '@main/services/sales/uncollected-products.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { monthlyProfitSummary, cumulativeNetProfitMinor, availableProfitMinor } from '@main/services/finance/profit.service'
import { createAccount } from '@main/services/finance/cash.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let materialId: number
let accountId: number
let previousTz: string | undefined
const db = () => getRawConnection()
const count = (table: string) => (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
beforeEach(() => {
  previousTz = process.env.TZ
  process.env.TZ = 'Africa/Tripoli'
  env = setupTestDatabase()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-30T22:30:00.000Z'))
  const categoryId = createCategory({ name: 'Boards' }, env.ctx)
  materialId = createMaterial({ sku: 'RISK01', name: 'Board', categoryId, unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(100) } as never, env.ctx)
  createPurchase({ supplierId: createSupplier({ name: 'Supplier' }, env.ctx), lines: [{ materialId, qtyMicro: q(100), unitCostMicro: c(100) }] }, env.ctx)
  accountId = createAccount({ name: 'Cash', kind: 'cash', openingBalanceMinor: m(100000) }, env.ctx)
})
afterEach(() => {
  vi.useRealTimers()
  try {
    expect(db().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db().pragma('foreign_key_check')).toEqual([])
  } finally {
    env.cleanup()
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

function source(retained: number, cost: number, linePrices = [10000]) {
  const invoice = createFinalInvoice({
    customerId: createCustomer({ name: crypto.randomUUID() }, env.ctx),
    depositPercentBp: 0,
    lines: linePrices.map((price, index) => ({ lineKind: 'custom' as const, description: `Custom cabinet ${index}`, quantityMicro: q(1), unitPriceMinor: m(price) }))
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  if (retained) recordPayment({ orderId: order.id, amountMinor: m(retained), cashAccountId: accountId }, env.ctx)
  const sheet = issueWorkSheet({ orderId: order.id, overrideDepositRequirement: true }, env.ctx)
  startProduction(sheet.id, env.ctx)
  cancelOrder({ orderId: order.id, reason: 'customer abandoned' }, env.ctx)
  if (cost) consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: q(cost / 100) }, env.ctx)
  return { orderId: order.id, sheetId: sheet.id }
}

function resell(productId: number, price: number) {
  const invoice = createFinalInvoice({
    customerId: createCustomer({ name: crypto.randomUUID() }, env.ctx), depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'Resale', quantityMicro: q(1), unitPriceMinor: m(price), uncollectedProductId: productId }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: m(price), cashAccountId: accountId }, env.ctx)
  const release = issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)
  recordDelivery({ orderId: order.id, releaseId: release.id, kind: 'handover' }, env.ctx)
  return order.id
}

describe('BL-03 Remaining Risk 01 retained original-customer margin', () => {
  it('recognizes 7,000 minus 6,000 at local-October transfer, then earns 5,000 on resale once', () => {
    const f = source(7000, 6000)
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(0)
    expect(productsFromOrder(f.orderId)).toHaveLength(0)
    completeProduction(f.sheetId, env.ctx)
    const product = productsFromOrder(f.orderId)[0]!
    expect(productEconomics(product.id)).toMatchObject({ actualCostMinor: m(6000), customerCoveredMinor: m(6000), factoryBorneMinor: 0 })
    expect(db().prepare('SELECT transferred_at AS t FROM uncollected_products WHERE id = ?').get(product.id)).toEqual({ t: '2026-09-30T22:30:00.000Z' })
    expect(orderCostBreakdown(f.orderId).actualProfitMinor).toBe(m(1000))
    expect(monthlyProfitSummary(2026, 9).netProfitMinor).toBe(0)
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(m(1000))
    expect(cumulativeNetProfitMinor()).toBe(m(1000))
    expect(availableProfitMinor()).toBe(m(1000))
    expect(count('customer_payment_refunds')).toBe(0)
    const soldOrderId = resell(product.id, 5000)
    expect(orderCostBreakdown(soldOrderId)).toMatchObject({ totalActualCostMinor: 0, actualProfitMinor: m(5000) })
    expect(orderCostBreakdown(f.orderId).actualProfitMinor).toBe(m(1000))
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(m(6000))
    expect(cumulativeNetProfitMinor()).toBe(m(6000))
    expect(() => completeProduction(f.sheetId, env.ctx)).toThrow()
    expect(() => cancelOrder({ orderId: f.orderId, reason: 'retry' }, env.ctx)).toThrow()
    expect(productsFromOrder(f.orderId)).toHaveLength(1)
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(m(6000))
  })

  it.each([[6000, 8000, 2000, 3000], [6000, 6000, 0, 5000], [0, 6000, 6000, -1000]])(
    'retained %i, cost %i: factory exposure %i and resale margin %i', (retained, cost, factory, resaleProfit) => {
      const f = source(retained, cost)
      completeProduction(f.sheetId, env.ctx)
      const product = productsFromOrder(f.orderId)[0]!
      expect(productEconomics(product.id)).toMatchObject({ actualCostMinor: m(cost), customerCoveredMinor: m(retained), factoryBorneMinor: m(factory) })
      expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(0)
      expect(orderCostBreakdown(f.orderId).actualProfitMinor).toBe(0)
      expect(count('customer_payment_refunds')).toBe(0)
      const soldOrderId = resell(product.id, 5000)
      expect(orderCostBreakdown(soldOrderId).actualProfitMinor).toBe(m(resaleProfit))
      expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(m(resaleProfit))
    }
  )

  it('requires payments.manage before any ordinary direct payment mutation', () => {
    const invoice = createFinalInvoice({ customerId: createCustomer({ name: 'Restricted customer' }, env.ctx),
      lines: [{ lineKind: 'custom', description: 'Cabinet', quantityMicro: q(1), unitPriceMinor: m(10000) }] }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    const restricted = { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [] } }
    const before = [count('customer_payments'), count('cash_transactions'), count('audit_log')]
    expect(() => recordPayment({ orderId: order.id, amountMinor: m(7000), cashAccountId: accountId }, restricted)).toThrow(/صلاحية/)
    expect([count('customer_payments'), count('cash_transactions'), count('audit_log')]).toEqual(before)
    const allowed = { session: { ...restricted.session, permissions: [P.payments.manage] } }
    recordPayment({ orderId: order.id, amountMinor: m(7000), cashAccountId: accountId }, allowed)
    expect(count('customer_payments')).toBe(before[0] + 1)
  })

  it('rejects under-permissioned IPC payment and accepts the same payment for an authorized caller', async () => {
    const invoice = createFinalInvoice({ customerId: createCustomer({ name: 'IPC customer' }, env.ctx),
      lines: [{ lineKind: 'custom', description: 'Cabinet', quantityMicro: q(1), unitPriceMinor: m(10000) }] }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => {
      handlers.set(channel, handler)
    }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    const roleId = createRole({ name: 'Risk01 payment viewer', permissions: [] }, env.ctx)
    createUser({ username: 'risk01-viewer', fullName: 'Viewer', password: 'secret123', roleId }, env.ctx)
    login('risk01-viewer', 'secret123', 8701)
    const request = { orderId: order.id, amountMinor: m(7000), cashAccountId: accountId, requestKey: 'risk01-pay-once' }
    const before = [count('customer_payments'), count('cash_transactions'), count('audit_log')]
    expect(await handlers.get(IPC_CHANNELS.orders.recordPayment)!({ sender: { id: 8701 } } as IpcMainInvokeEvent, request))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect([count('customer_payments'), count('cash_transactions'), count('audit_log')]).toEqual(before)
    login('owner', 'secret123', 8702)
    expect(await handlers.get(IPC_CHANNELS.orders.recordPayment)!({ sender: { id: 8702 } } as IpcMainInvokeEvent, request))
      .toMatchObject({ ok: true })
    expect(count('customer_payments')).toBe(before[0] + 1)
  })

  it('counts multiple transferred items of one source order as one retained-margin event', () => {
    const f = source(7000, 6000, [6000, 4000])
    completeProduction(f.sheetId, env.ctx)
    expect(productsFromOrder(f.orderId)).toHaveLength(2)
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(m(1000))
    expect(cumulativeNetProfitMinor()).toBe(m(1000))
  })

  it('treats successful completion from ready as actual start, as the manufacturing lifecycle does', () => {
    const invoice = createFinalInvoice({ customerId: createCustomer({ name: 'Unstarted' }, env.ctx), depositPercentBp: 0,
      lines: [{ lineKind: 'custom', description: 'Cabinet', quantityMicro: q(1), unitPriceMinor: m(10000) }] }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: m(7000), cashAccountId: accountId }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: q(60) }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    cancelOrder({ orderId: order.id, reason: 'cancelled after unstarted completion' }, env.ctx)
    expect(productsFromOrder(order.id)).toHaveLength(1)
    expect(db().prepare('SELECT started_at AS started FROM work_sheets WHERE id = ?').get(sheet.id))
      .toEqual({ started: '2026-09-30T22:30:00.000Z' })
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(m(1000))
  })

  it('withdraws retained-margin recognition on legitimate resume and moves it to a later re-transfer period', () => {
    const f = source(7000, 6000)
    completeProduction(f.sheetId, env.ctx)
    const product = productsFromOrder(f.orderId)[0]!
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(m(1000))
    const orderNumber = (db().prepare('SELECT document_number AS n FROM orders WHERE id = ?').get(f.orderId) as { n: string }).n
    resumeOriginalOrder({ id: product.id, confirmation: orderNumber, requestKey: 'risk01-resume-once', expectedProductIds: [product.id] }, env.ctx)
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(0)
    expect(cumulativeNetProfitMinor()).toBe(0)
    vi.setSystemTime(new Date('2026-10-31T22:30:00.000Z'))
    cancelOrder({ orderId: f.orderId, reason: 'abandoned again' }, env.ctx)
    expect(productsFromOrder(f.orderId)).toHaveLength(1)
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(0)
    expect(monthlyProfitSummary(2026, 11).netProfitMinor).toBe(m(1000))
    expect(cumulativeNetProfitMinor()).toBe(m(1000))
  })

  it('rolls back MO completion and recognized margin if transfer audit insertion fails', () => {
    const f = source(7000, 6000)
    const before = [count('uncollected_products'), count('audit_log')]
    db().exec("CREATE TRIGGER risk01_fail_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'uncollectedProducts.transfer' BEGIN SELECT RAISE(ABORT, 'transfer audit failure'); END")
    try {
      expect(() => completeProduction(f.sheetId, env.ctx)).toThrow(/transfer audit failure/)
    } finally {
      db().exec('DROP TRIGGER risk01_fail_audit')
    }
    expect(db().prepare('SELECT status FROM work_sheets WHERE id = ?').get(f.sheetId)).toEqual({ status: 'in_production' })
    expect([count('uncollected_products'), count('audit_log')]).toEqual(before)
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(0)
    completeProduction(f.sheetId, env.ctx)
    expect(productsFromOrder(f.orderId)).toHaveLength(1)
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(m(1000))
  })
})
