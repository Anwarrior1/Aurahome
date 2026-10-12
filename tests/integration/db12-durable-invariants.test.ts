import { issueStockForOrder } from '../helpers/finished-goods-fixture'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { reconcileDatabase } from '@main/db/reconciliation'
import { accountBalance, adjustAccountBalance, createAccount, transfer } from '@main/services/finance/cash.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase, paySupplier, updatePurchase } from '@main/services/purchasing/purchasing.service'
import { approveFinalInvoice, createFinalInvoice, createStandardFinalInvoice, orderPaymentPosition } from '@main/services/sales/final-invoices.service'
import { recordPayment, refundPayment } from '@main/services/sales/orders.service'
import {
  completeProduction, consumeForOrder, issueRelease, issueWorkSheet, issueStandardStockFromBom, recordDelivery
} from '@main/services/production/production.service'
import { createMaterialReturn } from '@main/services/production/material-returns.service'
import { addMachineUsage, createMachine } from '@main/services/production/machines.service'
import { assignWorkerToOrder, createWorker, recordWorkerTransaction } from '@main/services/production/workers.service'
import { createProduct } from '@main/services/products/products.service'
import { cancelOrder } from '@main/services/sales/orders.service'
import { createExpense, createRecurringExpense, ensureRecurringExpensesThrough } from '@main/services/finance/expenses.service'
import {
  createEmployee, deleteEmployeeTransaction, paySalary, recordEmployeeTransaction, reverseSalaryPayment, updateEmployeeTransaction
} from '@main/services/hr/employees.service'
import { confirmSavingsAllocation, recordProfitWithdrawal, recordSavingsUsage } from '@main/services/finance/profit.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})

