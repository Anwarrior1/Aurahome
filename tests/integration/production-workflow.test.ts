import { issueStockForOrder } from '../helpers/finished-goods-fixture'
import { issueWorkSheet as issueLifecycleWorkSheet, completeProduction as completeLifecycleProduction } from '@main/services/production/production.service'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createProduct, replaceBom } from '@main/services/products/products.service'
import { createQuotation, createStandardQuotation, getQuotation } from '@main/services/sales/quotations.service'
import {
  createFinalInvoice, createStandardFinalInvoice, approveFinalInvoice, getFinalInvoice,
  listFinalInvoices, cancelFinalInvoice, updateFinalInvoice, deleteFinalInvoice
} from '@main/services/sales/final-invoices.service'
import {
  recordPayment,
  getOrderOrThrow,
  cancelOrder,
} from '@main/services/sales/orders.service'
import {
  issueWorkSheet,
  issueRelease,
  consumeForOrder,
  recordDelivery,
  cancelDelivery,
  deliveriesForOrder,
  startProduction,
  completeProduction,
  cancelProductionOrder,
  getProductionOrder,
  listWorkSheets,
  listReleases,
  issueStandardStockFromBom,
  releaseWorkersFor,
  fulfillmentStatus,
  hasCompletedProduction
} from '@main/services/production/production.service'
import { onHandMicro, listFinishedGoods } from '@main/services/production/finished-goods.service'
import { createMachine, addMachineUsage } from '@main/services/production/machines.service'
import { createWorker, assignWorkerToOrder, workerBalances } from '@main/services/production/workers.service'
import { orderCostBreakdown, orderCostEstimate } from '@main/services/costing/costing.service'
import { buildFinalInvoice, buildPreliminaryInvoice, buildWorkSheet, buildRelease } from '@main/services/documents/documents.service'
import { renderFinalInvoice, renderPreliminaryInvoice, renderRelease, renderWorkSheet } from '@main/reports/templates/documents.template'
import { savePlannedMaterials, savePlannedMachines, savePlannedWorkers } from '@main/services/planning/planning.service'
import { getRawConnection } from '@main/db/connection'
import { availableQty } from '@main/services/inventory/inventory.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * The production-workflow pass, end to end:
 *
 *   preliminary invoice → order → deposit gate → PRODUCTION ORDER →
 *   material/worker/machine → stages → completion → payment gate →
 *   exit permit → delivery → FINAL INVOICE
 *
 * plus the standard-product paths (manufacture to stock, sell from
 * stock) and the customer-safety guarantees on both printed documents.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function seed() {
  const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
  const materialId = createMaterial({
    sku: 'MDF-18', name: 'لوح MDF', categoryId, unit: 'لوح',
    currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
  } as never, env.ctx)
  const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
  createPurchase({
    supplierId,
    lines: [{ materialId, qtyMicro: quantityFromDisplay(100), unitCostMicro: unitCostFromMajor(100) }]
  }, env.ctx)
  const customerId = createCustomer({ name: 'عميل تجريبي', phone: '0910000000' }, env.ctx)
  return { materialId, customerId }
}

function standardProduct(materialId: number, priceMajor = 6000) {
  const productId = createProduct({ code: 'PRD-1', name: 'خزانة قياسية', defaultPriceMinor: moneyFromMajor(priceMajor) }, env.ctx)
  replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(10), unit: 'لوح', dimensions: '200×60' }], env.ctx)
  return productId
}

