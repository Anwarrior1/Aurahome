import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import {
  createAccount,
  accountBalance,
  updateAccount,
  adjustAccountBalance,
  listTransactions,
  listAccounts
} from '@main/services/finance/cash.service'
import { getDatabase } from '@main/db/connection'
import { auditLog } from '@main/db/schema/audit.schema'
import { desc, eq } from 'drizzle-orm'
import { moneyFromMajor } from '@shared/money/money'

/**
 * Incremental-modification request, items 8/9: the opening balance may
 * only be edited while an account has zero transactions, and any
 * balance correction after that must go through adjustAccountBalance,
 * which posts one new auditable cash_transactions row for the delta —
 * it never rewrites the computed balance or any historical row.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

describe('Opening balance edit guard (item 8)', () => {
  it('allows editing the opening balance while the account has no transactions', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)

    updateAccount(accountId, { openingBalanceMinor: moneyFromMajor(2000) }, env.ctx)

    expect(accountBalance(accountId)).toBe(moneyFromMajor(2000))
  })

  it('blocks editing the opening balance once the account has any transaction, with a clear Arabic message', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(1500), reason: 'تسوية أولية' }, env.ctx)

    expect(() =>
      updateAccount(accountId, { openingBalanceMinor: moneyFromMajor(9999) }, env.ctx)
    ).toThrowError(/الرصيد الافتتاحي/)

    // The previous, legitimate history is untouched by the rejected attempt.
    expect(accountBalance(accountId)).toBe(moneyFromMajor(1500))
  })

  it('still allows editing the account name/kind even when the opening balance is locked', () => {
    const accountId = createAccount({ name: 'صندوق قديم', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(1200), reason: 'تسوية' }, env.ctx)

    updateAccount(accountId, { name: 'صندوق محدث' }, env.ctx)

    expect(listAccounts().find((a) => a.id === accountId)?.name).toBe('صندوق محدث')
  })
})

describe('adjustAccountBalance (item 9)', () => {
  it('increasing the balance posts a positive-difference "in" transaction, never overwriting the balance directly', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)

    const result = adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(5500), reason: 'جرد نقدي' }, env.ctx)

    expect(result.adjustmentMinor).toBe(moneyFromMajor(500))
    expect(accountBalance(accountId)).toBe(moneyFromMajor(5500))

    const [latest] = listTransactions({ accountId, limit: 1 }).items
    expect(latest?.kind).toBe('balance_adjustment')
    expect(latest?.direction).toBe('in')
    expect(latest?.amountMinor).toBe(moneyFromMajor(500))
    expect(latest?.notes).toBe('جرد نقدي')
  })

  it('decreasing the balance posts a negative-difference "out" transaction', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)

    const result = adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(4700), reason: 'عجز مكتشف بالجرد' }, env.ctx)

    expect(result.adjustmentMinor).toBe(moneyFromMajor(-300))
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4700))

    const [latest] = listTransactions({ accountId, limit: 1 }).items
    expect(latest?.kind).toBe('balance_adjustment')
    expect(latest?.direction).toBe('out')
    expect(latest?.amountMinor).toBe(moneyFromMajor(300))
  })

  it('never rewrites a previous transaction — prior history rows remain exactly as posted', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(1200), reason: 'تسوية أولى' }, env.ctx)
    const firstBatch = listTransactions({ accountId }).items

    adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(1000), reason: 'تسوية ثانية' }, env.ctx)
    const secondBatch = listTransactions({ accountId }).items

    // The first adjustment row is still present, unmodified, plus one new row.
    expect(secondBatch).toHaveLength(firstBatch.length + 1)
    const preserved = secondBatch.find((t) => t.id === firstBatch[0]!.id)
    expect(preserved?.amountMinor).toBe(firstBatch[0]!.amountMinor)
    expect(preserved?.notes).toBe('تسوية أولى')
  })

  it('rejects a no-op adjustment where the desired balance already matches the current balance', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    expect(() =>
      adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(1000), reason: 'لا تغيير' }, env.ctx)
    ).toThrowError()
  })

  it('requires a non-empty reason', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    expect(() =>
      adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(1200), reason: '' }, env.ctx)
    ).toThrowError(/سبب/)
  })

  it('records an auditable event carrying the previous balance, desired balance, and the user who made it', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)

    adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(1300), reason: 'فحص دوري' }, env.ctx)

    const [event] = getDatabase()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'cash.account.adjustBalance'))
      .orderBy(desc(auditLog.id))
      .limit(1)
      .all()
    expect(event).toBeTruthy()
    expect(event!.userId).toBe(env.ctx.session.user.id)
    const details = JSON.parse(event!.details as string)
    expect(details.previousBalanceMinor).toBe(moneyFromMajor(1000))
    expect(details.desiredBalanceMinor).toBe(moneyFromMajor(1300))
    expect(details.adjustmentMinor).toBe(moneyFromMajor(300))
  })
})
