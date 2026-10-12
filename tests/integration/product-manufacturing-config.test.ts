import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import {
  createProduct,
  replaceBom,
  getProduct,
  getProductMachines,
  getProductCommission,
  replaceProductMachines,
  replaceProductCommission,
  productManufacturingCost
} from '@main/services/products/products.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createMachine } from '@main/services/production/machines.service'
import { createWorker } from '@main/services/production/workers.service'
import { issueWorkSheet, issueStandardStockFromBom } from '@main/services/production/production.service'
import { insertHistoricalStockSheet } from '../helpers/historical-stock-sheet'
import { listFinishedGoods } from '@main/services/production/finished-goods.service'
import { listPlannedMachines, listPlannedWorkers, listPlannedMaterials } from '@main/services/planning/planning.service'
import { closeDatabase, getRawConnection } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * Product Components — الآلات (machines) and عمولة العامل (worker
 * commission) as a THIRD and FOURTH standard configuration alongside
 * المواد (the existing BOM), never merged into inventory materials.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function seedMasters() {
  const categoryId = createCategory({ name: 'ألواح' }, env.ctx)
  const materialId = createMaterial({
    sku: 'MDF-PC', name: 'لوح MDF', categoryId, unit: 'لوح',
    currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact'
  } as never, env.ctx)
  const machineId = createMachine({ name: 'آلة القص CNC', costingUnit: 'ساعة', defaultRateMicro: unitCostFromMajor(20) }, env.ctx)
  const workerId = createWorker({ name: 'نجّار' }, env.ctx)
  return { materialId, machineId, workerId }
}

describe('Product Components — الآلات section reuses the existing machine master', () => {
  it('never creates a duplicate machine master; stores standard usage/rate separately from inventory', () => {
    const { machineId } = seedMasters()
    const productId = createProduct({ code: 'PC-1', name: 'خزانة قياسية' }, env.ctx)

    // The brief's own example: 30 minutes at 20 LYD/hour = 10 LYD.
    replaceProductMachines(productId, [
      { machineId, usageQtyMicro: quantityFromDisplay(0.5) } // 0.5 hour = 30 minutes
    ], env.ctx)

    const lines = getProductMachines(productId)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.machineId).toBe(machineId)
    // No new row was added to the machine master — same id reused.
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM machines').get() as { c: number }).toEqual({ c: 1 })

    const cost = productManufacturingCost(productId)
    expect(cost.machineCostMinor).toBe(moneyFromMajor(10))
    expect(cost.materialCostMinor).toBe(0)
    expect(cost.commissionCostMinor).toBe(0)
    expect(cost.manufacturingCostMinor).toBe(moneyFromMajor(10))
  })

  it('an explicit rate overrides the machine default; omitting it falls back to the default rate', () => {
    const { machineId } = seedMasters()
    const productId = createProduct({ code: 'PC-2', name: 'طاولة' }, env.ctx)
    replaceProductMachines(productId, [
      { machineId, usageQtyMicro: quantityFromDisplay(1), rateMicro: unitCostFromMajor(35) }
    ], env.ctx)
    expect(productManufacturingCost(productId).machineCostMinor).toBe(moneyFromMajor(35))
  })

  it('rejects zero/negative usage, negative rate, and an unknown machine — server-side, not just the UI', () => {
    const { machineId } = seedMasters()
    const productId = createProduct({ code: 'PC-3', name: 'رف' }, env.ctx)
    expect(() => replaceProductMachines(productId, [{ machineId, usageQtyMicro: 0 }], env.ctx)).toThrowError(/أكبر من صفر/)
    expect(() => replaceProductMachines(productId, [{ machineId, usageQtyMicro: -1 }], env.ctx)).toThrowError(/أكبر من صفر/)
    expect(() => replaceProductMachines(productId, [{ machineId, usageQtyMicro: quantityFromDisplay(1), rateMicro: -1 }], env.ctx))
      .toThrowError(/سالباً/)
    expect(() => replaceProductMachines(productId, [{ machineId: 999999, usageQtyMicro: quantityFromDisplay(1) }], env.ctx))
      .toThrowError(/غير موجودة/)
    expect(getProductMachines(productId)).toHaveLength(0)
  })

  it('never deducts a machine from inventory stock or creates any inventory movement', () => {
    const { machineId } = seedMasters()
    const productId = createProduct({ code: 'PC-4', name: 'كرسي' }, env.ctx)
    const before = getRawConnection().prepare('SELECT COUNT(*) AS c FROM inventory_movements').get() as { c: number }
    replaceProductMachines(productId, [{ machineId, usageQtyMicro: quantityFromDisplay(2) }], env.ctx)
    const after = getRawConnection().prepare('SELECT COUNT(*) AS c FROM inventory_movements').get() as { c: number }
    expect(after.c).toBe(before.c)
  })
})

