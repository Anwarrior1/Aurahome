import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCategory, createMaterial, updateMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { consumeForOrder, getProductionOrder, issueWorkSheet } from '@main/services/production/production.service'
import { savePlannedMaterials } from '@main/services/planning/planning.service'
import {
  createMaterialReturn,
  editMaterialReturn,
  getMaterialReturnsOverview,
  reverseMaterialReturn
} from '@main/services/production/material-returns.service'
import { availableQty, consumeMaterial } from '@main/services/inventory/inventory.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { closeDatabase, getRawConnection, setDatabasePath } from '@main/db/connection'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function seedIssue(options: { issueQty?: number; salePrice?: number } = {}) {
  const issueQty = options.issueQty ?? 10
  const categoryId = createCategory({ name: 'أخشاب مرتجعات' }, env.ctx)
  const materialId = createMaterial({
    sku: `MDF-R-${Math.random()}`, name: 'MDF 18mm', categoryId, unit: 'لوحة',
    currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
  } as never, env.ctx)
  const supplierId = createSupplier({ name: 'مورد MDF' }, env.ctx)
  createPurchase({
    supplierId,
    lines: [{ materialId, qtyMicro: quantityFromDisplay(100), unitCostMicro: unitCostFromMajor(100) }]
  }, env.ctx)
  const customerId = createCustomer({ name: 'عميل المرتجعات' }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    lines: [{
      lineKind: 'custom', description: 'طلب اختبار مرتجع',
      quantityMicro: quantityFromDisplay(1),
      unitPriceMinor: moneyFromMajor(options.salePrice ?? 1500)
    }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  savePlannedMaterials({ orderId: order.id }, [{
    materialId,
    materialName: 'MDF 18mm',
    qtyMicro: quantityFromDisplay(issueQty),
    unit: 'لوحة',
    estimatedUnitCostMicro: unitCostFromMajor(150)
  }], env.ctx)
  recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
  const issue = getProductionOrder(sheet.id).materialLines[0]!
  return { materialId, order, sheet, issue }
}

function createReturn(orderId: number, materialId: number, qty: number, key = `create-${Math.random()}`) {
  return createMaterialReturn({
    orderId,
    materialId,
    quantityMicro: quantityFromDisplay(qty),
    notes: 'متبقٍ صالح للاستخدام',
    requestKey: key
  }, env.ctx)
}

describe('customer-order raw-material returns', () => {
  it('creates a real historical-cost return without rewriting the original issue', () => {
    const { materialId, order, sheet, issue } = seedIssue()
    const financialsBefore = getRawConnection().prepare(`
      SELECT o.total_minor AS orderTotal, o.paid_minor AS paid, o.remaining_minor AS remaining,
             fi.total_minor AS invoiceTotal,
             (SELECT SUM(total_minor) FROM purchases) AS purchaseTotal
      FROM orders o JOIN final_invoices fi ON fi.id = o.final_invoice_id WHERE o.id = ?
    `).get(order.id)
    const returned = createReturn(order.id, materialId, 1)

    const summary = getMaterialReturnsOverview(order.id).materials[0]
    expect(summary.issuedQtyMicro).toBe(quantityFromDisplay(10))
    expect(summary.returnedQtyMicro).toBe(quantityFromDisplay(1))
    expect(summary.netConsumedQtyMicro).toBe(quantityFromDisplay(9))
    expect(summary.netCostMinor).toBe(moneyFromMajor(900))
    expect(returned.returnedCostMinor).toBe(moneyFromMajor(100))
    expect(availableQty(materialId)).toBe(quantityFromDisplay(91))

    const original = getRawConnection().prepare(
      'SELECT physical_qty_micro AS qty, actual_cost_minor AS cost FROM order_material_lines WHERE id = ?'
    ).get(issue.id) as { qty: number; cost: number }
    expect(original).toEqual({ qty: quantityFromDisplay(10), cost: moneyFromMajor(1000) })
    expect(getProductionOrder(sheet.id).materialLines[0]).toMatchObject({
      physicalQtyMicro: quantityFromDisplay(10),
      returnedQtyMicro: quantityFromDisplay(1),
      netConsumedQtyMicro: quantityFromDisplay(9),
      netCostMinor: moneyFromMajor(900)
    })
    const costing = orderCostBreakdown(order.id)
    expect(costing.materialCostMinor).toBe(moneyFromMajor(900))
    expect(costing.totalActualCostMinor).toBe(moneyFromMajor(900))
    expect(costing.actualProfitMinor).toBe(moneyFromMajor(600))
    expect(getRawConnection().prepare(`
      SELECT o.total_minor AS orderTotal, o.paid_minor AS paid, o.remaining_minor AS remaining,
             fi.total_minor AS invoiceTotal,
             (SELECT SUM(total_minor) FROM purchases) AS purchaseTotal
      FROM orders o JOIN final_invoices fi ON fi.id = o.final_invoice_id WHERE o.id = ?
    `).get(order.id)).toEqual(financialsBefore)
  })

  it('edits up and down by inventory/cost delta only', () => {
    const { materialId, order } = seedIssue()
    const first = createReturn(order.id, materialId, 1)
    const up = editMaterialReturn({
      id: first.id, quantityMicro: quantityFromDisplay(2), notes: first.notes,
      expectedVersion: first.version, requestKey: 'edit-up-0001'
    }, env.ctx)
    expect(availableQty(materialId)).toBe(quantityFromDisplay(92))
    expect(up.returnedCostMinor).toBe(moneyFromMajor(200))
    expect(getRawConnection().prepare(
      "SELECT COUNT(*) AS c FROM inventory_movements WHERE kind = 'material_return'"
    ).get()).toEqual({ c: 2 })

    const down = editMaterialReturn({
      id: up.id, quantityMicro: quantityFromDisplay(1), notes: up.notes,
      expectedVersion: up.version, requestKey: 'edit-down-0001'
    }, env.ctx)
    expect(availableQty(materialId)).toBe(quantityFromDisplay(91))
    expect(down.returnedCostMinor).toBe(moneyFromMajor(100))
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(moneyFromMajor(900))
  })

  it('voids instead of deleting and restores stock, cost and profit', () => {
    const { materialId, order } = seedIssue()
    const returned = createReturn(order.id, materialId, 2)
    reverseMaterialReturn({
      id: returned.id, expectedVersion: returned.version, requestKey: 'reverse-0001'
    }, env.ctx)

    expect(getMaterialReturnsOverview(order.id).returns).toHaveLength(0)
    expect(getMaterialReturnsOverview(order.id).materials[0]).toMatchObject({
      issuedQtyMicro: quantityFromDisplay(10), returnedQtyMicro: 0,
      netConsumedQtyMicro: quantityFromDisplay(10), netCostMinor: moneyFromMajor(1000)
    })
    expect(availableQty(materialId)).toBe(quantityFromDisplay(90))
    expect(orderCostBreakdown(order.id).actualProfitMinor).toBe(moneyFromMajor(500))
    expect(getRawConnection().prepare('SELECT status FROM material_returns WHERE id = ?')
      .get(returned.id)).toEqual({ status: 'voided' })
    expect(getRawConnection().prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'production.materialReturn.reverse'"
    ).get()).toEqual({ c: 1 })
  })

  it('blocks reverse and edit-down if returned stock has been consumed, atomically', () => {
    const { materialId, order } = seedIssue()
    const returned = createReturn(order.id, materialId, 3)
    // Consume the original layer's remaining 90 plus two of the returned layer.
    consumeMaterial({ materialId, physicalQtyMicro: quantityFromDisplay(92), ctx: env.ctx })

    expect(() => editMaterialReturn({
      id: returned.id, quantityMicro: quantityFromDisplay(1), notes: returned.notes,
      expectedVersion: returned.version, requestKey: 'blocked-edit-0001'
    }, env.ctx)).toThrowError(/لم تعد متاحة بالكامل/)
    expect(() => reverseMaterialReturn({
      id: returned.id, expectedVersion: returned.version, requestKey: 'blocked-reverse-0001'
    }, env.ctx)).toThrowError(/لم تعد متاحة بالكامل/)
    const unchanged = getMaterialReturnsOverview(order.id).returns[0]
    expect(unchanged.quantityMicro).toBe(quantityFromDisplay(3))
    expect(unchanged.returnedCostMinor).toBe(moneyFromMajor(300))
    expect(availableQty(materialId)).toBe(quantityFromDisplay(1))
  })

  it('supports independent returns and validates against all other active records', () => {
    const { materialId, order } = seedIssue()
    const a = createReturn(order.id, materialId, 1, 'multi-create-a')
    const b = createReturn(order.id, materialId, 2, 'multi-create-b')
    const editedA = editMaterialReturn({
      id: a.id, quantityMicro: quantityFromDisplay(3), notes: null,
      expectedVersion: a.version, requestKey: 'multi-edit-a'
    }, env.ctx)
    expect(getMaterialReturnsOverview(order.id).materials[0].returnedQtyMicro)
      .toBe(quantityFromDisplay(5))
    expect(() => editMaterialReturn({
      id: editedA.id, quantityMicro: quantityFromDisplay(9), notes: null,
      expectedVersion: editedA.version, requestKey: 'multi-over-return'
    }, env.ctx)).toThrowError(/أكبر من الكمية المتاحة/)

    reverseMaterialReturn({ id: b.id, expectedVersion: b.version, requestKey: 'multi-reverse-b' }, env.ctx)
    const summary = getMaterialReturnsOverview(order.id).materials[0]
    expect(summary.returnedQtyMicro).toBe(quantityFromDisplay(3))
    expect(summary.netConsumedQtyMicro).toBe(quantityFromDisplay(7))
  })

  it('uses frozen issue costs across multiple FIFO issues, never the current catalog price', () => {
    const categoryId = createCategory({ name: 'تكلفة تاريخية' }, env.ctx)
    const materialId = createMaterial({
      sku: 'MIXED-COST', name: 'MDF متعدد الدفعات', categoryId, unit: 'لوحة',
      currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
    } as never, env.ctx)
    const supplierId = createSupplier({ name: 'مورد متعدد' }, env.ctx)
    createPurchase({ supplierId, lines: [
      { materialId, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(100) },
      { materialId, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(110) }
    ] }, env.ctx)
    const customerId = createCustomer({ name: 'عميل تكلفة' }, env.ctx)
    const invoice = createFinalInvoice({ customerId, lines: [{
      lineKind: 'custom', description: 'طلب', quantityMicro: quantityFromDisplay(1),
      unitPriceMinor: moneyFromMajor(2000)
    }] }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(10) }, env.ctx)
    updateMaterial(materialId, { currentMarketPriceMicro: unitCostFromMajor(250) }, env.ctx)

    // Return allocation unwinds latest historical issue allocations first: 2 × 110.
    const returned = createReturn(order.id, materialId, 2)
    expect(returned.returnedCostMinor).toBe(moneyFromMajor(220))
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(moneyFromMajor(830))
  })

  it('is idempotent and rejects stale concurrent edits', () => {
    const { materialId, order } = seedIssue()
    const a = createReturn(order.id, materialId, 1, 'same-create-request')
    const duplicate = createReturn(order.id, materialId, 1, 'same-create-request')
    expect(duplicate.id).toBe(a.id)
    expect(availableQty(materialId)).toBe(quantityFromDisplay(91))

    editMaterialReturn({
      id: a.id, quantityMicro: quantityFromDisplay(2), expectedVersion: a.version,
      requestKey: 'same-edit-request'
    }, env.ctx)
    editMaterialReturn({
      id: a.id, quantityMicro: quantityFromDisplay(2), expectedVersion: a.version,
      requestKey: 'same-edit-request'
    }, env.ctx)
    expect(availableQty(materialId)).toBe(quantityFromDisplay(92))
    expect(() => editMaterialReturn({
      id: a.id, quantityMicro: quantityFromDisplay(3), expectedVersion: a.version,
      requestKey: 'stale-edit-request'
    }, env.ctx)).toThrowError(/جلسة أخرى/)
  })

  it('persists return history, stock and derived cost after reopening the database', () => {
    const { materialId, order } = seedIssue()
    const first = createReturn(order.id, materialId, 1, 'reopen-create')
    editMaterialReturn({
      id: first.id, quantityMicro: quantityFromDisplay(2), expectedVersion: first.version,
      requestKey: 'reopen-edit'
    }, env.ctx)
    const dbPath = join(env.dir, readdirSync(env.dir).find((name) => name.endsWith('.db'))!)
    closeDatabase()
    setDatabasePath(dbPath)

    const overview = getMaterialReturnsOverview(order.id)
    expect(overview.returns).toHaveLength(1)
    expect(overview.returns[0].quantityMicro).toBe(quantityFromDisplay(2))
    expect(overview.materials[0].netConsumedQtyMicro).toBe(quantityFromDisplay(8))
    expect(availableQty(materialId)).toBe(quantityFromDisplay(92))
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(moneyFromMajor(800))
  })

  it('enforces production.returnMaterial in the service and records no side effects on denial', () => {
    const { materialId, order } = seedIssue()
    const roleId = createRole({ name: 'عرض فقط', permissions: [] }, env.ctx)
    createUser({ username: 'readonly-return', password: 'secret123', fullName: 'قارئ', roleId }, env.ctx)
    const deniedCtx = { session: login('readonly-return', 'secret123', 44).session }

    expect(() => createMaterialReturn({
      orderId: order.id, materialId, quantityMicro: quantityFromDisplay(1),
      requestKey: 'denied-create-request'
    }, deniedCtx)).toThrowError(/صلاحية/)
    expect(availableQty(materialId)).toBe(quantityFromDisplay(90))
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM material_returns').get())
      .toEqual({ c: 0 })

    const posted = createReturn(order.id, materialId, 1, 'admin-create-for-rbac')
    expect(() => editMaterialReturn({
      id: posted.id, quantityMicro: quantityFromDisplay(2), expectedVersion: posted.version,
      requestKey: 'denied-edit-request'
    }, deniedCtx)).toThrowError(/صلاحية/)
    expect(() => reverseMaterialReturn({
      id: posted.id, expectedVersion: posted.version, requestKey: 'denied-reverse-request'
    }, deniedCtx)).toThrowError(/صلاحية/)
    expect(availableQty(materialId)).toBe(quantityFromDisplay(91))
    expect(getMaterialReturnsOverview(order.id).returns[0].quantityMicro).toBe(quantityFromDisplay(1))
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
