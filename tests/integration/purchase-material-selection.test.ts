import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCategory, createMaterial, listMaterials } from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase, getPurchase, updatePurchase } from '@main/services/purchasing/purchasing.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { closeDatabase, getRawConnection } from '@main/db/connection'
import { filterMaterialTypeOptions } from '@renderer/components/materials/SearchableMaterialSelect'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function masters() {
  const root = createCategory({ name: 'Wood' }, env.ctx)
  const child = createCategory({ name: 'MDF', parentId: root }, env.ctx)
  const a = createMaterial({ sku: 'MDF-18', name: 'MDF 18mm', categoryId: child, unit: 'لوح', currentMarketPriceMicro: unitCostFromMajor(125), pricingRule: 'exact' }, env.ctx)
  const b = createMaterial({ sku: 'WOOD-B', name: 'خشب زان', categoryId: child, unit: 'لوح', currentMarketPriceMicro: unitCostFromMajor(25), pricingRule: 'exact' }, env.ctx)
  const supplierId = createSupplier({ name: 'المورد' }, env.ctx)
  return { a, b, supplierId }
}

function persistedFinancialRows() {
  const raw = getRawConnection()
  return ['purchases', 'purchase_lines', 'fifo_layers', 'inventory_movements', 'cash_transactions']
    .map((table) => raw.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
}

describe('Purchase searchable material selections and existing financial behavior', () => {
  it('selects two independent master IDs and preserves quantity, price, total and inventory through edits/reload', () => {
    const { a, b, supplierId } = masters()
    const options = listMaterials({})
    const first = filterMaterialTypeOptions(options, 'mdf')[0]!
    const second = filterMaterialTypeOptions(options, 'WOOD-B')[0]!
    expect(first.id).toBe(a)
    expect(second.id).toBe(b)
    const result = createPurchase({ supplierId, lines: [
      { materialId: first.id, qtyMicro: quantityFromDisplay(3), unitCostMicro: unitCostFromMajor(125) },
      { materialId: second.id, qtyMicro: quantityFromDisplay(2), unitCostMicro: unitCostFromMajor(25) }
    ] }, env.ctx)
    expect(result.totalMinor).toBe(moneyFromMajor(425))
    closeDatabase()
    const saved = getPurchase(result.id)
    expect(saved.lines.map((line) => line.materialId)).toEqual([a, b])
    expect(saved.lines.map((line) => line.qtyMicro)).toEqual([quantityFromDisplay(3), quantityFromDisplay(2)])
    expect(saved.lines.map((line) => line.unitCostMicro)).toEqual([unitCostFromMajor(125), unitCostFromMajor(25)])
    expect(saved.lines.map((line) => line.lineTotalMinor)).toEqual([moneyFromMajor(375), moneyFromMajor(50)])
    expect(availableQty(a)).toBe(quantityFromDisplay(3))
    expect(availableQty(b)).toBe(quantityFromDisplay(2))
    const before = persistedFinancialRows()
    updatePurchase(result.id, { lines: saved.lines.map((line) => ({ materialId: line.materialId, qtyMicro: line.qtyMicro, unitCostMicro: line.unitCostMicro, batchCode: line.batchCode })) }, env.ctx)
    expect(persistedFinancialRows()).toEqual(before)
    updatePurchase(result.id, { lines: saved.lines.map((line, index) => ({ materialId: index === 0 ? b : line.materialId, qtyMicro: line.qtyMicro, unitCostMicro: line.unitCostMicro, batchCode: line.batchCode })) }, env.ctx)
    closeDatabase()
    expect(getPurchase(result.id).lines.map((line) => line.materialId)).toEqual([b, b])
    expect(getPurchase(result.id).purchase.totalMinor).toBe(moneyFromMajor(425))
    expect(availableQty(a)).toBe(0)
    expect(availableQty(b)).toBe(quantityFromDisplay(5))
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })

  it('does not offer organizational roots and rejects invalid IDs without persisting financial/inventory changes', () => {
    const { supplierId } = masters()
    const root = createCategory({ name: 'Organizational root only' }, env.ctx)
    expect(listMaterials({}).some((entry) => entry.name === 'Organizational root only')).toBe(false)
    const before = persistedFinancialRows()
    for (const materialId of [root, 0, -1, 1.5, 999999]) {
      expect(() => createPurchase({ supplierId, lines: [{ materialId, qtyMicro: quantityFromDisplay(1), unitCostMicro: unitCostFromMajor(125) }] }, env.ctx)).toThrow()
      expect(persistedFinancialRows()).toEqual(before)
    }
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})
