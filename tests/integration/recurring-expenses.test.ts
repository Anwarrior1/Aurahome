import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import type { IpcMainInvokeEvent } from 'electron'
import { eq, and, sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { issueRelease, recordDelivery } from '@main/services/production/production.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import { buildReport } from '@main/services/reports/reports.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import {
  createExpense,
  updateExpense,
  listExpenses,
  createRecurringExpense,
  listRecurringExpenses,
  getRecurringExpense,
  updateRecurringExpense,
  changeRecurringExpenseAmount,
  deleteRecurringExpense,
  ensureRecurringExpensesThrough,
  materializeDueRecurringExpenses
} from '@main/services/finance/expenses.service'
import { closeDatabase, getDatabase, getRawConnection } from '@main/db/connection'
import { expenses } from '@main/db/schema/finance.schema'
import { cashTransactions } from '@main/db/schema/finance.schema'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => {
  // These September-due scenarios must not depend on the host's current month.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T12:00:00.000Z'))
  env = setupTestDatabase()
})
afterEach(() => { env.cleanup(); vi.useRealTimers() })

/** A revenue-only order, completed on `recordedAt`, with zero material/
 *  machine/worker/delivery cost — isolates general expenses in the
 *  monthly profit formula (Test 3). */
function completedOrder(priceMajor: number, recordedAt: string) {
  const customerId = createCustomer({ name: 'عميل — اختبار المصروفات' }, env.ctx)
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
  return order
}

