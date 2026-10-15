import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { colorFinishCatalog, materials } from '@main/db/schema/catalog.schema'
import { createCategory, createColor, createMaterial, updateMaterial, updateColor, deleteColor, listColors } from '@main/services/catalog/catalog.service'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function root(name: string): number {
  return createCategory({ name }, env.ctx)
}
function row(id: number) {
  return getDatabase().select().from(materials).where(eq(materials.id, id)).get()!
}
function color(id: number) {
  return listColors().find(item => item.id === id)!
}
function create(categoryId: number, sku: string, colorId?: number) {
  return createMaterial({ sku, name: sku, categoryId, colorId, unit: 'لوح', currentMarketPriceMicro: 0, pricingRule: 'exact' }, env.ctx)
}

describe('authoritative material color relationship', () => {
  it('reuses a catalog color for a standalone root, shows it from both sides, and keeps zero stock', () => {
    const white = createColor({ code: 'WHITE', name: 'أبيض' }, env.ctx)
    const pvcRoot = root('PVC')
    const pvc = create(pvcRoot, 'PVC-001', white)
    expect(row(pvc).colorId).toBe(white)
    expect(color(white).associatedMaterials).toEqual([{ id: pvc, sku: 'PVC-001', name: 'PVC-001' }])
    expect(color(white).baseMaterialNames).toEqual(['PVC'])
    expect(color(white).legacyAssociationConflict).toBe(false)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE material_id = ?').get(pvc)).toEqual({ count: 0 })
    expect(getRawConnection().prepare('SELECT COUNT(*) AS count FROM fifo_layers WHERE material_id = ?').get(pvc)).toEqual({ count: 0 })
    updateMaterial(pvc, { colorId: white }, env.ctx)
    expect(color(white).associatedMaterials).toHaveLength(1)
    expect(listColors()).toHaveLength(1)
  })

  it('allows multiple materials per color but only one color per material', () => {
    const white = createColor({ code: 'WHITE', name: 'أبيض' }, env.ctx)
    const black = createColor({ code: 'BLACK', name: 'أسود' }, env.ctx)
    const categoryId = root('PVC')
    const a = create(categoryId, 'PVC-A', white)
    const b = create(categoryId, 'PVC-B', white)
    expect(color(white).associatedMaterials.map(item => item.id)).toEqual([a, b])
    expect(color(white).baseMaterialNames).toEqual(['PVC'])
    expect(() => updateColor(black, { relatedMaterialId: a }, env.ctx)).toThrow(/نموذج المادة/)
    expect(row(a).colorId).toBe(white)
    updateMaterial(a, { colorId: black }, env.ctx)
    expect(color(white).associatedMaterials.map(item => item.id)).toEqual([b])
    expect(color(black).associatedMaterials.map(item => item.id)).toEqual([a])
    expect(color(white).baseMaterialNames).toEqual(['PVC'])
    expect(color(black).baseMaterialNames).toEqual(['PVC'])
    expect(row(a).colorId).toBe(black)
  })

  it('creates Raw without a color and rejects color association writes from the catalog API', () => {
    const categoryId = root('PVC')
    const raw = create(categoryId, 'RAW')
    const white = createColor({ code: 'WHITE', name: 'أبيض' }, env.ctx)
    expect(row(raw).colorId).toBeNull()
    expect(() => createColor({ code: 'OTHER', name: 'آخر', relatedMaterialId: raw }, env.ctx)).toThrow(/نموذج المادة/)
    expect(() => updateColor(white, { relatedMaterialId: raw }, env.ctx)).toThrow(/نموذج المادة/)
    expect(color(white).associatedMaterials).toEqual([])
    expect(listColors()).toHaveLength(1)
  })

  it('reports conflicting legacy links without changing or deleting them', () => {
    const white = createColor({ code: 'WHITE', name: 'أبيض' }, env.ctx)
    const black = createColor({ code: 'BLACK', name: 'أسود' }, env.ctx)
    const pvc = create(root('PVC'), 'PVC', white)
    getDatabase().update(colorFinishCatalog).set({ relatedMaterialId: pvc, relatedMaterialType: 'PVC' }).where(eq(colorFinishCatalog.id, black)).run()
    expect(color(black).legacyAssociationConflict).toBe(true)
    expect(color(black).associatedMaterials).toEqual([])
    expect(color(white).associatedMaterials.map(item => item.id)).toEqual([pvc])
    updateColor(black, { notes: 'review' }, env.ctx)
    expect(color(black).relatedMaterialId).toBe(pvc)
    expect(row(pvc).colorId).toBe(white)
    expect(deleteColor(black, env.ctx)).toMatchObject({ archived: true })
    expect(color(black).relatedMaterialId).toBe(pvc)
  })

  it('rolls back material creation if its audit write fails', () => {
    const white = createColor({ code: 'WHITE', name: 'أبيض' }, env.ctx)
    const categoryId = root('PVC')
    getRawConnection().exec("CREATE TRIGGER fail_material_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'catalog.material.create' BEGIN SELECT RAISE(FAIL, 'audit failure'); END")
    expect(() => create(categoryId, 'PVC-FAIL', white)).toThrow()
    expect(getDatabase().select().from(materials).where(eq(materials.sku, 'PVC-FAIL')).all()).toEqual([])
    expect(color(white).associatedMaterials).toEqual([])
    getRawConnection().exec('DROP TRIGGER fail_material_audit')
    expect(getDatabase().get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM inventory_movements`)?.count).toBe(0)
  })

  it('lists distinct base categories for one color without item names or full paths', () => {
    const white = createColor({ code: 'WHITE', name: 'أبيض' }, env.ctx)
    const wood = root('wood')
    const family = createCategory({ name: 'milamin', parentId: wood }, env.ctx)
    const base = createCategory({ name: 'milamin 18', parentId: family }, env.ctx)
    const pvc = root('PVC')
    const first = create(base, '898', white)
    const second = create(base, '899', white)
    create(pvc, 'PVC-W', white)
    expect(first).not.toBe(second)
    expect(color(white).baseMaterialNames).toEqual(['milamin 18', 'PVC'])
    expect(color(white).associatedMaterials.map(item => item.id)).toContain(first)
    expect(color(white).associatedMaterials.map(item => item.id)).toContain(second)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM inventory_movements').get()).toEqual({ c: 0 })
  })

  it('resolves a historical color-named leaf through its saved parent without renaming records', () => {
    const white = createColor({ code: 'WHITE', name: 'أبيض' }, env.ctx)
    const base = root('milamin 18')
    const db = getRawConnection()
    const leaf = Number(db.prepare("INSERT INTO material_categories (name,node_kind,parent_id) VALUES ('WHITE — أبيض','inventory_leaf',?)").run(base).lastInsertRowid)
    const legacy = Number(db.prepare("INSERT INTO materials (sku,name,category_id,hierarchy_node_id,color_id,unit,current_market_price_micro,pricing_rule) VALUES ('LEGACY-W','WHITE — أبيض',?,?,?,'لوح',0,'exact')").run(leaf, leaf, white).lastInsertRowid)
    expect(color(white).baseMaterialNames).toEqual(['milamin 18'])
    updateColor(white, { code: 'WHITE-NEW', name: 'أبيض جديد' }, env.ctx)
    expect(color(white).baseMaterialNames).toEqual(['milamin 18'])
    expect(db.prepare('SELECT name FROM materials WHERE id = ?').get(legacy)).toEqual({ name: 'WHITE — أبيض' })
    expect(db.prepare('SELECT name FROM material_categories WHERE id = ?').get(leaf)).toEqual({ name: 'WHITE — أبيض' })
  })

  it('reports an ambiguous historical category without guessing a base name', () => {
    const white = createColor({ code: 'WHITE', name: 'أبيض' }, env.ctx)
    const db = getRawConnection()
    const ambiguous = Number(db.prepare("INSERT INTO material_categories (name,node_kind) VALUES ('possibly color','legacy_ambiguous')").run().lastInsertRowid)
    const item = Number(db.prepare("INSERT INTO materials (sku,name,category_id,color_id,unit,current_market_price_micro,pricing_rule) VALUES ('OLD','possibly color',?,?,'لوح',0,'exact')").run(ambiguous, white).lastInsertRowid)
    expect(color(white).baseMaterialNames).toEqual([])
    expect(color(white).unresolvedMaterialIds).toEqual([item])
    expect(row(item).name).toBe('possibly color')
  })
})
