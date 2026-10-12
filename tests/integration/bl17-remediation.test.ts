import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder, getOrder } from '@main/services/sales/orders.service'
import { issueWorkSheet, completeProduction, issueRelease, recordDelivery, cancelDelivery } from '@main/services/production/production.service'
import { savePlannedWorkers } from '@main/services/planning/planning.service'
import { createWorker, assignWorkerToOrder, recordWorkerEarnings, reverseWorkerEarnings, workerBalances, payWorkerCommission, recordWorkerTransaction } from '@main/services/production/workers.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { productsFromOrder } from '@main/services/sales/uncollected-products.service'
import { buildAuthorizedReport, buildReport } from '@main/services/reports/reports.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { formatMoney, money, moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let seq = 0
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  env.cleanup()
})
const raw = () => getRawConnection()
const rows = (query: string, ...args: unknown[]) => raw().prepare(query).all(...args)
function order() {
  const customerId = createCustomer({ name: `BL17 customer ${++seq}` }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'Custom cabinet', quantityMicro: q(1), unitPriceMinor: m(9000) }] }, env.ctx)
  return approveFinalInvoice(invoice.id, env.ctx).orderId
}
function manufacturing() {
  const orderId = order()
  const workerId = createWorker({ name: `BL17 worker ${seq}` }, env.ctx)
  savePlannedWorkers({ orderId }, [{ workerId, workerName: `BL17 worker ${seq}`, estimatedCostMinor: m(200) }], env.ctx)
  const sheet = issueWorkSheet({ orderId }, env.ctx)
  return { orderId, workerId, sheetId: sheet.id }
}
function legacy() {
  const orderId = order()
  const workerId = createWorker({ name: `BL17 legacy ${seq}` }, env.ctx)
  assignWorkerToOrder({ orderId, workerId, method: 'fixed', amountMinor: m(200) }, env.ctx)
  return { orderId, workerId }
}
function reportPayable(workerId: number) {
  const name = (raw().prepare('SELECT name FROM workers WHERE id = ?').get(workerId) as { name: string }).name
  return buildReport({ key: 'worker_balances' }).rows.find((row) => row['العامل'] === name)!['المستحقات الحالية']
}
function state() {
  return ['orders', 'work_sheets', 'deliveries', 'finished_goods_movements', 'uncollected_products', 'worker_transactions', 'order_worker_assignments', 'cash_transactions', 'audit_log']
    .map((table) => [table, rows(`SELECT * FROM ${table} ORDER BY rowid`)])
}

