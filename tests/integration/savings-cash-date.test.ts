import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { eq, sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { closeDatabase, getDatabase, getRawConnection } from '@main/db/connection'
import { cashTransactions } from '@main/db/schema/finance.schema'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import {
  accountBalance,
  adjustAccountBalance,
  cashMovementEditability,
  createAccount,
  deleteCashMovement,
  deleteTransfer,
  getTransfer,
  listAccounts,
  listTransactions,
  transfer,
  updateCashMovement,
  updateTransfer
} from '@main/services/finance/cash.service'
import { createExpense, deleteExpense, listExpenses } from '@main/services/finance/expenses.service'
import { monthlyProfitSummary, savingsOverview, setSavingsRateBp } from '@main/services/finance/profit.service'
import { getSavingsRateBp } from '@main/services/settings.service'
import { createCustomer, listCustomers } from '@main/services/parties/parties.service'
import { createSupplier, listSuppliers } from '@main/services/parties/parties.service'
import { createCategory, createMaterial, listMaterials } from '@main/services/catalog/catalog.service'
import { createPurchase, listPurchases } from '@main/services/purchasing/purchasing.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const YEAR = 2026
const MONTH = 9
const D1 = '2026-09-01'
const D2 = '2026-09-02'
const D3 = '2026-09-03'

/* ------------------------------------------------------------------ */
/* PART 1 — الادخار                                                    */
/* ------------------------------------------------------------------ */

describe('savings (Part 1)', () => {
  it('persists the rate through app_settings and reads it straight back', () => {
    expect(getSavingsRateBp()).toBe(1000)

    setSavingsRateBp(2500, env.ctx)

    expect(getSavingsRateBp()).toBe(2500)
    expect(savingsOverview(YEAR, MONTH).savingsRateBp).toBe(2500)
    // Stored in the database, not in memory — a fresh read of the row
    // (what a restarted app does) returns the same value.
    expect(getDatabase().get<{ value: string }>(
      sql`SELECT value FROM app_settings WHERE key = 'savings.rate_bp'`
    )?.value).toBe('2500')
  })

  it('computes allocated savings as net profit × rate, in integer minor units', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(50000) }, env.ctx)
    // No completed orders, so net profit is driven by expenses alone —
    // a negative figure that must propose nothing (BR-111).
    createExpense({ kind: 'fixed', amountMinor: moneyFromMajor(1000), cashAccountId: accountId, description: 'إيجار', spentAt: D1 }, env.ctx)
    setSavingsRateBp(2000, env.ctx)

    const overview = savingsOverview(YEAR, MONTH)
    expect(overview.netProfitMinor).toBe(-moneyFromMajor(1000))
    expect(overview.allocatedMinor).toBe(0)
  })

  it('accepts 0% and the 100% upper boundary, and refuses anything outside', () => {
    expect(setSavingsRateBp(0, env.ctx)).toEqual({ savingsRateBp: 0 })
    expect(savingsOverview(YEAR, MONTH).allocatedMinor).toBe(0)

    expect(setSavingsRateBp(10000, env.ctx)).toEqual({ savingsRateBp: 10000 })
    expect(getSavingsRateBp()).toBe(10000)

    expect(() => setSavingsRateBp(10001, env.ctx)).toThrowError(/بين 0% و100%/)
    expect(() => setSavingsRateBp(-1, env.ctx)).toThrowError(/بين 0% و100%/)
    expect(() => setSavingsRateBp(12.5, env.ctx)).toThrowError(/بين 0% و100%/)
    expect(getSavingsRateBp()).toBe(10000)
  })

  it('reads the SAME net profit the profit summary reports, per period', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(50000) }, env.ctx)
    createExpense({ kind: 'variable', amountMinor: moneyFromMajor(300), cashAccountId: accountId, description: 'وقود', spentAt: '2026-08-15' }, env.ctx)
    createExpense({ kind: 'variable', amountMinor: moneyFromMajor(700), cashAccountId: accountId, description: 'كهرباء', spentAt: D1 }, env.ctx)

    for (const [year, month] of [[YEAR, 8], [YEAR, 9]] as const) {
      expect(savingsOverview(year, month).netProfitMinor)
        .toBe(monthlyProfitSummary(year, month).netProfitMinor)
    }
    // Different historical period ⇒ different figure.
    expect(savingsOverview(YEAR, 8).netProfitMinor).toBe(-moneyFromMajor(300))
    expect(savingsOverview(YEAR, 9).netProfitMinor).toBe(-moneyFromMajor(700))
  })

  it('requires savings.manage to change the rate', () => {
    const roleId = createRole({ name: 'مشاهد', permissions: [P.savings.view] }, env.ctx)
    createUser({ username: 'viewer', password: 'secret789', fullName: 'مشاهد', roleId }, env.ctx)
    const { session } = login('viewer', 'secret789', 71)

    expect(() => setSavingsRateBp(3000, { session })).toThrowError(/صلاحية/)
    expect(getSavingsRateBp()).toBe(1000)
  })
})

