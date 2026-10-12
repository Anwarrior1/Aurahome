import { issueWorkSheet as issueLifecycleWorkSheet, completeProduction as completeLifecycleProduction } from '@main/services/production/production.service'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { unitCostFromMajor } from '@shared/money/cost'
import { createQuotation, updateQuotation, deleteQuotation, quotationDeletePreview, cancelQuotation, getQuotation, issueQuotation } from '@main/services/sales/quotations.service'
import { createFinalInvoice, updateFinalInvoice, getFinalInvoice } from '@main/services/sales/final-invoices.service'
import {
  updateOrder,
  getOrderOrThrow,
  recordPayment,
  refundPayment,
  cancelOrder
} from '@main/services/sales/orders.service'
import { createAccount } from '@main/services/finance/cash.service'
import { buildFinalInvoice } from '@main/services/documents/documents.service'
import { issueRelease, recordDelivery } from '@main/services/production/production.service'
import { renderFinalInvoice } from '@main/reports/templates/documents.template'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { quotationLines } from '@main/db/schema/sales.schema'
import { eq } from 'drizzle-orm'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * Sales-workflow focused pass: preliminary invoice (quotation) edit/
 * delete, and final invoice (order) edit — plus the full customer →
 * quotation → order → payment → final-invoice pipeline end to end,
 * verifying no orphan records and correct balances throughout.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function draftQuotation(customerId: number, priceMajor = 1000) {
  return createQuotation({
    customerId,
    lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(priceMajor) }]
  }, env.ctx)
}

/** The document that starts the workflow after the workflow pass. */
function draftApprovedInvoice(customerId: number, priceMajor = 1000) {
  return createFinalInvoice({
    customerId,
    lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(priceMajor) }]
  }, env.ctx)
}

/**
 * Recreates a document pair exactly as the OLD workflow left it: a
 * preliminary invoice marked converted, and the order carrying its
 * `quotation_id`. Legacy rows like these must stay readable and must
 * still unwind safely (Part 15).
 */
function legacyConvertedPair(customerId: number, priceMajor = 1000) {
  const quotation = draftQuotation(customerId, priceMajor)
  const order = approveToOrder(draftApprovedInvoice(customerId, priceMajor).id, env.ctx)
  const raw = getRawConnection()
  // Detach the approved invoice and re-point the order at the quotation,
  // which is exactly the shape a pre-workflow-pass order has on disk.
  raw.prepare('UPDATE orders SET quotation_id = ?, final_invoice_id = NULL WHERE id = ?').run(quotation.id, order.id)
  raw.prepare('DELETE FROM final_invoices WHERE order_id = ?').run(order.id)
  raw.prepare("UPDATE quotations SET status = 'converted' WHERE id = ?").run(quotation.id)
  return { quotation, order }
}

describe('Edit a preliminary invoice (item 5)', () => {
  it('recalculates totals after editing a draft quotation’s lines', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = draftQuotation(customerId, 1000)

    updateQuotation(quotation.id, {
      lines: [{ lineKind: 'custom', description: 'بند معدّل', quantityMicro: quantityFromDisplay(2), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)

    const loaded = getQuotation(quotation.id)
    expect(loaded.quotation.totalMinor).toBe(moneyFromMajor(2000))
    expect(loaded.lines).toHaveLength(1)
    expect(loaded.lines[0]?.description).toBe('بند معدّل')
  })

  it('recalculates the deposit and remaining balance after a discount is added', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = draftQuotation(customerId, 1000)

    updateQuotation(quotation.id, { discountKind: 'amount', discountValue: moneyFromMajor(100) }, env.ctx)

    const loaded = getQuotation(quotation.id)
    expect(loaded.quotation.totalMinor).toBe(moneyFromMajor(900))
    expect(loaded.quotation.remainingMinor).toBe(loaded.quotation.totalMinor - loaded.quotation.depositRequiredMinor)
  })

  it('refuses to edit an ISSUED preliminary invoice (BR-45, preserved)', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = draftQuotation(customerId)
    issueQuotation(quotation.id, env.ctx)

    expect(() => updateQuotation(quotation.id, { discountValue: 0 }, env.ctx)).toThrowError(/لا يمكن تعديل/)
  })
})

