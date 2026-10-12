import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import {
  createCategory,
  categoryTree,
  createMaterial,
  updateMaterial,
  getMaterial,
  listMaterials
} from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase, getPurchase, listPurchases } from '@main/services/purchasing/purchasing.service'
import { availableQty, recordOpeningStock, consumeMaterial, listMovements } from '@main/services/inventory/inventory.service'
import { AppError } from '@main/utils/errors'
import { getDatabase } from '@main/db/connection'
import { fifoLayers } from '@main/db/schema/inventory.schema'
import { materials } from '@main/db/schema/catalog.schema'
import { eq } from 'drizzle-orm'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * Material-master refinement pass: a generic, versatile material master
 * (items 4–14) plus category hierarchy (items 2/3), purchase-unit
 * conversion (item 7/16), and opening stock (item 15) — verified across
 * several genuinely different material shapes (item 19), not just MDF.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function category(name: string, parentId?: number): number {
  return createCategory({ name, parentId }, env.ctx)
}

describe('Category hierarchy (items 2/3/20)', () => {
  it('keeps parent/child integrity across multiple branches', () => {
    const wood = category('أخشاب')
    const mdf = category('MDF', wood)
    const contour = category('Contour', wood)
    const accessories = category('إكسسوارات')
    const hinges = category('مفصلات', accessories)

    const tree = categoryTree()
    const woodNode = tree.find((n) => n.id === wood)!
    expect(woodNode.children.map((c) => c.id).sort()).toEqual([mdf, contour].sort())
    const accessoriesNode = tree.find((n) => n.id === accessories)!
    expect(accessoriesNode.children.map((c) => c.id)).toEqual([hinges])
    // Leaves have no children of their own.
    expect(woodNode.children.find((c) => c.id === mdf)!.children).toHaveLength(0)
  })

  it('keeps materials assigned to leaf categories readable without changing the category tree', () => {
    const accessories = category('إكسسوارات')
    const hingesCategory = category('مفصلات', accessories)
    const wood = category('أخشاب')
    const mdfCategory = category('MDF', wood)

    const hingeId = Number(getDatabase().insert(materials).values({
      sku: 'HNG-1', name: 'مفصلة هيدروليك', categoryId: hingesCategory, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }).run().lastInsertRowid)
    const mdfId = Number(getDatabase().insert(materials).values({
      sku: 'MDF-1', name: 'لوح MDF', categoryId: mdfCategory, unit: 'لوح',
      currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
    }).run().lastInsertRowid)

    expect(getMaterial(hingeId).categoryId).toBe(hingesCategory)
    expect(getMaterial(mdfId).categoryId).toBe(mdfCategory)
    // The tree still reports the material counts at the leaves.
    const tree = categoryTree()
    const accessoriesNode = tree.find((n) => n.id === accessories)!
    expect(accessoriesNode.children.find((c) => c.id === hingesCategory)!.materialCount).toBe(1)
  })
})

