import { issueStockForOrder } from '../helpers/finished-goods-fixture'
import { fulfillOrder } from '../helpers/sales-flow'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { closeDatabase, getRawConnection } from '@main/db/connection'
import { createCategory, createColor, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import {
  createProduct, replaceBom, replaceProductMachines, replaceProductCommission
} from '@main/services/products/products.service'
import { createMachine } from '@main/services/production/machines.service'
import { createWorker, workerBalances } from '@main/services/production/workers.service'
import {
  createQuotation, issueQuotation, getQuotation, cancelQuotation
} from '@main/services/sales/quotations.service'
import {
  createFinalInvoice, getFinalInvoice, updateFinalInvoice
} from '@main/services/sales/final-invoices.service'
import {
  getOrderOrThrow, recordPayment
} from '@main/services/sales/orders.service'
import {
  issueWorkSheet, getProductionOrder, cancelProductionOrder, listWorkSheets
} from '@main/services/production/production.service'
import {
  savePlannedMaterials, savePlannedMachines, savePlannedWorkers,
  listPlannedMaterials, listPlannedMachines, listPlannedWorkers, orderPlanningSnapshot
} from '@main/services/planning/planning.service'
import { buildPreliminaryInvoice } from '@main/services/documents/documents.service'
import { renderPreliminaryInvoice } from '@main/reports/templates/documents.template'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { seedFinishedGoods } from '../helpers/finished-goods-fixture'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * THE WORKFLOW REFACTOR, end to end.
 *
 *   preliminary invoice   →  an independent customer document. Full stop.
 *
 *   approved invoice  --approve-->  customer order
 *                                        ├── materials
 *                                        ├── machines
 *                                        ├── worker commissions
 *                                        └── (explicit) manufacturing order
 *
 * Every numbered test below is one of the acceptance tests for that
 * change.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function seed() {
  createColor({ code: '205', name: 'لون 205' }, env.ctx)
  const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
  const materialId = createMaterial({
    sku: 'MDF-WF', name: 'لوح MDF', categoryId, unit: 'لوح',
    currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
  } as never, env.ctx)
  const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
  createPurchase({
    supplierId,
    lines: [{ materialId, qtyMicro: quantityFromDisplay(100), unitCostMicro: unitCostFromMajor(100) }]
  }, env.ctx)
  const customerId = createCustomer({ name: 'عميل', phone: '0910000000' }, env.ctx)
  const accountId = createAccount({ name: 'صندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
  return { materialId, customerId, accountId, categoryId }
}

const LINE = {
  lineKind: 'custom' as const, description: 'مطبخ حسب الطلب', dimensions: '300×60',
  colorCode: '205', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(6000)
}

function invoiceFor(customerId: number) {
  return createFinalInvoice({ customerId, requiresInstallation: true, lines: [LINE] }, env.ctx)
}

/** Every table a document could wrongly touch, counted in one go. */
function operationalCounts() {
  const raw = getRawConnection()
  const count = (table: string, where = ''): number =>
    (raw.prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).get() as { c: number }).c
  return {
    orders: count('orders'),
    workSheets: count('work_sheets'),
    payments: count('customer_payments'),
    consumption: count('order_material_lines'),
    movements: count('inventory_movements', "WHERE kind != 'purchase'"),
    machineUsage: count('order_machine_usage'),
    assignments: count('order_worker_assignments'),
    workerLedger: count('worker_transactions'),
    cash: count('cash_transactions')
  }
}

/* ================================================================= */
describe('TEST 1 — the preliminary invoice is an independent customer document', () => {
  it('carries its customer-facing fields, prints, and creates absolutely nothing', () => {
    const { customerId } = seed()
    const before = operationalCounts()

    const quotation = createQuotation({
      customerId,
      requiresInstallation: true,
      requiresDelivery: true,
      discountKind: 'amount',
      discountValue: moneyFromMajor(500),
      notes: 'ملاحظات للعميل',
      lines: [{ ...LINE, specifications: 'وحدات علوية وسفلية', accessories: 'مفصلات مخفية' }]
    }, env.ctx)
    const { validUntil } = issueQuotation(quotation.id, env.ctx)

    // Customer-facing fields all work.
    const loaded = getQuotation(quotation.id)
    expect(loaded.quotation.status).toBe('issued')
    expect(loaded.quotation.totalMinor).toBe(moneyFromMajor(5500))
    expect(loaded.quotation.discountMinor).toBe(moneyFromMajor(500))
    expect(loaded.quotation.notes).toBe('ملاحظات للعميل')
    expect(validUntil).toBeTruthy()

    // The PDF still renders, with the customer's own content.
    const html = renderPreliminaryInvoice(buildPreliminaryInvoice(quotation.id), { name: 'AURA home' })
    expect(html).toContain('فاتورة مبدئية')
    expect(html).toContain('مطبخ حسب الطلب')
    expect(html).toContain('5.500,00')

    // No internal costing section of any kind.
    expect(html).not.toContain('تكلفة')
    expect(html).not.toContain('ربح')
    expect(loaded.quotation.estimatedMaterialMinor).toBe(0)
    expect(loaded.quotation.estimatedMachineMinor).toBe(0)
    expect(loaded.quotation.estimatedWorkerMinor).toBe(0)

    // …and nothing operational or financial happened at all.
    expect(operationalCounts()).toEqual(before)
  })

  it('can be edited while draft, cancelled, and never becomes an order', () => {
    const { customerId } = seed()
    const quotation = createQuotation({ customerId, lines: [LINE] }, env.ctx)

    cancelQuotation(quotation.id, env.ctx)
    expect(getQuotation(quotation.id).quotation.status).toBe('cancelled')
    expect(operationalCounts().orders).toBe(0)
  })
})

/* ================================================================= */
describe('TEST 2 — the obsolete preliminary-invoice → order path is gone', () => {
  let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>

  beforeEach(async () => {
    handlers = new Map()
    const electron = await import('electron')
    const spy = vi
      .spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
  })

  it('no longer registers ANY conversion or quotation-costing channel', () => {
    // The routes themselves do not exist — the button was not merely hidden.
    for (const dead of [
      'orders:createFromQuotation',
      'quotations:costing',
      'quotations:savePlannedMaterials',
      'quotations:savePlannedMachines',
      'quotations:savePlannedWorkers',
      'finalInvoices:issue',
      'finalInvoices:eligibility'
    ]) {
      expect(handlers.has(dead)).toBe(false)
    }
    // …and the channel constants are gone, so nothing can name them.
    expect(JSON.stringify(IPC_CHANNELS)).not.toContain('createFromQuotation')
    expect(JSON.stringify(IPC_CHANNELS)).not.toContain('quotations:costing')
  })

  it('refuses production planning against a preliminary invoice, server-side', () => {
    const { customerId } = seed()
    const quotation = createQuotation({ customerId, lines: [LINE] }, env.ctx)

    expect(() => savePlannedMaterials({ quotationId: quotation.id }, [], env.ctx))
      .toThrowError(/مستند تجاري للعميل فقط/)
    expect(() => savePlannedMachines({ quotationId: quotation.id }, [], env.ctx))
      .toThrowError(/مستند تجاري للعميل فقط/)
    expect(() => savePlannedWorkers({ quotationId: quotation.id }, [], env.ctx))
      .toThrowError(/مستند تجاري للعميل فقط/)
  })
})

/* ================================================================= */
describe('TESTS 5/13 — the order is the planning point, and planning posts nothing', () => {
  it('persists materials, machines and commissions across an application restart', () => {
    const { customerId, materialId } = seed()
    const order = approveToOrder(invoiceFor(customerId).id, env.ctx)
    const machineId = createMachine({ name: 'CNC', costingUnit: 'ساعة', defaultRateMicro: unitCostFromMajor(20) }, env.ctx)
    const workerId = createWorker({ name: 'نجار' }, env.ctx)

    savePlannedMaterials({ orderId: order.id }, [
      { materialId, materialName: 'لوح MDF', qtyMicro: quantityFromDisplay(12), unit: 'لوح', estimatedUnitCostMicro: unitCostFromMajor(100) }
    ], env.ctx)
    savePlannedMachines({ orderId: order.id }, [
      { machineId, machineName: 'CNC', usageQtyMicro: quantityFromDisplay(3), usageUnit: 'ساعة', estimatedCostMinor: moneyFromMajor(60) }
    ], env.ctx)
    savePlannedWorkers({ orderId: order.id }, [
      { workerId, workerName: 'نجار', estimatedCostMinor: moneyFromMajor(500) }
    ], env.ctx)

    // Restart the application against the same file.
    closeDatabase()

    const materials = listPlannedMaterials({ orderId: order.id })
    expect(materials).toHaveLength(1)
    expect(materials[0]!.qtyMicro).toBe(quantityFromDisplay(12))
    expect(listPlannedMachines({ orderId: order.id })[0]!.machineName).toBe('CNC')
    expect(listPlannedWorkers({ orderId: order.id })[0]!.estimatedCostMinor).toBe(moneyFromMajor(500))
  })

  it('derives the internal estimate from the three categories, kept separate', () => {
    const { customerId, materialId } = seed()
    const order = approveToOrder(invoiceFor(customerId).id, env.ctx)
    const machineId = createMachine({ name: 'CNC', costingUnit: 'عملية', defaultRateMicro: unitCostFromMajor(300) }, env.ctx)

    savePlannedMaterials({ orderId: order.id }, [
      { materialId, materialName: 'لوح MDF', qtyMicro: quantityFromDisplay(12), unit: 'لوح', estimatedUnitCostMicro: unitCostFromMajor(100) }
    ], env.ctx)
    savePlannedMachines({ orderId: order.id }, [
      { machineId, machineName: 'CNC', usageQtyMicro: quantityFromDisplay(1) }
    ], env.ctx)
    savePlannedWorkers({ orderId: order.id }, [
      { workerName: 'نجار', estimatedCostMinor: moneyFromMajor(500) }
    ], env.ctx)

    const snapshot = orderPlanningSnapshot(order.id)
    expect(snapshot.estimatedMaterialMinor).toBe(moneyFromMajor(1200))
    expect(snapshot.estimatedMachineMinor).toBe(moneyFromMajor(300))
    expect(snapshot.estimatedWorkerMinor).toBe(moneyFromMajor(500))
    expect(snapshot.totalEstimatedCostMinor).toBe(moneyFromMajor(2000))
    expect(snapshot.sellingPriceMinor).toBe(moneyFromMajor(6000))
    expect(snapshot.expectedProfitMinor).toBe(moneyFromMajor(4000))
  })

  it('TEST 13 — planning moves no stock, no worker balance and no cash', () => {
    const { customerId, materialId, accountId } = seed()
    const stockBefore = availableQty(materialId)
    const cashBefore = accountBalance(accountId)
    const workerId = createWorker({ name: 'نجار' }, env.ctx)

    const order = approveToOrder(invoiceFor(customerId).id, env.ctx)
    savePlannedMaterials({ orderId: order.id }, [
      { materialId, materialName: 'لوح MDF', qtyMicro: quantityFromDisplay(12), unit: 'لوح', estimatedUnitCostMicro: unitCostFromMajor(100) }
    ], env.ctx)
    savePlannedWorkers({ orderId: order.id }, [
      { workerId, workerName: 'نجار', estimatedCostMinor: moneyFromMajor(500) }
    ], env.ctx)

    expect(availableQty(materialId)).toBe(stockBefore)
    expect(accountBalance(accountId)).toBe(cashBefore)
    expect(workerBalances(workerId)).toEqual({ payableMinor: 0, debtMinor: 0 })
    const counts = operationalCounts()
    expect(counts.consumption).toBe(0)
    expect(counts.movements).toBe(0)
    expect(counts.assignments).toBe(0)
    expect(counts.workerLedger).toBe(0)
    expect(counts.cash).toBe(0)
  })

  it('freezes the configuration once the order is completed', () => {
    const { customerId } = seed()
    const order = approveToOrder(invoiceFor(customerId).id, env.ctx)
    fulfillOrder(order.id, env.ctx)

    expect(() => savePlannedMaterials({ orderId: order.id }, [], env.ctx)).toThrowError(/بعد إكمال الطلب/)
  })
})

/* ================================================================= */
describe('TESTS 6/7 — the product master is a template, the order owns its snapshot', () => {
  function configuredProduct(materialId: number) {
    const machineId = createMachine({ name: 'CNC', costingUnit: 'ساعة', defaultRateMicro: unitCostFromMajor(20) }, env.ctx)
    const workerId = createWorker({ name: 'نجار' }, env.ctx)
    const productId = createProduct({ code: 'STD-WF', name: 'خزانة قياسية', defaultPriceMinor: moneyFromMajor(2500) }, env.ctx)
    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(10), unit: 'لوح' }], env.ctx)
    replaceProductMachines(productId, [{ machineId, usageQtyMicro: quantityFromDisplay(0.5) }], env.ctx)
    replaceProductCommission(productId, [{ workerId, amountMinor: moneyFromMajor(50) }], env.ctx)
    return { productId, machineId, workerId }
  }

  it('TEST 6 — approving an invoice seeds the order from the product defaults', () => {
    const { customerId, materialId } = seed()
    const { productId } = configuredProduct(materialId)

    // BL-04: a standard line is fulfilled from ready stock — approval seeds no preparation for it.
    const standard = approveToOrder(createFinalInvoice({
      customerId,
      lines: [{ lineKind: 'standard', productId, description: 'خزانة قياسية', quantityMicro: quantityFromDisplay(2), unitPriceMinor: moneyFromMajor(2500) }]
    }, env.ctx).id, env.ctx)
    expect(listPlannedMaterials({ orderId: standard.id })).toHaveLength(0)
    expect(listPlannedMachines({ orderId: standard.id })).toHaveLength(0)
    expect(listPlannedWorkers({ orderId: standard.id })).toHaveLength(0)

    // A custom line built from the product template takes the template's defaults.
    const invoice = createFinalInvoice({
      customerId,
      lines: [{
        lineKind: 'custom', productId, description: 'خزانة حسب الطلب',
        quantityMicro: quantityFromDisplay(2), unitPriceMinor: moneyFromMajor(2500)
      }]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)

    // Scaled by the two units ordered, and kept in three separate lists.
    const materials = listPlannedMaterials({ orderId: order.id })
    expect(materials).toHaveLength(1)
    expect(materials[0]!.qtyMicro).toBe(quantityFromDisplay(20))
    const machines = listPlannedMachines({ orderId: order.id })
    expect(machines).toHaveLength(1)
    expect(machines[0]!.usageQtyMicro).toBe(quantityFromDisplay(1))
    expect(machines[0]!.estimatedCostMinor).toBe(moneyFromMajor(20))
    const workers = listPlannedWorkers({ orderId: order.id })
    expect(workers).toHaveLength(1)
    expect(workers[0]!.estimatedCostMinor).toBe(moneyFromMajor(100))

    // Machines and commissions are NOT material rows.
    expect(materials.every((row) => row.materialName !== 'CNC' && row.materialName !== 'نجار')).toBe(true)
    // And seeding still posted nothing.
    expect(operationalCounts().assignments).toBe(0)
    expect(operationalCounts().workerLedger).toBe(0)
  })

  it('TEST 7 — changing the product master afterwards never rewrites the order', () => {
    const { customerId, materialId } = seed()
    const { productId, machineId, workerId } = configuredProduct(materialId)
    const invoice = createFinalInvoice({
      customerId,
      lines: [{ lineKind: 'custom', productId, description: 'خزانة حسب الطلب', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(2500) }]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)

    // The brief's example: 10 MDF / 30 min / 50 LYD → 12 / 40 min / 60.
    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(12), unit: 'لوح' }], env.ctx)
    replaceProductMachines(productId, [{ machineId, usageQtyMicro: quantityFromDisplay(0.67) }], env.ctx)
    replaceProductCommission(productId, [{ workerId, amountMinor: moneyFromMajor(60) }], env.ctx)

    // Order #1 keeps exactly what it was created with.
    expect(listPlannedMaterials({ orderId: order.id })[0]!.qtyMicro).toBe(quantityFromDisplay(10))
    expect(listPlannedMachines({ orderId: order.id })[0]!.usageQtyMicro).toBe(quantityFromDisplay(0.5))
    expect(listPlannedWorkers({ orderId: order.id })[0]!.estimatedCostMinor).toBe(moneyFromMajor(50))

    // A NEW order picks up the new defaults.
    const later = approveToOrder(createFinalInvoice({
      customerId,
      lines: [{ lineKind: 'custom', productId, description: 'خزانة حسب الطلب', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(2500) }]
    }, env.ctx).id, env.ctx)
    expect(listPlannedMaterials({ orderId: later.id })[0]!.qtyMicro).toBe(quantityFromDisplay(12))
    expect(listPlannedWorkers({ orderId: later.id })[0]!.estimatedCostMinor).toBe(moneyFromMajor(60))
  })
})