const raw = () => getRawConnection()
const one = <T>(sql: string, ...params: unknown[]) => raw().prepare(sql).get(...params) as T
const all = (sql: string, ...params: unknown[]) => raw().prepare(sql).all(...params)
function snapshot(): Record<string, unknown[]> {
  const tables = raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
  return Object.fromEntries(tables.map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
const codes = () => reconcileDatabase(raw()).findings.map((f) => `${f.code}:${f.entity}`)

/** Every authoritative domain posted only through real services. */
function businessFixture() {
  const now = new Date()
  const year = now.getUTCFullYear(), month = now.getUTCMonth() + 1
  const accountId = createAccount({ name: 'Main', kind: 'cash', openingBalanceMinor: m(100_000) }, env.ctx)
  const bankId = createAccount({ name: 'Bank', kind: 'bank' }, env.ctx)
  transfer({ fromAccountId: accountId, toAccountId: bankId, amountMinor: m(500) }, env.ctx)
  adjustAccountBalance({ accountId: bankId, desiredBalanceMinor: m(600), reason: 'count' }, env.ctx)

  const supplierId = createSupplier({ name: 'Supplier' }, env.ctx)
  const categoryId = createCategory({ name: 'Boards' }, env.ctx)
  const materialId = createMaterial({ sku: 'MDF', name: 'MDF', categoryId, unit: 'sheet', pricingRule: 'exact', currentMarketPriceMicro: c(10) }, env.ctx)
  const purchase = createPurchase({ supplierId, lines: [{ materialId, qtyMicro: q(100), unitCostMicro: c(10) }], paidNowMinor: m(200), cashAccountId: accountId }, env.ctx)

  const customerId = createCustomer({ name: 'Customer' }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 0, requiresDelivery: true, paidAmountMinor: m(3000), initialCashAccountId: accountId,
    lines: [{ lineKind: 'custom', description: 'Wardrobe', quantityMicro: q(1), unitPriceMinor: m(10_000) }] }, env.ctx)
  const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
  recordPayment({ orderId, amountMinor: m(7000), cashAccountId: accountId }, env.ctx)
  const sheet = issueWorkSheet({ orderId }, env.ctx)
  consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: q(10) }, env.ctx)
  createMaterialReturn({ orderId, materialId, quantityMicro: q(2), requestKey: 'db12-return-0001' }, env.ctx)
  const machineId = createMachine({ name: 'Saw', costingUnit: 'hour', defaultRateMicro: c(5) }, env.ctx)
  addMachineUsage({ workSheetId: sheet.id, machineId, usageQtyMicro: q(2) }, env.ctx)
  const workerId = createWorker({ name: 'Carpenter' }, env.ctx)
  assignWorkerToOrder({ workSheetId: sheet.id, workerId, method: 'fixed', amountMinor: m(300) }, env.ctx)
  completeProduction(sheet.id, env.ctx)
  const release = issueRelease({ orderId, kind: 'transport' }, env.ctx)
  recordDelivery({ orderId, releaseId: release.id, kind: 'delivery' }, env.ctx)
  recordWorkerTransaction({ workerId, kind: 'withdrawal', amountMinor: m(10), cashAccountId: accountId }, env.ctx)

  const refundInvoice = createFinalInvoice({ customerId, depositPercentBp: 0, paidAmountMinor: m(400), initialCashAccountId: accountId,
    lines: [{ lineKind: 'custom', description: 'Shelf', quantityMicro: q(1), unitPriceMinor: m(1000) }] }, env.ctx)
  const refundOrderId = approveFinalInvoice(refundInvoice.id, env.ctx).orderId
  refundPayment({ orderId: refundOrderId, amountMinor: m(100), cashAccountId: accountId, requestKey: 'db12-refund-0001' }, env.ctx)

  const productId = createProduct({ code: 'CHAIR', name: 'Chair', bom: [{ materialId, qtyMicro: q(2.5), unit: 'sheet' }] }, env.ctx)
  const stockSheet = issueStandardStockFromBom({ productId, quantityMicro: q(2), requestKey: 'db12-stock-issue' }, env.ctx)
  const stockInvoice = createStandardFinalInvoice({ customerId, productId, quantityMicro: q(1), unitPriceMinor: m(900), depositPercentBp: 0 }, env.ctx)
  const stockOrderId = approveFinalInvoice(stockInvoice.id, env.ctx).orderId
  issueStockForOrder({ orderId: stockOrderId }, env.ctx)
  cancelOrder({ orderId: stockOrderId, reason: 'wrong unit' }, env.ctx)
  const nextInvoice = createStandardFinalInvoice({ customerId, productId, quantityMicro: q(1), unitPriceMinor: m(900), depositPercentBp: 0 }, env.ctx)
  issueStockForOrder({ orderId: approveFinalInvoice(nextInvoice.id, env.ctx).orderId }, env.ctx)

  createExpense({ amountMinor: m(50), cashAccountId: accountId, description: 'Fuel' }, env.ctx)
  createRecurringExpense({ description: 'Rent', amountMinor: m(20), cashAccountId: accountId, startDate: '2026-01-01' }, env.ctx)
  ensureRecurringExpensesThrough('2026-01-01', '2026-03-31')

  const employeeId = createEmployee({ name: 'Clerk', monthlySalaryMinor: m(1000) }, env.ctx)
  const salary = paySalary({ employeeId, amountMinor: m(1000), deductionMinor: m(100), periodYear: 2026, periodMonth: 1, cashAccountId: accountId }, env.ctx)
  reverseSalaryPayment(salary.transactionId, env.ctx)
  paySalary({ employeeId, amountMinor: m(900), periodYear: 2026, periodMonth: 1, cashAccountId: accountId }, env.ctx)
  const advanceId = recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: m(200), cashAccountId: accountId }, env.ctx)
  recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: m(50), cashAccountId: accountId }, env.ctx)

  confirmSavingsAllocation({ year, month }, env.ctx)
  recordSavingsUsage({ amountMinor: 1, cashAccountId: accountId }, env.ctx)
  recordProfitWithdrawal({ amountMinor: 1, cashAccountId: accountId }, env.ctx)

  return { accountId, bankId, purchaseId: purchase.id, orderId, refundOrderId, stockOrderId, sheetId: sheet.id, stockSheetId: stockSheet.workSheetId,
    materialId, productId, employeeId, advanceId, salaryId: salary.transactionId, workerId }
}

