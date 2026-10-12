import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { adjustStock, consumeMaterial, receiveStock, reverseConsumptionMovement } from '@main/services/inventory/inventory.service'
import { createPurchase, updatePurchase } from '@main/services/purchasing/purchasing.service'
import { materialValuation } from '@main/services/inventory/valuation.service'
import { getRawConnection } from '@main/db/connection'
import { registerIpcRouter } from '@main/ipc/router'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { login } from '@main/auth/auth.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { approveToOrder, fulfillOrder } from '../helpers/sales-flow'
import { issueWorkSheet, consumeForOrder, completeProduction } from '@main/services/production/production.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'

let env: TestEnv
let materialId: number
let supplierId: number
let windowId = 64000
beforeEach(() => {
  env = setupTestDatabase()
  const categoryId = createCategory({ name: 'BL15' }, env.ctx)
  materialId = createMaterial({
    sku: 'BL15', name: 'material', categoryId, unit: 'piece',
    purchaseUnit: 'box', purchaseUnitFactorMicro: 1_000_000,
    currentMarketPriceMicro: 1_000_000, pricingRule: 'exact'
  }, env.ctx)
  supplierId = createSupplier({ name: 'BL15 supplier' }, env.ctx)
})
afterEach(() => env.cleanup())

const counts = () => {
  const db = getRawConnection()
  return ['fifo_layers', 'inventory_movements', 'purchases', 'purchase_lines'].map(
    table => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  )
}
const line = (cost: Record<string, number>) => ({ materialId, qtyMicro: 1_000_000, ...cost })

async function ipc() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => {
    handlers.set(channel, handler)
  }) as never)
  try { registerIpcRouter() } finally { spy.mockRestore() }
  const id = ++windowId
  login('owner', 'secret123', id)
  return (channel: string, request: unknown) => handlers.get(channel)!({ sender: { id } } as IpcMainInvokeEvent, request)
}

