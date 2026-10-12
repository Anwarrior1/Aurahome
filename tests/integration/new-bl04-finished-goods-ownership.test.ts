import type { IpcMainInvokeEvent } from 'electron'
import { withTransaction } from '@main/db/transactions'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier, createCustomer } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createProduct } from '@main/services/products/products.service'
import { createStandardFinalInvoice } from '@main/services/sales/final-invoices.service'
import { fulfillFromStock, supplyStandardLinesFromStock, cancelOrder } from '@main/services/sales/orders.service'
import { issueStandardStockFromBom, issueRelease } from '@main/services/production/production.service'
import { postFinishedGoodsProduction, issueFromStock, onHandMicro, reverseFinishedGoodsIssue, reverseFinishedGoodsIssuesForOrder } from '@main/services/production/finished-goods.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { moneyFromMajor as m } from '@shared/money/money'
import { unitCostFromMajor as c } from '@shared/money/cost'
let env: TestEnv
let material: number
let product: number
let order: number
const raw = () => getRawConnection()
function snapshot() {
  return Object.fromEntries((raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
beforeEach(() => {
  env = setupTestDatabase()
  material = createMaterial({ sku: 'BOARD', name: 'Board', unit: 'board', categoryId: createCategory({ name: 'Boards' }, env.ctx), pricingRule: 'exact', currentMarketPriceMicro: c(100) }, env.ctx)
  createPurchase({ supplierId: createSupplier({ name: 'Supplier' }, env.ctx), lines: [{ materialId: material, qtyMicro: q(100), unitCostMicro: c(100) }] }, env.ctx)
  product = createProduct({ code: 'CABINET', name: 'Cabinet', bom: [{ materialId: material, qtyMicro: q(2), unit: 'board' }] }, env.ctx)
  order = approveToOrder(createStandardFinalInvoice({ customerId: createCustomer({ name: 'Customer' }, env.ctx), productId: product, quantityMicro: q(1), unitPriceMinor: m(500) }, env.ctx).id, env.ctx).id
})
afterEach(() => { try { expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); expect(raw().pragma('foreign_key_check')).toEqual([]) } finally { env.cleanup() } })
describe('NEW-BL-04 Standard Finished Goods lifecycle ownership', () => {
  it('blocks the legacy ready 2 -> 1 / zero permits direct command and lower-level sale', () => {
    issueStandardStockFromBom({ productId: product, quantityMicro: q(2), requestKey: 'new04-production' }, env.ctx)
    const before = snapshot()
    for (const attempt of [() => fulfillFromStock({ orderId: order }, env.ctx), () => supplyStandardLinesFromStock(order, env.ctx), () => issueFromStock({ productId: product, orderId: order, qtyMicro: q(1) }, env.ctx)]) {
      expect(attempt).toThrow(); expect(snapshot()).toEqual(before)
    }
    expect(onHandMicro(product)).toBe(q(2))
    expect(raw().prepare('SELECT COUNT(*) AS n FROM releases').get()).toEqual({ n: 0 })
  })
  it('blocks independent FG +10 with raw material 100 untouched', () => {
    const before = snapshot()
    expect(() => postFinishedGoodsProduction({ productId: product, qtyMicro: q(10), totalCostMinor: 0 }, env.ctx)).toThrow()
    expect(snapshot()).toEqual(before); expect(availableQty(material)).toBe(q(100)); expect(onHandMicro(product)).toBe(0)
  })
  it('preserves real BOM production, request replay, permit sale, cancellation restoration and repeat rejection', () => {
    const input = { productId: product, quantityMicro: q(2), requestKey: 'new04-production' }
    const production = issueStandardStockFromBom(input, env.ctx)
    expect(production.totalCostMinor).toBe(m(400)); expect(availableQty(material)).toBe(q(96)); expect(onHandMicro(product)).toBe(q(2))
    const produced = snapshot(); expect(issueStandardStockFromBom(input, env.ctx)).toEqual(production); expect(snapshot()).toEqual(produced)
    issueRelease({ orderId: order, kind: 'delivery' }, env.ctx)
    expect(onHandMicro(product)).toBe(q(1))
    const sold = snapshot(); expect(() => issueRelease({ orderId: order, kind: 'delivery' }, env.ctx)).toThrow(); expect(snapshot()).toEqual(sold)
    const id = (raw().prepare("SELECT id FROM finished_goods_movements WHERE kind='sale_out'").get() as { id: number }).id
    for (const attempt of [() => reverseFinishedGoodsIssue({ movementId: id, reason: 'independent' }, env.ctx), () => reverseFinishedGoodsIssuesForOrder(order, 'independent', env.ctx)]) { expect(attempt).toThrow(); expect(snapshot()).toEqual(sold) }
    cancelOrder({ orderId: order, reason: 'Before delivery' }, env.ctx)
    expect(onHandMicro(product)).toBe(q(2)); expect(availableQty(material)).toBe(q(96))
    expect(raw().prepare("SELECT COUNT(*) AS n FROM finished_goods_movements WHERE kind='sale_reversal'").get()).toEqual({ n: 1 })
    const cancelled = snapshot(); expect(() => cancelOrder({ orderId: order, reason: 'retry' }, env.ctx)).toThrow(); expect(snapshot()).toEqual(cancelled)
  })
  it('insufficient BOM materials and injected production audit failure leave no partial state', () => {
    const before = snapshot()
    expect(() => issueStandardStockFromBom({ productId: product, quantityMicro: q(51), requestKey: 'new04-insufficient' }, env.ctx)).toThrow()
    expect(snapshot()).toEqual(before)
    raw().exec("CREATE TRIGGER fail_fg_audit BEFORE INSERT ON audit_log WHEN NEW.action='finishedGoods.production' BEGIN SELECT RAISE(ABORT, 'injected FG failure'); END")
    expect(() => issueStandardStockFromBom({ productId: product, quantityMicro: q(2), requestKey: 'new04-audit-failure' }, env.ctx)).toThrow(/injected FG failure/)
    expect(snapshot()).toEqual(before)
    raw().exec('DROP TRIGGER fail_fg_audit')
  })
  it('a caller-created transaction does not authorize independent stock writers or completed-sheet replay', () => {
    const before = snapshot()
    expect(() => withTransaction(() => postFinishedGoodsProduction({ productId: product, qtyMicro: q(10), totalCostMinor: 0 }, env.ctx))).toThrow()
    expect(() => withTransaction(() => fulfillFromStock({ orderId: order }, env.ctx))).toThrow()
    expect(() => withTransaction(() => issueFromStock({ productId: product, orderId: order, qtyMicro: q(1) }, env.ctx))).toThrow()
    expect(snapshot()).toEqual(before)
    const result = issueStandardStockFromBom({ productId: product, quantityMicro: q(2), requestKey: 'new04-valid-owner' }, env.ctx)
    const completed = snapshot()
    expect(() => withTransaction(() => postFinishedGoodsProduction({ productId: product, workSheetId: result.workSheetId, qtyMicro: q(2), totalCostMinor: result.totalCostMinor }, env.ctx))).toThrow()
    expect(snapshot()).toEqual(completed)
  })
  it('rolls back the persisted permit and stock issue when issue audit fails', () => {
    issueStandardStockFromBom({ productId: product, quantityMicro: q(2), requestKey: 'new04-permit-failure' }, env.ctx)
    const before = snapshot()
    raw().exec("CREATE TRIGGER fail_sale_audit BEFORE INSERT ON audit_log WHEN NEW.action='finishedGoods.issue' BEGIN SELECT RAISE(ABORT, 'injected sale failure'); END")
    expect(() => issueRelease({ orderId: order, kind: 'delivery' }, env.ctx)).toThrow(/injected sale failure/)
    expect(snapshot()).toEqual(before)
    raw().exec('DROP TRIGGER fail_sale_audit')
  })
  it('supports multiple Standard lines for the same product without changing their per-line costing', () => {
    issueStandardStockFromBom({ productId: product, quantityMicro: q(4), requestKey: 'new04-multi-line' }, env.ctx)
    const invoice = createFinalInvoice({ customerId: createCustomer({ name: 'Multi-line customer' }, env.ctx), lines: [1, 2].map(n => ({ lineKind: 'standard' as const, productId: product, description: `Cabinet ${n}`, quantityMicro: q(1), unitPriceMinor: m(500) })) }, env.ctx)
    const multi = approveToOrder(invoice.id, env.ctx)
    issueRelease({ orderId: multi.id, kind: 'delivery' }, env.ctx)
    expect(onHandMicro(product)).toBe(q(2))
    expect(raw().prepare("SELECT COUNT(*) AS n, SUM(total_cost_minor) AS cost FROM finished_goods_movements WHERE kind='sale_out' AND order_id=?").get(multi.id)).toEqual({ n: 2, cost: m(400) })
  })
  it('IPC legacy route cannot issue stock; real production/permit IPC routes preserve authorization', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
    const invoke = (channel: string, request: unknown, id = 1) => handlers.get(channel)!({ sender: { id } } as IpcMainInvokeEvent, request)
    const production = { productId: product, quantityMicro: q(2), requestKey: 'new04-ipc-production' }
    expect(await invoke(C.products.issueStockFromBom, production)).toMatchObject({ ok: true })
    const before = snapshot()
    expect(await invoke(C.orders.fulfillFromStock, { orderId: order })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(snapshot()).toEqual(before)
    const role = createRole({ name: 'Legacy stock operator', permissions: ['orders.manage'] }, env.ctx)
    createUser({ username: 'legacy', password: 'secret123', fullName: 'Legacy', roleId: role }, env.ctx)
    login('legacy', 'secret123', 91)
    const restricted = snapshot()
    expect(await invoke(C.orders.fulfillFromStock, { orderId: order }, 91)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await invoke(C.production.issueRelease, { orderId: order, kind: 'delivery' }, 91)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await invoke(C.products.issueStockFromBom, { ...production, requestKey: 'new04-ipc-denied' }, 91)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(snapshot()).toEqual(restricted)
    expect(await invoke(C.production.issueRelease, { orderId: order, kind: 'delivery' })).toMatchObject({ ok: true })
    expect(onHandMicro(product)).toBe(q(1))
  })

})
