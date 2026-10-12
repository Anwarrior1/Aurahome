import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import {
  createFinalInvoice, approveFinalInvoice, unapproveFinalInvoice, deleteFinalInvoice, getFinalInvoice, listFinalInvoices, orderPaymentPosition
} from '@main/services/sales/final-invoices.service'
import {
  listOrders, refundPayment, recordPayment, reverseCustomerPayment, updateOrder, completeOrder
} from '@main/services/sales/orders.service'
import { savePlannedMaterials } from '@main/services/planning/planning.service'
import { issueWorkSheet, startProduction } from '@main/services/production/production.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 50300
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

const raw = () => getRawConnection()
function tables(exclude: string[] = []) {
  return (raw().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
    .filter(({ name }) => !exclude.includes(name))
    .map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
}
const rows = (sql: string, ...params: unknown[]) => raw().prepare(sql).all(...params)
function authenticate(permissions: string[]) {
  const roleId = createRole({ name: 'CC02B role', permissions }, env.ctx)
  createUser({ username: 'cc02b-user', fullName: 'CC02B', password: 'secret123', roleId }, env.ctx)
  login('cc02b-user', 'secret123', windowId)
}
const call = (channel: string, request: unknown) => handlers.get(channel)!(event, request)

let seq = 0
function seed(paidMajor = 0) {
  seq += 1
  const customerId = createCustomer({ name: `عميل CC02B ${seq}` }, env.ctx)
  const accountId = createAccount({ name: `صندوق CC02B ${seq}`, kind: 'cash' }, env.ctx)
  const invoice = createFinalInvoice({
    customerId, depositPercentBp: 0,
    ...(paidMajor ? { paidAmountMinor: m(paidMajor), initialCashAccountId: accountId } : {}),
    lines: [{ lineKind: 'custom', description: `مطبخ ${seq}`, quantityMicro: q(1), unitPriceMinor: m(10000) }]
  }, env.ctx)
  const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
  return { invoiceId: invoice.id, orderId, accountId, customerId }
}
const unapprove = (id: number) => unapproveFinalInvoice({ id, expectedRevision: getFinalInvoice(id).invoice.approvalRevision }, env.ctx)
function refund(f: ReturnType<typeof seed>, amountMinor = orderPaymentPosition(f.orderId).paidMinor, accountId = f.accountId) {
  refundPayment({ orderId: f.orderId, amountMinor, cashAccountId: accountId, requestKey: crypto.randomUUID() }, env.ctx)
}
const activeOrderIds = () => listOrders({}, { limit: 100 }).items.map((row) => row.id)
function expectRejectedWithoutResidue(operation: () => unknown, message: RegExp) {
  const before = tables()
  expect(operation).toThrow(message)
  expect(tables()).toEqual(before)
}

describe('CC02B rule 1 — unapproval removes the order from the active workflow', () => {
  it('1: no payment → unapprove → the order leaves the active Customer Orders list (service + IPC)', async () => {
    const f = seed()
    expect(activeOrderIds()).toContain(f.orderId)
    unapprove(f.invoiceId)
    expect(activeOrderIds()).not.toContain(f.orderId)
    expect(listOrders({ includeArchived: true }).items.map((row) => row.id)).not.toContain(f.orderId)
    authenticate([P.orders.view])
    expect(await call(C.orders.list, { limit: 100 })).toMatchObject({ ok: true, data: { items: [] } })
  })

  it('2: payment + full refund → unapprove → the order leaves the active Customer Orders list', () => {
    const f = seed(3000)
    refund(f)
    unapprove(f.invoiceId)
    expect(activeOrderIds()).not.toContain(f.orderId)
    expect(rows('SELECT id FROM orders WHERE id = ?', f.orderId)).toHaveLength(1)
  })

  it('3: the unapproved order cannot be operated through direct service calls — zero residue', () => {
    const f = seed(3000)
    refund(f)
    unapprove(f.invoiceId)
    const paymentId = (rows('SELECT id FROM customer_payments WHERE order_id = ?', f.orderId) as Array<{ id: number }>)[0].id
    const categoryId = createCategory({ name: 'مواد CC02B' }, env.ctx)
    const materialId = createMaterial({ sku: 'CC02B-MDF', name: 'لوح', categoryId, unit: 'لوح', pricingRule: 'exact', currentMarketPriceMicro: c(10) }, env.ctx)
    const supplierId = createSupplier({ name: 'مورد CC02B' }, env.ctx)
    const inactive = /بانتظار|أعد اعتماد|اعتماد الفاتورة/
    expectRejectedWithoutResidue(() => recordPayment({ orderId: f.orderId, amountMinor: m(10), cashAccountId: f.accountId }, env.ctx), inactive)
    expectRejectedWithoutResidue(() => reverseCustomerPayment(paymentId, env.ctx), inactive)
    expectRejectedWithoutResidue(() => updateOrder(f.orderId, { notes: 'bypass' }, env.ctx), inactive)
    expectRejectedWithoutResidue(() => refund(f, m(1)), inactive)
    expectRejectedWithoutResidue(() => completeOrder({ orderId: f.orderId }, env.ctx), inactive)
    expectRejectedWithoutResidue(() => issueWorkSheet({ orderId: f.orderId }, env.ctx), inactive)
    expectRejectedWithoutResidue(() => savePlannedMaterials({ orderId: f.orderId }, [], env.ctx), inactive)
    expectRejectedWithoutResidue(() => createPurchase({ supplierId, customerOrderId: f.orderId, lines: [{ materialId, qtyMicro: q(1), unitCostMicro: c(10) }] }, env.ctx), inactive)
  })

  it('3: the unapproved order cannot be operated through direct IPC — zero residue', async () => {
    const f = seed()
    unapprove(f.invoiceId)
    authenticate([P.orders.manage, P.payments.manage, P.payments.refund, P.worksheets.issue, P.orders.complete])
    const attempts: Array<[string, unknown]> = [
      [C.orders.update, { id: f.orderId, notes: 'bypass' }],
      [C.orders.recordPayment, { orderId: f.orderId, amountMinor: m(10), cashAccountId: f.accountId, requestKey: 'cc02b-ipc-payment' }],
      [C.production.issueWorkSheet, { orderId: f.orderId }]
    ]
    for (const [channel, payload] of attempts) {
      const before = tables()
      const result = await call(channel, payload)
      expect(result.ok, channel).toBe(false)
      expect(tables()).toEqual(before)
    }
  })
})

describe('CC02B rule 2 — reapproval restores exactly one order', () => {
  it('4: unapprove → reapprove → exactly one active order, the same one', () => {
    const f = seed()
    unapprove(f.invoiceId)
    expect(approveFinalInvoice(f.invoiceId, env.ctx).orderId).toBe(f.orderId)
    expect(activeOrderIds().filter((id) => id === f.orderId)).toHaveLength(1)
    expect(rows('SELECT id FROM orders')).toHaveLength(1)
  })

  it('5: repeated cycles never duplicate orders, links, planning data or payments', () => {
    const f = seed(3000)
    refund(f)
    const count = (table: string, where = 'order_id = ?') => (raw().prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(f.orderId) as { c: number }).c
    const baseline = ['planned_materials', 'planned_machines', 'planned_workers', 'planned_order_expenses', 'customer_payments', 'customer_payment_refunds'].map((t) => count(t))
    const activeLines = count('order_lines', 'order_id = ? AND superseded_at IS NULL')
    const cash = rows('SELECT * FROM cash_transactions ORDER BY id')
    for (let cycle = 0; cycle < 3; cycle++) {
      unapprove(f.invoiceId)
      expect(activeOrderIds()).not.toContain(f.orderId)
      expect(approveFinalInvoice(f.invoiceId, env.ctx).orderId).toBe(f.orderId)
      expect(activeOrderIds().filter((id) => id === f.orderId)).toHaveLength(1)
    }
    expect(rows('SELECT id FROM orders')).toHaveLength(1)
    expect(rows('SELECT id FROM final_invoices WHERE order_id = ?', f.orderId)).toHaveLength(1)
    expect(['planned_materials', 'planned_machines', 'planned_workers', 'planned_order_expenses', 'customer_payments', 'customer_payment_refunds'].map((t) => count(t))).toEqual(baseline)
    expect(count('order_lines', 'order_id = ? AND superseded_at IS NULL')).toBe(activeLines)
    expect(rows('SELECT * FROM cash_transactions ORDER BY id')).toEqual(cash)
    expect(orderPaymentPosition(f.orderId).paidMinor).toBe(0)
  })
})

describe('CC02B rule 3 — true hard delete of a fully reversed pre-start cycle', () => {
  function unrelatedActivity() {
    const other = seed(2500) // unrelated customer, paid, still approved
    const shared = createAccount({ name: 'حساب مشترك CC02B', kind: 'bank', openingBalanceMinor: m(50000) }, env.ctx)
    return { other, shared }
  }
  const excluding = (orderId: number, invoiceId: number) => ({
    payments: rows('SELECT * FROM customer_payments WHERE order_id != ? ORDER BY id', orderId),
    refunds: rows('SELECT * FROM customer_payment_refunds WHERE order_id != ? ORDER BY id', orderId),
    allocations: rows('SELECT a.* FROM customer_payment_refund_allocations a JOIN customer_payment_refunds r ON r.id = a.refund_id WHERE r.order_id != ? ORDER BY a.id', orderId),
    cash: rows(`SELECT * FROM cash_transactions WHERE NOT (
      (ref_table = 'customer_payments' AND ref_id IN (SELECT id FROM customer_payments WHERE order_id = ?))
      OR (ref_table = 'customer_payment_refunds' AND ref_id IN (SELECT id FROM customer_payment_refunds WHERE order_id = ?))) ORDER BY id`, orderId, orderId),
    invoices: rows('SELECT * FROM final_invoices WHERE id != ? ORDER BY id', invoiceId),
    orders: rows('SELECT * FROM orders WHERE id != ? ORDER BY id', orderId),
    stock: ['inventory_movements', 'fifo_layers', 'fifo_allocations', 'material_remainders'].map((t) => rows(`SELECT * FROM ${t} ORDER BY rowid`)),
    accounts: rows('SELECT * FROM cash_accounts ORDER BY id'),
    audit: rows('SELECT * FROM audit_log ORDER BY id')
  })

  it('6/7/8/9: payment + full refund → unapprove → hard delete removes the whole cycle, cash-neutral, unrelated data byte-identical', async () => {
    const f = seed(3000)
    const { other, shared } = unrelatedActivity()
    refund(f)
    unapprove(f.invoiceId)
    expect(listFinalInvoices({}).items.find((row) => row.id === f.invoiceId)).toMatchObject({ canDelete: true })
    const paymentIds = (rows('SELECT id FROM customer_payments WHERE order_id = ?', f.orderId) as Array<{ id: number }>).map((r) => r.id)
    const refundIds = (rows('SELECT id FROM customer_payment_refunds WHERE order_id = ?', f.orderId) as Array<{ id: number }>).map((r) => r.id)
    expect(paymentIds).toHaveLength(1)
    expect(refundIds).toHaveLength(1)
    const balances = [f.accountId, other.accountId, shared].map((id) => accountBalance(id))
    const unrelated = excluding(f.orderId, f.invoiceId)

    authenticate([P.finalInvoices.remove])
    expect(await call(C.finalInvoices.remove, { id: f.invoiceId })).toMatchObject({ ok: true })

    expect(rows('SELECT id FROM final_invoices WHERE id = ?', f.invoiceId)).toEqual([])
    expect(rows('SELECT id FROM orders WHERE id = ?', f.orderId)).toEqual([])
    expect(rows(`SELECT id FROM customer_payments WHERE id IN (${paymentIds.join(',')})`)).toEqual([])
    expect(rows(`SELECT id FROM customer_payment_refunds WHERE id IN (${refundIds.join(',')})`)).toEqual([])
    expect(rows(`SELECT id FROM customer_payment_refund_allocations WHERE refund_id IN (${refundIds.join(',')}) OR payment_id IN (${paymentIds.join(',')})`)).toEqual([])
    expect(rows(`SELECT id FROM cash_transactions WHERE (ref_table = 'customer_payments' AND ref_id IN (${paymentIds.join(',')})) OR (ref_table = 'customer_payment_refunds' AND ref_id IN (${refundIds.join(',')}))`)).toEqual([])
    expect([f.accountId, other.accountId, shared].map((id) => accountBalance(id))).toEqual(balances)
    const after = excluding(f.orderId, f.invoiceId)
    expect({ ...after, audit: after.audit.slice(0, unrelated.audit.length) }).toEqual(unrelated)
    expect((after.audit as Array<{ action: string }>).at(-1)).toMatchObject({ action: 'finalInvoices.delete' })
  })

  it('refuses a cycle that is not cash-neutral per account (refund from another account) with zero residue', () => {
    const f = seed(3000)
    const bank = createAccount({ name: 'بنك CC02B', kind: 'bank', openingBalanceMinor: m(50000) }, env.ctx)
    refund(f, undefined, bank)
    unapprove(f.invoiceId)
    expect(listFinalInvoices({}).items.find((row) => row.id === f.invoiceId)).toMatchObject({ canDelete: false })
    expectRejectedWithoutResidue(() => deleteFinalInvoice(f.invoiceId, env.ctx), /سجلاً مالياً/)
  })

  it('refuses a payment/refund whose cash link cannot be proven exclusive, with zero residue', () => {
    const f = seed(3000)
    refund(f)
    unapprove(f.invoiceId)
    const paymentId = (rows('SELECT id FROM customer_payments WHERE order_id = ?', f.orderId) as Array<{ id: number }>)[0].id
    raw().prepare("UPDATE cash_transactions SET ref_id = NULL WHERE ref_table = 'customer_payments' AND ref_id = ?").run(paymentId)
    expectRejectedWithoutResidue(() => deleteFinalInvoice(f.invoiceId, env.ctx), /سجلاً مالياً/)
  })

  it('10: partial refund → net paid ≠ 0 → unapproval stays blocked with zero residue', () => {
    const f = seed(3000)
    refund(f, m(1000))
    expectRejectedWithoutResidue(() => unapprove(f.invoiceId), /استرداد كامل/)
  })

  it('11: manufacturing started → unapproval and the delete path stay blocked', () => {
    const f = seed()
    startProduction(issueWorkSheet({ orderId: f.orderId }, env.ctx).id, env.ctx)
    expectRejectedWithoutResidue(() => unapprove(f.invoiceId), /بعد بدء التصنيع/)
    expectRejectedWithoutResidue(() => deleteFinalInvoice(f.invoiceId, env.ctx), /معتمدة/)
  })

  it.each([
    ['customer_payment_refund_allocations', 'BEFORE DELETE ON customer_payment_refund_allocations'],
    ['cash_transactions', 'BEFORE DELETE ON cash_transactions'],
    ['customer_payments', 'BEFORE DELETE ON customer_payments'],
    ['orders', 'BEFORE DELETE ON orders'],
    ['audit_log', "BEFORE INSERT ON audit_log WHEN NEW.action = 'finalInvoices.delete'"]
  ])('12: a failure at %s rolls the entire hard delete back with zero residue', (_name, trigger) => {
    const f = seed(3000)
    refund(f)
    unapprove(f.invoiceId)
    raw().exec(`CREATE TRIGGER cc02b_fail ${trigger} BEGIN SELECT RAISE(ABORT, 'forced failure'); END`)
    expectRejectedWithoutResidue(() => deleteFinalInvoice(f.invoiceId, env.ctx), /forced failure/)
  })
})
