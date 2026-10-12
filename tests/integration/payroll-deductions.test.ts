import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createEmployee, monthlyPayroll, paySalary, recordEmployeeTransaction, updateEmployeeTransaction, deleteEmployeeTransaction, listDeductions, listAdvances, employeeBalance } from '@main/services/hr/employees.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { getDatabase } from '@main/db/connection'
import { employeeTransactions } from '@main/db/schema/hr.schema'
import { moneyFromMajor } from '@shared/money/money'

/** Finds the id of the salary_payment row just posted for this employee. */
function findSalaryTransactionId(employeeId: number): number {
  const row = getDatabase()
    .select({ id: employeeTransactions.id })
    .from(employeeTransactions)
    .where(and(eq(employeeTransactions.employeeId, employeeId), eq(employeeTransactions.kind, 'salary_payment')))
    .get()
  return row!.id
}

/**
 * Focused improvement pass: deductions and advances must be
 * completely separate concepts (items 2/3/5), payroll math is
 * authoritative in the service layer (item 3), and edit/delete must
 * leave no stale totals anywhere (item 7).
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const NOW = new Date()
const YEAR = NOW.getUTCFullYear()
const MONTH = NOW.getUTCMonth() + 1

describe('Deduction reduces monthly salary (item 3)', () => {
  it('computes salary after deductions = monthly salary − total deductions', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction(
      { employeeId, kind: 'deduction', amountMinor: moneyFromMajor(200), periodYear: YEAR, periodMonth: MONTH },
      env.ctx
    )

    const row = monthlyPayroll(YEAR, MONTH).find((r) => r.employeeId === employeeId)!
    expect(row.deductionMinor).toBe(moneyFromMajor(200))
    expect(row.remainingSalaryMinor).toBe(moneyFromMajor(1300))
  })

  it('aggregates multiple deductions in the same month (item 3 example)', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(100), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(50), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(50), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    const row = monthlyPayroll(YEAR, MONTH).find((r) => r.employeeId === employeeId)!
    expect(row.deductionMinor).toBe(moneyFromMajor(200))
    expect(row.remainingSalaryMinor).toBe(moneyFromMajor(1300))
  })

  it('requires a period year/month for a deduction (BR-safety: cannot affect the wrong month)', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    expect(() =>
      recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(100) }, env.ctx)
    ).toThrowError(/شهر وسنة/)
  })

  it('never lets one employee’s deduction affect another’s payroll (BR-safety)', () => {
    const a = createEmployee({ name: 'أحمد', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    const b = createEmployee({ name: 'خالد', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    recordEmployeeTransaction({ employeeId: a, kind: 'deduction', amountMinor: moneyFromMajor(300), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    const rows = monthlyPayroll(YEAR, MONTH)
    expect(rows.find((r) => r.employeeId === a)!.deductionMinor).toBe(moneyFromMajor(300))
    expect(rows.find((r) => r.employeeId === b)!.deductionMinor).toBe(0)
  })

  it('never lets a deduction leak into a different month (BR-safety)', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(300), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    const otherMonth = MONTH === 12 ? 1 : MONTH + 1
    const otherYear = MONTH === 12 ? YEAR + 1 : YEAR
    const row = monthlyPayroll(otherYear, otherMonth).find((r) => r.employeeId === employeeId)!
    expect(row.deductionMinor).toBe(0)
    expect(row.remainingSalaryMinor).toBe(row.monthlySalaryMinor)
  })
})

describe('Edit and delete a deduction recalculates payroll (item 7)', () => {
  it('editing the amount immediately changes the month’s total (no stale totals)', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(200), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    const [deduction] = listDeductions({ employeeId, year: YEAR, month: MONTH }).items

    updateEmployeeTransaction(deduction!.id, { amountMinor: moneyFromMajor(500) }, env.ctx)

    const row = monthlyPayroll(YEAR, MONTH).find((r) => r.employeeId === employeeId)!
    expect(row.deductionMinor).toBe(moneyFromMajor(500))
    expect(row.remainingSalaryMinor).toBe(moneyFromMajor(1000))
  })

  it('deleting a deduction removes it from the month’s total (no stale totals)', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(200), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(100), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    const [latest] = listDeductions({ employeeId, year: YEAR, month: MONTH }).items

    deleteEmployeeTransaction(latest!.id, env.ctx)

    const row = monthlyPayroll(YEAR, MONTH).find((r) => r.employeeId === employeeId)!
    expect(row.deductionMinor).toBe(moneyFromMajor(200))
    expect(row.remainingSalaryMinor).toBe(moneyFromMajor(1300))
  })

  it('moving a deduction to a different month recalculates BOTH months correctly', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(300), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    const [deduction] = listDeductions({ employeeId, year: YEAR, month: MONTH }).items

    const nextMonth = MONTH === 12 ? 1 : MONTH + 1
    const nextYear = MONTH === 12 ? YEAR + 1 : YEAR
    updateEmployeeTransaction(deduction!.id, { periodYear: nextYear, periodMonth: nextMonth }, env.ctx)

    expect(monthlyPayroll(YEAR, MONTH).find((r) => r.employeeId === employeeId)!.deductionMinor).toBe(0)
    expect(monthlyPayroll(nextYear, nextMonth).find((r) => r.employeeId === employeeId)!.deductionMinor).toBe(moneyFromMajor(300))
  })
})

describe('Advances remain completely separate from deductions (item 5)', () => {
  it('an advance never appears in the deduction total, and vice versa', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)

    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(400), cashAccountId: accountId }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(200), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    const row = monthlyPayroll(YEAR, MONTH).find((r) => r.employeeId === employeeId)!
    expect(row.deductionMinor).toBe(moneyFromMajor(200)) // advance did not leak in
    expect(row.remainingSalaryMinor).toBe(moneyFromMajor(1300))
    // Bug-fix regression: a deduction must NEVER leak into the outstanding
    // advance balance — it stays exactly the advance total (400), unaffected
    // by the 200 deduction recorded above.
    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(400))

    const deductionRows = listDeductions({ employeeId }).items
    const advanceRows = listAdvances({ employeeId }).items
    expect(deductionRows).toHaveLength(1)
    expect(advanceRows).toHaveLength(1)
    expect(deductionRows[0]?.amountMinor).toBe(moneyFromMajor(200))
    expect(advanceRows[0]?.amountMinor).toBe(moneyFromMajor(400))
  })

  it('an advance posts a real cash movement; a deduction never does', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)

    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(400), cashAccountId: accountId }, env.ctx)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4600))

    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(200), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4600)) // unchanged — a deduction is not a cash movement
  })
})

describe('Edit and delete an advance recalculates balances correctly (item 7)', () => {
  it('editing an advance amount updates both the employee balance and the cash account', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(400), cashAccountId: accountId }, env.ctx)
    const [advance] = listAdvances({ employeeId }).items

    updateEmployeeTransaction(advance!.id, { amountMinor: moneyFromMajor(600) }, env.ctx)

    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(600))
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4400))
  })

  it('deleting an advance reverses both the balance and the cash movement — no stale totals', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(400), cashAccountId: accountId }, env.ctx)
    const [advance] = listAdvances({ employeeId }).items

    deleteEmployeeTransaction(advance!.id, env.ctx)

    expect(employeeBalance(employeeId)).toBe(0)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(5000))
    expect(listAdvances({ employeeId }).items).toHaveLength(0)
  })
})

describe('الراتب المتبقي subtracts BOTH discounts and salary already paid (item 6)', () => {
  it('matches the requested example: 1500 − 200 (discount) − 500 (partial payment) = 800', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(200), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(500), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    const row = monthlyPayroll(YEAR, MONTH).find((r) => r.employeeId === employeeId)!
    expect(row.deductionMinor).toBe(moneyFromMajor(200))
    expect(row.paidMinor).toBe(moneyFromMajor(500))
    expect(row.remainingSalaryMinor).toBe(moneyFromMajor(800))
  })

  it('an advance does NOT reduce الراتب المتبقي — it is a separate running settlement balance', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(400), cashAccountId: accountId }, env.ctx)

    const row = monthlyPayroll(YEAR, MONTH).find((r) => r.employeeId === employeeId)!
    expect(row.remainingSalaryMinor).toBe(moneyFromMajor(1500)) // unaffected by the advance
    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(400)) // tracked separately instead
  })
})

describe('Finalized payroll postings cannot be destructively edited/deleted (item 8 safety)', () => {
  it('refuses to edit or delete a salary_payment transaction', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(1500), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    const salaryTx = findSalaryTransactionId(employeeId)
    expect(() => updateEmployeeTransaction(salaryTx, { amountMinor: moneyFromMajor(1) }, env.ctx)).toThrowError(/نهائية/)
    expect(() => deleteEmployeeTransaction(salaryTx, env.ctx)).toThrowError(/نهائية/)
  })
})
