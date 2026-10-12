import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { savePlannedMaterials, orderPlanningSnapshot } from '@main/services/planning/planning.service'
import { getProductionOrder, issueWorkSheet, listWorkSheets } from '@main/services/production/production.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { getRawConnection } from '@main/db/connection'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import type { ServiceContext } from '@main/services/base/service.types'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function setup(required = 10, stocked = 20) {
  const categoryId = createCategory({ name: 'مواد إصدار ذري' }, env.ctx)
  const materialId = createMaterial({
    sku: `MO-AUTO-${Math.random()}`,
    name: 'MDF 18mm',
    categoryId,
    unit: 'لوحة',
    currentMarketPriceMicro: unitCostFromMajor(150),
    pricingRule: 'exact'
  } as never, env.ctx)
  const supplierId = createSupplier({ name: 'مورد إصدار ذري' }, env.ctx)
  createPurchase({
    supplierId,
    lines: [{ materialId, qtyMicro: quantityFromDisplay(stocked), unitCostMicro: unitCostFromMajor(100) }]
  }, env.ctx)
  const customerId = createCustomer({ name: 'عميل إصدار ذري' }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    lines: [{
      lineKind: 'custom', description: 'طلب MDF', quantityMicro: quantityFromDisplay(1),
      unitPriceMinor: moneyFromMajor(1500)
    }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  savePlannedMaterials({ orderId: order.id }, [{
    materialId,
    materialName: 'MDF 18mm',
    qtyMicro: quantityFromDisplay(required),
    unit: 'لوحة',
    estimatedUnitCostMicro: unitCostFromMajor(150)
  }], env.ctx)
  recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
  return { materialId, order }
}

describe('atomic Manufacturing Order material issuance', () => {
  it('creates one worksheet and one historical-cost issue while preserving the estimate', () => {
    const { materialId, order } = setup()
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    expect(availableQty(materialId)).toBe(quantityFromDisplay(10))
    expect(getProductionOrder(sheet.id).materialLines).toMatchObject([{
      physicalQtyMicro: quantityFromDisplay(10),
      actualCostMinor: moneyFromMajor(1000)
    }])
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(moneyFromMajor(1000))
    expect(orderPlanningSnapshot(order.id).materials[0]).toMatchObject({
      qtyMicro: quantityFromDisplay(10),
      estimatedTotalMinor: moneyFromMajor(1500)
    })
    const audit = getRawConnection().prepare(
      "SELECT details FROM audit_log WHERE action = 'worksheets.issue' ORDER BY id DESC LIMIT 1"
    ).get() as { details: string }
    expect(JSON.parse(audit.details)).toMatchObject({
      orderId: order.id,
      actualMaterialCostMinor: moneyFromMajor(1000),
      issuedMaterials: [{ materialId, quantityMicro: quantityFromDisplay(10), actualCostMinor: moneyFromMajor(1000) }]
    })
  })

  it('rolls back the worksheet, issue and cost when any required stock is insufficient', () => {
    const { materialId, order } = setup(10, 7)

    expect(() => issueWorkSheet({ orderId: order.id }, env.ctx))
      .toThrowError(/الرصيد المتاح لمادة MDF 18mm هو 7 لوحة، والكمية المطلوبة هي 10 لوحة/)
    expect(listWorkSheets({ orderId: order.id }).items).toHaveLength(0)
    expect(availableQty(materialId)).toBe(quantityFromDisplay(7))
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(0)
    expect(getRawConnection().prepare(
      'SELECT COUNT(*) AS c FROM order_material_lines WHERE order_id = ?'
    ).get(order.id)).toEqual({ c: 0 })
  })

  it('makes retries idempotent at the persisted one-time workflow boundary', () => {
    const { materialId, order } = setup()
    issueWorkSheet({ orderId: order.id }, env.ctx)

    expect(() => issueWorkSheet({ orderId: order.id }, env.ctx)).toThrowError(/بالفعل/)
    expect(listWorkSheets({ orderId: order.id }).items).toHaveLength(1)
    expect(availableQty(materialId)).toBe(quantityFromDisplay(10))
    expect(getRawConnection().prepare(
      'SELECT COUNT(*) AS c FROM order_material_lines WHERE order_id = ?'
    ).get(order.id)).toEqual({ c: 1 })
  })

  it('requires both worksheet issuance and inventory consumption permission in the service', () => {
    const { materialId, order } = setup()
    const limited: ServiceContext = {
      session: {
        ...env.ctx.session,
        user: { ...env.ctx.session.user, isAdmin: false },
        permissions: [P.worksheets.issue]
      }
    }

    expect(() => issueWorkSheet({ orderId: order.id }, limited)).toThrowError(/صلاحية/)
    expect(listWorkSheets({ orderId: order.id }).items).toHaveLength(0)
    expect(availableQty(materialId)).toBe(quantityFromDisplay(20))
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
