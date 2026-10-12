import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { insertHistoricalStockSheet } from '../helpers/historical-stock-sheet'
import { getRawConnection } from '@main/db/connection'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier, createCustomer } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createProduct } from '@main/services/products/products.service'
import { createMachine, addMachineUsage } from '@main/services/production/machines.service'
import { createWorker, workerBalances, assignWorkerToOrder } from '@main/services/production/workers.service'
import { savePlannedMaterials } from '@main/services/planning/planning.service'
import { availableQty, consumeMaterial } from '@main/services/inventory/inventory.service'
import { onHandMicro, listFinishedGoods } from '@main/services/production/finished-goods.service'
import { issueStandardStockFromBom, issueWorkSheet, consumeForOrder, cancelProductionOrder, completeProduction, startProduction, reverseWorkSheet, reverseMaterialConsumption, correctMaterialConsumption, getProductionOrder } from '@main/services/production/production.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let key = 0
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  env.cleanup()
})
const raw = () => getRawConnection()
const rows = (table: string) => raw().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
function seedStock() {
  const categoryId = createCategory({ name: 'BL14 material' }, env.ctx)
  const materialId = createMaterial({ sku: `BL14-${++key}`, name: 'Board', categoryId, unit: 'unit', currentMarketPriceMicro: c(100), pricingRule: 'exact' } as never, env.ctx)
  const supplierId = createSupplier({ name: 'BL14 supplier' }, env.ctx)
  createPurchase({ supplierId, lines: [{ materialId, qtyMicro: q(10), unitCostMicro: c(100) }] }, env.ctx)
  const machineId = createMachine({ name: 'BL14 machine', costingUnit: 'hour', defaultRateMicro: c(100) }, env.ctx)
  const workerId = createWorker({ name: 'BL14 worker' }, env.ctx)
  const productId = createProduct({ code: `BL14-P-${key}`, name: 'BL14 product',
    bom: [{ materialId, qtyMicro: q(5), unit: 'unit' }],
    machines: [{ machineId, usageQtyMicro: q(1) }],
    commission: [{ workerId, amountMinor: m(100) }] }, env.ctx)
  return { materialId, machineId, workerId, productId }
}
function state(s: ReturnType<typeof seedStock>) {
  return {
    materialQty: availableQty(s.materialId),
    workerPayable: workerBalances(s.workerId).payableMinor,
    fgQty: onHandMicro(s.productId),
    fgValue: listFinishedGoods({ productId: s.productId })[0]?.onHandValueMinor ?? 0,
    tables: Object.fromEntries([
      'inventory_movements', 'fifo_layers', 'fifo_allocations', 'order_material_lines',
      'planned_materials', 'planned_machines', 'planned_workers',
      'order_machine_usage', 'order_worker_assignments', 'worker_transactions',
      'finished_goods_movements', 'work_sheets', 'audit_log', 'financial_command_requests'
    ].map((table) => [table, rows(table)]))
  }
}
const count = (table: string) => rows(table).length

