import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { closeDatabase, getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { createCategory, createColor, createMaterial, updateColor } from '@main/services/catalog/catalog.service'
import { createMachine, updateMachine } from '@main/services/production/machines.service'
import { issueWorkSheet } from '@main/services/production/production.service'
import {
  listPlannedMachines,
  listPlannedMaterials,
  orderPlanningSnapshot,
  savePlannedMachines,
  savePlannedMaterials
} from '@main/services/planning/planning.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function makeOrder() {
  const customerId = createCustomer({ name: 'عميل تجهيز الإنتاج' }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    depositPercentBp: 0,
    lines: [{
      lineKind: 'custom', description: 'طلب تجهيز', quantityMicro: quantityFromDisplay(1),
      unitPriceMinor: moneyFromMajor(5_000)
    }]
  }, env.ctx)
  return approveToOrder(invoice.id, env.ctx)
}

function makeMaterial() {
  const categoryId = createCategory({ name: 'مواد اختبار اللون' }, env.ctx)
  return createMaterial({
    sku: 'COLOR-MDF', name: 'MDF لون', categoryId, unit: 'لوح',
    currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact'
  } as never, env.ctx)
}

describe('Production Preparation material color/finish catalog', () => {
  it('uses a catalog code snapshot, persists across reopen, creates no duplicate or stock movement', () => {
    const order = makeOrder()
    const materialId = makeMaterial()
    const colorId = createColor({ code: 'DEMO-G', name: 'رمادي - تجريبي' }, env.ctx)
    const raw = getRawConnection()
    const colorsBefore = (raw.prepare('SELECT COUNT(*) AS c FROM color_finish_catalog').get() as { c: number }).c
    const movementsBefore = (raw.prepare('SELECT COUNT(*) AS c FROM inventory_movements').get() as { c: number }).c

    savePlannedMaterials({ orderId: order.id }, [{
      materialId, materialName: 'MDF لون', qtyMicro: quantityFromDisplay(2),
      colorCode: 'DEMO-G', estimatedUnitCostMicro: unitCostFromMajor(100)
    }], env.ctx)

    expect(listPlannedMaterials({ orderId: order.id })[0]?.colorCode).toBe('DEMO-G')
    expect((raw.prepare('SELECT COUNT(*) AS c FROM color_finish_catalog').get() as { c: number }).c).toBe(colorsBefore)
    expect((raw.prepare('SELECT COUNT(*) AS c FROM inventory_movements').get() as { c: number }).c).toBe(movementsBefore)

    closeDatabase()
    expect(listPlannedMaterials({ orderId: order.id })[0]?.colorCode).toBe('DEMO-G')

    // Renaming the master cannot rewrite history. The old snapshot can
    // still pass through an otherwise unchanged replace-all save.
    updateColor(colorId, { code: 'DEMO-G-NEW', name: 'رمادي جديد' }, env.ctx)
    const historical = listPlannedMaterials({ orderId: order.id })[0]!
    savePlannedMaterials({ orderId: order.id }, [{
      id: historical.id,
      materialId: historical.materialId,
      materialName: historical.materialName,
      qtyMicro: historical.qtyMicro,
      unit: historical.unit,
      dimensions: historical.dimensions,
      thickness: historical.thickness,
      colorCode: historical.colorCode,
      notes: historical.notes,
      estimatedUnitCostMicro: historical.estimatedUnitCostMicro
    }], env.ctx)
    expect(listPlannedMaterials({ orderId: order.id })[0]?.colorCode).toBe('DEMO-G')
  })

  it('rejects arbitrary free text that is neither active catalog data nor an unchanged historical snapshot', () => {
    const order = makeOrder()
    const materialId = makeMaterial()
    expect(() => savePlannedMaterials({ orderId: order.id }, [{
      materialId, materialName: 'MDF لون', qtyMicro: quantityFromDisplay(1),
      colorCode: 'نص حر غير موجود'
    }], env.ctx)).toThrowError(/الكتالوج المعتمد/)
  })
})

