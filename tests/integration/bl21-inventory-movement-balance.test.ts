import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { approveToOrder } from '../helpers/sales-flow'
import { savePlannedMaterials } from '@main/services/planning/planning.service'
import { consumeForOrder, issueWorkSheet } from '@main/services/production/production.service'
import { availableQty, listMovements, recordWaste } from '@main/services/inventory/inventory.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
const q = quantityFromDisplay

function seedMaterial() {
  const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
  const materialId = createMaterial({ sku: 'BL21-MDF', name: 'MDF', categoryId, unit: 'لوح', currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact' } as never, env.ctx)
  const supplierId = createSupplier({ name: 'مورد الأخشاب' }, env.ctx)
  createPurchase({ supplierId, lines: [{ materialId, qtyMicro: q(100), unitCostMicro: unitCostFromMajor(100) }] }, env.ctx)
  return materialId
}

function issue(materialId: number, customerName: string) {
  const customerId = createCustomer({ name: customerName }, env.ctx)
  const invoice = createFinalInvoice({ customerId, lines: [{ lineKind: 'custom', description: 'خزانة', quantityMicro: q(1), unitPriceMinor: moneyFromMajor(1500) }] }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  savePlannedMaterials({ orderId: order.id }, [{ materialId, materialName: 'MDF', qtyMicro: q(10), unit: 'لوح', estimatedUnitCostMicro: unitCostFromMajor(100) }], env.ctx)
  issueWorkSheet({ orderId: order.id }, env.ctx)
  const movement = listMovements({ materialId, orderId: order.id }).items.find((row) => row.kind === 'consumption')!
  return { orderId: order.id, movementId: movement.id }
}

const count = (table: string) => (getRawConnection().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
const balance = (movementId: number, filter: Parameters<typeof listMovements>[0], request?: Parameters<typeof listMovements>[1]) =>
  listMovements(filter, request).items.find((row) => row.id === movementId)?.balanceAfterMicro

beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  try {
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  } finally { env.cleanup() }
})

describe('BL-21 material-wide historical movement balances', () => {
  it('keeps the issue at 90 after later unrelated waste leaves current stock at 60', () => {
    const materialId = seedMaterial()
    const { orderId, movementId } = issue(materialId, 'عميل A')
    expect(balance(movementId, { materialId, orderId })).toBe(q(90))
    recordWaste({ materialId, qtyMicro: q(30), reason: 'هالك', ctx: env.ctx })
    expect(availableQty(materialId)).toBe(q(60))
    expect(balance(movementId, {})).toBe(q(90))
    expect(balance(movementId, { materialId })).toBe(q(90))
    expect(balance(movementId, { materialId, orderId })).toBe(q(90))
    expect(balance(movementId, { materialId, orderId, kind: 'consumption' })).toBeNull()
    expect(balance(movementId, { materialId, orderId, from: '2000-01-01' })).toBeNull()
    const before = ['inventory_movements', 'fifo_layers', 'fifo_allocations', 'audit_log'].map(count)
    listMovements({ materialId, orderId })
    listMovements({ materialId, orderId })
    expect(['inventory_movements', 'fifo_layers', 'fifo_allocations', 'audit_log'].map(count)).toEqual(before)
  })

  it('includes movements from Order B between two Order A rows and remains page independent', () => {
    const materialId = seedMaterial()
    const first = issue(materialId, 'عميل A')
    issue(materialId, 'عميل B')
    consumeForOrder({ orderId: first.orderId, materialId, physicalQtyMicro: q(5) }, env.ctx)
    recordWaste({ materialId, qtyMicro: q(30), reason: 'هالك', ctx: env.ctx })
    expect(availableQty(materialId)).toBe(q(45))
    expect(balance(first.movementId, { materialId, orderId: first.orderId })).toBe(q(90))
    const all = listMovements({ materialId, orderId: first.orderId }, { limit: 20 }).items
    expect(all.map((row) => row.balanceAfterMicro)).toEqual([q(75), q(90)])
    const expected = new Map(all.map((row) => [row.id, row.balanceAfterMicro]))
    let cursor: string | undefined
    const paged = new Map<number, number | null>()
    do {
      const page = listMovements({ materialId, orderId: first.orderId }, { limit: 1, cursor })
      for (const row of page.items) paged.set(row.id, row.balanceAfterMicro)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(paged).toEqual(expected)
    expect(paged.get(first.movementId)).toBe(q(90))
  })

  it('retains IPC viewing, cost redaction, and waste permission boundaries', async () => {
    const materialId = seedMaterial()
    const { orderId, movementId } = issue(materialId, 'عميل A')
    recordWaste({ materialId, qtyMicro: q(30), reason: 'هالك', ctx: env.ctx })
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    const user = (id: number, permissions: string[]) => {
      const roleId = createRole({ name: `BL21-${id}`, permissions }, env.ctx)
      createUser({ username: `bl21-${id}`, password: 'secret123', fullName: `BL21 ${id}`, roleId }, env.ctx)
      login(`bl21-${id}`, 'secret123', id)
      return { sender: { id } } as IpcMainInvokeEvent
    }
    const viewer = user(21001, [P.inventory.view])
    const denied = user(21002, [])
    const invoke = (channel: string, input: unknown, event: IpcMainInvokeEvent) => handlers.get(channel)!(event, input)
    const input = { materialId, orderId }
    const rejected = await invoke(IPC_CHANNELS.inventory.movements, input, denied)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.code).toBe('FORBIDDEN')
    const rejectedWaste = await invoke(IPC_CHANNELS.inventory.waste, { materialId, qtyMicro: q(1), reason: 'هالك' }, viewer)
    expect(rejectedWaste.ok).toBe(false)
    if (!rejectedWaste.ok) expect(rejectedWaste.error.code).toBe('FORBIDDEN')
    const viewed = await invoke(IPC_CHANNELS.inventory.movements, input, viewer)
    expect(viewed.ok).toBe(true)
    if (viewed.ok) {
      const row = (viewed.data as ReturnType<typeof listMovements>).items.find((item) => item.id === movementId)!
      expect(row.balanceAfterMicro).toBe(q(90))
      expect(row).not.toHaveProperty('actualCostMinor')
    }
    const owner = await invoke(IPC_CHANNELS.inventory.movements, input, { sender: { id: 1 } } as IpcMainInvokeEvent)
    expect(owner.ok).toBe(true)
    if (owner.ok) expect((owner.data as ReturnType<typeof listMovements>).items.find((item) => item.id === movementId)).toHaveProperty('actualCostMinor')
  })

  it('keeps failed waste allocation atomic and permits a later valid waste', () => {
    const materialId = seedMaterial()
    const { orderId, movementId } = issue(materialId, 'عميل A')
    const before = ['inventory_movements', 'fifo_layers', 'fifo_allocations', 'audit_log'].map(count)
    getRawConnection().exec("CREATE TRIGGER bl21_fail_allocation BEFORE INSERT ON fifo_allocations BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")
    expect(() => recordWaste({ materialId, qtyMicro: q(30), reason: 'هالك', ctx: env.ctx })).toThrow()
    expect(['inventory_movements', 'fifo_layers', 'fifo_allocations', 'audit_log'].map(count)).toEqual(before)
    expect(availableQty(materialId)).toBe(q(90))
    getRawConnection().exec('DROP TRIGGER bl21_fail_allocation')
    recordWaste({ materialId, qtyMicro: q(30), reason: 'هالك', ctx: env.ctx })
    expect(availableQty(materialId)).toBe(q(60))
    expect(balance(movementId, { materialId, orderId })).toBe(q(90))
  })
})
