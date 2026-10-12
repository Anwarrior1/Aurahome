import { createAccount } from '@main/services/finance/cash.service'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCategory, createMaterial, createColor, updateMaterial, updateColor } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import {
  createFinalInvoice,
  approveFinalInvoice,
  getFinalInvoice,
  updateFinalInvoice,
  cancelFinalInvoice,
  unapproveFinalInvoice
} from '@main/services/sales/final-invoices.service'
import { recordPayment, cancelOrder, getOrder, getOrderOrThrow, archiveOrder } from '@main/services/sales/orders.service'
import {
  issueWorkSheet,
  consumeForOrder,
  completeProduction,
  getProductionOrder,
  listOperationalWorkSheets,
  listWorkSheets,
  productionActualCostMinor,
  reverseWorkSheet,
  recordDelivery,
  issueRelease
} from '@main/services/production/production.service'
import { listMaterialReturns } from '@main/services/production/material-returns.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import {
  listUncollectedProducts,
  getUncollectedProduct,
  availableUncollectedProducts,
  productsFromOrder,
  attributeActualCost,
  productEconomics,
  transferManufacturedProducts
} from '@main/services/sales/uncollected-products.service'
import { buildFinalInvoice } from '@main/services/documents/documents.service'
import { renderFinalInvoice } from '@main/reports/templates/documents.template'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * "المنتجات غير المستلمة" — the physical products a cancelled Customer
 * Order physically left behind.
 *
 * The cancellation itself is UNCHANGED: the same `cancelOrder` action,
 * the same reason, the same financial and inventory consequences. What
 * these tests pin is the transfer it now performs inside that same
 * transaction, and the resale lifecycle afterwards.
 */
let env: TestEnv
beforeEach(() => {
  env = setupTestDatabase()
})
afterEach(() => env.cleanup())

function seed() {
  const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
  const materialId = createMaterial(
    {
      sku: 'MDF-18',
      name: 'لوح MDF',
      categoryId,
      unit: 'لوح',
      currentMarketPriceMicro: unitCostFromMajor(150),
      pricingRule: 'exact'
    } as never,
    env.ctx
  )
  const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
  createPurchase(
    {
      supplierId,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(100), unitCostMicro: unitCostFromMajor(100) }]
    },
    env.ctx
  )
  // The colour must genuinely belong to the material — the catalogue
  // refuses an unrelated pairing, exactly as it does in the real app.
  const colorId = createColor(
    { code: '205', name: 'بني داكن', relatedMaterialId: materialId },
    env.ctx
  )
  const customerId = createCustomer({ name: 'عميل تجريبي', phone: '0910000000' }, env.ctx)
  return { materialId, colorId, customerId, categoryId }
}

/** An invoice whose items carry real material/colour/accessory choices. */
function invoiceWith(
  customerId: number,
  lines: Array<{ description: string; priceMajor: number; materialId?: number; colorId?: number; accessoryId?: number }>
) {
  return createFinalInvoice(
    {
      customerId,
      depositPercentBp: 0,
      lines: lines.map((line) => ({
        lineKind: 'custom' as const,
        description: line.description,
        specifications: `مواصفات ${line.description}`,
        dimensions: '300×60',
        quantityMicro: quantityFromDisplay(1),
        unitPriceMinor: moneyFromMajor(line.priceMajor),
        materialIds: line.materialId ? [line.materialId] : [],
        materialColors:
          line.materialId && line.colorId
            ? [{ materialId: line.materialId, colorIds: [line.colorId] }]
            : [],
        accessoryIds: line.accessoryId ? [line.accessoryId] : []
      }))
    },
    env.ctx
  )
}

/** Drives an order all the way to "physically built, not delivered". */
function manufacturedOrder(
  customerId: number,
  materialId: number,
  colorId: number,
  lines: Array<{ description: string; priceMajor: number }> = [{ description: 'مطبخ حسب الطلب', priceMajor: 6000 }]
) {
  const invoice = invoiceWith(
    customerId,
    lines.map((line) => ({ ...line, materialId, colorId }))
  )
  const order = approveToOrder(invoice.id, env.ctx)
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
  consumeForOrder(
    { workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(10) },
    env.ctx
  )
  completeProduction(sheet.id, env.ctx)
  return { invoiceId: invoice.id, order, sheetId: sheet.id }
}

