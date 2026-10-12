import { issueWorkSheet as issueLifecycleWorkSheet, completeProduction as completeLifecycleProduction } from '@main/services/production/production.service'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import {
  listPlannedMachines,
  listPlannedMaterials,
  orderPlanningSnapshot,
  savePlannedMachines,
  savePlannedMaterials,
  savePlannedWorkers
} from '@main/services/planning/planning.service'
import { createCategory, createColor, createMaterial, updateMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createProduct, replaceBom } from '@main/services/products/products.service'
import { createQuotation } from '@main/services/sales/quotations.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrderOrThrow, recordPayment, cancelOrder } from '@main/services/sales/orders.service'
import { consumeForOrder, issueWorkSheet, issueStandardStockFromBom, materialLinesForOrder } from '@main/services/production/production.service'
import { addMachineUsage, createMachine, machineUsageForOrder } from '@main/services/production/machines.service'
import { createWorker } from '@main/services/production/workers.service'
import { createAccount } from '@main/services/finance/cash.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { buildWorkSheet, buildPreliminaryInvoice } from '@main/services/documents/documents.service'
import { renderWorkSheet, renderPreliminaryInvoice } from '@main/reports/templates/documents.template'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * PRELIMINARY INVOICE → CUSTOMER ORDER → PRODUCTION ORDER → FACTORY REPORT.
 *
 * The manufacturing plan is entered once, while pricing, and is carried
 * forward as an immutable snapshot. It is planning, never consumption:
 * no stock moves and no actual cost is created by planning it.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const COMPANY = { name: 'AURA home' }

function seedMasters() {
  createColor({ code: 'W-01', name: 'أبيض تخطيط' }, env.ctx)
  const categoryId = createCategory({ name: 'ألواح' }, env.ctx)
  const mdfId = createMaterial({
    sku: 'MDF-PLAN', name: 'لوح MDF 18مم', categoryId, unit: 'لوح',
    tracksDimensions: true, dimensions: '244×122', thickness: '18مم',
    currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
  } as never, env.ctx)
  const hingeId = createMaterial({
    sku: 'HINGE-PLAN', name: 'مفصلة مخفية', categoryId, unit: 'قطعة',
    currentMarketPriceMicro: unitCostFromMajor(12), pricingRule: 'exact'
  } as never, env.ctx)
  const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
  createPurchase({ supplierId, lines: [
    { materialId: mdfId, qtyMicro: quantityFromDisplay(30), unitCostMicro: unitCostFromMajor(100), batchCode: 'LOT-P' },
    { materialId: hingeId, qtyMicro: quantityFromDisplay(100), unitCostMicro: unitCostFromMajor(8) }
  ] }, env.ctx)
  const customerId = createCustomer({ name: 'عميل' }, env.ctx)
  const cuttingId = createMachine({ name: 'ماكينة قص', costingUnit: 'لوح', defaultRateMicro: unitCostFromMajor(25) }, env.ctx)
  const cncId = createMachine({ name: 'CNC', costingUnit: 'ساعة', defaultRateMicro: unitCostFromMajor(100) }, env.ctx)
  const workerId = createWorker({ name: 'نجار' }, env.ctx)
  const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(50000) }, env.ctx)
  return { categoryId, mdfId, hingeId, customerId, cuttingId, cncId, workerId, accountId }
}

/** A custom job priced with an explicit manufacturing plan. */
/**
 * Workflow pass: the approved invoice creates the order, and the plan
 * is entered on the ORDER — the authoritative planning point.
 */
