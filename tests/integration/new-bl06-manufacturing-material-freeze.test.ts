import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { reconcileDatabase } from '@main/db/reconciliation'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { createProduct } from '@main/services/products/products.service'
import { issueWorkSheet, startProduction, consumeForOrder, completeProduction, correctMaterialConsumption, reverseMaterialConsumption, issueStandardStockFromBom, productionActualCostMinor } from '@main/services/production/production.service'
import { availableQty, consumeMaterial, reverseConsumptionMovement } from '@main/services/inventory/inventory.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
let material: number
const raw = () => getRawConnection()
const issues = () => raw().prepare('SELECT * FROM order_material_lines ORDER BY id').all() as { id: number; movement_id: number; physical_qty_micro: number; actual_cost_minor: number }[]
function snapshot() {
  return Object.fromEntries((raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
function denied(invoke: () => unknown) { const before = snapshot(); expect(invoke).toThrow(); expect(snapshot()).toEqual(before) }
function reconciled() {
  expect(reconcileDatabase(raw()).findings.filter(f => f.severity === 'error' && (f.domain === 'inventory' || f.domain === 'production'))).toEqual([])
}
beforeEach(() => {
  env = setupTestDatabase()
  material = createMaterial({ sku: 'BOARD', name: 'Board', unit: 'board', pricingRule: 'exact', categoryId: createCategory({ name: 'Boards' }, env.ctx), currentMarketPriceMicro: c(100) }, env.ctx)
  createPurchase({ supplierId: createSupplier({ name: 'Supplier' }, env.ctx), lines: [{ materialId: material, qtyMicro: q(100), unitCostMicro: c(100) }] }, env.ctx)
})
afterEach(() => {
  try { expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); expect(raw().pragma('foreign_key_check')).toEqual([]) } finally { env.cleanup() }
})
function manufacturing() {
  const invoice = createFinalInvoice({ customerId: createCustomer({ name: 'Customer' }, env.ctx), depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'Cabinet', quantityMicro: q(1), unitPriceMinor: m(5000) }] }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx); startProduction(sheet.id, env.ctx)
  const issue = consumeForOrder({ workSheetId: sheet.id, materialId: material, physicalQtyMicro: q(10) }, env.ctx)
  return { order: order.id, sheet: sheet.id, issue: issue.id }
}
function reverse(movementId: number) { return reverseConsumptionMovement({ movementId, sourceRefId: movementId, reason: 'Direct reversal', ctx: env.ctx }) }

