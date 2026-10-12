import { seedFinishedGoods } from '../helpers/finished-goods-fixture'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { createAccount } from '@main/services/finance/cash.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier, customerBalances, customerBalancesPage, listCustomers } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createProduct } from '@main/services/products/products.service'
import {
  createFinalInvoice,
  deleteFinalInvoice,
  getFinalInvoice,
  unapproveFinalInvoice
} from '@main/services/sales/final-invoices.service'
import {
  archiveOrder,
  authoritativeOrderPaymentPosition,
  cancelOrder,
  getOrder,
  listOrders,
  recordPayment,
  refundPayment
} from '@main/services/sales/orders.service'
import {
  cancelProductionOrder,
  completeProduction,
  getProductionOrder,
  issueWorkSheet,
  reverseWorkSheet,
  startProduction
} from '@main/services/production/production.service'
import { onHandMicro } from '@main/services/production/finished-goods.service'
import { savePlannedMaterials } from '@main/services/planning/planning.service'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { getUncollectedProduct, productsFromOrder } from '@main/services/sales/uncollected-products.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let sequence = 0

beforeEach(() => {
  env = setupTestDatabase()
  sequence = 0
})

afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})

const raw = () => getRawConnection()
const count = (query: string, ...params: unknown[]) =>
  (raw().prepare(query).get(...params) as { count: number }).count

function seedCatalog() {
  const categoryId = createCategory({ name: `BL06 materials ${++sequence}` }, env.ctx)
  const materialId = createMaterial({
    sku: `BL06-M-${sequence}`,
    name: 'BL06 board',
    categoryId,
    unit: 'board',
    pricingRule: 'exact',
    currentMarketPriceMicro: c(100)
  } as never, env.ctx)
  createPurchase({
    supplierId: createSupplier({ name: `BL06 supplier ${sequence}` }, env.ctx),
    lines: [{ materialId, qtyMicro: q(100), unitCostMicro: c(100) }]
  }, env.ctx)
  const accountId = createAccount({ name: `BL06 cash ${sequence}`, kind: 'cash' }, env.ctx)
  return { materialId, accountId }
}