/** A custom order of `priceMajor`, paid to the given fraction. */
function customOrder(customerId: number, priceMajor = 6000) {
  const invoice = createFinalInvoice({
    customerId,
    requiresInstallation: true,
    lines: [{
      lineKind: 'custom', description: 'مطبخ حسب الطلب', dimensions: '300×60',
      colorCode: '205', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(priceMajor)
    }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  return { invoiceId: invoice.id, order }
}

/**
 * The order's OWN production configuration — the workflow pass moved
 * internal costing here, so this is where the brief's 4,200 estimate
 * (3,000 material + 700 labour + 300 machine + 200 other) now lives.
 */
function planProduction(orderId: number) {
  const machineId = createMachine({ name: 'آلة القص', costingUnit: 'عملية', defaultRateMicro: unitCostFromMajor(300) }, env.ctx)
  // CC04B: تجهيز الإنتاج names the worker; it is the only authoring source for the commission.
  const workerId = createWorker({ name: 'نجار' }, env.ctx)
  savePlannedMaterials({ orderId }, [
    { materialName: 'لوح MDF', qtyMicro: quantityFromDisplay(30), unit: 'لوح', estimatedUnitCostMicro: unitCostFromMajor(100) }
  ], env.ctx)
  savePlannedMachines({ orderId }, [
    { machineId, machineName: 'آلة القص', usageQtyMicro: quantityFromDisplay(1) }
  ], env.ctx)
  savePlannedWorkers({ orderId }, [
    { workerId, workerName: 'نجار', estimatedCostMinor: moneyFromMajor(700) }
  ], env.ctx)
  getRawConnection().prepare('UPDATE orders SET estimated_other_minor = ? WHERE id = ?')
    .run(moneyFromMajor(200), orderId)
  return { machineId, workerId }
}

describe('Production order lifecycle (items 8/9)', () => {
  it('is the SAME work_sheets record, still linked to its order and traceable to the approved invoice', () => {
    const { customerId } = seed()
    const { invoiceId, order } = customOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)

    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    const detail = getProductionOrder(sheet.id)

    expect(sheet.documentNumber).toMatch(/^MO-\d{4}-\d{4}$/)
    expect(detail.sheet.orderId).toBe(order.id)
    expect(detail.order?.documentNumber).toBe(order.documentNumber)
    expect(getOrderOrThrow(order.id).finalInvoiceId).toBe(invoiceId)
  })

  it('starts ready, moves to in production, then completes', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    expect(getProductionOrder(sheet.id).sheet.status).toBe('ready')
    startProduction(sheet.id, env.ctx)
    expect(getProductionOrder(sheet.id).sheet.status).toBe('in_production')

    completeProduction(sheet.id, env.ctx)
    const done = getProductionOrder(sheet.id).sheet
    expect(done.status).toBe('completed')
    expect(done.completedAt).toBeTruthy()
    expect(hasCompletedProduction(order.id)).toBe(true)
  })

  it('refuses an invalid backward transition', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    completeProduction(sheet.id, env.ctx)

    expect(() => startProduction(sheet.id, env.ctx)).toThrowError(/لا يمكن نقل أمر التصنيع/)
    expect(() => cancelProductionOrder({ id: sheet.id, reason: 'خطأ' }, env.ctx)).toThrowError(/لا يمكن نقل/)
  })

  it('allows manufacturing with no deposit while retaining the receivable', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId)
    expect(issueWorkSheet({ orderId: order.id }, env.ctx).id).toBeGreaterThan(0)
    expect(getOrderOrThrow(order.id).remainingMinor).toBe(order.totalMinor)
  })
})

describe('Material consumption belongs to production (items 12/13)', () => {
  it('REFUSES to consume material before a production order exists', () => {
    const { customerId, materialId } = seed()
    const { order } = customOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)

    expect(() =>
      consumeForOrder({ orderId: order.id, materialId, physicalQtyMicro: quantityFromDisplay(5) }, env.ctx)
    ).toThrowError(/أمر تصنيع/)
    // Stock is untouched by the refused attempt.
    expect(availableQty(materialId)).toBe(quantityFromDisplay(100))
  })

  it('REFUSES to consume against a completed or cancelled production order', () => {
    const { customerId, materialId } = seed()
    const { order } = customOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    completeProduction(sheet.id, env.ctx)

    expect(() =>
      consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(5) }, env.ctx)
    ).toThrowError(/جاهزاً أو قيد التصنيع/)
  })

  it('consumes FIFO against the production order and keeps both links', () => {
    const { customerId, materialId } = seed()
    const { order } = customOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    const result = consumeForOrder(
      { workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(10) },
      env.ctx
    )

    // 10 boards at the FIFO layer cost of 100 = 1,000 actual.
    expect(result.actualCostMinor).toBe(moneyFromMajor(1000))
    expect(availableQty(materialId)).toBe(quantityFromDisplay(90))
    // Visible from the production order AND still costed onto the order.
    expect(getProductionOrder(sheet.id).materialLines).toHaveLength(1)
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(moneyFromMajor(1000))
  })

  it('still blocks negative stock inside production (BR-5 preserved)', () => {
    const { customerId, materialId } = seed()
    const { order } = customOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    expect(() =>
      consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(500) }, env.ctx)
    ).toThrowError(/غير كافية/)
  })
})

