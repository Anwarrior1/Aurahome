import { issueStockForOrder } from '../helpers/finished-goods-fixture'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createProduct, listProducts, replaceBom } from '@main/services/products/products.service'
import { createFinalInvoice, createStandardFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment, completeOrder, getOrder } from '@main/services/sales/orders.service'
import {
  issueWorkSheet, startProduction, completeProduction, issueRelease, recordDelivery,
  issueStandardStockFromBom, standardStockIssuePreview
} from '@main/services/production/production.service'
import { onHandMicro, listFinishedGoods, finishedGoodsCostForOrder } from '@main/services/production/finished-goods.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { listPlannedMaterials, savePlannedMaterials } from '@main/services/planning/planning.service'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { standardProductAvailability } from '@shared/production/standard-availability'

/**
 * BL-04: a standard line is supplied once — from ready finished goods only.
 * Customer manufacturing is for custom lines; standard stock is produced
 * independently through «صرف من المخزون» (BOM × N → N ready units).
 */
let env: TestEnv
let key = 0
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const raw = () => getRawConnection()
const count = (sql: string, ...args: unknown[]) => (raw().prepare(sql).get(...args) as { c: number }).c

function seed(mdfQty = 20) {
  const categoryId = createCategory({ name: 'مواد' }, env.ctx)
  const material = (sku: string, name: string, extra: Record<string, unknown> = {}) => createMaterial({
    sku, name, categoryId, unit: 'وحدة', currentMarketPriceMicro: unitCostFromMajor(1), pricingRule: 'exact', ...extra
  } as never, env.ctx)
  const mdf = material('MDF', 'MDF')
  const hinge = material('HNG', 'مفصلة')
  const handle = material('HDL', 'مقبض')
  const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
  // Two MDF FIFO layers at different costs.
  createPurchase({ supplierId, lines: [{ materialId: mdf, qtyMicro: q(10), unitCostMicro: unitCostFromMajor(100) }] }, env.ctx)
  if (mdfQty > 10) createPurchase({ supplierId, lines: [{ materialId: mdf, qtyMicro: q(mdfQty - 10), unitCostMicro: unitCostFromMajor(200) }] }, env.ctx)
  createPurchase({ supplierId, lines: [
    { materialId: hinge, qtyMicro: q(100), unitCostMicro: unitCostFromMajor(2) },
    { materialId: handle, qtyMicro: q(100), unitCostMicro: unitCostFromMajor(5) }
  ] }, env.ctx)
  // Wardrobe A: MDF 3, hinges 8, handles 4 per unit.
  const productId = createProduct({ code: 'W-A', name: 'خزانة A', defaultPriceMinor: moneyFromMajor(3000) }, env.ctx)
  replaceBom(productId, [
    { materialId: mdf, qtyMicro: q(3), unit: 'وحدة' },
    { materialId: hinge, qtyMicro: q(8), unit: 'وحدة' },
    { materialId: handle, qtyMicro: q(4), unit: 'وحدة' }
  ], env.ctx)
  const customerId = createCustomer({ name: 'عميل', phone: '0910000000' }, env.ctx)
  return { mdf, hinge, handle, productId, customerId, supplierId, categoryId }
}

const produce = (productId: number, units: number, requestKey = `bl04-${++key}-key`) =>
  issueStandardStockFromBom({ productId, quantityMicro: q(units), requestKey }, env.ctx)

function standardOrder(customerId: number, productId: number, units = 1, paid = true) {
  const order = approveToOrder(createStandardFinalInvoice({ customerId, productId, quantityMicro: q(units), unitPriceMinor: moneyFromMajor(3000) }, env.ctx).id, env.ctx)
  if (paid) recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
  return order
}

