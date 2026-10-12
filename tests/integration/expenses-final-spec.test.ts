import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import type { IpcMainInvokeEvent } from 'electron'
import { sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { issueRelease, recordDelivery } from '@main/services/production/production.service'
import {
  createEmployee,
  updateEmployee,
  paySalary,
  monthlyPayroll
} from '@main/services/hr/employees.service'
import {
  createExpense,
  updateExpense,
  deleteExpense,
  listExpenses,
  createRecurringExpense,
  listRecurringExpenses,
  updateRecurringExpense,
  changeRecurringExpenseAmount,
  deleteRecurringExpense,
  ensureRecurringExpensesThrough
} from '@main/services/finance/expenses.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { closeDatabase, getDatabase } from '@main/db/connection'
import { registerIpcRouter } from '@main/ipc/router'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => {
  env = setupTestDatabase()
})
afterEach(() => env.cleanup())

function completedOrder(priceMajor: number, recordedAt: string) {
  const customerId = createCustomer({ name: 'عميل — المواصفة النهائية' }, env.ctx)
  const quotation = createFinalInvoice(
    {
      customerId,
      lines: [
        {
          lineKind: 'custom',
          description: 'بند',
          quantityMicro: quantityFromDisplay(1),
          unitPriceMinor: moneyFromMajor(priceMajor)
        }
      ]
    },
    env.ctx
  )
  const order = approveToOrder(quotation.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(priceMajor) }, env.ctx)
  issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
  recordDelivery({ orderId: order.id, kind: 'delivery', recordedAt }, env.ctx)
}

/**
 * The combined "Fixed Expenses" figure exactly as the Expenses page
 * computes it — kind='fixed' non-salary rows for the month (manual
 * recurring occurrences) + the authoritative payroll period. This is
 * deliberately NOT monthlyProfitSummary().generalExpensesMinor, which
 * mixes fixed AND variable general costs together for the (correct,
 * unrelated) purpose of net profit — the fixed/variable split is a
 * presentation concept, read from the same underlying rows.
 */
