import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { sql } from 'drizzle-orm'
import {
  createEmployee,
  deleteEmployee,
  employeeBalance,
  employeeDeletePreview,
  fullDeleteEmployee,
  listEmployees,
  monthlyPayroll,
  paySalary,
  recordEmployeeTransaction
} from '@main/services/hr/employees.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { listExpenses } from '@main/services/finance/expenses.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor } from '@shared/money/money'

/**
 * Incremental-modification request, item 4: deleting an employee must
 * never corrupt historical payroll/transaction data. An employee with
 * zero recorded activity is hard-deleted; one with any
 * employee_transactions history is archived (active = false) instead,
 * which the existing monthlyPayroll()/listEmployees(activeOnly) filters
 * already exclude from active lists automatically — no new column or
 * migration needed.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const NOW = new Date()
const YEAR = NOW.getUTCFullYear()
const MONTH = NOW.getUTCMonth() + 1

describe('Delete employee (item 4)', () => {
  it('hard-deletes an employee with no financial history', () => {
    const id = createEmployee({ name: 'موظف بدون حركات', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)

    const result = deleteEmployee({ id, confirmation: 'موظف بدون حركات' }, env.ctx)

    expect(result.physicallyDeleted).toBe(true)
    expect(listEmployees().some((e) => e.id === id)).toBe(false)
  })

  it('archives (soft-deletes) an employee who has advance/deduction history instead of hard-deleting', () => {
    const id = createEmployee({ name: 'موظف له حركات', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    recordEmployeeTransaction({ employeeId: id, kind: 'deduction', amountMinor: moneyFromMajor(100), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    const result = deleteEmployee({ id, confirmation: 'موظف له حركات' }, env.ctx)

    expect(result.historyPreserved).toBe(true)
    // Still exists in the raw table (history intact)...
    expect(listEmployees({ activeOnly: false }).some((e) => e.id === id)).toBe(true)
    // ...but no longer counted as an active employee.
    expect(listEmployees({ activeOnly: true }).some((e) => e.id === id)).toBe(false)
  })

  it('a removed employee disappears from current lists but remains in a relevant historical payroll period', () => {
    const id = createEmployee({ name: 'موظف مؤرشف', monthlySalaryMinor: moneyFromMajor(1200) }, env.ctx)
    recordEmployeeTransaction({ employeeId: id, kind: 'deduction', amountMinor: moneyFromMajor(50), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    deleteEmployee({ id, confirmation: 'موظف مؤرشف' }, env.ctx)

    expect(listEmployees({ activeOnly: true }).some((r) => r.id === id)).toBe(false)
    expect(monthlyPayroll(YEAR, MONTH).some((r) => r.employeeId === id)).toBe(true)
  })

  it('archiving does not touch or corrupt the employee’s existing transaction history', () => {
    const id = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1500) }, env.ctx)
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    recordEmployeeTransaction({ employeeId: id, kind: 'advance', amountMinor: moneyFromMajor(300), cashAccountId: accountId }, env.ctx)

    deleteEmployee({ id, confirmation: 'موظف' }, env.ctx)

    // Balance calc still works off the untouched transaction row.
    expect(employeeBalance(id)).toBe(moneyFromMajor(300))
  })

  it('throws a clear Arabic error when deleting a non-existent employee', () => {
    expect(() => deleteEmployee({ id: 999999, confirmation: 'مفقود' }, env.ctx)).toThrowError(/غير موجود/)
  })
})

/**
 * Part D of the deletion pass: an explicit Level-3 full delete that
 * lives ALONGSIDE the archive above, never replaces it, and is never
 * silently substituted for it. Its dependency graph is discovered from
 * the live schema — salaried employees are separate from production
 * workers (BR-91), so what actually links to them is their payroll
 * ledger, the Fixed salary expense each payment creates (BR-109), the
 * paired cash rows and their salary history.
 */