describe('Fixed/recurring expenses — no re-entry, no double counting', () => {
  it('Test 1 — Rent=1200 starting September appears once in September, October and November without re-entry', () => {
    createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )

    for (const [from, to] of [
      ['2026-09-01', '2026-09-30'],
      ['2026-10-01', '2026-10-31'],
      ['2026-11-01', '2026-11-30']
    ]) {
      const rows = listExpenses({ from, to }).items
      const rent = rows.filter((r) => r.source === 'recurring' && r.description === 'إيجار المصنع')
      expect(rent).toHaveLength(1) // never more than once per month
      expect(rent[0]?.amountMinor).toBe(moneyFromMajor(1200))
      expect(rent[0]?.kind).toBe('fixed')
    }
    // No re-entry happened anywhere above — only reads.
  })

  it('Test 2 — a variable expense stays in its own date only', () => {
    createExpense(
      {
        kind: 'variable',
        amountMinor: moneyFromMajor(800),
        description: 'إصلاح كهرباء',
        spentAt: '2026-09-15'
      },
      env.ctx
    )

    const september = listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items
    const october = listExpenses({ from: '2026-10-01', to: '2026-10-31' }).items
    expect(
      september.some(
        (r) => r.description === 'إصلاح كهرباء' && r.amountMinor === moneyFromMajor(800)
      )
    ).toBe(true)
    expect(october.some((r) => r.description === 'إصلاح كهرباء')).toBe(false)
  })

  it('Test 3 — September profit = revenue − rent − repair, using the one authoritative profit calculation', () => {
    createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    createExpense(
      {
        kind: 'variable',
        amountMinor: moneyFromMajor(800),
        description: 'إصلاح كهرباء',
        spentAt: '2026-09-15'
      },
      env.ctx
    )
    completedOrder(20000, '2026-09-20T00:00:00.000Z')

    const summary = monthlyProfitSummary(2026, 9)
    expect(summary.revenueMinor).toBe(moneyFromMajor(20000))
    expect(summary.generalExpensesMinor).toBe(moneyFromMajor(2000)) // 1200 + 800
    expect(summary.netProfitMinor).toBe(moneyFromMajor(18000))
  })

  it('Test 4 — repeatedly navigating between September and October creates no new transactions and totals stay stable', () => {
    const accountId = createAccount(
      { name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) },
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

    // Both months are posted once, by the authoritative path.
    ensureRecurringExpensesThrough('2026-09-01', '2026-10-31')
    for (let i = 0; i < 5; i++) {
      listExpenses({ from: '2026-09-01', to: '2026-09-30' })
      listExpenses({ from: '2026-10-01', to: '2026-10-31' })
    }

    const countByMonth = (period: string) =>
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM expenses WHERE source = 'recurring' AND spent_at = ${period}`
      )?.c ?? 0
    expect(countByMonth('2026-09-01')).toBe(1)
    expect(countByMonth('2026-10-01')).toBe(1)
    // Two months' rent deducted, never more, regardless of how many times the pages were opened.
    expect(accountBalance(accountId)).toBe(moneyFromMajor(5000 - 1200 - 1200))
  })

  it('Test 5 — survives a connection restart against the same database file', () => {
    createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    materializeDueRecurringExpenses() // September is due; posting is a command, not a read

    closeDatabase() // simulates the app closing and reopening the same erp.db

    const rows = listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items
    expect(rows.filter((r) => r.source === 'recurring')).toHaveLength(1)
    expect(rows.find((r) => r.source === 'recurring')?.amountMinor).toBe(moneyFromMajor(1200))
  })

  it('Test 6 — changing the amount effective October never rewrites September, in either materialization order', () => {
    const id = createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )

    // Order A: materialize September FIRST, then raise the rate for October.
    materializeDueRecurringExpenses()
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

    // Order B: a second recurring expense where the amount changes BEFORE
    // the earlier month is ever materialized — the resolved amount must
    // still be the one that was actually in effect for that month, not
    // "whatever the template says now".
    const id2 = createRecurringExpense(
      { description: 'صيانة المعدات', amountMinor: moneyFromMajor(300), startDate: '2026-09-01' },
      env.ctx
    )
    changeRecurringExpenseAmount(
      id2,
      { amountMinor: moneyFromMajor(450), effectiveFrom: '2026-10-01' },
      env.ctx
    )
    const sep = listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items.find(
      (r) => r.description === 'صيانة المعدات'
    )
    const oct = listExpenses({ from: '2026-10-01', to: '2026-10-31' }).items.find(
      (r) => r.description === 'صيانة المعدات'
    )
    expect(sep?.amountMinor).toBe(moneyFromMajor(300))
    expect(oct?.amountMinor).toBe(moneyFromMajor(450))
  })

  it('Test 7 — ending a recurring expense stops it from the correct month onward, without touching what already happened', () => {
    const id = createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    materializeDueRecurringExpenses() // September is posted while still active
    updateRecurringExpense(id, { endDate: '2026-10-01' }, env.ctx) // last applicable month is October

    const sep = listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items
    const oct = listExpenses({ from: '2026-10-01', to: '2026-10-31' }).items
    const nov = listExpenses({ from: '2026-11-01', to: '2026-11-30' }).items
    expect(sep.some((r) => r.source === 'recurring')).toBe(true) // untouched history
    expect(oct.some((r) => r.source === 'recurring')).toBe(true) // still within the end date
    expect(nov.some((r) => r.source === 'recurring')).toBe(false) // stopped

    const stopped = listRecurringExpenses().find((r) => r.id === id)
    expect(stopped?.endDate).toBe('2026-10-01')
  })

  it('never materializes a month before the recurring expense actually started (item 18)', () => {
    createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    const august = listExpenses({ from: '2026-08-01', to: '2026-08-31' }).items
    expect(august.some((r) => r.source === 'recurring')).toBe(false)
  })

  it('Test 8 — the cash ledger shows exactly one active movement per recurring expense per month, never a duplicate', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash' }, env.ctx)
    const id = createRecurringExpense(
      {
        description: 'إيجار المصنع',
        amountMinor: moneyFromMajor(1200),
        startDate: '2026-09-01',
        cashAccountId: accountId
      },
      env.ctx
    )
    ensureRecurringExpensesThrough('2026-09-01', '2026-10-31')
    // Open the same two months repeatedly, as a user switching back and forth would.
    for (let i = 0; i < 4; i++) {
      listExpenses({ from: '2026-09-01', to: '2026-09-30' })
      listExpenses({ from: '2026-10-01', to: '2026-10-31' })
    }

    const expenseRows = getDatabase()
      .select()
      .from(expenses)
      .where(and(eq(expenses.source, 'recurring'), eq(expenses.sourceRefId, id)))
      .all()
    expect(expenseRows).toHaveLength(2) // September + October, never more

    for (const row of expenseRows) {
      const ledgerRows = getDatabase()
        .select()
        .from(cashTransactions)
        .where(and(eq(cashTransactions.refTable, 'expenses'), eq(cashTransactions.refId, row.id)))
        .all()
      expect(ledgerRows).toHaveLength(1)
      expect(ledgerRows[0]?.accountId).toBe(accountId)
      expect(ledgerRows[0]?.direction).toBe('out')
    }
    expect(accountBalance(accountId)).toBe(-moneyFromMajor(2400)) // exactly two months, never doubled
  })

  it('Test 9 — the dashboard/profit report and the raw expenses report agree on the exact same monthly total', () => {
    createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    createRecurringExpense(
      {
        description: 'الرواتب الثابتة',
        amountMinor: moneyFromMajor(3000),
        startDate: '2026-09-01'
      },
      env.ctx
    )
    createExpense(
      {
        kind: 'variable',
        amountMinor: moneyFromMajor(800),
        description: 'إصلاحات',
        spentAt: '2026-09-15'
      },
      env.ctx
    )
    completedOrder(20000, '2026-09-20T00:00:00.000Z')

    const summary = monthlyProfitSummary(2026, 9)
    expect(summary.generalExpensesMinor).toBe(moneyFromMajor(5000)) // 1200+3000+800
    expect(summary.netProfitMinor).toBe(moneyFromMajor(15000))

    // The 'monthly_profit' report is the SAME function, not a second one.
    const monthlyReport = buildReport({ key: 'monthly_profit', year: 2026, month: 9 })
    const netRow = monthlyReport.rows.find((r) => r['البند'] === 'صافي الربح')
    expect(netRow?.['القيمة']).toContain('15.000,00')

    // The raw expenses report sums the exact same underlying rows.
    const expensesReport = buildReport({ key: 'expenses', from: '2026-09-01', to: '2026-09-30' })
    expect(expensesReport.totals?.['إجمالي المصروفات']).toContain('5.000,00')
    expect(expensesReport.rows).toHaveLength(3) // rent + salaries + repair, no more
  })

  it('a forced mid-transaction failure during materialization rolls back the expense, ledger and balance together', () => {
    const accountId = createAccount(
      { name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) },
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
    getRawConnection().exec(
      "CREATE TRIGGER test_block_expense_insert BEFORE INSERT ON cash_transactions BEGIN SELECT RAISE(ABORT, 'forced rollback'); END"
    )

    // The posting path swallows nothing — the underlying insert failure
    // propagates so the caller (and the test) can see it.
    expect(() => materializeDueRecurringExpenses()).toThrow()

    expect(
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM expenses WHERE source = 'recurring'`
      )?.c
    ).toBe(0)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(1000)) // untouched
  })

  it('deactivates a materialized definition while preserving posted history', () => {
    const id = createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    materializeDueRecurringExpenses()
    deleteRecurringExpense(id, env.ctx)
    expect(getRecurringExpense(id).template).toMatchObject({ active: false })
    expect(listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items).toHaveLength(1)
  })

  it('a materialized occurrence cannot be edited or deleted directly from the Expenses screen — only through the definition', () => {
    createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    materializeDueRecurringExpenses() // a posted row is what the screen can act on
    const row = listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items.find(
      (r) => r.source === 'recurring'
    )!

    expect(() =>
      updateExpense(row.id, { amountMinor: moneyFromMajor(9999) }, env.ctx)
    ).toThrowError(/المصروف الثابت نفسه/)
  })
})