describe('DB-12 reconciliation', () => {
  it('reports nothing for complete real-service history, deterministically and without writing', () => {
    businessFixture()
    const before = snapshot()
    const changes = one<{ c: number }>('SELECT total_changes() AS c')
    const first = reconcileDatabase(raw())
    expect(first).toMatchObject({ errorCount: 0, warningCount: 0, findings: [] })
    expect(first.checksRun).toBeGreaterThan(60)
    expect(reconcileDatabase(raw())).toEqual(first)
    expect(one('SELECT total_changes() AS c')).toEqual(changes)
    expect(snapshot()).toEqual(before)
  })

  const FG_SALE = "SELECT id FROM finished_goods_movements WHERE kind = 'sale_out' ORDER BY id DESC LIMIT 1"
  it.each<[string, string, (f: ReturnType<typeof businessFixture>) => void]>([
    ['CASH_SOURCE_MIRROR_MISMATCH:customer_payments', 'payment mirror amount', () => raw().exec("UPDATE cash_transactions SET amount_minor = amount_minor + 1 WHERE ref_table = 'customer_payments'")],
    ['CASH_SOURCE_MIRROR_MISMATCH:employee_transactions', 'advance mirror removed', (f) => raw().prepare("DELETE FROM cash_transactions WHERE ref_table = 'employee_transactions' AND ref_id = ?").run(f.advanceId)],
    ['CASH_SOURCE_MIRROR_MISMATCH:supplier_payments', 'supplier mirror account', (f) => raw().prepare("UPDATE cash_transactions SET account_id = ? WHERE ref_table = 'supplier_payments'").run(f.bankId)],
    ['CASH_ORPHAN_MIRROR:cash_transactions', 'orphan mirror', (f) => raw().prepare("INSERT INTO cash_transactions (account_id, direction, amount_minor, kind, ref_table, ref_id, occurred_at) VALUES (?, 'out', 1, 'expense', 'expenses', 999999, '2026-01-01')").run(f.accountId)],
    ['CASH_TRANSFER_LEGS_MISMATCH:cash_transactions', 'one transfer leg', () => raw().exec("DELETE FROM cash_transactions WHERE kind = 'transfer_in'")],
    ['CASH_REVERSAL_MISMATCH:cash_transactions', 'salary reversal amount', () => raw().exec("UPDATE cash_transactions SET amount_minor = amount_minor + 1 WHERE kind = 'salary_reversal'")],
    ['ORDER_PAYMENT_CACHE_DRIFT:orders', 'order cache', (f) => raw().prepare('UPDATE orders SET paid_minor = 0 WHERE id = ?').run(f.orderId)],
    ['REFUND_ALLOCATION_MISMATCH:customer_payment_refunds', 'refund allocation', () => raw().exec('UPDATE customer_payment_refund_allocations SET amount_minor = amount_minor - 1')],
    ['PURCHASE_PAID_CACHE_DRIFT:purchases', 'purchase paid cache', (f) => raw().prepare('UPDATE purchases SET paid_minor = paid_minor + 1 WHERE id = ?').run(f.purchaseId)],
    ['PURCHASE_TOTAL_MISMATCH:purchases', 'purchase total', (f) => raw().prepare('UPDATE purchases SET total_minor = total_minor + 1 WHERE id = ?').run(f.purchaseId)],
    ['FIFO_LAYER_ALLOCATION_BALANCE:fifo_layers', 'layer remainder', () => raw().exec("UPDATE fifo_layers SET qty_remaining_micro = qty_remaining_micro - 1 WHERE source_kind = 'purchase'")],
    ['INVENTORY_LEDGER_LAYER_MISMATCH:materials', 'stock vs ledger', () => raw().exec("UPDATE fifo_layers SET qty_remaining_micro = qty_remaining_micro - 1 WHERE source_kind = 'purchase'")],
    ['INVENTORY_ALLOCATION_MISMATCH:inventory_movements', 'allocation cost', () => raw().exec("UPDATE fifo_allocations SET cost_minor = cost_minor + 1 WHERE movement_id = (SELECT MIN(id) FROM inventory_movements WHERE kind = 'consumption')")],
    ['MATERIAL_ISSUE_MOVEMENT_MISMATCH:order_material_lines', 'issue line cost', () => raw().exec('UPDATE order_material_lines SET actual_cost_minor = actual_cost_minor + 1')],
    ['MATERIAL_RETURN_BALANCE_MISMATCH:material_returns', 'return header', () => raw().exec('UPDATE material_returns SET quantity_micro = quantity_micro + 1')],
    ['FG_VALUATION_STATE_INVALID:products', 'fg over-issue', () => raw().exec(`UPDATE finished_goods_movements SET qty_micro = qty_micro * 10 WHERE id = (${FG_SALE})`)],
    ['FG_REVERSAL_MISMATCH:finished_goods_movements', 'fg reversal cost', () => raw().exec("UPDATE finished_goods_movements SET total_cost_minor = total_cost_minor + 1 WHERE kind = 'sale_reversal'")],
    ['FG_PRODUCTION_LINK_MISMATCH:work_sheets', 'fg production qty', () => raw().exec("UPDATE finished_goods_movements SET qty_micro = qty_micro + 1 WHERE kind = 'production_in'")],
    ['SALARY_EXPENSE_LINK_MISMATCH:employee_transactions', 'salary expense amount', () => raw().exec("UPDATE expenses SET amount_minor = amount_minor + 1 WHERE source = 'salary' AND reversed_at IS NULL")],
    ['EMPLOYEE_ADVANCE_BALANCE_NEGATIVE:employees', 'repayment over advance', () => raw().exec("UPDATE employee_transactions SET amount_minor = 999999999 WHERE kind = 'repayment'")],
    ['WORKER_EARNINGS_ASSIGNMENT_MISMATCH:orders', 'earning amount', () => raw().exec("UPDATE worker_transactions SET amount_minor = amount_minor + 1 WHERE kind = 'earning'")],
    ['RECURRING_OCCURRENCE_DUPLICATE:expenses', 'duplicate occurrence', () => raw().exec("INSERT INTO expenses (category_id, kind, amount_minor, cash_account_id, description, spent_at, source, source_ref_id) SELECT category_id, kind, amount_minor, NULL, description, spent_at, source, source_ref_id FROM expenses WHERE source = 'recurring' ORDER BY id LIMIT 1")],
    ['SAVINGS_ALLOCATION_DUPLICATE_PERIOD:savings_allocations', 'duplicate allocation', () => raw().exec("INSERT INTO savings_allocations (period_year, period_month, net_profit_minor, rate_bp, amount_minor, confirmed_at) SELECT period_year, period_month, net_profit_minor, rate_bp, amount_minor, confirmed_at FROM savings_allocations")],
    ['SAVINGS_ALLOCATION_LEDGER_MISMATCH:savings_allocations', 'allocation ledger', () => raw().exec("UPDATE savings_transactions SET amount_minor = amount_minor + 1 WHERE kind = 'allocation'")],
    ['WORKSHEET_LIFECYCLE_MISMATCH:work_sheets', 'worksheet timestamp', (f) => raw().prepare('UPDATE work_sheets SET completed_at = NULL WHERE id = ?').run(f.sheetId)],
    ['ORDER_LIFECYCLE_TIMESTAMP_MISMATCH:orders', 'order timestamp', (f) => raw().prepare('UPDATE orders SET completed_at = NULL WHERE id = ?').run(f.orderId)]
  ])('detects %s (%s)', (expected, _label, mutate) => {
    const fixture = businessFixture()
    mutate(fixture)
    expect(codes()).toContain(expected)
  })

  it('bounds the sample payload while counting every violating row', () => {
    const accountId = createAccount({ name: 'Bulk', kind: 'cash' }, env.ctx)
    const insert = raw().prepare("INSERT INTO cash_transactions (account_id, direction, amount_minor, kind, ref_table, ref_id, occurred_at) VALUES (?, 'out', 1, 'expense', 'expenses', ?, '2026-01-01')")
    raw().transaction(() => { for (let i = 1; i <= 250; i += 1) insert.run(accountId, 1_000_000 + i) })()
    const finding = reconcileDatabase(raw(), { sampleLimit: 5 }).findings.find((f) => f.code === 'CASH_ORPHAN_MIRROR')!
    expect(finding.count).toBe(250)
    expect(finding.sampleIds).toHaveLength(5)
    expect(finding.sampleIds).toEqual([...finding.sampleIds].sort((a, b) => a - b))
    expect(reconcileDatabase(raw(), { sampleLimit: 10_000 }).findings[0]!.sampleIds).toHaveLength(100)
  })
})