describe('Delete a preliminary invoice (Part B of the deletion pass)', () => {
  it('hard-deletes a draft quotation and its lines — no orphan rows left', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = draftQuotation(customerId)

    deleteQuotation({ id: quotation.id }, env.ctx)

    expect(() => getQuotation(quotation.id)).toThrowError(/غير موجود/)
    const remainingLines = getDatabase().select().from(quotationLines).where(eq(quotationLines.quotationId, quotation.id)).all()
    expect(remainingLines).toHaveLength(0)
  })

  it('deletes an issued but unconverted preliminary invoice without a reason or a token', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = draftQuotation(customerId)

    const preview = quotationDeletePreview(quotation.id)
    expect(preview.requiresConfirmation).toBe(false)
    expect(preview.blockers).toEqual([])

    expect(deleteQuotation({ id: quotation.id }, env.ctx)).toEqual({ removed: true, orderRemoved: false })
    expect(() => getQuotation(quotation.id)).toThrowError(/غير موجود/)
  })

  it('preserves a LEGACY converted quotation and order after enforcing the typed invoice number', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const { quotation, order } = legacyConvertedPair(customerId)

    const preview = quotationDeletePreview(quotation.id)
    expect(preview.requiresConfirmation).toBe(true)
    expect(preview.order?.id).toBe(order.id)

    // Wrong/absent token: nothing at all is removed.
    expect(() => deleteQuotation({ id: quotation.id }, env.ctx)).toThrowError(/اكتب رقم الفاتورة المبدئية/)
    expect(getOrderOrThrow(order.id).quotationId).toBe(quotation.id)

    expect(() => deleteQuotation({ id: quotation.id, confirmation: quotation.documentNumber }, env.ctx))
      .toThrowError(/سجلاً تجارياً|سجل تجاري مُرحّل/)
    expect(getQuotation(quotation.id).quotation.id).toBe(quotation.id)
    expect(getOrderOrThrow(order.id).id).toBe(order.id)
  })

  it('refuses the whole deletion — never a partial one — when the order cannot be safely unwound', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const { quotation, order } = legacyConvertedPair(customerId)
    // An order-linked inventory movement that no consumption line accounts
    // for is exactly what the order service refuses to restore blindly.
    const categoryId = createCategory({ name: 'خشب' }, env.ctx)
    const materialId = createMaterial(
      { sku: 'MDF-BLOCK', name: 'MDF', categoryId, unit: 'لوح', currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact' } as never,
      env.ctx
    )
    getRawConnection().prepare(`
      INSERT INTO inventory_movements (material_id, kind, qty_micro, order_id)
      VALUES (?, 'consumption', 1000000, ?)
    `).run(materialId, order.id)

    expect(quotationDeletePreview(quotation.id).blockers.length).toBeGreaterThan(0)
    expect(() => deleteQuotation({ id: quotation.id, confirmation: quotation.documentNumber }, env.ctx))
      .toThrowError(/تعذر حذف الفاتورة المبدئية/)
    expect(getQuotation(quotation.id).quotation.status).toBe('converted')
    expect(getOrderOrThrow(order.id).id).toBe(order.id)
  })

  it('cancel (the safe alternative) still refuses a LEGACY converted quotation, preserving the chain', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const { quotation } = legacyConvertedPair(customerId)

    expect(() => cancelQuotation(quotation.id, env.ctx)).toThrowError(/تحويله إلى طلب/)
  })

  it('allows cancelling a draft quotation that was never converted', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = draftQuotation(customerId)

    cancelQuotation(quotation.id, env.ctx)

    expect(getQuotation(quotation.id).quotation.status).toBe('cancelled')
  })
})

describe('Edit a final invoice / order (item 7)', () => {
  function makeOrder(customerId: number) {
    const quotation = draftApprovedInvoice(customerId, 1000)
    return approveToOrder(quotation.id, env.ctx)
  }

  it('corrects the address and notes without touching any financial figure', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const order = makeOrder(customerId)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(500) }, env.ctx)
    const before = getOrderOrThrow(order.id)

    updateOrder(order.id, { address: 'بنغازي', notes: 'ملاحظة محدّثة' }, env.ctx)

    const after = getOrderOrThrow(order.id)
    expect(after.address).toBe('بنغازي')
    expect(after.notes).toBe('ملاحظة محدّثة')
    // Every financial figure is completely unaffected by this edit.
    expect(after.totalMinor).toBe(before.totalMinor)
    expect(after.paidMinor).toBe(before.paidMinor)
    expect(after.remainingMinor).toBe(before.remainingMinor)
    expect(after.paymentStatus).toBe(before.paymentStatus)
  })

  it('refuses to edit a cancelled order', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const order = makeOrder(customerId)
    completeLifecycleProduction(issueLifecycleWorkSheet({ orderId: order.id, overrideDepositRequirement: true }, env.ctx).id, env.ctx)
    cancelOrder({ orderId: order.id, reason: 'طلب العميل' }, env.ctx)

    expect(() => updateOrder(order.id, { notes: 'x' }, env.ctx)).toThrowError(/ملغى/)
  })
})

