import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { insertHistoricalStockSheet } from '../helpers/historical-stock-sheet'
import { approveToOrder } from '../helpers/sales-flow'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { products } from '@main/db/schema/products.schema'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import {
  createProduct,
  replaceBom,
  replaceProductMachines,
  replaceProductCommission,
  listProducts,
  getProduct,
  productFullDeletePreview,
  fullDeleteProduct
} from '@main/services/products/products.service'
import { createStandardQuotation, getQuotation } from '@main/services/sales/quotations.service'
import { createStandardFinalInvoice, getFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrder, getOrderOrThrow, recordPayment } from '@main/services/sales/orders.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { issueStandardStockFromBom } from '@main/services/production/production.service'
import { onHandMicro } from '@main/services/production/finished-goods.service'
import { createMachine } from '@main/services/production/machines.service'
import { createWorker } from '@main/services/production/workers.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * Standard Product permanent delete: removes the catalog master and its
 * OWN current configuration (BOM/machine/commission — all
 * `onDelete: 'cascade'` in the schema), while every historical
 * quotation/order/approved-invoice line that named it keeps its own
 * frozen snapshot untouched and only loses the live `product_id` link
 * — mirroring `fullDeleteMaterial`'s already-established pattern.
 * Blocked outright when real finished-goods inventory history or an
 * open stock-production order still needs the live link.
 */
let env: TestEnv
let seq = 0
beforeEach(() => { env = setupTestDatabase(); seq = 0 })
afterEach(() => env.cleanup())

function unique(prefix: string): string { return `${prefix}-${++seq}` }

function seedMaterial() {
  const categoryId = createCategory({ name: unique('أخشاب') }, env.ctx)
  const materialId = createMaterial({
    sku: unique('MDF'), name: 'لوح MDF', categoryId, unit: 'لوح',
    currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
  } as never, env.ctx)
  const supplierId = createSupplier({ name: unique('مورد') }, env.ctx)
  createPurchase({
    supplierId,
    lines: [{ materialId, qtyMicro: quantityFromDisplay(100), unitCostMicro: unitCostFromMajor(100) }]
  }, env.ctx)
  return materialId
}

/** A fully-configured Standard Product: its own BOM, machine and
 *  worker-commission templates — the "owned configuration" the ticket
 *  asks to be gone once the product is deleted. */
function fullyConfiguredProduct(materialId: number, code: string, priceMajor = 6000) {
  const productId = createProduct({ code, name: 'خزانة', defaultPriceMinor: moneyFromMajor(priceMajor) }, env.ctx)
  replaceBom(productId, [{ materialId, qtyMicro: quantityFromDisplay(10), unit: 'لوح', dimensions: '200×60' }], env.ctx)
  const machineId = createMachine({ name: unique('آلة القص'), costingUnit: 'لوح', defaultRateMicro: unitCostFromMajor(30) }, env.ctx)
  replaceProductMachines(productId, [{ machineId, usageQtyMicro: quantityFromDisplay(1) }], env.ctx)
  const workerId = createWorker({ name: unique('عامل') }, env.ctx)
  replaceProductCommission(productId, [{ workerId, amountMinor: moneyFromMajor(200) }], env.ctx)
  return productId
}