describe('Workers and machines on the production order (items 14/15)', () => {
  it('posts machine usage and labour against the production order and onto the order cost', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    // The brief's example: 10 boards × 30 LYD per board = 300.
    const machineId = createMachine({ name: 'آلة القص', costingUnit: 'لوح', defaultRateMicro: unitCostFromMajor(30) }, env.ctx)
    const usage = addMachineUsage({ workSheetId: sheet.id, machineId, usageQtyMicro: quantityFromDisplay(10) }, env.ctx)
    expect(usage.finalAmountMinor).toBe(moneyFromMajor(300))

    const workerId = createWorker({ name: 'أحمد' }, env.ctx)
    assignWorkerToOrder({ workSheetId: sheet.id, workerId, method: 'fixed', amountMinor: moneyFromMajor(700) }, env.ctx)

    const detail = getProductionOrder(sheet.id)
    expect(detail.machineUsage).toHaveLength(1)
    expect(detail.assignments).toHaveLength(1)
    // Traceability to the customer order is preserved in both directions.
    const cost = orderCostBreakdown(order.id)
    expect(cost.machineCostMinor).toBe(moneyFromMajor(300))
    expect(cost.workerCostMinor).toBe(moneyFromMajor(700))
  })

  it('refuses machine usage on a closed production order', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    cancelProductionOrder({ id: sheet.id, reason: 'خطأ في الإصدار' }, env.ctx)
    const machineId = createMachine({ name: 'آلة', costingUnit: 'لوح', defaultRateMicro: unitCostFromMajor(30) }, env.ctx)

    expect(() =>
      addMachineUsage({ workSheetId: sheet.id, machineId, usageQtyMicro: quantityFromDisplay(1) }, env.ctx)
    ).toThrowError(/جاهزاً أو قيد التصنيع/)
  })
})

describe('Estimated vs actual cost (items 16/17)', () => {
  it('matches the brief: estimate 4,200 on a 6,000 sale = 1,800 expected profit', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId, 6000)
    planProduction(order.id)

    const estimate = orderCostEstimate(order.id)
    expect(estimate.estimatedTotalMinor).toBe(moneyFromMajor(4200))
    expect(estimate.sellingPriceMinor).toBe(moneyFromMajor(6000))
    expect(estimate.expectedProfitMinor).toBe(moneyFromMajor(1800))
  })

  it('keeps the estimate and the actual distinct, and reports the variance', () => {
    const { customerId, materialId } = seed()
    const { order } = customOrder(customerId, 6000)
    planProduction(order.id)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    // Actual: 30 boards × 100 = 3,000 material, 500 machine, 950 labour.
    consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(30) }, env.ctx)
    const machineId = createMachine({ name: 'آلة', costingUnit: 'لوح', defaultRateMicro: unitCostFromMajor(50) }, env.ctx)
    addMachineUsage({ workSheetId: sheet.id, machineId, usageQtyMicro: quantityFromDisplay(10) }, env.ctx)
    const workerId = createWorker({ name: 'عامل' }, env.ctx)
    assignWorkerToOrder({ workSheetId: sheet.id, workerId, method: 'fixed', amountMinor: moneyFromMajor(950) }, env.ctx)

    const estimate = orderCostEstimate(order.id)
    expect(estimate.estimatedTotalMinor).toBe(moneyFromMajor(4200)) // unchanged by actuals
    expect(estimate.actualTotalMinor).toBe(moneyFromMajor(4450))
    expect(estimate.expectedProfitMinor).toBe(moneyFromMajor(1800))
    expect(estimate.actualProfitMinor).toBe(moneyFromMajor(1550))
    expect(estimate.varianceMinor).toBe(moneyFromMajor(250))
  })

  it('falls back to the product BOM at market price when no estimate was entered', () => {
    const { customerId, materialId } = seed()
    const productId = standardProduct(materialId)
    const quotation = createStandardFinalInvoice(
      { customerId, productId, quantityMicro: quantityFromDisplay(1) },
      env.ctx
    )
    const order = approveToOrder(quotation.id, env.ctx)

    // BOM is 10 boards; market price 150 → 1,500 estimated material.
    expect(orderCostEstimate(order.id).estimatedMaterialMinor).toBe(moneyFromMajor(1500))
  })
})

