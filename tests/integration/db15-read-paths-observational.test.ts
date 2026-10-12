import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { traceQueries } from '../helpers/query-counter'
import {
  changeRecurringExpenseAmount,
  createExpense,
  createRecurringExpense,
  ensureRecurringExpensesThrough,
  expenseSummary,
  listExpenses,
  materializeDueRecurringExpenses,
  updateRecurringExpense
} from '@main/services/finance/expenses.service'
import { createAccount, accountBalance, listAccounts } from '@main/services/finance/cash.service'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { cumulativeNetProfitMinor, monthlyProfitSummary } from '@main/services/finance/profit.service'
import { buildReport } from '@main/services/reports/reports.service'
import { moneyFromMajor } from '@shared/money/money'

/**
 * DB-15: browsing is observation. A list, report, dashboard or profit
 * figure derives the months a schedule implies but nobody has posted yet;
 * posting them is a command (startup, or an explicit range), never the
 * side effect of opening a screen.
 */
let env: TestEnv
beforeEach(() => {
  // The posting assertions are for September 2026, regardless of host date.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-16T12:00:00.000Z'))
  env = setupTestDatabase()
})
afterEach(() => { env.cleanup(); vi.useRealTimers() })

const THIS_MONTH = '2026-09-01'
const FUTURE_MONTH = '2027-06-01'