describe('Manufacturing Orders operational visibility after transfer', () => {
  it('keeps a completed Manufacturing Order visible until its output is transferred', () => {
    const { customerId, materialId, colorId } = seed()
    const { sheetId } = manufacturedOrder(customerId, materialId, colorId)

    expect(listOperationalWorkSheets({}).items.map((row) => row.id)).toContain(sheetId)
    expect(listOperationalWorkSheets({ status: 'completed' }).summary.totalCount).toBe(1)
  })

  it('rejects cancellation and retains operational visibility before manufacturing completion', () => {
    const { customerId, materialId, colorId } = seed()
    const invoice = invoiceWith(customerId, [{ description: 'خزانة', priceMajor: 6000, materialId, colorId }])
    const order = approveToOrder(invoice.id, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)

    expect(() => cancelOrder({ orderId: order.id, reason: 'إلغاء قبل التصنيع' }, env.ctx)).toThrow(/قبل بدء/)
    expect(productsFromOrder(order.id)).toEqual([])
    expect(listOperationalWorkSheets({}).items.map((row) => row.id)).toContain(sheet.id)
  })

  it('hides a fully transferred worksheet operationally but preserves database and bidirectional history', () => {
    const { customerId, materialId, colorId } = seed()
    const { order, sheetId } = manufacturedOrder(customerId, materialId, colorId)
    const before = getProductionOrder(sheetId)

    cancelOrder({ orderId: order.id, reason: 'إلغاء بعد التصنيع' }, env.ctx)

    expect(listOperationalWorkSheets({}).items.map((row) => row.id)).not.toContain(sheetId)
    expect(listOperationalWorkSheets({ search: before.sheet.documentNumber }).summary.totalCount).toBe(0)
    expect(listOperationalWorkSheets({ status: 'completed' }).summary.totalCount).toBe(0)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM work_sheets WHERE id = ?').get(sheetId)).toEqual({ c: 1 })
    expect(getProductionOrder(sheetId).sheet).toMatchObject({ id: sheetId, orderId: order.id, status: 'completed' })
    expect(listWorkSheets({ orderId: order.id, includeReversed: true }).items.map((row) => row.id)).toContain(sheetId)
    expect(getUncollectedProduct(productsFromOrder(order.id)[0]!.id, env.ctx.session)).toMatchObject({
      sourceOrderId: order.id,
      sourceWorkSheetId: sheetId,
      status: 'available'
    })
  })

  it('changes visibility without changing consumption, stock, cost or Material Returns', () => {
    const { customerId, materialId, colorId } = seed()
    const { order, sheetId } = manufacturedOrder(customerId, materialId, colorId)
    const stock = availableQty(materialId)
    const consumption = getRawConnection().prepare('SELECT * FROM order_material_lines WHERE work_sheet_id = ? ORDER BY id').all(sheetId)
    const cost = productionActualCostMinor(sheetId)

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    expect(availableQty(materialId)).toBe(stock)
    expect(getRawConnection().prepare('SELECT * FROM order_material_lines WHERE work_sheet_id = ? ORDER BY id').all(sheetId)).toEqual(consumption)
    expect(productionActualCostMinor(sheetId)).toBe(cost)
    expect(listMaterialReturns(order.id)).toHaveLength(0)
  })

  it('keeps the worksheet visible when cancellation and transfer roll back', () => {
    const { customerId, materialId, colorId } = seed()
    const { order, sheetId } = manufacturedOrder(customerId, materialId, colorId)
    const db = getRawConnection()
    db.exec(`CREATE TRIGGER fail_visibility_transfer BEFORE INSERT ON uncollected_products BEGIN SELECT RAISE(ABORT, 'forced'); END`)
    try {
      expect(() => cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)).toThrow()
    } finally {
      db.exec('DROP TRIGGER fail_visibility_transfer')
    }

    expect(getOrderOrThrow(order.id).status).not.toBe('cancelled')
    expect(listOperationalWorkSheets({}).items.map((row) => row.id)).toContain(sheetId)
    expect(productsFromOrder(order.id)).toHaveLength(0)
  })

  it('requires every physical output and keeps count/pagination aligned with returned rows', () => {
    const { customerId, materialId, colorId } = seed()
    const { order, sheetId } = manufacturedOrder(customerId, materialId, colorId, [
      { description: 'خزانة', priceMajor: 4000 },
      { description: 'طاولة', priceMajor: 2000 }
    ])
    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)
    expect(listOperationalWorkSheets({}, { limit: 1 })).toMatchObject({ items: [], summary: { totalCount: 0 }, hasMore: false })

    // Simulate an incomplete legacy/partial transfer: one authoritative
    // output relationship is absent, so the worksheet must reappear.
    const oneOutput = getRawConnection()
      .prepare('SELECT source_order_line_id AS sourceOrderLineId FROM uncollected_products WHERE source_order_id = ? ORDER BY id LIMIT 1')
      .get(order.id) as { sourceOrderLineId: number }
    getRawConnection().prepare('DELETE FROM uncollected_products WHERE source_order_line_id = ?').run(oneOutput.sourceOrderLineId)
    const firstPage = listOperationalWorkSheets({}, { limit: 1 })
    expect(firstPage.summary.totalCount).toBe(1)
    expect(firstPage.items.map((row) => row.id)).toEqual([sheetId])
    expect(firstPage.items).toHaveLength(Math.min(firstPage.summary.totalCount, 1))

    // Replaying the cancelled operation cannot create a duplicate or
    // incorrectly change visibility.
    expect(() => cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)).toThrow()
    expect(listOperationalWorkSheets({}).items.map((row) => row.id)).toContain(sheetId)
  })

  it('archiving a cancelled source order preserves its product, worksheet, consumption and cost while blocking reversal', () => {
    const { customerId, materialId, colorId } = seed()
    const { order, sheetId } = manufacturedOrder(customerId, materialId, colorId)
    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)
    archiveOrder({ id: order.id, archive: true }, env.ctx)
    const productBefore = getUncollectedProduct(productsFromOrder(order.id)[0]!.id, env.ctx.session)
    const sheetBefore = getProductionOrder(sheetId)
    const consumptionBefore = getRawConnection().prepare('SELECT * FROM order_material_lines WHERE work_sheet_id = ? ORDER BY id').all(sheetId)
    const stockBefore = availableQty(materialId)
    const costBefore = productionActualCostMinor(sheetId)

    expect(() => reverseWorkSheet({
      id: sheetId,
      expectedToken: sheetBefore.reversalToken,
      confirmation: sheetBefore.sheet.documentNumber,
      reason: 'محاولة مباشرة'
    }, env.ctx)).toThrow(/لا يمكن التراجع عن أمر تصنيع تابع لطلب مؤرشف/)

    expect(getProductionOrder(sheetId).sheet).toMatchObject({ id: sheetId, status: 'completed' })
    expect(getUncollectedProduct(productBefore.id, env.ctx.session)).toEqual(productBefore)
    expect(getRawConnection().prepare('SELECT * FROM order_material_lines WHERE work_sheet_id = ? ORDER BY id').all(sheetId)).toEqual(consumptionBefore)
    expect(availableQty(materialId)).toBe(stockBefore)
    expect(productionActualCostMinor(sheetId)).toBe(costBefore)
    expect(listMaterialReturns(order.id)).toHaveLength(0)
  })
})

