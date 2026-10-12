import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import {
  createEmployee,
  employeeBalance,
  listAdvances,
  recordEmployeeTransaction,
  updateEmployeeTransaction,
  deleteEmployeeTransaction,
  monthlyPayroll
} from '@main/services/hr/employees.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { moneyFromMajor } from '@shared/money/money'

/**
 * Bug fix + new feature: advance returns/repayments (مرتجع سلفة).
 *
 * Root cause of the reported bug: employeeBalance() used to compute
 * "advances − repayments − deductions", so an employee with only a
 * deduction (no advance transaction at all) showed a nonzero/negative
 * advance balance in the payroll row while "سجل السلف" — which
 * correctly lists only advance/repayment rows — showed nothing. The
 * fix makes employeeBalance() a pure "advances − repayments" figure,
 * completely independent of deductions, and listAdvances().items is the
 * exact same transaction set that balance is derived from.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

describe('Bug fix: advance balance is never affected by a deduction (item 1)', () => {
  it('an employee with a deduction but no advance has a ZERO outstanding advance and an empty سجل السلف', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const now = new Date()
    recordEmployeeTransaction(
      { employeeId, kind: 'deduction', amountMinor: moneyFromMajor(200), periodYear: now.getUTCFullYear(), periodMonth: now.getUTCMonth() + 1 },
      env.ctx
    )

    expect(employeeBalance(employeeId)).toBe(0) // NOT -200
    expect(listAdvances({ employeeId }).items).toHaveLength(0) // consistent with the balance
  })

  it('the advance-history query and the outstanding-balance figure always agree', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200), cashAccountId: accountId }, env.ctx)

    const rows = listAdvances({ employeeId }).items
    const computedFromHistory = rows.reduce(
      (sum, r) => sum + (r.kind === 'advance' ? r.amountMinor : -r.amountMinor),
      0
    )
    expect(computedFromHistory).toBe(employeeBalance(employeeId))
  })
})

describe('Outstanding advance calculation (item 6)', () => {
  it('matches the requested example: advance 200, return 50 → outstanding 150, then return 150 → outstanding 0', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)
    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(200))

    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(50) }, env.ctx)
    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(150))

    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(150) }, env.ctx)
    expect(employeeBalance(employeeId)).toBe(0)
  })

  it('the original advance and both returns all remain visible in سجل السلف (item 5)', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(50) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(150) }, env.ctx)

    const rows = listAdvances({ employeeId }).items
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.kind === 'advance')).toHaveLength(1)
    expect(rows.filter((r) => r.kind === 'repayment')).toHaveLength(2)
  })

  it('does not display the balance as negative under normal use — advances and returns net to a non-negative figure', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(200) }, env.ctx)

    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(300))
    expect(employeeBalance(employeeId)).toBeGreaterThanOrEqual(0)
  })

  it('monthlyPayroll’s advanceMinor also reports the NET outstanding advance, not the gross issued amount', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(200) }, env.ctx)

    const now = new Date()
    const row = monthlyPayroll(now.getUTCFullYear(), now.getUTCMonth() + 1).find((r) => r.employeeId === employeeId)!
    expect(row.advanceMinor).toBe(moneyFromMajor(300))
  })
})

describe('Return validation rules (item 4)', () => {
  it('rejects a return when the outstanding balance is zero', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)

    expect(() =>
      recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(50) }, env.ctx)
    ).toThrowError(/لا توجد سلفة قائمة/)
  })

  it('rejects a return greater than the outstanding balance', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)

    expect(() =>
      recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(201) }, env.ctx)
    ).toThrowError(/أكبر من السلفة القائمة/)
    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(200)) // unchanged by the rejected attempt
  })

  it('rejects a zero or negative return amount', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)

    expect(() =>
      recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: 0 }, env.ctx)
    ).toThrowError(/أكبر من صفر/)
  })

  it('accepts a return exactly equal to the outstanding balance (full return)', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)

    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(200) }, env.ctx)

    expect(employeeBalance(employeeId)).toBe(0)
  })
})

describe('Cash account integration (item 9)', () => {
  it('issuing an advance decreases the cash account; a return increases it back — neither counts as revenue/expense', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)

    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200), cashAccountId: accountId }, env.ctx)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4800))

    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(50), cashAccountId: accountId }, env.ctx)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4850))
  })
})

describe('Edit advance/return recalculates the outstanding balance safely (item 8)', () => {
  it('editing a return’s amount recalculates the outstanding balance', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)
    const returnId = recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(50) }, env.ctx)
    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(150))

    updateEmployeeTransaction(returnId, { amountMinor: moneyFromMajor(80) }, env.ctx)

    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(120))
  })

  it('editing an advance amount downward recalculates the balance correctly', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const advanceId = recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(50) }, env.ctx)

    updateEmployeeTransaction(advanceId, { amountMinor: moneyFromMajor(300) }, env.ctx)

    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(250)) // 300 - 50
  })

  it('rejects editing a return above the (now smaller) outstanding balance', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)
    const returnId = recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(50) }, env.ctx)

    expect(() =>
      updateEmployeeTransaction(returnId, { amountMinor: moneyFromMajor(300) }, env.ctx)
    ).toThrowError(/لا يمكن أن يتجاوز/)
    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(150)) // unchanged
  })

  it('rejects lowering an advance below returns already recorded against it', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const advanceId = recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(150) }, env.ctx)

    expect(() =>
      updateEmployeeTransaction(advanceId, { amountMinor: moneyFromMajor(100) }, env.ctx)
    ).toThrowError(/لا يمكن أن يتجاوز/)
    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(50)) // unchanged
  })
})

describe('Delete advance/return safely (item 8)', () => {
  it('deleting a return always succeeds and raises the outstanding balance back up', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)
    const returnId = recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(50) }, env.ctx)

    deleteEmployeeTransaction(returnId, env.ctx)

    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(200))
    expect(listAdvances({ employeeId }).items).toHaveLength(1)
  })

  it('deleting an advance that is fully covered by no returns succeeds, zeroing the balance', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const advanceId = recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)

    deleteEmployeeTransaction(advanceId, env.ctx)

    expect(employeeBalance(employeeId)).toBe(0)
    expect(listAdvances({ employeeId }).items).toHaveLength(0)
  })

  it('refuses to delete an advance that returns have already been recorded against, to avoid a negative balance', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const advanceId = recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(150) }, env.ctx)

    expect(() => deleteEmployeeTransaction(advanceId, env.ctx)).toThrowError(/لا يمكن حذف هذه السلفة/)
    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(50)) // unchanged
    expect(listAdvances({ employeeId }).items).toHaveLength(2) // nothing removed
  })

  it('deleting an advance reverses its cash movement; deleting a return reverses its own', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    const advanceId = recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200), cashAccountId: accountId }, env.ctx)
    const returnId = recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(50), cashAccountId: accountId }, env.ctx)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4850)) // 5000 - 200 + 50

    deleteEmployeeTransaction(returnId, env.ctx)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4800)) // return reversed

    deleteEmployeeTransaction(advanceId, env.ctx)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(5000)) // advance reversed too
  })
})