function persistentState() {
  const db = getDatabase()
  const count = (table: string) =>
    Number(db.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM ${sql.raw(table)}`)?.c ?? 0)
  return {
    expenses: count('expenses'),
    cash: count('cash_transactions'),
    audit: count('audit_log'),
    recurringAmounts: count('recurring_expense_amounts'),
    balances: listAccounts().map((account) => account.currentBalanceMinor)
  }
}

function rentSchedule(accountId?: number, startDate = '2026-01-01'): number {
  return createRecurringExpense(
    {
      description: 'إيجار المصنع',
      amountMinor: moneyFromMajor(1200),
      startDate,
      cashAccountId: accountId ?? null
    },
    env.ctx
  )
}

/** Every nominally read-only path, with the range each one is asked about. */
const READ_PATHS: Array<[string, () => unknown]> = [
  ['expenses list (this month)', () => listExpenses({ from: THIS_MONTH, to: '2026-09-30' })],
  ['expenses list (unfiltered)', () => listExpenses({})],
  ['expenses summary (future month)', () => expenseSummary({ from: FUTURE_MONTH, to: '2027-06-30' })],
  ['dashboard', () => dashboardSummary({ date: '2026-09-16', year: 2026, month: 9, currentDay: true }, env.ctx.session)],
  ['monthly profit (this month)', () => monthlyProfitSummary(2026, 9)],
  ['monthly profit (future month)', () => monthlyProfitSummary(2027, 12)],
  ['cumulative profit', () => cumulativeNetProfitMinor()],
  ['expenses report (past range)', () => buildReport({ key: 'expenses', from: '2026-01-01', to: '2026-09-30' })],
  ['expenses report (future range)', () => buildReport({ key: 'expenses', from: '2028-01-01', to: '2028-12-31' })],
  ['expenses report (unbounded)', () => buildReport({ key: 'expenses' })]
]

describe('DB-15 — read paths never write', () => {
  it.each(READ_PATHS)('%s writes nothing, and repeating it stays observational', (_name, run) => {
    const accountId = createAccount(
      { name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(100000) },
      env.ctx
    )
    rentSchedule(accountId)

    const before = persistentState()
    const first = traceQueries(run)
    const afterFirst = persistentState()
    expect(afterFirst).toEqual(before)

    // A second identical read is byte-for-byte the same work and the same state.
    const second = traceQueries(run)
    expect(persistentState()).toEqual(before)
    expect(second.count).toBe(first.count)
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result))
  })

  it('a whole browsing session over past and future months leaves the ledger untouched', () => {
    const accountId = createAccount(
      { name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(100000) },
      env.ctx
    )
    rentSchedule(accountId)
    const before = persistentState()

    for (let round = 0; round < 3; round += 1) {
      for (const [, run] of READ_PATHS) run()
    }

    expect(persistentState()).toEqual(before)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(100000))
    expect(
      Number(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM expenses WHERE source = 'recurring'`)?.c)
    ).toBe(0)
  })

  it('reading a future month never posts a future-dated expense or cash movement', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(50000) }, env.ctx)
    rentSchedule(accountId)

    expenseSummary({ from: FUTURE_MONTH, to: '2027-06-30' })
    monthlyProfitSummary(2027, 6)
    buildReport({ key: 'expenses', from: '2027-01-01', to: '2028-12-31' })

    const future = getDatabase().get<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM expenses WHERE spent_at > date('now')`
    )?.c
    expect(Number(future)).toBe(0)
    // The live balance is what the account actually holds, never reduced by
    // a month that has not happened.
    expect(accountBalance(accountId)).toBe(moneyFromMajor(50000))
  })
})

describe('DB-15 — derived figures equal posted figures', () => {
  it('every read returns the same numbers before and after the schedule is posted', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(100000) }, env.ctx)
    rentSchedule(accountId)
    createExpense(
      { kind: 'variable', amountMinor: moneyFromMajor(800), description: 'إصلاح', spentAt: '2026-09-15' },
      env.ctx
    )

    // A derived occurrence carries a synthetic id until it is posted, and it
    // is deliberately NOT money out of the account yet — the cash ledger only
    // ever holds real posted movements. Every reported expense/profit figure
    // must already be final.
    const financials = (value: unknown) =>
      JSON.stringify(value, (key, entry) =>
        key === 'id' || key === 'cashBalanceMinor' ? undefined : entry
      )

    const derived = READ_PATHS.map(([, run]) => financials(run()))
    // Posting the due months must not move a single figure anywhere. Months
    // still in the future stay derived in both runs, exactly as an unfiltered
    // history view is capped at today.
    materializeDueRecurringExpenses()
    const posted = READ_PATHS.map(([, run]) => financials(run()))

    READ_PATHS.forEach(([name], index) => {
      expect(posted[index], `${name} changed when the schedule was posted`).toBe(derived[index])
    })
  })

  it('cash leaves the account only when the occurrence is actually posted', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(100000) }, env.ctx)
    rentSchedule(accountId, THIS_MONTH)

    // Reported as this month's fixed expense while still derived...
    expect(expenseSummary({ from: THIS_MONTH, to: '2026-09-30' }).fixedNonSalaryMinor).toBe(moneyFromMajor(1200))
    // ...but no money has moved and no ledger row exists yet.
    expect(accountBalance(accountId)).toBe(moneyFromMajor(100000))
    expect(
      Number(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM cash_transactions`)?.c)
    ).toBe(0)

    materializeDueRecurringExpenses()
    expect(accountBalance(accountId)).toBe(moneyFromMajor(100000 - 1200))
    expect(
      Number(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM cash_transactions`)?.c)
    ).toBe(1)
  })

  it('the expenses report, the expenses screen and monthly profit agree on the same month', () => {
    rentSchedule(undefined, THIS_MONTH)
    createExpense(
      { kind: 'variable', amountMinor: moneyFromMajor(800), description: 'إصلاح كهرباء', spentAt: '2026-09-15' },
      env.ctx
    )
    const expected = moneyFromMajor(2000)

    expect(expenseSummary({ from: THIS_MONTH, to: '2026-09-30' })).toMatchObject({
      fixedNonSalaryMinor: moneyFromMajor(1200),
      variableMinor: moneyFromMajor(800)
    })
    expect(monthlyProfitSummary(2026, 9).generalExpensesMinor).toBe(expected)
    const report = buildReport({ key: 'expenses', from: THIS_MONTH, to: '2026-09-30' })
    expect(report.rows).toHaveLength(2)
    expect(
      report.rows.reduce((sum, row) => sum + Number(row['المبلغ'].replace(/[^\d]/g, '')), 0)
    ).toBe(2_000_00) // 2.000,00 formatted
  })

  it('a filtered list counts a derived occurrence exactly as it counts a posted one', () => {
    rentSchedule(undefined, THIS_MONTH)
    const filters = [
      { from: THIS_MONTH, to: '2026-09-30' },
      { from: THIS_MONTH, to: '2026-09-30', kind: 'fixed' as const },
      { from: THIS_MONTH, to: '2026-09-30', kind: 'variable' as const },
      { from: THIS_MONTH, to: '2026-09-30', search: 'إيجار' },
      { from: THIS_MONTH, to: '2026-09-30', search: 'لا-يوجد' },
      { from: THIS_MONTH, to: '2026-09-30', linkedOnly: true },
      // A day range that excludes the 1st must exclude the occurrence too.
      { from: '2026-09-15', to: '2026-09-30' }
    ]
    const derived = filters.map((filter) => JSON.stringify(expenseSummary(filter)))
    ensureRecurringExpensesThrough(THIS_MONTH, '2026-09-30')
    filters.forEach((filter, index) => {
      expect(JSON.stringify(expenseSummary(filter)), JSON.stringify(filter)).toBe(derived[index])
    })
  })
})

describe('DB-15 — posting stays correct and happens exactly once', () => {
  it('posts each due month once, and a second run adds nothing', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(100000) }, env.ctx)
    rentSchedule(accountId, '2026-07-01')

    const first = materializeDueRecurringExpenses()
    expect(first.created).toBe(3) // July, August, September — today is in September
    const afterFirst = persistentState()

    expect(materializeDueRecurringExpenses()).toEqual({ created: 0 })
    expect(persistentState()).toEqual(afterFirst)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(100000 - 3 * 1200))
    expect(
      getDatabase().all<{ spentAt: string }>(
        sql`SELECT spent_at AS spentAt FROM expenses WHERE source = 'recurring' ORDER BY spent_at`
      ).map((row) => row.spentAt)
    ).toEqual(['2026-07-01', '2026-08-01', '2026-09-01'])
  })

  it('stops at the current month — a due run never posts a future month', () => {
    rentSchedule(undefined, '2026-01-01')
    materializeDueRecurringExpenses()
    const posted = getDatabase().get<{ m: string }>(
      sql`SELECT MAX(spent_at) AS m FROM expenses WHERE source = 'recurring'`
    )?.m
    expect(posted).toBe(THIS_MONTH)
  })

  it('never posts a month before the schedule started', () => {
    rentSchedule(undefined, THIS_MONTH)
    materializeDueRecurringExpenses()
    expect(
      getDatabase().get<{ m: string }>(sql`SELECT MIN(spent_at) AS m FROM expenses WHERE source = 'recurring'`)?.m
    ).toBe(THIS_MONTH)
    expect(expenseSummary({ from: '2026-08-01', to: '2026-08-31' }).totalCount).toBe(0)
  })

  it('an inactive or end-dated schedule neither posts nor shows a later month', () => {
    const ended = rentSchedule(undefined, '2026-08-01')
    updateRecurringExpense(ended, { endDate: '2026-08-01' }, env.ctx)
    const deactivated = createRecurringExpense(
      { description: 'اشتراك', amountMinor: moneyFromMajor(300), startDate: '2026-08-01' },
      env.ctx
    )
    updateRecurringExpense(deactivated, { active: false }, env.ctx)

    materializeDueRecurringExpenses()
    const rows = getDatabase().all<{ spentAt: string; description: string }>(
      sql`SELECT spent_at AS spentAt, description FROM expenses WHERE source = 'recurring' ORDER BY spent_at`
    )
    expect(rows).toEqual([{ spentAt: '2026-08-01', description: 'إيجار المصنع' }])
    // September is past the end date for one and deactivated for the other.
    expect(expenseSummary({ from: THIS_MONTH, to: '2026-09-30' }).totalCount).toBe(0)
    expect(listExpenses({ from: THIS_MONTH, to: '2026-09-30' }).items).toHaveLength(0)
  })

  it('a rate change keeps each month on the amount that was in effect for it', () => {
    const id = rentSchedule(undefined, '2026-08-01')
    changeRecurringExpenseAmount(
      id,
      { amountMinor: moneyFromMajor(1500), effectiveFrom: THIS_MONTH },
      env.ctx
    )
    // Derived first — the future month already resolves to the new rate.
    expect(expenseSummary({ from: '2026-08-01', to: '2026-08-31' }).fixedNonSalaryMinor).toBe(moneyFromMajor(1200))
    expect(expenseSummary({ from: THIS_MONTH, to: '2026-09-30' }).fixedNonSalaryMinor).toBe(moneyFromMajor(1500))
    expect(expenseSummary({ from: '2026-10-01', to: '2026-10-31' }).fixedNonSalaryMinor).toBe(moneyFromMajor(1500))

    // Posting must freeze exactly those amounts, in either order.
    materializeDueRecurringExpenses()
    expect(
      getDatabase().all<{ spentAt: string; amountMinor: number }>(
        sql`SELECT spent_at AS spentAt, amount_minor AS amountMinor FROM expenses WHERE source = 'recurring' ORDER BY spent_at`
      )
    ).toEqual([
      { spentAt: '2026-08-01', amountMinor: moneyFromMajor(1200) },
      { spentAt: THIS_MONTH, amountMinor: moneyFromMajor(1500) }
    ])
  })

  it('a failure while posting rolls back the expense, its cash movement and the balance together', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    rentSchedule(accountId, THIS_MONTH)
    getRawConnection().exec(
      "CREATE TRIGGER db15_block_cash BEFORE INSERT ON cash_transactions BEGIN SELECT RAISE(ABORT, 'forced rollback'); END"
    )

    expect(() => materializeDueRecurringExpenses()).toThrow(/forced rollback/)

    expect(
      Number(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM expenses WHERE source = 'recurring'`)?.c)
    ).toBe(0)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(1000))
    // The read paths still answer, from the schedule alone.
    expect(expenseSummary({ from: THIS_MONTH, to: '2026-09-30' }).fixedNonSalaryMinor).toBe(moneyFromMajor(1200))
  })

  it('startup posts what came due while the app was closed', async () => {
    rentSchedule(undefined, '2026-07-01')
    const { openVerifiedDatabase } = await import('@main/app/database-startup')
    // Same sequence bootstrap runs; the database is already open and current.
    openVerifiedDatabase()
    expect(
      getDatabase().all<{ spentAt: string }>(
        sql`SELECT spent_at AS spentAt FROM expenses WHERE source = 'recurring' ORDER BY spent_at`
      ).map((row) => row.spentAt)
    ).toEqual(['2026-07-01', '2026-08-01', THIS_MONTH])
  })
})