describe('Material category assignment — any level of the hierarchy is valid', () => {
  it('creating a material assigned to a ROOT category succeeds', () => {
    const wood = category('Wood')
    const id = createMaterial({
      sku: 'ROOT-1', name: 'مادة على الجذر', categoryId: wood, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact'
    } as never, env.ctx)
    expect(getMaterial(id).categoryId).toBe(wood)
  })

  it('creating a material assigned to a CHILD category succeeds — the previous root-only rule is gone', () => {
    const wood = category('Wood')
    const mdf = category('mdf', wood)
    const id = createMaterial({
      sku: 'CHILD-1', name: 'لوح mdf', categoryId: mdf, unit: 'لوح',
      currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact'
    } as never, env.ctx)
    expect(getMaterial(id).categoryId).toBe(mdf)
  })

  it('updating a material from a ROOT category to a CHILD category succeeds', () => {
    const wood = category('Wood')
    const mdf = category('mdf', wood)
    const id = createMaterial({
      sku: 'MOVE-1', name: 'مادة تنتقل', categoryId: wood, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact'
    } as never, env.ctx)
    updateMaterial(id, { categoryId: mdf }, env.ctx)
    expect(getMaterial(id).categoryId).toBe(mdf)
  })

  it('updating a material from one CHILD category to a sibling CHILD category succeeds', () => {
    const wood = category('Wood')
    const mdf = category('mdf', wood)
    const contour = category('contour', wood)
    const id = createMaterial({
      sku: 'MOVE-2', name: 'مادة بين فرعين', categoryId: mdf, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact'
    } as never, env.ctx)
    updateMaterial(id, { categoryId: contour }, env.ctx)
    expect(getMaterial(id).categoryId).toBe(contour)
  })

  it('still rejects an invalid/nonexistent category id on create and on update', () => {
    const wood = category('Wood')
    expect(() => createMaterial({
      sku: 'BAD-1', name: 'مادة بتصنيف خاطئ', categoryId: 999999, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact'
    } as never, env.ctx)).toThrowError(/التصنيف غير موجود/)

    const id = createMaterial({
      sku: 'GOOD-1', name: 'مادة صحيحة', categoryId: wood, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact'
    } as never, env.ctx)
    expect(() => updateMaterial(id, { categoryId: 999999 }, env.ctx)).toThrowError(/التصنيف غير موجود/)
    expect(getMaterial(id).categoryId).toBe(wood)
  })

  it('creating/editing one material never reassigns another existing material\'s category', () => {
    const wood = category('Wood')
    const mdf = category('mdf', wood)
    const untouchedId = createMaterial({
      sku: 'STAY-1', name: 'مادة ثابتة', categoryId: wood, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact'
    } as never, env.ctx)

    const otherId = createMaterial({
      sku: 'STAY-2', name: 'مادة أخرى', categoryId: mdf, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact'
    } as never, env.ctx)
    updateMaterial(otherId, { categoryId: wood }, env.ctx)

    expect(getMaterial(untouchedId).categoryId).toBe(wood)
    expect(getMaterial(otherId).categoryId).toBe(wood)
  })

  it('moving a material between categories never touches its inventory/stock data', () => {
    const wood = category('Wood')
    const mdf = category('mdf', wood)
    const id = createMaterial({
      sku: 'STOCK-1', name: 'مادة برصيد', categoryId: wood, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'exact'
    } as never, env.ctx)
    recordOpeningStock({ materialId: id, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(10) }, env.ctx)
    const before = availableQty(id)

    updateMaterial(id, { categoryId: mdf }, env.ctx)

    expect(availableQty(id)).toBe(before)
    expect(getMaterial(id).categoryId).toBe(mdf)
  })
})

describe('Generic material master — validation is capability-based, not board-shaped (items 8/21)', () => {
  it('TEST B: a piece-based material (hinge) is valid with no dimensions or thickness', () => {
    const categoryId = category('إكسسوارات')
    const id = createMaterial({
      sku: 'HNG-2', name: 'مفصلة هيدروليك', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
      // No dimensions or alternate purchase unit.
    }, env.ctx)

    const material = getMaterial(id)
    expect(material.tracksDimensions).toBe(false)
    expect(material.dimensions).toBeNull()
  })

  it('TEST A: a board material may enable dimensions/thickness', () => {
    const categoryId = category('أخشاب')
    const id = createMaterial({
      sku: 'MDF-2', name: 'MDF 18mm', categoryId, unit: 'لوح',
      tracksDimensions: true, dimensions: '244×122', thickness: '18mm',
      currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
    }, env.ctx)

    const material = getMaterial(id)
    expect(material.tracksDimensions).toBe(true)
    expect(material.dimensions).toBe('244×122')
    expect(material.thickness).toBe('18mm')
  })

  it('TEST C: a liquid material (glue) needs no dimensions', () => {
    const categoryId = category('مواد لاصقة')
    const id = createMaterial({
      sku: 'GLU-1', name: 'غراء', categoryId, unit: 'لتر',
      currentMarketPriceMicro: unitCostFromMajor(20), pricingRule: 'exact'
    }, env.ctx)

    const material = getMaterial(id)
    expect(material.unit).toBe('لتر')
    expect(material.tracksDimensions).toBe(false)
  })

  it('refuses tracksDimensions=true with empty dimensions (item 21)', () => {
    const categoryId = category('أخشاب')
    expect(() =>
      createMaterial({
        sku: 'MDF-3', name: 'MDF', categoryId, unit: 'لوح', tracksDimensions: true,
        currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
      }, env.ctx)
    ).toThrowError(/الأبعاد/)
  })

  it('a market-price update never touches an existing FIFO layer (item 13)', () => {
    const categoryId = category('إكسسوارات')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'HNG-3', name: 'مفصلة', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)
    createPurchase({
      supplierId,
      lines: [{ materialId: id, qtyMicro: quantityFromDisplay(10), unitCostMicro: unitCostFromMajor(5) }]
    }, env.ctx)

    updateMaterial(id, { currentMarketPriceMicro: unitCostFromMajor(999) }, env.ctx)

    const layer = getDatabase().select().from(fifoLayers).where(eq(fifoLayers.materialId, id)).get()!
    expect(layer.unitCostMicro).toBe(unitCostFromMajor(5)) // untouched
    expect(getMaterial(id).currentMarketPriceMicro).toBe(unitCostFromMajor(999)) // only the reference price moved
  })
})

