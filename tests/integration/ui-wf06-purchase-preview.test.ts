import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier, supplierBalances } from '@main/services/parties/parties.service'
import { createPurchase, getPurchase } from '@main/services/purchasing/purchasing.service'
import { getRawConnection } from '@main/db/connection'
import { purchaseLinePreview } from '@renderer/pages/purchases/purchase-preview'
import { toMicro, fmtMoney } from '@renderer/lib/format'
import { costOf, unitCostMicro } from '@shared/money/cost'

let env: TestEnv
let materialId: number
let supplierId: number
beforeEach(() => {
  env = setupTestDatabase()
  const categoryId = createCategory({ name: 'UIWF06' }, env.ctx)
  materialId = createMaterial({ sku: 'UIWF06', name: 'material', categoryId, unit: 'unit', currentMarketPriceMicro: 0, pricingRule: 'exact' }, env.ctx)
  supplierId = createSupplier({ name: 'supplier' }, env.ctx)
})
afterEach(() => env.cleanup())
const matrix: Array<[string, string, number]> = [
  ['0.145', '0.100000', 15],
  ['0.004', '0.100000', 0],
  ['0.005', '0.100000', 1],
  ['0.006', '0.100000', 1],
  ['1', '1', 1000],
  ['1.0', '0.100000', 100],
  ['1.125', '2.000000', 2250],
  ['0.1', '0.2', 20],
  ['0.29', '0.050000', 15],
  ['2.345', '1.234567', 2895],
  ['0.145000', '0.100000', 15],
  ['1', '0', 0],
  ['9007199254.740990', '0.000001', 9007199],
  ['0.001', '9007199254.740990', 9007199255],
  ['9007199254.740990', '1000', 9007199254740990]
]
describe('UI-WF-06 authoritative purchase preview', () => {
  it.each(matrix)('%s × %s previews and commits exactly %i minor', (qty, price, expected) => {
    const raw = getRawConnection()
    const before = raw.serialize()
    const preview = purchaseLinePreview(qty, price)
    expect(preview).toBe(expected)
    expect(raw.serialize().equals(before)).toBe(true)
    const qtyMicro = toMicro(qty)
    const unitMicro = Math.round(Number(price) * 1_000_000)
    const result = createPurchase({ supplierId, lines: [{ materialId, qtyMicro, unitCostMicro: unitMicro }] }, env.ctx)
    expect(result.totalMinor).toBe(preview)
    const saved = getPurchase(result.id)
    expect(saved.purchase.totalMinor).toBe(expected)
    expect(saved.lines[0]).toMatchObject({ qtyMicro, unitCostMicro: unitMicro, lineTotalMinor: expected })
    expect(raw.prepare('SELECT * FROM inventory_movements').get()).toMatchObject({ qty_micro: qtyMicro, actual_cost_minor: expected, source_kind: 'purchase', source_ref_id: saved.lines[0].id })
    expect(raw.prepare('SELECT * FROM fifo_layers').get()).toMatchObject({ qty_received_micro: qtyMicro, qty_remaining_micro: qtyMicro, unit_cost_micro: unitMicro, source_ref_id: saved.lines[0].id })
    expect(supplierBalances()[0]).toMatchObject({ purchasedMinor: expected, paidMinor: 0, remainingMinor: expected })
    expect(raw.prepare('SELECT count(*) AS n FROM cash_transactions').get()).toEqual({ n: 0 })
    expect(raw.prepare('SELECT count(*) AS n FROM supplier_payments').get()).toEqual({ n: 0 })
    expect(raw.prepare("SELECT count(*) AS n FROM audit_log WHERE action='purchases.create'").get()).toEqual({ n: 1 })
    expect(fmtMoney(preview)).toBe(fmtMoney(result.totalMinor))
  })
  it('rounds each stock-unit line before aggregation', () => {
    const lines = [0, 1].map(() => ({ materialId, qtyMicro: 5000, unitCostMicro: 100000 }))
    const total = lines.reduce((sum) => sum + purchaseLinePreview('0.005', '0.100000'), 0)
    expect(total).toBe(2)
    expect(costOf(10000, unitCostMicro(100000))).toBe(1)
    expect(createPurchase({ supplierId, lines }, env.ctx).totalMinor).toBe(total)
  })
  it('uses purchase-unit rounding before stock conversion', () => {
    const categoryId = createCategory({ name: 'purchase units' }, env.ctx)
    const purchaseMaterial = createMaterial({ sku: 'PACK', name: 'pack', categoryId, unit: 'unit', purchaseUnit: 'pack', purchaseUnitFactorMicro: 3000000, currentMarketPriceMicro: 0, pricingRule: 'exact' }, env.ctx)
    const result = createPurchase({ supplierId, lines: [{ materialId: purchaseMaterial, purchaseQtyMicro: 145000, purchaseUnitCostMicro: 100000 }] }, env.ctx)
    expect(result.totalMinor).toBe(purchaseLinePreview('0.145', '0.100000'))
    expect(getPurchase(result.id).lines[0]).toMatchObject({ qtyMicro: 435000, unitCostMicro: 34483, lineTotalMinor: 15 })
  })
  it('allows empty/zero preview and independently rejects invalid mutation inputs', () => {
    expect(purchaseLinePreview('', '')).toBe(0)
    expect(purchaseLinePreview('0', '1')).toBe(0)
    for (const [qty, price] of [['-1', '1'], ['1', '-1'], ['1', 'NaN'], ['Infinity', '1'], ['1', 'Infinity']]) {
      expect(purchaseLinePreview(qty!, price!)).toBe(0)
    }
    for (const [qtyMicro, unitMicro] of [[0, 1], [-1, 1], [1, -1], [1.1, 1], [1, NaN], [Number.MAX_SAFE_INTEGER + 1, 1], [1, Number.MAX_SAFE_INTEGER + 1], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
      expect(() => createPurchase({ supplierId, lines: [{ materialId, qtyMicro: qtyMicro!, unitCostMicro: unitMicro! }] }, env.ctx)).toThrow()
    }
    expect(getRawConnection().prepare('SELECT count(*) AS n FROM purchases').get()).toEqual({ n: 0 })
    expect(purchaseLinePreview('9007199254.740990', '9007199254.740990')).toBe(0)
  })
})
