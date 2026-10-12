import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import {
  createEmployee,
  currentMonthlyPayroll,
  deleteEmployee,
  employeeBalance,
  employeeStatement,
  listEmployees,
  monthlyPayroll,
  paySalary,
  recordEmployeeTransaction,
  updateEmployee
} from '@main/services/hr/employees.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { buildReport } from '@main/services/reports/reports.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { recordAuditEvent } from '@main/audit/audit-log.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor } from '@shared/money/money'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const YEAR = 2026
const MONTH = 1

function financialSnapshot(employeeId: number, accountId: number) {
  const db = getDatabase()
  return {
    employeeTransactions: db.get<{ value: number }>(sql`
      SELECT COUNT(*) AS value FROM employee_transactions WHERE employee_id = ${employeeId}
    `)?.value ?? 0,
    salaryPayments: db.get<{ value: number }>(sql`
      SELECT COALESCE(SUM(paid_amount_minor), 0) AS value
      FROM employee_transactions
      WHERE employee_id = ${employeeId} AND kind = 'salary_payment' AND reversed_at IS NULL
    `)?.value ?? 0,
    deductions: db.get<{ value: number }>(sql`
      SELECT COALESCE(SUM(amount_minor), 0) AS value
      FROM employee_transactions
      WHERE employee_id = ${employeeId} AND kind = 'deduction' AND reversed_at IS NULL
    `)?.value ?? 0,
    salaryExpenses: db.get<{ value: number }>(sql`
      SELECT COALESCE(SUM(amount_minor), 0) AS value
      FROM expenses WHERE source = 'salary' AND source_ref_id = ${employeeId} AND reversed_at IS NULL
    `)?.value ?? 0,
    cashRows: db.get<{ value: number }>(sql`
      SELECT COUNT(*) AS value FROM cash_transactions
      WHERE ref_table = 'employee_transactions'
        AND ref_id IN (SELECT id FROM employee_transactions WHERE employee_id = ${employeeId})
    `)?.value ?? 0,
    accountBalance: accountBalance(accountId),
    payroll: monthlyPayroll(YEAR, MONTH).find((row) => row.employeeId === employeeId)
  }
}