describe('DB-12 employee advance/repayment cash mirror', () => {
  let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
  beforeEach(async () => {
    handlers = new Map()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
  })
  const mirrors = (id: number) => all("SELECT account_id AS accountId, direction, amount_minor AS amountMinor, kind FROM cash_transactions WHERE ref_table = 'employee_transactions' AND ref_id = ?", id)
  function seed() {
    const employeeId = createEmployee({ name: 'E', monthlySalaryMinor: m(1000) }, env.ctx)
    const accountId = createAccount({ name: 'Cash', kind: 'cash', openingBalanceMinor: m(5000) }, env.ctx)
    return { employeeId, accountId }
  }

  it('assigning an account over IPC posts exactly one mirror; retries and later corrections move that same mirror', async () => {
    const { employeeId, accountId } = seed()
    const id = recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: m(200) }, env.ctx)
    const request = { id, cashAccountId: accountId, amountMinor: m(300) }
    const event = { sender: { id: 1 } } as IpcMainInvokeEvent
    expect(await handlers.get(C.employees.updateTransaction)!(event, request)).toMatchObject({ ok: true })
    expect(await handlers.get(C.employees.updateTransaction)!(event, request)).toMatchObject({ ok: true })
    expect(mirrors(id)).toEqual([{ accountId, direction: 'out', amountMinor: m(300), kind: 'employee_advance' }])
    expect(accountBalance(accountId)).toBe(m(4700))
    const repayment = recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: m(100) }, env.ctx)
    updateEmployeeTransaction(repayment, { cashAccountId: accountId }, env.ctx)
    updateEmployeeTransaction(repayment, { amountMinor: m(150) }, env.ctx)
    expect(mirrors(repayment)).toEqual([{ accountId, direction: 'in', amountMinor: m(150), kind: 'employee_repayment' }])
    expect(accountBalance(accountId)).toBe(m(4850))
    expect(reconcileDatabase(raw()).findings).toEqual([])
    deleteEmployeeTransaction(repayment, env.ctx)
    expect(mirrors(repayment)).toEqual([])
    expect(reconcileDatabase(raw()).findings).toEqual([])
  })

  it('fails closed on a contradictory historical mirror and changes nothing', () => {
    const { employeeId, accountId } = seed()
    const id = recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: m(200), cashAccountId: accountId }, env.ctx)
    raw().prepare("DELETE FROM cash_transactions WHERE ref_table = 'employee_transactions' AND ref_id = ?").run(id)
    expect(codes()).toContain('CASH_SOURCE_MIRROR_MISMATCH:employee_transactions')
    const before = snapshot()
    expect(() => updateEmployeeTransaction(id, { amountMinor: m(250) }, env.ctx)).toThrow(/رابط حركتها النقدية/)
    expect(() => deleteEmployeeTransaction(id, env.ctx)).toThrow(/رابط حركتها النقدية/)
    expect(snapshot()).toEqual(before)
  })

  it.each([
    ['mirror insert', "CREATE TRIGGER db12_fail BEFORE INSERT ON cash_transactions WHEN NEW.kind = 'employee_advance' BEGIN SELECT RAISE(ABORT, 'db12 injected'); END"],
    ['audit insert', "CREATE TRIGGER db12_fail BEFORE INSERT ON audit_log WHEN NEW.action = 'employees.advance.update' BEGIN SELECT RAISE(ABORT, 'db12 injected'); END"]
  ])('rolls back source, mirror and audit together when the %s fails', (_label, trigger) => {
    const { employeeId, accountId } = seed()
    const id = recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: m(200) }, env.ctx)
    const before = snapshot()
    raw().exec(trigger)
    expect(() => updateEmployeeTransaction(id, { cashAccountId: accountId }, env.ctx)).toThrow(/db12 injected/)
    raw().exec('DROP TRIGGER db12_fail')
    expect(snapshot()).toEqual(before)
    updateEmployeeTransaction(id, { cashAccountId: accountId }, env.ctx)
    expect(mirrors(id)).toHaveLength(1)
  })

  it('rolls back a deletion when its audit fails', () => {
    const { employeeId, accountId } = seed()
    const id = recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: m(200), cashAccountId: accountId }, env.ctx)
    const before = snapshot()
    raw().exec("CREATE TRIGGER db12_fail BEFORE INSERT ON audit_log WHEN NEW.action = 'employees.advance.delete' BEGIN SELECT RAISE(ABORT, 'db12 injected'); END")
    expect(() => deleteEmployeeTransaction(id, env.ctx)).toThrow(/db12 injected/)
    raw().exec('DROP TRIGGER db12_fail')
    expect(snapshot()).toEqual(before)
  })

  it('a second SQLite writer cannot interleave: busy fails whole, a committed mirror removal then fails closed', () => {
    const { employeeId, accountId } = seed()
    const id = recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: m(200), cashAccountId: accountId }, env.ctx)
    const file = (raw().pragma('database_list') as Array<{ name: string; file: string }>).find((row) => row.name === 'main')!.file
    const competing = new Database(file)
    raw().pragma('busy_timeout = 1')
    try {
      const before = snapshot()
      competing.exec('BEGIN IMMEDIATE')
      competing.prepare("DELETE FROM cash_transactions WHERE ref_table = 'employee_transactions' AND ref_id = ?").run(id)
      expect(() => updateEmployeeTransaction(id, { amountMinor: m(250) }, env.ctx)).toThrow(/locked|busy/i)
      expect(snapshot()).toEqual(before)
      competing.exec('COMMIT')
      expect(() => updateEmployeeTransaction(id, { amountMinor: m(250) }, env.ctx)).toThrow(/رابط حركتها النقدية/)
      expect(one('SELECT amount_minor AS a FROM employee_transactions WHERE id = ?', id)).toEqual({ a: m(200) })
    } finally {
      if (competing.inTransaction) competing.exec('ROLLBACK')
      competing.close()
    }
  })
})