describe('Production Preparation authoritative machine auto-costing', () => {
  it('snapshots machine configuration and derives usage × rate, ignoring a supplied total', () => {
    const order = makeOrder()
    const machineId = createMachine({ name: 'CNC 30', costingUnit: 'ساعة', defaultRateMicro: unitCostFromMajor(30) }, env.ctx)

    savePlannedMachines({ orderId: order.id }, [{
      machineId, machineName: 'اسم عميل غير موثوق', usageQtyMicro: quantityFromDisplay(10),
      usageUnit: 'وحدة مزورة', estimatedCostMinor: moneyFromMajor(99_999)
    }], env.ctx)

    expect(listPlannedMachines({ orderId: order.id })[0]).toMatchObject({
      machineId, machineName: 'CNC 30', usageQtyMicro: quantityFromDisplay(10),
      usageUnit: 'ساعة', rateMicro: unitCostFromMajor(30), estimatedCostMinor: moneyFromMajor(300)
    })
    expect(orderPlanningSnapshot(order.id).estimatedMachineMinor).toBe(moneyFromMajor(300))
    expect(orderPlanningSnapshot(order.id).totalEstimatedCostMinor).toBe(moneyFromMajor(300))
  })

  it('recalculates usage with the frozen rate, and changing machine loads the new machine rate', () => {
    const order = makeOrder()
    const firstId = createMachine({ name: 'آلة أولى', costingUnit: 'ساعة', defaultRateMicro: unitCostFromMajor(30) }, env.ctx)
    const secondId = createMachine({ name: 'آلة ثانية', costingUnit: 'دورة', defaultRateMicro: unitCostFromMajor(40) }, env.ctx)
    savePlannedMachines({ orderId: order.id }, [{
      machineId: firstId, machineName: 'آلة أولى', usageQtyMicro: quantityFromDisplay(10)
    }], env.ctx)

    const firstLine = listPlannedMachines({ orderId: order.id })[0]!
    updateMachine(firstId, { defaultRateMicro: unitCostFromMajor(999) }, env.ctx)
    savePlannedMachines({ orderId: order.id }, [{
      id: firstLine.id, machineId: firstId, machineName: firstLine.machineName,
      usageQtyMicro: quantityFromDisplay(5), usageUnit: firstLine.usageUnit
    }], env.ctx)
    expect(listPlannedMachines({ orderId: order.id })[0]).toMatchObject({
      rateMicro: unitCostFromMajor(30), estimatedCostMinor: moneyFromMajor(150)
    })

    const edited = listPlannedMachines({ orderId: order.id })[0]!
    savePlannedMachines({ orderId: order.id }, [{
      id: edited.id, machineId: secondId, machineName: edited.machineName,
      usageQtyMicro: quantityFromDisplay(5), usageUnit: edited.usageUnit
    }], env.ctx)
    expect(listPlannedMachines({ orderId: order.id })[0]).toMatchObject({
      machineId: secondId, machineName: 'آلة ثانية', usageUnit: 'دورة',
      rateMicro: unitCostFromMajor(40), estimatedCostMinor: moneyFromMajor(200)
    })
  })

  it('models a configured per-job operation as one usage unit', () => {
    const order = makeOrder()
    const machineId = createMachine({ name: 'تشغيل ثابت', costingUnit: 'عملية', defaultRateMicro: unitCostFromMajor(120) }, env.ctx)
    savePlannedMachines({ orderId: order.id }, [{
      machineId, machineName: 'تشغيل ثابت', usageQtyMicro: quantityFromDisplay(1)
    }], env.ctx)
    expect(listPlannedMachines({ orderId: order.id })[0]?.estimatedCostMinor).toBe(moneyFromMajor(120))
  })

  it('fails safely when the selected machine has no configured unit cost', () => {
    const order = makeOrder()
    const machineId = createMachine({ name: 'بلا سعر', costingUnit: 'ساعة', defaultRateMicro: 0 }, env.ctx)
    expect(() => savePlannedMachines({ orderId: order.id }, [{
      machineId, machineName: 'بلا سعر', usageQtyMicro: quantityFromDisplay(2)
    }], env.ctx)).toThrowError(/لم تُضبط تكلفة الوحدة/)
    expect(listPlannedMachines({ orderId: order.id })).toHaveLength(0)
  })

  it('keeps legacy manual rows readable and unchanged until enough source data is edited', () => {
    const order = makeOrder()
    const machineId = createMachine({ name: 'آلة قديمة', costingUnit: 'ساعة', defaultRateMicro: unitCostFromMajor(30) }, env.ctx)
    getRawConnection().prepare(`
      INSERT INTO planned_machines (order_id, machine_id, machine_name, usage_qty_micro, usage_unit, estimated_cost_minor)
      VALUES (?, ?, 'لقطة آلة قديمة', ?, 'ساعة', ?)
    `).run(order.id, machineId, quantityFromDisplay(2), moneyFromMajor(777))

    const legacy = listPlannedMachines({ orderId: order.id })[0]!
    expect(legacy).toMatchObject({ rateMicro: null, estimatedCostMinor: moneyFromMajor(777) })
    savePlannedMachines({ orderId: order.id }, [{
      id: legacy.id, machineId: legacy.machineId, machineName: legacy.machineName,
      usageQtyMicro: legacy.usageQtyMicro, usageUnit: legacy.usageUnit
    }], env.ctx)
    expect(listPlannedMachines({ orderId: order.id })[0]).toMatchObject({
      rateMicro: null, estimatedCostMinor: moneyFromMajor(777)
    })

    const preserved = listPlannedMachines({ orderId: order.id })[0]!
    savePlannedMachines({ orderId: order.id }, [{
      id: preserved.id, machineId: preserved.machineId, machineName: preserved.machineName,
      usageQtyMicro: quantityFromDisplay(3), usageUnit: preserved.usageUnit
    }], env.ctx)
    expect(listPlannedMachines({ orderId: order.id })[0]).toMatchObject({
      rateMicro: unitCostFromMajor(30), estimatedCostMinor: moneyFromMajor(90)
    })
  })

  it('reopens with the saved basis and snapshots it onto a Manufacturing Order without actual usage', () => {
    const order = makeOrder()
    const machineId = createMachine({ name: 'آلة أمر التصنيع', costingUnit: 'ساعة', defaultRateMicro: unitCostFromMajor(30) }, env.ctx)
    savePlannedMachines({ orderId: order.id }, [{
      machineId, machineName: 'آلة أمر التصنيع', usageQtyMicro: quantityFromDisplay(10)
    }], env.ctx)

    closeDatabase()
    expect(listPlannedMachines({ orderId: order.id })[0]).toMatchObject({
      rateMicro: unitCostFromMajor(30), estimatedCostMinor: moneyFromMajor(300)
    })
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    expect(listPlannedMachines({ workSheetId: sheet.id })[0]).toMatchObject({
      rateMicro: unitCostFromMajor(30), estimatedCostMinor: moneyFromMajor(300)
    })
    expect((getRawConnection().prepare('SELECT COUNT(*) AS c FROM order_machine_usage').get() as { c: number }).c).toBe(0)
  })
})