describe('Standard product: manufacture to stock, then sell from stock (items 18/19)', () => {
  it('atomic stock production needs no customer and posts finished goods', () => {
    const { materialId } = seed()
    const productId = standardProduct(materialId)

    const result = issueStandardStockFromBom({ productId, quantityMicro: quantityFromDisplay(2), requestKey: 'production-workflow-stock-1' }, env.ctx)
    expect(getProductionOrder(result.workSheetId).sheet.orderId).toBeNull()

    expect(result.finishedGoodsMovementId).toBeTruthy()
    expect(onHandMicro(productId)).toBe(quantityFromDisplay(2))
    // The goods carry their real production cost: 20 boards × 100 = 2,000.
    expect(listFinishedGoods({ productId })[0]?.unitCostMinor).toBe(moneyFromMajor(1000))
  })

  it('sells a standard product out of stock, costing the order at production cost', () => {
    const { customerId, materialId } = seed()
    const productId = standardProduct(materialId)

    // Manufacture 2 into stock.
    issueStandardStockFromBom({ productId, quantityMicro: quantityFromDisplay(2), requestKey: 'production-workflow-stock-2' }, env.ctx)

    // Sell one.
    const quotation = createStandardFinalInvoice(
      { customerId, productId, quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(6000) },
      env.ctx
    )
    const order = approveToOrder(quotation.id, env.ctx)
    issueStockForOrder({ orderId: order.id }, env.ctx)

    expect(onHandMicro(productId)).toBe(quantityFromDisplay(1))
    // Cost of goods sold = the unit's own production cost.
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(moneyFromMajor(1000))
    expect(orderCostBreakdown(order.id).actualProfitMinor).toBe(moneyFromMajor(5000))
  })

  it('refuses to sell more finished goods than exist', () => {
    const { customerId, materialId } = seed()
    const productId = standardProduct(materialId)
    const quotation = createStandardFinalInvoice(
      { customerId, productId, quantityMicro: quantityFromDisplay(5) },
      env.ctx
    )
    const order = approveToOrder(quotation.id, env.ctx)

    expect(() => issueStockForOrder({ orderId: order.id }, env.ctx)).toThrowError(/المخزون الجاهز غير كافٍ/)
  })

  it('builds the standard preliminary invoice from the saved product and its BOM', () => {
    const { customerId, materialId } = seed()
    const productId = standardProduct(materialId)

    const quotation = createStandardQuotation(
      { customerId, productId, quantityMicro: quantityFromDisplay(1), colorCode: '101' },
      env.ctx
    )

    const loaded = getQuotation(quotation.id)
    expect(loaded.lines).toHaveLength(1)
    expect(loaded.lines[0]?.lineKind).toBe('standard')
    expect(loaded.lines[0]?.productId).toBe(productId)
    // BR-46: the BOM was snapshotted without anyone re-entering it.
    expect(loaded.lines[0]?.bomSnapshot).toBeTruthy()
    expect(loaded.quotation.totalMinor).toBe(moneyFromMajor(6000))
  })
})

describe('Exit permit gates (items 21/22)', () => {
  it('BLOCKS the exit permit until production is complete', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId, 6000)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    expect(() => issueRelease({ orderId: order.id, kind: 'installation' }, env.ctx))
      .toThrowError(/إكمال أمر التصنيع/)

    completeProduction(sheet.id, env.ctx)
    expect(issueRelease({ orderId: order.id, kind: 'installation' }, env.ctx).documentNumber)
      .toMatch(/^IA-\d{4}-\d{4}$/)
  })

  it('allows an Exit Permit with a partial balance and snapshots the receivable', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId, 6000)
    // The brief's example: 3,000 + 2,000 = 5,000 paid, 1,000 remaining.
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3000) }, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(2000) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    completeProduction(sheet.id, env.ctx)

    expect(getOrderOrThrow(order.id).remainingMinor).toBe(moneyFromMajor(1000))
    expect(issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx).documentNumber)
      .toMatch(/^DR-\d{4}-\d{4}$/)
    expect(getOrderOrThrow(order.id).remainingMinor).toBe(moneyFromMajor(1000))
  })

  it('keeps the exit permit traceable to its order', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId, 6000)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)
    const release = issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)

    const delivery = recordDelivery({ orderId: order.id, kind: 'delivery', releaseId: release.id }, env.ctx)
    expect(delivery.id).toBeTruthy()
  })
})

