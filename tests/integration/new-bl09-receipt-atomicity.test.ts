import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { reconcileDatabase } from '@main/db/reconciliation'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase, updatePurchase } from '@main/services/purchasing/purchasing.service'
import { receiveStock, availableQty, adjustStock, recordOpeningStock } from '@main/services/inventory/inventory.service'
import { inventoryRepository } from '@main/repositories/inventory/inventory.repository'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
let material: number
let supplier: number
let purchase: number
const raw = () => getRawConnection()
function snapshot() {
  const tables = raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  return Object.fromEntries(tables.map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
function stock() { return inventoryRepository.stockByMaterial().find(row => row.materialId === material)! }
function reconciled() {
  expect(reconcileDatabase(raw()).findings.filter(row => row.severity === 'error' && ['inventory', 'purchasing', 'production'].includes(row.domain))).toEqual([])
}
function inject(kind: string, table = 'inventory_movements', column = 'kind') {
  raw().exec(`CREATE TRIGGER new09_fail BEFORE INSERT ON ${table} WHEN NEW.${column}='${kind}' BEGIN SELECT RAISE(ABORT, 'NEW09 injected failure'); END;`)
}
function failure(kind: string, command: () => unknown, table?: string, column?: string) {
  const before = snapshot(); const value = stock()
  inject(kind, table, column)
  try { expect(command).toThrow(/NEW09 injected failure/); expect(stock()).toEqual(value); expect(snapshot()).toEqual(before); reconciled() }
  finally { raw().exec('DROP TRIGGER new09_fail') }
}
function receipt(sourceKind: 'adjustment' | 'opening' = 'adjustment') {
  return receiveStock({ materialId: material, qtyMicro: q(10), unitCost: c(100), sourceKind, reason: 'Receipt', batchCode: 'NEW09', receivedAt: '2026-10-03T01:00:00.000Z', ctx: env.ctx })
}
beforeEach(() => {
  env = setupTestDatabase()
  material = createMaterial({ sku: 'BOARD', name: 'Board', categoryId: createCategory({ name: 'Boards' }, env.ctx), unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(100) }, env.ctx)
  supplier = createSupplier({ name: 'Supplier' }, env.ctx)
  purchase = createPurchase({ supplierId: supplier, lines: [{ materialId: material, qtyMicro: q(100), unitCostMicro: c(100) }] }, env.ctx).id
  reconciled()
})
afterEach(() => {
  try { expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); expect(raw().pragma('foreign_key_check')).toEqual([]) }
  finally { env.cleanup() }
})

describe('NEW-BL-09 atomic stock receipt service', () => {
  it.each(['adjustment', 'opening'] as const)('direct %s failure preserves 100 / value, retry receives only 10 / 1000 LYD', source => {
    const before = stock(); const kind = source === 'adjustment' ? 'adjustment_in' : 'opening'
    failure(kind, () => receipt(source))
    expect(availableQty(material)).toBe(q(100)); expect(stock().fifoValueMinor).toBe(m(10000))
    const result = receipt(source)
    expect(stock()).toMatchObject({ qtyMicro: q(110), fifoValueMinor: before.fifoValueMinor + m(1000) })
    expect(raw().prepare('SELECT material_id, kind, qty_micro, actual_cost_minor, source_kind, source_ref_id, created_by, created_at FROM inventory_movements WHERE id=?').get(result.movementId)).toEqual({ material_id: material, kind, qty_micro: q(10), actual_cost_minor: m(1000), source_kind: source, source_ref_id: null, created_by: env.ctx.session.user.id, created_at: '2026-10-03T01:00:00.000Z' })
    expect(raw().prepare('SELECT qty_received_micro, qty_remaining_micro, unit_cost_micro, batch_code FROM fifo_layers WHERE id=?').get(result.layerId)).toEqual({ qty_received_micro: q(10), qty_remaining_micro: q(10), unit_cost_micro: c(100), batch_code: 'NEW09' })
    expect(raw().prepare('SELECT COUNT(*) AS n FROM fifo_layers').get()).toEqual({ n: 2 }); reconciled()
  })
  it('caller-created transaction rolls back movement failure and may catch it without committing partial FIFO', () => {
    failure('adjustment_in', () => withTransaction(() => receipt()))
    const before = snapshot(); inject('adjustment_in')
    try { withTransaction(() => { expect(() => receipt()).toThrow(/NEW09 injected failure/) }); expect(snapshot()).toEqual(before) }
    finally { raw().exec('DROP TRIGGER new09_fail') }
    reconciled()
  })
  it('successful nested receipt does not commit past a later outer rollback', () => {
    const before = snapshot()
    expect(() => withTransaction(() => { receipt(); expect(availableQty(material)).toBe(q(110)); throw new Error('outer rollback') })).toThrow('outer rollback')
    expect(snapshot()).toEqual(before); reconciled()
  })
  it('preserves multiple existing FIFO layers on failure and adds exactly one layer on retry', () => {
    updatePurchase(purchase, { lines: [{ materialId: material, qtyMicro: q(60), unitCostMicro: c(80) }] }, env.ctx)
    createPurchase({ supplierId: supplier, lines: [{ materialId: material, qtyMicro: q(40), unitCostMicro: c(120) }] }, env.ctx)
    const layers = raw().prepare('SELECT * FROM fifo_layers ORDER BY id').all(); const value = stock().fifoValueMinor
    failure('adjustment_in', () => receipt()); expect(raw().prepare('SELECT * FROM fifo_layers ORDER BY id').all()).toEqual(layers)
    receipt(); expect(stock()).toMatchObject({ qtyMicro: q(110), fifoValueMinor: value + m(1000) })
    expect(raw().prepare('SELECT COUNT(*) AS n FROM fifo_layers').get()).toEqual({ n: 3 }); reconciled()
  })
  it('purchase creation rolls back parent/payment/cash/audit on movement failure, then legitimate purchase commits once', () => {
    const account = createAccount({ name: 'Cash', kind: 'cash', openingBalanceMinor: m(20000) }, env.ctx)
    const input = { supplierId: supplier, lines: [{ materialId: material, qtyMicro: q(10), unitCostMicro: c(100) }], paidNowMinor: m(500), cashAccountId: account, requestKey: 'new09-purchase-retry' }
    const cash = accountBalance(account)
    failure('purchase', () => createPurchase(input, env.ctx))
    const result = createPurchase(input, env.ctx)
    expect(result.totalMinor).toBe(m(1000)); expect(accountBalance(account)).toBe(cash - m(500))
    expect(raw().prepare("SELECT m.qty_micro, m.actual_cost_minor, m.source_kind FROM inventory_movements m JOIN purchase_lines l ON l.id=m.source_ref_id WHERE m.source_kind='purchase' AND l.purchase_id=?").all(result.id)).toEqual([{ qty_micro: q(10), actual_cost_minor: m(1000), source_kind: 'purchase' }])
    expect(raw().prepare('SELECT paid_minor FROM purchases WHERE id=?').get(result.id)).toEqual({ paid_minor: m(500) })
    expect(stock()).toMatchObject({ qtyMicro: q(110), fifoValueMinor: m(11000) })
    expect(raw().prepare("SELECT COUNT(*) AS n FROM inventory_movements WHERE kind='purchase'").get()).toEqual({ n: 2 })
    const committed = snapshot(); expect(createPurchase(input, env.ctx).id).toBe(result.id); expect(snapshot()).toEqual(committed); reconciled()
  })
  it('unused purchase correction restores deleted old artifacts if the replacement receipt movement fails', () => {
    const input = { lines: [{ materialId: material, qtyMicro: q(110), unitCostMicro: c(100) }] }
    failure('purchase', () => updatePurchase(purchase, input, env.ctx))
    updatePurchase(purchase, input, env.ctx)
    expect(stock()).toMatchObject({ qtyMicro: q(110), fifoValueMinor: m(11000) })
    expect(raw().prepare('SELECT COUNT(*) AS n FROM fifo_layers').get()).toEqual({ n: 1 }); reconciled()
  })
  it.each(['adjustment', 'opening'] as const)('legitimate %s owner rejects failed movement with no partial state then succeeds', owner => {
    const command = () => owner === 'adjustment' ? adjustStock({ materialId: material, qtyMicro: q(10), unitCost: c(100), direction: 'in', reason: 'Correction', ctx: env.ctx }) : recordOpeningStock({ materialId: material, qtyMicro: q(10), unitCostMicro: c(100) }, env.ctx)
    failure(owner === 'adjustment' ? 'adjustment_in' : 'opening', command)
    command(); expect(stock()).toMatchObject({ qtyMicro: q(110), fifoValueMinor: m(11000) }); reconciled()
  })
  it('preserves outer purchase audit rollback after its nested receipt has succeeded', () => {
    failure('purchases.create', () => createPurchase({ supplierId: supplier, lines: [{ materialId: material, qtyMicro: q(10), unitCostMicro: c(100) }] }, env.ctx), 'audit_log', 'action')
    expect(availableQty(material)).toBe(q(100))
  })
  it.each(['purchase', 'correction', 'adjustment'])('registered IPC %s retains permissions and movement failure rollback', async owner => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>()
    const electron = await import('electron'); const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
    const role = createRole({ name: 'Restricted', permissions: [] }, env.ctx); createUser({ username: 'restricted', password: 'secret123', fullName: 'Restricted', roleId: role }, env.ctx); login('restricted', 'secret123', 92)
    const channel = owner === 'purchase' ? C.purchases.create : owner === 'correction' ? C.purchases.update : C.inventory.adjust
    const input = owner === 'purchase' ? { supplierId: supplier, requestKey: 'new09-ipc-purchase', lines: [{ materialId: material, qtyMicro: q(10), unitCostMicro: c(100) }] } : owner === 'correction' ? { id: purchase, lines: [{ materialId: material, qtyMicro: q(110), unitCostMicro: c(100) }] } : { materialId: material, qtyMicro: q(10), unitCostMicro: c(100), direction: 'in', reason: 'Correction' }
    const invoke = (id: number) => handlers.get(channel)!({ sender: { id } } as IpcMainInvokeEvent, input)
    const before = snapshot(); expect(await invoke(92)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } }); expect(snapshot()).toEqual(before)
    inject(owner === 'adjustment' ? 'adjustment_in' : 'purchase')
    try { expect(await invoke(1)).toMatchObject({ ok: false }); expect(snapshot()).toEqual(before); reconciled() }
    finally { raw().exec('DROP TRIGGER new09_fail') }
    expect(await invoke(1)).toMatchObject({ ok: true }); expect(stock()).toMatchObject({ qtyMicro: q(110), fifoValueMinor: m(11000) }); reconciled()
  })
})
