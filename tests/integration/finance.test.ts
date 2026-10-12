import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { consumeForOrder, recordDelivery, issueWorkSheet, issueRelease, completeProduction } from '@main/services/production/production.service'
import { createEmployee, paySalary, employeeBalance, recordEmployeeTransaction } from '@main/services/hr/employees.service'
import { createExpense, listExpenses, updateExpense, deleteExpense } from '@main/services/finance/expenses.service'
import { createAccount, accountBalance, transfer, listAccounts } from '@main/services/finance/cash.service'
import {
  monthlyProfitSummary, confirmSavingsAllocation, recordProfitWithdrawal,
  availableProfitMinor, savingsBalanceMinor, recordSavingsUsage, listWithdrawals,
  updateProfitWithdrawal, deleteProfitWithdrawal, setSavingsRateBp
} from '@main/services/finance/profit.service'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { closeDatabase, getDatabase, getRawConnection } from '@main/db/connection'
import { sql } from 'drizzle-orm'
import { fmtMoney } from '@renderer/lib/format'
import { recordWaste } from '@main/services/inventory/inventory.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'


let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const NOW = new Date()
const YEAR = NOW.getUTCFullYear()
const MONTH = NOW.getUTCMonth() + 1

function completedOrder(sellingPrice: number, materialQty = 10) {
  const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
  const materialId = createMaterial({
    sku: `M-${Math.random().toString(36).slice(2, 8)}`, name: 'مادة', categoryId, unit: 'لوح',
    currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
  } as never, env.ctx)
  const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
  createPurchase({
    supplierId,
    lines: [{ materialId, qtyMicro: quantityFromDisplay(100), unitCostMicro: unitCostFromMajor(100) }]
  }, env.ctx)

  const customerId = createCustomer({ name: 'عميل' }, env.ctx)
  const quotation = createFinalInvoice({
    customerId,
    lines: [{ lineKind: 'custom', description: 'طلب', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(sellingPrice) }]
  }, env.ctx)
  const order = approveToOrder(quotation.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(sellingPrice) }, env.ctx)
  // Production-workflow pass: material is consumed against a production
  // order, and goods only leave the factory under an exit permit.
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
  consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(materialQty) }, env.ctx)
  completeProduction(sheet.id, env.ctx)
  issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
  recordDelivery({ orderId: order.id, kind: 'delivery' }, env.ctx)
  return { orderId: order.id, materialId, workSheetId: sheet.id }
}

describe('Monthly profit on a completed-orders basis (BR-105, BR-106, BR-100)', () => {
  it('recognises revenue and full actual cost in the month the order completes', () => {
    completedOrder(10000, 10) // 10,000 revenue, 1,000 material cost
    const summary = monthlyProfitSummary(YEAR, MONTH)

    expect(summary.completedOrderCount).toBe(1)
    expect(summary.revenueMinor).toBe(moneyFromMajor(10000))
    expect(summary.materialCostMinor).toBe(moneyFromMajor(1000))
    expect(summary.grossOrderProfitMinor).toBe(moneyFromMajor(9000))
    expect(summary.netProfitMinor).toBe(moneyFromMajor(9000))
  })

  it('subtracts general expenses and waste losses, but not order-linked expenses twice', () => {
    const { orderId, materialId } = completedOrder(10000, 10)
    // A general operational expense.
    createExpense({ kind: 'variable', amountMinor: moneyFromMajor(500), description: 'كهرباء' }, env.ctx)
    // An order-linked expense — a DIRECT order cost, not a general one.
    createExpense({ kind: 'variable', amountMinor: moneyFromMajor(200), description: 'نقل خاص', orderId }, env.ctx)
    // Waste is a general operational loss (BR-49).
    recordWaste({ materialId, qtyMicro: quantityFromDisplay(1), reason: 'تلف', ctx: env.ctx })

    const summary = monthlyProfitSummary(YEAR, MONTH)
    expect(summary.orderLinkedExpensesMinor).toBe(moneyFromMajor(200))
    expect(summary.generalExpensesMinor).toBe(moneyFromMajor(500))
    expect(summary.wasteLossMinor).toBe(moneyFromMajor(100))
    // 10,000 − (1,000 material + 200 linked) − 500 general − 100 waste = 8,200
    expect(summary.netProfitMinor).toBe(moneyFromMajor(8200))
  })

  it('excludes cash transfers from revenue and expenses (BR-114)', () => {
    const a = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    const b = createAccount({ name: 'البنك', kind: 'bank' }, env.ctx)
    transfer({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(2000) }, env.ctx)

    expect(accountBalance(a)).toBe(moneyFromMajor(3000))
    expect(accountBalance(b)).toBe(moneyFromMajor(2000))
    // A transfer moves money without touching profit.
    expect(monthlyProfitSummary(YEAR, MONTH).netProfitMinor).toBe(0)
  })
})