describe('The final invoice is customer-safe and distinct from the preliminary invoice (items 3/4)', () => {
  it('buildFinalInvoice/renderFinalInvoice exposes no internal cost/profit data, and is labelled "فاتورة معتمدة"', () => {
    const customerId = createCustomer({ name: 'عميل نهائي' }, env.ctx)
    const invoice = draftApprovedInvoice(customerId, 5000)
    const order = approveToOrder(invoice.id, env.ctx)
    // Workflow pass: approving the invoice IS its issuance. Payment,
    // release and delivery follow it instead of preceding it.
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(5000) }, env.ctx)
    issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
    recordDelivery({ orderId: order.id, kind: 'delivery' }, env.ctx)

    const dto = buildFinalInvoice(invoice.id)
    const html = renderFinalInvoice(dto, { name: 'AURA home' })

    const serialised = JSON.stringify(dto)
    for (const forbidden of ['costMinor', 'actualCost', 'machineCost', 'laborCost', 'profit', 'fifo']) {
      expect(serialised).not.toContain(forbidden)
    }
    expect(html).toContain('فاتورة معتمدة')
    expect(html).not.toContain('تكلفة')
    // Uses the ORDER's own commercial data directly — no re-entry.
    expect(dto.totalAfterDiscount).toBe('5.000,00 د.ل')
    expect(dto.remainingBalance).toBe('0,00 د.ل')
    expect(dto.orderReference).toBe(order.documentNumber)
  })
})

describe('Full sales pipeline, end to end (item 11)', () => {
  it('customer → approved invoice → approval → order → payment → cancel leaves correct, non-orphaned state', () => {
    const customerId = createCustomer({ name: 'عميل شامل' }, env.ctx)

    // 1. Approved invoice created and edited while still a draft.
    const invoice = draftApprovedInvoice(customerId, 2000)
    updateFinalInvoice(invoice.id, { notes: 'ملاحظات أولية' }, env.ctx)

    // 2/3. Approval freezes it AND creates the confirmed order — no
    //      duplicate data entry; the order copies the same figures.
    const order = approveToOrder(invoice.id, env.ctx)
    const loadedOrder = getOrderOrThrow(order.id)
    expect(loadedOrder.totalMinor).toBe(moneyFromMajor(2000))
    expect(loadedOrder.finalInvoiceId).toBe(invoice.id)
    expect(getFinalInvoice(invoice.id).invoice.status).toBe('approved')

    // 4. A partial payment, then a correction to the delivery address.
    const accountId = createAccount({ name: 'صندوق مسار البيع', kind: 'cash' }, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(1000), cashAccountId: accountId }, env.ctx)
    updateOrder(order.id, { address: 'مصراتة - حي جديد' }, env.ctx)
    expect(getOrderOrThrow(order.id).remainingMinor).toBe(moneyFromMajor(1000))

    // 5. Customer money is returned explicitly before cancellation.
    refundPayment({ orderId: order.id, amountMinor: moneyFromMajor(1000), cashAccountId: accountId, requestKey: crypto.randomUUID() }, env.ctx)
    completeLifecycleProduction(issueLifecycleWorkSheet({ orderId: order.id, overrideDepositRequirement: true }, env.ctx).id, env.ctx)
    cancelOrder({ orderId: order.id, reason: 'تغيير رغبة العميل' }, env.ctx)
    const cancelled = getOrderOrThrow(order.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.paidMinor).toBe(0)
    expect(cancelled.address).toBe('مصراتة - حي جديد')

    // The approved invoice is untouched by any of this.
    expect(getFinalInvoice(invoice.id).invoice.status).toBe('approved')
  })
})
