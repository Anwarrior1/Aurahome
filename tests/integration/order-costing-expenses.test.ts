import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { closeDatabase, getRawConnection } from '@main/db/connection'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { createWorker } from '@main/services/production/workers.service'
import { createMachine } from '@main/services/production/machines.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { issueWorkSheet } from '@main/services/production/production.service'
import {
  listPlannedOrderExpenses,
  listPlannedWorkers,
  orderPlanningSnapshot,
  savePlannedMachines,
  savePlannedMaterials,
  savePlannedOrderExpenses,
  savePlannedWorkers
} from '@main/services/planning/planning.service'
import { orderCostEstimate } from '@main/services/costing/costing.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function makeOrder() {
  const customerId = createCustomer({ name: 'عميل تكلفة الطلب' }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    depositPercentBp: 0,
    lines: [{
      lineKind: 'custom', description: 'مطبخ', quantityMicro: quantityFromDisplay(1),
      unitPriceMinor: moneyFromMajor(10_000)
    }]
  }, env.ctx)
  return approveToOrder(invoice.id, env.ctx)
}

describe('meter and estimated planned worker commissions', () => {
  it('persists meter rate/count and derives 30 × 10 = 300, ignoring a supplied total override', () => {
    const order = makeOrder()
    const workerId = createWorker({ name: 'نجار بالمتر' }, env.ctx)

    savePlannedWorkers({ orderId: order.id }, [{
      workerId,
      workerName: 'نجار بالمتر',
      commissionMode: 'meter',
      meterRateMicro: unitCostFromMajor(30),
      meterQtyMicro: quantityFromDisplay(10),
      estimatedCostMinor: moneyFromMajor(99_999)
    }], env.ctx)

    expect(listPlannedWorkers({ orderId: order.id })[0]).toMatchObject({
      commissionMode: 'meter',
      meterRateMicro: unitCostFromMajor(30),
      meterQtyMicro: quantityFromDisplay(10),
      estimatedCostMinor: moneyFromMajor(300)
    })
  })

  it('keeps estimated/manual mode independent and does not require meter fields', () => {
    const order = makeOrder()
    const workerId = createWorker({ name: 'عامل ثابت' }, env.ctx)
    savePlannedWorkers({ orderId: order.id }, [{
      workerId,
      workerName: 'عامل ثابت',
      commissionMode: 'estimated',
      estimatedCostMinor: moneyFromMajor(150)
    }], env.ctx)

    expect(listPlannedWorkers({ orderId: order.id })[0]).toMatchObject({
      commissionMode: 'estimated', meterRateMicro: null, meterQtyMicro: null,
      estimatedCostMinor: moneyFromMajor(150)
    })
  })

  it('totals meter and estimated lines exactly once', () => {
    const order = makeOrder()
    const meterWorker = createWorker({ name: 'عامل متر' }, env.ctx)
    const fixedWorker = createWorker({ name: 'عامل ثابت' }, env.ctx)
    savePlannedWorkers({ orderId: order.id }, [
      { workerId: meterWorker, workerName: 'عامل متر', commissionMode: 'meter', meterRateMicro: unitCostFromMajor(30), meterQtyMicro: quantityFromDisplay(10), estimatedCostMinor: moneyFromMajor(999) },
      { workerId: fixedWorker, workerName: 'عامل ثابت', commissionMode: 'estimated', estimatedCostMinor: moneyFromMajor(150) }
    ], env.ctx)

    expect(orderPlanningSnapshot(order.id).estimatedWorkerMinor).toBe(moneyFromMajor(450))
  })

  it('reads legacy rows as estimated mode without inventing meter values', () => {
    const order = makeOrder()
    getRawConnection().prepare(`
      INSERT INTO planned_workers (order_id, worker_name, estimated_cost_minor)
      VALUES (?, 'سجل قديم', ?)
    `).run(order.id, moneyFromMajor(275))

    expect(listPlannedWorkers({ orderId: order.id })[0]).toMatchObject({
      workerName: 'سجل قديم', commissionMode: 'estimated',
      meterRateMicro: null, meterQtyMicro: null, estimatedCostMinor: moneyFromMajor(275)
    })
  })
})