describe('BL-17 owned commission lifecycle', () => {
  it('earns named manufacturing commission once, without delivery or automatic cash, then pays 150 and 50 manually while debt stays separate', () => {
    const f = manufacturing()
    const box = createAccount({ name: 'BL17 cash', kind: 'cash', openingBalanceMinor: m(1000) }, env.ctx)
    expect(workerBalances(f.workerId)).toEqual({ payableMinor: 0, debtMinor: 0 })
    expect(reportPayable(f.workerId)).toBe(formatMoney(money(0)))
    completeProduction(f.sheetId, env.ctx)
    expect(workerBalances(f.workerId)).toEqual({ payableMinor: m(200), debtMinor: 0 })
    expect(reportPayable(f.workerId)).toBe(formatMoney(money(m(200))))
    expect(rows("SELECT kind, amount_minor FROM worker_transactions WHERE worker_id = ?", f.workerId)).toEqual([{ kind: 'earning', amount_minor: m(200) }])
    expect(rows('SELECT * FROM cash_transactions WHERE ref_table = ?', 'worker_transactions')).toEqual([])
    expect(accountBalance(box)).toBe(m(1000))
    expect(rows('SELECT * FROM deliveries WHERE order_id = ?', f.orderId)).toEqual([])
    const beforeRepeat = state()
    expect(() => completeProduction(f.sheetId, env.ctx)).toThrow()
    expect(state()).toEqual(beforeRepeat)
    const reportsOnly = { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [P.reports.view] } }
    expect(() => buildAuthorizedReport({ key: 'worker_balances' }, reportsOnly.session)).toThrow(/صلاحية/)
    expect(() => payWorkerCommission({ workerId: f.workerId, amountMinor: m(150), cashAccountId: box }, reportsOnly)).toThrow(/صلاحية/)
    payWorkerCommission({ workerId: f.workerId, amountMinor: m(150), cashAccountId: box }, env.ctx)
    expect(workerBalances(f.workerId)).toEqual({ payableMinor: m(50), debtMinor: 0 })
    expect(reportPayable(f.workerId)).toBe(formatMoney(money(m(50))))
    payWorkerCommission({ workerId: f.workerId, amountMinor: m(50), cashAccountId: box }, env.ctx)
    expect(workerBalances(f.workerId)).toEqual({ payableMinor: 0, debtMinor: 0 })
    expect(reportPayable(f.workerId)).toBe(formatMoney(money(0)))
    expect(accountBalance(box)).toBe(m(800))
    recordWorkerTransaction({ workerId: f.workerId, kind: 'withdrawal', amountMinor: m(30), cashAccountId: box }, env.ctx)
    expect(workerBalances(f.workerId)).toEqual({ payableMinor: 0, debtMinor: m(30) })
  })

  it('keeps earned manufacturing commission through non-collection, Customer Order cancellation, and Custom Uncollected transfer', () => {
    const f = manufacturing()
    completeProduction(f.sheetId, env.ctx)
    expect(rows('SELECT * FROM deliveries WHERE order_id = ?', f.orderId)).toEqual([])
    expect(workerBalances(f.workerId).payableMinor).toBe(m(200))
    cancelOrder({ orderId: f.orderId, reason: 'Customer never collected' }, env.ctx)
    expect(getOrder(f.orderId).order.status).toBe('cancelled')
    expect(productsFromOrder(f.orderId)).toHaveLength(1)
    expect(workerBalances(f.workerId).payableMinor).toBe(m(200))
    expect(reportPayable(f.workerId)).toBe(formatMoney(money(m(200))))
    expect(rows("SELECT kind FROM worker_transactions WHERE worker_id = ?", f.workerId)).toEqual([{ kind: 'earning' }])
  })

  it('keeps manufacturing earning through delivery reversal and blocks direct independent helper calls', () => {
    const f = manufacturing()
    const viewOnly = { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [P.workers.view] } }
    expect(() => recordWorkerEarnings(f.orderId, new Date().toISOString(), viewOnly)).toThrow(/صلاحية/)
    expect(() => recordWorkerEarnings(f.orderId, new Date().toISOString(), env.ctx)).toThrow(/معاملة الإكمال/)
    completeProduction(f.sheetId, env.ctx)
    const permit = issueRelease({ orderId: f.orderId, kind: 'delivery' }, env.ctx)
    const delivery = recordDelivery({ orderId: f.orderId, releaseId: permit.id, kind: 'handover' }, env.ctx)
    const before = state()
    expect(() => reverseWorkerEarnings(f.orderId, viewOnly)).toThrow(/صلاحية/)
    expect(() => reverseWorkerEarnings(f.orderId, env.ctx)).toThrow(/معاملة تراجع/)
    expect(() => withTransaction(() => reverseWorkerEarnings(f.orderId, env.ctx))).toThrow(/معاملة تراجع/)
    expect(state()).toEqual(before)
    cancelDelivery({ id: delivery.id }, env.ctx)
    expect(workerBalances(f.workerId).payableMinor).toBe(m(200))
    expect(reportPayable(f.workerId)).toBe(formatMoney(money(m(200))))
    expect(rows("SELECT kind FROM worker_transactions WHERE worker_id = ?", f.workerId)).toEqual([{ kind: 'earning' }])
  })

  it('preserves legacy fulfillment-linked signed reversal while blocking direct early/reverse calls', () => {
    const f = legacy()
    const viewOnly = { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [P.workers.view] } }
    expect(() => recordWorkerEarnings(f.orderId, new Date().toISOString(), viewOnly)).toThrow(/صلاحية/)
    expect(() => withTransaction(() => recordWorkerEarnings(f.orderId, new Date().toISOString(), env.ctx))).toThrow(/معاملة الإكمال/)
    expect(workerBalances(f.workerId).payableMinor).toBe(0)
    const permit = issueRelease({ orderId: f.orderId, kind: 'delivery' }, env.ctx)
    const delivery = recordDelivery({ orderId: f.orderId, releaseId: permit.id, kind: 'handover' }, env.ctx)
    expect(workerBalances(f.workerId).payableMinor).toBe(m(200))
    expect(() => reverseWorkerEarnings(f.orderId, env.ctx)).toThrow(/معاملة تراجع/)
    cancelDelivery({ id: delivery.id }, env.ctx)
    expect(workerBalances(f.workerId).payableMinor).toBe(0)
    expect(reportPayable(f.workerId)).toBe(formatMoney(money(0)))
    expect(rows('SELECT kind, amount_minor, reversal_of_transaction_id FROM worker_transactions WHERE worker_id = ? ORDER BY id', f.workerId)).toMatchObject([
      { kind: 'earning', amount_minor: m(200), reversal_of_transaction_id: null },
      { kind: 'adjustment', amount_minor: -m(200), reversal_of_transaction_id: expect.any(Number) }
    ])
  })

  it('rolls back owning completion and reversal transactions if the worker ledger write fails', () => {
    const f = legacy()
    const permit = issueRelease({ orderId: f.orderId, kind: 'delivery' }, env.ctx)
    const beforeCompletion = state()
    raw().exec("CREATE TRIGGER bl17_earning_fail BEFORE INSERT ON worker_transactions WHEN NEW.kind = 'earning' BEGIN SELECT RAISE(ABORT, 'earning failure'); END")
    expect(() => recordDelivery({ orderId: f.orderId, releaseId: permit.id, kind: 'handover' }, env.ctx)).toThrow(/earning failure/)
    expect(state()).toEqual(beforeCompletion)
    raw().exec('DROP TRIGGER bl17_earning_fail')
    const delivery = recordDelivery({ orderId: f.orderId, releaseId: permit.id, kind: 'handover' }, env.ctx)
    const beforeReversal = state()
    raw().exec("CREATE TRIGGER bl17_adjustment_fail BEFORE INSERT ON worker_transactions WHEN NEW.kind = 'adjustment' BEGIN SELECT RAISE(ABORT, 'adjustment failure'); END")
    expect(() => cancelDelivery({ id: delivery.id }, env.ctx)).toThrow(/adjustment failure/)
    expect(state()).toEqual(beforeReversal)
  })

  it('rolls back manufacturing completion when commission recognition fails', () => {
    const f = manufacturing()
    const before = state()
    raw().exec("CREATE TRIGGER bl17_manufacturing_fail BEFORE INSERT ON worker_transactions WHEN NEW.kind = 'earning' BEGIN SELECT RAISE(ABORT, 'manufacturing earning failure'); END")
    expect(() => completeProduction(f.sheetId, env.ctx)).toThrow(/manufacturing earning failure/)
    expect(state()).toEqual(before)
    expect(workerBalances(f.workerId).payableMinor).toBe(0)
  })
})
