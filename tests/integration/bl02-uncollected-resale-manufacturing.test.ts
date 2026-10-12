import { fulfillFromStock } from '@main/services/sales/orders.service'
import { issueStockForOrder } from '../helpers/finished-goods-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createProduct } from '@main/services/products/products.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder } from '@main/services/sales/orders.service'
import {
  completeProduction,
  getProductionOrder,
  issueWorkSheet,
  listOperationalWorkSheets,
  listWorkSheets
} from '@main/services/production/production.service'
import { seedFinishedGoods } from '../helpers/finished-goods-fixture'
import { assignWorkerToOrder, createWorker } from '@main/services/production/workers.service'
import {
  getUncollectedProduct,
  productsFromOrder,
  resumeOriginalOrder
} from '@main/services/sales/uncollected-products.service'
import { orderPlanningSnapshot, savePlannedMaterials } from '@main/services/planning/planning.service'
import { orderCostEstimate } from '@main/services/costing/costing.service'
import { buildWorkSheet } from '@main/services/documents/documents.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv

beforeEach(() => {
  env = setupTestDatabase()
})

afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})

function fixture(sourceProductCount = 2) {
  const categoryId = createCategory({ name: `BL02-${crypto.randomUUID()}` }, env.ctx)
  const materialId = createMaterial({
    sku: `BL02-${crypto.randomUUID()}`,
    name: 'BL-02 board',
    categoryId,
    unit: 'board',
    pricingRule: 'exact',
    currentMarketPriceMicro: c(100)
  }, env.ctx)
  createPurchase({
    supplierId: createSupplier({ name: 'BL-02 supplier' }, env.ctx),
    lines: [{ materialId, qtyMicro: q(200), unitCostMicro: c(100) }]
  }, env.ctx)

  const sourceCustomerId = createCustomer({ name: 'BL-02 source customer' }, env.ctx)
  const buyerId = createCustomer({ name: 'BL-02 resale buyer' }, env.ctx)
  const sourceInvoice = createFinalInvoice({
    customerId: sourceCustomerId,
    depositPercentBp: 0,
    lines: Array.from({ length: sourceProductCount }, (_, index) => ({
      lineKind: 'custom' as const,
      description: `Existing physical product ${index + 1}`,
      quantityMicro: q(1),
      unitPriceMinor: m(1000)
    }))
  }, env.ctx)
  const sourceOrder = approveToOrder(sourceInvoice.id, env.ctx)
  const sourceSheet = issueWorkSheet({ orderId: sourceOrder.id }, env.ctx)
  completeProduction(sourceSheet.id, env.ctx)
  cancelOrder({ orderId: sourceOrder.id, reason: 'Create existing physical products' }, env.ctx)
  const sourceProducts = productsFromOrder(sourceOrder.id)

  const resaleTemplateId = createProduct({
    code: `BL02-R-${crypto.randomUUID()}`,
    name: 'Resale template',
    defaultPriceMinor: m(1000),
    bom: [{ materialId, qtyMicro: q(5), unit: 'board' }]
  }, env.ctx)
  const newProductIds = [3, 4].map((boards, index) => createProduct({
    code: `BL02-N${index}-${crypto.randomUUID()}`,
    name: `New manufactured product ${index + 1}`,
    defaultPriceMinor: m(2000),
    bom: [{ materialId, qtyMicro: q(boards), unit: 'board' }]
  }, env.ctx))

  return { materialId, buyerId, sourceOrder, sourceSheet, sourceProducts, resaleTemplateId, newProductIds }
}

function resaleLine(productId: number, uncollectedProductId: number, index: number) {
  return {
    lineKind: 'standard' as const,
    productId,
    description: `Resale line ${index}`,
    quantityMicro: q(1),
    unitPriceMinor: m(1000),
    uncollectedProductId
  }
}

/** BL-04: customer manufacturing demand is a custom line with its own Production Preparation plan. */
function customLine(index: number) {
  return {
    lineKind: 'custom' as const,
    description: `Manufacturable line ${index}`,
    quantityMicro: q(1),
    unitPriceMinor: m(2000)
  }
}

function planBoards(orderId: number, materialId: number, boards: number[]) {
  savePlannedMaterials({ orderId }, boards.map((qty) => ({
    materialId, materialName: 'BL-02 board', qtyMicro: q(qty), unit: 'board', estimatedUnitCostMicro: c(100)
  })), env.ctx)
}

function newLine(productId: number, index: number) {
  return {
    lineKind: 'standard' as const,
    productId,
    description: `Manufacturable line ${index}`,
    quantityMicro: q(1),
    unitPriceMinor: m(2000)
  }
}