/* ================================================================= */
describe('TESTS 8/9/10/11 — the manufacturing order is an explicit decision', () => {
  function plannedOrder() {
    const { customerId, materialId } = seed()
    const order = approveToOrder(invoiceFor(customerId).id, env.ctx)
    const machineId = createMachine({ name: 'CNC', costingUnit: 'ساعة', defaultRateMicro: unitCostFromMajor(20) }, env.ctx)
    savePlannedMaterials({ orderId: order.id }, [
      { materialId, materialName: 'لوح MDF', qtyMicro: quantityFromDisplay(12), unit: 'لوح', dimensions: '244×122', colorCode: '205', estimatedUnitCostMicro: unitCostFromMajor(100) }
    ], env.ctx)
    savePlannedMachines({ orderId: order.id }, [
      { machineId, machineName: 'CNC', usageQtyMicro: quantityFromDisplay(3), usageUnit: 'ساعة' }
    ], env.ctx)
    savePlannedWorkers({ orderId: order.id }, [
      { workerName: 'نجار', estimatedCostMinor: moneyFromMajor(500) }
    ], env.ctx)
    return { order, materialId }
  }

  it('TEST 8 — no manufacturing order exists until it is explicitly requested', () => {
    const { order } = plannedOrder()
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)

    expect(listWorkSheets({ orderId: order.id }).items).toHaveLength(0)
    expect(operationalCounts().workSheets).toBe(0)
  })

  it('TEST 9 — issuing one snapshots the ORDER\'s configuration onto it', () => {
    const { order } = plannedOrder()
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)

    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    const detail = getProductionOrder(sheet.id)
    expect(detail.sheet.orderId).toBe(order.id)

    const materials = listPlannedMaterials({ workSheetId: sheet.id })
    expect(materials).toHaveLength(1)
    expect(materials[0]!.qtyMicro).toBe(quantityFromDisplay(12))
    expect(materials[0]!.dimensions).toBe('244×122')
    expect(materials[0]!.colorCode).toBe('205')
    expect(listPlannedMachines({ workSheetId: sheet.id })[0]!.machineName).toBe('CNC')
    expect(listPlannedWorkers({ workSheetId: sheet.id })[0]!.estimatedCostMinor).toBe(moneyFromMajor(500))

    // Issuing it now posts linked Raw Materials atomically, while planned
    // machine and worker values remain estimates until their real events.
    const counts = operationalCounts()
    expect(counts.consumption).toBe(1)
    expect(counts.machineUsage).toBe(0)
    expect(counts.assignments).toBe(0)
    expect(counts.workerLedger).toBe(0)
  })

  it('TEST 10 — retrying never produces a second live manufacturing order', () => {
    const { order } = plannedOrder()
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3600) }, env.ctx)
    const first = issueWorkSheet({ orderId: order.id }, env.ctx)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() => issueWorkSheet({ orderId: order.id }, env.ctx)).toThrowError(/صدر أمر تصنيع لهذا الطلب بالفعل/)
    }
    expect(listWorkSheets({ orderId: order.id }).items).toHaveLength(1)

    // Cancellation preserves the issued inventory/cost history, so it
    // deliberately does not reopen a duplicate issue path.
    cancelProductionOrder({ id: first.id, reason: 'خطأ في الإصدار' }, env.ctx)
    expect(() => issueWorkSheet({ orderId: order.id }, env.ctx)).toThrowError(/صدر أمر تصنيع لهذا الطلب بالفعل/)
    expect(listWorkSheets({ orderId: order.id }).items).toHaveLength(1)
  })

  it('TEST 11 — an order fulfilled from finished goods stays valid with no manufacturing order', () => {
    const { customerId, materialId } = seed()
    const productId = createProduct({ code: 'STK-1', name: 'خزانة جاهزة', defaultPriceMinor: moneyFromMajor(2500) }, env.ctx)
    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(4), unit: 'لوح' }], env.ctx)
    // Stock already on the shelf, produced earlier.
    seedFinishedGoods(
      { productId, qtyMicro: quantityFromDisplay(5), totalCostMinor: moneyFromMajor(5000) },
      env.ctx
    )

    const order = approveToOrder(createFinalInvoice({
      customerId,
      lines: [{ lineKind: 'standard', productId, description: 'خزانة جاهزة', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(2500) }]
    }, env.ctx).id, env.ctx)

    issueStockForOrder({ orderId: order.id }, env.ctx)

    expect(listWorkSheets({ orderId: order.id }).items).toHaveLength(0)
    expect(getOrderOrThrow(order.id).status).toBe('confirmed')
    expect(operationalCounts().workSheets).toBe(0)
  })
})