// ───────────────────────────────── transfer: the three cases

describe('Cancellation stays the only cancellation, and decides the case itself', () => {
  it('1. the existing cancelOrder action is the one and only entry point, and still cancels exactly as before', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)

    const result = cancelOrder({ orderId: order.id, reason: 'العميل تراجع' }, env.ctx)

    const after = getOrderOrThrow(order.id)
    expect(after.status).toBe('cancelled')
    expect(after.cancelReason).toBe('العميل تراجع')
    // The order itself never moves — it stays a cancelled Customer Order.
    expect(result.transferredProductIds.length).toBe(1)
    expect(listUncollectedProducts({}, env.ctx.session).items[0]!.sourceOrderId).toBe(order.id)
  })

  it('2. CASE A — cancelling an order that was never manufactured creates nothing', () => {
    const { customerId, materialId, colorId } = seed()
    const invoice = invoiceWith(customerId, [
      { description: 'مطبخ', priceMajor: 6000, materialId, colorId }
    ])
    const order = approveToOrder(invoice.id, env.ctx)
    expect(() => cancelOrder({ orderId: order.id, reason: 'إلغاء مبكر' }, env.ctx)).toThrow(/قبل إصدار/)

    expect(listUncollectedProducts({}, env.ctx.session).summary.totalCount).toBe(0)
    expect(getOrderOrThrow(order.id).status).toBe('confirmed')
  })

  it('3. CASE B — a manufactured, undelivered order transfers its physical product', () => {
    const { customerId, materialId, colorId } = seed()
    const { order, sheetId } = manufacturedOrder(customerId, materialId, colorId)

    cancelOrder({ orderId: order.id, reason: 'العميل لم يستلم' }, env.ctx)

    const rows = listUncollectedProducts({}, env.ctx.session).items
    expect(rows).toHaveLength(1)
    const product = getUncollectedProduct(rows[0]!.id as number, env.ctx.session)
    expect(product.name).toBe('مطبخ حسب الطلب')
    expect(product.status).toBe('available')
    expect(product.sourceOrderNumber).toBe(order.documentNumber)
    expect(product.sourceWorkSheetNumber).toBe(getProductionOrder(sheetId).sheet.documentNumber)
    expect(product.cancelReason).toBe('العميل لم يستلم')
  })

  it('4. several independently manufactured items become several independent products', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId, [
      { description: 'خزانة', priceMajor: 4000 },
      { description: 'طاولة', priceMajor: 2000 },
      { description: 'كرسي', priceMajor: 1000 }
    ])

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    // One record per manufactured item, each in its own right.
    expect(productsFromOrder(order.id).map((row) => row.name)).toEqual(['خزانة', 'طاولة', 'كرسي'])
    const rows = listUncollectedProducts({}, env.ctx.session).items
    expect(new Set(rows.map((row) => row.id)).size).toBe(3)
    expect(rows.every((row) => row.status === 'available')).toBe(true)
  })

  it('5. CASE C — an order that already reached the customer transfers nothing', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)
    // Recording a delivery requires the order to be paid in full, and
    // recorded fulfilment remains an explicit cancellation blocker.
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6000) }, env.ctx)
    issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)
    recordDelivery({ orderId: order.id, kind: 'handover' }, env.ctx)
    expect(() => cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)).toThrow()

    // The transfer refuses it on its own account too, so the guard holds
    // wherever the cancellation rules move next: what is with the
    // customer is not ours to resell.
    expect(() => transferManufacturedProducts(
      { orderId: order.id, cancelReason: 'إلغاء' }, env.ctx, () => []
    )).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))
    expect(listUncollectedProducts({}, env.ctx.session).summary.totalCount).toBe(0)
  })
})

