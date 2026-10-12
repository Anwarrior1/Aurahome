import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P, PERMISSION_SECTIONS, allPermissionKeys } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createRole, createUser } from '@main/services/admin/users.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { login } from '@main/auth/auth.service'
import { getDatabase } from '@main/db/connection'
import { recordProfitWithdrawal, listWithdrawals } from '@main/services/finance/profit.service'
import { sql } from 'drizzle-orm'
import { orders } from '@main/db/schema/sales.schema'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 11_000

beforeEach(async () => {
  env = setupTestDatabase()
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle')
    .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})

afterEach(() => env.cleanup())

function makeUser(permissions: string[]): IpcMainInvokeEvent {
  windowId += 1
  const suffix = String(windowId)
  const roleId = createRole({ name: `role-${suffix}`, permissions }, env.ctx)
  createUser({ username: `user-${suffix}`, password: 'secret123', fullName: `User ${suffix}`, roleId }, env.ctx)
  login(`user-${suffix}`, 'secret123', windowId)
  return { sender: { id: windowId } } as IpcMainInvokeEvent
}

function seedOrder(): number {
  const customerId = createCustomer({ name: 'عميل اختبار الصلاحيات' }, env.ctx)
  return Number(getDatabase().insert(orders).values({
    documentNumber: `SO-RBAC-${windowId}`,
    customerId,
    totalMinor: 5_000_000,
    remainingMinor: 5_000_000,
    estimatedMaterialMinor: 1_000_000,
    estimatedMachineMinor: 200_000,
    estimatedWorkerMinor: 300_000,
    estimatedOtherMinor: 100_000,
    createdAt: '2026-09-13T10:00:00.000Z'
  }).run().lastInsertRowid)
}

async function invoke(channel: string, request: unknown, event: IpcMainInvokeEvent) {
  return handlers.get(channel)!(event, request)
}