describe('Test 10 — recurring-expense endpoints are rejected server-side without the finance permission', () => {
  let handlers: Map<
    string,
    (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>
  >
  let windowId = 9000
  let event: IpcMainInvokeEvent

  beforeEach(async () => {
    windowId += 1
    event = { sender: { id: windowId } } as IpcMainInvokeEvent
    handlers = new Map()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((
      channel: string,
      handler: never
    ) => {
      handlers.set(channel, handler)
    }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
  })

  async function invoke(channel: string, request: unknown): Promise<IpcResult<unknown>> {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler registered for ${channel}`)
    return handler(event, request)
  }

  function signInViewOnly(): void {
    const roleId = createRole(
      { name: `مشاهد-${Math.random()}`, permissions: [P.expenses.view] },
      env.ctx
    )
    const username = `viewer${Math.floor(Math.random() * 1e9)}`
    createUser({ username, password: 'secret789', fullName: 'مستخدم مشاهدة فقط', roleId }, env.ctx)
    login(username, 'secret789', windowId)
  }

  it('refuses expenses:createRecurring for a role without expenses.manage, even with a valid payload', async () => {
    signInViewOnly()
    const result = await invoke(IPC_CHANNELS.expenses.createRecurring, {
      description: 'إيجار المصنع',
      amountMinor: moneyFromMajor(1200),
      startDate: '2026-09-01',
      requestKey: 'db05-recurring-forbidden'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    expect(listRecurringExpenses()).toHaveLength(0)
  })

  it('refuses amount changes and full reversal without permission, preserving posted effects', async () => {
    const accountId = createAccount(
      { name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(50000) },
      env.ctx
    )
    const id = createRecurringExpense(
      {
        description: 'إيجار المصنع',
        amountMinor: moneyFromMajor(16000),
        startDate: '2026-09-01',
        cashAccountId: accountId
      },
      env.ctx
    )
    materializeDueRecurringExpenses()
    signInViewOnly()
    const before = {
      expenses: getDatabase().select().from(expenses).all(),
      cash: getDatabase().select().from(cashTransactions).all()
    }
    const changeResult = await invoke(IPC_CHANNELS.expenses.changeRecurringAmount, {
      id,
      amountMinor: moneyFromMajor(9999),
      effectiveFrom: '2026-10-01'
    })
    expect(changeResult.ok).toBe(false)
    const removeResult = await invoke(IPC_CHANNELS.expenses.removeRecurring, { id })
    expect(removeResult.ok).toBe(false)
    if (!removeResult.ok) expect(removeResult.error.code).toBe('FORBIDDEN')
    expect(getRecurringExpense(id).template.active).toBe(true)
    expect(getDatabase().select().from(expenses).all()).toEqual(before.expenses)
    expect(getDatabase().select().from(cashTransactions).all()).toEqual(before.cash)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(34000))
    const anonymous = handlers.get(IPC_CHANNELS.expenses.removeRecurring)!
    const unauthenticated = await anonymous({ sender: { id: -1 } } as IpcMainInvokeEvent, { id })
    expect(unauthenticated.ok).toBe(false)
    if (!unauthenticated.ok) expect(unauthenticated.error.code).toBe('UNAUTHENTICATED')
    expect(accountBalance(accountId)).toBe(moneyFromMajor(34000))
  })

  it('allows an authorized full reversal through IPC and rejects a repeated request without another reversal', async () => {
    const accountId = createAccount(
      { name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(50000) },
      env.ctx
    )
    const id = createRecurringExpense(
      {
        description: 'إيجار المصنع',
        amountMinor: moneyFromMajor(16000),
        startDate: '2026-09-01',
        cashAccountId: accountId
      },
      env.ctx
    )
    materializeDueRecurringExpenses()
    login('owner', 'secret123', windowId)
    expect((await invoke(IPC_CHANNELS.expenses.removeRecurring, { id })).ok).toBe(true)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(34000))
    const repeated = await invoke(IPC_CHANNELS.expenses.removeRecurring, { id })
    expect(repeated).toMatchObject({ ok: true, data: { deleted: false, deactivated: true } })
    expect(accountBalance(accountId)).toBe(moneyFromMajor(34000))
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })

  it('still allows expenses:listRecurring for view-only access (read is not the protected action)', async () => {
    createRecurringExpense(
      { description: 'إيجار المصنع', amountMinor: moneyFromMajor(1200), startDate: '2026-09-01' },
      env.ctx
    )
    signInViewOnly()
    const result = await invoke(IPC_CHANNELS.expenses.listRecurring, {})
    expect(result.ok).toBe(true)
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
