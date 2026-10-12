import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import type { IpcMainInvokeEvent } from 'electron'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import {
  createEmployee,
  deleteSalaryPaymentFromHistory,
  deleteEmployeeTransaction,
  listDeductions,
  listSalaryPayments,
  monthlyPayroll,
  paySalary,
  recordEmployeeTransaction,
  reverseSalaryPayment,
  updateEmployee,
  updateEmployeeTransaction
} from '@main/services/hr/employees.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { listExpenses } from '@main/services/finance/expenses.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import { buildAuthorizedReport } from '@main/services/reports/reports.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { closeDatabase, getDatabase, getRawConnection, setDatabasePath } from '@main/db/connection'
import { employeeTransactions } from '@main/db/schema/hr.schema'
import { moneyFromMajor } from '@shared/money/money'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const YEAR = 2026
const MONTH = 9

function payroll(employeeId: number, year = YEAR, month = MONTH) {
  return monthlyPayroll(year, month).find((row) => row.employeeId === employeeId)!
}

describe('authoritative remaining salary and payment amount', () => {
  it('pays only salary − period deduction and creates expense/cash for the actual payment', () => {
    const accountId = createAccount({ name: 'صندوق الرواتب', kind: 'cash', openingBalanceMinor: moneyFromMajor(5_000) }, env.ctx)
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1_500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(900), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    expect(payroll(employeeId).remainingSalaryMinor).toBe(moneyFromMajor(600))
    const payment = paySalary({ employeeId, amountMinor: moneyFromMajor(600), periodYear: YEAR, periodMonth: MONTH, cashAccountId: accountId }, env.ctx)

    expect(payment.netPaidMinor).toBe(moneyFromMajor(600))
    expect(payroll(employeeId)).toMatchObject({ paidMinor: moneyFromMajor(600), deductionMinor: moneyFromMajor(900), remainingSalaryMinor: 0 })
    expect(listExpenses({}).items.find((row) => row.id === payment.expenseId)?.amountMinor).toBe(moneyFromMajor(600))
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4_400))
  })

  it('supports partial payments, pays the later remainder, and rejects overpayment at zero without side effects', () => {
    const employeeId = createEmployee({ name: 'موظف جزئي', monthlySalaryMinor: moneyFromMajor(1_500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(500), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(300), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    expect(payroll(employeeId).remainingSalaryMinor).toBe(moneyFromMajor(700))
    paySalary({ employeeId, amountMinor: moneyFromMajor(700), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    expect(payroll(employeeId)).toMatchObject({ paidMinor: moneyFromMajor(1_000), remainingSalaryMinor: 0 })

    const before = {
      payments: listSalaryPayments({ employeeId }).items.length,
      expenses: listExpenses({}).items.length,
      cash: getRawConnection().prepare('SELECT COUNT(*) AS c FROM cash_transactions').get() as { c: number }
    }
    expect(() => paySalary({ employeeId, amountMinor: moneyFromMajor(1), periodYear: YEAR, periodMonth: MONTH }, env.ctx))
      .toThrowError(/لا يوجد راتب متبق/)
    expect(listSalaryPayments({ employeeId }).items).toHaveLength(before.payments)
    expect(listExpenses({}).items).toHaveLength(before.expenses)
    expect((getRawConnection().prepare('SELECT COUNT(*) AS c FROM cash_transactions').get() as { c: number }).c).toBe(before.cash.c)
  })

  it('rejects renderer/backend attempts to pay above the authoritative remainder', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1_500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(500), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    expect(() => paySalary({ employeeId, amountMinor: moneyFromMajor(1_500), periodYear: YEAR, periodMonth: MONTH }, env.ctx))
      .toThrowError(/يتجاوز الراتب المتبقي/)
    expect(listSalaryPayments({ employeeId }).items).toEqual([])
    expect(listExpenses({}).items).toEqual([])
  })
})

describe('salary payment reversal', () => {
  it('blocks active-history deletion, then hides a reversed payment with zero additional financial effect', () => {
    const accountId = createAccount({ name: 'صندوق الإخفاء', kind: 'cash', openingBalanceMinor: moneyFromMajor(5_000) }, env.ctx)
    const employeeId = createEmployee({ name: 'موظف حذف السجل', monthlySalaryMinor: moneyFromMajor(1_500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(900), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    const payment = paySalary({ employeeId, amountMinor: moneyFromMajor(600), periodYear: YEAR, periodMonth: MONTH, cashAccountId: accountId }, env.ctx)

    expect(() => deleteSalaryPaymentFromHistory(payment.transactionId, env.ctx)).toThrowError(/يجب عكسه أولاً/)
    reverseSalaryPayment(payment.transactionId, env.ctx)
    const before = {
      payroll: payroll(employeeId),
      balance: accountBalance(accountId),
      cashRows: (getRawConnection().prepare('SELECT COUNT(*) AS c FROM cash_transactions').get() as { c: number }).c,
      expense: listExpenses({}).items.find((row) => row.id === payment.expenseId)
    }

    expect(deleteSalaryPaymentFromHistory(payment.transactionId, env.ctx)).toEqual({ ok: true })
    expect(listSalaryPayments({ employeeId }).items).toEqual([])
    expect(payroll(employeeId)).toEqual(before.payroll)
    expect(accountBalance(accountId)).toBe(before.balance)
    expect((getRawConnection().prepare('SELECT COUNT(*) AS c FROM cash_transactions').get() as { c: number }).c).toBe(before.cashRows)
    expect(listExpenses({}).items.find((row) => row.id === payment.expenseId)).toEqual(before.expense)
    const stored = getRawConnection().prepare('SELECT reversed_at AS reversedAt, history_hidden_at AS historyHiddenAt FROM employee_transactions WHERE id=?').get(payment.transactionId) as { reversedAt: string; historyHiddenAt: string }
    expect(stored.reversedAt).toBeTruthy()
    expect(stored.historyHiddenAt).toBeTruthy()
    expect(() => deleteSalaryPaymentFromHistory(payment.transactionId, env.ctx)).toThrowError(/بالفعل/)
    expect(getRawConnection().prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action='employees.salary_payment.history_hide' AND entity_id=?").get(String(payment.transactionId))).toEqual({ c: 1 })
  })

  it('preserves the payment and deduction history, reverses expense/cash once, and audits the actor', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5_000) }, env.ctx)
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1_500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(500), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    const payment = paySalary({ employeeId, amountMinor: moneyFromMajor(1_000), periodYear: YEAR, periodMonth: MONTH, cashAccountId: accountId }, env.ctx)

    reverseSalaryPayment(payment.transactionId, env.ctx)

    expect(payroll(employeeId)).toMatchObject({ paidMinor: 0, deductionMinor: moneyFromMajor(500), remainingSalaryMinor: moneyFromMajor(1_000) })
    expect(listDeductions({ employeeId }).items).toHaveLength(1)
    expect(listSalaryPayments({ employeeId }).items[0]).toMatchObject({ id: payment.transactionId, amountMinor: moneyFromMajor(1_000), status: 'reversed' })
    expect(listExpenses({}).items.find((row) => row.id === payment.expenseId)?.reversedAt).toBeTruthy()
    expect(accountBalance(accountId)).toBe(moneyFromMajor(5_000))
    const cash = getRawConnection().prepare("SELECT direction, amount_minor AS amountMinor, reversal_of_id AS reversalOfId FROM cash_transactions WHERE ref_table='employee_transactions' AND ref_id=? ORDER BY id").all(payment.transactionId) as Array<{ direction: string; amountMinor: number; reversalOfId: number | null }>
    expect(cash).toHaveLength(2)
    expect(cash.map((row) => row.direction)).toEqual(['out', 'in'])
    expect(cash[1]).toMatchObject({ amountMinor: moneyFromMajor(1_000), reversalOfId: expect.any(Number) })
    const audit = getRawConnection().prepare("SELECT details FROM audit_log WHERE action='employees.salary_payment.reverse' AND entity_id=?").get(String(payment.transactionId)) as { details: string }
    expect(audit.details).toContain(`"netPaidMinor":${moneyFromMajor(1_000)}`)
  })

  it('reverses one of multiple payments independently and rejects a second reversal', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1_000) }, env.ctx)
    const first = paySalary({ employeeId, amountMinor: moneyFromMajor(300), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    const second = paySalary({ employeeId, amountMinor: moneyFromMajor(700), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    reverseSalaryPayment(second.transactionId, env.ctx)
    expect(payroll(employeeId)).toMatchObject({ paidMinor: moneyFromMajor(300), remainingSalaryMinor: moneyFromMajor(700) })
    expect(listSalaryPayments({ employeeId }).items.find((row) => row.id === first.transactionId)?.status).toBe('posted')
    deleteSalaryPaymentFromHistory(second.transactionId, env.ctx)
    expect(listSalaryPayments({ employeeId }).items.map((row) => row.id)).toEqual([first.transactionId])
    expect(payroll(employeeId)).toMatchObject({ paidMinor: moneyFromMajor(300), remainingSalaryMinor: moneyFromMajor(700) })
    expect(() => reverseSalaryPayment(second.transactionId, env.ctx)).toThrowError(/بالفعل/)
    expect(payroll(employeeId).remainingSalaryMinor).toBe(moneyFromMajor(700))
  })

  it('rolls back the entire reversal when the linked expense cannot be marked reversed', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5_000) }, env.ctx)
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1_000) }, env.ctx)
    const payment = paySalary({ employeeId, amountMinor: moneyFromMajor(1_000), periodYear: YEAR, periodMonth: MONTH, cashAccountId: accountId }, env.ctx)
    getRawConnection().exec("CREATE TRIGGER fail_salary_expense_reversal BEFORE UPDATE OF reversed_at ON expenses WHEN NEW.reversed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")

    expect(() => reverseSalaryPayment(payment.transactionId, env.ctx)).toThrow()
    expect(payroll(employeeId)).toMatchObject({ paidMinor: moneyFromMajor(1_000), remainingSalaryMinor: 0 })
    expect(listSalaryPayments({ employeeId }).items[0]?.status).toBe('posted')
    expect(listExpenses({}).items.find((row) => row.id === payment.expenseId)?.reversedAt).toBeNull()
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4_000))
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM cash_transactions WHERE reversal_of_id IS NOT NULL').get()).toEqual({ c: 0 })
  })

  it('requires employees.finance in the service even for a forged direct call', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1_000) }, env.ctx)
    const payment = paySalary({ employeeId, amountMinor: moneyFromMajor(1_000), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    const roleId = createRole({ name: 'مشاهدة الموظفين', permissions: [] }, env.ctx)
    createUser({ username: 'no-payroll', password: 'secret789', fullName: 'بدون صلاحية', roleId }, env.ctx)
    const limited = login('no-payroll', 'secret789', 909)

    expect(() => reverseSalaryPayment(payment.transactionId, { session: limited.session })).toThrowError(/صلاحية/)
    reverseSalaryPayment(payment.transactionId, env.ctx)
    expect(() => deleteSalaryPaymentFromHistory(payment.transactionId, { session: limited.session })).toThrowError(/صلاحية/)
    expect(listSalaryPayments({ employeeId }).items[0]?.status).toBe('reversed')
  })

  it('rejects a direct IPC reversal attempt from a session without payroll finance permission', async () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1_000) }, env.ctx)
    const payment = paySalary({ employeeId, amountMinor: moneyFromMajor(1_000), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    const roleId = createRole({ name: 'دور بلا رواتب', permissions: [] }, env.ctx)
    createUser({ username: 'forged-payroll', password: 'secret789', fullName: 'محاولة مباشرة', roleId }, env.ctx)
    const windowId = 18_034
    login('forged-payroll', 'secret789', windowId)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()

    const result = await handlers.get(IPC_CHANNELS.employees.reverseSalaryPayment)!(
      { sender: { id: windowId } } as IpcMainInvokeEvent,
      { id: payment.transactionId }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    expect(listSalaryPayments({ employeeId }).items[0]?.status).toBe('posted')

    reverseSalaryPayment(payment.transactionId, env.ctx)
    const deleteResult = await handlers.get(IPC_CHANNELS.employees.deleteSalaryPaymentHistory)!(
      { sender: { id: windowId } } as IpcMainInvokeEvent,
      { id: payment.transactionId }
    )
    expect(deleteResult.ok).toBe(false)
    if (!deleteResult.ok) expect(deleteResult.error.code).toBe('FORBIDDEN')
    expect(listSalaryPayments({ employeeId }).items[0]?.status).toBe('reversed')
  })

  it('rolls back visible-history deletion when its audit write fails', () => {
    const employeeId = createEmployee({ name: 'موظف تدقيق', monthlySalaryMinor: moneyFromMajor(1_000) }, env.ctx)
    const payment = paySalary({ employeeId, amountMinor: moneyFromMajor(1_000), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    reverseSalaryPayment(payment.transactionId, env.ctx)
    getRawConnection().exec("CREATE TRIGGER fail_salary_history_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'employees.salary_payment.history_hide' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")

    expect(() => deleteSalaryPaymentFromHistory(payment.transactionId, env.ctx)).toThrow()
    expect(listSalaryPayments({ employeeId }).items[0]).toMatchObject({ id: payment.transactionId, status: 'reversed' })
    expect((getRawConnection().prepare('SELECT history_hidden_at AS hiddenAt FROM employee_transactions WHERE id=?').get(payment.transactionId) as { hiddenAt: string | null }).hiddenAt).toBeNull()
  })
})

describe('deduction safety and period/report correctness', () => {
  it('recalculates edits/deletes and blocks a deduction edit that would make paid exceed entitlement', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1_500) }, env.ctx)
    const deductionId = recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(500), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(1_000), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    updateEmployeeTransaction(deductionId, { amountMinor: moneyFromMajor(300) }, env.ctx)
    expect(payroll(employeeId).remainingSalaryMinor).toBe(moneyFromMajor(200))
    expect(() => updateEmployeeTransaction(deductionId, { amountMinor: moneyFromMajor(600) }, env.ctx)).toThrowError(/ستتجاوز صافي استحقاق/)
    deleteEmployeeTransaction(deductionId, env.ctx)
    expect(payroll(employeeId).remainingSalaryMinor).toBe(moneyFromMajor(500))
  })

  it('isolates periods and removes reversed pay from payroll profit only in its own period', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1_500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(500), periodYear: 2026, periodMonth: 9 }, env.ctx)
    const september = paySalary({ employeeId, amountMinor: moneyFromMajor(1_000), periodYear: 2026, periodMonth: 9 }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(1_500), periodYear: 2026, periodMonth: 10 }, env.ctx)
    expect(payroll(employeeId, 2026, 9).remainingSalaryMinor).toBe(0)
    expect(payroll(employeeId, 2026, 10).deductionMinor).toBe(0)
    expect(monthlyProfitSummary(2026, 9).payrollExpenseMinor).toBe(moneyFromMajor(1_000))
    expect(monthlyProfitSummary(2026, 10).payrollExpenseMinor).toBe(moneyFromMajor(1_500))

    reverseSalaryPayment(september.transactionId, env.ctx)
    expect(monthlyProfitSummary(2026, 9).payrollExpenseMinor).toBe(0)
    expect(monthlyProfitSummary(2026, 10).payrollExpenseMinor).toBe(moneyFromMajor(1_500))
  })

  it('uses the salary history effective for each period instead of rewriting an older month after a raise', () => {
    const employeeId = createEmployee({ name: 'موظف متدرج', monthlySalaryMinor: moneyFromMajor(1_000), hiredAt: '2026-09-01' }, env.ctx)
    updateEmployee(employeeId, { monthlySalaryMinor: moneyFromMajor(1_500), effectiveFrom: '2026-10-01' }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(200), periodYear: 2026, periodMonth: 9 }, env.ctx)

    expect(payroll(employeeId, 2026, 9)).toMatchObject({ monthlySalaryMinor: moneyFromMajor(1_000), remainingSalaryMinor: moneyFromMajor(800) })
    expect(payroll(employeeId, 2026, 10)).toMatchObject({ monthlySalaryMinor: moneyFromMajor(1_500), remainingSalaryMinor: moneyFromMajor(1_500) })
  })

  it('uses the same net entitlement and remaining figures in the payroll report', () => {
    const employeeId = createEmployee({ name: 'موظف تقرير', monthlySalaryMinor: moneyFromMajor(1_500) }, env.ctx)
    recordEmployeeTransaction({ employeeId, kind: 'deduction', amountMinor: moneyFromMajor(500), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    paySalary({ employeeId, amountMinor: moneyFromMajor(300), periodYear: YEAR, periodMonth: MONTH }, env.ctx)

    const report = buildAuthorizedReport({ key: 'payroll', year: YEAR, month: MONTH }, env.ctx.session)
    expect(report.rows[0]).toMatchObject({
      الموظف: 'موظف تقرير',
      المدفوع: '300,00 د.ل',
      الخصومات: '500,00 د.ل',
      'صافي المستحق': '1.000,00 د.ل',
      المتبقي: '700,00 د.ل'
    })
  })

  it('keeps the persisted reversal/history visibility after reopening and passes integrity checks', () => {
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: moneyFromMajor(1_000) }, env.ctx)
    const payment = paySalary({ employeeId, amountMinor: moneyFromMajor(1_000), periodYear: YEAR, periodMonth: MONTH }, env.ctx)
    reverseSalaryPayment(payment.transactionId, env.ctx)
    deleteSalaryPaymentFromHistory(payment.transactionId, env.ctx)

    const databaseFile = join(env.dir, readdirSync(env.dir).find((name) => name.endsWith('.db'))!)
    closeDatabase()
    setDatabasePath(databaseFile)

    const stored = getDatabase().select().from(employeeTransactions).where(eq(employeeTransactions.id, payment.transactionId)).get()
    expect(stored?.reversedAt).toBeTruthy()
    expect(stored?.historyHiddenAt).toBeTruthy()
    expect(listSalaryPayments({ employeeId }).items).toEqual([])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