/* ------------------------------------------------------------------ */
/* PART 2 — cash movements                                            */
/* ------------------------------------------------------------------ */

describe('manual cash movements (Part 2)', () => {
  function manualMovement(openingMajor = 10000, amountMajor = 18000) {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(openingMajor) }, env.ctx)
    adjustAccountBalance({
      accountId,
      desiredBalanceMinor: moneyFromMajor(openingMajor + amountMajor),
      reason: 'إيداع نقدي',
      occurredAt: `${D1}T10:00:00.000Z`
    }, env.ctx)
    const id = getDatabase().get<{ id: number }>(
      sql`SELECT id FROM cash_transactions WHERE account_id = ${accountId} ORDER BY id DESC LIMIT 1`
    )!.id
    return { accountId, id }
  }

  it('marks a standalone movement editable and a generated one not', () => {
    const { id } = manualMovement()
    expect(cashMovementEditability(id)).toMatchObject({ manual: true, blockers: [] })

    const accountId = createAccount({ name: 'آخر', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    const expenseId = createExpense({ kind: 'variable', amountMinor: moneyFromMajor(100), cashAccountId: accountId, description: 'مصروف' }, env.ctx)
    const generated = getDatabase().get<{ id: number }>(
      sql`SELECT id FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = ${expenseId}`
    )!.id
    const check = cashMovementEditability(generated)
    expect(check.manual).toBe(false)
    expect(check.refTable).toBe('expenses')
    expect(check.blockers.join(' ')).toContain('صفحة المصروفات')
  })

  it('edits an incoming movement and moves the real balance by the difference', () => {
    const { accountId, id } = manualMovement(10000, 18000)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(28000))

    updateCashMovement({ id, amountMinor: moneyFromMajor(15000) }, env.ctx)

    // 18,000 corrected to 15,000 ⇒ the account drops by exactly 3,000.
    expect(accountBalance(accountId)).toBe(moneyFromMajor(25000))
    expect(getDatabase().get<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'cash.movement.update'`
    )?.c).toBe(1)
  })

  it('edits an outgoing movement, and can flip direction and account', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    const other = createAccount({ name: 'بنك', kind: 'bank', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(4000), reason: 'سحب نقدي' }, env.ctx)
    const id = getDatabase().get<{ id: number }>(sql`SELECT id FROM cash_transactions ORDER BY id DESC LIMIT 1`)!.id
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4000))

    updateCashMovement({ id, amountMinor: moneyFromMajor(400), direction: 'in', accountId: other }, env.ctx)

    expect(accountBalance(accountId)).toBe(moneyFromMajor(5000))
    expect(accountBalance(other)).toBe(moneyFromMajor(1400))
  })

  it.each([['in', 28000, 10000], ['out', 4000, 5000]] as const)(
    'deletes a manual %s movement with no reason and no typed identifier',
    (direction, beforeMajor, afterMajor) => {
      const accountId = createAccount({ name: `صندوق-${direction}`, kind: 'cash', openingBalanceMinor: moneyFromMajor(direction === 'in' ? 10000 : 5000) }, env.ctx)
      adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(beforeMajor), reason: 'حركة' }, env.ctx)
      const id = getDatabase().get<{ id: number }>(sql`SELECT id FROM cash_transactions ORDER BY id DESC LIMIT 1`)!.id
      expect(accountBalance(accountId)).toBe(moneyFromMajor(beforeMajor))

      // Only an id — there is no reason or confirmation parameter.
      deleteCashMovement(id, env.ctx)

      expect(accountBalance(accountId)).toBe(moneyFromMajor(afterMajor))
      expect(listTransactions({}).items.some((row) => row.id === id)).toBe(false)
      const details = getDatabase().get<{ details: string }>(
        sql`SELECT details FROM audit_log WHERE action = 'cash.movement.delete' ORDER BY id DESC LIMIT 1`
      )?.details
      expect(details).toContain('Manual cash movement deletion')
      expect(details).not.toContain('سبب')
    }
  )

  it('refuses to touch a generated movement, keeping its source consistent', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    const expenseId = createExpense({ kind: 'variable', amountMinor: moneyFromMajor(400), cashAccountId: accountId, description: 'مصروف' }, env.ctx)
    const generated = getDatabase().get<{ id: number }>(
      sql`SELECT id FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = ${expenseId}`
    )!.id

    expect(() => deleteCashMovement(generated, env.ctx)).toThrowError(/صفحة المصروفات/)
    expect(() => updateCashMovement({ id: generated, amountMinor: moneyFromMajor(1) }, env.ctx)).toThrowError(/صفحة المصروفات/)
    // Source and balance both untouched.
    expect(listExpenses({}).items.find((row) => row.id === expenseId)?.amountMinor).toBe(moneyFromMajor(400))
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4600))

    // Going through the authoritative source works and stays consistent.
    deleteExpense(expenseId, env.ctx)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(5000))
    expect(listTransactions({}).items.some((row) => row.id === generated)).toBe(false)
  })

  it('refuses to touch one half of a transfer pair', () => {
    const a = createAccount({ name: 'أ', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    const b = createAccount({ name: 'ب', kind: 'bank', openingBalanceMinor: 0 }, env.ctx)
    transfer({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(1000) }, env.ctx)
    const leg = getDatabase().get<{ id: number }>(sql`SELECT id FROM cash_transactions ORDER BY id DESC LIMIT 1`)!.id

    expect(() => deleteCashMovement(leg, env.ctx)).toThrowError(/تحويل بين حسابين/)
    expect(accountBalance(a)).toBe(moneyFromMajor(4000))
    expect(accountBalance(b)).toBe(moneyFromMajor(1000))
  })

  it('rolls back the whole edit if any step fails', () => {
    const { accountId, id } = manualMovement()
    getRawConnection().exec("CREATE TRIGGER test_block_cash_update BEFORE UPDATE ON cash_transactions BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")

    expect(() => updateCashMovement({ id, amountMinor: moneyFromMajor(1) }, env.ctx)).toThrow()

    expect(accountBalance(accountId)).toBe(moneyFromMajor(28000))
    expect(getDatabase().get<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'cash.movement.update'`
    )?.c).toBe(0)
  })

  it('rejects a non-positive amount and an unknown account', () => {
    const { id, accountId } = manualMovement()
    expect(() => updateCashMovement({ id, amountMinor: -1 }, env.ctx)).toThrow()
    expect(() => updateCashMovement({ id, accountId: 999999 }, env.ctx)).toThrowError(/غير موجود/)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(28000))
  })

  it('a correction and a deletion both survive a connection restart against the same database file', () => {
    const { accountId, id } = manualMovement(10000, 18000)
    updateCashMovement({ id, amountMinor: moneyFromMajor(15000) }, env.ctx)

    closeDatabase() // simulates the app closing and reopening the same erp.db

    expect(accountBalance(accountId)).toBe(moneyFromMajor(25000))
    expect(cashMovementEditability(id)).toMatchObject({ manual: true })

    deleteCashMovement(id, env.ctx)
    closeDatabase()

    expect(accountBalance(accountId)).toBe(moneyFromMajor(10000))
    expect(listTransactions({}).items.some((row) => row.id === id)).toBe(false)
  })
})