describe('Product Components — عمولة العامل is a standard rule, never a raw material or a payment', () => {
  it('reuses the existing worker master and stores the commission separately from material cost', () => {
    const { workerId } = seedMasters()
    const productId = createProduct({ code: 'PC-5', name: 'باب' }, env.ctx)
    replaceProductCommission(productId, [{ workerId, amountMinor: moneyFromMajor(5) }], env.ctx)

    const lines = getProductCommission(productId)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.workerId).toBe(workerId)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM workers').get() as { c: number }).toEqual({ c: 1 })
    expect(productManufacturingCost(productId).commissionCostMinor).toBe(moneyFromMajor(5))
  })

  it('requires a real worker for every Standard Product commission', () => {
    const productId = createProduct({ code: 'PC-6', name: 'مكتب' }, env.ctx)
    expect(() => replaceProductCommission(productId, [{ amountMinor: moneyFromMajor(3) }], env.ctx))
      .toThrow(/اختر عاملاً/)
    expect(getProductCommission(productId)).toHaveLength(0)
  })

  it('saving the standard commission NEVER pays anyone and posts no financial transaction', () => {
    const { workerId } = seedMasters()
    const productId = createProduct({ code: 'PC-7', name: 'سرير' }, env.ctx)
    replaceProductCommission(productId, [{ workerId, amountMinor: moneyFromMajor(50) }], env.ctx)
    // Saving it again (idempotent full replace) still posts nothing.
    replaceProductCommission(productId, [{ workerId, amountMinor: moneyFromMajor(60) }], env.ctx)

    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM worker_transactions').get() as { c: number }).toEqual({ c: 0 })
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM order_worker_assignments').get() as { c: number }).toEqual({ c: 0 })
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM cash_transactions').get() as { c: number }).toEqual({ c: 0 })
  })

  it('rejects a zero/negative commission and an unknown worker reference', () => {
    const productId = createProduct({ code: 'PC-8', name: 'منضدة' }, env.ctx)
    expect(() => replaceProductCommission(productId, [{ amountMinor: 0 }], env.ctx)).toThrowError(/أكبر من صفر/)
    expect(() => replaceProductCommission(productId, [{ amountMinor: -100 }], env.ctx)).toThrowError(/أكبر من صفر/)
    expect(() => replaceProductCommission(productId, [{ workerId: 999999, amountMinor: moneyFromMajor(5) }], env.ctx))
      .toThrowError(/غير موجود/)
    expect(getProductCommission(productId)).toHaveLength(0)
  })
})