function ownedConfigCounts(productId: number) {
  const raw = getRawConnection()
  const c = (table: string) =>
    (raw.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE product_id = ?`).get(productId) as { c: number }).c
  return { bom: c('product_bom_lines'), machines: c('product_machine_lines'), commission: c('product_commission_lines') }
}

describe('1 — a Standard Product with no history at all can be deleted', () => {
  it('is physically gone, its own owned configuration cascades away with it', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    expect(ownedConfigCounts(productId)).toEqual({ bom: 1, machines: 1, commission: 1 })

    const preview = productFullDeletePreview(productId)
    expect(preview.blockers).toEqual([])

    const result = fullDeleteProduct({ id: productId, confirmation: preview.code }, env.ctx)
    expect(result.removed).toBe(true)

    expect(getDatabase().select().from(products).where(eq(products.id, productId)).get()).toBeUndefined()
    expect(ownedConfigCounts(productId)).toEqual({ bom: 0, machines: 0, commission: 0 })
  })
})

describe('2 — typed confirmation gate uses the product code', () => {
  it('blocks with the wrong code, allows with the exact code', () => {
    const materialId = seedMaterial()
    const code = unique('DEMO-WARDROBE')
    const productId = createProduct({ code, name: 'دولاب', defaultPriceMinor: moneyFromMajor(1000) }, env.ctx)
    void materialId

    expect(() => fullDeleteProduct({ id: productId, confirmation: 'كود خاطئ' }, env.ctx)).toThrowError(/اكتب كود المنتج/)
    expect(getDatabase().select().from(products).where(eq(products.id, productId)).get()).toBeDefined()

    fullDeleteProduct({ id: productId, confirmation: code }, env.ctx)
    expect(getDatabase().select().from(products).where(eq(products.id, productId)).get()).toBeUndefined()
  })
})

describe('3 — cancel is a true no-op', () => {
  it('computing the preview alone never mutates anything', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    productFullDeletePreview(productId)
    productFullDeletePreview(productId)
    expect(ownedConfigCounts(productId)).toEqual({ bom: 1, machines: 1, commission: 1 })
  })
})

describe('4 — historical documents survive with their frozen snapshot untouched', () => {
  it('an approved-invoice → order chain keeps its exact frozen text/price after the product is deleted', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    const customerId = createCustomer({ name: unique('عميل') }, env.ctx)

    const invoice = createStandardFinalInvoice(
      { customerId, productId, quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(6500), specifications: 'مواصفات دقيقة', dimensions: '200×60×40' },
      env.ctx
    )
    const order = approveToOrder(invoice.id, env.ctx)
    const beforeOrder = getOrder(order.id)
    const beforeInvoice = getFinalInvoice(invoice.id)
    const beforeLine = beforeOrder.lines[0]
    expect(beforeLine.productId).toBe(productId)

    const preview = productFullDeletePreview(productId)
    expect(preview.blockers).toEqual([])
    const byKey = Object.fromEntries(preview.dependencies.map((d) => [d.key, d.count]))
    expect(byKey.orderLines).toBe(1)
    expect(byKey.finalInvoiceLines).toBe(1)

    fullDeleteProduct({ id: productId, confirmation: preview.code }, env.ctx)

    // The order and invoice still exist, unchanged in every business
    // sense — only the live product_id link is released.
    const afterOrder = getOrder(order.id)
    const afterInvoice = getFinalInvoice(invoice.id)
    expect(afterOrder.order.id).toBe(beforeOrder.order.id)
    expect(afterOrder.order.totalMinor).toBe(beforeOrder.order.totalMinor)
    expect(afterInvoice.invoice.id).toBe(beforeInvoice.invoice.id)
    expect(afterInvoice.invoice.totalMinor).toBe(beforeInvoice.invoice.totalMinor)

    const afterLine = afterOrder.lines[0]
    expect(afterLine.productId).toBeNull()
    expect(afterLine.description).toBe(beforeLine.description)
    expect(afterLine.specifications).toBe(beforeLine.specifications)
    expect(afterLine.dimensions).toBe(beforeLine.dimensions)
    expect(afterLine.unitPriceMinor).toBe(beforeLine.unitPriceMinor)
    expect(afterLine.lineTotalMinor).toBe(beforeLine.lineTotalMinor)
    expect(afterLine.bomSnapshot).toBe(beforeLine.bomSnapshot)
  })

  it('a preliminary quotation line keeps its frozen snapshot after the product is deleted', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    const customerId = createCustomer({ name: unique('عميل') }, env.ctx)
    const quotation = createStandardQuotation({ customerId, productId, quantityMicro: quantityFromDisplay(1) }, env.ctx)
    const before = getQuotation(quotation.id).lines[0]

    fullDeleteProduct({ id: productId, confirmation: productFullDeletePreview(productId).code }, env.ctx)

    const after = getQuotation(quotation.id).lines[0]
    expect(after.productId).toBeNull()
    expect(after.description).toBe(before.description)
    expect(after.unitPriceMinor).toBe(before.unitPriceMinor)
    expect(after.bomSnapshot).toBe(before.bomSnapshot)
  })

  // BL-04: a standard line is never manufactured by a customer MO. Its sale
  // history survives deletion; stock history makes the product undeletable.
  it('a Customer Order that sold the product remains unchanged, and stock history blocks deletion', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    const customerId = createCustomer({ name: unique('عميل') }, env.ctx)
    const invoice = createStandardFinalInvoice({ customerId, productId, quantityMicro: quantityFromDisplay(1) }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
    const lineBefore = getOrder(order.id).lines[0]
    const costBefore = orderCostBreakdown(order.id)

    fullDeleteProduct({ id: productId, confirmation: productFullDeletePreview(productId).code }, env.ctx)

    expect(getOrder(order.id).lines[0]).toMatchObject({ description: lineBefore!.description, bomSnapshot: lineBefore!.bomSnapshot })
    const costAfter = orderCostBreakdown(order.id)
    expect(costAfter.totalActualCostMinor).toBe(costBefore.totalActualCostMinor)
    expect(costAfter.actualProfitMinor).toBe(costBefore.actualProfitMinor)

    const stocked = fullyConfiguredProduct(materialId, unique('DEMO-S'))
    issueStandardStockFromBom({ productId: stocked, quantityMicro: quantityFromDisplay(1), requestKey: unique('full-delete-stock') }, env.ctx)
    expect(productFullDeletePreview(stocked).blockers.length).toBeGreaterThan(0)
  })
})

describe('5 — an unrelated Product B is never touched', () => {
  it('deleting Product A leaves Product B, its own config, and its own historical lines exactly as they were', () => {
    const materialId = seedMaterial()
    const productA = fullyConfiguredProduct(materialId, unique('DEMO-A'))
    const productB = fullyConfiguredProduct(materialId, unique('DEMO-B'))
    const customerId = createCustomer({ name: unique('عميل') }, env.ctx)
    const invoiceB = createStandardFinalInvoice({ customerId, productId: productB, quantityMicro: quantityFromDisplay(1) }, env.ctx)
    const orderB = approveToOrder(invoiceB.id, env.ctx)
    const beforeB = getProduct(productB)
    const beforeLineB = getOrder(orderB.id).lines[0]

    fullDeleteProduct({ id: productA, confirmation: productFullDeletePreview(productA).code }, env.ctx)

    expect(getDatabase().select().from(products).where(eq(products.id, productB)).get()).toBeDefined()
    expect(ownedConfigCounts(productB)).toEqual({ bom: 1, machines: 1, commission: 1 })
    const afterB = getProduct(productB)
    expect(afterB.product).toEqual(beforeB.product)
    const afterLineB = getOrder(orderB.id).lines[0]
    expect(afterLineB.productId).toBe(productB)
    expect(afterLineB.description).toBe(beforeLineB.description)
    expect(listProducts().some((p) => p.id === productB)).toBe(true)
  })
})

describe('6 — deleted product disappears from the catalog and cannot be selected for new documents', () => {
  it('listProducts no longer returns it — there is no row left to select', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    expect(listProducts().some((p) => p.id === productId)).toBe(true)

    fullDeleteProduct({ id: productId, confirmation: productFullDeletePreview(productId).code }, env.ctx)

    expect(listProducts().some((p) => p.id === productId)).toBe(false)
    expect(listProducts({ activeOnly: true }).some((p) => p.id === productId)).toBe(false)
  })
})

describe('7 — financial totals and inventory stay correct', () => {
  it('material stock is completely untouched by a product deletion', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    const before = availableQty(materialId)

    fullDeleteProduct({ id: productId, confirmation: productFullDeletePreview(productId).code }, env.ctx)

    expect(availableQty(materialId)).toBe(before)
  })

  it('an order\'s financial totals are unchanged after the product behind one of its lines is deleted', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    const customerId = createCustomer({ name: unique('عميل') }, env.ctx)
    const invoice = createStandardFinalInvoice(
      { customerId, productId, quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(7000) },
      env.ctx
    )
    const order = approveToOrder(invoice.id, env.ctx)
    const totalBefore = getOrderOrThrow(order.id).totalMinor

    fullDeleteProduct({ id: productId, confirmation: productFullDeletePreview(productId).code }, env.ctx)

    expect(getOrderOrThrow(order.id).totalMinor).toBe(totalBefore)
  })
})

describe('8 — an open stock-production order blocks deletion explicitly (active production case)', () => {
  it('refuses to delete a product with an open (not yet completed) stock production order', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    insertHistoricalStockSheet(productId, quantityFromDisplay(2))

    const preview = productFullDeletePreview(productId)
    expect(preview.blockers.length).toBeGreaterThan(0)
    expect(preview.blockers.join('،')).toMatch(/أوامر تصنيع لإنتاج مخزون/)

    expect(() => fullDeleteProduct({ id: productId, confirmation: preview.code }, env.ctx)).toThrowError(/تعذر حذف المنتج/)
    expect(getDatabase().select().from(products).where(eq(products.id, productId)).get()).toBeDefined()
  })
})

describe('9 — real finished-goods inventory history blocks deletion explicitly, never corrupted', () => {
  it('refuses to delete a product that already has posted finished-goods movements', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    issueStandardStockFromBom({ productId, quantityMicro: quantityFromDisplay(2), requestKey: 'product-full-delete-stock' }, env.ctx)
    expect(onHandMicro(productId)).toBe(quantityFromDisplay(2))

    const preview = productFullDeletePreview(productId)
    expect(preview.blockers.length).toBeGreaterThan(0)
    expect(preview.blockers.join('،')).toMatch(/حركات مخزون بضاعة تامة/)

    expect(() => fullDeleteProduct({ id: productId, confirmation: preview.code }, env.ctx)).toThrowError(/تعذر حذف المنتج/)

    // Nothing corrupted: the product, its finished-goods on-hand and
    // its own configuration all survive exactly as they were.
    expect(getDatabase().select().from(products).where(eq(products.id, productId)).get()).toBeDefined()
    expect(onHandMicro(productId)).toBe(quantityFromDisplay(2))
    expect(ownedConfigCounts(productId)).toEqual({ bom: 1, machines: 1, commission: 1 })
  })
})

describe('10 — rollback on forced failure', () => {
  it('rolls back the entire operation, nothing partially deleted or nulled', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    const customerId = createCustomer({ name: unique('عميل') }, env.ctx)
    const invoice = createStandardFinalInvoice({ customerId, productId, quantityMicro: quantityFromDisplay(1) }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    getRawConnection().exec("CREATE TRIGGER test_block_product_full_delete BEFORE DELETE ON products BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")

    expect(() => fullDeleteProduct({ id: productId, confirmation: productFullDeletePreview(productId).code }, env.ctx)).toThrow()

    expect(getDatabase().select().from(products).where(eq(products.id, productId)).get()).toBeDefined()
    expect(ownedConfigCounts(productId)).toEqual({ bom: 1, machines: 1, commission: 1 })
    const line = getOrder(order.id).lines[0]
    expect(line.productId).toBe(productId)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})

describe('11 — database integrity after a real mixed deletion', () => {
  it('leaves foreign_key_check clean and integrity_check ok', () => {
    const materialId = seedMaterial()
    const productId = fullyConfiguredProduct(materialId, unique('DEMO'))
    const customerId = createCustomer({ name: unique('عميل') }, env.ctx)
    createStandardQuotation({ customerId, productId, quantityMicro: quantityFromDisplay(1) }, env.ctx)
    const invoice = createStandardFinalInvoice({ customerId, productId, quantityMicro: quantityFromDisplay(1) }, env.ctx)
    approveToOrder(invoice.id, env.ctx)

    fullDeleteProduct({ id: productId, confirmation: productFullDeletePreview(productId).code }, env.ctx)

    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})
