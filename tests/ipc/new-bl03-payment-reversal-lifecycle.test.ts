import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice, deleteFinalInvoice, unapproveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder, recordPayment, reverseCustomerPayment, refundPayment, fullDeleteOrder, getOrder } from '@main/services/sales/orders.service'
import { issueWorkSheet, startProduction, consumeForOrder, completeProduction, reverseWorkSheet, getProductionOrder } from '@main/services/production/production.service'
import { productEconomics, productsFromOrder } from '@main/services/sales/uncollected-products.service'
import { monthlyProfitSummary, cumulativeNetProfitMinor, availableProfitMinor } from '@main/services/finance/profit.service'
import { createAccount, accountBalance, fullDeleteCashAccount } from '@main/services/finance/cash.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let account: number
let material: number
let oldTz: string | undefined
const db = () => getRawConnection()
beforeEach(() => {
  oldTz = process.env.TZ
  process.env.TZ = 'Africa/Tripoli'
  env = setupTestDatabase()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-30T22:30:00.000Z'))
  account = createAccount({ name: 'Cash', kind: 'cash', openingBalanceMinor: m(100000) }, env.ctx)
  material = createMaterial({ sku: 'NEW03', name: 'Board', categoryId: createCategory({ name: 'Boards' }, env.ctx), unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(100) }, env.ctx)
  createPurchase({ supplierId: createSupplier({ name: 'Supplier' }, env.ctx), lines: [{ materialId: material, qtyMicro: q(100), unitCostMicro: c(100) }] }, env.ctx)
})
afterEach(() => {
  vi.useRealTimers()
  try {
    expect(db().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db().pragma('foreign_key_check')).toEqual([])
  } finally {
    env.cleanup()
    if (oldTz === undefined) delete process.env.TZ
    else process.env.TZ = oldTz
  }
})
function seed() {
  const invoice = createFinalInvoice({ customerId: createCustomer({ name: 'Customer' }, env.ctx), depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'Cabinet', quantityMicro: q(1), unitPriceMinor: m(10000) }] }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: m(7000), cashAccountId: account, requestKey: `new03-payment-${order.id}` }, env.ctx)
  return { order: order.id, invoice: invoice.id, payment: getOrder(order.id).payments[0]!.id }
}
function snapshot() {
  const tables = db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  return Object.fromEntries(tables.map(({ name }) => [name, db().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
function economics(order: number) {
  return { order: getOrder(order).order, cash: accountBalance(account), september: monthlyProfitSummary(2026, 9), october: monthlyProfitSummary(2026, 10), cumulative: cumulativeNetProfitMinor(), available: availableProfitMinor(), products: productsFromOrder(order).map(p => productEconomics(p.id)) }
}
function denied(f: ReturnType<typeof seed>, ctx = env.ctx, transactional = false, code = 'CONFLICT') {
  const before = snapshot(); const values = economics(f.order)
  const invoke = () => reverseCustomerPayment(f.payment, ctx)
  expect(() => transactional ? withTransaction(invoke) : invoke()).toThrowError(expect.objectContaining({ code }))
  expect(snapshot()).toEqual(before)
  expect(economics(f.order)).toEqual(values)
  expect(getOrder(f.order).payments).toHaveLength(1)
  expect(getOrder(f.order).order.paidMinor).toBe(m(7000))
}

describe('NEW-BL-03 authoritative customer payment reversal lifecycle', () => {
  it.each(['no worksheet', 'ready worksheet', 'safely reversed worksheet'])('preserves authorized reversal before actual start: %s', stage => {
    const f = seed()
    if (stage !== 'no worksheet') {
      const sheet = issueWorkSheet({ orderId: f.order }, env.ctx)
      if (stage === 'safely reversed worksheet') reverseWorkSheet({ id: sheet.id, expectedToken: getProductionOrder(sheet.id).reversalToken, confirmation: sheet.documentNumber, reason: 'Reverse before actual start' }, env.ctx)
    }
    const cash = accountBalance(account)
    withTransaction(() => reverseCustomerPayment(f.payment, env.ctx))
    expect(getOrder(f.order).payments).toHaveLength(0)
    expect(getOrder(f.order).order).toMatchObject({ paidMinor: 0, remainingMinor: m(10000), paymentStatus: 'unpaid' })
    expect(accountBalance(account)).toBe(cash - m(7000))
    expect(db().prepare("SELECT COUNT(*) AS n FROM cash_transactions WHERE ref_table='customer_payments'").get()).toEqual({ n: 0 })
    expect(db().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='orders.payment.reverse'").get()).toEqual({ n: 1 })
    const after = snapshot()
    expect(() => reverseCustomerPayment(f.payment, env.ctx)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(snapshot()).toEqual(after)
  })

  it.each(['started', 'cancelled while started', 'completed', 'cancelled and completed'])('rejects direct and transactional reversal with no financial effects: %s', stage => {
    const f = seed(); const sheet = issueWorkSheet({ orderId: f.order }, env.ctx)
    startProduction(sheet.id, env.ctx)
    if (stage.startsWith('cancelled')) cancelOrder({ orderId: f.order, reason: 'Customer abandoned' }, env.ctx)
    if (stage.includes('completed')) { consumeForOrder({ workSheetId: sheet.id, materialId: material, physicalQtyMicro: q(60) }, env.ctx); completeProduction(sheet.id, env.ctx) }
    denied(f)
    denied(f, env.ctx, true)
  })

  it('protects 7,000 retained payment and 1,000 local-October margin from a no-permission direct caller', () => {
    const f = seed(); const sheet = issueWorkSheet({ orderId: f.order }, env.ctx)
    startProduction(sheet.id, env.ctx)
    cancelOrder({ orderId: f.order, reason: 'Customer abandoned after actual start' }, env.ctx)
    consumeForOrder({ workSheetId: sheet.id, materialId: material, physicalQtyMicro: q(60) }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    const role = createRole({ name: 'Restricted', permissions: [] }, env.ctx)
    createUser({ username: 'restricted', fullName: 'Restricted', password: 'secret123', roleId: role }, env.ctx)
    const ctx = { session: login('restricted', 'secret123', 9301).session }
    const product = productsFromOrder(f.order)[0]!
    expect(productsFromOrder(f.order)).toHaveLength(1)
    expect(productEconomics(product.id)).toMatchObject({ actualCostMinor: m(6000), customerCoveredMinor: m(6000), factoryBorneMinor: 0 })
    expect(monthlyProfitSummary(2026, 9).netProfitMinor).toBe(0)
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(m(1000))
    expect(cumulativeNetProfitMinor()).toBe(m(1000))
    expect(availableProfitMinor()).toBe(m(1000))
    expect(db().prepare('SELECT COUNT(*) AS n FROM customer_payment_refunds').get()).toEqual({ n: 0 })
    denied(f, ctx, false, 'FORBIDDEN')
    denied(f, ctx, false, 'FORBIDDEN')
  })

  it('completion directly from ready also protects the receipt without requiring a start-button action', () => {
    const f = seed(); const sheet = issueWorkSheet({ orderId: f.order }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    expect(db().prepare('SELECT started_at AS started FROM work_sheets WHERE id=?').get(sheet.id)).toEqual({ started: '2026-09-30T22:30:00.000Z' })
    denied(f)
  })

  it('existing refund and deletion paths cannot erase the started receipt', () => {
    const f = seed(); const sheet = issueWorkSheet({ orderId: f.order }, env.ctx); startProduction(sheet.id, env.ctx)
    const before = snapshot()
    for (const invoke of [
      () => refundPayment({ orderId: f.order, amountMinor: m(7000), cashAccountId: account, requestKey: 'new03-refund-denied' }, env.ctx),
      () => fullDeleteCashAccount({ id: account, confirmation: 'Cash' }, env.ctx),
      () => fullDeleteOrder({ id: f.order, confirmation: getOrder(f.order).order.documentNumber }, env.ctx),
      () => unapproveFinalInvoice({ id: f.invoice, expectedRevision: 1 }, env.ctx),
      () => deleteFinalInvoice(f.invoice, env.ctx)
    ]) {
      expect(invoke).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))
      expect(snapshot()).toEqual(before)
    }
  })

  it('does not expose legacy reversal through IPC and preserves permission/lifecycle rejection on the real refund route', async () => {
    const f = seed(); const sheet = issueWorkSheet({ orderId: f.order }, env.ctx); startProduction(sheet.id, env.ctx)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
    expect([...handlers.keys()].some(channel => /reverseCustomerPayment|reversePayment|deletePayment/i.test(channel))).toBe(false)
    for (const [id, permissions, error] of [[9302, [], 'FORBIDDEN'], [9303, [P.payments.refund], 'CONFLICT']] as const) {
      const role = createRole({ name: `Role ${id}`, permissions: [...permissions] }, env.ctx)
      createUser({ username: `user${id}`, password: 'secret123', fullName: 'Operator', roleId: role }, env.ctx)
      login(`user${id}`, 'secret123', id)
      const before = snapshot()
      expect(await handlers.get(C.orders.refundPayment)!({ sender: { id } } as IpcMainInvokeEvent, { orderId: f.order, amountMinor: m(7000), cashAccountId: account, requestKey: `new03-ipc-${id}` })).toMatchObject({ ok: false, error: { code: error } })
      expect(snapshot()).toEqual(before)
    }
  })
})