function plannedOrder(m: ReturnType<typeof seedMasters>, mdfQtyDisplay = 12) {
  const invoice = createFinalInvoice({
    customerId: m.customerId,
    requiresInstallation: true,
    requiresDelivery: true,
    lines: [{
      lineKind: 'custom', description: 'مطبخ MDF مخصص', dimensions: '360×60',
      colorCode: 'W-01', accessories: 'مفصلات مخفية',
      specifications: 'وحدات علوية وسفلية',
      quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(6000)
    }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  savePlannedMaterials({ orderId: order.id }, [
    { materialId: m.mdfId, materialName: 'لوح MDF 18مم', qtyMicro: quantityFromDisplay(mdfQtyDisplay), unit: 'لوح', dimensions: '244×122', thickness: '18مم', colorCode: 'W-01', estimatedUnitCostMicro: unitCostFromMajor(120), notes: 'يُقص حسب المخطط' },
    { materialId: m.hingeId, materialName: 'مفصلة مخفية', qtyMicro: quantityFromDisplay(20), unit: 'قطعة', estimatedUnitCostMicro: unitCostFromMajor(8) }
  ], env.ctx)
  savePlannedMachines({ orderId: order.id }, [
    { machineId: m.cuttingId, machineName: 'ماكينة قص', usageQtyMicro: quantityFromDisplay(12), usageUnit: 'لوح', estimatedCostMinor: moneyFromMajor(300) },
    { machineId: m.cncId, machineName: 'CNC', usageQtyMicro: quantityFromDisplay(4), usageUnit: 'ساعة', estimatedCostMinor: moneyFromMajor(400), notes: 'حفر الواجهات' }
  ], env.ctx)
  savePlannedWorkers({ orderId: order.id }, [
    { workerId: m.workerId, workerName: 'نجار', estimatedCostMinor: moneyFromMajor(800) }
  ], env.ctx)
  getRawConnection().prepare('UPDATE orders SET estimated_other_minor = ? WHERE id = ?')
    .run(moneyFromMajor(200), order.id)
  return { order }
}

/** Pay the deposit — but stop BEFORE any production order exists,
 *  matching exactly what the Customer Order View must show on its own. */
function payDeposit(order: { id: number }, accountId: number) {
  const required = getOrderOrThrow(order.id).depositRequiredMinor
  recordPayment({ orderId: order.id, amountMinor: required, cashAccountId: accountId }, env.ctx)
  return order
}

function issueFor(order: { id: number }, accountId: number) {
  payDeposit(order, accountId)
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
  return { order, sheet }
}

/* ---------------------------------------------------------------- */
describe('preliminary invoice stores the manufacturing plan', () => {
  it('stores planned materials with quantities, units and attributes', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)

    const planned = listPlannedMaterials({ orderId: order.id })
    expect(planned).toHaveLength(2)
    expect(planned[0]).toMatchObject({
      materialName: 'لوح MDF 18مم',
      qtyMicro: quantityFromDisplay(12),
      unit: 'لوح',
      dimensions: '244×122',
      thickness: '18مم',
      colorCode: 'W-01'
    })
    expect(planned[1]).toMatchObject({ materialName: 'مفصلة مخفية', unit: 'قطعة' })
  })

  it('stores planned machines with expected usage', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)

    const machines = listPlannedMachines({ orderId: order.id })
    expect(machines.map((row) => row.machineName)).toEqual(['ماكينة قص', 'CNC'])
    expect(machines[1]).toMatchObject({ usageQtyMicro: quantityFromDisplay(4), usageUnit: 'ساعة' })
  })

  it('derives the internal estimate from the planned lines, never a typed total', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)

    const costing = orderPlanningSnapshot(order.id)
    // 12×120 + 20×8 = 1,600 material; 300+400 = 700 machine; 800 worker; 200 other.
    expect(costing.estimatedMaterialMinor).toBe(moneyFromMajor(1600))
    expect(costing.estimatedMachineMinor).toBe(moneyFromMajor(700))
    expect(costing.estimatedWorkerMinor).toBe(moneyFromMajor(800))
    expect(costing.estimatedOtherMinor).toBe(moneyFromMajor(200))
    expect(costing.totalEstimatedCostMinor).toBe(moneyFromMajor(3300))
    expect(costing.expectedProfitMinor).toBe(moneyFromMajor(2700))
  })

  it('a standard product derives its stock-production plan from the BOM × produced quantity (BL-04)', () => {
    const m = seedMasters()
    const productId = createProduct({
      code: 'STD-1', name: 'خزانة قياسية', defaultPriceMinor: moneyFromMajor(2500),
      bom: [{ materialId: m.mdfId, qtyMicro: quantityFromDisplay(4), unit: 'لوح' }]
    }, env.ctx)
    const invoice = createFinalInvoice({
      customerId: m.customerId,
      lines: [{ lineKind: 'standard', productId, description: 'خزانة قياسية', quantityMicro: quantityFromDisplay(3), unitPriceMinor: moneyFromMajor(2500) }]
    }, env.ctx)
    // A standard customer line is not manufacturing demand: no plan, no Manufacturing Order.
    const order = approveToOrder(invoice.id, env.ctx)
    expect(listPlannedMaterials({ orderId: order.id })).toHaveLength(0)
    expect(() => issueFor(order, m.accountId)).toThrowError(/لا يحتاج أمر تصنيع/)

    // «صرف من المخزون»: BOM 4 boards × 3 produced = 12, with no plan typed by hand.
    const stock = issueStandardStockFromBom({ productId, quantityMicro: quantityFromDisplay(3), requestKey: 'plan-flow-std-1' }, env.ctx)
    const planned = listPlannedMaterials({ workSheetId: stock.workSheetId })
    expect(planned).toHaveLength(1)
    expect(planned[0]!.qtyMicro).toBe(quantityFromDisplay(12))
  })

  it('planning deducts no stock until Manufacturing Order issuance posts its linked materials', () => {
    const m = seedMasters()
    const before = availableQty(m.mdfId)
    const { order } = plannedOrder(m)
    expect(availableQty(m.mdfId)).toBe(before)

    const { sheet } = issueFor(order, m.accountId)

    // The saved plan itself changed no stock; issuing the Manufacturing
    // Order is now the atomic point that posts its 12 linked MDF boards.
    expect(availableQty(m.mdfId)).toBe(before - quantityFromDisplay(12))
    expect(listPlannedMaterials({ workSheetId: sheet.id })).toHaveLength(2)
    const raw = getRawConnection()
    expect((raw.prepare('SELECT COUNT(*) AS c FROM fifo_allocations').get() as { c: number }).c).toBeGreaterThan(0)
    expect((raw.prepare('SELECT COUNT(*) AS c FROM order_material_lines WHERE order_id = ?').get(order.id) as { c: number }).c).toBe(2)
    expect(machineUsageForOrder(order.id)).toHaveLength(0)
  })
})