function customOrder(input: {
  lines?: number
  paidMajor?: number
  materialId?: number
  extraLines?: Parameters<typeof createFinalInvoice>[0]['lines']
} = {}) {
  const customerId = createCustomer({ name: `BL06 customer ${++sequence}` }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    depositPercentBp: input.paidMajor ? 3000 : 0,
    lines: [
      ...Array.from({ length: input.lines ?? 1 }, (_, index) => ({
        lineKind: 'custom' as const,
        description: `Custom output ${index + 1}`,
        quantityMicro: q(1),
        unitPriceMinor: m(5000)
      })),
      ...(input.extraLines ?? [])
    ]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  if (input.paidMajor) {
    recordPayment({ orderId: order.id, amountMinor: m(input.paidMajor) }, env.ctx)
  }
  if (input.materialId) {
    savePlannedMaterials({ orderId: order.id }, [{
      materialId: input.materialId,
      materialName: 'BL06 board',
      qtyMicro: q(5)
    }], env.ctx)
  }
  return { customerId, invoiceId: invoice.id, order }
}

function operationalHistory(orderId: number) {
  return {
    sheets: raw().prepare('SELECT * FROM work_sheets WHERE order_id = ? ORDER BY id').all(orderId),
    materialLines: raw().prepare('SELECT * FROM order_material_lines WHERE order_id = ? ORDER BY id').all(orderId),
    inventory: raw().prepare('SELECT * FROM inventory_movements WHERE order_id = ? ORDER BY id').all(orderId),
    payments: raw().prepare('SELECT * FROM customer_payments WHERE order_id = ? ORDER BY id').all(orderId),
    refunds: raw().prepare('SELECT * FROM customer_payment_refunds WHERE order_id = ? ORDER BY id').all(orderId),
    cash: raw().prepare("SELECT * FROM cash_transactions WHERE ref_table IN ('customer_payments', 'customer_payment_refunds') ORDER BY id").all()
  }
}

function dashboardReceivables(): number {
  const summary = dashboardSummary({
    date: '2026-09-18',
    year: 2026,
    month: 9,
    currentDay: true
  }, env.ctx.session) as { sales: { customerReceivablesMinor: number } }
  return summary.sales.customerReceivablesMinor
}

function createResaleProduct(): number {
  const source = customOrder()
  completeProduction(issueWorkSheet({ orderId: source.order.id }, env.ctx).id, env.ctx)
  cancelOrder({ orderId: source.order.id, reason: 'Create legitimate completed stock' }, env.ctx)
  return productsFromOrder(source.order.id)[0]!.id
}

describe('BL-06 — Customer Order abandonment follows manufacturing reality', () => {
  it('A/F: pre-start reversal reaches the existing inactive unapproval path without deleting history or leaving a receivable', () => {
    const { materialId } = seedCatalog()
    const fixture = customOrder({ materialId })
    const sheet = issueWorkSheet({ orderId: fixture.order.id }, env.ctx)

    reverseWorkSheet({
      id: sheet.id,
      expectedToken: getProductionOrder(sheet.id).reversalToken,
      confirmation: sheet.documentNumber,
      reason: 'Customer abandoned before manufacturing started'
    }, env.ctx)
    expect(getProductionOrder(sheet.id).sheet.status).toBe('reversed')
    expect(productsFromOrder(fixture.order.id)).toEqual([])

    unapproveFinalInvoice({ id: fixture.invoiceId, expectedRevision: 1 }, env.ctx)

    expect(getOrder(fixture.order.id).order.status).toBe('awaiting_approval')
    expect(getFinalInvoice(fixture.invoiceId).invoice.status).toBe('draft')
    expect(listOrders({ includeArchived: true }).items.map((row) => row.id)).not.toContain(fixture.order.id)
    expect(dashboardReceivables()).toBe(0)
    expect(customerBalances(undefined, fixture.customerId)[0]).toMatchObject({
      orderCount: 0,
      totalMinor: 0,
      paidMinor: 0,
      remainingMinor: 0
    })
    expect(customerBalancesPage({}).items.find((row) => row.customerId === fixture.customerId)).toMatchObject({ remainingMinor: 0 })
    expect(listCustomers({}).items.find((row) => row.id === fixture.customerId)).toMatchObject({ remainingMinor: 0 })
    expect(() => deleteFinalInvoice(fixture.invoiceId, env.ctx)).toThrow(/سجلاً مالياً أو تشغيلياً تاريخياً/)
    expect(getProductionOrder(sheet.id).sheet.status).toBe('reversed')
  })

  it('B/E: a started Manufacturing Order stays open when its Customer Order cancels, then transfers real output at completion', () => {
    const { materialId, accountId } = seedCatalog()
    const fixture = customOrder({ paidMajor: 3000, materialId })
    const sheet = issueWorkSheet({ orderId: fixture.order.id }, env.ctx)
    startProduction(sheet.id, env.ctx)
    const costBefore = orderCostBreakdown(fixture.order.id)

    expect(() => cancelProductionOrder({ id: sheet.id, reason: 'Customer abandoned during production' }, env.ctx)).toThrow(/بعد بدء التصنيع/)

    expect(getOrder(fixture.order.id).actions.canCancel).toBe(true)
    expect(listOrders({}).items.find((row) => row.id === fixture.order.id)?.canCancel).toBe(true)
    expect(() => refundPayment({
      orderId: fixture.order.id,
      amountMinor: m(3000),
      cashAccountId: accountId,
      requestKey: crypto.randomUUID()
    }, env.ctx)).toThrow(/بعد بدء التصنيع/)

    const historyBefore = operationalHistory(fixture.order.id)
    const paymentBefore = authoritativeOrderPaymentPosition(fixture.order.id)
    cancelOrder({ orderId: fixture.order.id, reason: 'Customer abandonment' }, env.ctx)

    expect(getOrder(fixture.order.id).order.status).toBe('cancelled')
    expect(getProductionOrder(sheet.id).sheet).toMatchObject({ status: 'in_production', startedAt: expect.any(String), completedAt: null })
    expect(operationalHistory(fixture.order.id)).toEqual(historyBefore)
    expect(authoritativeOrderPaymentPosition(fixture.order.id)).toEqual(paymentBefore)
    expect(orderCostBreakdown(fixture.order.id)).toEqual({ ...costBefore, actualProfitMinor: 0 })
    expect(productsFromOrder(fixture.order.id)).toEqual([])
    expect(dashboardReceivables()).toBe(0)
    expect(customerBalances(undefined, fixture.customerId)[0]?.remainingMinor).toBe(0)

    archiveOrder({ id: fixture.order.id, archive: true }, env.ctx)
    expect(getOrder(fixture.order.id).order.archivedAt).toBeTruthy()
    completeProduction(sheet.id, env.ctx)
    expect(getProductionOrder(sheet.id).sheet.status).toBe('completed')
    expect(productsFromOrder(fixture.order.id)).toHaveLength(1)
    expect(orderCostBreakdown(fixture.order.id)).toEqual({ ...costBefore,
      actualProfitMinor: Math.max(m(3000) - costBefore.totalActualCostMinor, 0) })
  })

  it('C/D: completed manufacturing cancellation creates exactly one Uncollected Product per eligible line without changing payment or cost history', () => {
    const { materialId } = seedCatalog()
    const fixture = customOrder({ lines: 2, paidMajor: 3000, materialId })
    const sheet = issueWorkSheet({ orderId: fixture.order.id }, env.ctx)
    startProduction(sheet.id, env.ctx)
    completeProduction(sheet.id, env.ctx)
    const costBefore = orderCostBreakdown(fixture.order.id)
    const paymentBefore = authoritativeOrderPaymentPosition(fixture.order.id)
    const historyBefore = operationalHistory(fixture.order.id)

    const result = cancelOrder({ orderId: fixture.order.id, reason: 'Customer abandoned completed products' }, env.ctx)

    expect(result.transferredProductIds).toHaveLength(2)
    const products = productsFromOrder(fixture.order.id)
    expect(products).toHaveLength(2)
    expect(new Set(products.map((product) => product.id)).size).toBe(2)
    expect(raw().prepare('SELECT source_order_line_id AS lineId FROM uncollected_products WHERE source_order_id = ? ORDER BY lineId').all(fixture.order.id)).toHaveLength(2)
    expect(products.every((product) => product.status === 'available')).toBe(true)
    expect(operationalHistory(fixture.order.id)).toEqual(historyBefore)
    expect(authoritativeOrderPaymentPosition(fixture.order.id)).toEqual(paymentBefore)
    expect(orderCostBreakdown(fixture.order.id)).toEqual({ ...costBefore,
      actualProfitMinor: Math.max(m(3000) - costBefore.totalActualCostMinor, 0) })
    expect(() => cancelOrder({ orderId: fixture.order.id, reason: 'No duplicate' }, env.ctx)).toThrow()
    expect(productsFromOrder(fixture.order.id)).toHaveLength(2)
  })

  it('G: mixed incomplete abandonment creates no Custom output, releases resale, and leaves unissued Standard Finished Goods untouched', () => {
    const { materialId } = seedCatalog()
    const resaleProductId = createResaleProduct()
    const standardProductId = createProduct({
      code: `BL06-STD-${++sequence}`,
      name: 'BL06 Standard',
      defaultPriceMinor: m(2000)
    }, env.ctx)
    seedFinishedGoods({
      productId: standardProductId,
      qtyMicro: q(3),
      totalCostMinor: m(3000)
    }, env.ctx)
    const readyBefore = onHandMicro(standardProductId)
    const fixture = customOrder({
      materialId,
      extraLines: [
        { lineKind: 'standard', productId: standardProductId, description: 'Standard line', quantityMicro: q(1), unitPriceMinor: m(2000) },
        { lineKind: 'custom', description: 'Resale line', quantityMicro: q(1), unitPriceMinor: m(2500), uncollectedProductId: resaleProductId }
      ]
    })
    const sheet = issueWorkSheet({ orderId: fixture.order.id }, env.ctx)
    startProduction(sheet.id, env.ctx)
    expect(() => cancelProductionOrder({ id: sheet.id, reason: 'Incomplete mixed production abandoned' }, env.ctx)).toThrow(/بعد بدء التصنيع/)

    cancelOrder({ orderId: fixture.order.id, reason: 'Mixed order abandoned' }, env.ctx)

    expect(productsFromOrder(fixture.order.id)).toEqual([])
    expect(getUncollectedProduct(resaleProductId, env.ctx.session)).toMatchObject({
      status: 'available',
      soldOrderId: null,
      soldInvoiceId: null
    })
    expect(onHandMicro(standardProductId)).toBe(readyBefore)
    expect(count("SELECT COUNT(*) AS count FROM finished_goods_movements WHERE order_id = ?", fixture.order.id)).toBe(0)
    expect(getOrder(fixture.order.id).order.status).toBe('cancelled')
    completeProduction(sheet.id, env.ctx)
    expect(productsFromOrder(fixture.order.id)).toHaveLength(1)
  })
})