/**
 * Edit/delete on cash_transactions has no permission check of its own
 * (unlike setSavingsRateBp above) — enforcement lives entirely in the
 * IPC router's `permission: P.cash.manage` guard, so proving it holds
 * requires going through that boundary, not calling the service
 * function directly with a limited session.
 */
describe('unauthorized cash-movement edit/delete is rejected server-side (Part 2 continued)', () => {
  let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
  let windowId = 8100
  let event: IpcMainInvokeEvent

  beforeEach(async () => {
    windowId += 1
    event = { sender: { id: windowId } } as IpcMainInvokeEvent
    handlers = new Map()
    const electron = await import('electron')
    const spy = vi
      .spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
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
    const roleId = createRole({ name: `مشاهد-نقد-${Math.random()}`, permissions: [P.cash.view] }, env.ctx)
    const username = `cashviewer${Math.floor(Math.random() * 1e9)}`
    createUser({ username, password: 'secret789', fullName: 'مشاهد الحسابات النقدية', roleId }, env.ctx)
    login(username, 'secret789', windowId)
  }

  it('refuses cash:updateTransaction and cash:removeTransaction for a role without cash.manage, even with a valid payload', async () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    adjustAccountBalance({ accountId, desiredBalanceMinor: moneyFromMajor(9000), reason: 'إيداع' }, env.ctx)
    const id = getDatabase().get<{ id: number }>(sql`SELECT id FROM cash_transactions ORDER BY id DESC LIMIT 1`)!.id

    signInViewOnly()

    const updateResult = await invoke(IPC_CHANNELS.cash.updateTransaction, { id, amountMinor: moneyFromMajor(1) })
    expect(updateResult.ok).toBe(false)
    if (!updateResult.ok) expect(updateResult.error.code).toBe('FORBIDDEN')

    const removeResult = await invoke(IPC_CHANNELS.cash.removeTransaction, { id })
    expect(removeResult.ok).toBe(false)
    if (!removeResult.ok) expect(removeResult.error.code).toBe('FORBIDDEN')

    // Nothing changed under either unauthorized attempt.
    expect(accountBalance(accountId)).toBe(moneyFromMajor(9000))
    expect(listTransactions({}).items.some((row) => row.id === id)).toBe(true)
  })

  it('still allows cash:transactions (read) for view-only access', async () => {
    createAccount({ name: 'صندوق', kind: 'cash' }, env.ctx)
    signInViewOnly()
    const result = await invoke(IPC_CHANNELS.cash.transactions, {})
    expect(result.ok).toBe(true)
  })
})