describe('Product Components — المواد: per-line "السعر" overrides the material market price', () => {
  it('stores a per-line price and uses it instead of the material market price', () => {
    const { materialId } = seedMasters() // currentMarketPriceMicro = 100 LYD, pricingRule 'exact'
    const productId = createProduct({ code: 'PC-PRICE-1', name: 'رف' }, env.ctx)

    replaceBom(productId, [
      { materialId, qtyMicro: quantityFromDisplay(4), unit: 'لوح', unitPriceMicro: unitCostFromMajor(80) }
    ], env.ctx)

    const [line] = getProduct(productId).bom
    expect(line!.unitPriceMicro).toBe(unitCostFromMajor(80))
    expect(line!.materialPriceMicro).toBe(unitCostFromMajor(100)) // the live reference price, unaffected

    // 4 × 80 = 320, NOT 4 × 100 = 400 — the override was actually used.
    expect(productManufacturingCost(productId).materialCostMinor).toBe(moneyFromMajor(320))
  })

  it('falls back to the material market price when no per-line price is set (regression)', () => {
    const { materialId } = seedMasters()
    const productId = createProduct({ code: 'PC-PRICE-2', name: 'رف' }, env.ctx)
    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(4), unit: 'لوح' }], env.ctx)

    expect(getProduct(productId).bom[0]!.unitPriceMicro).toBeNull()
    expect(productManufacturingCost(productId).materialCostMinor).toBe(moneyFromMajor(400)) // 4 × 100
  })

  it('persists the price across an application restart', () => {
    const { materialId } = seedMasters()
    const productId = createProduct({ code: 'PC-PRICE-3', name: 'رف' }, env.ctx)
    replaceBom(productId, [
      { materialId, qtyMicro: quantityFromDisplay(2), unit: 'لوح', unitPriceMicro: unitCostFromMajor(55) }
    ], env.ctx)

    closeDatabase()

    expect(getProduct(productId).bom[0]!.unitPriceMicro).toBe(unitCostFromMajor(55))
  })

  it('rejects a negative price server-side', () => {
    const { materialId } = seedMasters()
    const productId = createProduct({ code: 'PC-PRICE-4', name: 'رف' }, env.ctx)
    expect(() =>
      replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(1), unit: 'لوح', unitPriceMicro: -1 }], env.ctx)
    ).toThrowError(/سالباً/)
    expect(getProduct(productId).bom).toHaveLength(0)
  })

  it('BR-11/BR-32: respects an indivisible/whole-unit material pricing rule in the estimate', () => {
    const categoryId = createCategory({ name: 'إكسسوارات' }, env.ctx)
    // A material sold only by the full box of 10 pieces.
    const boxMaterialId = createMaterial({
      sku: 'BOX-10', name: 'علبة مسامير', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(1), pricingRule: 'full_unit',
      commercialUnitSizeMicro: quantityFromDisplay(10)
    } as never, env.ctx)
    const productId = createProduct({ code: 'PC-PRICE-5', name: 'خزانة' }, env.ctx)

    // Needs only 3 pieces per unit product — but the material can only
    // be charged a full box (10) at a time, exactly like it would be
    // charged to a customer via commercialQuantityFor.
    replaceBom(productId, [
      { materialId: boxMaterialId, qtyMicro: quantityFromDisplay(3), unit: 'قطعة', unitPriceMicro: unitCostFromMajor(1) }
    ], env.ctx)

    // NOT 3 × 1 = 3 — the whole 10-piece box is charged: 10 × 1 = 10.
    expect(productManufacturingCost(productId).materialCostMinor).toBe(moneyFromMajor(10))
  })

  it('an "exact" material is charged for precisely the physical quantity needed — no over-rounding', () => {
    const { materialId } = seedMasters() // pricingRule 'exact'
    const productId = createProduct({ code: 'PC-PRICE-6', name: 'رف' }, env.ctx)
    replaceBom(productId, [
      { materialId, qtyMicro: quantityFromDisplay(2.5), unit: 'لوح', unitPriceMicro: unitCostFromMajor(10) }
    ], env.ctx)

    expect(productManufacturingCost(productId).materialCostMinor).toBe(moneyFromMajor(25)) // 2.5 × 10, unrounded
  })

  it('a "manual" pricing-rule material falls back to the physical quantity (no product-level manual override exists)', () => {
    const categoryId = createCategory({ name: 'مواد خاصة' }, env.ctx)
    const manualMaterialId = createMaterial({
      sku: 'MANUAL-1', name: 'مادة يدوية التسعير', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(1), pricingRule: 'manual'
    } as never, env.ctx)
    const productId = createProduct({ code: 'PC-PRICE-7', name: 'خزانة' }, env.ctx)
    replaceBom(productId, [
      { materialId: manualMaterialId, qtyMicro: quantityFromDisplay(4), unit: 'قطعة', unitPriceMicro: unitCostFromMajor(2) }
    ], env.ctx)

    expect(productManufacturingCost(productId).materialCostMinor).toBe(moneyFromMajor(8)) // 4 × 2, no throw
  })

  it('the grand total combines a priced material line with machines and commissions correctly', () => {
    const { materialId, machineId, workerId } = seedMasters()
    const productId = createProduct({ code: 'PC-PRICE-8', name: 'خزانة كاملة' }, env.ctx)
    replaceBom(productId, [
      { materialId, qtyMicro: quantityFromDisplay(3), unit: 'لوح', unitPriceMicro: unitCostFromMajor(50) }
    ], env.ctx) // 150
    replaceProductMachines(productId, [{ machineId, usageQtyMicro: quantityFromDisplay(1) }], env.ctx) // 20
    replaceProductCommission(productId, [{ workerId, amountMinor: moneyFromMajor(30) }], env.ctx) // 30

    const cost = productManufacturingCost(productId)
    expect(cost.materialCostMinor).toBe(moneyFromMajor(150))
    expect(cost.machineCostMinor).toBe(moneyFromMajor(20))
    expect(cost.commissionCostMinor).toBe(moneyFromMajor(30))
    expect(cost.manufacturingCostMinor).toBe(moneyFromMajor(200))
  })

  it('the standard-cost estimate updates live when the configuration changes, and never affects finished-goods stock', () => {
    const { materialId } = seedMasters()
    const productId = createProduct({ code: 'PC-PRICE-9', name: 'رف' }, env.ctx)
    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(1), unit: 'لوح', unitPriceMicro: unitCostFromMajor(10) }], env.ctx)
    expect(productManufacturingCost(productId).materialCostMinor).toBe(moneyFromMajor(10))

    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(1), unit: 'لوح', unitPriceMicro: unitCostFromMajor(40) }], env.ctx)
    expect(productManufacturingCost(productId).materialCostMinor).toBe(moneyFromMajor(40))

    // Purely a read-side calculation — no inventory/finished-goods side effect.
    expect((getRawConnection().prepare('SELECT COUNT(*) AS c FROM finished_goods_movements').get() as { c: number }).c).toBe(0)
  })
})