describe('BL-15 receipt and purchase cost boundaries', () => {
  it.each([-1, -100, -1_000_001])('rejects negative stock-in adjustment and direct receipt %i before FIFO write', cost => {
    const before = counts()
    expect(() => adjustStock({ materialId, qtyMicro: 1_000_000, direction: 'in', reason: 'probe', unitCost: cost as never, ctx: env.ctx })).toThrow()
    expect(() => receiveStock({ materialId, qtyMicro: 1_000_000, unitCost: cost as never, sourceKind: 'adjustment' })).toThrow()
    expect(counts()).toEqual(before)
  })

  it.each(['unitCostMicro', 'purchaseUnitCostMicro', 'lineTotalMinor'] as const)('rejects negative %s in create and correction, even at rounding precision', field => {
    const original = createPurchase({ supplierId, lines: [line({ unitCostMicro: 1_000_000 })] }, env.ctx)
    const before = counts()
    const bad = field === 'purchaseUnitCostMicro'
      ? { materialId, purchaseQtyMicro: 1_000_000, [field]: -1 }
      : line({ [field]: -1 })
    expect(() => createPurchase({ supplierId, lines: [bad] }, env.ctx)).toThrow()
    expect(() => updatePurchase(original.id, { lines: [bad] }, env.ctx)).toThrow()
    expect(counts()).toEqual(before)
    expect((getRawConnection().prepare('SELECT total_minor AS total FROM purchases WHERE id = ?').get(original.id) as { total: number }).total).toBe(1000)
  })

  it('rejects a negative total even when another supplied cost could derive a positive unit', () => {
    const before = counts()
    expect(() => createPurchase({ supplierId, lines: [line({ unitCostMicro: 1_000_000, lineTotalMinor: -1 })] }, env.ctx)).toThrow()
    expect(counts()).toEqual(before)
  })

  it('rejects authorized IPC adjustment, purchase creation, and purchase correction before business writes', async () => {
    const invoke = await ipc()
    const original = createPurchase({ supplierId, lines: [line({ unitCostMicro: 1_000_000 })] }, env.ctx)
    const before = counts()
    const adjustment = await invoke(IPC_CHANNELS.inventory.adjust, { materialId, qtyMicro: 1_000_000, direction: 'in', reason: 'probe', unitCostMicro: -1 }) as { ok: boolean; error?: { code: string } }
    const purchase = await invoke(IPC_CHANNELS.purchases.create, { supplierId, requestKey: 'bl15-negative-create', lines: [line({ unitCostMicro: -1 })] }) as { ok: boolean; error?: { code: string } }
    const correction = await invoke(IPC_CHANNELS.purchases.update, { id: original.id, lines: [line({ lineTotalMinor: -1 })] }) as { ok: boolean; error?: { code: string } }
    for (const result of [adjustment, purchase, correction]) {
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('VALIDATION_ERROR')
    }
    expect(counts()).toEqual(before)
  })

  it('preserves zero and positive receipt/purchase costs and linked negative consumption reversal', () => {
    adjustStock({ materialId, qtyMicro: 1_000_000, direction: 'in', reason: 'free stock', unitCost: 0 as never, ctx: env.ctx })
    receiveStock({ materialId, qtyMicro: 1_000_000, unitCost: 0 as never, sourceKind: 'adjustment', ctx: env.ctx })
    createPurchase({ supplierId, lines: [line({ unitCostMicro: 0 })] }, env.ctx)
    createPurchase({ supplierId, lines: [line({ lineTotalMinor: 0 })] }, env.ctx)
    createPurchase({ supplierId, lines: [{ materialId, purchaseQtyMicro: 1_000_000, purchaseUnitCostMicro: 0 }] }, env.ctx)
    const paid = createPurchase({ supplierId, lines: [line({ unitCostMicro: 1_000_000 })] }, env.ctx)
    updatePurchase(paid.id, { lines: [line({ unitCostMicro: 2_000_000 })] }, env.ctx)
    const positive = receiveStock({ materialId, qtyMicro: 1_000_000, unitCost: 1_000_000 as never, sourceKind: 'adjustment', ctx: env.ctx })
    expect(positive.layerId).toBeGreaterThan(0)
    // Purchase receipts precede same-day adjustments in FIFO order.
    consumeMaterial({ materialId, physicalQtyMicro: 6_000_000, ctx: env.ctx })
    const issue = consumeMaterial({ materialId, physicalQtyMicro: 1_000_000, ctx: env.ctx })
    expect(issue.actualCostMinor).toBeGreaterThan(0)
    reverseConsumptionMovement({ movementId: issue.movementId, sourceRefId: issue.movementId, reason: 'reversal', ctx: env.ctx })
    const last = getRawConnection().prepare('SELECT kind, actual_cost_minor AS cost FROM inventory_movements ORDER BY id DESC LIMIT 1').get() as { kind: string; cost: number }
    expect(last).toEqual({ kind: 'consumption_reversal', cost: -issue.actualCostMinor })
    expect(materialValuation().totals.fifoValueMinor).toBeGreaterThanOrEqual(0)
  })

  it('blocks the original negative FIFO to Custom Order profit path', () => {
    const before = counts()
    expect(() => createPurchase({ supplierId, lines: [line({ unitCostMicro: -1_000_000 })] }, env.ctx)).toThrow()
    expect(counts()).toEqual(before)
    expect(materialValuation().totals.fifoValueMinor).toBe(0)
    createPurchase({ supplierId, lines: [line({ unitCostMicro: 1_000_000 })] }, env.ctx)
    const customerId = createCustomer({ name: 'BL15 customer' }, env.ctx)
    const invoice = createFinalInvoice({ customerId, lines: [{ lineKind: 'custom', description: 'custom', quantityMicro: 1_000_000, unitPriceMinor: 1_000_000 }] }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    const issue = consumeForOrder({ orderId: order.id, materialId, physicalQtyMicro: 1_000_000 }, env.ctx)
    expect(issue.actualCostMinor).toBe(1000)
    expect(orderCostBreakdown(order.id).actualProfitMinor).toBe(999_000)
    completeProduction(sheet.id, env.ctx)
    fulfillOrder(order.id, env.ctx)
    const completedNow = new Date()
    expect(monthlyProfitSummary(completedNow.getFullYear(), completedNow.getMonth() + 1).netProfitMinor).toBe(999_000)
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})
