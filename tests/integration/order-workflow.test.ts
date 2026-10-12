import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createQuotation, issueQuotation, getQuotation, createRevision } from '@main/services/sales/quotations.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment, getOrderOrThrow, cancelOrder } from '@main/services/sales/orders.service'
import { issueWorkSheet, issueRelease, consumeForOrder, recordDelivery } from '@main/services/production/production.service'
import { createMachine, addMachineUsage } from '@main/services/production/machines.service'
import { createWorker, assignWorkerToOrder, workerBalances, recordWorkerTransaction } from '@main/services/production/workers.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function seed() {
  const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
  const materialId = createMaterial(
    {
      sku: 'MDF-18', name: 'لوح MDF', categoryId, unit: 'لوح',
      currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
    } as never,
    env.ctx
  )
  const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
  createPurchase({
    supplierId,
    lines: [{ materialId, qtyMicro: quantityFromDisplay(50), unitCostMicro: unitCostFromMajor(100) }]
  }, env.ctx)
  const customerId = createCustomer({ name: 'عميل تجريبي', phone: '0910000000' }, env.ctx)
  return { materialId, customerId }
}

/** A 10,000 LYD quotation → order, so the 60% deposit is 6,000. */
function makeOrder(customerId: number, opts: { requiresInstallation?: boolean } = {}) {
  const quotation = createFinalInvoice({
    customerId,
    requiresInstallation: opts.requiresInstallation ?? true,
    lines: [{
      lineKind: 'custom',
      description: 'خزانة ملابس حسب الطلب',
      dimensions: '240×60×220',
      colorCode: '101',
      quantityMicro: quantityFromDisplay(1),
      unitPriceMinor: moneyFromMajor(10000)
    }]
  }, env.ctx)
  return approveToOrder(quotation.id, env.ctx)
}

describe('Preliminary invoice lifecycle — independent (BR-44, BR-45, BR-9, BR-79)', () => {
  it('locks on issue, snapshots the terms, and carries a 48-hour validity window', () => {
    const { customerId } = seed()
    const quotation = createQuotation({
      customerId,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)

    const { validUntil } = issueQuotation(quotation.id, env.ctx)
    const loaded = getQuotation(quotation.id)

    expect(loaded.quotation.status).toBe('issued')
    // Exactly 48 hours after issue.
    const hours = (new Date(validUntil).getTime() - new Date(loaded.quotation.issuedAt!).getTime()) / 3_600_000
    expect(Math.round(hours)).toBe(48)
    // The eight confirmed clauses are frozen onto the document.
    expect(JSON.parse(loaded.quotation.termsSnapshot!)).toHaveLength(8)
  })

  it('refuses to edit an issued preliminary invoice and creates a linked revision instead (BR-45)', () => {
    const { customerId } = seed()
    const quotation = createQuotation({
      customerId,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)
    issueQuotation(quotation.id, env.ctx)

    const revision = createRevision(quotation.id, env.ctx)
    const loaded = getQuotation(revision.id)
    expect(loaded.quotation.revisionOf).toBe(quotation.id)
    expect(loaded.quotation.status).toBe('draft')
  })

  it('creates NOTHING downstream — no order, no production, no financial effect', () => {
    const { customerId } = seed()
    const quotation = createQuotation({
      customerId,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)
    issueQuotation(quotation.id, env.ctx)

    const raw = getRawConnection()
    // Nothing operational or financial exists because of this document.
    // (Stock movements from the seeded purchase are unrelated to it.)
    for (const table of ['orders', 'work_sheets', 'customer_payments', 'order_material_lines', 'worker_transactions']) {
      expect((raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c).toBe(0)
    }
    expect((raw.prepare("SELECT COUNT(*) AS c FROM inventory_movements WHERE kind != 'purchase'").get() as { c: number }).c).toBe(0)
    // The document itself carries no internal production configuration.
    expect((raw.prepare('SELECT COUNT(*) AS c FROM planned_materials WHERE quotation_id = ?').get(quotation.id) as { c: number }).c).toBe(0)
  })
})

describe('Payment position without fulfillment gates (BL-12)', () => {
  it('computes a 60% deposit on the total after discount', () => {
    const { customerId } = seed()
    const order = makeOrder(customerId)
    const loaded = getOrderOrThrow(order.id)
    expect(loaded.totalMinor).toBe(moneyFromMajor(10000))
    expect(loaded.depositRequiredMinor).toBe(moneyFromMajor(6000))
    expect(loaded.paymentStatus).toBe('unpaid')
  })

  it('allows Manufacturing Work Sheet with no deposit and retains payment status', () => {
    const { customerId } = seed()
    const order = makeOrder(customerId)

    const sheet = issueWorkSheet({ orderId: order.id, workerIds: [] }, env.ctx)
    expect(sheet.documentNumber).toMatch(/^MO-\d{4}-\d{4}$/)
    expect(getOrderOrThrow(order.id).paymentStatus).toBe('unpaid')
  })

  it('allows Installation Authorization with an outstanding balance', () => {
    const { customerId } = seed()
    const order = makeOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)

    const release = issueRelease({ orderId: order.id, kind: 'installation' }, env.ctx)
    expect(release.documentNumber).toMatch(/^IA-\d{4}-\d{4}$/)
    expect(getOrderOrThrow(order.id).remainingMinor).toBe(moneyFromMajor(4000))
  })

  it('issues a SEPARATE Delivery/Handover Release for non-installation orders (BR-112)', () => {
    const { customerId } = seed()
    const order = makeOrder(customerId, { requiresInstallation: false })
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(10000) }, env.ctx)
    const release = issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)
    expect(release.documentNumber).toMatch(/^DR-\d{4}-\d{4}$/)
  })

  it('refuses a payment larger than the remaining balance', () => {
    const { customerId } = seed()
    const order = makeOrder(customerId)
    expect(() => recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(10001) }, env.ctx))
      .toThrowError(/أكبر من الرصيد المتبقي/)
  })
})

