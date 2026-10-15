import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { closeDatabase, getRawConnection, setDatabasePath } from '@main/db/connection'
import { registerIpcRouter } from '@main/ipc/router'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { createCategory, createChildMaterial, createMaterial, createColor, updateColor, categoryTree, getMaterial, listMaterials, updateCategory, updateMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { adjustStock, consumeMaterial, recordRemainder } from '@main/services/inventory/inventory.service'
import { inventoryRepository } from '@main/repositories/inventory/inventory.repository'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const details = (sku: string) => ({ sku, unit: 'قطعة', currentMarketPriceMicro: 0, pricingRule: 'exact' as const })
const count = (table: 'fifo_layers' | 'inventory_movements' | 'purchase_lines') =>
  (getRawConnection().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const bound = (categoryId: number) => listMaterials({}).find((material) => material.creationKey?.startsWith(`category-visibility:${categoryId}`))!

describe('category controlled raw material lifecycle', () => {
  it('creates a colored PVC material directly on a standalone root with zero stock and a persistent catalog color', () => {
    const white = createColor({ code: 'WHT', name: 'أبيض' }, env.ctx)
    const pvc = createCategory({ name: 'PVC', showInRawMaterials: true, materialDetails: {
      ...details('PVC-001'), name: 'PVC', unit: 'لوح', colorId: white
    } }, env.ctx)
    const row = bound(pvc)
    expect(row).toMatchObject({ categoryId: pvc, name: 'PVC', colorId: white, sku: 'PVC-001', active: true })
    expect(categoryTree()).toMatchObject([{ id: pvc, name: 'PVC', children: [],
      visibilityMaterialId: row.id, materialColorId: white }])
    expect(inventoryRepository.availableQtyMicro(row.id)).toBe(0)
    expect([count('fifo_layers'), count('inventory_movements'), count('purchase_lines')]).toEqual([0, 0, 0])
    updateCategory(pvc, { showInRawMaterials: true }, env.ctx)
    expect(listMaterials({ activeOnly: true }).filter((material) => material.categoryId === pvc)).toHaveLength(1)
    closeDatabase()
    expect(getMaterial(row.id)).toMatchObject({ categoryId: pvc, colorId: white, name: 'PVC' })
    expect(categoryTree()[0].materialColorId).toBe(white)
  })

  it('validates catalog colors and preserves color identity during safe edits and catalog renames', () => {
    const pvc = createCategory({ name: 'PVC', showInRawMaterials: false }, env.ctx)
    expect(() => updateCategory(pvc, { showInRawMaterials: true, materialDetails: {
      ...details('PVC-BAD'), colorId: 999999
    } }, env.ctx)).toThrow(/غير موجود/)
    expect(categoryTree()[0].showInRawMaterials).toBe(false)
    const white = createColor({ code: 'WHT', name: 'أبيض' }, env.ctx)
    const red = createColor({ code: 'RED', name: 'أحمر' }, env.ctx)
    updateCategory(pvc, { showInRawMaterials: true, materialDetails: {
      ...details('PVC-001'), colorId: white
    } }, env.ctx)
    const row = bound(pvc)
    updateMaterial(row.id, { colorId: red }, env.ctx)
    expect(getMaterial(row.id)).toMatchObject({ id: row.id, colorId: red, name: 'PVC' })
    expect(categoryTree()[0].materialColorId).toBe(red)
    updateColor(red, { name: 'أحمر غامق' }, env.ctx)
    expect(getMaterial(row.id)).toMatchObject({ id: row.id, colorId: red, name: 'PVC' })
    updateMaterial(row.id, { colorId: null }, env.ctx)
    expect(getMaterial(row.id).colorId).toBeNull()
    expect(categoryTree()[0].materialColorId).toBeNull()
    expect(categoryTree()[0].children).toEqual([])
  })

  it('creates colored materials at intermediate and deeper levels without new inventory leaves', () => {
    const white = createColor({ code: 'WHT', name: 'أبيض' }, env.ctx)
    const root = createCategory({ name: 'Wood', showInRawMaterials: false }, env.ctx)
    const second = createCategory({ name: 'MDF', parentId: root, showInRawMaterials: true,
      materialDetails: { ...details('MDF-WHT'), colorId: white } }, env.ctx)
    const third = createCategory({ name: '18', parentId: second, showInRawMaterials: false }, env.ctx)
    const fourth = createCategory({ name: 'Colored', parentId: third, showInRawMaterials: true,
      materialDetails: { ...details('18-WHT'), colorId: white } }, env.ctx)
    expect([bound(second).colorId, bound(fourth).colorId]).toEqual([white, white])
    expect([bound(second).categoryId, bound(fourth).categoryId]).toEqual([second, fourth])
    expect(categoryTree()[0].children[0]).toMatchObject({ id: second, materialColorId: white })
    expect(categoryTree()[0].children[0].children[0].children).toMatchObject([
      { id: fourth, children: [], materialColorId: white }
    ])
    expect(count('inventory_movements')).toBe(0)
  })

  it('blocks changing type or color after purchase history exists without changing stock or references', () => {
    const white = createColor({ code: 'WHT', name: 'أبيض' }, env.ctx)
    const pvc = createCategory({ name: 'PVC', showInRawMaterials: true, materialDetails: {
      ...details('PVC-001'), colorId: white
    } }, env.ctx)
    const row = bound(pvc)
    const supplierId = createSupplier({ name: 'supplier' }, env.ctx)
    createPurchase({ supplierId, lines: [{ materialId: row.id, qtyMicro: 1_000_000, unitCostMicro: 1_000_000 }] }, env.ctx)
    expect(() => updateMaterial(row.id, { colorId: null }, env.ctx)).toThrow(/تاريخية/)
    expect(getMaterial(row.id).colorId).toBe(white)
    expect(inventoryRepository.availableQtyMicro(row.id)).toBe(1_000_000)
    expect(count('purchase_lines')).toBe(1)
    expect(() => updateCategory(pvc, { showInRawMaterials: false }, env.ctx)).toThrow(/رصيد/)
  })
  it('creates a moop row with zero stock and no inventory movement, then reuses it on every save and reopen', () => {
    expect(() => createCategory({ name: 'incomplete', showInRawMaterials: true }, env.ctx)).toThrow(/كود المادة/)
    expect(categoryTree()).toEqual([])
    const moop = createCategory({ name: 'moop', showInRawMaterials: false }, env.ctx)
    expect(() => updateCategory(moop, { showInRawMaterials: true }, env.ctx)).toThrow(/كود المادة/)
    expect(categoryTree()[0].showInRawMaterials).toBe(false)
    updateCategory(moop, { showInRawMaterials: true, materialDetails: details('MOOP') }, env.ctx)
    const material = bound(moop)
    expect(material).toMatchObject({ name: 'moop', sku: 'MOOP', unit: 'قطعة', categoryId: moop, active: true })
    expect(inventoryRepository.availableQtyMicro(material.id)).toBe(0)
    expect([count('fifo_layers'), count('inventory_movements'), count('purchase_lines')]).toEqual([0, 0, 0])
    expect(categoryTree()[0].visibilityMaterialId).toBe(material.id)
    expect(categoryTree()[0].materialColorId).toBeNull()
    updateCategory(moop, { showInRawMaterials: true }, env.ctx)
    updateCategory(moop, { showInRawMaterials: false }, env.ctx)
    expect(getMaterial(material.id).active).toBe(false)
    expect(listMaterials({ activeOnly: true })).not.toContainEqual(expect.objectContaining({ id: material.id }))
    updateCategory(moop, { showInRawMaterials: true }, env.ctx)
    expect(bound(moop).id).toBe(material.id)
    expect(listMaterials({}).filter((row) => row.categoryId === moop)).toHaveLength(1)
    expect(count('inventory_movements')).toBe(0)
    const dbPath = join(env.dir, readdirSync(env.dir).find((name) => name.endsWith('.db'))!)
    closeDatabase()
    setDatabasePath(dbPath)
    expect(getMaterial(material.id)).toMatchObject({ active: true, categoryId: moop, creationKey: `category-visibility:${moop}:owned` })
  })

  it('persists the full shared material payload and keeps a custom material name after category edits', () => {
    const moop = createCategory({ name: 'moop', showInRawMaterials: false }, env.ctx)
    updateCategory(moop, { showInRawMaterials: true, materialDetails: {
      ...details('MOOP-FULL'), name: 'لوح خاص', purchaseUnit: 'علبة', purchaseUnitFactorMicro: 12_000_000,
      tracksDimensions: true, dimensions: '120×240', thickness: '18',
      reorderLevelMicro: 2_000_000, notes: 'اختبار', currentMarketPriceMicro: 15_000_000
    } }, env.ctx)
    const material = bound(moop)
    expect(getMaterial(material.id)).toMatchObject({
      name: 'لوح خاص', purchaseUnit: 'علبة', purchaseUnitFactorMicro: 12_000_000,
      tracksDimensions: true, dimensions: '120×240', thickness: '18',
      reorderLevelMicro: 2_000_000, notes: 'اختبار', currentMarketPriceMicro: 15_000_000
    })
    updateCategory(moop, { name: 'moop renamed', showInRawMaterials: true }, env.ctx)
    expect(getMaterial(material.id)).toMatchObject({ name: 'لوح خاص', categoryId: moop })
    expect(listMaterials({}).filter((row) => row.categoryId === moop)).toHaveLength(1)
  })

  it('rolls back the category and material together if the material audit write fails', () => {
    getRawConnection().exec("CREATE TEMP TRIGGER fail_material_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'catalog.material.create' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
    expect(() => createCategory({ name: 'moop', showInRawMaterials: true, materialDetails: details('MOOP') }, env.ctx)).toThrow()
    expect(categoryTree()).toEqual([])
    expect(listMaterials({})).toEqual([])
    expect(count('inventory_movements')).toBe(0)
  })

  it('works at every hierarchy depth, including a root with children', () => {
    const root = createCategory({ name: 'Wood', showInRawMaterials: true, materialDetails: details('WOOD') }, env.ctx)
    const second = createCategory({ name: 'MDF', parentId: root, showInRawMaterials: true, materialDetails: details('MDF') }, env.ctx)
    const third = createCategory({ name: '18', parentId: second, showInRawMaterials: true, materialDetails: details('18') }, env.ctx)
    const fourth = createCategory({ name: 'Raw', parentId: third, showInRawMaterials: true, materialDetails: details('RAW') }, env.ctx)
    for (const id of [root, second, third, fourth]) expect(bound(id).active).toBe(true)
    expect(categoryTree()[0].children[0].children[0].children[0].id).toBe(fourth)
  })

  it('reuses an existing category material and prevents stock receipts after hiding it', () => {
    const root = createCategory({ name: 'Wood' }, env.ctx)
    const family = createCategory({ name: 'MDF', parentId: root }, env.ctx)
    const type = createCategory({ name: '18', parentId: family }, env.ctx)
    const leaf = createChildMaterial({ parentId: type, clientRequestId: 'leaf-request-1', name: 'Raw', sku: 'RAW', unit: 'لوح', currentMarketPriceMicro: 0, pricingRule: 'exact' }, env.ctx)
    updateCategory(leaf.categoryId, { showInRawMaterials: true }, env.ctx)
    expect(listMaterials({}).filter((row) => row.categoryId === leaf.categoryId)).toHaveLength(1)
    updateCategory(leaf.categoryId, { showInRawMaterials: false }, env.ctx)
    expect(getMaterial(leaf.materialId).active).toBe(true)
    const supplierId = createSupplier({ name: 'supplier' }, env.ctx)
    expect(() => createPurchase({ supplierId, lines: [{ materialId: leaf.materialId, qtyMicro: 1_000_000, unitCostMicro: 1_000_000 }] }, env.ctx)).toThrow(/مخفية/)
  })

  it('adopts an existing matching material instead of creating a duplicate', () => {
    const moop = createCategory({ name: 'moop' }, env.ctx)
    const materialId = createMaterial({ ...details('EXISTING-MOOP'), name: 'moop', categoryId: moop }, env.ctx)
    updateCategory(moop, { showInRawMaterials: true }, env.ctx)
    expect(bound(moop).id).toBe(materialId)
    expect(listMaterials({}).filter((row) => row.categoryId === moop)).toHaveLength(1)
    updateCategory(moop, { showInRawMaterials: false }, env.ctx)
    expect(() => updateMaterial(materialId, { active: true }, env.ctx)).toThrow(/فعّل ظهور التصنيف/)
    updateCategory(moop, { showInRawMaterials: true }, env.ctx)
    expect(bound(moop).id).toBe(materialId)
  })

  it('rejects later purchase and manual stock receipts while the generated material is hidden', () => {
    const moop = createCategory({ name: 'moop', showInRawMaterials: true, materialDetails: details('MOOP') }, env.ctx)
    const material = bound(moop)
    updateCategory(moop, { showInRawMaterials: false }, env.ctx)
    const supplierId = createSupplier({ name: 'supplier' }, env.ctx)
    expect(() => createPurchase({ supplierId, lines: [{ materialId: material.id, qtyMicro: 1_000_000, unitCostMicro: 1_000_000 }] }, env.ctx)).toThrow(/مخفية/)
    expect(() => adjustStock({ materialId: material.id, qtyMicro: 1_000_000, direction: 'in', reason: 'test', ctx: env.ctx })).toThrow(/مخفية/)
    expect(() => recordRemainder({ materialId: material.id, sizeMicro: 1_000_000, ctx: env.ctx })).toThrow(/مخفية/)
    expect([count('fifo_layers'), count('inventory_movements'), count('purchase_lines')]).toEqual([0, 0, 0])
  })

  it('treats a reusable offcut as stock even when FIFO balance is zero', () => {
    const moop = createCategory({ name: 'moop', showInRawMaterials: true, materialDetails: details('MOOP') }, env.ctx)
    const material = bound(moop)
    recordRemainder({ materialId: material.id, sizeMicro: 500_000, ctx: env.ctx })
    expect(inventoryRepository.availableQtyMicro(material.id)).toBe(0)
    expect(() => updateCategory(moop, { showInRawMaterials: false }, env.ctx)).toThrow(/رصيد بالمخزون/)
    expect(categoryTree()[0].showInRawMaterials).toBe(true)
  })

  it('blocks disabling after a real purchase, then permits it after legitimate consumption and preserves history', () => {
    const moop = createCategory({ name: 'moop', showInRawMaterials: true, materialDetails: details('MOOP') }, env.ctx)
    const material = bound(moop)
    const supplierId = createSupplier({ name: 'supplier' }, env.ctx)
    const purchase = createPurchase({ supplierId, lines: [{ materialId: material.id, qtyMicro: 2_000_000, unitCostMicro: 1_000_000 }] }, env.ctx)
    const before = [count('fifo_layers'), count('inventory_movements'), count('purchase_lines')]
    expect(() => updateCategory(moop, { showInRawMaterials: false }, env.ctx))
      .toThrow('لا يمكن إيقاف ظهور هذا التصنيف في مواد الخام لوجود رصيد بالمخزون. يجب أن يصبح الرصيد صفرًا أولًا.')
    expect(categoryTree()[0].showInRawMaterials).toBe(true)
    expect(getMaterial(material.id).active).toBe(true)
    expect([count('fifo_layers'), count('inventory_movements'), count('purchase_lines')]).toEqual(before)
    consumeMaterial({ materialId: material.id, physicalQtyMicro: 2_000_000, ctx: env.ctx })
    expect(inventoryRepository.availableQtyMicro(material.id)).toBe(0)
    updateCategory(moop, { showInRawMaterials: false }, env.ctx)
    expect(getMaterial(material.id).active).toBe(false)
    expect(count('purchase_lines')).toBe(1)
    expect(getRawConnection().prepare('SELECT material_id FROM purchase_lines WHERE purchase_id = ?').get(purchase.id)).toEqual({ material_id: material.id })
    expect(count('inventory_movements')).toBe(2)
    updateCategory(moop, { showInRawMaterials: true }, env.ctx)
    expect(bound(moop).id).toBe(material.id)
  })

  it('checks each associated material and FIFO batch instead of allowing signed balances to cancel', () => {
    const moop = createCategory({ name: 'moop', showInRawMaterials: true, materialDetails: details('MOOP') }, env.ctx)
    const material = bound(moop)
    const otherId = Number(getRawConnection().prepare("INSERT INTO materials (sku, name, category_id, unit) VALUES ('OTHER', 'Other', ?, 'قطعة')").run(moop).lastInsertRowid)
    const insertLayer = (materialId: number, qty: number, seq: number) => getRawConnection().prepare(
      "INSERT INTO fifo_layers (material_id, source_kind, qty_received_micro, qty_remaining_micro, unit_cost_micro, received_at, seq) VALUES (?, 'test-legacy', ?, ?, 0, '2026-01-01', ?)"
    ).run(materialId, qty, qty, seq)
    insertLayer(material.id, 1_000_000, 1)
    insertLayer(otherId, -1_000_000, 1)
    expect(() => updateCategory(moop, { showInRawMaterials: false }, env.ctx)).toThrow(/رصيد بالمخزون/)
    getRawConnection().prepare('UPDATE fifo_layers SET qty_remaining_micro = 0 WHERE material_id = ?').run(material.id)
    expect(() => updateCategory(moop, { showInRawMaterials: false }, env.ctx)).toThrow(/رصيد بالمخزون/)
    getRawConnection().prepare('UPDATE fifo_layers SET qty_remaining_micro = 1000000 WHERE material_id = ?').run(material.id)
    insertLayer(material.id, -1_000_000, 2)
    expect(inventoryRepository.availableQtyMicro(material.id)).toBe(0)
    expect(() => updateCategory(moop, { showInRawMaterials: false }, env.ctx)).toThrow(/رصيد بالمخزون/)
  })

  it('enforces the stock guard through the IPC handler', async () => {
    const moop = createCategory({ name: 'moop', showInRawMaterials: true, materialDetails: details('MOOP') }, env.ctx)
    const material = bound(moop)
    const supplierId = createSupplier({ name: 'supplier' }, env.ctx)
    createPurchase({ supplierId, lines: [{ materialId: material.id, qtyMicro: 1_000_000, unitCostMicro: 1_000_000 }] }, env.ctx)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => {
      handlers.set(channel, handler)
    }) as never)
    registerIpcRouter()
    spy.mockRestore()
    const response = await handlers.get(IPC_CHANNELS.categories.update)!({ sender: { id: 1 } } as IpcMainInvokeEvent, { id: moop, showInRawMaterials: false })
    expect(response).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('رصيد بالمخزون') } })
    expect(categoryTree()[0].showInRawMaterials).toBe(true)
  })
})