/* ================================================================= */
describe('TEST 12 — documents from the OLD workflow stay readable and traceable', () => {
  it('reads a legacy converted preliminary invoice and its order in both directions', () => {
    const { customerId } = seed()
    const quotation = createQuotation({ customerId, lines: [LINE] }, env.ctx)
    const order = approveToOrder(invoiceFor(customerId).id, env.ctx)

    // Reshape the pair exactly as the old workflow left it on disk.
    const raw = getRawConnection()
    const invoiceId = getOrderOrThrow(order.id).finalInvoiceId!
    raw.prepare('UPDATE orders SET quotation_id = ?, final_invoice_id = NULL WHERE id = ?').run(quotation.id, order.id)
    raw.prepare("UPDATE final_invoices SET status = 'approved', order_id = ? WHERE id = ?").run(order.id, invoiceId)
    raw.prepare("UPDATE quotations SET status = 'converted' WHERE id = ?").run(quotation.id)

    // Both documents still load, and the link is readable from each side.
    expect(getQuotation(quotation.id).quotation.status).toBe('converted')
    expect(getOrderOrThrow(order.id).quotationId).toBe(quotation.id)
    const legacyInvoice = getFinalInvoice(invoiceId)
    expect(legacyInvoice.invoice.orderId).toBe(order.id)
    // A legacy invoice renders from its frozen snapshot, as it always did.
    expect(legacyInvoice.snapshot.totalMinor).toBe(moneyFromMajor(6000))
    expect(raw.pragma('foreign_key_check')).toEqual([])
  })
})