/**
 * فريق التركيب/التسليم — item 3: an exit permit's assigned worker is a
 * proper many-to-many (release_workers), never a single id or a
 * comma-separated string. Covers verification cases 1/2/3/4/6 from
 * the brief; case 5 (pre-existing single-worker permits) is covered
 * by every other test above, which issue releases with zero/one
 * worker through the exact same code path — there is no separate
 * legacy column to migrate.
 */
describe('Exit permit installation team (item 3 — multiple workers)', () => {
  it('saves a single worker and returns it as the team', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId, 6000)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)
    const anwar = createWorker({ name: 'أنور' }, env.ctx)

    const release = issueRelease({ orderId: order.id, kind: 'delivery', workerIds: [anwar] }, env.ctx)

    expect(releaseWorkersFor(release.id).map((w) => w.name)).toEqual(['أنور'])
  })

  it('saves three workers on the same exit permit — all three, atomically', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId, 6000)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)
    const anwar = createWorker({ name: 'أنور' }, env.ctx)
    const ahmed = createWorker({ name: 'أحمد' }, env.ctx)
    const salem = createWorker({ name: 'سالم' }, env.ctx)

    const release = issueRelease(
      { orderId: order.id, kind: 'installation', workerIds: [anwar, ahmed, salem] },
      env.ctx
    )

    const team = releaseWorkersFor(release.id).map((w) => w.name)
    expect(team).toHaveLength(3)
    expect(team).toEqual(expect.arrayContaining(['أنور', 'أحمد', 'سالم']))

    // The order/exit-permit list screen — no more '—' when a team exists.
    const listed = listReleases({ orderId: order.id }).items.find((r) => r.id === release.id)
    expect(listed?.workers.map((w) => w.name)).toEqual(expect.arrayContaining(['أنور', 'أحمد', 'سالم']))

    // The printed document prints every name under "فريق التركيب".
    const html = renderRelease(buildRelease(release.id), { name: 'AURA home' })
    expect(html).toContain('فريق التركيب')
    expect(html).toContain('أنور')
    expect(html).toContain('أحمد')
    expect(html).toContain('سالم')
  })

  it('an exit permit issued with no worker still shows "—", never a broken/partial team', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId, 6000)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)

    const release = issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)

    expect(releaseWorkersFor(release.id)).toEqual([])
    const html = renderRelease(buildRelease(release.id), { name: 'AURA home' })
    expect(html).toContain('—')
  })
})