function snapshot(ids: { mdf: number; hinge: number; handle: number; productId: number }) {
  return {
    mdf: availableQty(ids.mdf), hinge: availableQty(ids.hinge), handle: availableQty(ids.handle),
    ready: onHandMicro(ids.productId),
    sheets: count('SELECT COUNT(*) AS c FROM work_sheets'),
    fg: count('SELECT COUNT(*) AS c FROM finished_goods_movements'),
    issues: count('SELECT COUNT(*) AS c FROM inventory_movements'),
    materialLines: count('SELECT COUNT(*) AS c FROM order_material_lines'),
    receipts: count("SELECT COUNT(*) AS c FROM financial_command_requests WHERE command_scope = 'products.issueStockFromBom'")
  }
}

describe('BL-04 original defect is closed', () => {
  it('stock-fulfilled standard order cannot also be manufactured (no BOM re-consumption, single cost)', () => {
    const s = seed()
    produce(s.productId, 3)
    const order = standardOrder(s.customerId, s.productId)
    expect(listPlannedMaterials({ orderId: order.id })).toHaveLength(0)
    issueStockForOrder({ orderId: order.id }, env.ctx)
    const before = snapshot(s)
    expect(() => issueWorkSheet({ orderId: order.id }, env.ctx)).toThrow(/لا يحتاج أمر تصنيع/)
    expect(snapshot(s)).toEqual(before)
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(finishedGoodsCostForOrder(order.id))
  })

  it('legacy: a pre-fix customer MO that covered the standard line blocks stock fulfilment', () => {
    const s = seed()
    produce(s.productId, 2)
    const order = standardOrder(s.customerId, s.productId)
    raw().prepare("INSERT INTO work_sheets (document_number, order_id, quantity_micro, status, issued_at, created_at) VALUES ('MO-LEGACY', ?, 0, 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run(order.id)
    expect(() => issueStockForOrder({ orderId: order.id }, env.ctx)).toThrow(/قبل إكمال أمر التصنيع/)
    expect(onHandMicro(s.productId)).toBe(q(2))
  })
})

describe('A–E: standard sale uses ready stock only', () => {
  it('A/B: sold from finished goods exactly once, never customer manufacturing', () => {
    const s = seed()
    produce(s.productId, 4)
    const order = standardOrder(s.customerId, s.productId)
    expect(getOrder(order.id).workflow).toMatchObject({ needsManufacturing: false, standardStockPending: true })
    issueStockForOrder({ orderId: order.id }, env.ctx)
    expect(onHandMicro(s.productId)).toBe(q(3))
    expect(() => issueStockForOrder({ orderId: order.id }, env.ctx)).toThrow(/بالفعل|غير مؤكد أو مكتمل/)
    expect(onHandMicro(s.productId)).toBe(q(3))
    expect(count('SELECT COUNT(*) AS c FROM work_sheets WHERE order_id = ?', order.id)).toBe(0)
    expect(getOrder(order.id).workflow.standardStockPending).toBe(false)
  })

  it('C/D: last ready unit sold → غير متوفر, product stays in the catalog', () => {
    const s = seed()
    produce(s.productId, 1)
    const ready = () => listFinishedGoods({ productId: s.productId })[0]!.onHandMicro
    expect([ready(), standardProductAvailability(ready())]).toEqual([q(1), 'متوفر'])
    issueStockForOrder({ orderId: standardOrder(s.customerId, s.productId).id }, env.ctx)
    expect([ready(), standardProductAvailability(ready())]).toEqual([0, 'غير متوفر'])
    expect(listProducts().map((product) => product.id)).toContain(s.productId)
  })

  it('E: no Production Preparation or Manufacturing Order for a standard-only order', () => {
    const s = seed()
    const order = standardOrder(s.customerId, s.productId)
    const before = snapshot(s)
    expect(() => savePlannedMaterials({ orderId: order.id }, [{ materialId: s.mdf, materialName: 'MDF', qtyMicro: q(3) }] as never, env.ctx))
      .toThrow(/تجهيز الإنتاج مخصص للبنود المخصّصة/)
    expect(() => issueWorkSheet({ orderId: order.id }, env.ctx)).toThrow(/لا يحتاج أمر تصنيع/)
    expect(snapshot(s)).toEqual(before)
  })
})

describe('F–M: «صرف من المخزون» (BOM × produced quantity)', () => {
  it('F: quantity 4 consumes BOM × 4 and adds exactly 4 ready units', () => {
    const s = seed()
    const before = snapshot(s)
    const preview = standardStockIssuePreview({ productId: s.productId, quantityMicro: q(4) })
    expect(preview).toMatchObject({ canIssue: true, readyMicro: 0, readyAfterMicro: q(4) })
    expect(preview.lines.map((line) => line.qtyMicro)).toEqual([q(12), q(32), q(16)])
    produce(s.productId, 4)
    const after = snapshot(s)
    expect(before.mdf - after.mdf).toBe(q(12))
    expect(before.hinge - after.hinge).toBe(q(32))
    expect(before.handle - after.handle).toBe(q(16))
    expect(after.ready).toBe(q(4))
    // This fixture configures no machines or commissions; the same one-step
    // path now posts them when the Standard Product defines them.
    const sheet = raw().prepare('SELECT order_id AS orderId, status FROM work_sheets').get() as { orderId: number | null; status: string }
    expect(sheet).toEqual({ orderId: null, status: 'completed' })
    expect(count('SELECT COUNT(*) AS c FROM order_machine_usage')).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM order_worker_assignments')).toBe(0)
  })

  it('G: existing 2 + produced 4 = 6', () => {
    const s = seed(30)
    produce(s.productId, 2)
    produce(s.productId, 4)
    expect(onHandMicro(s.productId)).toBe(q(6))
  })

  it('H: insufficient for the full quantity rejects everything (no partial 3)', () => {
    const s = seed(10) // MDF for 3 units only
    const before = snapshot(s)
    expect(standardStockIssuePreview({ productId: s.productId, quantityMicro: q(4) })).toMatchObject({ canIssue: false })
    expect(() => produce(s.productId, 4)).toThrow(/المواد غير كافية لتصنيع الكمية كاملة: MDF/)
    expect(snapshot(s)).toEqual(before)
  })

  it('I: a finished-goods failure rolls back all material consumption', () => {
    const s = seed()
    const before = snapshot(s)
    raw().exec("CREATE TEMP TRIGGER bl04_fail_fg BEFORE INSERT ON finished_goods_movements BEGIN SELECT RAISE(ABORT, 'fg boom'); END")
    expect(() => produce(s.productId, 4)).toThrow(/fg boom/)
    expect(snapshot(s)).toEqual(before)
  })

  it('J: a failure on any BOM component rolls back the whole operation', () => {
    const s = seed()
    const before = snapshot(s)
    raw().exec(`CREATE TEMP TRIGGER bl04_fail_handle BEFORE INSERT ON inventory_movements WHEN NEW.material_id = ${s.handle} BEGIN SELECT RAISE(ABORT, 'handle boom'); END`)
    expect(() => produce(s.productId, 4)).toThrow(/handle boom/)
    expect(snapshot(s)).toEqual(before)
  })

  it('K: retry/double request is idempotent; invalid quantities are rejected', () => {
    const s = seed()
    const first = produce(s.productId, 2, 'same-request-key')
    const after = snapshot(s)
    expect(produce(s.productId, 2, 'same-request-key')).toEqual(first)
    expect(snapshot(s)).toEqual(after)
    expect(() => produce(s.productId, 3, 'same-request-key')).toThrow(/لعملية مختلفة/)
    for (const quantityMicro of [0, -q(1), q(1) / 2, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => issueStandardStockFromBom({ productId: s.productId, quantityMicro, requestKey: `bad-${quantityMicro}-key` }, env.ctx)).toThrow()
    }
    expect(snapshot(s)).toEqual(after)
  })

  it('K: the service itself requires both products.manage and inventory.consume', () => {
    const s = seed()
    const before = snapshot(s)
    const restricted = (permissions: string[]) => ({ ...env.ctx, session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions } })
    for (const permissions of [['products.manage'], ['inventory.consume']]) {
      expect(() => issueStandardStockFromBom({ productId: s.productId, quantityMicro: q(1), requestKey: `rbac-${permissions[0]}` }, restricted(permissions) as never)).toThrow()
    }
    expect(snapshot(s)).toEqual(before)
  })

  it('L/M: FIFO actual cost becomes finished-goods cost and reaches COGS exactly once', () => {
    const s = seed()
    const result = produce(s.productId, 4)
    // MDF 12 = 10 × 100 + 2 × 200; hinges 32 × 2; handles 16 × 5.
    const expected = moneyFromMajor(10 * 100 + 2 * 200 + 32 * 2 + 16 * 5)
    expect(result.totalCostMinor).toBe(expected)
    expect(listFinishedGoods({ productId: s.productId })[0]!.onHandValueMinor).toBe(expected)
    const order = standardOrder(s.customerId, s.productId)
    issueStockForOrder({ orderId: order.id }, env.ctx)
    const cost = orderCostBreakdown(order.id)
    expect(finishedGoodsCostForOrder(order.id)).toBe(expected / 4)
    expect(cost.materialCostMinor).toBe(expected / 4)
    expect(count('SELECT COUNT(*) AS c FROM order_material_lines WHERE order_id = ?', order.id)).toBe(0)
    expect(listFinishedGoods({ productId: s.productId })[0]!.onHandValueMinor).toBe(expected - expected / 4)
  })

  it('L: CP-2 full-unit material keeps physical FIFO cost with its full-unit commercial charge', () => {
    const s = seed()
    const band = createMaterial({ sku: 'BAND', name: 'شريط', categoryId: s.categoryId, unit: 'لفة', currentMarketPriceMicro: unitCostFromMajor(10), pricingRule: 'full_unit', commercialUnitSizeMicro: q(1) } as never, env.ctx)
    createPurchase({ supplierId: s.supplierId, lines: [{ materialId: band, qtyMicro: q(5), unitCostMicro: unitCostFromMajor(8) }] }, env.ctx)
    const productId = createProduct({ code: 'W-B', name: 'خزانة B', defaultPriceMinor: 0 }, env.ctx)
    replaceBom(productId, [{ materialId: band, qtyMicro: q(0.25), unit: 'لفة' }], env.ctx)
    produce(productId, 3)
    const line = raw().prepare('SELECT physical_qty_micro AS p, actual_cost_minor AS a, commercial_qty_micro AS c, pricing_rule_used AS r FROM order_material_lines WHERE material_id = ?').get(band)
    expect(line).toEqual({ p: q(0.75), a: moneyFromMajor(6), c: q(1), r: 'full_unit' })
    expect(availableQty(band)).toBe(q(4.25))
  })
})

