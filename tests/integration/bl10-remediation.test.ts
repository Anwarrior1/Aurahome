import { seedFinishedGoods } from '../helpers/finished-goods-fixture'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import { createProduct } from '@main/services/products/products.service'
import { createFinalInvoice, unapproveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder, getOrder, listOrders, recordPayment } from '@main/services/sales/orders.service'
import { cancelDelivery, cancelProductionOrder, completeProduction, consumeForOrder, getProductionOrder, issueRelease, issueWorkSheet, listReleases, recordDelivery, reverseRelease, reverseWorkSheet, startProduction } from '@main/services/production/production.service'
import { reverseCancelledOrderReleases } from '@main/services/production/release-reversal.internal'
import { withImmediateTransaction } from '@main/db/transactions'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { onHandMicro } from '@main/services/production/finished-goods.service'
import { productsFromOrder } from '@main/services/sales/uncollected-products.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createMaterialReturn } from '@main/services/production/material-returns.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let seq = 0
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  env.cleanup()
})
const raw = () => getRawConnection()
const rows = (query: string, ...args: unknown[]) => raw().prepare(query).all(...args)

function order(kind: 'custom' | 'standard' | 'mixed' = 'custom', paid = true) {
  const customerId = createCustomer({ name: `BL10 ${++seq}` }, env.ctx)
  const productId = kind === 'custom' ? null : createProduct({ code: `BL10-${seq}`, name: 'Ready', defaultPriceMinor: m(3000) }, env.ctx)
  if (productId) seedFinishedGoods({ productId, qtyMicro: q(3), totalCostMinor: m(1500) }, env.ctx)
  const invoice = createFinalInvoice({ customerId, lines: [
    ...(kind === 'standard' ? [] : [{ lineKind: 'custom' as const, description: 'Custom', quantityMicro: q(1), unitPriceMinor: m(5000) }]),
    ...(productId ? [{ lineKind: 'standard' as const, productId, description: 'Ready', quantityMicro: q(1), unitPriceMinor: m(3000) }] : [])
  ] }, env.ctx)
  const approved = approveToOrder(invoice.id, env.ctx)
  if (paid) recordPayment({ orderId: approved.id, amountMinor: approved.totalMinor }, env.ctx)
  return { invoiceId: invoice.id, id: approved.id, productId }
}

function state(orderId: number) {
  return {
    order: rows('SELECT * FROM orders WHERE id = ?', orderId),
    sheets: rows('SELECT * FROM work_sheets WHERE order_id = ? ORDER BY id', orderId),
    releases: rows('SELECT * FROM releases WHERE order_id = ? ORDER BY id', orderId),
    deliveries: rows('SELECT * FROM deliveries WHERE order_id = ? ORDER BY id', orderId),
    fg: rows('SELECT * FROM finished_goods_movements WHERE order_id = ? ORDER BY id', orderId),
    uncollected: rows('SELECT * FROM uncollected_products WHERE source_order_id = ? ORDER BY id', orderId),
    payments: rows('SELECT * FROM customer_payments WHERE order_id = ? ORDER BY id', orderId),
    refunds: rows('SELECT * FROM customer_payment_refunds WHERE order_id = ? ORDER BY id', orderId),
    inventory: rows('SELECT * FROM inventory_movements WHERE order_id = ? ORDER BY id', orderId),
    audit: rows('SELECT * FROM audit_log ORDER BY id')
  }
}

function eligible(orderId: number, expected: boolean) {
  expect(getOrder(orderId).actions.canCancel).toBe(expected)
  expect(listOrders({}).items.find(row => row.id === orderId)?.canCancel).toBe(expected)
}