describe('DB-12 shared mirror correction and exit-permit authority', () => {
  it('a purchase account move refuses to re-point a missing supplier-payment mirror', () => {
    const supplierId = createSupplier({ name: 'S' }, env.ctx)
    const categoryId = createCategory({ name: 'Cat' }, env.ctx)
    const materialId = createMaterial({ sku: 'M', name: 'M', categoryId, unit: 'sheet', pricingRule: 'exact', currentMarketPriceMicro: c(1) }, env.ctx)
    const a = createAccount({ name: 'A', kind: 'cash', openingBalanceMinor: m(1000) }, env.ctx)
    const b = createAccount({ name: 'B', kind: 'cash', openingBalanceMinor: m(1000) }, env.ctx)
    const purchase = createPurchase({ supplierId, lines: [{ materialId, qtyMicro: q(1), unitCostMicro: c(100) }] }, env.ctx)
    const paymentId = paySupplier({ supplierId, purchaseId: purchase.id, amountMinor: m(100), cashAccountId: a }, env.ctx)
    updatePurchase(purchase.id, { cashAccountId: b }, env.ctx)
    expect(all("SELECT account_id AS a FROM cash_transactions WHERE ref_table = 'supplier_payments' AND ref_id = ?", paymentId)).toEqual([{ a: b }])
    raw().prepare("DELETE FROM cash_transactions WHERE ref_table = 'supplier_payments' AND ref_id = ?").run(paymentId)
    const before = snapshot()
    expect(() => updatePurchase(purchase.id, { cashAccountId: a }, env.ctx)).toThrow(/غير مكتمل أو مكرر/)
    expect(snapshot()).toEqual(before)
  })

  function paidOrder() {
    const customerId = createCustomer({ name: 'C' }, env.ctx)
    const accountId = createAccount({ name: 'Cash', kind: 'cash' }, env.ctx)
    const invoice = createFinalInvoice({ customerId, depositPercentBp: 0, requiresDelivery: true,
      lines: [{ lineKind: 'custom', description: 'X', quantityMicro: q(1), unitPriceMinor: m(1000) }] }, env.ctx)
    const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
    return { orderId, accountId }
  }

  it('a stale-low payment cache no longer blocks or falsifies a fully paid exit permit', () => {
    const { orderId, accountId } = paidOrder()
    recordPayment({ orderId, amountMinor: m(1000), cashAccountId: accountId }, env.ctx)
    raw().prepare("UPDATE orders SET paid_minor = 0, remaining_minor = total_minor, payment_status = 'unpaid' WHERE id = ?").run(orderId)
    const release = issueRelease({ orderId, kind: 'transport' }, env.ctx)
    expect(one('SELECT authorization_type AS t, paid_minor_at_issue AS p, remaining_minor_at_issue AS r FROM releases WHERE id = ?', release.id))
      .toEqual({ t: 'fully_paid', p: m(1000), r: 0 })
  })

  it('a stale-high payment cache cannot falsify an unpaid permit snapshot', () => {
    const { orderId } = paidOrder()
    raw().prepare("UPDATE orders SET paid_minor = total_minor, remaining_minor = 0, payment_status = 'paid' WHERE id = ?").run(orderId)
    expect(orderPaymentPosition(orderId).paidMinor).toBe(0)
    const release = issueRelease({ orderId, kind: 'transport' }, env.ctx)
    expect(one('SELECT authorization_type AS t, paid_minor_at_issue AS p, remaining_minor_at_issue AS r FROM releases WHERE id = ?', release.id))
      .toEqual({ t: 'unpaid', p: 0, r: m(1000) })
  })
})