describe('Purchase-unit conversion (items 7/16/17)', () => {
  it('TEST B exactly: 2 boxes × 50 pieces = 100 stock pieces, correct FIFO cost', () => {
    const categoryId = category('إكسسوارات')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'HNG-4', name: 'مفصلة هيدروليك', categoryId, unit: 'قطعة',
      purchaseUnit: 'علبة', purchaseUnitFactorMicro: quantityFromDisplay(50),
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)

    // 2 boxes at 250 LYD per box.
    createPurchase({
      supplierId,
      lines: [{ materialId: id, purchaseQtyMicro: quantityFromDisplay(2), purchaseUnitCostMicro: unitCostFromMajor(250) }]
    }, env.ctx)

    expect(availableQty(id)).toBe(quantityFromDisplay(100))
    const layer = getDatabase().select().from(fifoLayers).where(eq(fifoLayers.materialId, id)).get()!
    // 500 LYD total ÷ 100 pieces = 5 LYD/piece — NEVER 250 LYD/piece.
    expect(layer.unitCostMicro).toBe(unitCostFromMajor(5))
    expect(layer.qtyReceivedMicro).toBe(quantityFromDisplay(100))
  })

  it('TEST C exactly: glue, 1 gallon = 4 litres, 3 gallons purchased → 12 litres', () => {
    const categoryId = category('مواد لاصقة')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'GLU-2', name: 'غراء', categoryId, unit: 'لتر',
      purchaseUnit: 'جالون', purchaseUnitFactorMicro: quantityFromDisplay(4),
      currentMarketPriceMicro: unitCostFromMajor(15), pricingRule: 'exact'
    }, env.ctx)

    createPurchase({
      supplierId,
      lines: [{ materialId: id, purchaseQtyMicro: quantityFromDisplay(3), purchaseUnitCostMicro: unitCostFromMajor(60) }]
    }, env.ctx)

    expect(availableQty(id)).toBe(quantityFromDisplay(12))
    const layer = getDatabase().select().from(fifoLayers).where(eq(fifoLayers.materialId, id)).get()!
    // 3 × 60 = 180 LYD ÷ 12 litres = 15 LYD/litre.
    expect(layer.unitCostMicro).toBe(unitCostFromMajor(15))
  })

  it('TEST D exactly: edge banding, 1 roll = 100 metres, 2 rolls purchased → 200 metres', () => {
    const categoryId = category('تشطيبات')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'EDG-1', name: 'شريط حواف', categoryId, unit: 'متر',
      purchaseUnit: 'رول', purchaseUnitFactorMicro: quantityFromDisplay(100),
      currentMarketPriceMicro: unitCostFromMajor(2), pricingRule: 'exact'
    }, env.ctx)

    createPurchase({
      supplierId,
      lines: [{ materialId: id, purchaseQtyMicro: quantityFromDisplay(2), purchaseUnitCostMicro: unitCostFromMajor(150) }]
    }, env.ctx)

    expect(availableQty(id)).toBe(quantityFromDisplay(200))
  })

  it('TEST E: an area-based material (glass) needs no purchase-unit conversion', () => {
    const categoryId = category('زجاج')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'GLS-1', name: 'زجاج', categoryId, unit: 'م2',
      tracksDimensions: true, dimensions: 'متغيرة حسب الطلب', thickness: '6mm',
      currentMarketPriceMicro: unitCostFromMajor(40), pricingRule: 'exact'
      // purchaseUnit intentionally omitted — bought directly in م2.
    }, env.ctx)

    createPurchase({
      supplierId,
      lines: [{ materialId: id, qtyMicro: quantityFromDisplay(10), unitCostMicro: unitCostFromMajor(40) }]
    }, env.ctx)

    expect(availableQty(id)).toBe(quantityFromDisplay(10))
    expect(getMaterial(id).purchaseUnit).toBeNull()
  })

  it('refuses purchase-unit quantity for a material with no conversion configured', () => {
    const categoryId = category('إكسسوارات')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'HNG-5', name: 'مفصلة', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)

    expect(() =>
      createPurchase({
        supplierId,
        lines: [{ materialId: id, purchaseQtyMicro: quantityFromDisplay(2), purchaseUnitCostMicro: unitCostFromMajor(250) }]
      }, env.ctx)
    ).toThrowError(/ليس لها وحدة شراء/)
  })

  it('rejects a material with a purchase unit but no factor', () => {
    const categoryId = category('إكسسوارات')
    expect(() =>
      createMaterial({
        sku: 'HNG-6', name: 'مفصلة', categoryId, unit: 'قطعة', purchaseUnit: 'علبة',
        currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
      }, env.ctx)
    ).toThrowError(/عدد وحدات المخزون/)
  })

  it('still supports plain base-unit purchasing when no conversion is used (TEST A: 20 boards → stock 20)', () => {
    const categoryId = category('أخشاب')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'MDF-4', name: 'MDF', categoryId, unit: 'لوح', tracksDimensions: true, dimensions: '244×122', thickness: '18mm',
      currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
    }, env.ctx)

    createPurchase({
      supplierId,
      lines: [{ materialId: id, qtyMicro: quantityFromDisplay(20), unitCostMicro: unitCostFromMajor(150) }]
    }, env.ctx)

    expect(availableQty(id)).toBe(quantityFromDisplay(20))
  })

  it('a purchase line total (not per-purchase-unit cost) still converts correctly', () => {
    const categoryId = category('إكسسوارات')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'HNG-7', name: 'مفصلة', categoryId, unit: 'قطعة',
      purchaseUnit: 'علبة', purchaseUnitFactorMicro: quantityFromDisplay(50),
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)

    const purchase = createPurchase({
      supplierId,
      lines: [{ materialId: id, purchaseQtyMicro: quantityFromDisplay(2), lineTotalMinor: moneyFromMajor(500) }]
    }, env.ctx)

    expect(availableQty(id)).toBe(quantityFromDisplay(100))
    expect(getPurchase(purchase.id).purchase.totalMinor).toBe(moneyFromMajor(500))
    const layer = getDatabase().select().from(fifoLayers).where(eq(fifoLayers.materialId, id)).get()!
    expect(layer.unitCostMicro).toBe(unitCostFromMajor(5))
  })

  it('refuses a line that mixes qtyMicro and purchaseQtyMicro', () => {
    const categoryId = category('إكسسوارات')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'HNG-8', name: 'مفصلة', categoryId, unit: 'قطعة',
      purchaseUnit: 'علبة', purchaseUnitFactorMicro: quantityFromDisplay(50),
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)

    expect(() =>
      createPurchase({
        supplierId,
        lines: [{ materialId: id, qtyMicro: quantityFromDisplay(10), purchaseQtyMicro: quantityFromDisplay(2), unitCostMicro: unitCostFromMajor(5) }]
      }, env.ctx)
    ).toThrowError(/وليس كلاهما/)
  })
})