function fixedExpensesFor(year: number, month: number): number {
  const from = `${year}-${String(month).padStart(2, '0')}-01`
  const to = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`
  const fixedManual = listExpenses({ from, to }).items
    .filter((r) => r.kind === 'fixed' && r.source !== 'salary')
    .reduce((s, r) => s + r.amountMinor, 0)
  return fixedManual + monthlyProfitSummary(year, month).payrollExpenseMinor
}

describe('Final spec — recurring fixed expenses + payroll + variable, one authoritative total', () => {
  it('Test 1 — a manual recurring expense (Rent) recurs automatically and stays editable', () => {
    const id = createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )

    for (const [from, to] of [
      ['2026-09-01', '2026-09-30'],
      ['2026-10-01', '2026-10-31'],
      ['2026-11-01', '2026-11-30']
    ]) {
      const rent = listExpenses({ from, to }).items.find((r) => r.source === 'recurring')
      expect(rent?.amountMinor).toBe(moneyFromMajor(1200))
    }
    // Sep-Nov are posted by the authoritative path, so "Delete" ends a
    // schedule that has really recurred instead of hard-deleting setup data.
    ensureRecurringExpensesThrough('2026-09-01', '2026-11-30')
    // "Edit/Delete" both actually work on a manual definition.
    updateRecurringExpense(id, { description: 'إيجار المصنع (محدّث)' }, env.ctx)
    expect(listRecurringExpenses().find((r) => r.id === id)?.description).toBe(
      'إيجار المصنع (محدّث)'
    )
    deleteRecurringExpense(id, env.ctx)
    expect(listRecurringExpenses().find((r) => r.id === id)).toMatchObject({ active: false })
    expect(listExpenses({ from: '2026-09-01', to: '2026-11-30' }).items).toHaveLength(3)
  })

  it('Test 2 — payroll shows as its own figure and is never a recurring-expense record', () => {
    const employeeId = createEmployee(
      { name: 'أحمد', monthlySalaryMinor: moneyFromMajor(7800) },
      env.ctx
    )
    paySalary(
      {
        employeeId,
        amountMinor: moneyFromMajor(7800),
        periodYear: 2026,
        periodMonth: 9,
        paidAt: '2026-09-28'
      },
      env.ctx
    )

    expect(monthlyProfitSummary(2026, 9).payrollExpenseMinor).toBe(moneyFromMajor(7800))
    // Item 2/6/16: payroll is NEVER a row in the recurring-expense list —
    // there is nothing there to edit or delete regardless of amount.
    expect(listRecurringExpenses()).toHaveLength(0)
  })

  it('Test 3 — Recurring Fixed Expenses combine Rent + Payroll into one Fixed total', () => {
    createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    const employeeId = createEmployee(
      { name: 'سالم', monthlySalaryMinor: moneyFromMajor(7800) },
      env.ctx
    )
    paySalary(
      {
        employeeId,
        amountMinor: moneyFromMajor(7800),
        periodYear: 2026,
        periodMonth: 9,
        paidAt: '2026-09-28'
      },
      env.ctx
    )

    expect(fixedExpensesFor(2026, 9)).toBe(moneyFromMajor(9000))
    // The recurring list itself holds only the manual definition — the
    // Expenses page combines the two sources only at render time.
    expect(listRecurringExpenses().map((r) => r.description)).toEqual(['إيجار المصنع'])
  })

  it('Test 4 — "New Expense" always creates VARIABLE, and it is month-specific', () => {
    const id = createExpense(
      { amountMinor: moneyFromMajor(500), description: 'إصلاح', spentAt: '2026-09-15' },
      env.ctx
    )
    const row = listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items.find((r) => r.id === id)
    expect(row?.kind).toBe('variable')
    expect(listExpenses({ from: '2026-10-01', to: '2026-10-31' }).items.some((r) => r.id === id)).toBe(
      false
    )
  })

  it('Test 5 — Total Expenses = Fixed (Rent + Payroll) + Variable', () => {
    createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    const employeeId = createEmployee(
      { name: 'وائل', monthlySalaryMinor: moneyFromMajor(7800) },
      env.ctx
    )
    paySalary(
      {
        employeeId,
        amountMinor: moneyFromMajor(7800),
        periodYear: 2026,
        periodMonth: 9,
        paidAt: '2026-09-28'
      },
      env.ctx
    )
    createExpense(
      { amountMinor: moneyFromMajor(500), description: 'إصلاح', spentAt: '2026-09-15' },
      env.ctx
    )

    const fixed = fixedExpensesFor(2026, 9)
    expect(fixed).toBe(moneyFromMajor(9000)) // 1,200 rent + 7,800 payroll
    // generalExpensesMinor mixes fixed+variable general costs together
    // (correct for net profit, which doesn't care about the split) —
    // rent (1,200) + repair (500), payroll excluded from it either way.
    const summary = monthlyProfitSummary(2026, 9)
    expect(summary.generalExpensesMinor).toBe(moneyFromMajor(1200 + 500))
    const variable = listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items
      .filter((r) => r.kind === 'variable')
      .reduce((s, r) => s + r.amountMinor, 0)
    expect(variable).toBe(moneyFromMajor(500))
    expect(fixed + variable).toBe(moneyFromMajor(9500)) // Total Expenses
  })

  it('Test 6 — profit reuses the authoritative profit service, no independent formula', () => {
    createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    const employeeId = createEmployee(
      { name: 'ليلى', monthlySalaryMinor: moneyFromMajor(7800) },
      env.ctx
    )
    paySalary(
      {
        employeeId,
        amountMinor: moneyFromMajor(7800),
        periodYear: 2026,
        periodMonth: 9,
        paidAt: '2026-09-28'
      },
      env.ctx
    )
    createExpense(
      { amountMinor: moneyFromMajor(500), description: 'إصلاح', spentAt: '2026-09-15' },
      env.ctx
    )
    completedOrder(20000, '2026-09-20T00:00:00.000Z')

    const summary = monthlyProfitSummary(2026, 9)
    expect(summary.revenueMinor).toBe(moneyFromMajor(20000))
    expect(summary.netProfitMinor).toBe(moneyFromMajor(10500))
  })

  it('Test 7 — payroll cannot be edited/deleted from Expenses; a payroll change flows through automatically', () => {
    const employeeId = createEmployee(
      { name: 'منى', monthlySalaryMinor: moneyFromMajor(7800) },
      env.ctx
    )
    paySalary(
      {
        employeeId,
        amountMinor: moneyFromMajor(7800),
        periodYear: 2026,
        periodMonth: 9,
        paidAt: '2026-09-28'
      },
      env.ctx
    )
    const salaryRow = listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items.find(
      (r) => r.source === 'salary'
    )!

    expect(() =>
      updateExpense(salaryRow.id, { amountMinor: moneyFromMajor(1) }, env.ctx)
    ).toThrowError(/الرواتب/)
    expect(() => deleteExpense(salaryRow.id, env.ctx)).not.toThrow() // allowed, but only via the payroll-reversal path
    expect(monthlyProfitSummary(2026, 9).payrollExpenseMinor).toBe(0) // the whole payment, reversed cleanly

    // A raise applied through the proper Payroll workflow, for a new period.
    updateEmployee(employeeId, { monthlySalaryMinor: moneyFromMajor(8200) }, env.ctx)
    paySalary(
      {
        employeeId,
        amountMinor: moneyFromMajor(8200),
        periodYear: 2026,
        periodMonth: 10,
        paidAt: '2026-10-28'
      },
      env.ctx
    )
    expect(monthlyProfitSummary(2026, 10).payrollExpenseMinor).toBe(moneyFromMajor(8200)) // reflected automatically
  })

  it('Test 8 — changing Rent effective October never rewrites September', () => {
    const id = createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    listExpenses({ from: '2026-09-01', to: '2026-09-30' }) // September materializes at 1200

    changeRecurringExpenseAmount(
      id,
      { amountMinor: moneyFromMajor(1500), effectiveFrom: '2026-10-01' },
      env.ctx
    )

    expect(
      listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items.find((r) => r.source === 'recurring')
        ?.amountMinor
    ).toBe(moneyFromMajor(1200))
    expect(
      listExpenses({ from: '2026-10-01', to: '2026-10-31' }).items.find((r) => r.source === 'recurring')
        ?.amountMinor
    ).toBe(moneyFromMajor(1500))
  })

  it('Test 9 — switching months and reloading repeatedly creates no new records', () => {
    const accountId = createAccount(
      { name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(20000) },
      env.ctx
    )
    createRecurringExpense(
      {
        description: 'إيجار المصنع',
        amountMinor: moneyFromMajor(1200),
        startDate: '2026-09-01',
        cashAccountId: accountId
      },
      env.ctx
    )
    const employeeId = createEmployee(
      { name: 'كريم', monthlySalaryMinor: moneyFromMajor(7800) },
      env.ctx
    )
    paySalary(
      {
        employeeId,
        amountMinor: moneyFromMajor(7800),
        periodYear: 2026,
        periodMonth: 9,
        cashAccountId: accountId,
        paidAt: '2026-09-28'
      },
      env.ctx
    )

    const countAll = (table: 'expenses' | 'employee_transactions' | 'cash_transactions') =>
      getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM ${sql.raw(table)}`)?.c ?? 0

    // Posting September's and October's rent is a command (item 8's own
    // one-time effect). The baseline is taken after it, so the loop below
    // proves repeated navigation causes no growth at all.
    ensureRecurringExpensesThrough('2026-09-01', '2026-10-31')
    const before = {
      e: countAll('expenses'),
      t: countAll('employee_transactions'),
      c: countAll('cash_transactions')
    }

    for (let i = 0; i < 6; i++) {
      listExpenses({ from: '2026-09-01', to: '2026-09-30' })
      listExpenses({ from: '2026-10-01', to: '2026-10-31' })
      listRecurringExpenses()
      monthlyPayroll(2026, 9)
      monthlyProfitSummary(2026, 9)
      closeDatabase() // simulates a "refresh" — reopen the same file
    }

    expect(countAll('expenses')).toBe(before.e)
    expect(countAll('employee_transactions')).toBe(before.t)
    expect(countAll('cash_transactions')).toBe(before.c)
    // Rent (open-ended) legitimately applies to BOTH September and
    // October, since both months were viewed above — one charge each,
    // never doubled by the repeated navigation itself.
    expect(accountBalance(accountId)).toBe(moneyFromMajor(20000 - 1200 - 1200 - 7800))
  })

  it('Test 10 — salary affects profitability exactly once, with no duplicate expense or cash effect', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash' }, env.ctx)
    const employeeId = createEmployee(
      { name: 'هدى', monthlySalaryMinor: moneyFromMajor(7800) },
      env.ctx
    )
    paySalary(
      {
        employeeId,
        amountMinor: moneyFromMajor(7800),
        periodYear: 2026,
        periodMonth: 9,
        cashAccountId: accountId,
        paidAt: '2026-09-28'
      },
      env.ctx
    )

    for (let i = 0; i < 3; i++) {
      listExpenses({ from: '2026-09-01', to: '2026-09-30' })
      monthlyProfitSummary(2026, 9)
    }

    const salaryRows =
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM expenses WHERE source = 'salary'`
      )?.c ?? 0
    const ledgerRows =
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM cash_transactions WHERE kind = 'salary'`
      )?.c ?? 0
    expect(salaryRows).toBe(1)
    expect(ledgerRows).toBe(1)
    expect(accountBalance(accountId)).toBe(-moneyFromMajor(7800)) // deducted exactly once
    const summary = monthlyProfitSummary(2026, 9)
    expect(summary.payrollExpenseMinor).toBe(moneyFromMajor(7800))
    expect(summary.generalExpensesMinor).toBe(0) // never counted a second time here
  })

  it('Test 11 — the standard "New Expense" endpoint cannot create a FIXED expense, even if asked to', async () => {
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>
    >()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((
      channel: string,
      handler: never
    ) => {
      handlers.set(channel, handler)
    }) as never)
    registerIpcRouter()
    spy.mockRestore()
    const event = { sender: { id: 555 } } as IpcMainInvokeEvent

    // A bypassing/malicious client explicitly asking for FIXED.
    const result = await handlers.get(IPC_CHANNELS.expenses.create)!(event, {
      kind: 'fixed',
      amountMinor: moneyFromMajor(999),
      description: 'محاولة إنشاء مصروف ثابت يدوي',
      spentAt: '2026-09-01',
      requestKey: 'db05-manual-fixed-bypass'
    })
    // Either rejected outright, or silently coerced — either way, no
    // manual FIXED expense is ever created through this endpoint.
    if (result.ok) {
      const created = listExpenses({ from: '2026-09-01', to: '2026-09-01' }).items.find((r) =>
        r.description.includes('محاولة')
      )
      expect(created?.kind).toBe('variable')
    }
    expect(
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM expenses WHERE kind = 'fixed' AND source = 'manual'`
      )?.c
    ).toBe(0)
  })

  it('Test 12 — everything survives a connection restart', () => {
    createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    const employeeId = createEmployee(
      { name: 'وليد', monthlySalaryMinor: moneyFromMajor(7800) },
      env.ctx
    )
    paySalary(
      {
        employeeId,
        amountMinor: moneyFromMajor(7800),
        periodYear: 2026,
        periodMonth: 9,
        paidAt: '2026-09-28'
      },
      env.ctx
    )
    createExpense(
      { amountMinor: moneyFromMajor(500), description: 'إصلاح', spentAt: '2026-09-15' },
      env.ctx
    )
    listExpenses({ from: '2026-09-01', to: '2026-09-30' }) // materializes rent

    closeDatabase()

    expect(fixedExpensesFor(2026, 9)).toBe(moneyFromMajor(9000))
    const variable = listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items
      .filter((r) => r.kind === 'variable')
      .reduce((s, r) => s + r.amountMinor, 0)
    expect(variable).toBe(moneyFromMajor(500))
    expect(monthlyProfitSummary(2026, 9).payrollExpenseMinor).toBe(moneyFromMajor(7800))
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