describe('Delivery / installation recording (items 26/27/28/29)', () => {
  function readyOrder(priceMajor = 6000) {
    const { customerId, materialId } = seed()
    const { order } = customOrder(customerId, priceMajor)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(priceMajor) }, env.ctx)
    return { order, materialId }
  }

  it('REFUSES delivery before an exit permit exists', () => {
    const { order } = readyOrder()
    expect(() => recordDelivery({ orderId: order.id, kind: 'delivery' }, env.ctx))
      .toThrowError(/إذن خروج/)
  })

  it('REFUSES delivery while the order is not fully paid', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId, 6000)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)
    issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)

    // A second order that is only part-paid cannot be delivered.
    const other = customOrder(customerId, 4000)
    recordPayment({ orderId: other.order.id, amountMinor: moneyFromMajor(1000) }, env.ctx)
    expect(() => recordDelivery({ orderId: other.order.id, kind: 'delivery' }, env.ctx))
      .toThrowError(/إذن خروج|كامل قيمة الطلب/)
  })

  it('REFUSES delivery while production is unfinished', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId, 6000)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)
    issueWorkSheet({ orderId: order.id }, env.ctx)

    expect(() => recordDelivery({ orderId: order.id, kind: 'handover' }, env.ctx))
      .toThrowError(/إكمال أمر التصنيع/)
  })

  it('records the event with its crew and completes the order', () => {
    const { order } = readyOrder()
    issueRelease({ orderId: order.id, kind: 'installation' }, env.ctx)
    const workerId = createWorker({ name: 'فريق التركيب' }, env.ctx)

    const result = recordDelivery({
      orderId: order.id, kind: 'installation', workerIds: [workerId],
      actualCostMinor: moneyFromMajor(200), notes: 'تم التركيب بالموقع'
    }, env.ctx)

    expect(result.completedAt).toBeTruthy()
    expect(getOrderOrThrow(order.id).status).toBe('completed')
    expect(fulfillmentStatus(order.id)).toBe('installed')
  })

  it('derives combined fulfilment from one combined permit-driven event', () => {
    const { order } = readyOrder()
    issueRelease({ orderId: order.id, kind: 'delivery_installation' }, env.ctx)

    recordDelivery({ orderId: order.id, kind: 'delivery_installation' }, env.ctx)
    expect(fulfillmentStatus(order.id)).toBe('delivered_installed')
    expect(deliveriesForOrder(order.id)).toHaveLength(1)
  })

  it('voids a delivery instead of deleting it, and the status re-derives', () => {
    const { order } = readyOrder()
    issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
    const delivery = recordDelivery({ orderId: order.id, kind: 'delivery' }, env.ctx)
    expect(fulfillmentStatus(order.id)).toBe('delivered')

    cancelDelivery({ id: delivery.id, reason: 'سُجل بالخطأ' }, env.ctx)

    expect(fulfillmentStatus(order.id)).toBe('not_delivered')
    // The historical row itself is still there — voided, never deleted.
    expect(deliveriesForOrder(order.id)).toHaveLength(1)
  })
})