/**
 * A Cash-module transfer is fully owned by this module — unlike a
 * linked module's movement, both legs may be edited/deleted, but only
 * together, as one grouped operation. A transferGroup alone is never
 * enough to lock a row; only a refTable (another module's ownership)
 * is, and that still wins even over a transferGroup.
 */
describe('Cash-module transfers are editable/deletable as one grouped operation (Part 2 — transfers)', () => {
  function twoAccounts(openingAMajor = 10000, openingBMajor = 5000) {
    const a = createAccount({ name: 'أ', kind: 'cash', openingBalanceMinor: moneyFromMajor(openingAMajor) }, env.ctx)
    const b = createAccount({ name: 'ب', kind: 'bank', openingBalanceMinor: moneyFromMajor(openingBMajor) }, env.ctx)
    return { a, b }
  }

  function findGroup(): string {
    return getDatabase().get<{ transferGroup: string }>(
      sql`SELECT transfer_group AS transferGroup FROM cash_transactions WHERE transfer_group IS NOT NULL ORDER BY id DESC LIMIT 1`
    )!.transferGroup
  }

  it('Test 1 — a standalone manual movement is unaffected by this change', () => {
    const { a } = twoAccounts()
    adjustAccountBalance({ accountId: a, desiredBalanceMinor: moneyFromMajor(12000), reason: 'إيداع' }, env.ctx)
    const id = getDatabase().get<{ id: number }>(sql`SELECT id FROM cash_transactions ORDER BY id DESC LIMIT 1`)!.id
    expect(cashMovementEditability(id)).toMatchObject({ manual: true, blockers: [] })
    updateCashMovement({ id, amountMinor: moneyFromMajor(1000) }, env.ctx)
    expect(accountBalance(a)).toBe(moneyFromMajor(11000))
  })

  it('Test 2 — a Cash-module transfer shows as editable/deletable, not "من عملية مرتبطة"', () => {
    const { a, b } = twoAccounts()
    transfer({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(2000) }, env.ctx)
    const group = findGroup()

    const legs = listTransactions({}).items.filter((row) => row.transferGroup === group)
    expect(legs).toHaveLength(2)
    for (const leg of legs) {
      expect(leg.refTable).toBeNull() // never locked as "linked to another module"
    }
    const t = getTransfer(group)
    expect(t).toMatchObject({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(2000) })
  })

  it('Test 3 — editing the amount updates BOTH legs, balances correct, no duplicate remains', () => {
    const { a, b } = twoAccounts()
    transfer({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(2000) }, env.ctx)
    const group = findGroup()
    expect(accountBalance(a)).toBe(moneyFromMajor(8000))
    expect(accountBalance(b)).toBe(moneyFromMajor(7000))

    updateTransfer({ transferGroup: group, fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(1500) }, env.ctx)

    expect(accountBalance(a)).toBe(moneyFromMajor(8500))
    expect(accountBalance(b)).toBe(moneyFromMajor(6500))
    const legs = getDatabase().select().from(cashTransactions).where(eq(cashTransactions.transferGroup, group)).all()
    expect(legs).toHaveLength(2) // still exactly two rows, never a third
    expect(legs.every((l) => l.amountMinor === moneyFromMajor(1500))).toBe(true)
    expect(getTransfer(group).amountMinor).toBe(moneyFromMajor(1500))
  })

  it('Test 4 — editing the source account fully removes the old account\'s effect', () => {
    const { a, b } = twoAccounts()
    const c = createAccount({ name: 'ج', kind: 'cash', openingBalanceMinor: moneyFromMajor(3000) }, env.ctx)
    transfer({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(2000) }, env.ctx)
    const group = findGroup()
    expect(accountBalance(a)).toBe(moneyFromMajor(8000))
    expect(accountBalance(b)).toBe(moneyFromMajor(7000))

    updateTransfer({ transferGroup: group, fromAccountId: c, toAccountId: b, amountMinor: moneyFromMajor(2000) }, env.ctx)

    expect(accountBalance(a)).toBe(moneyFromMajor(10000)) // fully restored — no trace of the old leg
    expect(accountBalance(c)).toBe(moneyFromMajor(1000))
    expect(accountBalance(b)).toBe(moneyFromMajor(7000)) // unaffected — it was never removed
    expect(getTransfer(group)).toMatchObject({ fromAccountId: c, toAccountId: b })
  })

  it('Test 5 — deleting a transfer removes both legs together and restores both balances exactly once', () => {
    const { a, b } = twoAccounts()
    transfer({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(2000) }, env.ctx)
    const group = findGroup()

    deleteTransfer(group, env.ctx)

    expect(accountBalance(a)).toBe(moneyFromMajor(10000))
    expect(accountBalance(b)).toBe(moneyFromMajor(5000))
    expect(listTransactions({}).items.some((row) => row.transferGroup === group)).toBe(false)
    expect(() => getTransfer(group)).toThrow()
  })

  it('Test 6 — a forced failure during the update rolls back BOTH legs, the original transfer remains intact', () => {
    const { a, b } = twoAccounts()
    transfer({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(2000) }, env.ctx)
    const group = findGroup()
    getRawConnection().exec("CREATE TRIGGER test_block_transfer_update BEFORE UPDATE ON cash_transactions BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")

    expect(() => updateTransfer({ transferGroup: group, fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(1) }, env.ctx)).toThrow()

    expect(accountBalance(a)).toBe(moneyFromMajor(8000))
    expect(accountBalance(b)).toBe(moneyFromMajor(7000))
    expect(getTransfer(group).amountMinor).toBe(moneyFromMajor(2000))
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'cash.transfer.update'`)?.c).toBe(0)
  })

  it('Test 7 — a movement generated by another module stays locked, transferGroup or not', () => {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    const expenseId = createExpense({ amountMinor: moneyFromMajor(400), cashAccountId: accountId, description: 'مصروف' }, env.ctx)
    const generated = getDatabase().get<{ id: number }>(
      sql`SELECT id FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = ${expenseId}`
    )!.id

    expect(() => updateCashMovement({ id: generated, amountMinor: moneyFromMajor(1) }, env.ctx)).toThrowError(/صفحة المصروفات/)
    expect(() => deleteCashMovement(generated, env.ctx)).toThrowError(/صفحة المصروفات/)
    // Not reachable as a "transfer" either — it never had a transferGroup.
    expect(cashMovementEditability(generated).manual).toBe(false)
    expect(accountBalance(accountId)).toBe(moneyFromMajor(4600))
  })

  it('Test 8 — a direct single-leg update/delete attempt is rejected; only the grouped path works', () => {
    const { a, b } = twoAccounts()
    transfer({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(2000) }, env.ctx)
    const group = findGroup()
    const outLeg = getDatabase().get<{ id: number }>(sql`SELECT id FROM cash_transactions WHERE transfer_group = ${group} AND direction = 'out'`)!.id

    expect(() => updateCashMovement({ id: outLeg, amountMinor: moneyFromMajor(1) }, env.ctx))
      .toThrowError(/تحويل بين حسابين/)
    expect(() => deleteCashMovement(outLeg, env.ctx))
      .toThrowError(/تحويل بين حسابين/)
    // Both balances remain exactly as the original transfer left them.
    expect(accountBalance(a)).toBe(moneyFromMajor(8000))
    expect(accountBalance(b)).toBe(moneyFromMajor(7000))

    // The grouped path works correctly for the very same transfer.
    updateTransfer({ transferGroup: group, fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(500) }, env.ctx)
    expect(accountBalance(a)).toBe(moneyFromMajor(9500))
    expect(accountBalance(b)).toBe(moneyFromMajor(5500))
  })

  it('Test 9 — unauthorized users cannot edit/delete a transfer via direct IPC', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>()
    const windowId = 8500
    const event = { sender: { id: windowId } } as IpcMainInvokeEvent
    const electron = await import('electron')
    const spy = vi
      .spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    async function invoke(channel: string, request: unknown): Promise<IpcResult<unknown>> {
      return handlers.get(channel)!(event, request)
    }

    const { a, b } = twoAccounts()
    transfer({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(2000) }, env.ctx)
    const group = findGroup()

    const roleId = createRole({ name: `مشاهد-تحويل-${Math.random()}`, permissions: [P.cash.view] }, env.ctx)
    const username = `transferviewer${Math.floor(Math.random() * 1e9)}`
    createUser({ username, password: 'secret789', fullName: 'مشاهد', roleId }, env.ctx)
    login(username, 'secret789', windowId)

    const updateResult = await invoke(IPC_CHANNELS.cash.updateTransfer, { transferGroup: group, fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(1) })
    expect(updateResult.ok).toBe(false)
    if (!updateResult.ok) expect(updateResult.error.code).toBe('FORBIDDEN')
    const removeResult = await invoke(IPC_CHANNELS.cash.removeTransfer, { transferGroup: group })
    expect(removeResult.ok).toBe(false)
    if (!removeResult.ok) expect(removeResult.error.code).toBe('FORBIDDEN')

    expect(accountBalance(a)).toBe(moneyFromMajor(8000))
    expect(accountBalance(b)).toBe(moneyFromMajor(7000))
  })

  it('Test 10 — the edited transfer, balances, group relationship and audit state survive a connection restart', () => {
    const { a, b } = twoAccounts()
    transfer({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(2000) }, env.ctx)
    const group = findGroup()
    updateTransfer({ transferGroup: group, fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(1500) }, env.ctx)

    closeDatabase() // simulates the app closing and reopening the same erp.db

    expect(accountBalance(a)).toBe(moneyFromMajor(8500))
    expect(accountBalance(b)).toBe(moneyFromMajor(6500))
    expect(getTransfer(group)).toMatchObject({ fromAccountId: a, toAccountId: b, amountMinor: moneyFromMajor(1500) })
    const legs = getDatabase().select().from(cashTransactions).where(eq(cashTransactions.transferGroup, group)).all()
    expect(legs).toHaveLength(2)
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'cash.transfer.update'`)?.c).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/* PART 3 — global operational date                                    */
/* ------------------------------------------------------------------ */

describe('global operational date (Part 3)', () => {
  function threeDaysOfActivity() {
    const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(10000) }, env.ctx)
    const categoryId = createCategory({ name: 'خشب' }, env.ctx)
    const materialId = createMaterial(
      { sku: 'MDF-DATE', name: 'MDF', categoryId, unit: 'لوح', currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact' } as never,
      env.ctx
    )
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)

    createPurchase({ supplierId, purchaseDate: D1, lines: [{ materialId, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(100) }] }, env.ctx)
    createExpense({ kind: 'variable', amountMinor: moneyFromMajor(100), cashAccountId: accountId, description: 'يوم ١', spentAt: D1 }, env.ctx)
    createExpense({ kind: 'fixed', amountMinor: moneyFromMajor(250), cashAccountId: accountId, description: 'يوم ٢', spentAt: D2 }, env.ctx)
    createExpense({ kind: 'variable', amountMinor: moneyFromMajor(40), cashAccountId: accountId, description: 'يوم ٣', spentAt: D3 }, env.ctx)
    return { accountId, materialId, supplierId }
  }

  it('returns a different set of transactions for each selected day', () => {
    threeDaysOfActivity()

    expect(listExpenses({ from: D1, to: D1 }).items.map((row) => row.description)).toEqual(['يوم ١'])
    expect(listExpenses({ from: D2, to: D2 }).items.map((row) => row.description)).toEqual(['يوم ٢'])
    expect(listExpenses({ from: D3, to: D3 }).items.map((row) => row.description)).toEqual(['يوم ٣'])
    expect(listExpenses({}).items.length).toBe(3)

    expect(listPurchases({ from: D1, to: D1 }).items.length).toBe(1)
    expect(listPurchases({ from: D2, to: D2 }).items.length).toBe(0)
  })

  it.each([
    ['fixed 23:30Z instant', new Date(`${D2}T23:30:00.000Z`)],
    ['local midday', new Date(2026, 8, 2, 12)],
    ['just before local midnight', new Date(new Date(2026, 8, 3).getTime() - 1)],
    ['exact local midnight', new Date(2026, 8, 3)],
    ['just after local midnight', new Date(new Date(2026, 8, 3).getTime() + 1)]
  ])('lists cash movements ON their factory-local day: %s', (_label, instant) => {
    const { accountId } = threeDaysOfActivity()
    const occurredAt = instant.toISOString()
    // Independent calendar oracle: no production date helper or SQL predicate.
    // 23:30Z need not cross midnight in the process's startup timezone.
    const localDate = [instant.getFullYear(), String(instant.getMonth() + 1).padStart(2, '0'),
      String(instant.getDate()).padStart(2, '0')].join('-')
    expect(adjustAccountBalance({ accountId, desiredBalanceMinor: accountBalance(accountId) + moneyFromMajor(50), reason: 'تسوية', occurredAt }, env.ctx))
      .toEqual({ adjustmentMinor: moneyFromMajor(50), newBalanceMinor: moneyFromMajor(9660) })

    const movements = listTransactions({ accountId }).items
    const adjustment = movements.find((row) => row.kind === 'balance_adjustment')!
    expect(adjustment).toMatchObject({ accountId, amountMinor: moneyFromMajor(50), direction: 'in',
      occurredAt, refTable: null, refId: null, createdBy: env.ctx.session.user.id })
    expect(movements).toHaveLength(4)
    const raw = getRawConnection()
    const audits = raw.prepare("SELECT * FROM audit_log WHERE action = 'cash.account.adjustBalance'").all()
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ entity: 'cash_accounts', entity_id: String(accountId), user_id: env.ctx.session.user.id })

    for (const day of [D1, D2, D3]) {
      const expected = movements.filter((row) => (row.id === adjustment.id ? localDate : row.occurredAt) === day)
      const actual = listTransactions({ accountId, from: day, to: day }).items
      expect(actual.map((row) => row.id)).toEqual(expected.map((row) => row.id))
      expect(actual.reduce((sum, row) => sum + (row.direction === 'in' ? row.amountMinor : -row.amountMinor), 0))
        .toBe(expected.reduce((sum, row) => sum + (row.direction === 'in' ? row.amountMinor : -row.amountMinor), 0))
    }
    expect(accountBalance(accountId)).toBe(moneyFromMajor(9660))
    expect(savingsOverview(YEAR, MONTH)).toMatchObject({ netProfitMinor: -moneyFromMajor(390), allocatedMinor: 0, fundBalanceMinor: 0 })
    expect(listTransactions({ accountId }).items).toEqual(movements)
    expect(raw.prepare("SELECT * FROM audit_log WHERE action = 'cash.account.adjustBalance'").all()).toEqual(audits)
  })

  it('reports the balance AS OF a day — opening plus everything up to it, not that day alone', () => {
    const { accountId } = threeDaysOfActivity()

    // Opening 10,000; −100 on D1, −250 on D2, −40 on D3.
    expect(accountBalance(accountId, D1)).toBe(moneyFromMajor(9900))
    expect(accountBalance(accountId, D2)).toBe(moneyFromMajor(9650))
    expect(accountBalance(accountId, D3)).toBe(moneyFromMajor(9610))
    expect(accountBalance(accountId)).toBe(moneyFromMajor(9610))
    // Explicitly NOT the sum of that one day's movements.
    expect(accountBalance(accountId, D2)).not.toBe(-moneyFromMajor(250))
    // Before any activity, the balance is the opening balance.
    expect(accountBalance(accountId, '2026-08-31')).toBe(moneyFromMajor(10000))
  })

  it('exposes the as-of balance through listAccounts alongside the live one', () => {
    const { accountId } = threeDaysOfActivity()
    const asOf = listAccounts({ asOf: D1 }).find((a) => a.id === accountId)!
    expect(asOf.balanceMinor).toBe(moneyFromMajor(9900))
    expect(asOf.currentBalanceMinor).toBe(moneyFromMajor(9610))
    expect(listAccounts().find((a) => a.id === accountId)!.balanceMinor).toBe(moneyFromMajor(9610))
  })

  it('changes net profit and the savings allocation with the selected period', () => {
    threeDaysOfActivity()
    createExpense({ kind: 'variable', amountMinor: moneyFromMajor(500), description: 'شهر سابق', spentAt: '2026-08-10' }, env.ctx)
    setSavingsRateBp(2000, env.ctx)

    expect(monthlyProfitSummary(YEAR, 8).netProfitMinor).toBe(-moneyFromMajor(500))
    expect(monthlyProfitSummary(YEAR, 9).netProfitMinor).toBe(-moneyFromMajor(390))
    expect(savingsOverview(YEAR, 8).netProfitMinor).not.toBe(savingsOverview(YEAR, 9).netProfitMinor)
  })

  it('never date-filters master data — it stays visible on every day', () => {
    const { materialId, supplierId } = threeDaysOfActivity()
    createCustomer({ name: 'عميل' }, env.ctx)

    // The same master rows are returned regardless of any date scope,
    // because these list functions take no date filter at all.
    expect(listMaterials({}).some((row) => row.id === materialId)).toBe(true)
    expect(listSuppliers({}).some((row) => row.id === supplierId)).toBe(true)
    expect(listCustomers({}).items.length).toBe(1)
    expect(listAccounts({ asOf: '2026-08-31' }).length).toBe(listAccounts().length)
  })

  it('browsing a historical date never mutates a record', () => {
    const { accountId } = threeDaysOfActivity()
    const raw = getRawConnection()
    const before = raw.prepare('SELECT id, amount_minor AS amount, occurred_at AS at FROM cash_transactions ORDER BY id').all()
    const expensesBefore = raw.prepare('SELECT id, spent_at AS at, amount_minor AS amount FROM expenses ORDER BY id').all()

    // Every read a date change triggers, run for three different days.
    for (const day of [D1, D2, D3]) {
      listExpenses({ from: day, to: day })
      listPurchases({ from: day, to: day })
      listTransactions({ from: day, to: `${day}T23:59:59.999Z` })
      listAccounts({ asOf: day })
      accountBalance(accountId, day)
      monthlyProfitSummary(Number(day.slice(0, 4)), Number(day.slice(5, 7)))
      savingsOverview(Number(day.slice(0, 4)), Number(day.slice(5, 7)))
    }

    expect(raw.prepare('SELECT id, amount_minor AS amount, occurred_at AS at FROM cash_transactions ORDER BY id').all()).toEqual(before)
    expect(raw.prepare('SELECT id, spent_at AS at, amount_minor AS amount FROM expenses ORDER BY id').all()).toEqual(expensesBefore)
  })
})
