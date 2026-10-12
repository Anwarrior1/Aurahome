import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { approveToOrder } from '../helpers/sales-flow'
import type { IpcResult } from '@shared/types/ipc.types'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { createQuotation } from '@main/services/sales/quotations.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

/**
 * Part F: the deletion permissions are enforced in MAIN, at the IPC
 * boundary, not by the renderer hiding a Trash icon. A window whose
 * role lacks the key must be refused even when it calls the channel
 * directly with a perfectly valid payload.
 *
 * The same handlers double as the check that no delete flow in this
 * pass still demands a reason: none of these payloads carries one, and
 * none is rejected for its absence.
 */
let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>

// A fresh webContents id per test: sessions are keyed by it and live
// in a module-level store that outlives the throwaway database.
let windowId = 4242
let event: IpcMainInvokeEvent

beforeEach(async () => {
  windowId += 1
  event = { sender: { id: windowId } } as IpcMainInvokeEvent
  env = setupTestDatabase()
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi
    .spyOn(electron.ipcMain, 'handle')
    .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})
afterEach(() => env.cleanup())

async function invoke(channel: string, request: unknown): Promise<IpcResult<unknown>> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler(event, request)
}

/** Logs in a role holding exactly `permissions` on the test window. */
function signInWith(permissions: string[]): void {
  const roleId = createRole({ name: `دور-${permissions.length}-${Math.random()}`, permissions }, env.ctx)
  const username = `user${Math.floor(Math.random() * 1e9)}`
  createUser({ username, password: 'secret789', fullName: 'مستخدم محدود', roleId }, env.ctx)
  login(username, 'secret789', windowId)
}

describe('deletion channels enforce their permission in main', () => {
  it.each([
    [IPC_CHANNELS.orders.fullDelete, { id: 1, confirmation: 'SO-000001' }, P.orders.fullDelete],
    [IPC_CHANNELS.employees.fullDelete, { id: 1, confirmation: 'اسم' }, P.employees.fullDelete],
    [IPC_CHANNELS.quotations.remove, { id: 1 }, P.quotations.remove],
    [IPC_CHANNELS.expenses.remove, { id: 1 }, P.expenses.manage],
    [IPC_CHANNELS.employees.remove, { id: 1, confirmation: 'اسم' }, P.employees.manage],
    [IPC_CHANNELS.purchases.fullDelete, { id: 1, confirmation: 'PO-000001' }, P.purchases.fullDelete],
    [IPC_CHANNELS.purchases.fullDeletePreview, { id: 1 }, P.purchases.fullDelete],
    [IPC_CHANNELS.suppliers.fullDelete, { id: 1, confirmation: 'اسم' }, P.suppliers.fullDelete],
    [IPC_CHANNELS.suppliers.fullDeletePreview, { id: 1 }, P.suppliers.fullDelete],
    [IPC_CHANNELS.cash.fullDeleteAccount, { id: 1, confirmation: 'اسم' }, P.cash.fullDelete],
    [IPC_CHANNELS.cash.fullDeleteAccountPreview, { id: 1 }, P.cash.fullDelete],
    [IPC_CHANNELS.materials.fullDelete, { id: 1, confirmation: 'اسم' }, P.materials.fullDelete],
    [IPC_CHANNELS.materials.fullDeletePreview, { id: 1 }, P.materials.fullDelete],
    [IPC_CHANNELS.products.fullDelete, { id: 1, confirmation: 'كود' }, P.products.fullDelete],
    [IPC_CHANNELS.products.fullDeletePreview, { id: 1 }, P.products.fullDelete]
  ])('refuses %s without its permission key', async (channel, payload, permission) => {
    // Every OTHER manage/delete key, but not this one.
    signInWith([
      P.orders.fullDelete, P.employees.fullDelete, P.quotations.remove,
      P.expenses.manage, P.employees.manage,
      P.purchases.fullDelete, P.suppliers.fullDelete, P.cash.fullDelete, P.materials.fullDelete,
      P.products.fullDelete
    ].filter((key) => key !== permission))

    const result = await invoke(channel, payload)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
  })

  it('refuses an unauthenticated window outright', async () => {
    const result = await invoke(IPC_CHANNELS.employees.fullDelete, { id: 1, confirmation: 'اسم' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('UNAUTHENTICATED')
  })

  it('re-checks orders.fullDelete when a preliminary-invoice delete cascades into its order', async () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    // A LEGACY converted pair: the shape a preliminary invoice and its
    // order have on disk from before the workflow pass.
    const quotation = createQuotation({
      customerId,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)
    const invoice = createFinalInvoice({
      customerId,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    const raw = getRawConnection()
    raw.prepare('UPDATE orders SET quotation_id = ?, final_invoice_id = NULL WHERE id = ?').run(quotation.id, order.id)
    raw.prepare('DELETE FROM final_invoices WHERE id = ?').run(invoice.id)
    raw.prepare("UPDATE quotations SET status = 'converted' WHERE id = ?").run(quotation.id)

    // The preliminary invoice's own delete key opens the channel but
    // not the cascade into its Customer Order.
    signInWith([P.quotations.remove])
    const refused = await invoke(IPC_CHANNELS.quotations.remove, {
      id: quotation.id, confirmation: quotation.documentNumber
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('FORBIDDEN')

    signInWith([P.quotations.remove, P.orders.fullDelete])
    const authorizedButProtected = await invoke(IPC_CHANNELS.quotations.remove, {
      id: quotation.id, confirmation: quotation.documentNumber
    })
    expect(authorizedButProtected).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(getRawConnection().prepare('SELECT id FROM orders WHERE id = ?').get(order.id)).toEqual({ id: order.id })
  })

  it('accepts every delete payload without a reason field', async () => {
    signInWith([
      P.orders.fullDelete, P.employees.fullDelete, P.quotations.remove,
      P.expenses.manage, P.employees.manage,
      P.purchases.fullDelete, P.suppliers.fullDelete, P.cash.fullDelete, P.materials.fullDelete,
      P.products.fullDelete
    ])
    for (const [channel, payload] of [
      [IPC_CHANNELS.orders.fullDelete, { id: 999999, confirmation: 'SO-000001' }],
      [IPC_CHANNELS.employees.fullDelete, { id: 999999, confirmation: 'اسم' }],
      [IPC_CHANNELS.quotations.remove, { id: 999999 }],
      [IPC_CHANNELS.expenses.remove, { id: 999999 }],
      [IPC_CHANNELS.employees.remove, { id: 999999, confirmation: 'اسم' }],
      [IPC_CHANNELS.purchases.fullDelete, { id: 999999, confirmation: 'PO-000001' }],
      [IPC_CHANNELS.suppliers.fullDelete, { id: 999999, confirmation: 'اسم' }],
      [IPC_CHANNELS.cash.fullDeleteAccount, { id: 999999, confirmation: 'اسم' }],
      [IPC_CHANNELS.materials.fullDelete, { id: 999999, confirmation: 'اسم' }],
      [IPC_CHANNELS.products.fullDelete, { id: 999999, confirmation: 'كود' }]
    ] as const) {
      const result = await invoke(channel, payload)
      // They fail because the row does not exist — never because a
      // reason was not supplied.
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('NOT_FOUND')
        expect(result.error.message).not.toContain('سبب')
      }
    }
  })
})