describe('FIFO stays authoritative across mixed-cost purchases (item 17)', () => {
  it('consumes the oldest layer first regardless of how each purchase was entered', () => {
    const categoryId = category('إكسسوارات')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'HNG-9', name: 'مفصلة', categoryId, unit: 'قطعة',
      purchaseUnit: 'علبة', purchaseUnitFactorMicro: quantityFromDisplay(50),
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)

    // Layer 1: 100 pieces @ 5 LYD (via purchase-unit conversion).
    createPurchase({
      supplierId,
      lines: [{ materialId: id, purchaseQtyMicro: quantityFromDisplay(2), purchaseUnitCostMicro: unitCostFromMajor(250) }]
    }, env.ctx)
    // Layer 2: 50 pieces @ 6 LYD/piece (entered directly in the base unit).
    createPurchase({
      supplierId,
      lines: [{ materialId: id, qtyMicro: quantityFromDisplay(50), unitCostMicro: unitCostFromMajor(6) }]
    }, env.ctx)

    expect(availableQty(id)).toBe(quantityFromDisplay(150))

    // Consuming 120 pieces must take all 100 from layer 1 (@5) then 20 from layer 2 (@6).
    const result = consumeMaterial({ materialId: id, physicalQtyMicro: quantityFromDisplay(120), ctx: env.ctx })
    expect(result.actualCostMinor).toBe(moneyFromMajor(100 * 5 + 20 * 6))
    expect(availableQty(id)).toBe(quantityFromDisplay(30))
  })

  it('still blocks negative stock', () => {
    const categoryId = category('إكسسوارات')
    const id = createMaterial({
      sku: 'HNG-10', name: 'مفصلة', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)

    expect(() => consumeMaterial({ materialId: id, physicalQtyMicro: quantityFromDisplay(1), ctx: env.ctx }))
      .toThrowError(/غير كافية/)
  })
})