describe('Savings & Investment (BR-98, BR-110, BR-111)', () => {
  it('proposes 10% of net profit and requires owner confirmation', () => {
    completedOrder(10000, 10) // net profit 9,000
    const before = monthlyProfitSummary(YEAR, MONTH)
    expect(before.savingsRateBp).toBe(1000)
    expect(before.savingsProposedMinor).toBe(moneyFromMajor(900))
    expect(before.allocationConfirmed).toBe(false)
    expect(savingsBalanceMinor()).toBe(0) // nothing allocated until confirmed

    const result = confirmSavingsAllocation({ year: YEAR, month: MONTH }, env.ctx)
    expect(result.amountMinor).toBe(moneyFromMajor(900))
    expect(savingsBalanceMinor()).toBe(moneyFromMajor(900))
    expect(monthlyProfitSummary(YEAR, MONTH).allocationConfirmed).toBe(true)
  })

  it('stores the rate used so a later rate change never rewrites history', () => {
    completedOrder(10000, 10)
    confirmSavingsAllocation({ year: YEAR, month: MONTH }, env.ctx)

    setSavingsRateBp(2000, env.ctx) // change to 20%, through the Savings module's own route
    // The confirmed allocation keeps its original 10% amount.
    expect(savingsBalanceMinor()).toBe(moneyFromMajor(900))
  })

  it('allocates NOTHING in a loss month and leaves the fund untouched (BR-111)', () => {
    completedOrder(10000, 10)
    confirmSavingsAllocation({ year: YEAR, month: MONTH }, env.ctx)
    const fundBefore = savingsBalanceMinor()

    // Push the month into a loss with a large general expense.
    createExpense({ kind: 'fixed', amountMinor: moneyFromMajor(20000), description: 'إيجار سنوي' }, env.ctx)
    const summary = monthlyProfitSummary(YEAR, MONTH)
    expect(summary.netProfitMinor).toBeLessThan(0)
    expect(summary.savingsProposedMinor).toBe(0)
    // The existing fund balance is never reduced by a loss.
    expect(savingsBalanceMinor()).toBe(fundBefore)
  })

  it('refuses to use more than the fund holds (BR-99)', () => {
    completedOrder(10000, 10)
    confirmSavingsAllocation({ year: YEAR, month: MONTH }, env.ctx)
    expect(() => recordSavingsUsage({ amountMinor: moneyFromMajor(5000) }, env.ctx))
      .toThrowError(/رصيد صندوق/)
    recordSavingsUsage({ amountMinor: moneyFromMajor(400) }, env.ctx)
    expect(savingsBalanceMinor()).toBe(moneyFromMajor(500))
  })
})

describe('Dashboard remaining profit', () => {
  it('matches the source screen after financial changes and reopening the database', () => {
    completedOrder(20000, 10)
    const request = {
      date: NOW.toISOString().slice(0, 10), year: YEAR, month: MONTH, currentDay: true
    }
    function check(): number {
      const source = monthlyProfitSummary(YEAR, MONTH)
      const dashboard = dashboardSummary(request, env.ctx.session)
      expect(dashboard.profits).toMatchObject({
        netProfitMinor: source.netProfitMinor,
        completedOrderCount: source.completedOrderCount,
        remainingProfitMinor: source.remainingProfitMinor
      })
      const value = (dashboard.profits as { remainingProfitMinor: number }).remainingProfitMinor
      expect(fmtMoney(value)).toBe(fmtMoney(source.remainingProfitMinor))
      return value
    }
    check()
    confirmSavingsAllocation({ year: YEAR, month: MONTH }, env.ctx)
    check()
    recordProfitWithdrawal({ amountMinor: moneyFromMajor(1560) }, env.ctx)
    expect(check()).toBe(moneyFromMajor(15540))
    expect(fmtMoney(check())).toBe(`${new Intl.NumberFormat('ar-LY-u-nu-latn', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(15540)} د.ل`)
    const expense = createExpense({
      kind: 'variable', amountMinor: moneyFromMajor(100), description: 'خصم تشغيلي'
    }, env.ctx)
    expect(check()).toBe(moneyFromMajor(15440))
    updateExpense(expense, { amountMinor: moneyFromMajor(200) }, env.ctx)
    expect(check()).toBe(moneyFromMajor(15340))
    deleteExpense(expense, env.ctx)
    expect(check()).toBe(moneyFromMajor(15540))
    closeDatabase()
    expect(check()).toBe(moneyFromMajor(15540))
    const otherMonth = MONTH === 12 ? 1 : MONTH + 1
    expect(dashboardSummary({ ...request, month: otherMonth }, env.ctx.session).profits)
      .toMatchObject({ remainingProfitMinor: monthlyProfitSummary(YEAR, otherMonth).remainingProfitMinor })
  })
})