describe('Manufacturing cost stays separated: material + machine + commission = total', () => {
  it('computes each component independently and their sum as the total', () => {
    const { materialId, machineId, workerId } = seedMasters()
    const productId = createProduct({ code: 'PC-9', name: 'خزانة كاملة' }, env.ctx)
    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(4), unit: 'لوح' }], env.ctx)
    replaceProductMachines(productId, [{ machineId, usageQtyMicro: quantityFromDisplay(1) }], env.ctx)
    replaceProductCommission(productId, [{ workerId, amountMinor: moneyFromMajor(15) }], env.ctx)

    const cost = productManufacturingCost(productId)
    expect(cost.materialCostMinor).toBe(moneyFromMajor(400)) // 4 boards × 100
    expect(cost.machineCostMinor).toBe(moneyFromMajor(20)) // 1 hour × 20
    expect(cost.commissionCostMinor).toBe(moneyFromMajor(15))
    expect(cost.manufacturingCostMinor).toBe(moneyFromMajor(435))

    // getProduct returns materials, machines and commission as three
    // clearly separated lists, plus the same cost breakdown.
    const full = getProduct(productId)
    expect(full.bom).toHaveLength(1)
    expect(full.machines).toHaveLength(1)
    expect(full.commission).toHaveLength(1)
    expect(full.cost).toEqual(cost)
  })

  it('existing products and their saved BOM still load correctly with no machines/commission configured', () => {
    const { materialId } = seedMasters()
    const productId = createProduct({ code: 'PC-10', name: 'رف بسيط' }, env.ctx)
    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(2), unit: 'لوح' }], env.ctx)

    const full = getProduct(productId)
    expect(full.bom).toHaveLength(1)
    expect(full.machines).toHaveLength(0)
    expect(full.commission).toHaveLength(0)
    expect(full.cost.machineCostMinor).toBe(0)
    expect(full.cost.commissionCostMinor).toBe(0)
    expect(full.cost.materialCostMinor).toBe(moneyFromMajor(200))
  })
})