describe('Employee full delete (Part D)', () => {
  function employeeWithHistory() {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(10000) }, env.ctx)
    const id = createEmployee({ name: 'موظف كامل', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    paySalary({ employeeId: id, amountMinor: moneyFromMajor(1000), periodYear: YEAR, periodMonth: MONTH, deductionMinor: moneyFromMajor(100), cashAccountId: accountId }, env.ctx)
    recordEmployeeTransaction({ employeeId: id, kind: 'advance', amountMinor: moneyFromMajor(300), cashAccountId: accountId }, env.ctx)
    recordEmployeeTransaction({ employeeId: id, kind: 'repayment', amountMinor: moneyFromMajor(120), cashAccountId: accountId }, env.ctx)
    return { id, accountId }
  }

  it('reports no dependencies for an employee nothing links to', () => {
    const id = createEmployee({ name: 'موظف بلا سجل', monthlySalaryMinor: moneyFromMajor(800) }, env.ctx)
    const preview = employeeDeletePreview(id)
    expect(preview.requiresFullDelete).toBe(false)
    // Only the auto-created salary-history row, which is part of the
    // employee record itself and never blocks the plain delete.
    expect(preview.dependencies.map((item) => item.key)).toEqual(['salaryHistory'])
    expect(preview.blockers).toEqual([])
  })

  it('reports the real linked-record counts discovered from the schema', () => {
    const { id } = employeeWithHistory()
    const counts = Object.fromEntries(employeeDeletePreview(id).dependencies.map((item) => [item.key, item.count]))
    expect(counts).toMatchObject({
      salaryPayments: 1,
      advances: 1,
      repayments: 1,
      deductions: 1,
      salaryExpenses: 1,
      salaryHistory: 1
    })
    // net salary out + advance out + repayment in
    expect(counts.cashMovements).toBe(3)
  })

  it('requires the exact employee name as strong confirmation', () => {
    const { id, accountId } = employeeWithHistory()
    const before = accountBalance(accountId)
    expect(() => fullDeleteEmployee({ id, confirmation: 'حذف' }, env.ctx)).toThrowError(/اكتب اسم الموظف/)
    expect(listEmployees({ activeOnly: false }).some((e) => e.id === id)).toBe(true)
    expect(accountBalance(accountId)).toBe(before)
  })

  it('refuses full deletion and preserves every payroll, expense and cash fact', () => {
    const { id, accountId } = employeeWithHistory()
    const balanceBefore = accountBalance(accountId)
    const preview = employeeDeletePreview(id)
    expect(preview.blockers.join(' ')).toMatch(/سجل رواتب أو تسويات مُرحّل/)

    expect(() => fullDeleteEmployee({ id, confirmation: 'موظف كامل' }, env.ctx)).toThrowError(/تعذر الحذف النهائي/)

    expect(listEmployees({ activeOnly: false }).some((e) => e.id === id)).toBe(true)
    expect(accountBalance(accountId)).toBe(balanceBefore)
    const raw = getRawConnection()
    expect((raw.prepare('SELECT COUNT(*) AS c FROM employee_transactions WHERE employee_id = ?').get(id) as { c: number }).c).toBe(4)
    expect((raw.prepare('SELECT COUNT(*) AS c FROM employee_salary_history WHERE employee_id = ?').get(id) as { c: number }).c).toBe(1)
    expect((raw.prepare("SELECT COUNT(*) AS c FROM expenses WHERE source = 'salary' AND source_ref_id = ?").get(id) as { c: number }).c).toBe(1)
    expect(raw.pragma('foreign_key_check')).toEqual([])
  })

  it('keeps payroll and expense reports reproducible after a blocked full delete', () => {
    const { id } = employeeWithHistory()
    const payrollBefore = monthlyPayroll(YEAR, MONTH)
    const expensesBefore = listExpenses({}).items

    expect(() => fullDeleteEmployee({ id, confirmation: 'موظف كامل' }, env.ctx)).toThrow()

    expect(monthlyPayroll(YEAR, MONTH)).toEqual(payrollBefore)
    expect(listExpenses({}).items).toEqual(expensesBefore)
  })

  it('does not write a misleading full-delete audit event when deletion is refused', () => {
    const { id } = employeeWithHistory()
    const before = getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM audit_log`)?.c ?? 0

    expect(() => fullDeleteEmployee({ id, confirmation: 'موظف كامل' }, env.ctx)).toThrow()

    const after = getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM audit_log`)?.c ?? 0
    expect(after).toBe(before)
    const event = getDatabase().get<{ details: string }>(
      sql`SELECT details FROM audit_log WHERE action = 'employees.full_delete' AND entity_id = ${String(id)}`
    )
    expect(event).toBeUndefined()
  })

  it('blocks the full delete — without falling back to archive — when the reversal is not provably exact', () => {
    const { id, accountId } = employeeWithHistory()
    const before = accountBalance(accountId)
    // A cash row that belongs to a transfer pair cannot be pulled out
    // alone without unbalancing the other side of the transfer.
    getRawConnection().prepare(`
      UPDATE cash_transactions SET transfer_group = 'TRF-1'
      WHERE ref_table = 'employee_transactions'
        AND ref_id IN (SELECT id FROM employee_transactions WHERE employee_id = ?)
      LIMIT 1
    `).run(id)

    expect(employeeDeletePreview(id).blockers.length).toBeGreaterThan(0)
    expect(() => fullDeleteEmployee({ id, confirmation: 'موظف كامل' }, env.ctx)).toThrowError(/تعذر الحذف النهائي/)
    expect(listEmployees({ activeOnly: false }).some((e) => e.id === id)).toBe(true)
    expect(listEmployees({ activeOnly: true }).some((e) => e.id === id)).toBe(true) // NOT silently archived
    expect(accountBalance(accountId)).toBe(before)
  })

  it('rolls the whole operation back if any step fails — never a partial delete', () => {
    const { id, accountId } = employeeWithHistory()
    const before = accountBalance(accountId)
    getRawConnection().exec("CREATE TRIGGER test_block_employee_delete BEFORE DELETE ON employees BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")

    expect(() => fullDeleteEmployee({ id, confirmation: 'موظف كامل' }, env.ctx)).toThrow()

    expect(listEmployees({ activeOnly: false }).some((e) => e.id === id)).toBe(true)
    expect(accountBalance(accountId)).toBe(before)
    const raw = getRawConnection()
    expect((raw.prepare('SELECT COUNT(*) AS c FROM employee_transactions WHERE employee_id = ?').get(id) as { c: number }).c).toBe(4)
    expect((raw.prepare("SELECT COUNT(*) AS c FROM expenses WHERE source = 'salary' AND source_ref_id = ?").get(id) as { c: number }).c).toBe(1)
  })

  it('refuses the full delete for a role without employees.fullDelete, even with a valid confirmation', () => {
    const { id } = employeeWithHistory()
    const roleId = createRole({ name: 'شؤون موظفين', permissions: [P.employees.view, P.employees.manage, P.employees.finance] }, env.ctx)
    createUser({ username: 'hr', password: 'secret789', fullName: 'موظف شؤون', roleId }, env.ctx)
    const { session } = login('hr', 'secret789', 91)

    expect(() => fullDeleteEmployee({ id, confirmation: 'موظف كامل' }, { session })).toThrowError(/صلاحية/)
    expect(listEmployees({ activeOnly: false }).some((e) => e.id === id)).toBe(true)
    // The archive path stays open to that same role.
    expect(deleteEmployee({ id, confirmation: 'موظف كامل' }, { session })).toMatchObject({
      removedFromCurrent: true,
      historyPreserved: true
    })
  })
})
