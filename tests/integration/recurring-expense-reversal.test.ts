import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { auditLog } from '@main/db/schema/audit.schema'
import { cashTransactions, expenses, recurringExpenseAmounts, recurringExpenses } from '@main/db/schema/finance.schema'
import { accountBalance, createAccount } from '@main/services/finance/cash.service'
import { createRecurringExpense, deleteRecurringExpense, ensureRecurringExpensesThrough, listExpenses } from '@main/services/finance/expenses.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import { moneyFromMajor } from '@shared/money/money'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function create(accountId?: number): number {
  return createRecurringExpense({
    description: 'إيجار DB11', amountMinor: moneyFromMajor(16_000),
    cashAccountId: accountId, startDate: '2026-09-01'
  }, env.ctx)
}

function generated(id: number) {
  return getDatabase().select().from(expenses)
    .where(and(eq(expenses.source, 'recurring'), eq(expenses.sourceRefId, id))).all()
}

function snapshot() {
  return {
    definitions: getDatabase().select().from(recurringExpenses).all(),
    amounts: getDatabase().select().from(recurringExpenseAmounts).all(),
    expenses: getDatabase().select().from(expenses).all(),
    cash: getDatabase().select().from(cashTransactions).all(),
    audit: getDatabase().select().from(auditLog).all()
  }
}

function integrity(): void {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
}

describe('DB-11 — recurring expense removal', () => {
  it('hard-deletes a never-generated schedule and its derived amount setup', () => {
    const id = create()
    expect(deleteRecurringExpense(id, env.ctx)).toEqual({ deleted: true, deactivated: false })
    expect(getDatabase().select().from(recurringExpenses).where(eq(recurringExpenses.id, id)).get()).toBeUndefined()
    expect(getDatabase().select().from(recurringExpenseAmounts).all()).toEqual([])
    integrity()
  })

  it('ends a schedule with posted occurrences without erasing expense, cash or report history', () => {
    const accountId = createAccount({ name: 'صندوق DB11', kind: 'cash', openingBalanceMinor: moneyFromMajor(50_000) }, env.ctx)
    const id = create(accountId)
    ensureRecurringExpensesThrough('2026-09-01', '2026-09-30')
    const before = snapshot()
    const balanceBefore = accountBalance(accountId)
    const profitBefore = monthlyProfitSummary(2026, 9)

    expect(deleteRecurringExpense(id, env.ctx)).toEqual({ deleted: false, deactivated: true })

    expect(generated(id)).toEqual(before.expenses.filter((row) => row.source === 'recurring' && row.sourceRefId === id))
    expect(getDatabase().select().from(cashTransactions).all()).toEqual(before.cash)
    expect(accountBalance(accountId)).toBe(balanceBefore)
    expect(monthlyProfitSummary(2026, 9)).toEqual(profitBefore)
    expect(listExpenses({ from: '2026-09-01', to: '2026-09-30' }).items).toHaveLength(1)
    expect(getDatabase().select().from(recurringExpenses).where(eq(recurringExpenses.id, id)).get()).toMatchObject({ active: false })
    expect(getDatabase().select().from(auditLog).where(and(eq(auditLog.action, 'expenses.recurring.deactivate'), eq(auditLog.entityId, String(id)))).all()).toHaveLength(1)
    integrity()
  })

  it('does not regenerate future occurrences after deactivation and remains idempotent', () => {
    const id = create()
    ensureRecurringExpensesThrough('2026-09-01', '2026-09-30')
    deleteRecurringExpense(id, env.ctx)
    ensureRecurringExpensesThrough('2026-10-01', '2030-12-31')
    expect(generated(id)).toHaveLength(1)
    expect(deleteRecurringExpense(id, env.ctx)).toEqual({ deleted: false, deactivated: true })
    expect(getDatabase().select().from(auditLog).where(and(eq(auditLog.action, 'expenses.recurring.deactivate'), eq(auditLog.entityId, String(id)))).all()).toHaveLength(1)
    integrity()
  })

  it('rolls back deactivation if its audit write fails', () => {
    const accountId = createAccount({ name: 'صندوق فشل DB11', kind: 'cash', openingBalanceMinor: moneyFromMajor(50_000) }, env.ctx)
    const id = create(accountId)
    ensureRecurringExpensesThrough('2026-09-01', '2026-09-30')
    const before = snapshot()
    getRawConnection().exec(`CREATE TRIGGER db11_fail_recurring_audit BEFORE INSERT ON audit_log
      WHEN NEW.action = 'expenses.recurring.deactivate'
      BEGIN SELECT RAISE(ABORT, 'db11 audit failure'); END`)

    expect(() => deleteRecurringExpense(id, env.ctx)).toThrow(/db11 audit failure/)
    expect(snapshot()).toEqual(before)
    integrity()
  })
})