describe('Production Order integration (item 8) — stock production uses the saved configuration', () => {
  it('a stock production order snapshots materials, machines AND standard commission as PLANNING rows only', () => {
    const { materialId, machineId, workerId } = seedMasters()
    const productId = createProduct({ code: 'PC-11', name: 'خزانة إنتاج' }, env.ctx)
    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(4), unit: 'لوح' }], env.ctx)
    replaceProductMachines(productId, [{ machineId, usageQtyMicro: quantityFromDisplay(1) }], env.ctx)
    replaceProductCommission(productId, [{ workerId, amountMinor: moneyFromMajor(15) }], env.ctx)

    // Produce 3 units — everything should scale by 3.
    const sheet = insertHistoricalStockSheet(productId, quantityFromDisplay(3))

    const materials = listPlannedMaterials({ workSheetId: sheet.id })
    const machines = listPlannedMachines({ workSheetId: sheet.id })
    const workersPlan = listPlannedWorkers({ workSheetId: sheet.id })
    expect(materials).toHaveLength(1)
    expect(materials[0]!.qtyMicro).toBe(quantityFromDisplay(12)) // 4 × 3
    expect(machines).toHaveLength(1)
    expect(machines[0]!.usageQtyMicro).toBe(quantityFromDisplay(3)) // 1 × 3
    expect(machines[0]!.estimatedCostMinor).toBe(moneyFromMajor(60)) // 3h × 20
    expect(workersPlan).toHaveLength(1)
    expect(workersPlan[0]!.estimatedCostMinor).toBe(moneyFromMajor(45)) // 15 × 3

    // Item 8: issuing the production order created NO actual financial
    // transaction — no machine usage, no worker assignment, no earning.
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM order_machine_usage').get() as { c: number }).toEqual({ c: 0 })
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM order_worker_assignments').get() as { c: number }).toEqual({ c: 0 })
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM worker_transactions').get() as { c: number }).toEqual({ c: 0 })
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM inventory_movements').get() as { c: number }).toEqual({ c: 0 })
  })

  it('a product with no machine/commission configuration cannot enter the retired stock-MO workflow', () => {
    const { materialId } = seedMasters()
    const productId = createProduct({ code: 'PC-12', name: 'منتج بسيط' }, env.ctx)
    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(1), unit: 'لوح' }], env.ctx)
    expect(() => issueWorkSheet({ productId, quantityMicro: quantityFromDisplay(1) }, env.ctx)).toThrow(/صرف من المخزون/)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM work_sheets').get()).toEqual({ c: 0 })
  })
})

describe('Historical integrity (item 9) — later config edits never rewrite an issued production order', () => {
  it('changing the product machine/commission configuration after issuance leaves the already-issued snapshot untouched', () => {
    const { materialId, machineId, workerId } = seedMasters()
    const productId = createProduct({ code: 'PC-13', name: 'خزانة تاريخية' }, env.ctx)
    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(1), unit: 'لوح' }], env.ctx)
    replaceProductMachines(productId, [{ machineId, usageQtyMicro: quantityFromDisplay(1) }], env.ctx)
    replaceProductCommission(productId, [{ workerId, amountMinor: moneyFromMajor(10) }], env.ctx)

    const sheet = insertHistoricalStockSheet(productId, quantityFromDisplay(1))
    const frozenMachineCost = listPlannedMachines({ workSheetId: sheet.id })[0]!.estimatedCostMinor
    const frozenCommission = listPlannedWorkers({ workSheetId: sheet.id })[0]!.estimatedCostMinor

    // Now change the product's standard configuration drastically.
    const newMachineId = createMachine({ name: 'آلة أخرى', costingUnit: 'ساعة', defaultRateMicro: unitCostFromMajor(999) }, env.ctx)
    replaceProductMachines(productId, [{ machineId: newMachineId, usageQtyMicro: quantityFromDisplay(5) }], env.ctx)
    replaceProductCommission(productId, [{ workerId, amountMinor: moneyFromMajor(500) }], env.ctx)

    // The already-issued work sheet's frozen snapshot is unchanged.
    expect(listPlannedMachines({ workSheetId: sheet.id })[0]!.estimatedCostMinor).toBe(frozenMachineCost)
    expect(listPlannedWorkers({ workSheetId: sheet.id })[0]!.estimatedCostMinor).toBe(frozenCommission)

    // Future atomic production reads the current Product Components configuration.
    expect(getProductMachines(productId)[0]!.machineId).toBe(newMachineId)
    expect(getProductCommission(productId)[0]!.amountMinor).toBe(moneyFromMajor(500))
  })

  it('changing a material\'s per-line "السعر" after issuance never rewrites an already-issued production order', () => {
    const { materialId } = seedMasters()
    const productId = createProduct({ code: 'PC-PRICE-HIST', name: 'خزانة تاريخية' }, env.ctx)
    replaceBom(productId, [
      { materialId, qtyMicro: quantityFromDisplay(10), unit: 'لوح', unitPriceMicro: unitCostFromMajor(20) }
    ], env.ctx)

    const sheet = insertHistoricalStockSheet(productId, quantityFromDisplay(1))
    const frozenPlannedQty = listPlannedMaterials({ workSheetId: sheet.id })[0]!.qtyMicro

    // Changing the standard-cost template afterwards…
    replaceBom(productId, [
      { materialId, qtyMicro: quantityFromDisplay(10), unit: 'لوح', unitPriceMicro: unitCostFromMajor(999) }
    ], env.ctx)

    // …never rewrites the already-issued work sheet's material plan —
    // it is a frozen snapshot, structurally independent of
    // productManufacturingCost (a pure read never invoked by issuance
    // for this purpose, only used by the "التكلفة الإنتاجية" tab).
    expect(listPlannedMaterials({ workSheetId: sheet.id })[0]!.qtyMicro).toBe(frozenPlannedQty)
    // The STANDARD estimate itself, read fresh, does reflect the new price.
    expect(productManufacturingCost(productId).materialCostMinor).toBe(moneyFromMajor(9990))
  })
})