/* ================================================================= */
describe('TEST 14 — every new route is authorised server-side', () => {
  let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
  let windowId = 71000
  let event: IpcMainInvokeEvent

  beforeEach(async () => {
    windowId += 1
    event = { sender: { id: windowId } } as IpcMainInvokeEvent
    handlers = new Map()
    const electron = await import('electron')
    const spy = vi
      .spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
  })

  async function invoke(channel: string, request: unknown): Promise<IpcResult<unknown>> {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler registered for ${channel}`)
    return handler(event, request)
  }

  function signInWith(permissions: string[]): void {
    const roleId = createRole({ name: `دور-${Math.random()}`, permissions }, env.ctx)
    const username = `user${Math.floor(Math.random() * 1e9)}`
    createUser({ username, password: 'secret789', fullName: 'مستخدم', roleId }, env.ctx)
    login(username, 'secret789', windowId)
  }

  function signInViewOnly(): void {
    const roleId = createRole({ name: `مشاهد-${Math.random()}`, permissions: [P.orders.view, P.costing.view] }, env.ctx)
    const username = `viewer${Math.floor(Math.random() * 1e9)}`
    createUser({ username, password: 'secret789', fullName: 'مشاهدة فقط', roleId }, env.ctx)
    login(username, 'secret789', windowId)
  }

  it('refuses approval, invoice editing and order production planning without authority', async () => {
    const { customerId } = seed()
    const invoice = invoiceFor(customerId)
    const approved = approveToOrder(invoiceFor(customerId).id, env.ctx)
    signInViewOnly()

    for (const [channel, payload] of [
      [IPC_CHANNELS.finalInvoices.approve, { id: invoice.id }],
      [IPC_CHANNELS.finalInvoices.create, { customerId, lines: [LINE] }],
      [IPC_CHANNELS.finalInvoices.update, { id: invoice.id, notes: 'x' }],
      [IPC_CHANNELS.finalInvoices.remove, { id: invoice.id }],
      [IPC_CHANNELS.orders.savePlannedMaterials, { orderId: approved.id, lines: [] }],
      [IPC_CHANNELS.orders.savePlannedMachines, { orderId: approved.id, lines: [] }],
      [IPC_CHANNELS.orders.savePlannedWorkers, { orderId: approved.id, lines: [] }]
    ] as Array<[string, unknown]>) {
      const result = await invoke(channel, payload)
      expect(result.ok, `${channel} must be refused`).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    }

    // Nothing was approved by any of those attempts.
    expect(getFinalInvoice(invoice.id).invoice.status).toBe('draft')
  })

  it('still allows reading the invoice and the order plan for view-only access', async () => {
    const { customerId } = seed()
    const invoice = invoiceFor(customerId)
    signInViewOnly()

    expect((await invoke(IPC_CHANNELS.finalInvoices.get, { id: invoice.id })).ok).toBe(true)
    expect((await invoke(IPC_CHANNELS.finalInvoices.list, {})).ok).toBe(true)
  })

  it('lets an authorised user approve exactly once through the IPC boundary', async () => {
    const { customerId } = seed()
    const invoice = invoiceFor(customerId)
    signInWith([P.orders.view, P.orders.manage, P.costing.view])

    const first = await invoke(IPC_CHANNELS.finalInvoices.approve, { id: invoice.id })
    const second = await invoke(IPC_CHANNELS.finalInvoices.approve, { id: invoice.id })
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) {
      const a = first.data as { orderId: number; alreadyApproved: boolean }
      const b = second.data as { orderId: number; alreadyApproved: boolean }
      expect(a.alreadyApproved).toBe(false)
      expect(b.alreadyApproved).toBe(true)
      expect(b.orderId).toBe(a.orderId)
    }
    expect(operationalCounts().orders).toBe(1)
  })
})

/* ================================================================= */
describe('the approved invoice keeps its commercial terms frozen', () => {
  it('is editable as a draft and frozen after approval', () => {
    const { customerId } = seed()
    const invoice = invoiceFor(customerId)

    updateFinalInvoice(invoice.id, { discountKind: 'amount', discountValue: moneyFromMajor(1000) }, env.ctx)
    expect(getFinalInvoice(invoice.id).invoice.totalMinor).toBe(moneyFromMajor(5000))

    const order = approveToOrder(invoice.id, env.ctx)
    expect(order.totalMinor).toBe(moneyFromMajor(5000))
    expect(order.depositRequiredMinor).toBe(moneyFromMajor(3000))
    expect(() => updateFinalInvoice(invoice.id, { notes: 'بعد الاعتماد' }, env.ctx)).toThrowError(/بعد اعتمادها/)
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