describe('Order costing and worker compensation (BR-19, BR-20, BR-87, BR-90, BR-107, BR-108)', () => {
  it('assembles actual cost from materials, machines, workers and expenses, and derives profit', () => {
    const { customerId, materialId } = seed()
    const order = makeOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)

    // Materials: 10 boards at FIFO cost 100 = 1,000 LYD actual, consumed
    // against the order's production order (production-workflow pass).
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(10) }, env.ctx)

    // Machine: 10 boards × 30 LYD per board = 300 LYD (BR-90 example).
    const machineId = createMachine({ name: 'آلة القص', costingUnit: 'لوح', defaultRateMicro: unitCostFromMajor(30) }, env.ctx)
    const usage = addMachineUsage({ orderId: order.id, machineId, usageQtyMicro: quantityFromDisplay(10) }, env.ctx)
    expect(usage.calculatedMinor).toBe(moneyFromMajor(300))

    // Worker A: a fixed 500 LYD. Worker B: 5% of the total after discount = 500 LYD.
    const workerA = createWorker({ name: 'أحمد' }, env.ctx)
    const workerB = createWorker({ name: 'خالد' }, env.ctx)
    assignWorkerToOrder({ orderId: order.id, workerId: workerA, method: 'fixed', amountMinor: moneyFromMajor(500) }, env.ctx)
    const b = assignWorkerToOrder({ orderId: order.id, workerId: workerB, method: 'percent', percentBp: 500, baseKind: 'total_after_discount' }, env.ctx)
    expect(b.amountMinor).toBe(moneyFromMajor(500))

    const cost = orderCostBreakdown(order.id)
    expect(cost.materialCostMinor).toBe(moneyFromMajor(1000))
    expect(cost.machineCostMinor).toBe(moneyFromMajor(300))
    expect(cost.workerCostMinor).toBe(moneyFromMajor(1000))
    expect(cost.totalActualCostMinor).toBe(moneyFromMajor(2300))
    // Selling price 10,000 − actual cost 2,300 = 7,700 profit.
    expect(cost.actualProfitMinor).toBe(moneyFromMajor(7700))
    // The commercial material value (what the customer is charged for
    // materials) is separate from the 1,000 actual FIFO cost.
    expect(cost.commercialMaterialValueMinor).toBe(moneyFromMajor(1500))
  })

  it('keeps the EDITED machine amount, not the calculated one (BR-90)', () => {
    const { customerId } = seed()
    const order = makeOrder(customerId)
    const machineId = createMachine({ name: 'آلة', costingUnit: 'لوح', defaultRateMicro: unitCostFromMajor(30) }, env.ctx)
    addMachineUsage({
      orderId: order.id, machineId, usageQtyMicro: quantityFromDisplay(10),
      finalAmountMinor: moneyFromMajor(250)
    }, env.ctx)
    expect(orderCostBreakdown(order.id).machineCostMinor).toBe(moneyFromMajor(250))
  })

  it('supports all four percentage bases per worker per order (BR-107)', () => {
    const { customerId } = seed()
    const order = makeOrder(customerId)
    const worker = createWorker({ name: 'عامل' }, env.ctx)

    const manual = assignWorkerToOrder({
      orderId: order.id, workerId: worker, method: 'percent', percentBp: 1000,
      baseKind: 'manual', baseAmountMinor: moneyFromMajor(4000)
    }, env.ctx)
    expect(manual.amountMinor).toBe(moneyFromMajor(400))

    const subtotal = assignWorkerToOrder({
      orderId: order.id, workerId: worker, method: 'percent', percentBp: 1000,
      baseKind: 'subtotal_before_discount'
    }, env.ctx)
    expect(subtotal.amountMinor).toBe(moneyFromMajor(1000))
  })

  it('order-scope labour with no Manufacturing Order is owed at order completion; a withdrawal stays separate debt (BR-108 / CC04)', () => {
    const { customerId } = seed()
    const order = makeOrder(customerId)
    const worker = createWorker({ name: 'أحمد' }, env.ctx)
    assignWorkerToOrder({ orderId: order.id, workerId: worker, method: 'fixed', amountMinor: moneyFromMajor(500) }, env.ctx)

    // Nothing owed while the order is still in progress.
    expect(workerBalances(worker)).toEqual({ payableMinor: 0, debtMinor: 0 })

    // CC04: a withdrawal is worker debt, never netted against commissions.
    recordWorkerTransaction({ workerId: worker, kind: 'withdrawal', amountMinor: moneyFromMajor(200) }, env.ctx)
    expect(workerBalances(worker)).toEqual({ payableMinor: 0, debtMinor: moneyFromMajor(200) })

    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(10000) }, env.ctx)
    issueRelease({ orderId: order.id, kind: 'installation' }, env.ctx)
    recordDelivery({ orderId: order.id, kind: 'installation' }, env.ctx)

    // On completion the 500 is owed; the 200 debt stays separate.
    expect(workerBalances(worker)).toEqual({ payableMinor: moneyFromMajor(500), debtMinor: moneyFromMajor(200) })
    expect(getOrderOrThrow(order.id).status).toBe('completed')
    expect(getOrderOrThrow(order.id).completedAt).toBeTruthy()
  })
})

describe('Cancellation (BR-47)', () => {
  it('blocks cancellation before manufacturing completion and preserves payments and incurred costs', () => {
    const { customerId, materialId } = seed()
    const order = makeOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(5) }, env.ctx)

    expect(() => cancelOrder({ orderId: order.id, reason: 'إلغاء من العميل' }, env.ctx)).toThrow(/قبل (إصدار|بدء|اكتمال)/)

    const unchanged = getOrderOrThrow(order.id)
    expect(unchanged.status).toBe('confirmed')
    expect(unchanged.paidMinor).toBe(moneyFromMajor(6000))
    expect(unchanged.cancelReason).toBeNull()
    // Consumed material stays deducted and its cost stays on the order.
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(moneyFromMajor(500))
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
