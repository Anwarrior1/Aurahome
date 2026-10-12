import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { listReleases } from '@main/services/production/production.service'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 9300
let event: IpcMainInvokeEvent

beforeEach(async () => {
  windowId += 1
  event = { sender: { id: windowId } } as IpcMainInvokeEvent
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

function partialOrder(): number {
  const customerId = createCustomer({ name: 'عميل تلاعب IPC' }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    requiresInstallation: true,
    lines: [{
      lineKind: 'custom', description: 'طلب جزئي',
      quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(10_000)
    }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6_400) }, env.ctx)
  return order.id
}

describe('Unpaid Exit Permit IPC permissions', () => {
  it('allows an unpaid permit with ordinary issuance permission without inventing an override', async () => {
    const orderId = partialOrder()
    const roleId = createRole({ name: 'إصدار عادي', permissions: [P.releases.issue] }, env.ctx)
    createUser({ username: 'ipc-release', password: 'secret123', fullName: 'مستخدم محدود', roleId }, env.ctx)
    login('ipc-release', 'secret123', windowId)

    const result = await handlers.get(IPC_CHANNELS.production.issueRelease)!(event, {
      orderId,
      kind: 'installation',
      showPaidExitSentence: true,
      unpaidReleaseOverride: true,
      unpaidReleaseOverrideReason: 'بيانات مزورة من الواجهة'
    })

    expect(result.ok).toBe(true)
    expect(listReleases({ orderId }).items[0]).toMatchObject({ authorizationType: 'unpaid', unpaidOverrideReason: null })
  })

  it('records unpaid balance even when the role has the historical override permission', async () => {
    const orderId = partialOrder()
    const roleId = createRole({
      name: 'إصدار بتصريح إداري',
      permissions: [P.releases.issue, P.releases.overrideUnpaid]
    }, env.ctx)
    createUser({ username: 'ipc-override', password: 'secret123', fullName: 'مدير إصدار', roleId }, env.ctx)
    login('ipc-override', 'secret123', windowId)

    const result = await handlers.get(IPC_CHANNELS.production.issueRelease)!(event, {
      orderId,
      kind: 'installation',
      unpaidReleaseOverride: true
    })

    expect(result.ok).toBe(true)
    expect(listReleases({ orderId }).items[0]).toMatchObject({
      authorizationType: 'unpaid',
      unpaidOverrideReason: null
    })
  })
})