/* ---------------------------------------------------------------- */
describe('the plan snapshots forward and stays historically stable', () => {
  it('travels quotation → order → production order with no re-entry', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    const { sheet } = issueFor(order, m.accountId)

    const names = (rows: Array<{ materialName: string }>): string[] => rows.map((r) => r.materialName)
    expect(names(listPlannedMaterials({ orderId: order.id }))).toEqual(['لوح MDF 18مم', 'مفصلة مخفية'])
    expect(names(listPlannedMaterials({ workSheetId: sheet.id }))).toEqual(['لوح MDF 18مم', 'مفصلة مخفية'])
    expect(listPlannedMachines({ orderId: order.id }).map((r) => r.machineName)).toEqual(['ماكينة قص', 'CNC'])
    expect(listPlannedMachines({ workSheetId: sheet.id }).map((r) => r.machineName)).toEqual(['ماكينة قص', 'CNC'])

    // The attributes the factory needs travel with it.
    const mdf = listPlannedMaterials({ workSheetId: sheet.id })[0]!
    expect(mdf).toMatchObject({ qtyMicro: quantityFromDisplay(12), unit: 'لوح', dimensions: '244×122', thickness: '18مم', colorCode: 'W-01' })
  })

  it('renaming the material master never rewrites an issued plan', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    const { sheet } = issueFor(order, m.accountId)

    updateMaterial(m.mdfId, { name: 'لوح MDF 18مم (اسم جديد)' } as never, env.ctx)

    for (const scope of [{ orderId: order.id }, { workSheetId: sheet.id }]) {
      expect(listPlannedMaterials(scope)[0]!.materialName).toBe('لوح MDF 18مم')
    }
    // The link to the master is kept for traceability.
    expect(listPlannedMaterials({ workSheetId: sheet.id })[0]!.materialId).toBe(m.mdfId)
  })

  it('changing the product BOM later never rewrites an issued production order', () => {
    const m = seedMasters()
    const productId = createProduct({
      code: 'STD-2', name: 'خزانة قياسية', defaultPriceMinor: moneyFromMajor(2500),
      bom: [{ materialId: m.mdfId, qtyMicro: quantityFromDisplay(12), unit: 'لوح' }]
    }, env.ctx)
    const first = issueStandardStockFromBom({ productId, quantityMicro: quantityFromDisplay(1), requestKey: 'plan-flow-std-2a' }, env.ctx)
    expect(listPlannedMaterials({ workSheetId: first.workSheetId })[0]!.qtyMicro).toBe(quantityFromDisplay(12))

    replaceBom(productId, [{ materialId: m.mdfId, qtyMicro: quantityFromDisplay(10), unit: 'لوح' }], env.ctx)

    // Old production record keeps its 12-board plan…
    expect(listPlannedMaterials({ workSheetId: first.workSheetId })[0]!.qtyMicro).toBe(quantityFromDisplay(12))
    // …while a NEW stock issue picks up the new BOM.
    const later = issueStandardStockFromBom({ productId, quantityMicro: quantityFromDisplay(1), requestKey: 'plan-flow-std-2b' }, env.ctx)
    expect(listPlannedMaterials({ workSheetId: later.workSheetId })[0]!.qtyMicro).toBe(quantityFromDisplay(10))
  })

  it('keeps the order plan editable while the order is open, and freezes it once it closes', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)

    // Open order: the configuration is still the user's to change.
    savePlannedMaterials({ orderId: order.id }, [
      { materialId: m.hingeId, materialName: 'مفصلة مخفية', qtyMicro: quantityFromDisplay(4), unit: 'قطعة' }
    ], env.ctx)
    expect(listPlannedMaterials({ orderId: order.id })).toHaveLength(1)

    // Cancelled order: frozen exactly as it stood.
    completeLifecycleProduction(issueLifecycleWorkSheet({ orderId: order.id, overrideDepositRequirement: true }, env.ctx).id, env.ctx)
    cancelOrder({ orderId: order.id, reason: 'تراجع العميل' }, env.ctx)
    expect(() => savePlannedMaterials({ orderId: order.id }, [], env.ctx)).toThrowError(/ملغى/)
    // …and a preliminary invoice never accepts production planning at all.
    expect(() => savePlannedMaterials({ quotationId: 1 }, [], env.ctx)).toThrowError(/مستند تجاري للعميل فقط/)
  })
})