// ───────────────────────────────── what cancellation must NOT touch

describe('Cancellation consequences are unchanged by the transfer', () => {
  it('6/7. eligible cancellation invents no customer payment or cash movement', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)
    const db = getRawConnection()
    const paymentsBefore = db.prepare('SELECT * FROM customer_payments WHERE order_id = ?').all(order.id)
    const cashBefore = db.prepare('SELECT * FROM cash_transactions ORDER BY id').all()
    expect(paymentsBefore).toEqual([])

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    expect(db.prepare('SELECT * FROM customer_payments WHERE order_id = ?').all(order.id)).toEqual(
      paymentsBefore
    )
    // No implicit payment, reversal, refund, or re-pointing at the new sale.
    expect(db.prepare('SELECT * FROM cash_transactions ORDER BY id').all()).toEqual(cashBefore)
  })

  it.each([1000, 3000, 6000])('paid completed undelivered cancellation transfers physical output and preserves all financial/manufacturing history (paid=%i)', (paidMajor) => {
    const { customerId, materialId, colorId } = seed()
    const { order, sheetId, invoiceId } = manufacturedOrder(customerId, materialId, colorId)
    const accountId = createAccount({ name: 'Cancellation cash', kind: 'cash' }, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(paidMajor), cashAccountId: accountId }, env.ctx)
    expect(getOrder(order.id).actions.canCancel).toBe(true)
    const raw = getRawConnection()
    const tables = ['work_sheets', 'customer_payments', 'customer_payment_refunds', 'cash_transactions', 'inventory_movements', 'order_material_lines', 'fifo_layers', 'fifo_allocations', 'material_returns', 'final_invoices', 'final_invoice_lines']
    const rows = () => tables.map(table => raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = rows(), cost = orderCostBreakdown(order.id), stock = availableQty(materialId), invoice = getFinalInvoice(invoiceId)
    const result = cancelOrder({ orderId: order.id, reason: 'Manufactured paid product not collected' }, env.ctx)
    expect(result.transferredProductIds).toHaveLength(1)
    expect(getOrderOrThrow(order.id)).toMatchObject({ status: 'cancelled', paidMinor: moneyFromMajor(paidMajor) })
    expect(rows()).toEqual(before)
    expect(availableQty(materialId)).toBe(stock)
    expect(orderCostBreakdown(order.id)).toEqual({ ...cost,
      actualProfitMinor: Math.max(moneyFromMajor(paidMajor) - cost.totalActualCostMinor, 0) })
    expect(getFinalInvoice(invoiceId)).toEqual(invoice)
    expect(getProductionOrder(sheetId).sheet.status).toBe('completed')
    const product = getUncollectedProduct(result.transferredProductIds[0]!, env.ctx.session)
    expect(product).toMatchObject({ sourceOrderId: order.id, sourceWorkSheetId: sheetId, costBasisMinor: cost.totalActualCostMinor })
    expect(raw.pragma('foreign_key_check')).toEqual([])
    expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
  it('8. the historical totals at cancellation remain inspectable on the order itself', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)
    const before = getOrderOrThrow(order.id)

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    const after = getOrderOrThrow(order.id)
    expect(after.totalMinor).toBe(before.totalMinor)
    expect(after.paidMinor).toBe(before.paidMinor)
    expect(after.remainingMinor).toBe(before.remainingMinor)
  })

  it('9. the outstanding balance is still whatever the authoritative receivable logic says', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)
    const before = getOrderOrThrow(order.id)

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    const after = getOrderOrThrow(order.id)
    // Untouched by this feature: the transfer moves a physical product,
    // it does not write off or invent a receivable.
    expect(after.remainingMinor).toBe(before.remainingMinor)
    expect(after.paymentStatus).toBe(before.paymentStatus)
  })

  it('10. the Manufacturing Order stays historically intact', () => {
    const { customerId, materialId, colorId } = seed()
    const { order, sheetId } = manufacturedOrder(customerId, materialId, colorId)
    const before = getProductionOrder(sheetId).sheet

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    const after = getProductionOrder(sheetId).sheet
    expect(after.status).toBe('completed')
    expect(after.completedAt).toBe(before.completedAt)
    expect(after.reversedAt ?? null).toBeNull()
  })

  it('11/12. consumed raw material stays consumed — inventory is NOT restored', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)
    const stockAfterConsumption = availableQty(materialId)
    expect(stockAfterConsumption).toBe(quantityFromDisplay(90))

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    expect(availableQty(materialId)).toBe(stockAfterConsumption)
  })

  it('13. no Material Return is created automatically', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    expect(listMaterialReturns(order.id)).toHaveLength(0)
  })
})

