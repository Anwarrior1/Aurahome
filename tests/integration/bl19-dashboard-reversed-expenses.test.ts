import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { getRawConnection } from '@main/db/connection'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { createExpense, createRecurringExpense, ensureRecurringExpensesThrough } from '@main/services/finance/expenses.service'
import { createEmployee, paySalary, reverseSalaryPayment } from '@main/services/hr/employees.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import { buildReport } from '@main/services/reports/reports.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor, money, formatMoney } from '@shared/money/money'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { IPC_CHANNELS } from '@shared/constants/channels'

let env: TestEnv
const m = moneyFromMajor
const DAY = '2026-09-29'
const request = (date = DAY) => ({ date, year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), currentDay: true })
const dayCost = (date = DAY) => (dashboardSummary(request(date), env.ctx.session).costs as { dayExpensesMinor: number }).dayExpensesMinor
const report = (date = DAY) => buildReport({ key: 'expenses', from: date, to: date })
const count = (table: string) => (getRawConnection().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
const state = () => Object.fromEntries([
  'expenses', 'employee_transactions', 'cash_transactions', 'audit_log', 'financial_command_requests'
].map((table) => [table, count(table)]))

function salary(date = DAY, requestKey?: string) {
  const accountId = createAccount({ name: 'صندوق الرواتب', kind: 'cash', openingBalanceMinor: m(5000) }, env.ctx)
  const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: m(1000) }, env.ctx)
  const payment = paySalary({ employeeId, amountMinor: m(1000), periodYear: Number(date.slice(0, 4)), periodMonth: Number(date.slice(5, 7)), paidAt: date, cashAccountId: accountId, requestKey }, env.ctx)
  return { accountId, employeeId, payment }
}

beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  try {
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  } finally { env.cleanup() }
})

describe('BL-19 Dashboard active day expenses', () => {
  it('excludes a reversed salary while preserving history, cash, report and monthly profit', () => {
    const { accountId, payment } = salary()
    expect(dayCost()).toBe(m(1000))
    expect(report().totals['إجمالي المصروفات']).toBe(formatMoney(money(m(1000))))
    expect(accountBalance(accountId)).toBe(m(4000))
    expect(monthlyProfitSummary(2026, 9).netProfitMinor).toBe(-m(1000))

    reverseSalaryPayment(payment.transactionId, env.ctx)
    const historical = getRawConnection().prepare('SELECT amount_minor AS amountMinor, reversed_at AS reversedAt FROM expenses WHERE id = ?').get(payment.expenseId) as { amountMinor: number; reversedAt: string | null }
    expect(historical.amountMinor).toBe(m(1000))
    expect(historical.reversedAt).toBeTruthy()
    expect(dayCost()).toBe(0)
    expect(report().rows).toHaveLength(0)
    expect(report().totals['إجمالي المصروفات']).toBe(formatMoney(money(0)))
    expect(accountBalance(accountId)).toBe(m(5000))
    expect(monthlyProfitSummary(2026, 9).netProfitMinor).toBe(0)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM cash_transactions WHERE reversal_of_id IS NOT NULL').get()).toEqual({ c: 1 })
    expect(() => reverseSalaryPayment(payment.transactionId, env.ctx)).toThrow()

    const before = state()
    expect(dayCost()).toBe(0)
    expect(dayCost()).toBe(0)
    expect(state()).toEqual(before)
  })

  it('counts active persisted expenses but excludes reversed ones on the same day', () => {
    const { payment } = salary()
    createExpense({ amountMinor: m(400), description: 'صيانة', spentAt: DAY }, env.ctx)
    reverseSalaryPayment(payment.transactionId, env.ctx)
    expect(dayCost()).toBe(m(400))
    expect(report().totals['إجمالي المصروفات']).toBe(formatMoney(money(m(400))))
    expect(report().rows).toHaveLength(1)
  })

  it('keeps unposted recurring occurrences and counts each only once after posting', () => {
    const future = '2027-06-01'
    const { payment } = salary(future)
    createExpense({ amountMinor: m(400), description: 'صيانة', spentAt: future }, env.ctx)
    createRecurringExpense({ amountMinor: m(300), description: 'إيجار', startDate: future }, env.ctx)
    reverseSalaryPayment(payment.transactionId, env.ctx)
    const before = state()
    expect(dayCost(future)).toBe(m(700))
    expect(report(future).totals['إجمالي المصروفات']).toBe(formatMoney(money(m(700))))
    expect(state()).toEqual(before)

    ensureRecurringExpensesThrough(future, future)
    expect(dayCost(future)).toBe(m(700))
    expect(report(future).totals['إجمالي المصروفات']).toBe(formatMoney(money(m(700))))
    expect(count('expenses')).toBe(before.expenses + 1)
    ensureRecurringExpensesThrough(future, future)
    expect(count('expenses')).toBe(before.expenses + 1)
  })

  it('keeps Dashboard cost visibility under the existing IPC permissions', async () => {
    const { payment } = salary()
    reverseSalaryPayment(payment.transactionId, env.ctx)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()

    const asUser = (id: number, permissions: string[]) => {
      const roleId = createRole({ name: `BL19-${id}`, permissions }, env.ctx)
      createUser({ username: `bl19-${id}`, password: 'secret123', fullName: `BL19 ${id}`, roleId }, env.ctx)
      login(`bl19-${id}`, 'secret123', id)
      return { sender: { id } } as IpcMainInvokeEvent
    }
    const invoke = (event: IpcMainInvokeEvent) => handlers.get(IPC_CHANNELS.dashboard.summary)!(event, request())
    const viewOnly = await invoke(asUser(19001, [P.dashboard.view]))
    const costViewer = await invoke(asUser(19002, [P.dashboard.view, P.dashboard.viewCosts]))
    const blocked = await invoke(asUser(19003, [P.dashboard.viewCosts]))
    expect(viewOnly.ok).toBe(true)
    expect(viewOnly.ok && viewOnly.data).not.toHaveProperty('costs')
    expect(costViewer.ok).toBe(true)
    expect(costViewer.ok && costViewer.data).toHaveProperty('costs.dayExpensesMinor', 0)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error.code).toBe('FORBIDDEN')
  })

  it('does not weaken payroll reversal rollback or payment replay', () => {
    const { accountId, employeeId, payment } = salary(DAY, 'bl19-salary-once')
    const replay = paySalary({ employeeId, amountMinor: m(1000), periodYear: 2026, periodMonth: 9, paidAt: DAY, cashAccountId: accountId, requestKey: 'bl19-salary-once' }, env.ctx)
    expect(replay).toEqual(payment)
    expect(dayCost()).toBe(m(1000))
    const before = state()
    getRawConnection().exec("CREATE TRIGGER bl19_abort_reversal BEFORE UPDATE OF reversed_at ON expenses WHEN NEW.reversed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")
    expect(() => reverseSalaryPayment(payment.transactionId, env.ctx)).toThrow()
    expect(state()).toEqual(before)
    expect(dayCost()).toBe(m(1000))
    expect(report().rows).toHaveLength(1)
    expect(accountBalance(accountId)).toBe(m(4000))
    getRawConnection().exec('DROP TRIGGER bl19_abort_reversal')
    reverseSalaryPayment(payment.transactionId, env.ctx)
    expect(dayCost()).toBe(0)
    expect(count('expenses')).toBe(1)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM cash_transactions WHERE reversal_of_id IS NOT NULL').get()).toEqual({ c: 1 })
  })
})
