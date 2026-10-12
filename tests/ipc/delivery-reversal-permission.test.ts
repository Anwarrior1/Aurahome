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
import { getOrder, recordPayment } from '@main/services/sales/orders.service'
import {
  issueRelease,
  listDeliveries,
  recordDelivery
} from '@main/services/production/production.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 9700
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

describe('Delivery & Installation reversal IPC security', () => {
  it('rejects an unauthorized direct reversal without changing completion, cost or action state', async () => {
    const customerId = createCustomer({ name: 'عميل صلاحية حذف العملية' }, env.ctx)
    const invoice = createFinalInvoice({
      customerId,
      requiresDelivery: true,
      lines: [{
        lineKind: 'custom',
        description: 'طلب توصيل محمي',
        quantityMicro: quantityFromDisplay(1),
        unitPriceMinor: moneyFromMajor(1000)
      }]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
    const permit = issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
    const completion = recordDelivery({
      orderId: order.id,
      releaseId: permit.id,
      kind: 'delivery',
      actualCostMinor: moneyFromMajor(100)
    }, env.ctx)

    const roleId = createRole({ name: 'عرض الطلبات فقط', permissions: [P.orders.view] }, env.ctx)
    createUser({
      username: 'no-operation-delete',
      password: 'secret123',
      fullName: 'مستخدم دون حذف',
      roleId
    }, env.ctx)
    login('no-operation-delete', 'secret123', windowId)

    const result = await handlers.get(IPC_CHANNELS.production.cancelDelivery)!(event, {
      id: completion.id
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    expect(listDeliveries({ orderId: order.id }).items).toMatchObject([{
      id: completion.id,
      status: 'recorded'
    }])
    expect(orderCostBreakdown(order.id).deliveryCostMinor).toBe(moneyFromMajor(100))
    expect(getOrder(order.id).workflow.requiredCompletion).toBeNull()
  })
})