// ───────────────────────────────── idempotency and atomicity

describe('The transfer is exactly-once', () => {
  it('14. exactly one record per eligible manufactured item', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId, [
      { description: 'خزانة', priceMajor: 4000 },
      { description: 'طاولة', priceMajor: 2000 }
    ])

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    expect(productsFromOrder(order.id)).toHaveLength(2)
  })

  it('15. a retry, a double click or a replayed request cannot duplicate anything', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)
    // A second cancellation is refused by the existing workflow, and the
    // database itself would refuse a duplicate transfer anyway.
    expect(() => cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)).toThrow()
    expect(productsFromOrder(order.id)).toHaveLength(1)

    const line = getRawConnection()
      .prepare('SELECT source_order_line_id AS id FROM uncollected_products WHERE source_order_id = ?')
      .get(order.id) as { id: number }
    expect(() =>
      getRawConnection()
        .prepare(
          `INSERT INTO uncollected_products
             (source_order_id, source_order_number, source_order_line_id, name, cost_basis_method, transferred_at)
           VALUES (?, 'X', ?, 'نسخة', 'sole_manufactured_item', '2026-01-01')`
        )
        .run(order.id, line.id)
    ).toThrow(/UNIQUE/i)
  })

  it('16. a failure inside the cancellation rolls back BOTH the cancellation and the transfer', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)

    // Forcing the failure at the last write inside the transaction: the
    // audit table is made to reject the cancellation's own audit row.
    const db = getRawConnection()
    db.exec(
      `CREATE TRIGGER fail_cancel BEFORE INSERT ON audit_log
       WHEN NEW.action = 'orders.cancel'
       BEGIN SELECT RAISE(ABORT, 'forced'); END`
    )
    try {
      expect(() => cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)).toThrow()
    } finally {
      db.exec('DROP TRIGGER fail_cancel')
    }

    expect(getOrderOrThrow(order.id).status).not.toBe('cancelled')
    expect(productsFromOrder(order.id)).toHaveLength(0)
  })
})

// ───────────────────────────────── the frozen specification

describe('The manufactured specification is frozen at transfer', () => {
  it('17/19. name, description, specifications, dimensions and quantity are preserved', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)
    const product = getUncollectedProduct(productsFromOrder(order.id)[0]!.id, env.ctx.session)

    expect(product.name).toBe('مطبخ حسب الطلب')
    expect(product.specifications).toBe('مواصفات مطبخ حسب الطلب')
    expect(product.dimensions).toBe('300×60')
    expect(product.quantityMicro).toBe(quantityFromDisplay(1))
  })

  it('18/19. the Material → Colours grouping and the accessories survive the transfer', () => {
    const { customerId, materialId, colorId } = seed()
    const accessoryCategoryId = createCategory({ name: 'إكسسوارات', isAccessory: true }, env.ctx)
    const accessoryId = createMaterial(
      {
        sku: 'ACC-1',
        name: 'مقبض ألمنيوم',
        categoryId: accessoryCategoryId,
        unit: 'قطعة',
        currentMarketPriceMicro: unitCostFromMajor(5),
        pricingRule: 'exact'
      } as never,
      env.ctx
    )
    const invoice = createFinalInvoice(
      {
        customerId,
        depositPercentBp: 0,
        lines: [
          {
            lineKind: 'custom',
            description: 'مطبخ',
            dimensions: '300×60',
            quantityMicro: quantityFromDisplay(1),
            unitPriceMinor: moneyFromMajor(6000),
            materialIds: [materialId],
            materialColors: [{ materialId, colorIds: [colorId] }],
            accessoryIds: [accessoryId]
          }
        ]
      },
      env.ctx
    )
    const order = approveToOrder(invoice.id, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: quantityFromDisplay(5) }, env.ctx)
    completeProduction(sheet.id, env.ctx)

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)
    const product = getUncollectedProduct(productsFromOrder(order.id)[0]!.id, env.ctx.session) as {
      selectedMaterials: Array<{ name: string; colors?: Array<{ code: string }> }>
      selectedAccessories: Array<{ name: string }>
    }

    expect(product.selectedMaterials).toHaveLength(1)
    expect(product.selectedMaterials[0]!.name).toBe('لوح MDF')
    // The colour is still grouped UNDER its material, not floating.
    expect(product.selectedMaterials[0]!.colors?.map((color) => color.code)).toEqual(['205'])
    expect(product.selectedAccessories.map((a) => a.name)).toEqual(['مقبض ألمنيوم'])
  })

  it('20. renaming the Material or Colour catalog afterwards does NOT rewrite the historical snapshot', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)
    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)
    const productId = productsFromOrder(order.id)[0]!.id

    updateMaterial(materialId, { name: 'اسم جديد تماماً' } as never, env.ctx)
    updateColor(colorId, { code: '999', name: 'لون جديد' }, env.ctx)

    const product = getUncollectedProduct(productId, env.ctx.session) as {
      selectedMaterials: Array<{ name: string; colors?: Array<{ code: string }> }>
    }
    expect(product.selectedMaterials[0]!.name).toBe('لوح MDF')
    expect(product.selectedMaterials[0]!.colors?.[0]!.code).toBe('205')
  })
})

