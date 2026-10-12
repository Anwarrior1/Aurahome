import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { authoritativeOrderPaymentPosition, cancelOrder, getOrder, listOrders, recordPayment, refundPayment } from '@main/services/sales/orders.service'
import { completeProduction, issueRelease, issueWorkSheet, recordDelivery } from '@main/services/production/production.service'
import { savePlannedMaterials } from '@main/services/planning/planning.service'
import { getUncollectedProduct, productEconomics, productsFromOrder } from '@main/services/sales/uncollected-products.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import { createExpense } from '@main/services/finance/expenses.service'
import { accountBalance, createAccount } from '@main/services/finance/cash.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let materialId: number
let accountId: number
beforeEach(() => {
  env = setupTestDatabase()
  const categoryId = createCategory({ name: 'Risk 04 boards' }, env.ctx)
  materialId = createMaterial({ sku: 'R04', name: 'MDF', categoryId, unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(100) } as never, env.ctx)
  createPurchase({ supplierId: createSupplier({ name: 'Risk 04 supplier' }, env.ctx), lines: [{ materialId, qtyMicro: q(1000), unitCostMicro: c(100) }] }, env.ctx)
  accountId = createAccount({ name: 'Risk 04 cash', kind: 'cash', openingBalanceMinor: m(100000) }, env.ctx)
})
afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})

const raw = () => getRawConnection()
const now = new Date()
const month = () => monthlyProfitSummary(now.getUTCFullYear(), now.getUTCMonth() + 1)
const economics = (id: number) => {
  const e = productEconomics(id)!
  return { actual: e.actualCostMinor, covered: e.customerCoveredMinor, factory: e.factoryBorneMinor, preparation: e.preparationCostMinor }
}

/** Mohamed: 8,000 manufacture, 6,000 retained, cancelled → one Uncollected Product. */
function mohamedProduct() {
  const invoice = createFinalInvoice({ customerId: createCustomer({ name: 'Mohamed' }, env.ctx), depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'kitchen', quantityMicro: q(1), unitPriceMinor: m(10000) }] }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: m(6000), cashAccountId: accountId }, env.ctx)
  savePlannedMaterials({ orderId: order.id }, [{ materialId, materialName: 'MDF', qtyMicro: q(80) }], env.ctx)
  completeProduction(issueWorkSheet({ orderId: order.id }, env.ctx).id, env.ctx)
  cancelOrder({ orderId: order.id, reason: 'Mohamed abandoned' }, env.ctx)
  return { sourceOrderId: order.id, productId: productsFromOrder(order.id)[0]!.id }
}

function sellTo(name: string, productId: number, price: number, extraLine?: number) {
  const invoice = createFinalInvoice({ customerId: createCustomer({ name }, env.ctx), depositPercentBp: 0, lines: [
    { lineKind: 'custom', description: 'existing kitchen', quantityMicro: q(1), unitPriceMinor: m(price), uncollectedProductId: productId },
    ...(extraLine ? [{ lineKind: 'custom' as const, description: 'new cabinet', quantityMicro: q(1), unitPriceMinor: m(extraLine) }] : [])
  ] }, env.ctx)
  return approveToOrder(invoice.id, env.ctx)
}
const refund = (orderId: number, amount: number, requestKey = crypto.randomUUID()) =>
  refundPayment({ orderId, amountMinor: m(amount), cashAccountId: accountId, requestKey }, env.ctx)
const productCount = () => (raw().prepare('SELECT COUNT(*) AS c FROM uncollected_products').get() as { c: number }).c

