import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { eq, sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createRole, createUser, deleteRole, deleteUser, listRoles, listUsers, updateUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { getSessionForWebContents } from '@main/auth/session'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { users } from '@main/db/schema/users.schema'
import { roles } from '@main/db/schema/roles.schema'
import { expenses as expensesTable } from '@main/db/schema/finance.schema'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import {
  createCategory as createExpenseCategory,
  createExpense,
  deleteCategory as deleteExpenseCategory,
  deleteExpense,
  listCategories,
  listExpenses,
  updateExpense
} from '@main/services/finance/expenses.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import {
  createEmployee,
  employeeBalance,
  listDeductions,
  listEmployees,
  monthlyPayroll,
  paySalary,
  recordEmployeeTransaction
} from '@main/services/hr/employees.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { fullDeleteOrder, fullDeletePreview, getOrderOrThrow, recordPayment } from '@main/services/sales/orders.service'
import { completeProduction, consumeForOrder, issueRelease, issueWorkSheet, recordDelivery } from '@main/services/production/production.service'
import { createMachine, addMachineUsage } from '@main/services/production/machines.service'
import { createWorker, assignWorkerToOrder, workerBalances } from '@main/services/production/workers.service'
import { availableQty, recordWaste } from '@main/services/inventory/inventory.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