describe('Opening stock (item 15)', () => {
  it('matches the worked example: 300 hinges @ 5 LYD each', () => {
    const categoryId = category('إكسسوارات')
    const id = createMaterial({
      sku: 'HNG-11', name: 'مفصلة هيدروليك', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)

    recordOpeningStock({
      materialId: id, qtyMicro: quantityFromDisplay(300), unitCostMicro: unitCostFromMajor(5)
    }, env.ctx)

    expect(availableQty(id)).toBe(quantityFromDisplay(300))
  })

  it('creates a real FIFO layer and an "opening" inventory movement — never a direct stock overwrite', () => {
    const categoryId = category('إكسسوارات')
    const id = createMaterial({
      sku: 'HNG-12', name: 'مفصلة', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)

    recordOpeningStock({ materialId: id, qtyMicro: quantityFromDisplay(300), unitCostMicro: unitCostFromMajor(5) }, env.ctx)

    const layer = getDatabase().select().from(fifoLayers).where(eq(fifoLayers.materialId, id)).get()!
    expect(layer.sourceKind).toBe('opening')
    expect(layer.qtyReceivedMicro).toBe(quantityFromDisplay(300))
    expect(layer.unitCostMicro).toBe(unitCostFromMajor(5))

    const movements = listMovements({ materialId: id }).items
    expect(movements).toHaveLength(1)
    expect(movements[0]?.kind).toBe('opening')
  })

  it('opening stock and a later purchase both become real FIFO layers, consumed oldest-first', () => {
    const categoryId = category('إكسسوارات')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'HNG-13', name: 'مفصلة', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)

    recordOpeningStock({
      materialId: id, qtyMicro: quantityFromDisplay(50), unitCostMicro: unitCostFromMajor(4), openingDate: '2026-01-01'
    }, env.ctx)
    createPurchase({
      supplierId,
      lines: [{ materialId: id, qtyMicro: quantityFromDisplay(50), unitCostMicro: unitCostFromMajor(6) }]
    }, env.ctx)

    expect(availableQty(id)).toBe(quantityFromDisplay(100))
    // The opening layer (older, cheaper) is consumed first.
    const result = consumeMaterial({ materialId: id, physicalQtyMicro: quantityFromDisplay(60), ctx: env.ctx })
    expect(result.actualCostMinor).toBe(moneyFromMajor(50 * 4 + 10 * 6))
  })

  it('does NOT create a fabricated supplier purchase (item 15)', () => {
    const categoryId = category('إكسسوارات')
    const id = createMaterial({
      sku: 'HNG-14', name: 'مفصلة', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)

    recordOpeningStock({ materialId: id, qtyMicro: quantityFromDisplay(300), unitCostMicro: unitCostFromMajor(5) }, env.ctx)

    expect(listPurchases({}).items).toHaveLength(0) // no supplier document was created
    const movements = listMovements({ materialId: id }).items
    expect(movements[0]?.kind).toBe('opening') // not 'purchase'
  })

  it('rejects a zero or negative opening quantity', () => {
    const categoryId = category('إكسسوارات')
    const id = createMaterial({
      sku: 'HNG-15', name: 'مفصلة', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)

    expect(() => recordOpeningStock({ materialId: id, qtyMicro: 0, unitCostMicro: unitCostFromMajor(5) }, env.ctx))
      .toThrowError(AppError)
  })
})

describe('No direct stock overwrite from the Material Master (item 14)', () => {
  it('updateMaterial has no quantity/stock field to set at all', () => {
    const categoryId = category('إكسسوارات')
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const id = createMaterial({
      sku: 'HNG-16', name: 'مفصلة', categoryId, unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(5), pricingRule: 'exact'
    }, env.ctx)
    createPurchase({
      supplierId,
      lines: [{ materialId: id, qtyMicro: quantityFromDisplay(80), unitCostMicro: unitCostFromMajor(5) }]
    }, env.ctx)
    expect(availableQty(id)).toBe(quantityFromDisplay(80))

    // Editing every editable field on the material has zero effect on stock.
    updateMaterial(id, { name: 'مفصلة معدّلة', notes: 'تحديث تجريبي' }, env.ctx)

    expect(availableQty(id)).toBe(quantityFromDisplay(80)) // unchanged by the edit
  })
})

describe('Existing BOM/planned-material references remain valid (item 18/24)', () => {
  it('materials list still exposes the same id/name pair BOM lines rely on after a full edit', () => {
    const categoryId = category('أخشاب')
    const id = createMaterial({
      sku: 'MDF-5', name: 'MDF', categoryId, unit: 'لوح', tracksDimensions: true, dimensions: '244×122',
      currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact'
    }, env.ctx)

    updateMaterial(id, { purchaseUnit: null, tracksDimensions: true, dimensions: '244×122', thickness: '18mm' }, env.ctx)

    const rows = listMaterials({})
    expect(rows.find((m) => m.id === id)?.name).toBe('MDF')
  })
})