describe('Profit withdrawals (BR-96, BR-101, BR-113)', () => {
  it('BLOCKS a withdrawal larger than the available profit', () => {
    completedOrder(10000, 10) // net profit 9,000
    confirmSavingsAllocation({ year: YEAR, month: MONTH }, env.ctx) // −900

    expect(availableProfitMinor()).toBe(moneyFromMajor(8100))
    expect(() => recordProfitWithdrawal({ amountMinor: moneyFromMajor(9000) }, env.ctx))
      .toThrowError(/يتجاوز الأرباح المتاحة/)

    const result = recordProfitWithdrawal({ amountMinor: moneyFromMajor(2000) }, env.ctx)
    expect(result.availableAfterMinor).toBe(moneyFromMajor(6100))
  })

  it('never treats a withdrawal as an operating expense (BR-96/BR-101)', () => {
    completedOrder(10000, 10)
    const before = monthlyProfitSummary(YEAR, MONTH)
    recordProfitWithdrawal({ amountMinor: moneyFromMajor(2000) }, env.ctx)
    const after = monthlyProfitSummary(YEAR, MONTH)

    // Net profit and operating expenses are unchanged by the withdrawal.
    expect(after.netProfitMinor).toBe(before.netProfitMinor)
    expect(after.generalExpensesMinor).toBe(before.generalExpensesMinor)
    // It is reported separately, and reduces only the remaining figure.
    expect(after.profitWithdrawalsMinor).toBe(moneyFromMajor(2000))
    expect(after.remainingProfitMinor).toBe(before.netProfitMinor - moneyFromMajor(2000))
  })
})