describe('real user deletion — delete is never a disguised disable', () => {
  it('hard-deletes an unused test account completely, preserves its role, and audits without credentials', () => {
    const roleId = createRole({ name: 'اختبار', permissions: [P.orders.view] }, env.ctx)
    const userId = createUser({ username: 'unused', password: 'secret789', fullName: 'غير مستخدم', roleId }, env.ctx)
    expect(deleteUser(userId, env.ctx)).toEqual({ mode: 'deleted' })
    // Row is truly gone, not just deactivated.
    expect(getDatabase().select().from(users).where(eq(users.id, userId)).get()).toBeUndefined()
    expect(listUsers().some((u) => u.id === userId)).toBe(false)
    expect(listRoles().some((role) => role.id === roleId)).toBe(true)
    expect(getDatabase().get<{ details: string }>(sql`SELECT details FROM audit_log WHERE action = 'users.delete' ORDER BY id DESC LIMIT 1`)?.details).not.toContain('secret789')
  })

  it('a historically-referenced user is tombstoned, not left visible as "معطل" — it disappears from the list exactly like a real delete', () => {
    const roleId = createRole({ name: 'موظف', permissions: [] }, env.ctx)
    const userId = createUser({ username: 'history', password: 'secret789', fullName: 'موظف تاريخي', roleId }, env.ctx)
    login('history', 'secret789', 77)
    expect(getSessionForWebContents(77)?.user.id).toBe(userId)
    expect(deleteUser(userId, env.ctx)).toEqual({ mode: 'tombstoned' })
    // The row survives (history stays attributed)...
    const row = getDatabase().select().from(users).where(eq(users.id, userId)).get()
    expect(row?.active).toBe(false)
    expect(row?.deletedAt).toBeTruthy()
    // ...but it is gone from active user management, same as a hard
    // delete — never shown as a disabled ("معطل") account.
    expect(listUsers().some((u) => u.id === userId)).toBe(false)
    expect(getSessionForWebContents(77)).toBeUndefined()
    expect(() => login('history', 'secret789', 78)).toThrowError(/غير صحيحة/)
    // Historical audit attribution is preserved, not orphaned/deleted.
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM audit_log WHERE user_id = ${userId}`)?.c).toBeGreaterThan(0)
  })

  it('a deleted user cannot be deleted or edited again', () => {
    const roleId = createRole({ name: 'اختبار2', permissions: [] }, env.ctx)
    const userId = createUser({ username: 'gone', password: 'secret789', fullName: 'محذوف', roleId }, env.ctx)
    login('gone', 'secret789', 79)
    deleteUser(userId, env.ctx) // referenced via its own login session -> tombstoned
    expect(() => deleteUser(userId, env.ctx)).toThrowError(/غير موجود/)
    expect(() => updateUser(userId, { fullName: 'محاولة تعديل' }, env.ctx)).toThrowError(/غير موجود/)
  })

  it('blocks self-deletion and removing the last active administrator by role change', () => {
    expect(() => deleteUser(env.ctx.session.user.id, env.ctx)).toThrowError(/حسابك/)
    const normalRole = createRole({ name: 'إدارة مستخدمين', permissions: [P.users.manage] }, env.ctx)
    expect(() => updateUser(env.ctx.session.user.id, { roleId: normalRole }, env.ctx)).toThrowError(/آخر حساب مدير/)
  })

  it('blocks deleting the last remaining active administrator directly', () => {
    // env.ctx's own session user is the seeded admin; create a second
    // admin, then deactivate the seeded one directly (bypassing the
    // self-delete guard on purpose, via raw update) so the second
    // admin becomes the sole active administrator, and prove deleting
    // *that* one is blocked.
    const adminRoleId = getDatabase().select().from(roles).where(eq(roles.isAdmin, true)).get()!.id
    const secondAdminId = createUser({ username: 'admin2', password: 'secret789', fullName: 'مدير ثاني', roleId: adminRoleId }, env.ctx)
    getDatabase().update(users).set({ active: false }).where(eq(users.id, env.ctx.session.user.id)).run()
    expect(() => deleteUser(secondAdminId, env.ctx)).toThrowError(/آخر حساب مدير/)
  })
})

describe('real role deletion', () => {
  it('permanently deletes a custom, unused role — it disappears from the roles list', () => {
    const roleId = createRole({ name: 'دور تجريبي', permissions: [P.reports.view] }, env.ctx)
    expect(listRoles().some((r) => r.id === roleId)).toBe(true)
    deleteRole({ id: roleId, confirmation: 'دور تجريبي' }, env.ctx)
    expect(listRoles().some((r) => r.id === roleId)).toBe(false)
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'roles.delete' AND entity_id = ${String(roleId)}`)?.c).toBe(1)
  })

  it('blocks deleting a role that still has users assigned, with a clear message, and orphans nobody', () => {
    const roleId = createRole({ name: 'دور مستخدم', permissions: [] }, env.ctx)
    const userId = createUser({ username: 'roleuser', password: 'secret789', fullName: 'مستخدم الدور', roleId }, env.ctx)
    expect(() => deleteRole({ id: roleId, confirmation: 'دور مستخدم' }, env.ctx)).toThrowError(/مرتبط بمستخدمين/)
    expect(listRoles().some((r) => r.id === roleId)).toBe(true)
    expect(getDatabase().select().from(users).where(eq(users.id, userId)).get()?.roleId).toBe(roleId)
  })

  it('blocks deleting the required system administrator role', () => {
    const adminRole = getDatabase().select().from(roles).where(eq(roles.isAdmin, true)).get()!
    expect(() => deleteRole({ id: adminRole.id, confirmation: adminRole.name }, env.ctx)).toThrowError(/مدير النظام/)
    expect(listRoles().some((r) => r.id === adminRole.id)).toBe(true)
  })

  it('rejects a wrong typed confirmation server-side, with zero mutation — never trusting the UI alone', () => {
    const roleId = createRole({ name: 'دور دقيق', permissions: [P.reports.view] }, env.ctx)
    expect(() => deleteRole({ id: roleId, confirmation: 'اسم خاطئ' }, env.ctx)).toThrowError(/اكتب اسم الدور/)
    expect(listRoles().some((r) => r.id === roleId)).toBe(true)
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ${roleId}`)?.c).toBe(1)
  })

  it('rolls back cleanly if a later step fails — no partial role deletion', () => {
    const roleId = createRole({ name: 'دور للتراجع', permissions: [P.reports.view] }, env.ctx)
    getRawConnection().exec('CREATE TRIGGER test_block_role_delete BEFORE DELETE ON roles BEGIN SELECT RAISE(ABORT, \'forced rollback\'); END')
    expect(() => deleteRole({ id: roleId, confirmation: 'دور للتراجع' }, env.ctx)).toThrow()
    expect(listRoles().some((r) => r.id === roleId)).toBe(true)
    // role_permissions were not orphaned/removed by the rolled-back attempt.
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ${roleId}`)?.c).toBe(1)
  })

  it('RBAC and authentication keep working normally after these changes', () => {
    // A scoped role carries exactly its granted permission and nothing
    // from admin.manage — the router-level guard these deletes rely on
    // (requirePermission) is untouched by this change.
    const roleId = createRole({ name: 'صلاحية محدودة', permissions: [P.reports.view] }, env.ctx)
    const userId = createUser({ username: 'scoped', password: 'secret789', fullName: 'مستخدم محدود', roleId }, env.ctx)
    const { session } = login('scoped', 'secret789', 81)
    expect(session.user.id).toBe(userId)
    expect(session.user.isAdmin).toBe(false)
    expect(session.permissions).toContain(P.reports.view)
    expect(session.permissions).not.toContain(P.users.manage)
    // Authentication itself is untouched: wrong password still rejected,
    // correct one still succeeds for an ordinary, non-deleted account.
    expect(() => login('scoped', 'wrong-password', 82)).toThrowError(/غير صحيحة/)
    expect(login('scoped', 'secret789', 82).session.user.id).toBe(userId)
  })
})