describe('BL-14 Standard stock production boundary', () => {
  it('one-step production posts 500 + 100 + 100 = 700 once and replay is idempotent', () => {
    const s = seedStock()
    const request = { productId: s.productId, quantityMicro: q(1), requestKey: 'bl14-atomic-success' }
    const result = issueStandardStockFromBom(request, env.ctx)
    expect(result.totalCostMinor).toBe(m(700))
    expect([availableQty(s.materialId), workerBalances(s.workerId).payableMinor, onHandMicro(s.productId)]).toEqual([q(5), m(100), q(1)])
    expect(listFinishedGoods({ productId: s.productId })[0]!.onHandValueMinor).toBe(m(700))
    expect([count('order_material_lines'), count('order_machine_usage'), count('order_worker_assignments'), count('worker_transactions'), count('finished_goods_movements')]).toEqual([1, 1, 1, 1, 1])
    const after = state(s)
    expect(issueStandardStockFromBom(request, env.ctx)).toEqual(result)
    expect(() => cancelProductionOrder({ id: result.workSheetId, reason: 'no cancellation' }, env.ctx)).toThrow()
    expect(() => reverseWorkSheet({ id: result.workSheetId, expectedToken: '0'.repeat(64), confirmation: result.documentNumber, reason: 'no reversal' }, env.ctx)).toThrow()
    expect(state(s)).toEqual(after)
  })

  it('shortage and failures during material, worker, machine, and FG posting leave no effects', () => {
    const s = seedStock()
    const initial = state(s)
    expect(() => issueStandardStockFromBom({ productId: s.productId, quantityMicro: q(3), requestKey: 'bl14-shortage' }, env.ctx)).toThrow()
    expect(state(s)).toEqual(initial)
    for (const [stage, table, condition] of [
      ['material', 'inventory_movements', "NEW.kind = 'consumption'"],
      ['worker', 'worker_transactions', "NEW.kind = 'earning'"],
      ['machine', 'order_machine_usage', '1=1'],
      ['fg', 'finished_goods_movements', "NEW.kind = 'production_in'"]
    ]) {
      raw().exec(`CREATE TEMP TRIGGER bl14_fail BEFORE INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'bl14 failure'); END`)
      expect(() => issueStandardStockFromBom({ productId: s.productId, quantityMicro: q(1), requestKey: `bl14-failure-${stage}` }, env.ctx)).toThrow(/bl14 failure/)
      expect(state(s), stage).toEqual(initial)
      raw().exec('DROP TRIGGER bl14_fail')
    }
  })

  it('rejects retired stock creation in service and IPC without changing business or audit state', async () => {
    const s = seedStock()
    const before = state(s)
    expect(() => issueWorkSheet({ productId: s.productId, quantityMicro: q(1) }, env.ctx)).toThrow(/صرف من المخزون/)
    expect(state(s)).toEqual(before)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    const response = await handlers.get(C.production.issueWorkSheet)!({ sender: { id: 1 } } as IpcMainInvokeEvent, { productId: s.productId, quantityMicro: q(1) })
    expect(response).toMatchObject({ ok: false })
    expect(state(s)).toEqual(before)
    const old = insertHistoricalStockSheet(s.productId, q(1))
    const historical = state(s)
    expect(await handlers.get(C.production.cancelProduction)!({ sender: { id: 1 } } as IpcMainInvokeEvent, { id: old.id, reason: 'retired' })).toMatchObject({ ok: false })
    expect(state(s)).toEqual(historical)
    const ui = readFileSync('src/renderer/pages/worksheets/WorkSheetsPage.tsx', 'utf8')
    expect(ui).not.toContain("'production', 'issueWorkSheet'")
    expect(ui).not.toContain('createStockOrder')
    expect(readFileSync('src/renderer/pages/products/ProductsPage.tsx', 'utf8')).toContain("'products', 'issueStockFromBom'")
  })

  it('keeps historical stock worksheets visible and read-only, and enforces cancellation permission for customer MOs', () => {
    const s = seedStock()
    const old = insertHistoricalStockSheet(s.productId, q(1))
    const historicalIssue = consumeMaterial({ materialId: s.materialId, physicalQtyMicro: q(5), ctx: env.ctx })
    raw().prepare(`INSERT INTO order_material_lines
      (work_sheet_id, material_id, movement_id, physical_qty_micro, actual_cost_minor,
       commercial_qty_micro, commercial_value_minor, pricing_rule_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(old.id, s.materialId, historicalIssue.movementId, historicalIssue.physicalQtyMicro,
        historicalIssue.actualCostMinor, historicalIssue.commercialQtyMicro,
        historicalIssue.commercialValueMinor, historicalIssue.pricingRuleUsed)
    const before = state(s)
    expect(before.materialQty).toBe(q(5))
    expect(getProductionOrder(old.id).sheet.status).toBe('ready')
    expect(() => consumeForOrder({ workSheetId: old.id, materialId: s.materialId, physicalQtyMicro: q(5) }, env.ctx)).toThrow(/صرف من المخزون/)
    const oldLineId = (raw().prepare('SELECT id FROM order_material_lines WHERE work_sheet_id = ?').get(old.id) as { id: number }).id
    expect(() => reverseMaterialConsumption({ id: oldLineId, reason: 'unsafe' }, env.ctx)).toThrow(/للعرض فقط/)
    expect(() => correctMaterialConsumption({ id: oldLineId, materialId: s.materialId, physicalQtyMicro: q(4), reason: 'unsafe' }, env.ctx)).toThrow(/للعرض فقط/)
    expect(() => addMachineUsage({ workSheetId: old.id, machineId: s.machineId, usageQtyMicro: q(1) }, env.ctx)).toThrow()
    expect(() => assignWorkerToOrder({ workSheetId: old.id, workerId: s.workerId, method: 'fixed', amountMinor: m(100) }, env.ctx)).toThrow()
    expect(() => savePlannedMaterials({ workSheetId: old.id }, [], env.ctx)).toThrow(/للعرض فقط/)
    expect(() => startProduction(old.id, env.ctx)).toThrow(/للعرض فقط/)
    expect(() => completeProduction(old.id, env.ctx)).toThrow(/للعرض فقط/)
    expect(() => cancelProductionOrder({ id: old.id, reason: 'unsafe' }, env.ctx)).toThrow(/لا يمكن إلغاء/)
    expect(state(s)).toEqual(before)

    const customerId = createCustomer({ name: 'BL14 customer' }, env.ctx)
    const invoice = createFinalInvoice({ customerId, depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'Custom', quantityMicro: q(1), unitPriceMinor: m(1000) }] }, env.ctx)
    const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
    const customerSheet = issueWorkSheet({ orderId }, env.ctx)
    const noPermissions = { ...env.ctx, session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [] } }
    const beforeDenied = state(s)
    expect(() => cancelProductionOrder({ id: customerSheet.id, reason: 'denied' }, noPermissions)).toThrow()
    expect(state(s)).toEqual(beforeDenied)
    cancelProductionOrder({ id: customerSheet.id, reason: 'authorized' }, env.ctx)
    expect(getProductionOrder(customerSheet.id).sheet.status).toBe('cancelled')
  })
})