describe('planned order expenses', () => {
  it('adds, edits, deletes, persists and recalculates multiple expense lines', () => {
    const order = makeOrder()
    savePlannedOrderExpenses(order.id, [
      { expenseName: 'نقل داخلي', amountMinor: moneyFromMajor(150) },
      { expenseName: 'تحميل وتنزيل', amountMinor: moneyFromMajor(100) },
      { expenseName: 'مصاريف موقع', amountMinor: moneyFromMajor(75) }
    ], env.ctx)
    expect(orderPlanningSnapshot(order.id).estimatedOrderExpenseMinor).toBe(moneyFromMajor(325))

    savePlannedOrderExpenses(order.id, [
      { expenseName: 'نقل داخلي', amountMinor: moneyFromMajor(175) },
      { expenseName: 'تحميل وتنزيل', amountMinor: moneyFromMajor(100) }
    ], env.ctx)
    expect(listPlannedOrderExpenses({ orderId: order.id })).toHaveLength(2)
    expect(orderPlanningSnapshot(order.id).estimatedOrderExpenseMinor).toBe(moneyFromMajor(275))

    savePlannedOrderExpenses(order.id, [
      { expenseName: 'نقل داخلي', amountMinor: moneyFromMajor(175) }
    ], env.ctx)
    expect(orderPlanningSnapshot(order.id).estimatedOrderExpenseMinor).toBe(moneyFromMajor(175))

    closeDatabase()
    expect(listPlannedOrderExpenses({ orderId: order.id })[0]).toMatchObject({
      expenseName: 'نقل داخلي', amountMinor: moneyFromMajor(175)
    })
  })

  it('enters the authoritative estimate and total cost exactly once', () => {
    const order = makeOrder()
    savePlannedOrderExpenses(order.id, [
      { expenseName: 'نقل', amountMinor: moneyFromMajor(100) },
      { expenseName: 'تحميل', amountMinor: moneyFromMajor(50) }
    ], env.ctx)

    const snapshot = orderPlanningSnapshot(order.id)
    const estimate = orderCostEstimate(order.id)
    expect(snapshot.estimatedOrderExpenseMinor).toBe(moneyFromMajor(150))
    expect(snapshot.totalEstimatedCostMinor).toBe(moneyFromMajor(150))
    expect(estimate.estimatedOrderExpenseMinor).toBe(moneyFromMajor(150))
    expect(estimate.estimatedTotalMinor).toBe(moneyFromMajor(150))
  })

  it('creates no cash, expense-ledger, supplier, or inventory side effect', () => {
    const order = makeOrder()
    const raw = getRawConnection()
    const count = (table: string): number => (raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
    const before = {
      cash: count('cash_transactions'), expenses: count('expenses'),
      supplierPayments: count('supplier_payments'), inventory: count('inventory_movements')
    }

    savePlannedOrderExpenses(order.id, [{ expenseName: 'نقل', amountMinor: moneyFromMajor(100) }], env.ctx)

    expect({
      cash: count('cash_transactions'), expenses: count('expenses'),
      supplierPayments: count('supplier_payments'), inventory: count('inventory_movements')
    }).toEqual(before)
  })
})

describe('existing production planning and manufacturing-order workflow', () => {
  it('keeps material/machine totals correct and snapshots commissions/expenses on issuance', () => {
    const order = makeOrder()
    const categoryId = createCategory({ name: 'أخشاب اختبار التكلفة' }, env.ctx)
    const materialId = createMaterial({
      sku: 'COST-MDF', name: 'MDF', categoryId, unit: 'لوح',
      currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact'
    } as never, env.ctx)
    const supplierId = createSupplier({ name: 'مورد تكلفة أمر التصنيع' }, env.ctx)
    createPurchase({ supplierId, lines: [{
      materialId, qtyMicro: quantityFromDisplay(2), unitCostMicro: unitCostFromMajor(80)
    }] }, env.ctx)
    const machineId = createMachine({ name: 'CNC تكلفة', costingUnit: 'ساعة', defaultRateMicro: unitCostFromMajor(50) }, env.ctx)
    const workerId = createWorker({ name: 'عامل أمر التصنيع' }, env.ctx)
    savePlannedMaterials({ orderId: order.id }, [{ materialId, materialName: 'MDF', qtyMicro: quantityFromDisplay(2), estimatedUnitCostMicro: unitCostFromMajor(100) }], env.ctx)
    savePlannedMachines({ orderId: order.id }, [{ machineId, machineName: 'CNC تكلفة', usageQtyMicro: quantityFromDisplay(1) }], env.ctx)
    savePlannedWorkers({ orderId: order.id }, [{ workerId, workerName: 'عامل أمر التصنيع', commissionMode: 'meter', meterRateMicro: unitCostFromMajor(30), meterQtyMicro: quantityFromDisplay(10) }], env.ctx)
    savePlannedOrderExpenses(order.id, [{ expenseName: 'نقل', amountMinor: moneyFromMajor(100) }], env.ctx)

    const beforeIssue = orderPlanningSnapshot(order.id)
    expect(beforeIssue.estimatedMaterialMinor).toBe(moneyFromMajor(200))
    expect(beforeIssue.estimatedMachineMinor).toBe(moneyFromMajor(50))
    expect(beforeIssue.totalEstimatedCostMinor).toBe(moneyFromMajor(650))

    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    const snapWorker = getRawConnection().prepare('SELECT * FROM planned_workers WHERE work_sheet_id = ?').get(sheet.id) as Record<string, unknown>
    const snapExpense = getRawConnection().prepare('SELECT * FROM planned_order_expenses WHERE work_sheet_id = ?').get(sheet.id) as Record<string, unknown>
    expect(snapWorker).toMatchObject({ commission_mode: 'meter', estimated_cost_minor: moneyFromMajor(300) })
    expect(snapExpense).toMatchObject({ expense_name: 'نقل', amount_minor: moneyFromMajor(100) })
  })
})
