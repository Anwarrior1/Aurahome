import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier, customerBalances, supplierBalances } from '@main/services/parties/parties.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import {
  createPurchase,
  deletePurchase,
  getPurchase,
  listPurchases,
  purchasesForOrder,
  updatePurchase
} from '@main/services/purchasing/purchasing.service'
import { fullDeleteOrder, fullDeletePreview } from '@main/services/sales/orders.service'
import { listPlannedMaterials, savePlannedMaterials } from '@main/services/planning/planning.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function makeOrder(customerName: string) {
  const customerId = createCustomer({ name: customerName }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    lines: [{
      lineKind: 'custom', description: 'عمل حسب الطلب',
      quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(5_000)
    }]
  }, env.ctx)
  return approveToOrder(invoice.id, env.ctx)
}

function masters() {
  const categoryId = createCategory({ name: 'ألواح مشتريات الطلب' }, env.ctx)
  const materialId = createMaterial({
    sku: 'MDF-JOB', name: 'MDF', categoryId, unit: 'لوح',
    currentMarketPriceMicro: unitCostFromMajor(120), pricingRule: 'exact'
  }, env.ctx)
  const supplierId = createSupplier({ name: 'test supplier' }, env.ctx)
  return { materialId, supplierId }
}

describe('job-linked purchase invoices', () => {
  it('persists, lists, filters and totals linked invoices without touching production preparation or actual profitability', () => {
    const order = makeOrder('عميل تجريبي')
    const { materialId, supplierId } = masters()
    savePlannedMaterials({ orderId: order.id }, [{
      materialId,
      materialName: 'MDF',
      qtyMicro: quantityFromDisplay(5),
      estimatedUnitCostMicro: unitCostFromMajor(120)
    }], env.ctx)

    const planBefore = listPlannedMaterials({ orderId: order.id })
    const actualCostBefore = orderCostBreakdown(order.id)
    const customerBefore = customerBalances().find((row) => row.customerId === order.customerId)

    const first = createPurchase({
      supplierId,
      customerOrderId: order.id,
      paidNowMinor: moneyFromMajor(400),
      lines: [{
        materialId,
        qtyMicro: quantityFromDisplay(10),
        unitCostMicro: unitCostFromMajor(100)
      }]
    }, env.ctx)
    const second = createPurchase({
      supplierId,
      customerOrderId: order.id,
      lines: [{
        materialId,
        qtyMicro: quantityFromDisplay(5),
        unitCostMicro: unitCostFromMajor(100)
      }]
    }, env.ctx)

    expect(getPurchase(first.id).purchase.customerOrderId).toBe(order.id)
    expect(getPurchase(first.id).purchase.customerOrderNumber).toBe(order.documentNumber)
    expect(getPurchase(first.id).purchase.customerName).toBe('عميل تجريبي')
    expect(listPurchases({ customerOrderId: order.id }).items).toHaveLength(2)
    expect(listPurchases({ customerOrderId: order.id }).items[0]).toMatchObject({
      customerOrderNumber: order.documentNumber,
      customerName: 'عميل تجريبي'
    })
    expect(purchasesForOrder(order.id).totalMinor).toBe(moneyFromMajor(1_500))

    expect(listPlannedMaterials({ orderId: order.id })).toEqual(planBefore)
    expect(listPlannedMaterials({ orderId: order.id })[0]?.qtyMicro).toBe(quantityFromDisplay(5))
    expect(getRawConnection().prepare('SELECT COUNT(*) AS count FROM work_sheets WHERE order_id = ?')
      .get(order.id)).toEqual({ count: 0 })
    expect(availableQty(materialId)).toBe(quantityFromDisplay(15))

    expect(orderCostBreakdown(order.id)).toEqual(actualCostBefore)
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(0)
    expect(customerBalances().find((row) => row.customerId === order.customerId)).toEqual(customerBefore)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS count FROM customer_payments WHERE order_id = ?')
      .get(order.id)).toEqual({ count: 0 })
    expect(getRawConnection().prepare('SELECT COUNT(*) AS count FROM supplier_payments WHERE purchase_id = ?')
      .get(first.id)).toEqual({ count: 1 })
    expect(supplierBalances().find((row) => row.supplierId === supplierId)).toMatchObject({
      purchasedMinor: moneyFromMajor(1_500),
      paidMinor: moneyFromMajor(400),
      remainingMinor: moneyFromMajor(1_100)
    })

    expect(() => deletePurchase(second.id, env.ctx)).toThrowError(/سجل تجاري ومخزني مُرحّل/)
    expect(purchasesForOrder(order.id).totalMinor).toBe(moneyFromMajor(1_500))
    expect(availableQty(materialId)).toBe(quantityFromDisplay(15))
    expect(listPlannedMaterials({ orderId: order.id })).toEqual(planBefore)
  })

  it('supports a general purchase with a null order link', () => {
    const { materialId, supplierId } = masters()
    const purchase = createPurchase({
      supplierId,
      customerOrderId: null,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(1), unitCostMicro: unitCostFromMajor(50) }]
    }, env.ctx)

    expect(getPurchase(purchase.id).purchase.customerOrderId).toBeNull()
    expect(listPurchases({ unassignedOnly: true }).items).toHaveLength(1)
  })

  it('allows an audited attribution change because it moves no stock or financial history', () => {
    const firstOrder = makeOrder('العميل الأول')
    const secondOrder = makeOrder('العميل الثاني')
    const { materialId, supplierId } = masters()
    const purchase = createPurchase({
      supplierId,
      customerOrderId: firstOrder.id,
      paidNowMinor: moneyFromMajor(100),
      lines: [{ materialId, qtyMicro: quantityFromDisplay(2), unitCostMicro: unitCostFromMajor(50) }]
    }, env.ctx)
    const inventoryBefore = availableQty(materialId)
    const supplierBefore = supplierBalances().find((row) => row.supplierId === supplierId)

    updatePurchase(purchase.id, { customerOrderId: secondOrder.id }, env.ctx)

    expect(purchasesForOrder(firstOrder.id).totalMinor).toBe(0)
    expect(purchasesForOrder(secondOrder.id).totalMinor).toBe(moneyFromMajor(100))
    expect(availableQty(materialId)).toBe(inventoryBefore)
    expect(supplierBalances().find((row) => row.supplierId === supplierId)).toEqual(supplierBefore)
    const audit = getRawConnection().prepare(`SELECT details FROM audit_log
      WHERE action = 'purchases.update' ORDER BY id DESC LIMIT 1`).get() as { details: string }
    expect(JSON.parse(audit.details)).toMatchObject({
      customerOrderChanged: true,
      fromCustomerOrderId: firstOrder.id,
      toCustomerOrderId: secondOrder.id,
      linesChanged: false
    })
  })

  it('rejects nonexistent order ids server-side and protects linked purchases from order deletion', () => {
    const order = makeOrder('عميل محمي')
    const { materialId, supplierId } = masters()

    expect(() => createPurchase({
      supplierId,
      customerOrderId: 999_999,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(1), unitCostMicro: unitCostFromMajor(50) }]
    }, env.ctx)).toThrowError(/الطلب المرتبط غير موجود/)

    const purchase = createPurchase({
      supplierId,
      customerOrderId: order.id,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(1), unitCostMicro: unitCostFromMajor(50) }]
    }, env.ctx)
    expect(() => updatePurchase(purchase.id, { customerOrderId: 999_999 }, env.ctx))
      .toThrowError(/الطلب المرتبط غير موجود/)
    expect(fullDeletePreview(order.id)).toMatchObject({
      dependencies: expect.arrayContaining([expect.objectContaining({ key: 'purchases', count: 1 })]),
      blockers: expect.arrayContaining([expect.stringMatching(/فواتير شراء مرتبطة/)])
    })
    expect(() => fullDeleteOrder({ id: order.id, confirmation: order.documentNumber }, env.ctx))
      .toThrowError(/فواتير شراء مرتبطة/)
  })

  it('does not let purchase permission alone broaden access to customer orders', () => {
    const order = makeOrder('عميل محجوب')
    const { materialId, supplierId } = masters()
    const roleId = createRole({
      name: 'مشتريات بلا عرض طلبات',
      permissions: [P.purchases.manage, P.purchases.view]
    }, env.ctx)
    createUser({
      username: 'purchase-only', password: 'secret123', fullName: 'مستخدم مشتريات', roleId
    }, env.ctx)
    const { session } = login('purchase-only', 'secret123', 804)

    expect(() => createPurchase({
      supplierId,
      customerOrderId: order.id,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(1), unitCostMicro: unitCostFromMajor(50) }]
    }, { session })).toThrowError(/صلاحية/)
  })
})
