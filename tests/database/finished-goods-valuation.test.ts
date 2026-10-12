import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { replaceBom } from '@main/services/products/products.service'
import { issueStandardStockFromBom } from '@main/services/production/production.service'
import { issueFinishedGoodsForOrder } from '../helpers/finished-goods-fixture'
import { issueStockForOrder } from '../helpers/finished-goods-fixture'
import { seedFinishedGoods } from '../helpers/finished-goods-fixture'
import { fulfillOrder } from '../helpers/sales-flow'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { insertHistoricalStockSheet } from '../helpers/historical-stock-sheet'
import { createCustomer } from '@main/services/parties/parties.service'
import { createProduct } from '@main/services/products/products.service'
import { createStandardFinalInvoice } from '@main/services/sales/final-invoices.service'
import { approveToOrder } from '../helpers/sales-flow'
import {
  adjustFinishedGoods,
  finishedGoodsCostForOrder,
  finishedGoodsValuation,
  initializeFinishedGoodsValuationCutovers,
  listFinishedGoodsMovements,
  onHandMicro,
  onHandUnitCostMinor,
  onHandValueMinor,
  reverseFinishedGoodsIssue
} from '@main/services/production/finished-goods.service'
import { getProductionOrder, reverseWorkSheet } from '@main/services/production/production.service'
import {
  cancelOrder,
  getOrderOrThrow
} from '@main/services/sales/orders.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import {
  availableProfitMinor,
  confirmSavingsAllocation,
  monthlyProfitSummary,
  recordProfitWithdrawal,
  savingsOverview,
  setSavingsRateBp
} from '@main/services/finance/profit.service'
import { getRawConnection } from '@main/db/connection'

const UNIT = 1_000_000

let env: TestEnv
let productId: number
let customerId: number

beforeEach(() => {
  env = setupTestDatabase()
  productId = createProduct(
    { code: 'DB02', name: 'DB-02 valuation product', defaultPriceMinor: 300_000 },
    env.ctx
  )
  customerId = createCustomer({ name: 'DB-02 customer' }, env.ctx)
})

afterEach(() => env.cleanup())

function makeOrder(qtyMicro = UNIT, unitPriceMinor = 300_000) {
  const invoice = createStandardFinalInvoice(
    { customerId, productId, quantityMicro: qtyMicro, unitPriceMinor },
    env.ctx
  )
  return approveToOrder(invoice.id, env.ctx)
}

function produce(qtyMicro: number, totalCostMinor: number): number {
  // Explicit opening/count fixture. Production ownership is tested in NEW-BL-04.
  return seedFinishedGoods({ productId, qtyMicro, totalCostMinor }, env.ctx)
}

function issue(qtyMicro: number) {
  const order = makeOrder(qtyMicro)
  return { order, movement: issueFinishedGoodsForOrder({ productId, orderId: order.id, qtyMicro }, env.ctx) }
}

function expectState(qtyMicro: number, valueMinor: number, unitCostMinor: number): void {
  expect(finishedGoodsValuation(productId)).toMatchObject({
    onHandMicro: qtyMicro,
    onHandValueMinor: valueMinor,
    unitCostMinor
  })
  expect(onHandMicro(productId)).toBe(qtyMicro)
  expect(onHandValueMinor(productId)).toBe(valueMinor)
  expect(onHandUnitCostMinor(productId)).toBe(unitCostMinor)
}