describe('production-safe former employee lifecycle', () => {
  it('preserves salary, deduction, expense, cash and historical report totals exactly', () => {
    const accountId = createAccount({
      name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(10_000)
    }, env.ctx)
    const employeeId = createEmployee({
      name: 'محمد', monthlySalaryMinor: moneyFromMajor(1_500), hiredAt: '2025-12-01'
    }, env.ctx)
    recordEmployeeTransaction({
      employeeId, kind: 'deduction', amountMinor: moneyFromMajor(200),
      periodYear: YEAR, periodMonth: MONTH, occurredAt: '2026-01-15'
    }, env.ctx)
    paySalary({
      employeeId, amountMinor: moneyFromMajor(1_300), periodYear: YEAR,
      periodMonth: MONTH, cashAccountId: accountId, paidAt: '2026-01-31'
    }, env.ctx)

    const before = financialSnapshot(employeeId, accountId)
    const reportBefore = buildReport({ key: 'payroll', year: YEAR, month: MONTH })
    recordAuditEvent({
      userId: env.ctx.session.user.id,
      action: 'employees.archive',
      entity: 'employees',
      entityId: String(employeeId),
      details: { legacy: true }
    })

    const removal = deleteEmployee({ id: employeeId, confirmation: 'محمد' }, env.ctx)

    expect(removal).toEqual({
      removedFromCurrent: true,
      physicallyDeleted: false,
      historyPreserved: true
    })
    expect(financialSnapshot(employeeId, accountId)).toEqual(before)
    expect(before.salaryPayments).toBe(moneyFromMajor(1_300))
    expect(before.deductions).toBe(moneyFromMajor(200))
    expect(before.salaryExpenses).toBe(moneyFromMajor(1_300))
    expect(before.cashRows).toBe(1)
    expect(buildReport({ key: 'payroll', year: YEAR, month: MONTH })).toEqual(reportBefore)
    expect(getDatabase().get<{ value: number }>(sql`
      SELECT COUNT(*) AS value FROM audit_log
      WHERE entity_id = ${String(employeeId)} AND action = 'employees.archive'
    `)?.value).toBe(1)
    expect(getDatabase().get<{ details: string }>(sql`
      SELECT details FROM audit_log
      WHERE entity_id = ${String(employeeId)} AND action = 'employees.remove'
    `)?.details).toContain('"historyPreserved":true')
    expect(listEmployees({ activeOnly: true }).some((employee) => employee.id === employeeId)).toBe(false)
    expect(currentMonthlyPayroll(YEAR, MONTH).some((row) => row.employeeId === employeeId)).toBe(false)
    expect(monthlyPayroll(YEAR, MONTH).find((row) => row.employeeId === employeeId)).toMatchObject({
      paidMinor: moneyFromMajor(1_300),
      deductionMinor: moneyFromMajor(200),
      remainingSalaryMinor: 0
    })
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })

  it('includes a former employee only in periods with actual payroll history', () => {
    const employeeId = createEmployee({
      name: 'موظف تاريخي', monthlySalaryMinor: moneyFromMajor(1_500), hiredAt: '2025-12-01'
    }, env.ctx)
    recordEmployeeTransaction({
      employeeId, kind: 'deduction', amountMinor: moneyFromMajor(100),
      periodYear: 2026, periodMonth: 1
    }, env.ctx)
    deleteEmployee({ id: employeeId, confirmation: 'موظف تاريخي' }, env.ctx)

    expect(monthlyPayroll(2026, 1).some((row) => row.employeeId === employeeId)).toBe(true)
    expect(monthlyPayroll(2026, 2).some((row) => row.employeeId === employeeId)).toBe(false)
  })

  it('retains an outstanding advance and lets a former employee settle it without reactivation', () => {
    const accountId = createAccount({
      name: 'الخزنة', kind: 'cash', openingBalanceMinor: moneyFromMajor(1_000)
    }, env.ctx)
    const employeeId = createEmployee({ name: 'محمد', monthlySalaryMinor: moneyFromMajor(1_500) }, env.ctx)
    const advanceId = recordEmployeeTransaction({
      employeeId, kind: 'advance', amountMinor: moneyFromMajor(300), cashAccountId: accountId
    }, env.ctx)
    deleteEmployee({ id: employeeId, confirmation: 'محمد' }, env.ctx)

    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(300))
    expect(employeeStatement(employeeId).transactions.items.some((row) => row.id === advanceId)).toBe(true)

    const repaymentId = recordEmployeeTransaction({
      employeeId, kind: 'repayment', amountMinor: moneyFromMajor(300), cashAccountId: accountId
    }, env.ctx)

    expect(repaymentId).toBeGreaterThan(advanceId)
    expect(employeeBalance(employeeId)).toBe(0)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(1_000))
    expect(listEmployees({ activeOnly: false }).find((employee) => employee.id === employeeId)?.active).toBe(false)
    expect(getDatabase().get<{ value: number }>(sql`
      SELECT COUNT(*) AS value FROM employee_transactions
      WHERE employee_id = ${employeeId} AND kind = 'advance'
    `)?.value).toBe(1)
    expect(getDatabase().get<{ value: number }>(sql`
      SELECT COUNT(*) AS value FROM cash_transactions
      WHERE ref_table = 'employee_transactions' AND ref_id = ${repaymentId}
        AND kind = 'employee_repayment' AND direction = 'in'
    `)?.value).toBe(1)
  })

  it('blocks every new obligation for a former employee and cannot abuse repayment', () => {
    const employeeId = createEmployee({ name: 'موظف سابق', monthlySalaryMinor: moneyFromMajor(1_500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(300) }, env.ctx)
    deleteEmployee({ id: employeeId, confirmation: 'موظف سابق' }, env.ctx)

    expect(() => paySalary({
      employeeId, amountMinor: moneyFromMajor(1_500), periodYear: YEAR, periodMonth: MONTH
    }, env.ctx)).toThrowError(/موظف سابق/)
    expect(() => recordEmployeeTransaction({
      employeeId, kind: 'deduction', amountMinor: moneyFromMajor(100), periodYear: YEAR, periodMonth: MONTH
    }, env.ctx)).toThrowError(/موظف سابق/)
    expect(() => recordEmployeeTransaction({
      employeeId, kind: 'advance', amountMinor: moneyFromMajor(50)
    }, env.ctx)).toThrowError(/موظف سابق/)
    expect(() => recordEmployeeTransaction({
      employeeId, kind: 'repayment', amountMinor: moneyFromMajor(301)
    }, env.ctx)).toThrowError(/أكبر من السلفة القائمة/)

    recordEmployeeTransaction({ employeeId, kind: 'repayment', amountMinor: moneyFromMajor(300) }, env.ctx)
    expect(() => recordEmployeeTransaction({
      employeeId, kind: 'repayment', amountMinor: moneyFromMajor(1)
    }, env.ctx)).toThrowError(/لا توجد سلفة قائمة/)
  })

  it('requires typed-name confirmation and safely hard-deletes only a no-history employee', () => {
    const employeeId = createEmployee({ name: 'بلا تاريخ', monthlySalaryMinor: moneyFromMajor(900) }, env.ctx)

    expect(() => deleteEmployee({ id: employeeId, confirmation: 'اسم خطأ' }, env.ctx)).toThrowError(/اكتب اسم الموظف/)
    expect(listEmployees({ activeOnly: true }).some((employee) => employee.id === employeeId)).toBe(true)

    expect(deleteEmployee({ id: employeeId, confirmation: 'بلا تاريخ' }, env.ctx)).toMatchObject({
      physicallyDeleted: true,
      historyPreserved: false
    })
    expect(listEmployees({ activeOnly: false }).some((employee) => employee.id === employeeId)).toBe(false)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })

  it('rolls removal and advance settlement back completely when a required write fails', () => {
    const employeeId = createEmployee({ name: 'اختبار التراجع', monthlySalaryMinor: moneyFromMajor(900) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(300) }, env.ctx)
    const raw = getRawConnection()
    raw.exec(`
      CREATE TRIGGER block_employee_removal_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.action = 'employees.remove'
      BEGIN SELECT RAISE(ABORT, 'forced removal rollback'); END
    `)

    expect(() => deleteEmployee({ id: employeeId, confirmation: 'اختبار التراجع' }, env.ctx)).toThrow()
    expect(listEmployees({ activeOnly: true }).some((employee) => employee.id === employeeId)).toBe(true)

    raw.exec('DROP TRIGGER block_employee_removal_audit')
    deleteEmployee({ id: employeeId, confirmation: 'اختبار التراجع' }, env.ctx)
    raw.exec(`
      CREATE TRIGGER block_employee_repayment_cash
      BEFORE INSERT ON cash_transactions
      WHEN NEW.kind = 'employee_repayment'
      BEGIN SELECT RAISE(ABORT, 'forced settlement rollback'); END
    `)
    const accountId = createAccount({ name: 'حساب التراجع', kind: 'cash' }, env.ctx)

    expect(() => recordEmployeeTransaction({
      employeeId, kind: 'repayment', amountMinor: moneyFromMajor(300), cashAccountId: accountId
    }, env.ctx)).toThrow()
    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(300))
    expect(getDatabase().get<{ value: number }>(sql`
      SELECT COUNT(*) AS value FROM employee_transactions
      WHERE employee_id = ${employeeId} AND kind = 'repayment'
    `)?.value).toBe(0)
    expect(accountBalance(accountId)).toBe(0)
  })

  it('enforces lifecycle permissions and rejects direct active-field updates', () => {
    const employeeId = createEmployee({ name: 'محمي', monthlySalaryMinor: moneyFromMajor(900) }, env.ctx)
    const roleId = createRole({ name: 'عرض فقط', permissions: [P.employees.view] }, env.ctx)
    createUser({ username: 'viewer-lifecycle', password: 'secret789', fullName: 'مشاهد', roleId }, env.ctx)
    const { session } = login('viewer-lifecycle', 'secret789', 7701)

    expect(() => deleteEmployee({ id: employeeId, confirmation: 'محمي' }, { session })).toThrowError(/صلاحية/)
    expect(() => updateEmployee(employeeId, { active: false } as never, env.ctx)).toThrowError(/لا يمكن تغيير حالة الموظف/)
    expect(listEmployees({ activeOnly: true }).some((employee) => employee.id === employeeId)).toBe(true)
  })
})