describe('The approved invoice STARTS the workflow (items 30/33/35 + Tests 3/4)', () => {
  function draftInvoice(priceMajor = 6000, existingCustomerId?: number) {
    const customerId = existingCustomerId ?? seed().customerId
    return createFinalInvoice({
      customerId,
      lines: [{
        lineKind: 'custom', description: 'مطبخ حسب الطلب',
        quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(priceMajor)
      }]
    }, env.ctx)
  }

  it('a draft approved invoice exists on its own, with no order behind it', () => {
    const invoice = draftInvoice()
    const loaded = getFinalInvoice(invoice.id)

    expect(invoice.documentNumber).toMatch(/^FI-\d{4}-\d{4}$/)
    expect(loaded.invoice.status).toBe('draft')
    expect(loaded.invoice.orderId).toBeNull()
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM orders').get()).toEqual({ c: 0 })
  })

  it('TEST 3 — approval creates exactly one customer order, and freezes the terms', () => {
    const invoice = draftInvoice(6000)
    const result = approveFinalInvoice(invoice.id, env.ctx)

    expect(result.alreadyApproved).toBe(false)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM orders').get()).toEqual({ c: 1 })

    const loaded = getFinalInvoice(invoice.id)
    expect(loaded.invoice.status).toBe('approved')
    expect(loaded.invoice.orderId).toBe(result.orderId)
    expect(loaded.snapshot.totalMinor).toBe(moneyFromMajor(6000))
    expect(loaded.snapshot.orderNumber).toBe(result.orderNumber)

    const order = getOrderOrThrow(result.orderId)
    expect(order.totalMinor).toBe(moneyFromMajor(6000))
    expect(order.finalInvoiceId).toBe(invoice.id)
  })

  it('TEST 4 — repeating the approval never creates a second order', () => {
    const invoice = draftInvoice(6000)
    const first = approveFinalInvoice(invoice.id, env.ctx)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const retry = approveFinalInvoice(invoice.id, env.ctx)
      expect(retry.alreadyApproved).toBe(true)
      expect(retry.orderId).toBe(first.orderId)
    }
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM orders').get()).toEqual({ c: 1 })
    // …and the database itself refuses a second order for that invoice.
    expect(() =>
      getRawConnection()
        .prepare("INSERT INTO orders (document_number, customer_id, final_invoice_id, status, created_at) VALUES ('SO-DUP', ?, ?, 'confirmed', '2026-01-01')")
        .run(getOrderOrThrow(first.orderId).customerId, invoice.id)
    ).toThrowError(/UNIQUE/)
  })

  it('approving posts nothing else — no stock, no commission, no cash', () => {
    const invoice = draftInvoice(6000)
    approveFinalInvoice(invoice.id, env.ctx)

    const raw = getRawConnection()
    for (const table of ['work_sheets', 'customer_payments', 'order_material_lines', 'order_machine_usage', 'order_worker_assignments', 'worker_transactions', 'cash_transactions']) {
      expect((raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c).toBe(0)
    }
    expect((raw.prepare("SELECT COUNT(*) AS c FROM inventory_movements WHERE kind != 'purchase'").get() as { c: number }).c).toBe(0)
  })

  it('keeps commercial terms frozen while paid/remaining follow the ledger (item 33/35)', () => {
    const invoice = draftInvoice(6000)
    const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
    recordPayment({ orderId, amountMinor: moneyFromMajor(6000) }, env.ctx)

    const loaded = getFinalInvoice(invoice.id)
    expect(loaded.payment.paidMinor).toBe(moneyFromMajor(6000))
    expect(loaded.payment.remainingMinor).toBe(0)
    // The frozen snapshot total never moves, whatever happens later.
    expect(loaded.snapshot.totalMinor).toBe(moneyFromMajor(6000))

    const listed = listFinalInvoices({ orderId }).items
    expect(listed[0]?.paidMinor).toBe(moneyFromMajor(6000))
    expect(listed[0]?.remainingMinor).toBe(0)
  })

  it('an approved invoice cannot be edited, and cannot be voided while its order lives', () => {
    const invoice = draftInvoice(6000)
    const { orderId } = approveFinalInvoice(invoice.id, env.ctx)

    expect(() => updateFinalInvoice(invoice.id, { notes: 'تعديل' }, env.ctx)).toThrowError(/بعد اعتمادها/)
    expect(() => cancelFinalInvoice({ id: invoice.id, reason: 'خطأ' }, env.ctx)).toThrowError(/أنشأت طلب العميل/)

    // Cancelling the order first is what makes voiding it legitimate.
    completeLifecycleProduction(issueLifecycleWorkSheet({ orderId: orderId, overrideDepositRequirement: true }, env.ctx).id, env.ctx)
    cancelOrder({ orderId, reason: 'تراجع العميل' }, env.ctx)
    cancelFinalInvoice({ id: invoice.id, reason: 'خطأ في الإصدار' }, env.ctx)
    expect(getFinalInvoice(invoice.id).invoice.status).toBe('cancelled')
  })

  it('a draft may be deleted outright; an approved one never can', () => {
    const { customerId } = seed()
    const draft = draftInvoice(1000, customerId)
    deleteFinalInvoice(draft.id, env.ctx)
    expect(() => getFinalInvoice(draft.id)).toThrowError(/غير موجودة/)

    const approved = draftInvoice(1000, customerId)
    approveFinalInvoice(approved.id, env.ctx)
    expect(() => deleteFinalInvoice(approved.id, env.ctx)).toThrowError(/لا يمكن حذف/)
  })
})

