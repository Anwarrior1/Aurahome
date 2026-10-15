import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import {
  categoryDeletePreview, categoryTree, createCategory, createColor, createMaterial,
  deleteCategory, deleteMaterialDefinition, getMaterial, listMaterials,
  materialDefinitionDeletePreview
} from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { consumeMaterial } from '@main/services/inventory/inventory.service'
import { inventoryRepository } from '@main/repositories/inventory/inventory.repository'
import { createProduct } from '@main/services/products/products.service'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const details = (sku: string, colorId?: number) => ({
  sku, unit: 'لوح', currentMarketPriceMicro: 0, pricingRule: 'exact' as const,
  ...(colorId ? { colorId } : {})
})
const count = (table: 'materials' | 'material_categories' | 'inventory_movements' | 'purchase_lines') =>
  (getRawConnection().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c

function owned(name = 'PVC', colorId?: number) {
  const categoryId = createCategory({ name, showInRawMaterials: true,
    materialDetails: details(`${name}-001`, colorId) }, env.ctx)
  const material = listMaterials({}).find((row) => row.categoryId === categoryId)!
  return { categoryId, material }
}

describe('Material Categories own safe deletion', () => {
  it('deletes an empty category, while a second attempt reports it missing', () => {
    const id = createCategory({ name: 'Empty', showInRawMaterials: false }, env.ctx)
    expect(categoryDeletePreview(id)).toMatchObject({ blocker: null, ownedMaterialId: null })
    deleteCategory(id, env.ctx)
    expect(categoryTree()).toEqual([])
    expect(() => deleteCategory(id, env.ctx)).toThrow(/غير موجود/)
  })

  it.each(['raw', 'colored'] as const)('deletes a zero-stock %s visibility material with its root, retaining the catalog color', (kind) => {
    const colorId = kind === 'colored' ? createColor({ code: 'W', name: 'أبيض' }, env.ctx) : undefined
    const { categoryId, material } = owned(kind === 'raw' ? 'PVC' : 'MDF', colorId)
    expect(material.creationKey).toBe(`category-visibility:${categoryId}:owned`)
    expect(inventoryRepository.availableQtyMicro(material.id)).toBe(0)
    expect(categoryDeletePreview(categoryId)).toMatchObject({ blocker: null, ownedMaterialId: material.id })
    deleteCategory(categoryId, env.ctx)
    expect([count('materials'), count('material_categories'), count('inventory_movements')]).toEqual([0, 0, 0])
    expect(listMaterials({})).toEqual([])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    if (colorId) expect(getRawConnection().prepare('SELECT id FROM color_finish_catalog WHERE id = ?').get(colorId)).toEqual({ id: colorId })
  })

  it('keeps child categories and manually created material items intact', () => {
    const parent = createCategory({ name: 'Wood', showInRawMaterials: false }, env.ctx)
    const child = createCategory({ name: 'MDF', parentId: parent }, env.ctx)
    expect(categoryDeletePreview(parent)).toMatchObject({ blocker: 'children', message: expect.stringMatching(/تصنيفات فرعية/) })
    expect(() => deleteCategory(parent, env.ctx)).toThrow(/تصنيفات فرعية/)
    const manual = createMaterial({ ...details('MDF-1'), name: 'MDF', categoryId: child }, env.ctx)
    expect(categoryDeletePreview(child)).toMatchObject({ blocker: 'materials', message: expect.stringMatching(/مواد تابعة/) })
    expect(() => deleteCategory(child, env.ctx)).toThrow(/مواد تابعة/)
    expect(categoryTree()[0].children[0].id).toBe(child)
    expect(getMaterial(manual).id).toBe(manual)
  })

  it('blocks an older visibility key because it also marked adopted manual rows', () => {
    const { categoryId, material } = owned()
    getRawConnection().prepare('UPDATE materials SET creation_key = ? WHERE id = ?').run(`category-visibility:${categoryId}`, material.id)
    expect(categoryDeletePreview(categoryId)).toMatchObject({ blocker: 'ambiguous', message: expect.stringMatching(/ملكيتها/) })
    expect(() => deleteCategory(categoryId, env.ctx)).toThrow(/ملكيتها/)
    expect(count('materials')).toBe(1)
    expect(count('material_categories')).toBe(1)
  })

  it('blocks positive and negative nonzero balances before history checks', () => {
    const { categoryId, material } = owned()
    const supplier = createSupplier({ name: 'Supplier' }, env.ctx)
    createPurchase({ supplierId: supplier, lines: [{ materialId: material.id, qtyMicro: 1_000_000, unitCostMicro: 1_000_000 }] }, env.ctx)
    expect(categoryDeletePreview(categoryId)).toMatchObject({ blocker: 'stock' })
    expect(() => deleteCategory(categoryId, env.ctx)).toThrow(/رصيد غير صفري/)
    getRawConnection().prepare('UPDATE fifo_layers SET qty_remaining_micro = -1000000 WHERE material_id = ?').run(material.id)
    expect(categoryDeletePreview(categoryId)).toMatchObject({ blocker: 'stock' })
    expect(() => deleteCategory(categoryId, env.ctx)).toThrow(/رصيد غير صفري/)
    expect(count('purchase_lines')).toBe(1)
  })

  it('blocks zero stock when legitimate purchase and consumption history remains', () => {
    const { categoryId, material } = owned()
    const supplier = createSupplier({ name: 'Supplier' }, env.ctx)
    createPurchase({ supplierId: supplier, lines: [{ materialId: material.id, qtyMicro: 1_000_000, unitCostMicro: 1_000_000 }] }, env.ctx)
    consumeMaterial({ materialId: material.id, physicalQtyMicro: 1_000_000, ctx: env.ctx })
    expect(inventoryRepository.availableQtyMicro(material.id)).toBe(0)
    expect(categoryDeletePreview(categoryId)).toMatchObject({ blocker: 'history', message: expect.stringMatching(/فواتير أو حركات/) })
    expect(() => deleteCategory(categoryId, env.ctx)).toThrow(/فواتير أو حركات/)
    expect([count('materials'), count('material_categories'), count('purchase_lines')]).toEqual([1, 1, 1])
  })

  it('blocks a legacy Color Catalog foreign key without removing that association', () => {
    const { categoryId, material } = owned()
    const colorId = createColor({ code: 'W', name: 'أبيض' }, env.ctx)
    getRawConnection().prepare('UPDATE color_finish_catalog SET related_material_id = ? WHERE id = ?').run(material.id, colorId)
    expect(categoryDeletePreview(categoryId)).toMatchObject({ blocker: 'history' })
    expect(() => deleteCategory(categoryId, env.ctx)).toThrow(/سجلات مرتبطة/)
    expect(getRawConnection().prepare('SELECT related_material_id FROM color_finish_catalog WHERE id = ?').get(colorId)).toEqual({ related_material_id: material.id })
  })

  it('rolls back material and category deletion if the audit write fails', () => {
    const { categoryId, material } = owned()
    getRawConnection().exec("CREATE TEMP TRIGGER fail_category_delete_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'catalog.category.delete' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
    expect(() => deleteCategory(categoryId, env.ctx)).toThrow(/audit unavailable/)
    expect(getMaterial(material.id).id).toBe(material.id)
    expect(categoryTree()[0].id).toBe(categoryId)
  })

  it('deletes an unused manual item from Categories while retaining its category', () => {
    const categoryId = createCategory({ name: 'PVC' }, env.ctx)
    const id = createMaterial({ ...details('PVC-M'), name: 'PVC', categoryId }, env.ctx)
    expect(materialDefinitionDeletePreview(id)).toMatchObject({ blocker: null })
    expect(() => deleteMaterialDefinition({ id, confirmation: 'wrong' }, env.ctx)).toThrow(/اكتب اسم المادة/)
    deleteMaterialDefinition({ id, confirmation: 'PVC' }, env.ctx)
    expect(categoryTree()[0].id).toBe(categoryId)
    expect(count('materials')).toBe(0)
  })

  it('preserves a manual item referenced by a product BOM', () => {
    const categoryId = createCategory({ name: 'PVC' }, env.ctx)
    const id = createMaterial({ ...details('PVC-BOM'), name: 'PVC', categoryId }, env.ctx)
    createProduct({ code: 'P-1', name: 'Product', bom: [{ materialId: id, qtyMicro: 1_000_000, unit: 'لوح' }] }, env.ctx)
    expect(materialDefinitionDeletePreview(id)).toMatchObject({ blocker: 'history' })
    expect(() => deleteMaterialDefinition({ id, confirmation: 'PVC' }, env.ctx)).toThrow(/سجلات مرتبطة/)
    expect(getMaterial(id).id).toBe(id)
  })
})