/* ---------------------------------------------------------------- */
describe('planned is not actual', () => {
  it('actual consumption creates FIFO allocations without touching the plan', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    const { sheet } = issueFor(order, m.accountId)

    // The factory actually issues 13 boards, one more than planned.
    consumeForOrder({ workSheetId: sheet.id, materialId: m.mdfId, physicalQtyMicro: quantityFromDisplay(13) }, env.ctx)

    const raw = getRawConnection()
    expect((raw.prepare('SELECT COUNT(*) AS c FROM fifo_allocations').get() as { c: number }).c).toBeGreaterThan(0)
    expect(availableQty(m.mdfId)).toBe(quantityFromDisplay(5))
    // The plan is untouched: 12 planned, with the automatic issue and
    // later correction represented as distinct actual movements.
    expect(listPlannedMaterials({ workSheetId: sheet.id })[0]!.qtyMicro).toBe(quantityFromDisplay(12))
    expect(materialLinesForOrder(order.id).some((line) => line.physicalQtyMicro === quantityFromDisplay(13))).toBe(true)
  })

  it('a planned machine is not an actual machine posting', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    const { sheet } = issueFor(order, m.accountId)

    expect(listPlannedMachines({ workSheetId: sheet.id })).toHaveLength(2)
    expect(machineUsageForOrder(order.id)).toHaveLength(0)

    addMachineUsage({ workSheetId: sheet.id, machineId: m.cuttingId, usageQtyMicro: quantityFromDisplay(13) }, env.ctx)

    // Actual usage exists now; the plan still says the same two machines.
    expect(machineUsageForOrder(order.id)).toHaveLength(1)
    expect(machineUsageForOrder(order.id)[0]!.finalAmountMinor).toBe(moneyFromMajor(325))
    expect(listPlannedMachines({ workSheetId: sheet.id })).toHaveLength(2)
  })
})