describe('Finished-goods data stays intact and untouched by this pass', () => {
  it('listFinishedGoods still works correctly — the UI column removal was display-only', () => {
    const { materialId } = seedMasters()
    const productId = createProduct({ code: 'PC-STOCK-1', name: 'منتج بمخزون' }, env.ctx)
    replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(1), unit: 'لوح' }], env.ctx)

    const supplierId = createSupplier({ name: 'مورد مخزون' }, env.ctx)
    createPurchase({ supplierId, lines: [{ materialId, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(100) }] }, env.ctx)
    issueStandardStockFromBom({ productId, quantityMicro: quantityFromDisplay(5), requestKey: 'product-config-stock-issue' }, env.ctx)

    const stock = listFinishedGoods({ productId })
    expect(stock).toHaveLength(1)
    expect(stock[0]!.onHandMicro).toBe(quantityFromDisplay(5))
  })
})

describe('RBAC — Product Components machine/commission endpoints stay server-enforced (item 11)', () => {
  let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
  let windowId = 51000
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

  function signInViewOnly(): void {
    const roleId = createRole({ name: `مشاهد-${Math.random()}`, permissions: [P.products.view] }, env.ctx)
    const username = `viewer${Math.floor(Math.random() * 1e9)}`
    createUser({ username, password: 'secret789', fullName: 'مستخدم مشاهدة فقط', roleId }, env.ctx)
    login(username, 'secret789', windowId)
  }

  it('refuses products:setMachines and products:setCommission for a role without products.manage', async () => {
    const { machineId, workerId } = seedMasters()
    const productId = createProduct({ code: 'PC-14', name: 'منتج محمي' }, env.ctx)
    signInViewOnly()

    const machineResult = await invoke(IPC_CHANNELS.products.setMachines, {
      productId, lines: [{ machineId, usageQtyMicro: quantityFromDisplay(1) }]
    })
    expect(machineResult.ok).toBe(false)
    if (!machineResult.ok) expect(machineResult.error.code).toBe('FORBIDDEN')

    const commissionResult = await invoke(IPC_CHANNELS.products.setCommission, {
      productId, lines: [{ workerId, amountMinor: moneyFromMajor(10) }]
    })
    expect(commissionResult.ok).toBe(false)
    if (!commissionResult.ok) expect(commissionResult.error.code).toBe('FORBIDDEN')

    expect(getProductMachines(productId)).toHaveLength(0)
    expect(getProductCommission(productId)).toHaveLength(0)
  })

  it('still allows products:get (read) for view-only access', async () => {
    const productId = createProduct({ code: 'PC-15', name: 'منتج للعرض' }, env.ctx)
    signInViewOnly()
    const result = await invoke(IPC_CHANNELS.products.get, { id: productId })
    expect(result.ok).toBe(true)
  })

  it('item 12: the material price is protected by the exact same setBom authorization — no client-only rule', async () => {
    const { materialId } = seedMasters()
    const productId = createProduct({ code: 'PC-16', name: 'منتج محمي 2' }, env.ctx)
    signInViewOnly()

    const result = await invoke(IPC_CHANNELS.products.setBom, {
      productId, lines: [{ materialId, qtyMicro: quantityFromDisplay(1), unit: 'لوح', unitPriceMicro: unitCostFromMajor(5) }]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    expect(getProduct(productId).bom).toHaveLength(0)
  })
})