// ───────────────────────────────── actual cost

describe('Actual cost comes from the authoritative costing, never a guess', () => {
  it('21. a sole manufactured item carries the order actual cost the costing service reports', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)
    const cost = orderCostBreakdown(order.id)
    expect(cost.totalActualCostMinor).toBeGreaterThan(0)

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    const product = getUncollectedProduct(productsFromOrder(order.id)[0]!.id, env.ctx.session)
    expect(product.costBasisMinor).toBe(cost.totalActualCostMinor)
    expect(product.costBasisMethod).toBe('sole_manufactured_item')
  })

  it('22. several items are never divided equally — the method is recorded and the parts sum exactly', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId, [
      { description: 'خزانة', priceMajor: 9000 },
      { description: 'كرسي', priceMajor: 1000 }
    ])
    const cost = orderCostBreakdown(order.id)

    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    const products = productsFromOrder(order.id).map((row) =>
      getUncollectedProduct(row.id, env.ctx.session)
    )
    const shares = products.map((p) => p.costBasisMinor as number)
    expect(products.every((p) => p.costBasisMethod === 'relative_sales_value')).toBe(true)
    // 90/10 by selling value, emphatically not 50/50.
    expect(shares[0]).toBeGreaterThan(shares[1]!)
    expect(shares[0]! + shares[1]!).toBe(cost.totalActualCostMinor)
    expect(shares[0]).not.toBe(shares[1])
  })

  it('22b. an unattributable basis claims nothing rather than guessing', () => {
    expect(attributeActualCost(5000, [0, 0])).toEqual({ amounts: [0, 0], method: 'unattributable' })
    // And a split always adds back to the whole, to the minor unit.
    const { amounts } = attributeActualCost(1000, [1, 1, 1])
    expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(1000)
  })
})

// ───────────────────────────────── resale

