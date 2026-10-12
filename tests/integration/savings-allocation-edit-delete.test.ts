import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { closeDatabase, getDatabase, getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { issueRelease, recordDelivery } from '@main/services/production/production.service'
import {
  confirmSavingsAllocation,
  monthlyProfitSummary,
  recordSavingsUsage,
  savingsBalanceMinor,
  savingsHistory,
  setSavingsRateBp,
  updateSavingsAllocation,
  deleteSavingsAllocation
} from '@main/services/finance/profit.service'
import { createAccount } from '@main/services/finance/cash.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { registerIpcRouter } from '@main/ipc/router'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

/** A revenue-only order, completed on `recordedAt`, with zero material/
 *  machine/worker/delivery cost — gives a clean, predictable Net Profit
 *  equal to the selling price for the month it completes in. */
function completedOrder(priceMajor: number, recordedAt: string) {
  const customerId = createCustomer({ name: 'عميل — اختبار الادخار' }, env.ctx)
  const quotation = createFinalInvoice({
    customerId,
    lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(priceMajor) }]
  }, env.ctx)
  const order = approveToOrder(quotation.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(priceMajor) }, env.ctx)
  issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
  recordDelivery({ orderId: order.id, kind: 'delivery', recordedAt }, env.ctx)
}

/** Net Profit = 5,000, rate = 10% ⇒ a confirmed allocation of 500,
 *  exactly the brief's own worked example. */
function confirmedAllocation(rateBp = 1000, priceMajor = 5000) {
  completedOrder(priceMajor, '2026-09-20T00:00:00.000Z')
  setSavingsRateBp(rateBp, env.ctx)
  const { amountMinor } = confirmSavingsAllocation({ year: 2026, month: 9 }, env.ctx)
  const id = getDatabase().get<{ id: number }>(sql`SELECT id FROM savings_allocations ORDER BY id DESC LIMIT 1`)!.id
  return { id, amountMinor }
}