describe('Customer-safe documents (items 4/5/34)', () => {
  it('the preliminary invoice never carries the internal estimate or any cost', () => {
    const { customerId } = seed()
    const quotation = createQuotation({
      customerId,
      lines: [{
        lineKind: 'custom', description: 'مطبخ حسب الطلب', dimensions: '300×60',
        colorCode: '205', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(6000)
      }]
    }, env.ctx)
    const quotationId = quotation.id

    const dto = buildPreliminaryInvoice(quotationId)
    const html = renderPreliminaryInvoice(dto, { name: 'AURA home' })
    const serialised = JSON.stringify(dto)

    for (const forbidden of ['estimated', 'costMinor', 'actualCost', 'machineCost', 'laborCost', 'profit', 'fifo']) {
      expect(serialised).not.toContain(forbidden)
    }
    // Workflow pass: the preliminary invoice carries no internal
    // manufacturing costing at all any more — it is purely commercial.
    expect(getQuotation(quotationId).quotation.estimatedMaterialMinor).toBe(0)
    expect(html).not.toContain('تكلفة')
  })

  it('the final invoice carries payment status but no internal cost or profit', () => {
    const { customerId, materialId } = seed()
    const { invoiceId, order } = customOrder(customerId, 6000)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(10) }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
    recordDelivery({ orderId: order.id, kind: 'delivery' }, env.ctx)

    const dto = buildFinalInvoice(invoiceId)
    const html = renderFinalInvoice(dto, { name: 'AURA home' })
    const serialised = JSON.stringify(dto)

    for (const forbidden of ['costMinor', 'actualCost', 'machineCost', 'laborCost', 'profit', 'fifo', 'estimated']) {
      expect(serialised).not.toContain(forbidden)
    }
    expect(dto.paymentStatus).toBe('مدفوع بالكامل')
    expect(dto.orderReference).toBe(order.documentNumber)
    expect(html).toContain('فاتورة معتمدة')
    expect(html).not.toContain('تكلفة')
    // The 1,000 of actual FIFO material cost appears nowhere on it.
    expect(html).not.toContain('1.000,00')
  })

  it('the internal production document carries the material report, never costs', () => {
    const { customerId } = seed()
    const { order } = customOrder(customerId, 6000)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    const dto = buildWorkSheet(sheet.id, env.ctx) // admin session
    expect(dto.status).toBe('ready')
    // Item 14: no monetary field exists on this document for any role.
    expect(JSON.stringify(dto)).not.toContain('costBlock')

    // Label change: the rendered report shows "الفني المسؤول", not the
    // old "العامل المسؤول" — the assigned worker value itself is untouched.
    const html = renderWorkSheet(dto, { name: 'AURA home' })
    expect(html).toContain('الفني المسؤول')
    expect(html).not.toContain('العامل المسؤول')
  })
})

describe('Full pipeline, custom order (item 44)', () => {
  it('runs approved invoice → order → production planning → production → permit → delivery', () => {
    const { customerId, materialId } = seed()

    // 1-2. Approved invoice → order, then production planned on the order.
    const { invoiceId, order } = customOrder(customerId, 6000)
    const { workerId } = planProduction(order.id)
    expect(orderCostEstimate(order.id).expectedProfitMinor).toBe(moneyFromMajor(1800))

    // 3. Deposit gate.
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)

    // 4. Production order + real production. Machines and workers come only from تجهيز الإنتاج (CC04B).
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(30) }, env.ctx)
    startProduction(sheet.id, env.ctx)
    completeProduction(sheet.id, env.ctx)

    // 5. Exit Permit issuance does not settle the remaining receivable.
    issueRelease({ orderId: order.id, kind: 'installation' }, env.ctx)

    // 6. Real-world fulfilment.
    recordDelivery({ orderId: order.id, kind: 'installation', actualCostMinor: moneyFromMajor(0) }, env.ctx)
    expect(fulfillmentStatus(order.id)).toBe('installed')

    // 7. The approved invoice retains its outstanding balance.
    const loaded = getFinalInvoice(invoiceId)
    expect(loaded.payment.paidMinor).toBe(moneyFromMajor(3600))
    expect(loaded.payment.remainingMinor).toBe(moneyFromMajor(2400))

    // 8. Internals reconcile: estimate 4,200 vs actual 4,000 (material 3,000 + prepared machine 300 + prepared commission 700).
    const estimate = orderCostEstimate(order.id)
    expect(estimate.estimatedTotalMinor).toBe(moneyFromMajor(4200))
    expect(estimate.actualTotalMinor).toBe(moneyFromMajor(4000))
    expect(estimate.actualProfitMinor).toBe(moneyFromMajor(2000))

    // 9. Worker commission became payable on manufacturing completion (CC04), never netted with debt.
    expect(workerBalances(workerId)).toEqual({ payableMinor: moneyFromMajor(700), debtMinor: 0 })

    // 10. Nothing orphaned: the whole chain is still linked.
    expect(getOrderOrThrow(order.id).finalInvoiceId).toBe(invoiceId)
    expect(listWorkSheets({ orderId: order.id }).items).toHaveLength(1)
    expect(listFinalInvoices({ orderId: order.id }).items).toHaveLength(1)
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