describe('Post-BL03 Risk 04 — a cancelled, undelivered resale returns the same product to the shelf', () => {
  it('A–I: Mohamed → Ahmed paid, fully refunded, cancelled → same product available with 8,000/6,000/2,000 → Salem 5,000 earns 3,000 once', () => {
    const { productId } = mohamedProduct()
    expect(economics(productId)).toEqual({ actual: m(8000), covered: m(6000), factory: m(2000), preparation: 0 })
    const count = productCount()

    const ahmed = sellTo('Ahmed', productId, 5000)
    recordPayment({ orderId: ahmed.id, amountMinor: m(5000), cashAccountId: accountId }, env.ctx)
    expect(getUncollectedProduct(productId)).toMatchObject({ status: 'sold', soldOrderId: ahmed.id })

    // B: no cancellation while Ahmed's money is held, even partly refunded.
    expect(getOrder(ahmed.id).actions.canCancel).toBe(false)
    expect(() => cancelOrder({ orderId: ahmed.id, reason: 'Ahmed withdrew' }, env.ctx)).toThrow(/استرداد كامل/)
    refund(ahmed.id, 2000)
    expect(() => cancelOrder({ orderId: ahmed.id, reason: 'Ahmed withdrew' }, env.ctx)).toThrow(/استرداد كامل/)
    const key = crypto.randomUUID()
    refund(ahmed.id, 3000, key)
    expect(refund(ahmed.id, 3000, key).idempotent).toBe(true) // retried refund is the same refund
    expect(() => refund(ahmed.id, 1)).toThrow()                // nothing left to refund
    expect(getOrder(ahmed.id).actions.canCancel).toBe(true)
    expect(listOrders({}).items.find((row) => row.id === ahmed.id)!.canCancel).toBe(true)

    const balanceBeforeCancel = accountBalance(accountId)
    cancelOrder({ orderId: ahmed.id, reason: 'Ahmed withdrew' }, env.ctx)
    expect(accountBalance(accountId)).toBe(balanceBeforeCancel) // cancellation fabricates no cash
    expect(() => cancelOrder({ orderId: ahmed.id, reason: 'again' }, env.ctx)).toThrow()

    // C/D/E/F
    expect(authoritativeOrderPaymentPosition(ahmed.id).paidMinor).toBe(0)
    expect(getUncollectedProduct(productId)).toMatchObject({ id: productId, status: 'available', soldOrderId: null, soldInvoiceId: null, reservedInvoiceId: null, soldPriceMinor: null })
    expect(productCount()).toBe(count)
    expect(economics(productId)).toEqual({ actual: m(8000), covered: m(6000), factory: m(2000), preparation: 0 })
    expect(month().revenueMinor).toBe(0)
    expect(raw().prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'uncollectedProducts.resaleCancelled'").get()).toEqual({ c: 1 })

    // G/H/I
    const salem = sellTo('Salem', productId, 5000)
    recordPayment({ orderId: salem.id, amountMinor: m(5000), cashAccountId: accountId }, env.ctx)
    recordDelivery({ orderId: salem.id, releaseId: issueRelease({ orderId: salem.id, kind: 'delivery' }, env.ctx).id, kind: 'handover' }, env.ctx)
    expect(orderCostBreakdown(salem.id)).toMatchObject({ materialCostMinor: m(2000), actualProfitMinor: m(3000) })
    expect(orderCostBreakdown(ahmed.id).materialCostMinor).toBe(0)
    expect(month()).toMatchObject({ revenueMinor: m(5000), materialCostMinor: m(2000), netProfitMinor: m(3000) })
    expect(getUncollectedProduct(productId).resaleProfitMinor).toBe(m(3000))
  })

  it('J: preparation cost stays attached exactly once across the cancelled attempt and is charged to the later sale', () => {
    const { productId } = mohamedProduct()
    createExpense({ amountMinor: m(500), description: 'repaint', uncollectedProductId: productId, cashAccountId: accountId }, env.ctx)
    const ahmed = sellTo('Ahmed', productId, 5000)
    cancelOrder({ orderId: ahmed.id, reason: 'Ahmed withdrew' }, env.ctx)
    expect(raw().prepare('SELECT COUNT(*) AS c FROM expenses WHERE uncollected_product_id = ?').get(productId)).toEqual({ c: 1 })
    expect(economics(productId)).toEqual({ actual: m(8000), covered: m(6000), factory: m(2000), preparation: m(500) })
    const salem = sellTo('Salem', productId, 5000)
    recordPayment({ orderId: salem.id, amountMinor: m(5000), cashAccountId: accountId }, env.ctx)
    recordDelivery({ orderId: salem.id, releaseId: issueRelease({ orderId: salem.id, kind: 'delivery' }, env.ctx).id, kind: 'handover' }, env.ctx)
    expect(orderCostBreakdown(salem.id).actualProfitMinor).toBe(m(2500))
    expect(month().netProfitMinor).toBe(m(2500))
  })

  it('K: a handed-over resale cannot be cancelled back into stock', () => {
    const { productId } = mohamedProduct()
    const ahmed = sellTo('Ahmed', productId, 5000)
    recordPayment({ orderId: ahmed.id, amountMinor: m(5000), cashAccountId: accountId }, env.ctx)
    recordDelivery({ orderId: ahmed.id, releaseId: issueRelease({ orderId: ahmed.id, kind: 'delivery' }, env.ctx).id, kind: 'handover' }, env.ctx)
    expect(() => refund(ahmed.id, 5000)).toThrow()
    expect(() => cancelOrder({ orderId: ahmed.id, reason: 'after handover' }, env.ctx)).toThrow()
    expect(getUncollectedProduct(productId)).toMatchObject({ status: 'sold', soldOrderId: ahmed.id })
  })

  it('mixed order: cancelling after manufacture releases the resold product; its cost never joins the new product', () => {
    const { productId } = mohamedProduct()
    const ahmed = sellTo('Ahmed', productId, 5000, 2000)
    savePlannedMaterials({ orderId: ahmed.id }, [{ materialId, materialName: 'MDF', qtyMicro: q(10) }], env.ctx)
    completeProduction(issueWorkSheet({ orderId: ahmed.id }, env.ctx).id, env.ctx)
    cancelOrder({ orderId: ahmed.id, reason: 'Ahmed withdrew' }, env.ctx)
    expect(getUncollectedProduct(productId)).toMatchObject({ status: 'available', soldOrderId: null })
    expect(economics(productId)).toEqual({ actual: m(8000), covered: m(6000), factory: m(2000), preparation: 0 })
    const own = productsFromOrder(ahmed.id)
    expect(own).toHaveLength(1)
    expect(economics(own[0]!.id).actual).toBe(m(1000)) // Ahmed's own 10 boards only
    expect(() => sellTo('Salem', productId, 5000)).not.toThrow()
  })
})