describe('BL-10 owner-approved cancellation lifecycle', () => {
  it('BL-16: cancellation-only authority reverses the permit and preserves Custom output', () => {
    const f = order()
    completeProduction(issueWorkSheet({ orderId: f.id }, env.ctx).id, env.ctx)
    const permit = issueRelease({ orderId: f.id, kind: 'delivery' }, env.ctx)
    const cancelOnly = { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [P.orders.cancel] } }
    cancelOrder({ orderId: f.id, reason: 'BL-16 cancellation' }, cancelOnly)
    expect(getOrder(f.id).order.status).toBe('cancelled')
    expect(rows('SELECT status FROM releases WHERE id = ?', permit.id)).toEqual([{ status: 'reversed' }])
    expect(productsFromOrder(f.id)).toHaveLength(1)
  })

  it('BL-16: cancellation-only authority cannot independently reverse a live permit', () => {
    const f = order()
    completeProduction(issueWorkSheet({ orderId: f.id }, env.ctx).id, env.ctx)
    const permit = issueRelease({ orderId: f.id, kind: 'delivery' }, env.ctx)
    const cancelOnly = { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [P.orders.cancel] } }
    const token = listReleases({ orderId: f.id }).items[0]!.reversalToken
    const before = state(f.id)
    expect(() => reverseCancelledOrderReleases(f.id, cancelOnly)).toThrow(/معاملة إلغاء/)
    expect(() => withImmediateTransaction(() => reverseCancelledOrderReleases(f.id, cancelOnly))).toThrow(/معاملة إلغاء/)
    expect(() => reverseRelease({ id: permit.id, expectedToken: token }, cancelOnly)).toThrow(/صلاحية/)
    expect(state(f.id)).toEqual(before)
  })

  it('BL-16: independent reversal retains release authority and expected-token check', () => {
    const f = order()
    completeProduction(issueWorkSheet({ orderId: f.id }, env.ctx).id, env.ctx)
    const permit = issueRelease({ orderId: f.id, kind: 'delivery' }, env.ctx)
    const reverseOnly = { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [P.releases.reverse] } }
    const token = listReleases({ orderId: f.id }).items[0]!.reversalToken
    expect(() => reverseRelease({ id: permit.id, expectedToken: 'stale' }, reverseOnly)).toThrow(/تغير/)
    expect(rows('SELECT status FROM releases WHERE id = ?', permit.id)).toEqual([{ status: 'active' }])
    reverseRelease({ id: permit.id, expectedToken: token }, reverseOnly)
    expect(rows('SELECT status FROM releases WHERE id = ?', permit.id)).toEqual([{ status: 'reversed' }])
    expect(getOrder(f.id).order.status).toBe('confirmed')
  })

  it('keeps pre-start cancellation unavailable and safe reversal intact', () => {
    const f = order('custom', false)
    eligible(f.id, false)
    const sheet = issueWorkSheet({ orderId: f.id, overrideDepositRequirement: true }, env.ctx)
    eligible(f.id, false)
    const before = state(f.id)
    expect(() => cancelOrder({ orderId: f.id, reason: 'too early' }, env.ctx)).toThrow(/قبل اكتمال|قبل بدء/)
    expect(state(f.id)).toEqual(before)
    reverseWorkSheet({ id: sheet.id, expectedToken: getProductionOrder(sheet.id).reversalToken, confirmation: sheet.documentNumber, reason: 'pre-start' }, env.ctx)
    unapproveFinalInvoice({ id: f.invoiceId, expectedRevision: 1 }, env.ctx)
    expect(getOrder(f.id).order.status).toBe('awaiting_approval')
    expect(getProductionOrder(sheet.id).sheet.status).toBe('reversed')
  })

  it('enables Customer Order cancellation at start, keeps the MO running, and transfers only at completion', () => {
    const f = order()
    const sheet = issueWorkSheet({ orderId: f.id }, env.ctx)
    eligible(f.id, false)
    startProduction(sheet.id, env.ctx)
    eligible(f.id, true)
    const beforeCancelMO = state(f.id)
    expect(() => cancelProductionOrder({ id: sheet.id, reason: 'stopped' }, env.ctx)).toThrow()
    expect(state(f.id)).toEqual(beforeCancelMO)
    cancelOrder({ orderId: f.id, reason: 'abandoned during manufacture' }, env.ctx)
    expect(getOrder(f.id).order.status).toBe('cancelled')
    expect(getProductionOrder(sheet.id).sheet.status).toBe('in_production')
    expect(productsFromOrder(f.id)).toEqual([])
    expect(() => issueRelease({ orderId: f.id, kind: 'delivery' }, env.ctx)).toThrow(/ملغى/)
    expect(() => recordDelivery({ orderId: f.id, kind: 'handover' }, env.ctx)).toThrow(/ملغى/)
    const paid = state(f.id).payments
    completeProduction(sheet.id, env.ctx)
    const output = rows('SELECT source_order_id AS orderId, source_work_sheet_id AS sheetId, cost_basis_minor AS cost, status FROM uncollected_products WHERE source_order_id = ?', f.id) as Array<{ orderId: number; sheetId: number; cost: number; status: string }>
    expect(output).toEqual([{ orderId: f.id, sheetId: sheet.id, cost: 0, status: 'available' }])
    expect(state(f.id).payments).toEqual(paid)
    expect(() => completeProduction(sheet.id, env.ctx)).toThrow()
    expect(productsFromOrder(f.id)).toHaveLength(1)
  })

  it('continues order-linked material posting after cancellation and freezes the final actual cost', () => {
    const f = order()
    const categoryId = createCategory({ name: 'BL10 material category' }, env.ctx)
    const materialId = createMaterial({ sku: 'BL10-M', name: 'Board', categoryId, unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(100) } as never, env.ctx)
    createPurchase({ supplierId: createSupplier({ name: 'BL10 supplier' }, env.ctx), lines: [{ materialId, qtyMicro: q(5), unitCostMicro: c(100) }] }, env.ctx)
    const sheet = issueWorkSheet({ orderId: f.id }, env.ctx)
    startProduction(sheet.id, env.ctx)
    cancelOrder({ orderId: f.id, reason: 'abandoned' }, env.ctx)
    const issue = consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: q(2) }, env.ctx)
    expect(issue.actualCostMinor).toBe(m(200))
    createMaterialReturn({ orderId: f.id, materialId, quantityMicro: q(1), requestKey: crypto.randomUUID() }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    const output = rows('SELECT cost_basis_minor AS cost, source_order_line_id AS lineId FROM uncollected_products WHERE source_order_id = ?', f.id) as Array<{ cost: number; lineId: number }>
    expect(output).toHaveLength(1)
    expect(output[0]!.cost).toBe(m(100))
    expect(output[0]!.lineId).toBeTruthy()
  })

  it('complete then cancel converges to exactly one product, with recorded fulfillment still guarded', () => {
    const f = order()
    const sheet = issueWorkSheet({ orderId: f.id }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    eligible(f.id, true)
    const permit = issueRelease({ orderId: f.id, kind: 'delivery' }, env.ctx)
    const delivery = recordDelivery({ orderId: f.id, releaseId: permit.id, kind: 'handover' }, env.ctx)
    const before = state(f.id)
    expect(() => cancelOrder({ orderId: f.id, reason: 'after delivery' }, env.ctx)).toThrow(/بعد تسجيل/)
    expect(state(f.id)).toEqual(before)
    cancelDelivery({ id: delivery.id, reason: 'explicit reversal' }, env.ctx)
    cancelOrder({ orderId: f.id, reason: 'after reversal' }, env.ctx)
    expect(productsFromOrder(f.id)).toHaveLength(1)
    expect(rows('SELECT status FROM releases WHERE id = ?', permit.id)).toEqual([{ status: 'reversed' }])
  })

  it('automatically reverses an active permit and blocks all cancelled-parent fulfillment', () => {
    const f = order()
    completeProduction(issueWorkSheet({ orderId: f.id }, env.ctx).id, env.ctx)
    const permit = issueRelease({ orderId: f.id, kind: 'delivery' }, env.ctx)
    cancelOrder({ orderId: f.id, reason: 'abandoned' }, env.ctx)
    expect(rows('SELECT status, reversed_at IS NOT NULL AS reversed FROM releases WHERE id = ?', permit.id)).toEqual([{ status: 'reversed', reversed: 1 }])
    expect(rows('SELECT COUNT(*) AS count FROM releases WHERE order_id = ? AND status = ?', f.id, 'active')).toEqual([{ count: 0 }])
    expect(() => issueRelease({ orderId: f.id, kind: 'delivery' }, env.ctx)).toThrow(/ملغى/)
    expect(() => recordDelivery({ orderId: f.id, releaseId: permit.id, kind: 'handover' }, env.ctx)).toThrow(/ملغى/)
    expect(productsFromOrder(f.id)).toHaveLength(1)
  })

  it('reverses Standard FG once when cancellation reverses its permit', () => {
    const f = order('standard')
    eligible(f.id, false)
    const permit = issueRelease({ orderId: f.id, kind: 'transport' }, env.ctx)
    expect(onHandMicro(f.productId!)).toBe(q(2))
    eligible(f.id, true)
    cancelOrder({ orderId: f.id, reason: 'abandoned' }, env.ctx)
    expect(onHandMicro(f.productId!)).toBe(q(3))
    expect(rows('SELECT kind FROM finished_goods_movements WHERE order_id = ? ORDER BY id', f.id)).toEqual([{ kind: 'sale_out' }, { kind: 'sale_reversal' }])
    expect(rows('SELECT status FROM releases WHERE id = ?', permit.id)).toEqual([{ status: 'reversed' }])
    expect(() => cancelOrder({ orderId: f.id, reason: 'again' }, env.ctx)).toThrow()
    expect(onHandMicro(f.productId!)).toBe(q(3))
  })

  it('atomically reverses the mixed-order permit and FG and transfers only Custom output', () => {
    const f = order('mixed')
    const categoryId = createCategory({ name: 'BL10 mixed material category' }, env.ctx)
    const materialId = createMaterial({ sku: 'BL10-MIX', name: 'Mixed board', categoryId, unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(100) } as never, env.ctx)
    createPurchase({ supplierId: createSupplier({ name: 'BL10 mixed supplier' }, env.ctx), lines: [{ materialId, qtyMicro: q(2), unitCostMicro: c(100) }] }, env.ctx)
    const sheet = issueWorkSheet({ orderId: f.id }, env.ctx)
    consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: q(2) }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    const permit = issueRelease({ orderId: f.id, kind: 'transport' }, env.ctx)
    expect(onHandMicro(f.productId!)).toBe(q(2))
    cancelOrder({ orderId: f.id, reason: 'mixed abandonment' }, env.ctx)
    expect(onHandMicro(f.productId!)).toBe(q(3))
    expect(rows('SELECT kind FROM finished_goods_movements WHERE order_id = ? ORDER BY id', f.id)).toEqual([{ kind: 'sale_out' }, { kind: 'sale_reversal' }])
    expect(rows('SELECT status FROM releases WHERE id = ?', permit.id)).toEqual([{ status: 'reversed' }])
    expect(rows('SELECT cost_basis_minor AS cost FROM uncollected_products WHERE source_order_id = ?', f.id)).toEqual([{ cost: m(200) }])
    expect(productsFromOrder(f.id)).toHaveLength(1)
  })

  it('rolls back order, permit, stock and history when permit reversal fails', () => {
    const f = order('mixed')
    completeProduction(issueWorkSheet({ orderId: f.id }, env.ctx).id, env.ctx)
    issueRelease({ orderId: f.id, kind: 'transport' }, env.ctx)
    const before = state(f.id)
    const ready = onHandMicro(f.productId!)
    raw().exec("CREATE TRIGGER bl10_fail_release BEFORE UPDATE OF status ON releases WHEN NEW.status = 'reversed' BEGIN SELECT RAISE(ABORT, 'permit reversal failure'); END")
    expect(() => cancelOrder({ orderId: f.id, reason: 'rollback' }, env.ctx)).toThrow(/permit reversal failure/)
    expect(state(f.id)).toEqual(before)
    expect(onHandMicro(f.productId!)).toBe(ready)
  })

  it('rolls back the earlier order and permit reversal when FG reversal fails', () => {
    const f = order('mixed')
    completeProduction(issueWorkSheet({ orderId: f.id }, env.ctx).id, env.ctx)
    issueRelease({ orderId: f.id, kind: 'transport' }, env.ctx)
    const before = state(f.id)
    const ready = onHandMicro(f.productId!)
    raw().exec("CREATE TRIGGER bl10_fail_fg BEFORE INSERT ON finished_goods_movements WHEN NEW.kind = 'sale_reversal' BEGIN SELECT RAISE(ABORT, 'FG reversal failure'); END")
    expect(() => cancelOrder({ orderId: f.id, reason: 'rollback' }, env.ctx)).toThrow(/FG reversal failure/)
    expect(state(f.id)).toEqual(before)
    expect(onHandMicro(f.productId!)).toBe(ready)
  })

  it('preserves legitimate outsourced Custom fulfillment without an internal worksheet', () => {
    const f = order('custom')
    eligible(f.id, false)
    const permit = issueRelease({ orderId: f.id, kind: 'delivery' }, env.ctx)
    recordDelivery({ orderId: f.id, releaseId: permit.id, kind: 'handover' }, env.ctx)
    expect(getOrder(f.id).order.status).toBe('completed')
    expect(rows('SELECT id FROM work_sheets WHERE order_id = ?', f.id)).toEqual([])
  })

  it('uses authoritative backend eligibility for both order UIs in every internal state', () => {
    const detailUi = readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')
    const productionUi = readFileSync('src/renderer/pages/worksheets/ProductionOrderPage.tsx', 'utf8')
    expect(detailUi).toContain('can(P.orders.cancel) && detail.data!.actions.canCancel')
    expect(productionUi).toContain("data.order && can(P.worksheets.issue) && isOpen && sheet.status === 'ready'")
    const f = order()
    eligible(f.id, false)
    const sheet = issueWorkSheet({ orderId: f.id }, env.ctx)
    eligible(f.id, false)
    startProduction(sheet.id, env.ctx)
    eligible(f.id, true)
    completeProduction(sheet.id, env.ctx)
    eligible(f.id, true)
    const permit = issueRelease({ orderId: f.id, kind: 'delivery' }, env.ctx)
    eligible(f.id, true)
    recordDelivery({ orderId: f.id, releaseId: permit.id, kind: 'handover' }, env.ctx)
    eligible(f.id, false)
  })
})