describe('DB-02 moving weighted-average finished-goods valuation', () => {
  it('fixes the exact audit reproduction and the subsequent sale COGS', () => {
    produce(UNIT, 10_000)
    expect(issue(UNIT).movement.totalCostMinor).toBe(10_000)
    expectState(0, 0, 0)

    produce(UNIT, 100_000)
    expectState(UNIT, 100_000, 100_000)
    const current = finishedGoodsValuation(productId)
    const second = issue(UNIT)
    console.info(
      JSON.stringify({
        onHandAfterNewProductionMicro: current.onHandMicro,
        authoritativeOnHandValueMinor: current.onHandValueMinor,
        authoritativeUnitCostMinor: current.unitCostMinor,
        subsequentSaleCogsMinor: second.movement.totalCostMinor
      })
    )
    expect(second.movement.totalCostMinor).toBe(100_000)
    expect(finishedGoodsCostForOrder(second.order.id)).toBe(100_000)
    expectState(0, 0, 0)
  })

  it('costs a partial sale from one receipt and reconciles remaining value', () => {
    produce(3 * UNIT, 300_000)
    expect(issue(UNIT).movement.totalCostMinor).toBe(100_000)
    expectState(2 * UNIT, 200_000, 100_000)
  })

  it('weights multiple differently priced receipts and a partial mixed-stock sale', () => {
    produce(2 * UNIT, 20_000)
    produce(UNIT, 40_000)
    expectState(3 * UNIT, 60_000, 20_000)
    expect(issue(2 * UNIT).movement.totalCostMinor).toBe(40_000)
    expectState(UNIT, 20_000, 20_000)
  })

  it('resets carrying value at stockout before a later differently priced receipt', () => {
    produce(2 * UNIT, 21_001)
    issue(UNIT)
    const finalIssue = issue(UNIT)
    expect(finalIssue.movement.totalCostMinor).toBe(10_500)
    expectState(0, 0, 0)
    produce(UNIT, 77_777)
    expectState(UNIT, 77_777, 77_777)
  })

  it('uses explicit value for positive adjustments and current WAC for negative adjustments', () => {
    produce(UNIT, 10_000)
    const positive = adjustFinishedGoods(
      { productId, direction: 'in', qtyMicro: UNIT, totalCostMinor: 30_000, notes: 'count gain' },
      env.ctx
    )
    expect(positive.totalCostMinor).toBe(30_000)
    expectState(2 * UNIT, 40_000, 20_000)
    const negative = adjustFinishedGoods(
      { productId, direction: 'out', qtyMicro: UNIT, notes: 'count loss' },
      env.ctx
    )
    expect(negative.totalCostMinor).toBe(20_000)
    expectState(UNIT, 20_000, 20_000)
  })

  it('reports an explicit zero quantity, value, and cost for a never-stocked product', () => {
    expectState(0, 0, 0)
  })

  it('rounds half upward at each posting boundary and consumes the exact final residue', () => {
    produce(3, 2)
    expect(issueFinishedGoodsForOrder({ productId, orderId: makeOrder(1).id, qtyMicro: 1 }, env.ctx).totalCostMinor).toBe(1)
    expectState(2, 1, 500_000)
    expect(issueFinishedGoodsForOrder({ productId, orderId: makeOrder(1).id, qtyMicro: 1 }, env.ctx).totalCostMinor).toBe(1)
    expectState(1, 0, 0)
    expect(issueFinishedGoodsForOrder({ productId, orderId: makeOrder(1).id, qtyMicro: 1 }, env.ctx).totalCostMinor).toBe(0)
    expectState(0, 0, 0)
  })

  it('uses BigInt intermediates for very large supported safe integer values', () => {
    const qty = 4_000_000_000
    const value = 8_000_000_000_000_000
    produce(qty, value)
    const result = issueFinishedGoodsForOrder(
      { productId, orderId: makeOrder(1_000_000_000).id, qtyMicro: 1_000_000_000 },
      env.ctx
    )
    expect(result.totalCostMinor).toBe(2_000_000_000_000_000)
    expectState(3_000_000_000, 6_000_000_000_000_000, 2_000_000_000_000)
  })

  it('restores the exact issue quantity/value, zeros order COGS, and rejects repeated reversal', () => {
    produce(2 * UNIT, 50_000)
    const { order, movement } = issue(UNIT)
    cancelOrder({ orderId: order.id, reason: 'customer cancellation' }, env.ctx)
    const reversalId = (getRawConnection().prepare("SELECT id FROM finished_goods_movements WHERE reversal_of_movement_id = ?").get(movement.id) as { id: number }).id
    expect(reversalId).toBeGreaterThan(movement.id)
    expectState(2 * UNIT, 50_000, 25_000)
    expect(finishedGoodsCostForOrder(order.id)).toBe(0)
    expect(() =>
      reverseFinishedGoodsIssue({ movementId: movement.id, reason: 'retry' }, env.ctx)
    ).toThrow(/معاملة إلغاء الطلب/)
  })

  it('cancels a stock-fulfilled order and restores valuation atomically', () => {
    produce(UNIT, 80_000)
    const order = makeOrder()
    issueStockForOrder({ orderId: order.id }, env.ctx)
    expectState(0, 0, 0)
    cancelOrder({ orderId: order.id, reason: 'customer cancelled before delivery' }, env.ctx)
    expect(getOrderOrThrow(order.id).status).toBe('cancelled')
    expectState(UNIT, 80_000, 80_000)
    expect(finishedGoodsCostForOrder(order.id)).toBe(0)
    expect(listFinishedGoodsMovements({ orderId: order.id }).items.map((row) => row.kind)).toEqual([
      'sale_reversal',
      'sale_out'
    ])
  })

  it('refuses the unsupported stock-production completion reversal without changing stock', () => {
    const sheet = insertHistoricalStockSheet(productId, UNIT)
    getRawConnection().prepare("UPDATE work_sheets SET status = 'completed', started_at = '2026-01-01T00:00:00.000Z', completed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(sheet.id)
    seedFinishedGoods({ productId, workSheetId: sheet.id, qtyMicro: UNIT, totalCostMinor: 0 }, env.ctx)
    const detail = getProductionOrder(sheet.id)
    expect(() =>
      reverseWorkSheet(
        {
          id: sheet.id,
          expectedToken: detail.reversalToken,
          confirmation: sheet.documentNumber,
          reason: 'unsupported stock completion reversal'
        },
        env.ctx
      )
    ).toThrow(/قواعد مستقلة/)
    expectState(UNIT, 0, 0)
  })

  it('reconciles signed movement quantity and value to the authoritative state', () => {
    produce(2 * UNIT, 40_000)
    adjustFinishedGoods(
      { productId, direction: 'in', qtyMicro: UNIT, totalCostMinor: 50_000, notes: 'gain' },
      env.ctx
    )
    const sold = issue(UNIT)
    adjustFinishedGoods({ productId, direction: 'out', qtyMicro: UNIT, notes: 'loss' }, env.ctx)
    cancelOrder({ orderId: sold.order.id, reason: 'return' }, env.ctx)

    const rows = listFinishedGoodsMovements({ productId }).items
    const inbound = new Set(['production_in', 'adjustment_in', 'sale_reversal'])
    const qty = rows.reduce((sum, row) => sum + (inbound.has(row.kind) ? row.qtyMicro : -row.qtyMicro), 0)
    const value = rows.reduce(
      (sum, row) => sum + (inbound.has(row.kind) ? row.totalCostMinor : -row.totalCostMinor),
      0
    )
    expect(finishedGoodsValuation(productId)).toMatchObject({
      onHandMicro: qty,
      onHandValueMinor: value
    })
  })
})

describe('DB-02 historical cutover policy', () => {
  function rawMovement(kind: string, qtyMicro: number, totalCostMinor: number, orderId?: number) {
    return Number(
      getRawConnection()
        .prepare(
          `INSERT INTO finished_goods_movements
             (product_id, kind, qty_micro, unit_cost_minor, total_cost_minor, order_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, '2026-01-01')`
        )
        .run(productId, kind, qtyMicro, totalCostMinor, totalCostMinor, orderId ?? null)
        .lastInsertRowid
    )
  }

  it('classifies a clean historical cycle as unaffected and excludes sold stock from opening value', () => {
    rawMovement('production_in', UNIT, 10_000)
    rawMovement('sale_out', UNIT, 10_000, makeOrder().id)
    rawMovement('production_in', UNIT, 100_000)
    expect(initializeFinishedGoodsValuationCutovers()).toEqual({ initialized: 1, blocked: 0 })
    expect(finishedGoodsValuation(productId)).toMatchObject({
      classification: 'unaffected',
      onHandMicro: UNIT,
      onHandValueMinor: 100_000,
      unitCostMinor: 100_000
    })
    expect(issue(UNIT).movement.totalCostMinor).toBe(100_000)
  })

  it('classifies provably defective posted COGS, preserves it, and starts a correct prospective state', () => {
    const firstOrder = makeOrder()
    const secondOrder = makeOrder()
    rawMovement('production_in', UNIT, 10_000)
    rawMovement('sale_out', UNIT, 10_000, firstOrder.id)
    rawMovement('production_in', UNIT, 100_000)
    const defectiveId = rawMovement('sale_out', UNIT, 55_000, secondOrder.id)

    expect(initializeFinishedGoodsValuationCutovers()).toEqual({ initialized: 1, blocked: 0 })
    const cutover = getRawConnection()
      .prepare('SELECT * FROM finished_goods_valuation_cutovers WHERE product_id = ?')
      .get(productId) as Record<string, unknown>
    expect(cutover).toMatchObject({
      status: 'ready',
      classification: 'provably_affected',
      affected_movement_count: 1,
      historical_cogs_delta_minor: -45_000,
      opening_qty_micro: 0,
      opening_value_minor: 0
    })
    expect(finishedGoodsCostForOrder(secondOrder.id)).toBe(55_000)
    expect(
      (getRawConnection().prepare('SELECT total_cost_minor FROM finished_goods_movements WHERE id = ?').get(defectiveId) as { total_cost_minor: number }).total_cost_minor
    ).toBe(55_000)
    produce(UNIT, 100_000)
    expectState(UNIT, 100_000, 100_000)
  })

  it('classifies adjustment-era history as potentially affected without inventing cost', () => {
    rawMovement('adjustment_in', UNIT, 44_000)
    initializeFinishedGoodsValuationCutovers()
    expect(finishedGoodsValuation(productId)).toMatchObject({
      classification: 'potentially_affected',
      onHandMicro: UNIT,
      onHandValueMinor: 44_000
    })
  })

  it('blocks unreconstructable history instead of guessing or posting another movement', () => {
    rawMovement('sale_out', UNIT, 10_000, makeOrder().id)
    expect(initializeFinishedGoodsValuationCutovers()).toEqual({ initialized: 1, blocked: 1 })
    expect(() => finishedGoodsValuation(productId)).toThrow(/فحص محاسبي/)
    expect(() => produce(UNIT, 20_000)).toThrow(/فحص محاسبي/)
    expect(
      (getRawConnection().prepare('SELECT COUNT(*) AS c FROM finished_goods_movements WHERE product_id = ?').get(productId) as { c: number }).c
    ).toBe(1)
  })
})

describe('DB-02 downstream financial correctness', () => {
  it('carries posted COGS through order profit, monthly profit, savings, and available profit', () => {
    setSavingsRateBp(1_000, env.ctx)
    produce(UNIT, 100_000)
    const order = makeOrder(UNIT, 300_000)
    issueStockForOrder({ orderId: order.id }, env.ctx)
    const now = new Date()
    fulfillOrder(order.id, env.ctx, now.toISOString())

    expect(orderCostBreakdown(order.id)).toMatchObject({
      materialCostMinor: 100_000,
      totalActualCostMinor: 100_000,
      sellingPriceMinor: 300_000,
      actualProfitMinor: 200_000
    })
    const monthly = monthlyProfitSummary(now.getUTCFullYear(), now.getUTCMonth() + 1)
    expect(monthly).toMatchObject({
      revenueMinor: 300_000,
      materialCostMinor: 100_000,
      grossOrderProfitMinor: 200_000,
      netProfitMinor: 200_000,
      savingsProposedMinor: 20_000,
      remainingProfitMinor: 200_000
    })
    expect(savingsOverview(now.getUTCFullYear(), now.getUTCMonth() + 1)).toMatchObject({
      netProfitMinor: 200_000,
      allocatedMinor: 20_000
    })
    confirmSavingsAllocation({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }, env.ctx)
    expect(availableProfitMinor()).toBe(180_000)
    expect(recordProfitWithdrawal({ amountMinor: 30_000 }, env.ctx).availableAfterMinor).toBe(150_000)
    expect(availableProfitMinor()).toBe(150_000)
  })
})

describe('DB-02 transactional failure protection', () => {
  it('rolls back movement and valuation together when issue audit insertion fails', () => {
    produce(UNIT, 60_000)
    const order = makeOrder()
    getRawConnection().exec(`
      CREATE TRIGGER fail_finished_issue_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.action = 'finishedGoods.issue'
      BEGIN SELECT RAISE(ABORT, 'injected issue audit failure'); END;
    `)
    expect(() => issueFinishedGoodsForOrder({ productId, orderId: order.id, qtyMicro: UNIT }, env.ctx)).toThrow(
      /injected issue audit failure/
    )
    expectState(UNIT, 60_000, 60_000)
    expect(finishedGoodsCostForOrder(order.id)).toBe(0)
  })

  it('rolls back cancellation status and stock restoration when reversal insertion fails', () => {
    produce(UNIT, 90_000)
    const order = makeOrder()
    issueStockForOrder({ orderId: order.id }, env.ctx)
    getRawConnection().exec(`
      CREATE TRIGGER fail_finished_reversal
      BEFORE INSERT ON finished_goods_movements
      WHEN NEW.kind = 'sale_reversal'
      BEGIN SELECT RAISE(ABORT, 'injected reversal failure'); END;
    `)
    expect(() => cancelOrder({ orderId: order.id, reason: 'failure injection' }, env.ctx)).toThrow(
      /injected reversal failure/
    )
    expect(getOrderOrThrow(order.id).status).toBe('confirmed')
    expectState(0, 0, 0)
    expect(finishedGoodsCostForOrder(order.id)).toBe(90_000)
  })

  it('rolls back production movement and cutover when production audit insertion fails', () => {
    getRawConnection().exec(`
      CREATE TRIGGER fail_finished_production_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.action = 'finishedGoods.production'
      BEGIN SELECT RAISE(ABORT, 'injected production audit failure'); END;
    `)
    const materialId = createMaterial({ sku: 'AUDIT', name: 'Board', unit: 'board', categoryId: createCategory({ name: 'Boards' }, env.ctx), pricingRule: 'exact', currentMarketPriceMicro: 70_000_000 }, env.ctx)
    createPurchase({ supplierId: createSupplier({ name: 'Supplier' }, env.ctx), lines: [{ materialId, qtyMicro: UNIT, unitCostMicro: 70_000_000 }] }, env.ctx)
    replaceBom(productId, [{ materialId, qtyMicro: UNIT, unit: 'board' }], env.ctx)
    expect(() => issueStandardStockFromBom({ productId, quantityMicro: UNIT, requestKey: 'valuation-audit-production' }, env.ctx)).toThrow(/injected production audit failure/)
    expect(
      (getRawConnection().prepare('SELECT COUNT(*) AS c FROM finished_goods_movements WHERE product_id = ?').get(productId) as { c: number }).c
    ).toBe(0)
    expectState(0, 0, 0)
  })

  it('rolls back a negative adjustment when its audit insertion fails', () => {
    produce(2 * UNIT, 120_000)
    getRawConnection().exec(`
      CREATE TRIGGER fail_finished_adjustment_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.action = 'finishedGoods.adjust'
      BEGIN SELECT RAISE(ABORT, 'injected adjustment audit failure'); END;
    `)
    expect(() =>
      adjustFinishedGoods(
        { productId, direction: 'out', qtyMicro: UNIT, notes: 'failure injection' },
        env.ctx
      )
    ).toThrow(/injected adjustment audit failure/)
    expectState(2 * UNIT, 120_000, 60_000)
    expect(
      (getRawConnection().prepare("SELECT COUNT(*) AS c FROM finished_goods_movements WHERE product_id = ? AND kind = 'adjustment_out'").get(productId) as { c: number }).c
    ).toBe(0)
  })

  it('keeps SQLite structurally healthy after financial failure injection', () => {
    produce(2 * UNIT, 100_000)
    issue(UNIT)
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
