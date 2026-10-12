import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { consumeMaterial, recordWaste, adjustStock, availableQty } from '@main/services/inventory/inventory.service'
import { materialValuation } from '@main/services/inventory/valuation.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function seedMaterial(overrides: Record<string, unknown> = {}): number {
  const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
  return createMaterial(
    {
      sku: 'MDF-18',
      name: 'لوح MDF 18مم',
      categoryId,
      unit: 'لوح',
      currentMarketPriceMicro: unitCostFromMajor(150),
      pricingRule: 'exact',
      ...overrides
    } as never,
    env.ctx
  )
}

describe('FIFO inventory (BR-5, BR-6, BR-12)', () => {
  it('consumes the OLDEST layer first and costs from actual allocations, not an average', () => {
    const materialId = seedMaterial()
    const supplierId = createSupplier({ name: 'مورد الأخشاب' }, env.ctx)

    // Two purchases at different prices: 10 @ 100 LYD, then 10 @ 150 LYD.
    createPurchase({
      supplierId,
      purchaseDate: '2026-01-01',
      lines: [{ materialId, qtyMicro: quantityFromDisplay(10), unitCostMicro: unitCostFromMajor(100) }]
    }, env.ctx)
    createPurchase({
      supplierId,
      purchaseDate: '2026-02-01',
      lines: [{ materialId, qtyMicro: quantityFromDisplay(10), unitCostMicro: unitCostFromMajor(150) }]
    }, env.ctx)

    // Consuming 15 must take 10 from the older layer and 5 from the newer:
    // (10 × 100) + (5 × 150) = 1,750 LYD — an average would give 1,875.
    const result = consumeMaterial({ materialId, physicalQtyMicro: quantityFromDisplay(15), ctx: env.ctx })

    expect(result.actualCostMinor).toBe(moneyFromMajor(1750))
    expect(result.allocations).toHaveLength(2)
    expect(result.allocations[0]?.qtyMicro).toBe(quantityFromDisplay(10))
    expect(result.allocations[1]?.qtyMicro).toBe(quantityFromDisplay(5))
    expect(availableQty(materialId)).toBe(quantityFromDisplay(5))
  })

  it('BLOCKS a consumption that would drive stock negative (BR-5)', () => {
    const materialId = seedMaterial()
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    createPurchase({
      supplierId,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(3), unitCostMicro: unitCostFromMajor(100) }]
    }, env.ctx)

    expect(() =>
      consumeMaterial({ materialId, physicalQtyMicro: quantityFromDisplay(4), ctx: env.ctx })
    ).toThrowError(/غير كافية/)

    // The failed attempt must leave stock completely untouched.
    expect(availableQty(materialId)).toBe(quantityFromDisplay(3))
  })

  it('deducts only what was physically consumed while charging a FULL commercial unit (BR-10/BR-11/BR-12)', () => {
    // A 1.5 m unit material priced by the full commercial unit.
    const materialId = seedMaterial({
      sku: 'EDGE-15',
      name: 'شريط حواف 1.5م',
      unit: 'م',
      pricingRule: 'full_unit',
      commercialUnitSizeMicro: quantityFromDisplay(1.5),
      currentMarketPriceMicro: unitCostFromMajor(100) // 100 LYD per metre
    })
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    createPurchase({
      supplierId,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(1.5), unitCostMicro: unitCostFromMajor(60) }]
    }, env.ctx)

    // Physically use only 10 cm.
    const result = consumeMaterial({ materialId, physicalQtyMicro: quantityFromDisplay(0.1), ctx: env.ctx })

    // 1. Physical deduction is exactly 10 cm — the remainder stays usable.
    expect(result.physicalQtyMicro).toBe(quantityFromDisplay(0.1))
    expect(availableQty(materialId)).toBe(quantityFromDisplay(1.4))

    // 2. Actual cost is the FIFO cost of 10 cm only: 0.1 × 60 = 6 LYD.
    expect(result.actualCostMinor).toBe(moneyFromMajor(6))

    // 3. The customer is charged a full 1.5 m unit at market price: 150 LYD.
    expect(result.commercialQtyMicro).toBe(quantityFromDisplay(1.5))
    expect(result.commercialValueMinor).toBe(moneyFromMajor(150))
    expect(result.pricingRuleUsed).toBe('full_unit')
  })

  it('lets a second order reuse the remainder and charge a full unit again (BR-11)', () => {
    const materialId = seedMaterial({
      sku: 'EDGE-15',
      unit: 'م',
      pricingRule: 'full_unit',
      commercialUnitSizeMicro: quantityFromDisplay(1.5),
      currentMarketPriceMicro: unitCostFromMajor(100)
    })
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    createPurchase({
      supplierId,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(1.5), unitCostMicro: unitCostFromMajor(60) }]
    }, env.ctx)

    const first = consumeMaterial({ materialId, physicalQtyMicro: quantityFromDisplay(0.1), ctx: env.ctx })
    const second = consumeMaterial({ materialId, physicalQtyMicro: quantityFromDisplay(0.2), ctx: env.ctx })

    // One physical unit served two orders, each priced a full unit.
    expect(first.commercialValueMinor).toBe(moneyFromMajor(150))
    expect(second.commercialValueMinor).toBe(moneyFromMajor(150))
    // Yet only 0.3 m left inventory in total.
    expect(availableQty(materialId)).toBe(quantityFromDisplay(1.2))
  })

  it('records waste as a general loss and keeps it out of any order (BR-14/BR-49)', () => {
    const materialId = seedMaterial()
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    createPurchase({
      supplierId,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(10), unitCostMicro: unitCostFromMajor(100) }]
    }, env.ctx)

    const waste = recordWaste({ materialId, qtyMicro: quantityFromDisplay(2), reason: 'كسر أثناء النقل', ctx: env.ctx })
    expect(waste.costMinor).toBe(moneyFromMajor(200))
    expect(availableQty(materialId)).toBe(quantityFromDisplay(8))
  })

  it('requires a reason for a manual stock adjustment (BR-51)', () => {
    const materialId = seedMaterial()
    expect(() =>
      adjustStock({ materialId, qtyMicro: quantityFromDisplay(1), direction: 'in', reason: '', ctx: env.ctx })
    ).toThrowError(/سبب/)
  })

  it('reports FIFO value and market value as two separate figures (BR-95)', () => {
    const materialId = seedMaterial({ currentMarketPriceMicro: unitCostFromMajor(150) })
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    createPurchase({
      supplierId,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(10), unitCostMicro: unitCostFromMajor(100) }]
    }, env.ctx)

    const valuation = materialValuation()
    // Bought at 100, market now 150 — the two values must not be blended.
    expect(valuation.totals.fifoValueMinor).toBe(moneyFromMajor(1000))
    expect(valuation.totals.marketValueMinor).toBe(moneyFromMajor(1500))
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