describe('Resale goes through the existing Approved Invoice architecture', () => {
  function transferredProduct() {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId)
    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)
    const productId = productsFromOrder(order.id)[0]!.id
    const buyerId = createCustomer({ name: 'مشترٍ جديد', phone: '0920000000' }, env.ctx)
    return { productId, buyerId, sourceOrderId: order.id, materialId }
  }

  it('23/24. an available product is selectable on a new invoice at a completely new price', () => {
    const { productId, buyerId } = transferredProduct()
    expect(availableUncollectedProducts().map((row) => row.id)).toContain(productId)

    const invoice = createFinalInvoice(
      {
        customerId: buyerId,
        lines: [
          {
            lineKind: 'custom',
            description: 'مطبخ جاهز',
            quantityMicro: quantityFromDisplay(1),
            // Nothing forces the original 6000 — the seller sets the price.
            unitPriceMinor: moneyFromMajor(4500),
            uncollectedProductId: productId
          }
        ]
      },
      env.ctx
    )

    expect(getFinalInvoice(invoice.id).invoice.totalMinor).toBe(moneyFromMajor(4500))
    // Attaching it holds the product against this invoice.
    expect(getUncollectedProduct(productId, env.ctx.session).status).toBe('reserved')
  })

  it('25/26. the customer document shows the specification and NEVER the internal cost', () => {
    const { productId, buyerId } = transferredProduct()
    const cost = getUncollectedProduct(productId, env.ctx.session).costBasisMinor as number
    expect(cost).toBeGreaterThan(0)

    const invoice = createFinalInvoice(
      {
        customerId: buyerId,
        lines: [
          {
            lineKind: 'custom',
            description: 'مطبخ جاهز',
            specifications: 'مواصفات مطبخ حسب الطلب',
            dimensions: '300×60',
            quantityMicro: quantityFromDisplay(1),
            unitPriceMinor: moneyFromMajor(4500),
            uncollectedProductId: productId
          }
        ]
      },
      env.ctx
    )
    approveFinalInvoice(invoice.id, env.ctx)
    const html = renderFinalInvoice(buildFinalInvoice(invoice.id), { name: 'AURA home' })
    // CSS comments are inlined into every document, so text assertions
    // must look at the body alone.
    const body = html.replace(/<style>[\s\S]*?<\/style>/g, '')

    expect(body).toContain('مطبخ جاهز')
    expect(body).toContain('300×60')
    expect(body).toContain('4.500,00')
    expect(body).not.toContain(String(cost))
    expect(body).not.toContain('التكلفة')
    expect(body).not.toContain('المنتجات غير المستلمة')
  })

  it('27/28/29. reselling consumes no raw material, creates no manufacturing, and duplicates no cost', () => {
    const { productId, buyerId, materialId, sourceOrderId } = transferredProduct()
    const stockBefore = availableQty(materialId)
    const costBefore = orderCostBreakdown(sourceOrderId).totalActualCostMinor

    const invoice = createFinalInvoice(
      {
        customerId: buyerId,
        lines: [
          {
            lineKind: 'custom',
            description: 'مطبخ جاهز',
            quantityMicro: quantityFromDisplay(1),
            unitPriceMinor: moneyFromMajor(4500),
            uncollectedProductId: productId
          }
        ]
      },
      env.ctx
    )
    const approval = approveFinalInvoice(invoice.id, env.ctx)

    // No stock movement and no second copy of the manufacture: the source
    // order keeps its historical cost untouched, and (BL-03) the new order
    // carries only the part of it the original customer's retained money
    // did not cover — here nothing was paid, so all of it.
    expect(availableQty(materialId)).toBe(stockBefore)
    expect(orderCostBreakdown(sourceOrderId).totalActualCostMinor).toBe(costBefore)
    expect(productEconomics(productId)!.customerCoveredMinor).toBe(0)
    expect(orderCostBreakdown(approval.orderId).totalActualCostMinor).toBe(productEconomics(productId)!.factoryBorneMinor)
    expect(productEconomics(productId)!.factoryBorneMinor).toBe(productEconomics(productId)!.actualCostMinor)
    // And the new order cannot re-enter manufacturing at all.
    recordPayment({ orderId: approval.orderId, amountMinor: moneyFromMajor(4500) }, env.ctx)
    expect(() => issueWorkSheet({ orderId: approval.orderId }, env.ctx)).toThrowError(
      /المنتجات غير المستلمة/
    )
  })

  it('30. the same physical product can never be sold twice', () => {
    const { productId, buyerId } = transferredProduct()
    const line = {
      lineKind: 'custom' as const,
      description: 'مطبخ جاهز',
      quantityMicro: quantityFromDisplay(1),
      unitPriceMinor: moneyFromMajor(4500),
      uncollectedProductId: productId
    }
    const first = createFinalInvoice({ customerId: buyerId, lines: [line] }, env.ctx)
    approveFinalInvoice(first.id, env.ctx)
    expect(getUncollectedProduct(productId, env.ctx.session).status).toBe('sold')

    // A second invoice cannot even claim it…
    expect(() => createFinalInvoice({ customerId: buyerId, lines: [line] }, env.ctx)).toThrowError(
      /تم بيعه بالفعل/
    )
    // …and the database itself refuses a second invoice line for it.
    expect(() =>
      getRawConnection()
        .prepare(
          `INSERT INTO final_invoice_lines
             (final_invoice_id, line_kind, description, quantity_micro, unit_price_minor, line_total_minor, uncollected_product_id)
           VALUES (?, 'custom', 'تكرار', 1000000, 1000, 1000, ?)`
        )
        .run(first.id, productId)
    ).toThrow(/UNIQUE/i)
    // It is gone from the picker for good.
    expect(availableUncollectedProducts().map((row) => row.id)).not.toContain(productId)
  })

  it('31. the old customer payment is never moved onto the new sale', () => {
    const { productId, buyerId, sourceOrderId } = transferredProduct()
    const db = getRawConnection()
    const oldPayments = db.prepare('SELECT * FROM customer_payments WHERE order_id = ?').all(sourceOrderId)

    const invoice = createFinalInvoice(
      {
        customerId: buyerId,
        lines: [
          {
            lineKind: 'custom',
            description: 'مطبخ جاهز',
            quantityMicro: quantityFromDisplay(1),
            unitPriceMinor: moneyFromMajor(4500),
            uncollectedProductId: productId
          }
        ]
      },
      env.ctx
    )
    const approval = approveFinalInvoice(invoice.id, env.ctx)

    // The old payment stays exactly where it was, on the cancelled order.
    expect(db.prepare('SELECT * FROM customer_payments WHERE order_id = ?').all(sourceOrderId)).toEqual(
      oldPayments
    )
    // The new order starts genuinely unpaid.
    expect(getOrderOrThrow(approval.orderId).paidMinor).toBe(0)
  })

  it('32/33. both ends of the trail are linked — the old order to the product, the product to its new sale', () => {
    const { productId, buyerId, sourceOrderId } = transferredProduct()
    expect(productsFromOrder(sourceOrderId).map((row) => row.id)).toEqual([productId])

    const invoice = createFinalInvoice(
      {
        customerId: buyerId,
        lines: [
          {
            lineKind: 'custom',
            description: 'مطبخ جاهز',
            quantityMicro: quantityFromDisplay(1),
            unitPriceMinor: moneyFromMajor(4500),
            uncollectedProductId: productId
          }
        ]
      },
      env.ctx
    )
    const approval = approveFinalInvoice(invoice.id, env.ctx)

    const sold = getUncollectedProduct(productId, env.ctx.session) as {
      status: string
      soldInvoice?: { id: number }
      soldOrder?: { id: number }
      sourceOrderId: number
    }
    expect(sold.status).toBe('sold')
    expect(sold.soldInvoice?.id).toBe(invoice.id)
    expect(sold.soldOrder?.id).toBe(approval.orderId)
    // The source link is never overwritten by the resale.
    expect(sold.sourceOrderId).toBe(sourceOrderId)
  })

  it('a product returns to the shelf when its sale is undone, and audit evidence is never deleted', () => {
    const { productId, buyerId } = transferredProduct()
    const invoice = createFinalInvoice(
      {
        customerId: buyerId,
        lines: [
          {
            lineKind: 'custom',
            description: 'مطبخ جاهز',
            quantityMicro: quantityFromDisplay(1),
            unitPriceMinor: moneyFromMajor(4500),
            uncollectedProductId: productId
          }
        ]
      },
      env.ctx
    )
    const approval = approveFinalInvoice(invoice.id, env.ctx)
    expect(getUncollectedProduct(productId, env.ctx.session).status).toBe('sold')

    // Unapproving undoes the SALE, not the invoice's claim: the draft
    // still lists the product, so it is held for this same invoice.
    unapproveFinalInvoice({ id: invoice.id, expectedRevision: 1 }, env.ctx)
    expect(getUncollectedProduct(productId, env.ctx.session).status).toBe('reserved')
    expect(getOrderOrThrow(approval.orderId).status).toBe('awaiting_approval')

    // Post-BL03 Risk 04: an unpaid resale-only order cancels directly and the
    // same product returns to the shelf; voiding the invoice afterwards is harmless.
    approveFinalInvoice(invoice.id, env.ctx)
    cancelOrder({ orderId: approval.orderId, reason: 'إلغاء البيع' }, env.ctx)
    expect(getUncollectedProduct(productId, env.ctx.session).status).toBe('available')
    cancelFinalInvoice({ id: invoice.id, reason: 'إلغاء البيع' }, env.ctx)
    expect(getUncollectedProduct(productId, env.ctx.session).status).toBe('available')

    // Every step left its own audit row, and nothing was removed.
    const events = getRawConnection()
      .prepare("SELECT action FROM audit_log WHERE entity = 'uncollected_products' ORDER BY id")
      .all() as Array<{ action: string }>
    expect(events.map((row) => row.action)).toEqual([
      'uncollectedProducts.transfer',
      'uncollectedProducts.sold',
      'uncollectedProducts.released',
      'uncollectedProducts.sold',
      'uncollectedProducts.resaleCancelled'
    ])
  })

  it('detaching a product from a draft invoice frees it again', () => {
    const { productId, buyerId } = transferredProduct()
    const invoice = createFinalInvoice(
      {
        customerId: buyerId,
        lines: [
          {
            lineKind: 'custom',
            description: 'مطبخ جاهز',
            quantityMicro: quantityFromDisplay(1),
            unitPriceMinor: moneyFromMajor(4500),
            uncollectedProductId: productId
          }
        ]
      },
      env.ctx
    )
    expect(getUncollectedProduct(productId, env.ctx.session).status).toBe('reserved')

    updateFinalInvoice(
      invoice.id,
      {
        lines: [
          {
            lineKind: 'custom',
            description: 'صنف عادي',
            quantityMicro: quantityFromDisplay(1),
            unitPriceMinor: moneyFromMajor(1000)
          }
        ]
      },
      env.ctx
    )

    expect(getUncollectedProduct(productId, env.ctx.session).status).toBe('available')
  })

  it('an update that does not resend its lines keeps the resale link', () => {
    const { productId, buyerId } = transferredProduct()
    const invoice = createFinalInvoice(
      {
        customerId: buyerId,
        lines: [
          {
            lineKind: 'custom',
            description: 'مطبخ جاهز',
            quantityMicro: quantityFromDisplay(1),
            unitPriceMinor: moneyFromMajor(4500),
            uncollectedProductId: productId
          }
        ]
      },
      env.ctx
    )
    updateFinalInvoice(invoice.id, { notes: 'ملاحظة' }, env.ctx)

    const detail = getFinalInvoice(invoice.id)
    expect(detail.lines[0]!.uncollectedProductId).toBe(productId)
    expect(getUncollectedProduct(productId, env.ctx.session).status).toBe('reserved')
  })
})

// ───────────────────────────────── pagination

describe('The page is bounded', () => {
  it('never returns unbounded history, and reports the real total', () => {
    const { customerId, materialId, colorId } = seed()
    const { order } = manufacturedOrder(customerId, materialId, colorId, [
      { description: 'أ', priceMajor: 1000 },
      { description: 'ب', priceMajor: 1000 },
      { description: 'ج', priceMajor: 1000 }
    ])
    cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)

    const page = listUncollectedProducts({}, env.ctx.session, { limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.summary.totalCount).toBe(3)
    expect(listUncollectedProducts({}, env.ctx.session, { limit: 2, cursor: page.nextCursor! }).items).toHaveLength(1)
    // A caller asking for everything is refused rather than served an unbounded page.
    expect(() => listUncollectedProducts({}, env.ctx.session, { limit: 100_000 })).toThrow()
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
