import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import {
  categoryTree,
  createCategory,
  createChildMaterial,
  createColor,
  deleteCategory,
  deleteColor,
  getMaterial,
  listMaterials,
  listMaterialTypeOptions,
  materialFullDeletePreview,
  updateCategory,
  updateColor,
  updateMaterial
} from '@main/services/catalog/catalog.service'
import { catalogRepository } from '@main/repositories/catalog/catalog.repository'
import { closeDatabase, getDatabase, getRawConnection } from '@main/db/connection'
import { inventoryMovements } from '@main/db/schema/inventory.schema'
import { materialCategories, materials } from '@main/db/schema/catalog.schema'
import { stockLevels } from '@main/services/inventory/valuation.service'
import { registerIpcRouter } from '@main/ipc/router'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import { unitCostFromMajor } from '@shared/money/cost'

let env: TestEnv
beforeEach(() => {
  env = setupTestDatabase()
})
afterEach(() => env.cleanup())

function hierarchy(typeName = 'MDF 18') {
  const main = createCategory({ name: 'Wood' }, env.ctx)
  const family = createCategory({ name: 'MDF', parentId: main }, env.ctx)
  const type = createCategory({ name: typeName, parentId: family }, env.ctx)
  return { main, family, type }
}

function leaf(
  parentId: number,
  name: string,
  sku: string,
  options: { leafType?: 'raw' | 'colored'; colorId?: number; key?: string } = {}
) {
  return createChildMaterial(
    {
      parentId,
      clientRequestId: options.key ?? `request-${sku}`,
      leafType: options.leafType ?? 'raw',
      colorId: options.colorId ?? null,
      sku,
      name,
      unit: 'لوح',
      currentMarketPriceMicro: 0,
      pricingRule: 'exact'
    },
    env.ctx
  )
}

