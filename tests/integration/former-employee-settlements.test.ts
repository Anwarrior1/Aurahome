import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getDatabase, getRawConnection } from '@main/db/connection'
import {
  createEmployee,
  deleteEmployee,
  dismissFormerEmployeeSettlement,
  employeeBalance,
  listFormerEmployeeSettlements,
  paySalary,
  recordEmployeeTransaction
} from '@main/services/hr/employees.service'
import { accountBalance, createAccount } from '@main/services/finance/cash.service'
import { moneyFromMajor } from '@shared/money/money'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

describe('former employee outstanding-settlement queue', () => {
  it('shows only inactive employees whose authoritative outstanding advance is positive', () => {
    const owing = createEmployee({ name: 'سابق عليه سلفة', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    const settled = createEmployee({ name: 'سابق مسدد', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    const current = createEmployee({ name: 'حالي عليه سلفة', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    recordEmployeeTransaction({ employeeId: owing, kind: 'advance', amountMinor: moneyFromMajor(200) }, env.ctx)
    recordEmployeeTransaction({ employeeId: settled, kind: 'advance', amountMinor: moneyFromMajor(100) }, env.ctx)
    recordEmployeeTransaction({ employeeId: settled, kind: 'repayment', amountMinor: moneyFromMajor(100) }, env.ctx)
    recordEmployeeTransaction({ employeeId: current, kind: 'advance', amountMinor: moneyFromMajor(300) }, env.ctx)
    deleteEmployee({ id: owing, confirmation: 'سابق عليه سلفة' }, env.ctx)
    deleteEmployee({ id: settled, confirmation: 'سابق مسدد' }, env.ctx)

    expect(listFormerEmployeeSettlements()).toMatchObject([{
      id: owing, active: false, balanceMinor: moneyFromMajor(200)
    }])
    expect(employeeBalance(settled)).toBe(0)
    expect(listFormerEmployeeSettlements().some((row) => row.id === settled)).toBe(false)
    expect(listFormerEmployeeSettlements().some((row) => row.id === current)).toBe(false)
  })

  it('rejects dismissal while money is outstanding, then preserves every historical effect after final repayment and dismissal', () => {
    const accountId = createAccount({
      name: 'صندوق تاريخ الموظف السابق', kind: 'cash', openingBalanceMinor: moneyFromMajor(10_000)
    }, env.ctx)
    const employeeId = createEmployee({
      name: 'موظف سابق كامل التاريخ', monthlySalaryMinor: moneyFromMajor(1500), hiredAt: '2025-01-01'
    }, env.ctx)
    const deductionId = recordEmployeeTransaction({
      employeeId, kind: 'deduction', amountMinor: moneyFromMajor(100), periodYear: 2026, periodMonth: 1
    }, env.ctx)
    const salary = paySalary({
      employeeId, amountMinor: moneyFromMajor(1400), periodYear: 2026, periodMonth: 1,
      cashAccountId: accountId, paidAt: '2026-01-31'
    }, env.ctx)
    const advanceId = recordEmployeeTransaction({
      employeeId, kind: 'advance', amountMinor: moneyFromMajor(200), cashAccountId: accountId
    }, env.ctx)
    deleteEmployee({ id: employeeId, confirmation: 'موظف سابق كامل التاريخ' }, env.ctx)

    expect(listFormerEmployeeSettlements().map((row) => row.id)).toContain(employeeId)
    expect(() => dismissFormerEmployeeSettlement(employeeId, env.ctx)).toThrowError(/سداد السلفة القائمة بالكامل/)

    const repaymentId = recordEmployeeTransaction({
      employeeId, kind: 'repayment', amountMinor: moneyFromMajor(200), cashAccountId: accountId
    }, env.ctx)
    expect(employeeBalance(employeeId)).toBe(0)
    expect(listFormerEmployeeSettlements().some((row) => row.id === employeeId)).toBe(false)

    const raw = getRawConnection()
    const before = {
      employee: raw.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId),
      salaryHistory: raw.prepare('SELECT * FROM employee_salary_history WHERE employee_id = ? ORDER BY id').all(employeeId),
      transactions: raw.prepare('SELECT * FROM employee_transactions WHERE employee_id = ? ORDER BY id').all(employeeId),
      expenses: raw.prepare("SELECT * FROM expenses WHERE source = 'salary' AND source_ref_id = ? ORDER BY id").all(employeeId),
      cash: raw.prepare(`SELECT * FROM cash_transactions WHERE ref_table = 'employee_transactions'
        AND ref_id IN (SELECT id FROM employee_transactions WHERE employee_id = ?) ORDER BY id`).all(employeeId),
      accountBalance: accountBalance(accountId),
      priorAuditCount: getDatabase().get<{ count: number }>(sql`
        SELECT COUNT(*) AS count FROM audit_log WHERE entity_id = ${String(employeeId)}
      `)?.count ?? 0
    }

    expect(dismissFormerEmployeeSettlement(employeeId, env.ctx)).toEqual({
      removedFromSettlement: true, historyPreserved: true
    })
    expect(raw.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId)).toEqual(before.employee)
    expect(raw.prepare('SELECT * FROM employee_salary_history WHERE employee_id = ? ORDER BY id').all(employeeId)).toEqual(before.salaryHistory)
    expect(raw.prepare('SELECT * FROM employee_transactions WHERE employee_id = ? ORDER BY id').all(employeeId)).toEqual(before.transactions)
    expect(raw.prepare("SELECT * FROM expenses WHERE source = 'salary' AND source_ref_id = ? ORDER BY id").all(employeeId)).toEqual(before.expenses)
    expect(raw.prepare(`SELECT * FROM cash_transactions WHERE ref_table = 'employee_transactions'
      AND ref_id IN (SELECT id FROM employee_transactions WHERE employee_id = ?) ORDER BY id`).all(employeeId)).toEqual(before.cash)
    expect(accountBalance(accountId)).toBe(before.accountBalance)
    expect(before.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: deductionId, kind: 'deduction' }),
      expect.objectContaining({ id: salary.transactionId, kind: 'salary_payment' }),
      expect.objectContaining({ id: advanceId, kind: 'advance' }),
      expect.objectContaining({ id: repaymentId, kind: 'repayment' })
    ]))
    expect(getDatabase().get<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM audit_log WHERE entity_id = ${String(employeeId)}
    `)?.count).toBe(before.priorAuditCount + 1)
    expect(raw.prepare("SELECT details FROM audit_log WHERE action = 'employees.formerSettlement.dismiss' AND entity_id = ?").get(String(employeeId))).toBeTruthy()
  })
})