describe('Editing/deleting an approved savings allocation', () => {
  it('Test 3 — editing the rate recalculates the amount from the SAME net profit, via the authoritative formula', () => {
    const { id } = confirmedAllocation(1000, 5000) // 10% of 5,000 = 500
    expect(monthlyProfitSummary(2026, 9).netProfitMinor).toBe(moneyFromMajor(5000))

    const result = updateSavingsAllocation(id, { rateBp: 1500 }, env.ctx) // 15% of 5,000 = 750

    expect(result.amountMinor).toBe(moneyFromMajor(750))
    const allocation = savingsHistory().allocations.find((a) => a.id === id)!
    expect(allocation.rateBp).toBe(1500)
    expect(allocation.amountMinor).toBe(moneyFromMajor(750)) // never disagrees with the rate
    expect(allocation.netProfitMinor).toBe(moneyFromMajor(5000)) // frozen, untouched
    expect(allocation.periodYear).toBe(2026)
    expect(allocation.periodMonth).toBe(9)
    // The paired ledger row moves with it — the fund balance reflects
    // the NEW amount, not the old one.
    expect(savingsBalanceMinor()).toBe(moneyFromMajor(750))
  })

  it('Test 4 — delete shows nothing until confirmed at the service boundary, then removes it safely', () => {
    const { id, amountMinor } = confirmedAllocation()
    expect(savingsBalanceMinor()).toBe(amountMinor)

    deleteSavingsAllocation(id, env.ctx)

    expect(savingsHistory().allocations.some((a) => a.id === id)).toBe(false)
    // The period can be re-confirmed — allocationConfirmed correctly
    // flips back since the row is genuinely gone, not just hidden.
    expect(monthlyProfitSummary(2026, 9).allocationConfirmed).toBe(false)
  })

  it('Test 5 — the savings total no longer includes a removed allocation, no stale amount remains', () => {
    const { id, amountMinor } = confirmedAllocation(1000, 5000)
    expect(savingsBalanceMinor()).toBe(amountMinor)

    deleteSavingsAllocation(id, env.ctx)

    expect(savingsBalanceMinor()).toBe(0)
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM savings_transactions WHERE allocation_id = ${id}`)?.c).toBe(0)
  })

  it('Test 6 — editing/deleting one month never touches another month\'s allocation', () => {
    const septemberOrderPrice = 5000
    completedOrder(septemberOrderPrice, '2026-09-20T00:00:00.000Z')
    setSavingsRateBp(1000, env.ctx)
    confirmSavingsAllocation({ year: 2026, month: 9 }, env.ctx)
    const septemberId = getDatabase().get<{ id: number }>(sql`SELECT id FROM savings_allocations WHERE period_month = 9 ORDER BY id DESC LIMIT 1`)!.id

    completedOrder(8000, '2026-10-20T00:00:00.000Z')
    confirmSavingsAllocation({ year: 2026, month: 10 }, env.ctx)
    const octoberId = getDatabase().get<{ id: number }>(sql`SELECT id FROM savings_allocations WHERE period_month = 10 ORDER BY id DESC LIMIT 1`)!.id
    const octoberBefore = savingsHistory().allocations.find((a) => a.id === octoberId)!

    updateSavingsAllocation(septemberId, { rateBp: 2000 }, env.ctx)

    const octoberAfter = savingsHistory().allocations.find((a) => a.id === octoberId)!
    expect(octoberAfter).toEqual(octoberBefore) // completely unaffected

    deleteSavingsAllocation(septemberId, env.ctx)
    expect(savingsHistory().allocations.some((a) => a.id === octoberId)).toBe(true) // still there
    expect(monthlyProfitSummary(2026, 10).allocationConfirmed).toBe(true) // untouched
  })

  it('refuses to shrink or delete an allocation whose fund money has already been used (item 6/8)', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash' }, env.ctx)
    const { id } = confirmedAllocation(1000, 5000) // allocation = 500
    recordSavingsUsage({ amountMinor: moneyFromMajor(300), cashAccountId: accountId }, env.ctx) // 300 already drawn

    expect(() => updateSavingsAllocation(id, { rateBp: 0 }, env.ctx)).toThrowError(/تم استخدامه بالفعل/)
    expect(() => deleteSavingsAllocation(id, env.ctx)).toThrowError(/تم استخدامه بالفعل/)
    // Raising the rate (never reduces available funds) still works fine.
    updateSavingsAllocation(id, { rateBp: 2000 }, env.ctx) // 20% of 5,000 = 1,000
    expect(savingsBalanceMinor()).toBe(moneyFromMajor(1000 - 300))
  })

  it('a forced failure during the update rolls back both the allocation and its ledger row together', () => {
    const { id } = confirmedAllocation(1000, 5000)
    getRawConnection().exec("CREATE TRIGGER test_block_allocation_update BEFORE UPDATE ON savings_allocations BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")

    expect(() => updateSavingsAllocation(id, { rateBp: 2000 }, env.ctx)).toThrow()

    const allocation = savingsHistory().allocations.find((a) => a.id === id)!
    expect(allocation.rateBp).toBe(1000)
    expect(allocation.amountMinor).toBe(moneyFromMajor(500))
    expect(savingsBalanceMinor()).toBe(moneyFromMajor(500))
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'savings.allocation.update'`)?.c).toBe(0)
  })

  it('Test 7 — the edited allocation, fund balance and audit trail survive a connection restart', () => {
    const { id } = confirmedAllocation(1000, 5000)
    updateSavingsAllocation(id, { rateBp: 1500 }, env.ctx)

    closeDatabase() // simulates the app closing and reopening the same erp.db

    const allocation = savingsHistory().allocations.find((a) => a.id === id)!
    expect(allocation.rateBp).toBe(1500)
    expect(allocation.amountMinor).toBe(moneyFromMajor(750))
    expect(savingsBalanceMinor()).toBe(moneyFromMajor(750))
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'savings.allocation.update'`)?.c).toBe(1)
  })

  it('Test 9 — regression: rate/profit/confirm/history all keep working exactly as before', () => {
    completedOrder(5000, '2026-09-20T00:00:00.000Z')
    setSavingsRateBp(1000, env.ctx)
    const summary = monthlyProfitSummary(2026, 9)
    expect(summary.netProfitMinor).toBe(moneyFromMajor(5000))
    expect(summary.savingsProposedMinor).toBe(moneyFromMajor(500))

    const { amountMinor, rateBp } = confirmSavingsAllocation({ year: 2026, month: 9 }, env.ctx)
    expect(amountMinor).toBe(moneyFromMajor(500))
    expect(rateBp).toBe(1000)
    expect(() => confirmSavingsAllocation({ year: 2026, month: 9 }, env.ctx)).toThrowError(/بالفعل/)
    expect(savingsHistory().allocations).toHaveLength(1)
    expect(savingsHistory().balanceMinor).toBe(moneyFromMajor(500))
  })
})

describe('Test 8 — unauthorized allocation edit/delete is rejected server-side', () => {
  let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
  let windowId = 8700
  let event: IpcMainInvokeEvent

  beforeEach(async () => {
    windowId += 1
    event = { sender: { id: windowId } } as IpcMainInvokeEvent
    handlers = new Map()
    const electron = await import('electron')
    const spy = vi
      .spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    registerIpcRouter()
    spy.mockRestore()
  })

  async function invoke(channel: string, request: unknown): Promise<IpcResult<unknown>> {
    return handlers.get(channel)!(event, request)
  }

  it('refuses profit:updateAllocation and profit:removeAllocation for a role without savings.manage', async () => {
    completedOrder(5000, '2026-09-20T00:00:00.000Z')
    setSavingsRateBp(1000, env.ctx)
    confirmSavingsAllocation({ year: 2026, month: 9 }, env.ctx)
    const id = getDatabase().get<{ id: number }>(sql`SELECT id FROM savings_allocations ORDER BY id DESC LIMIT 1`)!.id

    const roleId = createRole({ name: `مشاهد-ادخار-${Math.random()}`, permissions: [P.savings.view] }, env.ctx)
    const username = `savingsviewer${Math.floor(Math.random() * 1e9)}`
    createUser({ username, password: 'secret789', fullName: 'مشاهد', roleId }, env.ctx)
    login(username, 'secret789', windowId)

    const updateResult = await invoke(IPC_CHANNELS.profit.updateAllocation, { id, rateBp: 2000 })
    expect(updateResult.ok).toBe(false)
    if (!updateResult.ok) expect(updateResult.error.code).toBe('FORBIDDEN')
    const removeResult = await invoke(IPC_CHANNELS.profit.removeAllocation, { id })
    expect(removeResult.ok).toBe(false)
    if (!removeResult.ok) expect(removeResult.error.code).toBe('FORBIDDEN')

    expect(savingsHistory().allocations.find((a) => a.id === id)?.rateBp).toBe(1000)
  })
})