describe('four-level material classification', () => {
  it('attaches distinct material items directly to the selected base category', () => {
    const { main, family, type } = hierarchy()
    updateCategory(type, { showInRawMaterials: false }, env.ctx)
    expect(listMaterials({})).toEqual([])

    const raw = leaf(type, 'خام', 'MDF-18-RAW')
    expect(categoryTree()[0]?.children[0]?.children[0]?.visibilityMaterialId).toBe(raw.materialId)
    const colorId = createColor({ code: '405', name: 'Red' }, env.ctx)
    const colored = leaf(type, 'ignored free text', 'MDF-18-405', {
      leafType: 'colored',
      colorId
    })

    expect(
      listMaterials({}).map((row) => ({
        id: row.id,
        name: row.name,
        path: row.hierarchyPath,
        colorId: row.colorId
      }))
    ).toEqual([
      {
        id: raw.materialId,
        name: 'MDF 18',
        path: 'Wood ← MDF ← MDF 18',
        colorId: null
      },
      { id: colored.materialId, name: 'MDF 18', path: 'Wood ← MDF ← MDF 18', colorId }
    ])
    expect(listMaterials({}).map((row) => row.id)).not.toEqual(
      expect.arrayContaining([main, family, type])
    )
    expect(getDatabase().select().from(inventoryMovements).all()).toEqual([])
    expect(stockLevels().every((row) => row.qtyMicro === 0)).toBe(true)
    expect(availableQty(raw.materialId)).toBe(0)
    expect(availableQty(colored.materialId)).toBe(0)

    const root = categoryTree()[0]!
    expect(root).toMatchObject({ id: main, nodeKind: 'main_category', rawMaterialId: null })
    expect(root.children[0]).toMatchObject({
      id: family,
      nodeKind: 'material_family',
      rawMaterialId: null
    })
    expect(root.children[0]?.children[0]).toMatchObject({
      id: type,
      nodeKind: 'material_type',
      rawMaterialId: null,
      visibilityMaterialId: null,
      materialCount: 2
    })
    expect(root.children[0]?.children[0]?.children).toEqual([])
    expect(raw.categoryId).toBe(type)
    expect(colored.categoryId).toBe(type)
    expect(raw.materialId).not.toBe(colored.materialId)
    expect(root.children[0]?.children[0]?.showInRawMaterials).toBe(true)
  })

  it('creates same-named raw leaves under different material types as independent stock items', () => {
    const first = hierarchy('MDF 18')
    const secondType = createCategory({ name: 'MDF 6', parentId: first.family }, env.ctx)
    const raw18 = leaf(first.type, 'خام', 'MDF-18-RAW')
    const raw6 = leaf(secondType, 'خام', 'MDF-6-RAW')
    const redColor = createColor({ code: '405', name: 'Red' }, env.ctx)
    const walnutColor = createColor({ code: '410', name: 'Walnut' }, env.ctx)
    const red = leaf(first.type, 'ignored', 'MDF-18-405', {
      leafType: 'colored',
      colorId: redColor
    })
    const walnut = leaf(first.type, 'ignored', 'MDF-18-410', {
      leafType: 'colored',
      colorId: walnutColor
    })
    updateCategory(first.type, { showInRawMaterials: true }, env.ctx)
    updateCategory(secondType, { showInRawMaterials: true }, env.ctx)
    const supplierId = createSupplier({ name: 'Supplier' }, env.ctx)
    createPurchase(
      {
        supplierId,
        lines: [
          {
            materialId: raw18.materialId,
            qtyMicro: quantityFromDisplay(20),
            unitCostMicro: unitCostFromMajor(5)
          },
          {
            materialId: raw6.materialId,
            qtyMicro: quantityFromDisplay(8),
            unitCostMicro: unitCostFromMajor(5)
          },
          {
            materialId: red.materialId,
            qtyMicro: quantityFromDisplay(8),
            unitCostMicro: unitCostFromMajor(5)
          },
          {
            materialId: walnut.materialId,
            qtyMicro: quantityFromDisplay(13),
            unitCostMicro: unitCostFromMajor(5)
          }
        ]
      },
      env.ctx
    )

    expect(raw18.materialId).not.toBe(raw6.materialId)
    expect(availableQty(raw18.materialId)).toBe(quantityFromDisplay(20))
    expect(availableQty(raw6.materialId)).toBe(quantityFromDisplay(8))
    expect(availableQty(red.materialId)).toBe(quantityFromDisplay(8))
    expect(availableQty(walnut.materialId)).toBe(quantityFromDisplay(13))
    expect(getMaterial(raw6.materialId).hierarchyPath).toBe('Wood ← MDF ← MDF 6')
  })

  it('derives paths after parent rename/move without changing material ids or stock history', () => {
    const { family, type } = hierarchy()
    const raw = leaf(type, 'خام', 'MDF-18-RAW')
    const beforeStock = stockLevels()
    updateCategory(family, { name: 'MDF ألواح' }, env.ctx)
    expect(getMaterial(raw.materialId)).toMatchObject({
      id: raw.materialId,
      hierarchyPath: 'Wood ← MDF ألواح ← MDF 18'
    })

    const otherMain = createCategory({ name: 'Engineered' }, env.ctx)
    const otherFamily = createCategory({ name: 'Boards', parentId: otherMain }, env.ctx)
    updateCategory(type, { parentId: otherFamily }, env.ctx)
    expect(getMaterial(raw.materialId).hierarchyPath).toBe('Engineered ← Boards ← MDF 18')
    expect(stockLevels()).toEqual(beforeStock)
    expect(getDatabase().select().from(inventoryMovements).all()).toEqual([])
  })

  it('keeps color identity separate from base material naming', () => {
    const { type } = hierarchy()
    const colorId = createColor({ code: '410', name: 'Walnut' }, env.ctx)
    const item = leaf(type, 'not authoritative', 'MDF-18-410', { leafType: 'colored', colorId })
    updateColor(colorId, { code: '411', name: 'Dark Walnut' }, env.ctx)

    expect(getMaterial(item.materialId)).toMatchObject({
      id: item.materialId,
      name: 'MDF 18',
      colorId,
      hierarchyPath: 'Wood ← MDF ← MDF 18'
    })
    expect(categoryTree()[0]?.children[0]?.children[0]?.children).toEqual([])
    expect(deleteColor(colorId, env.ctx)).toEqual({ deleted: false, archived: true })
    expect(getMaterial(item.materialId).colorId).toBe(colorId)
  })

  it('prevents duplicate requests and rolls back when material insertion fails', () => {
    const { type } = hierarchy()
    const first = leaf(type, 'خام', 'MDF-18-RAW', { key: 'stable-request-1' })
    expect(leaf(type, 'خام', 'MDF-18-RAW', { key: 'stable-request-1' })).toEqual(first)
    expect(getDatabase().select().from(materials).all()).toHaveLength(1)
    expect(() => leaf(type, 'ignored', 'MDF-18-RAW', { key: 'different-request' })).toThrow()

    const nodesBefore = getDatabase().select().from(materialCategories).all()
    const auditBefore = getRawConnection().prepare('SELECT COUNT(*) AS c FROM audit_log').get() as {
      c: number
    }
    const failure = vi.spyOn(catalogRepository, 'insertMaterial').mockImplementationOnce(() => {
      throw new Error('forced material insert failure')
    })
    expect(() => leaf(type, 'اختبار', 'ROLLBACK-LEAF')).toThrow(/forced material/)
    failure.mockRestore()
    expect(getDatabase().select().from(materialCategories).all()).toEqual(nodesBefore)
    expect(
      (getRawConnection().prepare('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c
    ).toBe(auditBefore.c)
  })

  it('rolls back category visibility when material audit fails', () => {
    const { type } = hierarchy()
    updateCategory(type, { showInRawMaterials: false }, env.ctx)
    expect(categoryTree()[0]?.children[0]?.children[0]?.showInRawMaterials).toBe(false)
    getRawConnection().exec("CREATE TRIGGER fail_new_item_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'catalog.material.create' BEGIN SELECT RAISE(FAIL, 'audit failure'); END")
    expect(() => leaf(type, 'ignored', 'MDF-FAIL')).toThrow()
    expect(categoryTree()[0]?.children[0]?.children[0]?.showInRawMaterials).toBe(false)
    expect(listMaterials({})).toEqual([])
  })

  it('searches path in one batched tree load and selectors expose actual materials only', () => {
    const { main, family, type } = hierarchy()
    const raw = leaf(type, 'خام', 'MDF-18-RAW')
    const categoryReads = vi.spyOn(catalogRepository, 'listCategories')
    expect(listMaterials({ search: 'MDF 18' }).map((row) => row.id)).toEqual([raw.materialId])
    expect(categoryReads).toHaveBeenCalledTimes(1)
    categoryReads.mockRestore()

    const options = listMaterialTypeOptions()
    expect(options).toEqual([
      expect.objectContaining({
        id: raw.materialId,
        hierarchyPath: 'Wood ← MDF ← MDF 18'
      })
    ])
    expect(options.map((row) => row.id)).not.toEqual(expect.arrayContaining([main, family, type]))
  })

  it('preserves identity across restart and reuses existing deletion protections', () => {
    const { main, type } = hierarchy()
    const raw = leaf(type, 'خام', 'MDF-18-RAW')
    expect(() => deleteCategory(main, env.ctx)).toThrow(/تصنيفات فرعية/)
    expect(materialFullDeletePreview(raw.materialId).blockers).toEqual([])
    closeDatabase()
    expect(getMaterial(raw.materialId)).toMatchObject({
      id: raw.materialId,
      hierarchyPath: 'Wood ← MDF ← MDF 18'
    })
  })

  it('validates level, color, and direct IPC authority server-side', async () => {
    const { main, type } = hierarchy()
    expect(
      getDatabase()
        .select()
        .from(materialCategories)
        .all()
        .every((node) => !node.isAccessory)
    ).toBe(true)
    expect(() => leaf(main, 'Invalid', 'INVALID-PARENT')).toThrow(/نوع المادة/)
    expect(() => leaf(type, 'Missing color', 'MISSING-COLOR', { leafType: 'colored' })).toThrow(
      /اختر لوناً/
    )
    expect(() =>
      leaf(type, 'Colored', 'INVALID-COLOR', { leafType: 'colored', colorId: 9999 })
    ).toThrow(/غير موجود/)
    const inactiveColor = createColor({ code: 'OLD', name: 'Inactive' }, env.ctx)
    updateColor(inactiveColor, { active: false }, env.ctx)
    const colorCount = getRawConnection()
      .prepare('SELECT COUNT(*) AS c FROM color_finish_catalog')
      .get() as { c: number }
    expect(() =>
      leaf(type, 'Inactive', 'INACTIVE-COLOR', { leafType: 'colored', colorId: inactiveColor })
    ).toThrow(/غير مفعّل/)
    expect(
      (
        getRawConnection().prepare('SELECT COUNT(*) AS c FROM color_finish_catalog').get() as {
          c: number
        }
      ).c
    ).toBe(colorCount.c)
    const nested = createCategory({ name: 'Fourth level', parentId: type }, env.ctx)
    expect(categoryTree()[0]?.children[0]?.children[0]?.children.find((node) => node.id === nested))
      .toMatchObject({ nodeKind: 'material_type', depth: 3 })

    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
    >()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((
      channel: string,
      handler: never
    ) => {
      handlers.set(channel, handler)
    }) as never)
    registerIpcRouter()
    spy.mockRestore()
    const event = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent
    const badLeaf = (await handlers.get(IPC_CHANNELS.categories.createChildMaterial)!(event, {
      parentId: main,
      clientRequestId: 'ipc-invalid-level',
      leafType: 'raw',
      colorId: null,
      nodeKind: 'inventory_leaf',
      sku: 'IPC-X',
      name: 'X',
      unit: 'لوح',
      currentMarketPriceMicro: 0,
      pricingRule: 'exact'
    })) as { ok: boolean; error?: { code: string } }
    expect(badLeaf).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })

    const direct = (await handlers.get(IPC_CHANNELS.materials.create)!(event, {
      sku: 'DIRECT-X',
      name: 'Direct',
      categoryId: type,
      unit: 'لوح',
      currentMarketPriceMicro: 0,
      pricingRule: 'exact'
    })) as { ok: boolean; data?: { id: number } }
    expect(direct).toMatchObject({ ok: true, data: { id: expect.any(Number) } })
  })

  it('renames raw leaves without changing their material identity', () => {
    const { type } = hierarchy()
    const raw = leaf(type, 'خام', 'MDF-18-RAW')
    updateMaterial(raw.materialId, { name: 'خام غير ملوّن' }, env.ctx)
    expect(getMaterial(raw.materialId)).toMatchObject({
      id: raw.materialId,
      name: 'خام غير ملوّن',
      hierarchyPath: 'Wood ← MDF ← MDF 18 ← خام غير ملوّن'
    })
  })
})