describe('Profit withdrawal corrections', () => {
  function request(id: number) {
    const row = listWithdrawals().items.find((entry) => entry.id === id)!
    const { amountMinor, person, notes, withdrawnAt, cashAccountId, createdAt } = row
    return { id, expected: { amountMinor, person, notes, withdrawnAt, cashAccountId, createdAt } }
  }
  function audit(id: number) {
    return getDatabase().all<{ action: string; userId: number; details: string; createdAt: string }>(sql`
      SELECT action, user_id AS userId, details, created_at AS createdAt FROM audit_log
      WHERE entity = 'profit_withdrawals' AND entity_id = ${String(id)} ORDER BY id
    `)
  }
  function cashCount(id: number): number {
    return getDatabase().get<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM cash_transactions WHERE ref_table = 'profit_withdrawals' AND ref_id = ${id}
    `)!.count
  }

  it('corrects 2000 to 1500 then deletes, synchronizing cash/profit/Dashboard and persisting through reopen', () => {
    completedOrder(21000, 10)
    const accountId = createAccount({ name: 'صندوق التصحيح', kind: 'cash', openingBalanceMinor: moneyFromMajor(10000) }, env.ctx)
    const { id } = recordProfitWithdrawal({ amountMinor: moneyFromMajor(2000), person: 'المالك', notes: 'قبل', cashAccountId: accountId }, env.ctx)
    const before = monthlyProfitSummary(YEAR, MONTH)
    const available = availableProfitMinor()
    const cash = accountBalance(accountId)
    const oldRequest = request(id)
    updateProfitWithdrawal({ ...oldRequest, amountMinor: moneyFromMajor(1500), person: 'مستلم', notes: 'بعد' }, env.ctx)
    expect(listWithdrawals().summary.totalWithdrawnMinor).toBe(moneyFromMajor(1500))
    expect(monthlyProfitSummary(YEAR, MONTH).remainingProfitMinor).toBe(before.remainingProfitMinor + moneyFromMajor(500))
    expect(monthlyProfitSummary(YEAR, MONTH).netProfitMinor).toBe(before.netProfitMinor)
    expect(availableProfitMinor()).toBe(available + moneyFromMajor(500))
    expect(accountBalance(accountId)).toBe(cash + moneyFromMajor(500))
    expect(cashCount(id)).toBe(1)
    expect(listWithdrawals().items[0]).toMatchObject({ person: 'مستلم', notes: 'بعد' })
    expect(() => updateProfitWithdrawal({ ...oldRequest, amountMinor: moneyFromMajor(1500), person: 'مستلم', notes: 'بعد' }, env.ctx)).toThrow(/تم تغيير/)
    const dashboardInput = { date: NOW.toISOString().slice(0, 10), year: YEAR, month: MONTH, currentDay: true }
    expect(dashboardSummary(dashboardInput, env.ctx.session).profits).toMatchObject({ remainingProfitMinor: monthlyProfitSummary(YEAR, MONTH).remainingProfitMinor })
    closeDatabase()
    expect(listWithdrawals().summary.totalWithdrawnMinor).toBe(moneyFromMajor(1500))
    expect(accountBalance(accountId)).toBe(cash + moneyFromMajor(500))
    const deletion = request(id)
    deleteProfitWithdrawal(deletion, env.ctx)
    expect(listWithdrawals().items).toHaveLength(0)
    expect(listWithdrawals().summary.totalWithdrawnMinor).toBe(0)
    expect(monthlyProfitSummary(YEAR, MONTH).remainingProfitMinor).toBe(before.remainingProfitMinor + moneyFromMajor(2000))
    expect(availableProfitMinor()).toBe(available + moneyFromMajor(2000))
    expect(accountBalance(accountId)).toBe(moneyFromMajor(10000))
    expect(cashCount(id)).toBe(0)
    expect(dashboardSummary(dashboardInput, env.ctx.session).profits).toMatchObject({ remainingProfitMinor: monthlyProfitSummary(YEAR, MONTH).remainingProfitMinor })
    expect(() => deleteProfitWithdrawal(deletion, env.ctx)).toThrow(/غير موجود/)
    expect(() => updateProfitWithdrawal({ ...deletion, amountMinor: moneyFromMajor(500), person: null, notes: null }, env.ctx)).toThrow(/غير موجود/)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(10000))
    const events = audit(id)
    expect(events.map((entry) => entry.action)).toEqual(['withdrawals.create', 'withdrawals.update', 'withdrawals.delete'])
    expect(events.every((entry) => entry.userId === env.ctx.session.user.id && Boolean(entry.createdAt))).toBe(true)
    expect(JSON.parse(events[1]!.details)).toMatchObject({ before: { amountMinor: moneyFromMajor(2000) }, after: { amountMinor: moneyFromMajor(1500), person: 'مستلم', notes: 'بعد' } })
    expect(JSON.parse(events[2]!.details)).toMatchObject({ before: { amountMinor: moneyFromMajor(1500) } })
    closeDatabase()
    expect(listWithdrawals().summary.totalWithdrawnMinor).toBe(0)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(10000))
    expect(audit(id)).toHaveLength(3)
  })

  it('validates edits, rejects stale deletion and excessive increases, and permits reductions in a loss period', () => {
    completedOrder(10000, 10)
    const { id } = recordProfitWithdrawal({ amountMinor: moneyFromMajor(2000) }, env.ctx)
    const original = request(id)
    for (const amountMinor of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => updateProfitWithdrawal({ ...original, amountMinor, person: null, notes: null }, env.ctx)).toThrow(/غير صحيحة/)
    }
    expect(() => updateProfitWithdrawal({ ...original, amountMinor: moneyFromMajor(10000), person: null, notes: null }, env.ctx)).toThrow(/يتجاوز/)
    updateProfitWithdrawal({ ...original, amountMinor: moneyFromMajor(2500), person: null, notes: null }, env.ctx)
    expect(() => deleteProfitWithdrawal(original, env.ctx)).toThrow(/تم تغيير/)
    const current = request(id)
    const auditCount = audit(id).length
    updateProfitWithdrawal({ ...current, amountMinor: current.expected.amountMinor, person: current.expected.person, notes: current.expected.notes }, env.ctx)
    expect(audit(id)).toHaveLength(auditCount)
    createExpense({ kind: 'variable', description: 'خسارة لاحقة', amountMinor: moneyFromMajor(20000) }, env.ctx)
    updateProfitWithdrawal({ ...request(id), amountMinor: moneyFromMajor(1500), person: null, notes: null }, env.ctx)
    expect(listWithdrawals().summary.totalWithdrawnMinor).toBe(moneyFromMajor(1500))
    expect(cashCount(id)).toBe(0)
  })

  it('rolls back both source and linked cash corrections/deletion if auditing fails', () => {
    completedOrder(10000, 10)
    const cashAccountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    const { id } = recordProfitWithdrawal({ amountMinor: moneyFromMajor(2000), cashAccountId }, env.ctx)
    const original = request(id)
    getRawConnection().exec(`CREATE TRIGGER fail_withdrawal_audit BEFORE INSERT ON audit_log
      WHEN NEW.action IN ('withdrawals.update', 'withdrawals.delete')
      BEGIN SELECT RAISE(ABORT, 'audit failure'); END`)
    expect(() => updateProfitWithdrawal({ ...original, amountMinor: moneyFromMajor(1500), person: null, notes: null }, env.ctx)).toThrow(/audit failure/)
    expect(() => deleteProfitWithdrawal(original, env.ctx)).toThrow(/audit failure/)
    expect(listWithdrawals().summary.totalWithdrawnMinor).toBe(moneyFromMajor(2000))
    expect(accountBalance(cashAccountId)).toBe(moneyFromMajor(3000))
    expect(cashCount(id)).toBe(1)
    expect(audit(id)).toHaveLength(1)
  })
})

describe('Employee salaries (BR-91, BR-109)', () => {
  it('posts a salary payment exactly once as a Fixed operating expense — via payroll, never generalExpensesMinor', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(1500), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    const salaryExpenses = listExpenses({}).items.filter((e) => e.source === 'salary')
    expect(salaryExpenses).toHaveLength(1)
    expect(salaryExpenses[0]?.kind).toBe('fixed')
    expect(salaryExpenses[0]?.amountMinor).toBe(moneyFromMajor(1500))

    // Recognised for its own payroll PERIOD, in its own named figure —
    // never folded into generalExpensesMinor a second time.
    const summary = monthlyProfitSummary(YEAR, MONTH)
    expect(summary.payrollExpenseMinor).toBe(moneyFromMajor(1500))
    expect(summary.generalExpensesMinor).toBe(0)
    expect(summary.netProfitMinor).toBe(-moneyFromMajor(1500))
  })

  it('refuses to pay the same employee twice for the same month', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(1500), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    expect(() => paySalary({ employeeId, amountMinor: moneyFromMajor(1500), periodYear: YEAR, periodMonth: MONTH }, env.ctx))
      .toThrowError(/لا يوجد راتب متبق/)
  })

  it('locks salary expenses against manual editing so they cannot be duplicated', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(1000), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    const salaryExpense = listExpenses({}).items.find((e) => e.source === 'salary')!
    expect(() => updateExpense(salaryExpense.id, { description: 'تعديل' }, env.ctx))
      .toThrowError(/الرواتب/)
  })

  it('treats an advance as a settlement movement, not an expense', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(300) }, env.ctx)

    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(300))
    // An advance must not appear as an operating expense.
    expect(monthlyProfitSummary(YEAR, MONTH).generalExpensesMinor).toBe(0)
  })
})

describe('Cash accounts (BR-114)', () => {
  it('tracks every money movement across named accounts', () => {
    const account = createAccount({ name: 'الصندوق', kind: 'cash' }, env.ctx)
    const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
    const materialId = createMaterial({
      sku: 'X1', name: 'مادة', categoryId, unit: 'لوح',
      currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact'
    } as never, env.ctx)
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)

    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = createFinalInvoice({
      customerId,
      lines: [{ lineKind: 'custom', description: 'طلب', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(5000) }]
    }, env.ctx)
    const order = approveToOrder(quotation.id, env.ctx)

    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3000), cashAccountId: account }, env.ctx)
    createPurchase({
      supplierId,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(100) }],
      paidNowMinor: moneyFromMajor(500),
      cashAccountId: account
    }, env.ctx)
    createExpense({ kind: 'variable', amountMinor: moneyFromMajor(200), description: 'وقود', cashAccountId: account }, env.ctx)

    // 3,000 in − 500 supplier − 200 expense = 2,300
    expect(accountBalance(account)).toBe(moneyFromMajor(2300))
    expect(listAccounts().find((a) => a.id === account)?.balanceMinor).toBe(moneyFromMajor(2300))
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