describe('BL-02 resale lines are existing physical products, not manufacturing output', () => {
  it('keeps a resale-only order out of planning, manufacturing consumption, and Finished Goods', () => {
    const f = fixture(2)
    const invoice = createFinalInvoice({
      customerId: f.buyerId,
      depositPercentBp: 0,
      lines: f.sourceProducts.map((product, index) => resaleLine(f.resaleTemplateId, product.id, index))
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    const stockBefore = availableQty(f.materialId)

    expect(orderPlanningSnapshot(order.id).materials).toEqual([])
    expect(() => issueWorkSheet({ orderId: order.id }, env.ctx)).toThrow(/لا يحتاج أمر تصنيع/)
    expect(listWorkSheets({ orderId: order.id }).items).toEqual([])
    expect(() => fulfillFromStock({ orderId: order.id }, env.ctx)).toThrow(/معاملة إصدار إذن خروج/)
    expect(availableQty(f.materialId)).toBe(stockBefore)
    expect(getRawConnection().prepare(
      'SELECT COUNT(*) AS c FROM order_material_lines WHERE order_id = ?'
    ).get(order.id)).toEqual({ c: 0 })
    expect(getRawConnection().prepare(
      'SELECT COUNT(*) AS c FROM finished_goods_movements WHERE order_id = ?'
    ).get(order.id)).toEqual({ c: 0 })
  })

  it('classifies multiple mixed-order lines individually for planning, consumption, and cancellation transfer', () => {
    const f = fixture(2)
    const invoice = createFinalInvoice({
      customerId: f.buyerId,
      depositPercentBp: 0,
      lines: [
        resaleLine(f.resaleTemplateId, f.sourceProducts[0]!.id, 1),
        customLine(1),
        resaleLine(f.resaleTemplateId, f.sourceProducts[1]!.id, 2),
        customLine(2)
      ]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    planBoards(order.id, f.materialId, [3, 4])
    const stockBefore = availableQty(f.materialId)

    expect(orderPlanningSnapshot(order.id).materials.map((line) => line.qtyMicro)).toEqual([q(3), q(4)])
    expect(orderCostEstimate(order.id).estimatedMaterialMinor).toBe(m(700))
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    expect(getProductionOrder(sheet.id).materialLines.map((line) => line.physicalQtyMicro)).toEqual([q(3), q(4)])
    expect(availableQty(f.materialId)).toBe(stockBefore - q(7))
    expect(buildWorkSheet(sheet.id, env.ctx).items.map((line) => line.product)).toEqual([
      'Manufacturable line 1',
      'Manufacturable line 2'
    ])

    const currentLines = getRawConnection().prepare(
      'SELECT id, uncollected_product_id AS uncollectedProductId FROM order_lines WHERE order_id = ? AND superseded_at IS NULL ORDER BY id'
    ).all(order.id) as Array<{ id: number; uncollectedProductId: number | null }>
    const resaleLineIds = currentLines.filter((line) => line.uncollectedProductId).map((line) => line.id)
    const manufacturedLineId = currentLines.find((line) => !line.uncollectedProductId)!.id
    const workerId = createWorker({ name: 'BL-02 worker' }, env.ctx)
    expect(() => assignWorkerToOrder({
      workSheetId: sheet.id,
      workerId,
      method: 'percent',
      percentBp: 1000,
      baseKind: 'line',
      orderLineId: resaleLineIds[0]
    }, env.ctx)).toThrow(/بند الطلب الحالي غير موجود/)
    expect(assignWorkerToOrder({
      workSheetId: sheet.id,
      workerId,
      method: 'percent',
      percentBp: 1000,
      baseKind: 'line',
      orderLineId: manufacturedLineId
    }, env.ctx).amountMinor).toBe(m(200))

    completeProduction(sheet.id, env.ctx)
    const result = cancelOrder({ orderId: order.id, reason: 'BL-02 mixed cancellation' }, env.ctx)
    expect(result.transferredProductIds).toHaveLength(2)
    expect(productsFromOrder(order.id)).toHaveLength(2)
    expect(listOperationalWorkSheets({}).items.map((row) => row.id)).not.toContain(sheet.id)

    // Post-BL03 Risk 04: the undelivered resold products return to the shelf.
    for (const product of f.sourceProducts) {
      expect(getUncollectedProduct(product.id)).toMatchObject({
        id: product.id,
        status: 'available',
        soldOrderId: null,
        sourceOrderId: f.sourceOrder.id
      })
    }
    expect(getRawConnection().prepare(
      `SELECT COUNT(*) AS c FROM uncollected_products WHERE source_order_line_id IN (${resaleLineIds.map(() => '?').join(',')})`
    ).get(...resaleLineIds)).toEqual({ c: 0 })
  })

  it('does not reconstruct resale lines as output when a mixed order is cancelled', () => {
    const f = fixture(2)
    const invoice = createFinalInvoice({
      customerId: f.buyerId,
      depositPercentBp: 0,
      lines: [
        resaleLine(f.resaleTemplateId, f.sourceProducts[0]!.id, 1),
        customLine(1),
        resaleLine(f.resaleTemplateId, f.sourceProducts[1]!.id, 2),
        customLine(2)
      ]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    planBoards(order.id, f.materialId, [3, 4])
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    completeProduction(sheet.id, env.ctx)

    const result = cancelOrder({ orderId: order.id, reason: 'BL-02 cancellation reproduction' }, env.ctx)
    expect(result.transferredProductIds).toHaveLength(2)
    expect(productsFromOrder(order.id)).toHaveLength(2)
  })

  it('fulfills only eligible non-resale standard lines from Finished Goods', () => {
    const f = fixture(1)
    seedFinishedGoods({ productId: f.resaleTemplateId, qtyMicro: q(1), totalCostMinor: m(500) }, env.ctx)
    seedFinishedGoods({ productId: f.newProductIds[0]!, qtyMicro: q(1), totalCostMinor: m(700) }, env.ctx)
    const invoice = createFinalInvoice({
      customerId: f.buyerId,
      depositPercentBp: 0,
      lines: [
        resaleLine(f.resaleTemplateId, f.sourceProducts[0]!.id, 1),
        newLine(f.newProductIds[0]!, 1)
      ]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)

    expect(issueStockForOrder({ orderId: order.id }, env.ctx)).toEqual({ issuedLines: 1, totalCostMinor: m(700) })
    expect(getRawConnection().prepare(
      "SELECT product_id AS productId, qty_micro AS qtyMicro FROM finished_goods_movements WHERE order_id = ? AND kind = 'sale_out'"
    ).all(order.id)).toEqual([{ productId: f.newProductIds[0], qtyMicro: q(1) }])
  })

  it('preserves normal manufacturing and whole-order resumption without duplicate state', () => {
    const normal = fixture(2)
    const invoice = createFinalInvoice({
      customerId: normal.buyerId,
      depositPercentBp: 0,
      lines: [customLine(0), customLine(1)]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    planBoards(order.id, normal.materialId, [3, 4])
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    expect(getProductionOrder(sheet.id).materialLines.map((line) => line.physicalQtyMicro)).toEqual([q(3), q(4)])

    const productIds = normal.sourceProducts.map((product) => product.id)
    const consumptionCount = (getRawConnection().prepare(
      'SELECT COUNT(*) AS c FROM order_material_lines WHERE order_id = ?'
    ).get(normal.sourceOrder.id) as { c: number }).c
    const result = resumeOriginalOrder({
      id: productIds[0]!,
      confirmation: normal.sourceOrder.documentNumber,
      requestKey: crypto.randomUUID(),
      expectedProductIds: productIds
    }, env.ctx)
    expect(result.resumedProductIds).toEqual(productIds)
    expect(productsFromOrder(normal.sourceOrder.id).map((product) => product.status)).toEqual(['resumed', 'resumed'])
    expect(getRawConnection().prepare(
      'SELECT COUNT(*) AS c FROM work_sheets WHERE order_id = ?'
    ).get(normal.sourceOrder.id)).toEqual({ c: 1 })
    expect(getRawConnection().prepare(
      'SELECT COUNT(*) AS c FROM order_material_lines WHERE order_id = ?'
    ).get(normal.sourceOrder.id)).toEqual({ c: consumptionCount })
  })
})

describe('BL-02 real IPC mutation paths', () => {
  let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
  const event = { sender: { id: 1 } } as IpcMainInvokeEvent

  beforeEach(async () => {
    handlers = new Map()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel: string, handler: never) => handlers.set(channel, handler)) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
  })

  it('applies the same mixed-line rule through worksheet issuance and cancellation IPC handlers', async () => {
    const f = fixture(1)
    const invoice = createFinalInvoice({
      customerId: f.buyerId,
      depositPercentBp: 0,
      lines: [
        resaleLine(f.resaleTemplateId, f.sourceProducts[0]!.id, 1),
        customLine(1)
      ]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    planBoards(order.id, f.materialId, [3])
    const issue = await handlers.get(IPC_CHANNELS.production.issueWorkSheet)!(event, { orderId: order.id })
    expect(issue).toMatchObject({ ok: true })
    const sheetId = (issue as { data: { id: number } }).data.id
    expect(getProductionOrder(sheetId).materialLines.map((line) => line.physicalQtyMicro)).toEqual([q(3)])

    completeProduction(sheetId, env.ctx)
    expect(await handlers.get(IPC_CHANNELS.orders.cancel)!(event, {
      orderId: order.id,
      reason: 'BL-02 IPC cancellation'
    })).toMatchObject({ ok: true })
    expect(productsFromOrder(order.id)).toHaveLength(1)
  })
})