describe('fixed and variable expense correction', () => {
  it.each(['fixed', 'variable'] as const)('edits and deletes a %s expense with one corrected cash effect', (kind) => {
    const first = createAccount({ name: `صندوق-${kind}`, kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    const second = createAccount({ name: `بنك-${kind}`, kind: 'bank', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    // Item 10/11 (final spec): "مصروف جديد" (createExpense) can only
    // ever create 'variable' now — a 'fixed' manual row only exists as
    // PRE-EXISTING historical data, so it is seeded directly here to
    // prove updateExpense/deleteExpense still correct such a legacy
    // row exactly as they always have (item 25: preserve existing data).
    const id = kind === 'variable'
      ? createExpense({ amountMinor: moneyFromMajor(500), cashAccountId: first, description: 'مصروف', spentAt: '2026-09-01' }, env.ctx)
      : (() => {
          const rowId = Number(getDatabase().insert(expensesTable).values({
            kind: 'fixed', amountMinor: moneyFromMajor(500), cashAccountId: first,
            description: 'مصروف', spentAt: '2026-09-01', source: 'manual', createdAt: '2026-09-01T00:00:00.000Z'
          }).run().lastInsertRowid)
          getRawConnection().prepare(`INSERT INTO cash_transactions
            (account_id, direction, amount_minor, kind, ref_table, ref_id, occurred_at, created_at)
            VALUES (?, 'out', ?, 'expense', 'expenses', ?, '2026-09-01', '2026-09-01T00:00:00.000Z')`)
            .run(first, moneyFromMajor(500), rowId)
          return rowId
        })()
    expect(accountBalance(first)).toBe(moneyFromMajor(4500))
    updateExpense(id, { amountMinor: moneyFromMajor(200), cashAccountId: second, spentAt: '2026-08-31', description: 'مصروف مصحح' }, env.ctx)
    expect(accountBalance(first)).toBe(moneyFromMajor(5000))
    expect(accountBalance(second)).toBe(moneyFromMajor(4800))
    expect(listExpenses({}).items.find((row) => row.id === id)?.spentAt).toBe('2026-08-31')
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = ${id}`)?.c).toBe(1)
    deleteExpense(id, env.ctx)
    expect(accountBalance(second)).toBe(moneyFromMajor(5000))
    expect(listExpenses({}).items.some((row) => row.id === id)).toBe(false)
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = ${`expenses.${kind}.delete`}`)?.c).toBe(1)
  })
})

describe('fixed and variable expense deletion (Part C)', () => {
  const YEAR = 2026
  const MONTH = 9

  it.each(['fixed', 'variable'] as const)(
    'deletes a %s expense with no reason, reversing its cash effect and its share of net profit',
    (kind) => {
      const accountId = createAccount({ name: `صندوق-حذف-${kind}`, kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
      const categoryId = createExpenseCategory({ name: `تصنيف-${kind}`, kind }, env.ctx)
      const id = createExpense({ categoryId, kind, amountMinor: moneyFromMajor(400), cashAccountId: accountId, description: 'مصروف', spentAt: '2026-09-10' }, env.ctx)
      const withExpense = monthlyProfitSummary(YEAR, MONTH)
      expect(withExpense.generalExpensesMinor).toBe(moneyFromMajor(400))

      // The service takes an id alone — there is no reason parameter to pass.
      deleteExpense(id, env.ctx)

      expect(accountBalance(accountId)).toBe(moneyFromMajor(5000))
      expect(listExpenses({ kind }).items.some((row) => row.id === id)).toBe(false)
      const after = monthlyProfitSummary(YEAR, MONTH)
      expect(after.generalExpensesMinor).toBe(0)
      expect(after.netProfitMinor).toBe(withExpense.netProfitMinor + moneyFromMajor(400))
      expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = ${id}`)?.c).toBe(0)
      // The category — the closest thing this schema has to a recurring
      // definition — survives its posted occurrence being deleted.
      expect(listCategories().some((row) => row.id === categoryId)).toBe(true)
    }
  )

  it('never lets deleting the category take its historical posted expenses with it', () => {
    const categoryId = createExpenseCategory({ name: 'إيجار', kind: 'fixed' }, env.ctx)
    const expenseId = createExpense({ categoryId, kind: 'fixed', amountMinor: moneyFromMajor(700), description: 'إيجار سبتمبر', spentAt: '2026-09-01' }, env.ctx)

    expect(() => deleteExpenseCategory(categoryId, env.ctx)).toThrowError(/لا يمكن حذف/)
    expect(listExpenses({}).items.some((row) => row.id === expenseId)).toBe(true)
  })

})

/**
 * Part 4: a salary-generated expense is deletable from the Expenses
 * screen itself. It is not a self-contained row, so deleting it
 * delegates to the payroll service's single reverseSalaryPayment path,
 * which undoes the whole payment — never the employee.
 */
describe('salary-generated expense deletion from the Expenses screen (Part 4)', () => {
  const YEAR = 2026
  const MONTH = 9

  function paidSalary(opts: { deductionMajor?: number } = {}) {
    const accountId = createAccount({ name: 'صندوق الرواتب', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    const employeeId = createEmployee({ name: 'موظف راتب', monthlySalaryMinor: moneyFromMajor(1000) }, env.ctx)
    const payment = paySalary({
      employeeId,
      amountMinor: moneyFromMajor(600),
      periodYear: YEAR,
      periodMonth: MONTH,
      deductionMinor: opts.deductionMajor ? moneyFromMajor(opts.deductionMajor) : undefined,
      cashAccountId: accountId
    }, env.ctx)
    return { accountId, employeeId, ...payment }
  }

  it('deletes it with no reason, undoing the payment, its cash outflow and the expense', () => {
    const { accountId, employeeId, expenseId, transactionId } = paidSalary()
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4400))
    expect(monthlyPayroll(YEAR, MONTH).find((row) => row.employeeId === employeeId)).toMatchObject({
      paidMinor: moneyFromMajor(600),
      remainingSalaryMinor: moneyFromMajor(400)
    })

    // Nothing but the id — there is no reason parameter to pass.
    expect(deleteExpense(expenseId, env.ctx)).toEqual({ salaryPaymentReversed: true })

    expect(listExpenses({}).items.find((row) => row.id === expenseId)?.reversedAt).toBeTruthy()
    expect(accountBalance(accountId)).toBe(moneyFromMajor(5000))
    expect(monthlyPayroll(YEAR, MONTH).find((row) => row.employeeId === employeeId)).toMatchObject({
      paidMinor: 0,
      remainingSalaryMinor: moneyFromMajor(1000)
    })
    const raw = getRawConnection()
    expect((raw.prepare('SELECT COUNT(*) AS c FROM employee_transactions WHERE id = ? AND reversed_at IS NOT NULL').get(transactionId) as { c: number }).c).toBe(1)
    expect((raw.prepare("SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'employee_transactions' AND ref_id = ?").get(transactionId) as { c: number }).c).toBe(2)
    expect((raw.prepare("SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'employee_transactions' AND ref_id = ? AND reversal_of_id IS NOT NULL").get(transactionId) as { c: number }).c).toBe(1)
    expect((raw.prepare("SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = ?").get(expenseId) as { c: number }).c).toBe(0)
    expect(raw.pragma('foreign_key_check')).toEqual([])
  })

  it('takes the deduction the payment itself recorded, and leaves the employee standing', () => {
    const { employeeId, expenseId, accountId } = paidSalary({ deductionMajor: 100 })
    // 600 gross salary, 100 inline deduction => 500 net cash out.
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4500))
    expect(listDeductions({ employeeId }).items.length).toBe(1)

    deleteExpense(expenseId, env.ctx)

    expect(listDeductions({ employeeId }).items).toHaveLength(1)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(5000))
    // The employee is untouched — this deletes a payment, not a person.
    expect(listEmployees({ activeOnly: false }).some((e) => e.id === employeeId)).toBe(true)
    expect(monthlyPayroll(YEAR, MONTH).find((row) => row.employeeId === employeeId)?.remainingSalaryMinor)
      .toBe(moneyFromMajor(900))
  })

  it('leaves a standalone deduction and outstanding advances alone', () => {
    const { employeeId, expenseId, accountId } = paidSalary()
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(50), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'advance', amountMinor: moneyFromMajor(200), cashAccountId: accountId }, env.ctx)

    deleteExpense(expenseId, env.ctx)

    expect(listDeductions({ employeeId }).items.length).toBe(1)
    expect(employeeBalance(employeeId)).toBe(moneyFromMajor(200))
    // 5000 − 200 advance; the 600 salary is back.
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4800))
  })

  it('recalculates expense totals and net profit', () => {
    const { expenseId } = paidSalary()
    // Recognised via the payroll period, not generalExpensesMinor.
    expect(monthlyProfitSummary(YEAR, MONTH).payrollExpenseMinor).toBe(moneyFromMajor(600))
    expect(monthlyProfitSummary(YEAR, MONTH).generalExpensesMinor).toBe(0)
    const before = monthlyProfitSummary(YEAR, MONTH).netProfitMinor

    deleteExpense(expenseId, env.ctx)

    const after = monthlyProfitSummary(YEAR, MONTH)
    expect(after.payrollExpenseMinor).toBe(0)
    expect(after.generalExpensesMinor).toBe(0)
    expect(after.netProfitMinor).toBe(before + moneyFromMajor(600))
  })

  it('the salary can be paid again afterwards, with no double deduction', () => {
    const { employeeId, expenseId, accountId } = paidSalary({ deductionMajor: 100 })
    deleteExpense(expenseId, env.ctx)

    paySalary({ employeeId, amountMinor: moneyFromMajor(900), periodYear: YEAR, periodMonth: MONTH, cashAccountId: accountId }, env.ctx)

    expect(listDeductions({ employeeId }).items.length).toBe(1)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4100))
  })

  it('rolls everything back if a later step fails — never a partial deletion', () => {
    const { accountId, expenseId, transactionId } = paidSalary()
    getRawConnection().exec("CREATE TRIGGER test_block_salary_reversal BEFORE UPDATE OF reversed_at ON employee_transactions WHEN NEW.reversed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")

    expect(() => deleteExpense(expenseId, env.ctx)).toThrow()

    expect(listExpenses({}).items.some((row) => row.id === expenseId)).toBe(true)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4400))
    const raw = getRawConnection()
    expect((raw.prepare('SELECT COUNT(*) AS c FROM employee_transactions WHERE id = ?').get(transactionId) as { c: number }).c).toBe(1)
    expect((raw.prepare("SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'employee_transactions' AND ref_id = ?").get(transactionId) as { c: number }).c).toBe(1)
  })

  it('blocks the deletion when the salary expense was charged to a customer order', () => {
    const { expenseId, accountId } = paidSalary()
    const chain = orderChain()
    getRawConnection().prepare('UPDATE expenses SET order_id = ? WHERE id = ?').run(chain.order.id, expenseId)

    expect(() => deleteExpense(expenseId, env.ctx)).toThrowError(/تعذر عكس صرف الراتب/)
    expect(listExpenses({}).items.some((row) => row.id === expenseId)).toBe(true)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4400))
  })

  it('requires payroll authority as well as expense authority', () => {
    const { expenseId } = paidSalary()
    const roleId = createRole({ name: 'محاسب مصروفات', permissions: [P.expenses.view, P.expenses.manage] }, env.ctx)
    createUser({ username: 'expensesonly', password: 'secret789', fullName: 'محاسب', roleId }, env.ctx)
    const { session } = login('expensesonly', 'secret789', 93)

    expect(() => deleteExpense(expenseId, { session })).toThrowError(/صلاحية/)
    expect(listExpenses({}).items.some((row) => row.id === expenseId)).toBe(true)
  })
})

function orderChain(manufacturing = true) {
  const categoryId = createCategory({ name: 'خشب' }, env.ctx)
  const materialId = createMaterial({ sku: 'MDF-FULL-DELETE', name: 'MDF', categoryId, unit: 'لوح', currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact' } as never, env.ctx)
  const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
  createPurchase({ supplierId, lines: [{ materialId, qtyMicro: quantityFromDisplay(20), unitCostMicro: unitCostFromMajor(100), batchCode: 'LOT-FD' }] }, env.ctx)
  const customerId = createCustomer({ name: 'عميل' }, env.ctx)
  const quotation = createFinalInvoice({ customerId, depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'SO-TEST', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(6000) }] }, env.ctx)
  const order = approveToOrder(quotation.id, env.ctx)
  const accountId = createAccount({ name: 'صندوق الطلب', kind: 'cash', openingBalanceMinor: 0 }, env.ctx)
  const sheet = manufacturing ? issueWorkSheet({ orderId: order.id }, env.ctx) : undefined
  if (sheet) consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(10) }, env.ctx)
  return { invoiceId: quotation.id, customerId, order, sheetId: sheet?.id ?? 0, materialId, accountId }
}

describe('authorized full delete operation', () => {
  it('rejects post-issuance deletion without changing manufacturing, FIFO, cost, cash or invoice history', () => {
    const chain = orderChain()
    const raw = getRawConnection()
    const tables = ['orders', 'work_sheets', 'inventory_movements', 'fifo_layers', 'fifo_allocations', 'order_material_lines', 'final_invoices', 'audit_log']
    const rows = () => tables.map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = rows()
    expect(fullDeletePreview(chain.order.id).blockers.join(' ')).toMatch(/بعد إصدار/)
    expect(() => fullDeleteOrder({ id: chain.order.id, confirmation: chain.order.documentNumber }, env.ctx)).toThrow(/بعد إصدار/)
    expect(rows()).toEqual(before)
    expect(availableQty(chain.materialId)).toBe(quantityFromDisplay(10))
    expect(raw.pragma('foreign_key_check')).toEqual([])
  })

  it('rejects destructive deletion of a completed paid chain and preserves linked history', () => {
    const chain = orderChain()
    const workerId = createWorker({ name: 'عامل العملية' }, env.ctx)
    assignWorkerToOrder({ workSheetId: chain.sheetId, workerId, method: 'fixed', amountMinor: moneyFromMajor(300) }, env.ctx)
    const machineId = createMachine({ name: 'آلة العملية', costingUnit: 'لوح', defaultRateMicro: unitCostFromMajor(20) }, env.ctx)
    addMachineUsage({ workSheetId: chain.sheetId, machineId, usageQtyMicro: quantityFromDisplay(2) }, env.ctx)
    createExpense({ kind: 'variable', amountMinor: moneyFromMajor(100), orderId: chain.order.id, cashAccountId: chain.accountId, description: 'نقل الطلب' }, env.ctx)
    recordPayment({ orderId: chain.order.id, amountMinor: moneyFromMajor(6000), cashAccountId: chain.accountId }, env.ctx)
    completeProduction(chain.sheetId, env.ctx)
    const release = issueRelease({ orderId: chain.order.id, kind: 'transport' }, env.ctx)
    recordDelivery({ orderId: chain.order.id, kind: 'delivery', releaseId: release.id }, env.ctx)
    const raw = getRawConnection()
    const tables = ['orders', 'work_sheets', 'customer_payments', 'cash_transactions', 'inventory_movements', 'fifo_layers', 'fifo_allocations', 'order_material_lines', 'order_machine_usage', 'order_worker_assignments', 'expenses', 'releases', 'deliveries', 'final_invoices']
    const rows = () => tables.map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = rows(), cash = accountBalance(chain.accountId), worker = workerBalances(workerId), stock = availableQty(chain.materialId)
    expect(() => fullDeleteOrder({ id: chain.order.id, confirmation: chain.order.documentNumber }, env.ctx)).toThrow(/استرداد كامل/)
    expect(rows()).toEqual(before)
    expect(accountBalance(chain.accountId)).toBe(cash)
    expect(workerBalances(workerId)).toEqual(worker)
    expect(availableQty(chain.materialId)).toBe(stock)
    expect(raw.pragma('foreign_key_check')).toEqual([])
  })

  it('preserves unrelated waste while removing only this order consumption', () => {
    const chain = orderChain()
    recordWaste({ materialId: chain.materialId, qtyMicro: quantityFromDisplay(1), reason: 'هالك مستقل', ctx: env.ctx })
    expect(() => fullDeleteOrder({ id: chain.order.id, confirmation: chain.order.documentNumber }, env.ctx)).toThrow(/بعد إصدار/)
    expect(availableQty(chain.materialId)).toBe(quantityFromDisplay(9))
    expect((getRawConnection().prepare("SELECT COUNT(*) AS c FROM inventory_movements WHERE kind = 'waste'").get() as { c: number }).c).toBe(1)
  })

  it('blocks an unsafe FIFO mismatch without partially deleting the operation', () => {
    const chain = orderChain()
    getRawConnection().prepare('UPDATE fifo_allocations SET qty_micro = qty_micro - 1 WHERE movement_id IN (SELECT movement_id FROM order_material_lines WHERE order_id = ?)').run(chain.order.id)
    expect(fullDeletePreview(chain.order.id).blockers.join(' ')).toMatch(/طبقات التكلفة/)
    expect(() => fullDeleteOrder({ id: chain.order.id, confirmation: chain.order.documentNumber }, env.ctx)).toThrowError(/بعد إصدار/)
    expect(getOrderOrThrow(chain.order.id).id).toBe(chain.order.id)
    expect(accountBalance(chain.accountId)).toBe(0)
  })

  it('requires the exact order number as strong backend confirmation', () => {
    const chain = orderChain(false)
    expect(() => fullDeleteOrder({ id: chain.order.id, confirmation: 'DELETE' }, env.ctx)).toThrowError(/اكتب رقم الطلب/)
    expect(() => fullDeleteOrder({ id: chain.order.id, confirmation: ` ${chain.order.documentNumber} ` }, env.ctx)).toThrowError(/اكتب رقم الطلب/)
    expect(getOrderOrThrow(chain.order.id).id).toBe(chain.order.id)
  })

  it('rolls back every reversal if a late deletion step fails', () => {
    const chain = orderChain()
    getRawConnection().exec(`CREATE TRIGGER test_block_full_delete BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'forced rollback'); END`)
    expect(() => fullDeleteOrder({ id: chain.order.id, confirmation: chain.order.documentNumber }, env.ctx)).toThrow()
    expect(getOrderOrThrow(chain.order.id).id).toBe(chain.order.id)
    expect(availableQty(chain.materialId)).toBe(quantityFromDisplay(10))
    expect(accountBalance(chain.accountId)).toBe(0)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
