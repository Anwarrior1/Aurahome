import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCategory, createMaterial, listMaterials } from '@main/services/catalog/catalog.service'
import { stockLevels } from '@main/services/inventory/valuation.service'
import { getDatabase } from '@main/db/connection'
import { materials } from '@main/db/schema/catalog.schema'
import { unitCostFromMajor } from '@shared/money/cost'

/**
 * Bug fix: the raw-material category filter ("المواد الخام") only ever
 * matched a material's `category_id` exactly, so selecting a PARENT
 * category ("Wood") missed every material actually assigned to one of
 * its subcategories ("contour", "mdf"). The fix resolves the selected
 * category to itself + every descendant, by id/parent_id only — never
 * by name. (A separate, later pass removed the root-only restriction
 * on material category assignment itself — see generic-materials.test.ts
 * — so a material can now genuinely sit on a child category, not just
 * a pre-existing row inserted directly like `legacyMaterial` below.)
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function category(name: string, parentId?: number): number {
  return createCategory({ name, parentId }, env.ctx)
}

/** A material inserted directly, bypassing the service layer entirely
 *  — used here only to isolate these tests from createMaterial's own
 *  validation/business rules, which are covered separately. */
function legacyMaterial(sku: string, name: string, categoryId: number) {
  return Number(getDatabase().insert(materials).values({
    sku, name, categoryId, unit: 'قطعة',
    currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact'
  }).run().lastInsertRowid)
}

function tree() {
  const wood = category('Wood')
  const contour = category('contour', wood)
  const mdf = category('mdf', wood)
  const otherRoot = category('ألواح وخشب - تجريبي')
  return { wood, contour, mdf, otherRoot }
}

describe('Category filter — parent selection rolls up every descendant (Item 2/3)', () => {
  it('1: "كل التصنيفات" (no filter) shows every material regardless of category', () => {
    const { wood, contour, otherRoot } = tree()
    const onWood = createMaterial({ sku: 'W-1', name: 'مادة على Wood', categoryId: wood, unit: 'قطعة', currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact' } as never, env.ctx)
    const onContour = legacyMaterial('C-1', 'مادة على contour', contour)
    const onOther = createMaterial({ sku: 'O-1', name: 'مادة أخرى', categoryId: otherRoot, unit: 'قطعة', currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact' } as never, env.ctx)

    const all = listMaterials({}).map((m) => m.id)
    expect(all).toEqual(expect.arrayContaining([onWood, onContour, onOther]))
  })

  it('2/3: selecting the PARENT ("Wood") returns materials assigned directly to it AND to its children', () => {
    const { wood, contour, mdf } = tree()
    const onWoodDirectly = createMaterial({ sku: 'W-2', name: 'مادة على Wood مباشرة', categoryId: wood, unit: 'قطعة', currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact' } as never, env.ctx)
    const onContour = legacyMaterial('C-2', 'مادة على contour', contour)
    const onMdf = legacyMaterial('M-2', 'مادة على mdf', mdf)

    const result = listMaterials({ categoryId: wood }).map((m) => m.id)
    expect(result.sort()).toEqual([onWoodDirectly, onContour, onMdf].sort())
  })

  it('4/5: selecting a CHILD ("contour") returns only that child\'s materials — never a sibling\'s', () => {
    const { contour, mdf } = tree()
    const onContour = legacyMaterial('C-3', 'مادة على contour', contour)
    legacyMaterial('M-3', 'مادة على mdf', mdf) // sibling — must NOT appear

    const result = listMaterials({ categoryId: contour }).map((m) => m.id)
    expect(result).toEqual([onContour])
  })

  it('4/5: selecting the other child ("mdf") mirrors the same isolation', () => {
    const { contour, mdf } = tree()
    legacyMaterial('C-4', 'مادة على contour', contour) // sibling — must NOT appear
    const onMdf = legacyMaterial('M-4', 'مادة على mdf', mdf)

    const result = listMaterials({ categoryId: mdf }).map((m) => m.id)
    expect(result).toEqual([onMdf])
  })

  it('never leaks materials from an unrelated root category', () => {
    const { wood, otherRoot } = tree()
    createMaterial({ sku: 'W-5', name: 'مادة Wood', categoryId: wood, unit: 'قطعة', currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact' } as never, env.ctx)
    const onOther = createMaterial({ sku: 'O-5', name: 'مادة أخرى', categoryId: otherRoot, unit: 'قطعة', currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact' } as never, env.ctx)

    const result = listMaterials({ categoryId: otherRoot }).map((m) => m.id)
    expect(result).toEqual([onOther])
  })

  it('6: a category with zero materials (direct or nested) returns an empty list, not an error', () => {
    const { contour } = tree()
    expect(listMaterials({ categoryId: contour })).toEqual([])
  })

  it('7: search and category filtering combine correctly', () => {
    const { wood, contour } = tree()
    const matchOnWood = createMaterial({ sku: 'SRCH-1', name: 'لوح خاص', categoryId: wood, unit: 'قطعة', currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact' } as never, env.ctx)
    legacyMaterial('SRCH-2', 'شيء آخر', contour) // same subtree, name does not match
    createMaterial({ sku: 'SRCH-3', name: 'لوح خاص', categoryId: category('غير ذلك'), unit: 'قطعة', currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact' } as never, env.ctx) // matches name, wrong category

    const result = listMaterials({ categoryId: wood, search: 'خاص' }).map((m) => m.id)
    expect(result).toEqual([matchOnWood])
  })

  it('8: the filter query itself never modifies material or category data', () => {
    const { wood, contour } = tree()
    legacyMaterial('NC-1', 'ثابت', contour)
    const before = getDatabase().select().from(materials).all()

    listMaterials({})
    listMaterials({ categoryId: wood })
    listMaterials({ categoryId: contour })

    const after = getDatabase().select().from(materials).all()
    expect(after).toEqual(before)
  })

  it('the stock screen behind the same "المواد الخام" filter rolls up descendants identically', () => {
    const { wood, contour, mdf } = tree()
    createMaterial({ sku: 'STK-1', name: 'مادة Wood', categoryId: wood, unit: 'قطعة', currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact' } as never, env.ctx)
    legacyMaterial('STK-2', 'مادة contour', contour)
    legacyMaterial('STK-3', 'مادة mdf', mdf)

    const rows = stockLevels({ categoryId: wood })
    expect(rows.map((r) => r.sku).sort()).toEqual(['STK-1', 'STK-2', 'STK-3'])
  })
})
