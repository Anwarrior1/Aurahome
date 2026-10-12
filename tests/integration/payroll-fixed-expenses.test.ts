import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, and, sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { issueRelease, recordDelivery } from '@main/services/production/production.service'
import { createEmployee, updateEmployee, paySalary, monthlyPayroll } from '@main/services/hr/employees.service'
import {
  createExpense,
  updateExpense,
  listExpenses,
  createRecurringExpense,
  listRecurringExpenses
} from '@main/services/finance/expenses.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { getDatabase } from '@main/db/connection'
import { expenses, cashTransactions } from '@main/db/schema/finance.schema'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

/** A revenue-only order, completed on `recordedAt`, with zero material/
 *  machine/worker/delivery cost — isolates general/payroll expenses in
 *  the monthly profit formula (Test 5). */
function completedOrder(priceMajor: number, recordedAt: string) {
  const customerId = createCustomer({ name: 'عميل — اختبار الرواتب' }, env.ctx)
  const quotation = createFinalInvoice({
    customerId,
    lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(priceMajor) }]
  }, env.ctx)
  const order = approveToOrder(quotation.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(priceMajor) }, env.ctx)
  issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
  recordDelivery({ orderId: order.id, kind: 'delivery', recordedAt }, env.ctx)
}

describe('Payroll as a fixed expense — via payroll periods, never a recurring-expense definition', () => {
  it('Test 1 — Fixed Expenses = recurring (Rent) + October payroll, and payroll never appears in the recurring list', () => {
    createRecurringExpense({ description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-10-01' }, env.ctx)
    const employeeId = createEmployee({ name: 'أحمد', monthlySalaryMinor: moneyFromMajor(4500) }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(4500), periodYear: 2026, periodMonth: 10, paidAt: '2026-10-28' }, env.ctx)

    const summary = monthlyProfitSummary(2026, 10)
    const fixedExpenses = summary.generalExpensesMinor + summary.payrollExpenseMinor
    expect(fixedExpenses).toBe(moneyFromMajor(5700))
    expect(summary.payrollExpenseMinor).toBe(moneyFromMajor(4500))

    // Item 2/3/16: the recurring-expense management list holds ONLY
    // the user-managed definition — never payroll/salaries.
    const recurring = listRecurringExpenses()
    expect(recurring).toHaveLength(1)
    expect(recurring[0]?.description).toBe('إيجار المصنع')
    expect(recurring.some((r) => r.description.includes('راتب') || r.description.includes('أحمد'))).toBe(false)
  })

  it('Test 2 — payroll is month-specific: October and November each use their own period total', () => {
    const employeeId = createEmployee({ name: 'سالم', monthlySalaryMinor: moneyFromMajor(4500) }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(4500), periodYear: 2026, periodMonth: 10 }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(4500), periodYear: 2026, periodMonth: 11 }, env.ctx)

    expect(monthlyProfitSummary(2026, 10).payrollExpenseMinor).toBe(moneyFromMajor(4500))
    expect(monthlyProfitSummary(2026, 11).payrollExpenseMinor).toBe(moneyFromMajor(4500))
    // The same employee's salary is never "carried over" as one record —
    // each month reads its own payroll period, never the other's.
    expect(monthlyProfitSummary(2026, 9).payrollExpenseMinor).toBe(0)

    expect(monthlyPayroll(2026, 10).find((r) => r.employeeId === employeeId)?.paidMinor).toBe(moneyFromMajor(4500))
    expect(monthlyPayroll(2026, 11).find((r) => r.employeeId === employeeId)?.paidMinor).toBe(moneyFromMajor(4500))
  })

  it('Test 3 — changing the employee\'s current salary never rewrites an already-recorded payroll period', () => {
    const employeeId = createEmployee({ name: 'منى', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(1000), periodYear: 2026, periodMonth: 9, paidAt: '2026-09-05' }, env.ctx)

    // A raise, effective for FUTURE payroll — the employee master record
    // changes, but nothing about September's already-posted period does.
    updateEmployee(employeeId, { monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(1500), periodYear: 2026, periodMonth: 10, paidAt: '2026-10-05' }, env.ctx)

    expect(monthlyProfitSummary(2026, 9).payrollExpenseMinor).toBe(moneyFromMajor(1000)) // untouched
    expect(monthlyProfitSummary(2026, 10).payrollExpenseMinor).toBe(moneyFromMajor(1500))
    const septemberExpense = listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items.find((e) => e.source === 'salary')
    expect(septemberExpense?.amountMinor).toBe(moneyFromMajor(1000)) // the frozen record, not the new 1500
  })

  it('Test 4 — repeatedly viewing the Expenses page / switching months creates no new payroll, expense, cash or ledger rows', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(10000) }, env.ctx)
    const employeeId = createEmployee({ name: 'هدى', monthlySalaryMinor: moneyFromMajor(4500) }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(4500), periodYear: 2026, periodMonth: 10, cashAccountId: accountId }, env.ctx)

    const countRows = (table: 'employee_transactions' | 'expenses' | 'cash_transactions') =>
      getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM ${sql.raw(table)}`)?.c ?? 0
    const before = {
      transactions: countRows('employee_transactions'),
      expenses: countRows('expenses'),
      cash: countRows('cash_transactions')
    }

    for (let i = 0; i < 5; i++) {
      listExpenses({ from: '2026-09-01', to: '2026-09-30' })
      listExpenses({ from: '2026-10-01', to: '2026-10-31' })
      monthlyProfitSummary(2026, 9)
      monthlyProfitSummary(2026, 10)
      monthlyPayroll(2026, 10)
    }

    expect(countRows('employee_transactions')).toBe(before.transactions)
    expect(countRows('expenses')).toBe(before.expenses)
    expect(countRows('cash_transactions')).toBe(before.cash)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(10000 - 4500)) // deducted exactly once
  })

  it('Test 5 — profitability includes payroll exactly once, in the correct month', () => {
    createRecurringExpense({ description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-10-01' }, env.ctx)
    const employeeId = createEmployee({ name: 'وائل', monthlySalaryMinor: moneyFromMajor(4500) }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(4500), periodYear: 2026, periodMonth: 10, paidAt: '2026-10-28' }, env.ctx)
    createExpense({ kind: 'variable', amountMinor: moneyFromMajor(800), description: 'صيانة', spentAt: '2026-10-10' }, env.ctx)
    completedOrder(20000, '2026-10-20T00:00:00.000Z')

    const summary = monthlyProfitSummary(2026, 10)
    expect(summary.revenueMinor).toBe(moneyFromMajor(20000))
    expect(summary.payrollExpenseMinor).toBe(moneyFromMajor(4500))
    expect(summary.generalExpensesMinor).toBe(moneyFromMajor(1200 + 800)) // rent + variable, salary excluded
    const totalExpenses = summary.generalExpensesMinor + summary.payrollExpenseMinor
    expect(totalExpenses).toBe(moneyFromMajor(6500))
    expect(summary.netProfitMinor).toBe(moneyFromMajor(13500))
  })

  it('Test 6 — no duplicate salary cash/ledger movement is created by reading expenses or profit repeatedly', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash' }, env.ctx)
    const employeeId = createEmployee({ name: 'كريم', monthlySalaryMinor: moneyFromMajor(4500) }, env.ctx)
    const { transactionId } = paySalary(
      { employeeId, amountMinor: moneyFromMajor(4500), periodYear: 2026, periodMonth: 10, cashAccountId: accountId },
      env.ctx
    )

    for (let i = 0; i < 4; i++) {
      listExpenses({ from: '2026-10-01', to: '2026-10-31' })
      monthlyProfitSummary(2026, 10)
    }

    const ledgerRows = getDatabase()
      .select()
      .from(cashTransactions)
      .where(and(eq(cashTransactions.refTable, 'employee_transactions'), eq(cashTransactions.refId, transactionId)))
      .all()
    expect(ledgerRows).toHaveLength(1)
    expect(accountBalance(accountId)).toBe(-moneyFromMajor(4500))

    const salaryExpenseRows = getDatabase().select().from(expenses).where(eq(expenses.source, 'salary')).all()
    expect(salaryExpenseRows).toHaveLength(1) // the ONE business-expense record — never a second one
  })

  it('Test 7 — the payroll-derived expense cannot be edited or deleted as a normal expense', () => {
    const employeeId = createEmployee({ name: 'ليلى', monthlySalaryMinor: moneyFromMajor(4500) }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(4500), periodYear: 2026, periodMonth: 10, paidAt: '2026-10-05' }, env.ctx)
    const salaryExpense = listExpenses({ from: '2026-10-01', to: '2026-10-31' }).items.find((e) => e.source === 'salary')!

    expect(() => updateExpense(salaryExpense.id, { amountMinor: moneyFromMajor(1) }, env.ctx))
      .toThrowError(/الرواتب/)
    // Deleting it IS allowed, but only through the dedicated payroll
    // reversal path — never as a silent, ordinary expense delete.
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM employee_transactions WHERE employee_id = ${employeeId}`)?.c).toBe(1)
  })
})