describe('N–P: zero stock, mixed orders, custom manufacturing', () => {
  it('N: zero-ready order stays pending — no negative stock, no manufacturing, no false fulfilment', () => {
    const s = seed()
    const order = standardOrder(s.customerId, s.productId)
    expect(() => issueStockForOrder({ orderId: order.id }, env.ctx)).toThrow(/المخزون الجاهز غير كافٍ/)
    expect(onHandMicro(s.productId)).toBe(0)
    expect(() => issueWorkSheet({ orderId: order.id }, env.ctx)).toThrow(/لا يحتاج أمر تصنيع/)
    // Exit permit / completion are the commitment point: refused while ready stock is short.
    expect(() => issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)).toThrow(/المخزون الجاهز غير كافٍ/)
    expect(() => completeOrder({ orderId: order.id }, env.ctx)).toThrow(/إذن خروج فعّال/)
    expect(count('SELECT COUNT(*) AS c FROM releases WHERE order_id = ?', order.id)).toBe(0)
    expect(getOrder(order.id).order.status).toBe('confirmed')
    expect(getOrder(order.id).workflow.standardStockPending).toBe(true)
    expect(onHandMicro(s.productId)).toBe(0)
    produce(s.productId, 1)
    // The permit itself issues the ready unit, exactly once.
    expect(issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx).documentNumber).toBeTruthy()
    expect(onHandMicro(s.productId)).toBe(0)
    expect(count("SELECT COUNT(*) AS c FROM finished_goods_movements WHERE order_id = ? AND kind = 'sale_out'", order.id)).toBe(1)
    expect(getOrder(order.id).workflow.standardStockPending).toBe(false)
  })

  it('O/P: mixed order — custom line manufactured, standard line from stock, no cross-over', () => {
    const s = seed()
    produce(s.productId, 2)
    const invoice = createFinalInvoice({ customerId: s.customerId, lines: [
      { lineKind: 'custom', description: 'مطبخ مخصص', quantityMicro: q(1), unitPriceMinor: moneyFromMajor(5000) },
      { lineKind: 'standard', productId: s.productId, description: 'خزانة A', quantityMicro: q(1), unitPriceMinor: moneyFromMajor(3000) }
    ] }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
    // Approval seeded no standard BOM into the customer plan.
    expect(listPlannedMaterials({ orderId: order.id })).toHaveLength(0)
    expect(getOrder(order.id).workflow).toMatchObject({ needsManufacturing: true, standardStockPending: true })
    savePlannedMaterials({ orderId: order.id }, [{ materialId: s.hinge, materialName: 'مفصلة', qtyMicro: q(6) }] as never, env.ctx)
    const hingeBefore = availableQty(s.hinge)
    const mdfBefore = availableQty(s.mdf)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    expect(hingeBefore - availableQty(s.hinge)).toBe(q(6))
    expect(availableQty(s.mdf)).toBe(mdfBefore)
    const covered = JSON.parse((raw().prepare('SELECT document_snapshot AS s FROM work_sheets WHERE id = ?').get(sheet.id) as { s: string }).s).sourceLines
    expect(covered.map((line: { description: string }) => line.description)).toEqual(['مطبخ مخصص'])
    // Release waits for the custom manufacturing, then issues the standard line from stock.
    expect(() => issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)).toThrow(/قبل إكمال أمر التصنيع/)
    expect(() => completeOrder({ orderId: order.id }, env.ctx)).toThrow(/إذن خروج فعّال/)
    expect(getOrder(order.id).order.status).toBe('confirmed')
    expect(onHandMicro(s.productId)).toBe(q(2))
    startProduction(sheet.id, env.ctx)
    completeProduction(sheet.id, env.ctx)
    const permit = issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)
    expect(permit.documentNumber).toBeTruthy()
    expect(onHandMicro(s.productId)).toBe(q(1))
    expect(getOrder(order.id).order.status).toBe('confirmed')
    recordDelivery({ orderId: order.id, releaseId: permit.id, kind: 'handover' }, env.ctx)
    expect(getOrder(order.id).order.status).toBe('completed')
    expect(count("SELECT COUNT(*) AS c FROM finished_goods_movements WHERE order_id = ? AND kind = 'sale_out'", order.id)).toBe(1)
    expect(availableQty(s.mdf)).toBe(mdfBefore)
    expect(() => issueStockForOrder({ orderId: order.id }, env.ctx)).toThrow(/بالفعل|غير مؤكد أو مكتمل/)
    const cost = orderCostBreakdown(order.id)
    expect(cost.materialCostMinor).toBe(moneyFromMajor(12) + finishedGoodsCostForOrder(order.id))
  })

  it('P: a custom-only order keeps preparation → MO → manufacturing → release', () => {
    const s = seed()
    const order = approveToOrder(createFinalInvoice({ customerId: s.customerId, lines: [
      { lineKind: 'custom', description: 'مطبخ', quantityMicro: q(1), unitPriceMinor: moneyFromMajor(5000) }
    ] }, env.ctx).id, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
    expect(getOrder(order.id).workflow).toMatchObject({ needsManufacturing: true, standardStockPending: false })
    savePlannedMaterials({ orderId: order.id }, [{ materialId: s.mdf, materialName: 'MDF', qtyMicro: q(2) }] as never, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    expect(availableQty(s.mdf)).toBe(q(18))
    completeProduction(sheet.id, env.ctx)
    expect(issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx).documentNumber).toBeTruthy()
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(moneyFromMajor(200))
  })
})