describe('normalized RBAC sensitive visibility', () => {
  it('catalogs permissions by every ERP section with explicit sensitive descriptors', () => {
    const permissions = allPermissionKeys()
    expect(new Set(permissions.map((permission) => permission.section)))
      .toEqual(new Set(PERMISSION_SECTIONS.map((section) => section.key)))
    expect(permissions.find((permission) => permission.key === P.orders.viewActualProfit))
      .toMatchObject({ section: 'orders', sensitive: true, label: 'عرض الربح الفعلي' })
  })

  it('keeps order operations visible but omits all cost/profit fields without sensitive grants', async () => {
    const orderId = seedOrder()
    // Production Preparation view opens the section; the cost/profit
    // keys below remain what governs the money inside it.
    const event = makeUser([P.orders.view, P.productionPrep.view])

    const orderResult = await invoke(IPC_CHANNELS.orders.get, { id: orderId }, event)
    const planningResult = await invoke(IPC_CHANNELS.orders.planningSnapshot, { id: orderId }, event)
    const actualResult = await invoke(IPC_CHANNELS.orders.costing, { id: orderId }, event)

    expect(orderResult.ok).toBe(true)
    expect(JSON.stringify(orderResult)).not.toContain('estimatedMaterialMinor')
    expect(planningResult.ok).toBe(true)
    expect(planningResult.ok && planningResult.data).not.toHaveProperty('estimatedMaterialMinor')
    expect(planningResult.ok && planningResult.data).not.toHaveProperty('expectedProfitMinor')
    expect(actualResult.ok).toBe(true)
    expect(actualResult.ok && actualResult.data).not.toHaveProperty('summary.totalActualCostMinor')
    expect(actualResult.ok && actualResult.data).not.toHaveProperty('summary.actualProfitMinor')
  })

  it('returns estimated and actual sensitive fields independently', async () => {
    const orderId = seedOrder()
    const estimatedEvent = makeUser([
      P.orders.view,
      P.productionPrep.view,
      P.orders.viewEstimatedCost,
      P.orders.viewExpectedProfit
    ])
    const actualEvent = makeUser([P.orders.view, P.orders.viewActualCost, P.orders.viewActualProfit])

    const estimated = await invoke(IPC_CHANNELS.orders.planningSnapshot, { id: orderId }, estimatedEvent)
    const actual = await invoke(IPC_CHANNELS.orders.costing, { id: orderId }, actualEvent)

    expect(estimated.ok && estimated.data).toHaveProperty('estimatedMaterialMinor', 1_000_000)
    expect(estimated.ok && estimated.data).toHaveProperty('expectedProfitMinor')
    expect(actual.ok && actual.data).toHaveProperty('summary.totalActualCostMinor')
    expect(actual.ok && actual.data).toHaveProperty('summary.actualProfitMinor')
  })

  it('blocks dashboard directly and filters every unauthorized widget server-side', async () => {
    seedOrder()
    const blockedEvent = makeUser([P.orders.view])
    const allowedEvent = makeUser([P.dashboard.view, P.dashboard.viewOrders])
    const request = { date: '2026-09-13', year: 2026, month: 9, currentDay: false }

    const blocked = await invoke(IPC_CHANNELS.dashboard.summary, request, blockedEvent)
    const allowed = await invoke(IPC_CHANNELS.dashboard.summary, request, allowedEvent)

    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error.code).toBe('FORBIDDEN')
    expect(allowed.ok).toBe(true)
    expect(allowed.ok && allowed.data).toHaveProperty('orders')
    expect(allowed.ok && allowed.data).not.toHaveProperty('sales')
    expect(allowed.ok && allowed.data).not.toHaveProperty('costs')
    expect(allowed.ok && allowed.data).not.toHaveProperty('profits')
    expect(allowed.ok && allowed.data).not.toHaveProperty('financialAlerts')
  })

  it('requires both Dashboard profit visibility and source-screen permission for remaining profit', async () => {
    const request = { date: '2026-09-13', year: 2026, month: 9, currentDay: false }
    for (const permissions of [
      [P.dashboard.view, P.dashboard.viewProfits],
      [P.dashboard.view, P.profit.view],
      [P.dashboard.view]
    ]) {
      const response = await invoke(IPC_CHANNELS.dashboard.summary, request, makeUser(permissions))
      expect(response.ok).toBe(true)
      expect(response.ok && response.data).not.toHaveProperty('profits.remainingProfitMinor')
      if (permissions.includes(P.dashboard.viewProfits)) {
        expect(response.ok && response.data).toHaveProperty('profits.netProfitMinor')
      }
    }
    const event = makeUser([P.dashboard.view, P.dashboard.viewProfits, P.profit.view])
    const dashboard = await invoke(IPC_CHANNELS.dashboard.summary, request, event)
    const source = await invoke(IPC_CHANNELS.profit.monthly, { year: 2026, month: 9 }, event)
    expect(dashboard.ok).toBe(true)
    expect(source.ok).toBe(true)
    expect(dashboard.ok && dashboard.data).toHaveProperty(
      'profits.remainingProfitMinor',
      source.ok && (source.data as { remainingProfitMinor: number }).remainingProfitMinor
    )
  })

  it('guards withdrawal corrections through direct IPC and preserves financial data on rejection', async () => {
    const orderId = seedOrder()
    getDatabase().run(sql`UPDATE orders SET status = 'completed', completed_at = '2026-09-01T10:00:00.000Z' WHERE id = ${orderId}`)
    const { id } = recordProfitWithdrawal({ amountMinor: 2_000_000, person: 'المالك' }, env.ctx)
    const row = listWithdrawals().items.find((entry) => entry.id === id)!
    const { amountMinor, person, notes, withdrawnAt, cashAccountId, createdAt } = row
    const request = { id, expected: { amountMinor, person, notes, withdrawnAt, cashAccountId, createdAt } }
    const edit = { ...request, amountMinor: 1_500_000, person, notes }
    const unauthorized = makeUser([P.withdrawals.view])
    const anonymous = { sender: { id: -1 } } as IpcMainInvokeEvent
    for (const event of [unauthorized, anonymous]) {
      for (const [channel, payload] of [
        [IPC_CHANNELS.profit.updateWithdrawal, edit],
        [IPC_CHANNELS.profit.removeWithdrawal, request]
      ] as const) {
        const result = await invoke(channel, payload, event)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.code).toBe(event === anonymous ? 'UNAUTHENTICATED' : 'FORBIDDEN')
      }
    }
    expect(listWithdrawals().summary.totalWithdrawnMinor).toBe(2_000_000)
    const allowed = makeUser([P.withdrawals.view, P.withdrawals.manage])
    const invalid = await invoke(IPC_CHANNELS.profit.updateWithdrawal, { ...edit, amountMinor: 0.5 }, allowed)
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('VALIDATION_ERROR')
    expect((await invoke(IPC_CHANNELS.profit.updateWithdrawal, edit, allowed)).ok).toBe(true)
    expect(listWithdrawals().summary.totalWithdrawnMinor).toBe(1_500_000)
    const stale = await invoke(IPC_CHANNELS.profit.removeWithdrawal, request, allowed)
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.code).toBe('CONFLICT')
    const deletion = { ...request, expected: { ...request.expected, amountMinor: 1_500_000 } }
    expect((await invoke(IPC_CHANNELS.profit.removeWithdrawal, deletion, allowed)).ok).toBe(true)
    const repeated = await invoke(IPC_CHANNELS.profit.removeWithdrawal, deletion, allowed)
    expect(repeated.ok).toBe(false)
    if (!repeated.ok) expect(repeated.error.code).toBe('NOT_FOUND')
    expect(listWithdrawals().summary.totalWithdrawnMinor).toBe(0)
  })

  it('does not expose cost/profit reports through listing or direct build', async () => {
    const event = makeUser([P.reports.view, P.orders.view])
    const available = await invoke(IPC_CHANNELS.reports.available, {}, event)
    const direct = await invoke(IPC_CHANNELS.reports.build, { key: 'order_profitability' }, event)

    expect(available.ok).toBe(true)
    expect(available.ok && (available.data as Array<{ key: string }>).map((row) => row.key))
      .not.toContain('order_profitability')
    expect(direct.ok).toBe(false)
    if (!direct.ok) expect(direct.error.code).toBe('FORBIDDEN')
  })
})