/* ---------------------------------------------------------------- */
describe('production order PDF is a factory instruction, never a price list', () => {
  function html() {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    const { sheet } = issueFor(order, m.accountId)
    consumeForOrder({ workSheetId: sheet.id, materialId: m.mdfId, physicalQtyMicro: quantityFromDisplay(13) }, env.ctx)
    addMachineUsage({ workSheetId: sheet.id, machineId: m.cuttingId, usageQtyMicro: quantityFromDisplay(13) }, env.ctx)
    const dto = buildWorkSheet(sheet.id, env.ctx)
    return { dto, out: renderWorkSheet(dto, COMPANY) }
  }

  it('prints the required materials with quantity, unit and specs', () => {
    const { dto, out } = html()
    expect(dto.requiredMaterials).toHaveLength(2)
    expect(out).toContain('المواد المطلوبة للتصنيع')
    expect(out).toContain('لوح MDF 18مم')
    expect(out).toContain('مفصلة مخفية')
    expect(out).toContain('لوح')
    expect(out).toContain('قطعة')
    expect(out).toContain('244×122')
    expect(out).toContain('18مم')
    expect(out).toContain('يُقص حسب المخطط')
  })

  it('never shows the empty-plan fallback when the snapshot has materials', () => {
    const { out } = html()
    expect(out).not.toContain('لم تُحدَّد مواد للتصنيع بعد')
  })

  it('prints the required machines with their expected usage', () => {
    const { dto, out } = html()
    expect(dto.requiredMachines.map((row) => row.machine)).toEqual(['ماكينة قص', 'CNC'])
    expect(out).toContain('الآلات المطلوبة للتصنيع')
    expect(out).toContain('CNC')
    expect(out).toContain('حفر الواجهات')
  })

  it('carries no monetary field at all', () => {
    const { dto, out } = html()
    // Structural: the DTO has no cost-shaped key anywhere.
    const keys = JSON.stringify(dto).toLowerCase()
    for (const forbidden of ['cost', 'price', 'profit', 'margin', 'minor', 'amount', 'rate']) {
      expect(keys).not.toContain(forbidden)
    }
    // Rendered: none of the figures involved appear, nor a currency.
    for (const figure of ['6.000', '3.300', '1.600', '325', '2.700', '1.300']) {
      expect(out).not.toContain(figure)
    }
    expect(out).not.toContain('د.ل')
    for (const label of ['سعر', 'التكلفة', 'الربح', 'الهامش', 'الإجمالي']) {
      expect(out).not.toContain(label)
    }
  })

  it('renders cleanly with no undefined/null and no empty attribute noise', () => {
    const { out } = html()
    expect(out).not.toContain('undefined')
    expect(out).not.toContain('null')
    expect(out).not.toContain('NaN')
    // A hinge has no dimensions/thickness — it shows a dash, not a blank.
    expect(out).toContain('—')
  })

  it('omits the machine section entirely when the plan names none', () => {
    const m = seedMasters()
    const invoice = createFinalInvoice({
      customerId: m.customerId,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    savePlannedMaterials({ orderId: order.id }, [
      { materialId: m.hingeId, materialName: 'مفصلة مخفية', qtyMicro: quantityFromDisplay(5), unit: 'قطعة' }
    ], env.ctx)
    const { sheet } = issueFor(order, m.accountId)
    const out = renderWorkSheet(buildWorkSheet(sheet.id, env.ctx), COMPANY)

    expect(out).toContain('مفصلة مخفية')
    expect(out).not.toContain('الآلات المطلوبة للتصنيع')
  })
})

/* ---------------------------------------------------------------- */
describe('preliminary invoice PDF is a commercial offer, never a recipe', () => {
  it('shows the product, the selling price and customer-safe specs only', () => {
    const m = seedMasters()
    // The order carries a full internal plan…
    const { order } = plannedOrder(m)
    void order
    // …and the customer's own document, prepared for the same job,
    // still shows nothing but the commercial offer.
    const quotation = createQuotation({
      customerId: m.customerId,
      lines: [{
        lineKind: 'custom', description: 'مطبخ MDF مخصص', dimensions: '360×60',
        colorCode: 'W-01', accessories: 'مفصلات مخفية', specifications: 'وحدات علوية وسفلية',
        quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(6000)
      }]
    }, env.ctx)
    const dto = buildPreliminaryInvoice(quotation.id)
    const out = renderPreliminaryInvoice(dto, COMPANY)

    expect(out).toContain('مطبخ MDF مخصص')
    expect(out).toContain('6.000,00')
    expect(out).toContain('360×60')
    expect(out).toContain('وحدات علوية وسفلية')

    // The internal manufacturing plan is absent — structurally, because
    // CustomerDocumentDTO has no field that could carry it.
    for (const leak of ['لوح MDF 18مم', 'مفصلة مخفية', 'ماكينة قص', 'CNC', 'نجار', '244×122', '18مم']) {
      expect(out).not.toContain(leak)
    }
    // …and so are every internal figure and label.
    for (const leak of ['1.600', '700,00', '800,00', '3.300', '2.700', 'التكلفة', 'الربح', 'الهامش']) {
      expect(out).not.toContain(leak)
    }
    const keys = JSON.stringify(dto)
    for (const forbidden of ['estimated', 'cost', 'profit', 'margin', 'machine', 'worker', 'planned']) {
      expect(keys.toLowerCase()).not.toContain(forbidden)
    }
  })
})

/* ---------------------------------------------------------------- */
/**
 * The Customer Order View is a COMMERCIAL + PLANNING snapshot screen —
 * never actual execution. orderPlanningSnapshot() is what backs it.
 */
describe('Customer Order View reads the planning snapshot, never actual execution', () => {
  it('returns the planned materials — not order_material_lines, not consumption', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    payDeposit(order, m.accountId)

    const snapshot = orderPlanningSnapshot(order.id)

    expect(snapshot.materials).toHaveLength(2)
    expect(snapshot.materials.map((row) => row.materialName)).toEqual(['لوح MDF 18مم', 'مفصلة مخفية'])
    expect(snapshot.materials[0]).toMatchObject({ qtyMicro: quantityFromDisplay(12), unit: 'لوح', dimensions: '244×122', thickness: '18مم' })
    // No production order exists yet at all — the plan is already
    // complete without one.
    const raw = getRawConnection()
    expect((raw.prepare('SELECT COUNT(*) AS c FROM work_sheets WHERE order_id = ?').get(order.id) as { c: number }).c).toBe(0)
    expect((raw.prepare('SELECT COUNT(*) AS c FROM order_material_lines WHERE order_id = ?').get(order.id) as { c: number }).c).toBe(0)
  })

  it('returns the planned machines — not order_machine_usage', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    payDeposit(order, m.accountId)

    const snapshot = orderPlanningSnapshot(order.id)

    expect(snapshot.machines.map((row) => row.machineName)).toEqual(['ماكينة قص', 'CNC'])
    expect(snapshot.machines[1]).toMatchObject({ usageQtyMicro: quantityFromDisplay(4), usageUnit: 'ساعة' })
    expect(machineUsageForOrder(order.id)).toHaveLength(0)
  })

  it('returns the planned workers without any actual worker assignment existing', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    payDeposit(order, m.accountId)

    const snapshot = orderPlanningSnapshot(order.id)

    expect(snapshot.workers.map((row) => row.workerName)).toEqual(['نجار'])
    expect(snapshot.workers[0]).toMatchObject({ estimatedCostMinor: moneyFromMajor(800) })
    const raw = getRawConnection()
    expect((raw.prepare('SELECT COUNT(*) AS c FROM order_worker_assignments WHERE order_id = ?').get(order.id) as { c: number }).c).toBe(0)
  })

  it('derives the estimate from the order\'s own frozen columns, matching the quotation it came from', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    payDeposit(order, m.accountId)

    const snapshot = orderPlanningSnapshot(order.id)

    // 12×120 + 20×8 = 1,600 material; 300+400 = 700 machine; 800 worker; 200 other.
    expect(snapshot.estimatedMaterialMinor).toBe(moneyFromMajor(1600))
    expect(snapshot.estimatedMachineMinor).toBe(moneyFromMajor(700))
    expect(snapshot.estimatedWorkerMinor).toBe(moneyFromMajor(800))
    expect(snapshot.estimatedOtherMinor).toBe(moneyFromMajor(200))
    expect(snapshot.totalEstimatedCostMinor).toBe(moneyFromMajor(3300))
    expect(snapshot.sellingPriceMinor).toBe(moneyFromMajor(6000))
    expect(snapshot.expectedProfitMinor).toBe(moneyFromMajor(2700))
  })

  it('reading the snapshot creates no inventory movement, FIFO allocation, machine usage or worker transaction', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    payDeposit(order, m.accountId)
    const stockBefore = availableQty(m.mdfId)
    const raw = getRawConnection()
    const countBefore = (table: string): number => (raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
    const before = {
      movements: countBefore('inventory_movements'),
      allocations: countBefore('fifo_allocations'),
      machineUsage: countBefore('order_machine_usage'),
      workerTx: countBefore('worker_transactions'),
      assignments: countBefore('order_worker_assignments')
    }

    // Simulate opening the Customer Order View — read it several times,
    // exactly as a page reload / repeated navigation would.
    orderPlanningSnapshot(order.id)
    orderPlanningSnapshot(order.id)
    orderPlanningSnapshot(order.id)

    expect(availableQty(m.mdfId)).toBe(stockBefore)
    expect(countBefore('inventory_movements')).toBe(before.movements)
    expect(countBefore('fifo_allocations')).toBe(before.allocations)
    expect(countBefore('order_machine_usage')).toBe(before.machineUsage)
    expect(countBefore('worker_transactions')).toBe(before.workerTx)
    expect(countBefore('order_worker_assignments')).toBe(before.assignments)
  })

  it('the snapshot never changes after later material master or BOM edits', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    payDeposit(order, m.accountId)
    const before = orderPlanningSnapshot(order.id)

    updateMaterial(m.mdfId, { name: 'لوح MDF 18مم (اسم جديد)', currentMarketPriceMicro: unitCostFromMajor(999) } as never, env.ctx)

    const after = orderPlanningSnapshot(order.id)
    expect(after.materials[0]!.materialName).toBe('لوح MDF 18مم')
    expect(after).toEqual(before)
  })

  it('actual production consumption never overwrites the Customer Order\'s planned quantities', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    payDeposit(order, m.accountId)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    // The factory actually consumes 13, one more than the 12 planned.
    consumeForOrder({ workSheetId: sheet.id, materialId: m.mdfId, physicalQtyMicro: quantityFromDisplay(13) }, env.ctx)

    const snapshot = orderPlanningSnapshot(order.id)
    expect(snapshot.materials[0]!.qtyMicro).toBe(quantityFromDisplay(12))
    expect(materialLinesForOrder(order.id).some((line) => line.physicalQtyMicro === quantityFromDisplay(13))).toBe(true)
  })

  it('shows an empty, neutral state — never actual consumption — for a legitimate order with no plan', () => {
    const m = seedMasters()
    const invoice = createFinalInvoice({
      customerId: m.customerId,
      lines: [{ lineKind: 'custom', description: 'بند بلا خطة', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    payDeposit(order, m.accountId)

    const snapshot = orderPlanningSnapshot(order.id)

    expect(snapshot.materials).toEqual([])
    expect(snapshot.machines).toEqual([])
    expect(snapshot.workers).toEqual([])
  })
})

/* ---------------------------------------------------------------- */
describe('Production Order retains actual execution after the Customer Order refactor', () => {
  it('still supports actual FIFO consumption, machine usage and worker assignment against the work sheet', () => {
    const m = seedMasters()
    const { order } = plannedOrder(m)
    const { sheet } = issueFor(order, m.accountId)

    consumeForOrder({ workSheetId: sheet.id, materialId: m.mdfId, physicalQtyMicro: quantityFromDisplay(13) }, env.ctx)
    addMachineUsage({ workSheetId: sheet.id, machineId: m.cuttingId, usageQtyMicro: quantityFromDisplay(13) }, env.ctx)

    expect(availableQty(m.mdfId)).toBe(quantityFromDisplay(5))
    expect(materialLinesForOrder(order.id)).toHaveLength(3)
    expect(machineUsageForOrder(order.id)).toHaveLength(1)
    const raw = getRawConnection()
    expect((raw.prepare('SELECT COUNT(*) AS c FROM fifo_allocations').get() as { c: number }).c).toBeGreaterThan(0)
  })
})
