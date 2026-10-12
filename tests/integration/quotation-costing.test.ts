import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCategory, createColor, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createProduct, replaceBom } from '@main/services/products/products.service'
import { createQuotation, getQuotation, deleteQuotation } from '@main/services/sales/quotations.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import {
  recordPayment,
  getOrderOrThrow,
  deleteOrder,
  orderDeletionBlockers,
  cancelOrder
} from '@main/services/sales/orders.service'
import {
  issueWorkSheet,
  issueRelease,
  recordDelivery,
  consumeForOrder,
  completeProduction,
  cancelProductionOrder,
  deleteProductionOrder,
  productionDeletionBlockers,
  getProductionOrder,
  listWorkSheets, issueStandardStockFromBom } from '@main/services/production/production.service'
import {
  savePlannedMaterials,
  savePlannedMachines,
  savePlannedWorkers,
  listPlannedMaterials,
  orderPlanningSnapshot
} from '@main/services/planning/planning.service'
import { buildFinalInvoice, buildWorkSheet } from '@main/services/documents/documents.service'
import { renderFinalInvoice, renderWorkSheet } from '@main/reports/templates/documents.template'
import { createStandardFinalInvoice, getFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { auditLog } from '@main/db/schema/audit.schema'
import { eq, desc } from 'drizzle-orm'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import { createMachine } from '@main/services/production/machines.service'

/**
 * The refinement pass:
 *
 *  • the preliminary invoice as an internal pricing tool — planned
 *    materials/machines/workers, a total estimated operating cost, and
 *    a MANUALLY chosen selling price;
 *  • those planned materials flowing forward, frozen, into the
 *    production order's factory material report;
 *  • the factory print carrying no money at all;
 *  • safe delete rules for quotations, orders and production orders.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function seed() {
  createColor({ code: 'أبيض مطفي', name: 'أبيض مطفي' }, env.ctx)
  const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
  const mdf = createMaterial({
    sku: 'MDF-18', name: 'لوح MDF 18مم', categoryId, unit: 'لوح',
    currentMarketPriceMicro: unitCostFromMajor(250), pricingRule: 'exact'
  } as never, env.ctx)
  const hinge = createMaterial({
    sku: 'HNG-1', name: 'مفصلات هيدروليك', categoryId, unit: 'قطعة',
    currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact'
  } as never, env.ctx)
  const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
  createPurchase({
    supplierId,
    lines: [
      { materialId: mdf, qtyMicro: quantityFromDisplay(100), unitCostMicro: unitCostFromMajor(200) },
      { materialId: hinge, qtyMicro: quantityFromDisplay(200), unitCostMicro: unitCostFromMajor(8) }
    ]
  }, env.ctx)
  const customerId = createCustomer({ name: 'test customer', phone: '0911111111' }, env.ctx)
  return { mdf, hinge, customerId }
}

/** The brief's exact scenario: a 6,000 LYD custom MDF kitchen. */
function customKitchen(customerId: number) {
  return createFinalInvoice({
    customerId,
    requiresInstallation: true,
    requiresDelivery: true,
    depositPercentBp: 6000,
    lines: [{
      lineKind: 'custom',
      description: 'مطبخ MDF حسب الطلب',
      dimensions: '10م × 2.4م',
      colorCode: 'أبيض مطفي',
      accessories: 'مفصلات هيدروليك، مجاري ناعمة',
      specifications: 'وحدات علوية وسفلية',
      quantityMicro: quantityFromDisplay(1),
      unitPriceMinor: moneyFromMajor(6000)
    }]
  }, env.ctx)
}

/** Prices the brief's estimate onto the ORDER (the planning point). */
function priceIt(orderId: number, mdf: number, hinge: number) {
  const machineId = createMachine({
    name: 'آلة القص', costingUnit: 'لوح', defaultRateMicro: unitCostFromMajor(400 / 12)
  }, env.ctx)
  savePlannedMaterials({ orderId }, [
    {
      materialId: mdf, materialName: 'لوح MDF 18مم', qtyMicro: quantityFromDisplay(12),
      unit: 'لوح', dimensions: '244×122', thickness: '18مم', colorCode: 'أبيض مطفي',
      estimatedUnitCostMicro: unitCostFromMajor(240)
    },
    {
      materialId: hinge, materialName: 'مفصلات هيدروليك', qtyMicro: quantityFromDisplay(20),
      unit: 'قطعة', estimatedUnitCostMicro: unitCostFromMajor(6)
    }
  ], env.ctx)
  savePlannedMachines({ orderId }, [
    { machineId, machineName: 'آلة القص', usageQtyMicro: quantityFromDisplay(12), usageUnit: 'لوح' }
  ], env.ctx)
  savePlannedWorkers({ orderId }, [
    { workerName: 'نجار', estimatedCostMinor: moneyFromMajor(600) }
  ], env.ctx)
  // Direct cost with no planned lines behind it stays manual.
  getRawConnection().prepare('UPDATE orders SET estimated_other_minor = ? WHERE id = ?')
    .run(moneyFromMajor(200), orderId)
}

/** The brief's kitchen, approved into the order it is planned on. */
function kitchenOrder(customerId: number, mdf?: number, hinge?: number) {
  const invoice = customKitchen(customerId)
  const order = approveToOrder(invoice.id, env.ctx)
  if (mdf !== undefined && hinge !== undefined) priceIt(order.id, mdf, hinge)
  return { invoice, order }
}

describe('Preliminary invoice as an internal pricing tool (items 1/2)', () => {
  it('totals materials + machines + workers + other into an estimated operating cost', () => {
    const { customerId, mdf, hinge } = seed()
    const { order } = kitchenOrder(customerId, mdf, hinge)

    const costing = orderPlanningSnapshot(order.id)
    // 12 boards × 240 = 2,880, plus 20 hinges × 6 = 120 → 3,000.
    expect(costing.estimatedMaterialMinor).toBe(moneyFromMajor(3000))
    expect(costing.estimatedMachineMinor).toBe(moneyFromMajor(400))
    expect(costing.estimatedWorkerMinor).toBe(moneyFromMajor(600))
    expect(costing.estimatedOtherMinor).toBe(moneyFromMajor(200))
    expect(costing.totalEstimatedCostMinor).toBe(moneyFromMajor(4200))
  })

  it('leaves the selling price to the user and derives expected profit from it', () => {
    const { customerId, mdf, hinge } = seed()
    const { order } = kitchenOrder(customerId, mdf, hinge)

    const costing = orderPlanningSnapshot(order.id)
    // The price the user typed — never forced to follow the cost.
    expect(costing.sellingPriceMinor).toBe(moneyFromMajor(6000))
    expect(costing.expectedProfitMinor).toBe(moneyFromMajor(1800))
  })

  it('recalculates the estimate whenever a planned line changes', () => {
    const { customerId, mdf, hinge } = seed()
    const { order } = kitchenOrder(customerId, mdf, hinge)

    savePlannedMaterials({ orderId: order.id }, [
      { materialId: mdf, materialName: 'لوح MDF 18مم', qtyMicro: quantityFromDisplay(13), unit: 'لوح', estimatedUnitCostMicro: unitCostFromMajor(240) }
    ], env.ctx)

    const costing = orderPlanningSnapshot(order.id)
    expect(costing.estimatedMaterialMinor).toBe(moneyFromMajor(3120))
    expect(costing.totalEstimatedCostMinor).toBe(moneyFromMajor(4320))
    expect(costing.expectedProfitMinor).toBe(moneyFromMajor(1680))
  })

  it('reuses the raw-material master rather than duplicating it', () => {
    const { customerId, mdf, hinge } = seed()
    const { order } = kitchenOrder(customerId, mdf, hinge)

    const lines = listPlannedMaterials({ orderId: order.id })
    expect(lines[0]?.materialId).toBe(mdf)
    expect(lines[1]?.materialId).toBe(hinge)
  })

  it('refuses production planning on a preliminary invoice — it belongs to the order', () => {
    const { customerId } = seed()
    const quotation = createQuotation({
      customerId,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)

    expect(() =>
      savePlannedMaterials({ quotationId: quotation.id }, [], env.ctx)
    ).toThrowError(/مستند تجاري للعميل فقط/)
  })
})

describe('The customer document stays customer-safe (item 3)', () => {
  it('shows the requested specification but never the internal costing', () => {
    const { customerId, mdf, hinge } = seed()
    const { invoice, order } = kitchenOrder(customerId, mdf, hinge)
    void order

    const dto = buildFinalInvoice(invoice.id)
    const html = renderFinalInvoice(dto, { name: 'AURA home' })
    const serialised = JSON.stringify(dto)

    // No internal costing field of any kind reaches the DTO.
    for (const forbidden of ['estimated', 'plannedMaterial', 'costMinor', 'unitCostMicro', 'machineCost', 'profit', 'fifo']) {
      expect(serialised).not.toContain(forbidden)
    }
    // None of the internal figures appear in the rendered document.
    // (Only distinctive totals are asserted — 400/600 would collide with
    // the legitimate 2.400,00 remaining balance and 6.000,00 total.)
    for (const figure of ['3.000,00', '4.200,00', '1.800,00']) {
      expect(html).not.toContain(figure)
    }
    expect(html).not.toContain('ربح')
    expect(html).not.toContain('هامش')
    // What the customer SHOULD see is all there.
    expect(html).toContain('6.000,00') // the selling price
    expect(html).toContain('10م × 2.4م') // requested dimensions
    expect(html).toContain('أبيض مطفي') // requested finish
    expect(html).not.toContain('تكلفة')
  })
})

describe('Planned materials flow forward, frozen (items 10/15)', () => {
  function upToProduction() {
    const { customerId, mdf, hinge } = seed()
    const { invoice, order } = kitchenOrder(customerId, mdf, hinge)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    return { invoiceId: invoice.id, order, sheet, mdf, hinge }
  }

  it('carries the order plan on to the production order', () => {
    const { order, sheet } = upToProduction()

    expect(listPlannedMaterials({ orderId: order.id })).toHaveLength(2)
    expect(listPlannedMaterials({ orderId: order.id })).toHaveLength(2)

    const sheetLines = listPlannedMaterials({ workSheetId: sheet.id })
    expect(sheetLines).toHaveLength(2)
    expect(sheetLines[0]?.materialName).toBe('لوح MDF 18مم')
    expect(sheetLines[0]?.qtyMicro).toBe(quantityFromDisplay(12))
    expect(sheetLines[0]?.thickness).toBe('18مم')
  })

  it('lets the factory adjust 12 boards to 13 WITHOUT rewriting the order plan', () => {
    const { order, sheet, mdf } = upToProduction()

    savePlannedMaterials({ workSheetId: sheet.id }, [
      { materialId: mdf, materialName: 'لوح MDF 18مم', qtyMicro: quantityFromDisplay(13), unit: 'لوح', thickness: '18مم' }
    ], env.ctx)

    // The production order reflects the technical review...
    expect(listPlannedMaterials({ workSheetId: sheet.id })[0]?.qtyMicro).toBe(quantityFromDisplay(13))
    // ...while the approved preliminary invoice stays historically true.
    expect(listPlannedMaterials({ orderId: order.id })[0]?.qtyMicro).toBe(quantityFromDisplay(12))
    expect(orderPlanningSnapshot(order.id).estimatedMaterialMinor).toBe(moneyFromMajor(3000))
    // And so does the order's own frozen copy.
    expect(listPlannedMaterials({ orderId: order.id })[0]?.qtyMicro).toBe(quantityFromDisplay(12))
  })

  it('audits the production-order material adjustment', () => {
    const { sheet, mdf } = upToProduction()
    savePlannedMaterials({ workSheetId: sheet.id }, [
      { materialId: mdf, materialName: 'لوح MDF 18مم', qtyMicro: quantityFromDisplay(13) }
    ], env.ctx)

    const [event] = getDatabase().select().from(auditLog)
      .where(eq(auditLog.action, 'production.plannedMaterials.update'))
      .orderBy(desc(auditLog.id)).limit(1).all()
    expect(event).toBeTruthy()
    expect(event!.userId).toBe(env.ctx.session.user.id)
  })

  it('keeps planned quantities separate from actual FIFO consumption (item 15)', () => {
    const { sheet, mdf } = upToProduction()

    // Planned 12, actually consumed 13.
    consumeForOrder({ workSheetId: sheet.id, materialId: mdf, physicalQtyMicro: quantityFromDisplay(13) }, env.ctx)

    const detail = getProductionOrder(sheet.id)
    expect(detail.plannedMaterials[0]?.qtyMicro).toBe(quantityFromDisplay(12)) // plan untouched
    const correction = detail.materialLines.find((line) => line.physicalQtyMicro === quantityFromDisplay(13))
    expect(correction?.physicalQtyMicro).toBe(quantityFromDisplay(13)) // later correction recorded too
    // 13 boards at the FIFO layer cost of 200 = 2,600 actual.
    expect(correction?.actualCostMinor).toBe(moneyFromMajor(2600))
  })

  it('derives the material report from the saved BOM for a standard product (item 4)', () => {
    const { customerId, mdf } = seed()
    const productId = createProduct({ code: 'KIT-1', name: 'مطبخ قياسي', defaultPriceMinor: moneyFromMajor(5000) }, env.ctx)
    replaceBom(productId, [{ materialId: mdf, qtyMicro: quantityFromDisplay(8), unit: 'لوح', dimensions: '244×122' }], env.ctx)

    const quotation = createStandardFinalInvoice(
      { customerId, productId, quantityMicro: quantityFromDisplay(2) },
      env.ctx
    )
    const order = approveToOrder(quotation.id, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)
    // BL-04: the standard sale is supplied from ready stock, never a customer MO;
    // the BOM report belongs to «صرف من المخزون» for the produced quantity.
    expect(() => issueWorkSheet({ orderId: order.id }, env.ctx)).toThrowError(/لا يحتاج أمر تصنيع/)
    const sheet = { id: issueStandardStockFromBom({ productId, quantityMicro: quantityFromDisplay(2), requestKey: 'quotation-costing-std' }, env.ctx).workSheetId }

    const lines = listPlannedMaterials({ workSheetId: sheet.id })
    expect(lines).toHaveLength(1)
    // 8 boards per unit × 2 produced — nobody re-entered the BOM.
    expect(lines[0]?.qtyMicro).toBe(quantityFromDisplay(16))
    expect(lines[0]?.materialId).toBe(mdf)
  })
})

describe('Factory production order print (items 13/14)', () => {
  it('contains the material report and the order specification', () => {
    const { customerId, mdf, hinge } = seed()
    const { order } = kitchenOrder(customerId, mdf, hinge)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    const dto = buildWorkSheet(sheet.id, env.ctx)
    const html = renderWorkSheet(dto, { name: 'AURA home' })

    expect(dto.documentNumber).toMatch(/^MO-/)
    expect(dto.orderNumber).toBe(order.documentNumber)
    expect(dto.requiredMaterials).toHaveLength(2)
    expect(html).toContain('أمر تصنيع')
    expect(html).toContain('المواد المطلوبة للتصنيع')
    expect(html).toContain('لوح MDF 18مم')
    expect(html).toContain('مفصلات هيدروليك')
    expect(html).toContain('10م × 2.4م')
    expect(html).toContain('18مم')
    expect(html).toContain('يشمل تركيباً')
  })

  it('contains NO price, cost, selling price or profit anywhere', () => {
    const { customerId, mdf, hinge } = seed()
    const { order } = kitchenOrder(customerId, mdf, hinge)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    const dto = buildWorkSheet(sheet.id, env.ctx)
    const html = renderWorkSheet(dto, { name: 'AURA home' })

    // The DTO has no monetary field to print, and the rendered document
    // carries no currency at all — the strongest available assertions.
    // (Bare digits are not asserted: they collide with dimensions like
    // 244×122 and with CSS values such as font-weight:600.)
    expect(JSON.stringify(dto)).not.toContain('Cost')
    expect(JSON.stringify(dto)).not.toContain('price')
    expect(html).not.toContain('د.ل')
    for (const label of ['تكلفة', 'سعر', 'ربح', 'هامش', 'الإجمالي']) {
      expect(html).not.toContain(label)
    }
  })
})

describe('Production completes without any stage workflow (items 7/12)', () => {
  it('goes ready → completed with one audited action', () => {
    const { customerId, mdf, hinge } = seed()
    const { order } = kitchenOrder(customerId, mdf, hinge)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    // No stages to start, finish or skip — it just completes.
    expect(completeProduction(sheet.id, env.ctx).completedAt).toBeTruthy()
    expect(getProductionOrder(sheet.id).sheet.status).toBe('completed')
  })
})

describe('Safe delete rules (items 19–23)', () => {
  function pricedDraft() {
    const { customerId, mdf, hinge } = seed()
    const { invoice, order } = kitchenOrder(customerId, mdf, hinge)
    return { invoice, order, customerId, mdf, hinge }
  }

  it('hard-deletes a draft preliminary invoice together with its lines', () => {
    const { customerId } = seed()
    const quotation = createQuotation({
      customerId,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)

    deleteQuotation({ id: quotation.id }, env.ctx)

    expect(() => getQuotation(quotation.id)).toThrowError(/غير موجود/)
  })

  it('preserves an approved customer order and its invoice even before operational work starts', () => {
    const { invoice, order } = pricedDraft()

    expect(orderDeletionBlockers(order.id).join(' ')).toMatch(/سجل تجاري مُرحّل/)
    expect(() => deleteOrder(order.id, env.ctx)).toThrow(/سجل تجاري مُرحّل/)

    expect(getOrderOrThrow(order.id).id).toBe(order.id)
    expect(getFinalInvoice(invoice.id).invoice.status).toBe('approved')
    expect(getFinalInvoice(invoice.id).invoice.orderId).toBe(order.id)
    expect(listPlannedMaterials({ orderId: order.id }).length).toBeGreaterThan(0)
  })

  it('REFUSES to hard-delete an order that has taken a payment', () => {
    const { order } = pricedDraft()
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)

    expect(orderDeletionBlockers(order.id)).toContain('توجد دفعات مسجّلة على الطلب')
    expect(() => deleteOrder(order.id, env.ctx)).toThrowError(/استرداد كامل/)
    // Pre-manufacturing cancellation is blocked independently of payment.
    expect(() => cancelOrder({ orderId: order.id, reason: 'اختبار' }, env.ctx)).toThrowError(/قبل (إصدار|اكتمال)/)
    const unchanged = getOrderOrThrow(order.id)
    expect(unchanged.status).toBe('confirmed')
    expect(unchanged.paidMinor).toBe(moneyFromMajor(3600))
  })

  it('REFUSES to hard-delete an order that already has a production order', () => {
    const { order } = pricedDraft()
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    issueWorkSheet({ orderId: order.id }, env.ctx)

    expect(orderDeletionBlockers(order.id)).toContain('صدر أمر تصنيع لهذا الطلب')
    expect(() => deleteOrder(order.id, env.ctx)).toThrowError(/لا يمكن حذف الطلب/)
  })

  it('hard-deletes an unused production order with its material report', () => {
    const { order } = pricedDraft()
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    savePlannedMaterials({ orderId: order.id }, [], env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    expect(productionDeletionBlockers(sheet.id)).toHaveLength(0)
    expect(() => deleteProductionOrder(sheet.id, env.ctx)).toThrow(/مستند تشغيلي مُصدر/)

    expect(listWorkSheets({ orderId: order.id }).items).toHaveLength(1)
    expect(listPlannedMaterials({ workSheetId: sheet.id })).toHaveLength(0)
  })

  it('REFUSES to hard-delete a production order that consumed stock, and cancels instead', () => {
    const { order, mdf } = pricedDraft()
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    consumeForOrder({ workSheetId: sheet.id, materialId: mdf, physicalQtyMicro: quantityFromDisplay(5) }, env.ctx)

    expect(productionDeletionBlockers(sheet.id)).toContain('صُرفت مواد فعلية من المخزون على هذا الأمر')
    expect(() => deleteProductionOrder(sheet.id, env.ctx)).toThrowError(/مستند تشغيلي مُصدر/)

    // Cancelling keeps the FIFO history exactly where it is.
    cancelProductionOrder({ id: sheet.id, reason: 'إعادة تخطيط' }, env.ctx)
    const detail = getProductionOrder(sheet.id)
    expect(detail.sheet.status).toBe('cancelled')
    expect(detail.materialLines).toHaveLength(3)
  })

  it('REFUSES to hard-delete a completed production order (the exit permit depends on it)', () => {
    const { order } = pricedDraft()
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    completeProduction(sheet.id, env.ctx)

    expect(() => deleteProductionOrder(sheet.id, env.ctx)).toThrowError(/مستند تشغيلي مُصدر/)
  })

  it('does not audit a posted order as deleted when deletion is refused', () => {
    const { order } = pricedDraft()
    expect(() => deleteOrder(order.id, env.ctx)).toThrow(/سجل تجاري مُرحّل/)

    const [event] = getDatabase().select().from(auditLog)
      .where(eq(auditLog.action, 'orders.delete'))
      .orderBy(desc(auditLog.id)).limit(1).all()
    expect(event).toBeUndefined()
    expect(getOrderOrThrow(order.id).documentNumber).toBe(order.documentNumber)
  })
})

describe('The brief\'s exact manual scenario, end to end (item 26)', () => {
  it('runs approved invoice → order → planning → production → permit → delivery', () => {
    const { customerId, mdf, hinge } = seed()

    // 1-4. The approved invoice creates the order; production is then
    //      planned on the order, which is the authoritative place for it.
    const { invoice, order } = kitchenOrder(customerId, mdf, hinge)
    expect(getOrderOrThrow(order.id).totalMinor).toBe(moneyFromMajor(6000))
    expect(orderPlanningSnapshot(order.id).totalEstimatedCostMinor).toBe(moneyFromMajor(4200))
    expect(orderPlanningSnapshot(order.id).expectedProfitMinor).toBe(moneyFromMajor(1800))

    // 5-8. The customer's own document never carries that estimate.
    expect(renderFinalInvoice(buildFinalInvoice(invoice.id), { name: 'AURA home' }))
      .not.toContain('4.200,00')

    // 9-14. Deposit, production order, planned materials already there.
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    expect(listPlannedMaterials({ workSheetId: sheet.id })).toHaveLength(2)

    // 15-16. Adjust to 13 boards without touching the quotation.
    savePlannedMaterials({ workSheetId: sheet.id }, [
      { materialId: mdf, materialName: 'لوح MDF 18مم', qtyMicro: quantityFromDisplay(13), unit: 'لوح', thickness: '18مم', colorCode: 'أبيض مطفي' },
      { materialId: hinge, materialName: 'مفصلات هيدروليك', qtyMicro: quantityFromDisplay(20), unit: 'قطعة' }
    ], env.ctx)
    expect(listPlannedMaterials({ orderId: order.id })[0]?.qtyMicro).toBe(quantityFromDisplay(12))

    // 17-19. Factory print: materials yes, money no.
    const factoryHtml = renderWorkSheet(buildWorkSheet(sheet.id, env.ctx), { name: 'AURA home' })
    expect(factoryHtml).toContain('المواد المطلوبة للتصنيع')
    expect(factoryHtml).not.toContain('د.ل')

    // 20. Complete, with no stage workflow in the way.
    completeProduction(sheet.id, env.ctx)

    // 21-24. The Exit Permit preserves the unpaid receivable.
    expect(getOrderOrThrow(order.id).remainingMinor).toBe(moneyFromMajor(2400))
    const permit = issueRelease({ orderId: order.id, kind: 'installation' }, env.ctx)
    expect(permit.documentNumber).toMatch(/^IA-/)

    // 26-29. Delivery closes it out; the approved invoice retains AR.
    recordDelivery({ orderId: order.id, kind: 'installation' }, env.ctx)
    expect(invoice.documentNumber).toMatch(/^FI-/)
    expect(getFinalInvoice(invoice.id).payment.remainingMinor).toBe(moneyFromMajor(2400))
  })
})