describe('NEW-BL-06 manufacturing material freeze', () => {
  it.each([false, true])('blocks completed reversal (caller-created transaction=%s) and preserves stock/issue/FIFO/cost', transactional => {
    const f = manufacturing(); completeProduction(f.sheet, env.ctx); reconciled()
    const movement = issues()[0]!.movement_id
    denied(() => transactional ? withTransaction(() => reverse(movement)) : reverse(movement))
    expect(availableQty(material)).toBe(q(90)); expect(issues()[0]).toMatchObject({ physical_qty_micro: q(10), actual_cost_minor: m(1000) })
    expect(orderCostBreakdown(f.order).materialCostMinor).toBe(m(1000))
    expect(productionActualCostMinor(f.sheet)).toBe(m(1000))
    expect(raw().prepare('SELECT SUM(qty_micro) AS quantity FROM fifo_allocations WHERE movement_id=?').get(movement)).toEqual({ quantity: q(10) })
    expect(raw().prepare('SELECT status FROM work_sheets WHERE id=?').get(f.sheet)).toEqual({ status: 'completed' }); reconciled()
  })
  it('blocks completed additions and repeated direct/owning mutations without any partial effects', () => {
    const f = manufacturing(); completeProduction(f.sheet, env.ctx)
    for (let i = 0; i < 2; i++) {
      denied(() => consumeMaterial({ orderId: f.order, materialId: material, physicalQtyMicro: q(2), ctx: env.ctx }))
      denied(() => withTransaction(() => consumeMaterial({ orderId: f.order, materialId: material, physicalQtyMicro: q(2), ctx: env.ctx })))
      denied(() => reverse(issues()[0]!.movement_id))
      denied(() => consumeForOrder({ workSheetId: f.sheet, materialId: material, physicalQtyMicro: q(2) }, env.ctx))
      denied(() => reverseMaterialConsumption({ id: f.issue, reason: 'Frozen' }, env.ctx))
      denied(() => correctMaterialConsumption({ id: f.issue, materialId: material, physicalQtyMicro: q(5), reason: 'Frozen' }, env.ctx))
    }
    expect(availableQty(material)).toBe(q(90)); reconciled()
  })
  it('preserves authoritative pre-completion correction/reversal and subsequent completion', () => {
    const f = manufacturing(); reconciled()
    const replacement = correctMaterialConsumption({ id: f.issue, materialId: material, physicalQtyMicro: q(8), reason: 'Correct quantity' }, env.ctx)
    expect(availableQty(material)).toBe(q(92)); expect(orderCostBreakdown(f.order).materialCostMinor).toBe(m(800)); reconciled()
    reverseMaterialConsumption({ id: replacement.id, reason: 'Reissue' }, env.ctx)
    expect(availableQty(material)).toBe(q(100)); reconciled()
    consumeForOrder({ workSheetId: f.sheet, materialId: material, physicalQtyMicro: q(10) }, env.ctx)
    completeProduction(f.sheet, env.ctx)
    expect(orderCostBreakdown(f.order).materialCostMinor).toBe(m(1000)); expect(availableQty(material)).toBe(q(90)); reconciled()
  })
  it('preserves multiple FIFO allocations and materials after completion', () => {
    const f = manufacturing()
    createPurchase({ supplierId: createSupplier({ name: 'Second supplier' }, env.ctx), lines: [{ materialId: material, qtyMicro: q(20), unitCostMicro: c(150) }] }, env.ctx)
    const second = createMaterial({ sku: 'SECOND', name: 'Second material', unit: 'unit', categoryId: createCategory({ name: 'Second category' }, env.ctx), pricingRule: 'exact', currentMarketPriceMicro: c(20) }, env.ctx)
    createPurchase({ supplierId: createSupplier({ name: 'Third supplier' }, env.ctx), lines: [{ materialId: second, qtyMicro: q(10), unitCostMicro: c(20) }] }, env.ctx)
    consumeForOrder({ workSheetId: f.sheet, materialId: material, physicalQtyMicro: q(95) }, env.ctx)
    consumeForOrder({ workSheetId: f.sheet, materialId: second, physicalQtyMicro: q(3) }, env.ctx)
    completeProduction(f.sheet, env.ctx)
    expect(raw().prepare('SELECT COUNT(*) AS n FROM fifo_allocations').get()).toEqual({ n: 4 })
    for (const line of issues()) denied(() => withTransaction(() => reverse(line.movement_id)))
    expect(availableQty(material)).toBe(q(15)); expect(availableQty(second)).toBe(q(7)); reconciled()
  })
  it('protects completed Standard worksheet reversal through its issue-line link without breaking BOM production', () => {
    const product = createProduct({ code: 'STANDARD', name: 'Standard', bom: [{ materialId: material, qtyMicro: q(2), unit: 'board' }] }, env.ctx)
    const result = issueStandardStockFromBom({ productId: product, quantityMicro: q(5), requestKey: 'new06-standard' }, env.ctx)
    expect(result.totalCostMinor).toBe(m(1000)); expect(availableQty(material)).toBe(q(90))
    denied(() => consumeMaterial({ workSheetId: result.workSheetId, materialId: material, physicalQtyMicro: q(2), ctx: env.ctx }))
    denied(() => reverse(issues()[0]!.movement_id)); reconciled()
  })
  it('keeps unrelated generic inventory consumption/reversal valid', () => {
    const result = consumeMaterial({ materialId: material, physicalQtyMicro: q(2), ctx: env.ctx })
    reverse(result.movementId); expect(availableQty(material)).toBe(q(100)); reconciled()
  })
  it('preserves IPC permissions and rejects completed-state manufacturing mutation', async () => {
    const f = manufacturing(); const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>()
    const electron = await import('electron'); const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
    const role = createRole({ name: 'Restricted', permissions: [] }, env.ctx); createUser({ username: 'restricted', password: 'secret123', fullName: 'Restricted', roleId: role }, env.ctx); login('restricted', 'secret123', 92)
    const invoke = (input: unknown, id = 1) => handlers.get(C.production.consumeMaterial)!({ sender: { id } } as IpcMainInvokeEvent, input)
    const input = { workSheetId: f.sheet, materialId: material, physicalQtyMicro: q(1) }
    const before = snapshot(); expect(await invoke(input, 92)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } }); expect(snapshot()).toEqual(before)
    expect(await invoke(input)).toMatchObject({ ok: true }); completeProduction(f.sheet, env.ctx)
    const completed = snapshot(); expect(await invoke(input)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } }); expect(snapshot()).toEqual(completed); reconciled()
  })
})
