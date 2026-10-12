import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { materials } from '@main/db/schema/catalog.schema'
import { purchases } from '@main/db/schema/parties.schema'
import { createCategory, createMaterial, fullDeleteMaterial, getMaterial, listMaterials, materialFullDeletePreview } from '@main/services/catalog/catalog.service'
import { createSupplier, supplierBalances } from '@main/services/parties/parties.service'
import { createPurchase, getPurchase } from '@main/services/purchasing/purchasing.service'
import { availableQty, recordOpeningStock } from '@main/services/inventory/inventory.service'
import { createProduct, getBom } from '@main/services/products/products.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { createQuotation } from '@main/services/sales/quotations.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
let seq = 0
beforeEach(() => { env = setupTestDatabase(); seq = 0 })
afterEach(() => env.cleanup())

function newMaterial(name = `مادة-${++seq}`) {
  const categoryId = createCategory({ name: `تصنيف-${++seq}` }, env.ctx)
  const id = createMaterial({
    sku: `SKU-${++seq}`, name, categoryId, unit: 'قطعة',
    currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact'
  } as never, env.ctx)
  return { id, name }
}

describe('DB-11 — legitimate material hard deletion', () => {
  it('permanently deletes an unused master row with exact-name confirmation', () => {
    const row = newMaterial('مادة غير مستخدمة')
    expect(materialFullDeletePreview(row.id)).toMatchObject({ dependencies: [], blockers: [] })
    expect(() => fullDeleteMaterial({ id: row.id, confirmation: 'خطأ' }, env.ctx)).toThrowError(/اكتب اسم المادة/)
    fullDeleteMaterial({ id: row.id, confirmation: row.name }, env.ctx)
    expect(getDatabase().select().from(materials).where(eq(materials.id, row.id)).get()).toBeUndefined()
    expect(listMaterials({}).some((material) => material.id === row.id)).toBe(false)
  })

  it('may remove current BOM configuration while preserving the product', () => {
    const target = newMaterial('مكون غير مستخدم')
    const other = newMaterial('مكون باق')
    const productId = createProduct({
      code: 'DB11-PRODUCT', name: 'منتج DB11',
      bom: [
        { materialId: target.id, qtyMicro: quantityFromDisplay(1), unit: 'قطعة' },
        { materialId: other.id, qtyMicro: quantityFromDisplay(2), unit: 'قطعة' }
      ]
    }, env.ctx)
    fullDeleteMaterial({ id: target.id, confirmation: target.name }, env.ctx)
    expect(getBom(productId).map((line) => line.materialId)).toEqual([other.id])
  })

  it('preserves a draft document snapshot while nulling its live master reference', () => {
    const target = newMaterial('مادة مسودة')
    const customerId = createCustomer({ name: 'عميل DB11' }, env.ctx)
    const quotation = createQuotation({
      customerId,
      lines: [{ lineKind: 'material', materialId: target.id, description: 'وصف تاريخي ثابت', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(50) }]
    }, env.ctx)
    fullDeleteMaterial({ id: target.id, confirmation: target.name }, env.ctx)
    expect(getDatabase().get<{ materialId: number | null; description: string }>(sql`
      SELECT material_id AS materialId, description FROM quotation_lines WHERE quotation_id = ${quotation.id}
    `)).toEqual({ materialId: null, description: 'وصف تاريخي ثابت' })
  })
})

describe('DB-11 — posted inventory and purchasing history', () => {
  it('refuses to erase opening-stock movements or their FIFO cost layers', () => {
    const target = newMaterial('مادة رصيد افتتاحي')
    recordOpeningStock({ materialId: target.id, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(10) }, env.ctx)
    const preview = materialFullDeletePreview(target.id)
    expect(preview.blockers.join(' ')).toMatch(/حركات مخزون أو طبقات تكلفة/)

    expect(() => fullDeleteMaterial({ id: target.id, confirmation: target.name }, env.ctx)).toThrowError(/تعذر حذف المادة بالكامل/)
    expect(availableQty(target.id)).toBe(quantityFromDisplay(5))
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM inventory_movements WHERE material_id = ${target.id}`)?.c).toBe(1)
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM fifo_layers WHERE material_id = ${target.id}`)?.c).toBe(1)
  })

  it('refuses to delete an exclusive purchase or rewrite a multi-line purchase total', () => {
    const supplierId = createSupplier({ name: 'مورد مواد DB11' }, env.ctx)
    const target = newMaterial('مادة مشتراة')
    const other = newMaterial('مادة أخرى')
    const purchase = createPurchase({
      supplierId,
      lines: [
        { materialId: target.id, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(10) },
        { materialId: other.id, qtyMicro: quantityFromDisplay(3), unitCostMicro: unitCostFromMajor(30) }
      ]
    }, env.ctx)
    const before = getPurchase(purchase.id)
    const supplierBefore = supplierBalances().find((row) => row.supplierId === supplierId)

    expect(materialFullDeletePreview(target.id).blockers.join(' ')).toMatch(/بنود شراء مُرحّلة/)
    expect(() => fullDeleteMaterial({ id: target.id, confirmation: target.name }, env.ctx)).toThrow()

    expect(getPurchase(purchase.id)).toEqual(before)
    expect(supplierBalances().find((row) => row.supplierId === supplierId)).toEqual(supplierBefore)
    expect(availableQty(target.id)).toBe(quantityFromDisplay(5))
    expect(availableQty(other.id)).toBe(quantityFromDisplay(3))
  })

  it('preserves a paid purchase, its payment, stock quantity and costing facts', () => {
    const supplierId = createSupplier({ name: 'مورد مدفوع DB11' }, env.ctx)
    const target = newMaterial('مادة مدفوعة')
    const purchase = createPurchase({
      supplierId,
      lines: [{ materialId: target.id, qtyMicro: quantityFromDisplay(4), unitCostMicro: unitCostFromMajor(10) }],
      paidNowMinor: moneyFromMajor(40)
    }, env.ctx)
    const before = getPurchase(purchase.id)

    expect(() => fullDeleteMaterial({ id: target.id, confirmation: target.name }, env.ctx)).toThrow()
    expect(getDatabase().select().from(purchases).where(eq(purchases.id, purchase.id)).get()).toBeDefined()
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM supplier_payments WHERE purchase_id = ${purchase.id}`)?.c).toBe(1)
    expect(getPurchase(purchase.id)).toEqual(before)
    expect(availableQty(target.id)).toBe(quantityFromDisplay(4))
  })

  it('does not begin mutation when blocked, even if a late-delete trigger is installed', () => {
    const target = newMaterial('مادة محمية DB11')
    recordOpeningStock({ materialId: target.id, qtyMicro: quantityFromDisplay(2), unitCostMicro: unitCostFromMajor(10) }, env.ctx)
    getRawConnection().exec("CREATE TRIGGER db11_block_material BEFORE DELETE ON materials BEGIN SELECT RAISE(ABORT, 'should not reach delete'); END")
    expect(() => fullDeleteMaterial({ id: target.id, confirmation: target.name }, env.ctx)).toThrowError(/حركات مخزون/)
    expect(getMaterial(target.id).id).toBe(target.id)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})
