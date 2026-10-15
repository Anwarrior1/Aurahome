import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { reconcileDatabase } from '@main/db/reconciliation'
import { login } from '@main/auth/auth.service'
import * as admin from '@main/services/admin/users.service'
import * as catalog from '@main/services/catalog/catalog.service'
import * as products from '@main/services/products/products.service'
import * as parties from '@main/services/parties/parties.service'
import * as machines from '@main/services/production/machines.service'
import * as workers from '@main/services/production/workers.service'
import * as invoices from '@main/services/sales/final-invoices.service'
import * as quotations from '@main/services/sales/quotations.service'
import * as orders from '@main/services/sales/orders.service'
import * as inventory from '@main/services/inventory/inventory.service'
import * as purchasing from '@main/services/purchasing/purchasing.service'
import * as expenses from '@main/services/finance/expenses.service'
import * as cash from '@main/services/finance/cash.service'
import * as settings from '@main/services/settings.service'
import type { ServiceContext } from '@main/services/base/service.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'

let env: TestEnv
let sequence = 68000
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let f: { category: number; type: number; material: number; product: number; machine: number; worker: number; customer: number; supplier: number; account: number }
const db = () => getRawConnection()
const key = () => `POSTBL01-${++sequence}`
const scalar = (sql: string, ...args: (string | number)[]) => (db().prepare(sql).get(...args) as { value: number }).value
function snapshot() {
  const tables = db().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  return Object.fromEntries(tables.map(({ name }) => [name, db().prepare(`SELECT * FROM "${name}"`).all()]))
}
function actor(permissions: string[]) {
  const windowId = ++sequence
  const roleId = admin.createRole({ name: key(), permissions }, env.ctx)
  const username = key()
  admin.createUser({ username, password: 'secret123', fullName: 'Operator', roleId }, env.ctx)
  return { windowId, ctx: { session: login(username, 'secret123', windowId).session } }
}
function businessOnly(state: ReturnType<typeof snapshot>) {
  return Object.fromEntries(Object.entries(state).filter(([name]) => name !== 'audit_log' && name !== 'financial_command_requests'))
}
const call = (channel: string, request: unknown, windowId: number) => handlers.get(channel)!({ sender: { id: windowId } } as IpcMainInvokeEvent, request)
const materialInput = () => ({ sku: key(), name: key(), categoryId: f.category, unit: 'board', pricingRule: 'exact' as const, currentMarketPriceMicro: c(100) })
const newMaterial = () => catalog.createMaterial(materialInput(), env.ctx)
const newProduct = () => products.createProduct({ code: key(), name: key(), defaultPriceMinor: m(10000) }, env.ctx)
const draft = () => invoices.createFinalInvoice({ customerId: f.customer, depositPercentBp: 0, termIndexes: [], lines: [{ lineKind: 'custom', description: 'Cabinet', quantityMicro: q(1), unitPriceMinor: m(10000) }] }, env.ctx).id
const quotationInput = () => ({ customerId: f.customer, lines: [{ lineKind: 'custom' as const, description: 'Cabinet', quantityMicro: q(1), unitPriceMinor: m(10000) }] })
const quote = () => quotations.createQuotation(quotationInput(), env.ctx).id
const newSupplier = () => parties.createSupplier({ name: key() }, env.ctx)
const newCategory = () => catalog.createCategory({ name: key() }, env.ctx)
const newExpenseCategory = () => expenses.createCategory({ name: key(), kind: 'variable' }, env.ctx)

beforeEach(async () => {
  env = setupTestDatabase()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'))
  const category = catalog.createCategory({ name: key() }, env.ctx)
  const family = catalog.createCategory({ name: key(), parentId: category }, env.ctx)
  const type = catalog.createCategory({ name: key(), parentId: family }, env.ctx)
  f = { category, type, material: 0, product: 0, machine: 0, worker: 0, customer: 0, supplier: 0, account: 0 }
  f.material = newMaterial(); f.product = newProduct()
  f.machine = machines.createMachine({ name: key(), costingUnit: 'hour', defaultRateMicro: c(10) }, env.ctx)
  f.worker = workers.createWorker({ name: key() }, env.ctx)
  f.customer = parties.createCustomer({ name: key() }, env.ctx)
  f.supplier = newSupplier()
  f.account = cash.createAccount({ name: key(), kind: 'cash', openingBalanceMinor: m(10000) }, env.ctx)
  purchasing.createPurchase({ supplierId: f.supplier, lines: [{ materialId: f.material, qtyMicro: q(100), unitCostMicro: c(100) }] }, env.ctx)
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((name: string, handler: never) => handlers.set(name, handler)) as never)
  try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
})
afterEach(() => {
  vi.useRealTimers()
  try {
    expect(db().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db().pragma('foreign_key_check')).toEqual([])
    expect(reconcileDatabase(db()).findings).toEqual([])
  } finally { env.cleanup() }
})

type Prepared = { request: object; run: (ctx: ServiceContext) => unknown; verify?: () => void }
type Operation = { name: string; permission: string; channel?: string; retiredIPC?: boolean; restrictedPermissions?: string[]; prepare: () => Prepared }
const operations: Operation[] = [
  { name: 'settings.setSettingInternal/public-key', permission: P.settings.manage, channel: C.settings.set, prepare: () => { const value = key(); return { request: { key: settings.SETTING_KEYS.companyName, value }, run: ctx => settings.setSettingInternal(settings.SETTING_KEYS.companyName, value, ctx) } } },
  { name: 'products.updateProduct', permission: P.products.manage, channel: C.products.update, prepare: () => { const input = { name: key() }; return { request: { id: f.product, ...input }, run: ctx => products.updateProduct(f.product, input, ctx) } } },
  { name: 'products.replaceBom', permission: P.products.manage, channel: C.products.setBom, prepare: () => { const id = newProduct(); const lines = [{ materialId: f.material, qtyMicro: q(2), unit: 'board' }]; return { request: { productId: id, lines }, run: ctx => products.replaceBom(id, lines, ctx) } } },
  { name: 'products.replaceProductMachines', permission: P.products.manage, channel: C.products.setMachines, prepare: () => { const id = newProduct(); const lines = [{ machineId: f.machine, usageQtyMicro: q(1) }]; return { request: { productId: id, lines }, run: ctx => products.replaceProductMachines(id, lines, ctx) } } },
  { name: 'products.fullDeleteProduct', permission: P.products.fullDelete, channel: C.products.fullDelete, prepare: () => { const id = newProduct(); const confirmation = products.getProduct(id).product.code; return { request: { id, confirmation }, run: ctx => products.fullDeleteProduct({ id, confirmation }, ctx) } } },
  { name: 'machines.createMachine', permission: P.machines.manage, channel: C.machines.create, prepare: () => { const input = { name: key(), costingUnit: 'hour', defaultRateMicro: c(10) }; return { request: input, run: ctx => machines.createMachine(input, ctx) } } },
  { name: 'machines.updateMachine', permission: P.machines.manage, channel: C.machines.update, prepare: () => { const input = { name: key() }; return { request: { id: f.machine, ...input }, run: ctx => machines.updateMachine(f.machine, input, ctx) } } },
  { name: 'machines.deleteMachine', permission: P.machines.manage, channel: C.machines.remove, prepare: () => { const id = machines.createMachine({ name: key(), costingUnit: 'hour', defaultRateMicro: c(1) }, env.ctx); return { request: { id }, run: ctx => machines.deleteMachine(id, ctx) } } },
  { name: 'workers.createWorker', permission: P.workers.manage, channel: C.workers.create, prepare: () => { const input = { name: key() }; return { request: input, run: ctx => workers.createWorker(input, ctx) } } },
  { name: 'workers.updateWorker', permission: P.workers.manage, channel: C.workers.update, prepare: () => { const input = { name: key() }; return { request: { id: f.worker, ...input }, run: ctx => workers.updateWorker(f.worker, input, ctx) } } },
  { name: 'workers.deleteWorker', permission: P.workers.manage, channel: C.workers.remove, prepare: () => { const id = workers.createWorker({ name: key() }, env.ctx); return { request: { id }, run: ctx => workers.deleteWorker(id, ctx) } } },
  { name: 'admin.deleteRole', permission: P.roles.manage, channel: C.admin.deleteRole, prepare: () => { const name = key(); const id = admin.createRole({ name, permissions: [] }, env.ctx); return { request: { id, confirmation: name }, run: ctx => admin.deleteRole({ id, confirmation: name }, ctx) } } },
  { name: 'expenses.createCategory', permission: P.expenses.manage, channel: C.expenses.createCategory, prepare: () => { const input = { name: key(), kind: 'variable' as const }; return { request: input, run: ctx => expenses.createCategory(input, ctx) } } },
  { name: 'expenses.updateCategory', permission: P.expenses.manage, channel: C.expenses.updateCategory, prepare: () => { const id = newExpenseCategory(); const input = { name: key() }; return { request: { id, ...input }, run: ctx => expenses.updateCategory(id, input, ctx) } } },
  { name: 'expenses.deleteCategory', permission: P.expenses.manage, channel: C.expenses.removeCategory, prepare: () => { const id = newExpenseCategory(); return { request: { id }, run: ctx => expenses.deleteCategory(id, ctx) } } },
  { name: 'parties.createCustomer', permission: P.customers.manage, channel: C.customers.create, prepare: () => { const input = { name: key() }; return { request: input, run: ctx => parties.createCustomer(input, ctx) } } },
  { name: 'parties.createSupplier', permission: P.suppliers.manage, channel: C.suppliers.create, prepare: () => { const input = { name: key() }; return { request: input, run: ctx => parties.createSupplier(input, ctx) } } },
  { name: 'parties.updateSupplier', permission: P.suppliers.manage, channel: C.suppliers.update, prepare: () => { const input = { name: key() }; return { request: { id: f.supplier, ...input }, run: ctx => parties.updateSupplier(f.supplier, input, ctx) } } },
  { name: 'parties.deleteSupplier', permission: P.suppliers.manage, channel: C.suppliers.remove, prepare: () => { const id = newSupplier(); return { request: { id }, run: ctx => parties.deleteSupplier(id, ctx) } } },
  { name: 'parties.fullDeleteSupplier', permission: P.suppliers.fullDelete, channel: C.suppliers.fullDelete, prepare: () => { const name = key(); const id = parties.createSupplier({ name }, env.ctx); return { request: { id, confirmation: name }, run: ctx => parties.fullDeleteSupplier({ id, confirmation: name }, ctx) } } },
  { name: 'parties.archiveCustomer', permission: P.customers.archive, restrictedPermissions: [P.customers.manage], channel: C.customers.archive, prepare: () => { const id = parties.createCustomer({ name: key() }, env.ctx); return { request: { id }, run: ctx => parties.archiveCustomer(id, ctx) } } },
  { name: 'parties.restoreCustomer', permission: P.customers.archive, restrictedPermissions: [P.customers.manage], channel: C.customers.restore, prepare: () => { const id = parties.createCustomer({ name: key() }, env.ctx); parties.archiveCustomer(id, env.ctx); return { request: { id }, run: ctx => parties.restoreCustomer(id, ctx) } } },
  { name: 'catalog.createCategory', permission: P.materials.manage, channel: C.categories.create, prepare: () => { const input = { name: key() }; return { request: input, run: ctx => catalog.createCategory(input, ctx) } } },
  { name: 'catalog.updateCategory', permission: P.materials.manage, channel: C.categories.update, prepare: () => { const id = newCategory(); const input = { name: key() }; return { request: { id, ...input }, run: ctx => catalog.updateCategory(id, input, ctx) } } },
  { name: 'catalog.deleteCategory', permission: P.materials.manage, channel: C.categories.remove, prepare: () => { const id = newCategory(); return { request: { id }, run: ctx => catalog.deleteCategory(id, ctx) } } },
  { name: 'catalog.createColor', permission: P.colors.manage, channel: C.colors.create, prepare: () => { const input = { code: key(), name: key() }; return { request: input, run: ctx => catalog.createColor(input, ctx) } } },
  { name: 'catalog.updateColor', permission: P.colors.manage, channel: C.colors.update, prepare: () => { const id = catalog.createColor({ code: key(), name: key() }, env.ctx); const input = { name: key() }; return { request: { id, ...input }, run: ctx => catalog.updateColor(id, input, ctx) } } },
  { name: 'catalog.deleteColor', permission: P.colors.manage, channel: C.colors.remove, prepare: () => { const id = catalog.createColor({ code: key(), name: key() }, env.ctx); return { request: { id }, run: ctx => catalog.deleteColor(id, ctx) } } },
  { name: 'catalog.createMaterial', permission: P.materials.manage, channel: C.materials.create, prepare: () => { const input = materialInput(); return { request: input, run: ctx => catalog.createMaterial(input, ctx) } } },
  { name: 'catalog.createChildMaterial', permission: P.materials.manage, channel: C.categories.createChildMaterial, prepare: () => { const { sku, name, unit, pricingRule, currentMarketPriceMicro } = materialInput(); const input = { sku, name, unit, pricingRule, currentMarketPriceMicro }; const request = { ...input, parentId: f.type, clientRequestId: key() }; return { request, run: ctx => catalog.createChildMaterial(request, ctx) } } },
  { name: 'catalog.updateMaterial', permission: P.materials.manage, channel: C.materials.update, prepare: () => { const input = { name: key() }; return { request: { id: f.material, ...input }, run: ctx => catalog.updateMaterial(f.material, input, ctx) } } },
  { name: 'catalog.deleteMaterial', permission: P.materials.manage, channel: C.materials.remove, prepare: () => { const id = newMaterial(); return { request: { id }, run: ctx => catalog.deleteMaterial(id, ctx) } } },
  { name: 'catalog.fullDeleteMaterial', permission: P.materials.fullDelete, channel: C.materials.fullDelete, prepare: () => { const id = newMaterial(); const name = catalog.getMaterial(id).name; return { request: { id, confirmation: name }, run: ctx => catalog.fullDeleteMaterial({ id, confirmation: name }, ctx) } } },
  { name: 'invoices.cancelFinalInvoice', permission: P.finalInvoices.cancel, channel: C.finalInvoices.cancel, prepare: () => { const id = draft(); const request = { id, reason: 'Cancel draft' }; return { request, run: ctx => invoices.cancelFinalInvoice(request, ctx) } } },
  { name: 'invoices.deleteFinalInvoice', permission: P.finalInvoices.remove, channel: C.finalInvoices.remove, prepare: () => { const id = draft(); return { request: { id }, run: ctx => invoices.deleteFinalInvoice(id, ctx) } } },
  { name: 'invoices.addFinalInvoiceTerms', permission: P.finalInvoices.manage, channel: C.finalInvoices.addTerms, prepare: () => { const id = draft(); return { request: { id, termIndexes: [0] }, run: ctx => invoices.addFinalInvoiceTerms(id, [0], ctx) } } },
  { name: 'invoices.removeFinalInvoiceTerm', permission: P.finalInvoices.manage, channel: C.finalInvoices.removeTerm, prepare: () => { const id = draft(); invoices.addFinalInvoiceTerms(id, [0], env.ctx); const termId = invoices.getFinalInvoiceTerms(id)[0]!.id; return { request: { id, termId }, run: ctx => invoices.removeFinalInvoiceTerm(id, termId, ctx) } } },
  { name: 'settings.setSetting', permission: P.settings.manage, channel: C.settings.set, prepare: () => { const value = key(); return { request: { key: settings.SETTING_KEYS.companyName, value }, run: ctx => settings.setSetting(settings.SETTING_KEYS.companyName, value, ctx) } } },
  { name: 'quotations.createQuotation', permission: P.quotations.manage, channel: C.quotations.create, prepare: () => { const input = quotationInput(); return { request: input, run: ctx => quotations.createQuotation(input, ctx) } } },
  { name: 'quotations.createStandardQuotation', permission: P.quotations.manage, channel: C.quotations.createStandard, prepare: () => { const input = { customerId: f.customer, productId: f.product, quantityMicro: q(1) }; return { request: input, run: ctx => quotations.createStandardQuotation(input, ctx) } } },
  { name: 'quotations.updateQuotation', permission: P.quotations.manage, channel: C.quotations.update, prepare: () => { const id = quote(); const input = { notes: key() }; return { request: { id, ...input }, run: ctx => quotations.updateQuotation(id, input, ctx) } } },
  { name: 'quotations.issueQuotation', permission: P.quotations.issue, channel: C.quotations.issue, prepare: () => { const id = quote(); return { request: { id }, run: ctx => quotations.issueQuotation(id, ctx) } } },
  { name: 'quotations.createRevision', permission: P.quotations.manage, channel: C.quotations.revise, prepare: () => { const id = quote(); return { request: { id }, run: ctx => quotations.createRevision(id, ctx) } } },
  { name: 'quotations.cancelQuotation', permission: P.quotations.manage, channel: C.quotations.cancel, prepare: () => { const id = quote(); return { request: { id }, run: ctx => quotations.cancelQuotation(id, ctx) } } },
  { name: 'quotations.deleteQuotation', permission: P.quotations.remove, channel: C.quotations.remove, prepare: () => { const id = quote(); return { request: { id }, run: ctx => quotations.deleteQuotation({ id }, ctx) } } },
  { name: 'orders.updateOrder', permission: P.orders.manage, channel: C.orders.update, prepare: () => { const id = approveToOrder(draft(), env.ctx).id; const input = { notes: key() }; return { request: { id, ...input }, run: ctx => orders.updateOrder(id, input, ctx) } } },
  { name: 'purchasing.deletePurchase', permission: P.purchases.manage, channel: C.purchases.remove, prepare: () => {
    const id = Number(db().prepare("INSERT INTO purchases (document_number, supplier_id, purchase_date, total_minor) VALUES (?, ?, '2026-10-15', 0)").run(key(), f.supplier).lastInsertRowid)
    return { request: { id }, run: ctx => purchasing.deletePurchase(id, ctx) }
  } },
  { name: 'purchasing.fullDeletePurchase', permission: P.purchases.fullDelete, channel: C.purchases.fullDelete, prepare: () => {
    const documentNumber = key()
    const id = Number(db().prepare("INSERT INTO purchases (document_number, supplier_id, purchase_date, total_minor) VALUES (?, ?, '2026-10-15', 0)").run(documentNumber, f.supplier).lastInsertRowid)
    const request = { id, confirmation: documentNumber }
    return { request, run: ctx => purchasing.fullDeletePurchase(request, ctx) }
  } },
  { name: 'purchasing.performFullDeletePurchase', permission: P.purchases.fullDelete, channel: C.purchases.fullDelete, prepare: () => {
    const documentNumber = key()
    const id = Number(db().prepare("INSERT INTO purchases (document_number, supplier_id, purchase_date, total_minor) VALUES (?, ?, '2026-10-15', 0)").run(documentNumber, f.supplier).lastInsertRowid)
    return { request: { id, confirmation: documentNumber }, run: ctx => purchasing.performFullDeletePurchase(id, ctx) }
  } },
  { name: 'orders.reverseCustomerPayment', permission: P.cash.fullDelete, prepare: () => { const orderId = approveToOrder(draft(), env.ctx).id; orders.recordPayment({ orderId, amountMinor: m(1000), cashAccountId: f.account }, env.ctx); const paymentId = scalar('SELECT id AS value FROM customer_payments WHERE order_id = ?', orderId); return { request: {}, run: ctx => orders.reverseCustomerPayment(paymentId, ctx), verify: () => expect(orders.getOrder(orderId).order.paidMinor).toBe(0) } } },
  { name: 'inventory.consumeMaterial', permission: P.inventory.consume, prepare: () => {
    const before = inventory.availableQty(f.material)
    return { request: {}, run: ctx => inventory.consumeMaterial({ materialId: f.material, physicalQtyMicro: q(2), ctx }), verify: () => expect(inventory.availableQty(f.material)).toBe(before - q(2)) }
  } },
  { name: 'inventory.reverseConsumptionMovement', permission: P.inventory.consume, prepare: () => {
    const movement = inventory.consumeMaterial({ materialId: f.material, physicalQtyMicro: q(2), ctx: env.ctx }); const before = inventory.availableQty(f.material)
    return { request: {}, run: ctx => inventory.reverseConsumptionMovement({ movementId: movement.movementId, sourceRefId: movement.movementId, reason: 'FIFO correction', ctx }), verify: () => expect(inventory.availableQty(f.material)).toBe(before + q(2)) }
  } },
  { name: 'inventory.receiveStock/adjustment', permission: P.inventory.adjust, channel: C.inventory.adjust, prepare: () => { const input = { materialId: f.material, qtyMicro: q(10), unitCost: c(100), sourceKind: 'adjustment' as const }; const before = inventory.availableQty(f.material); return { request: { materialId: f.material, qtyMicro: q(10), direction: 'in', unitCostMicro: c(100), reason: 'Receipt' }, run: ctx => inventory.receiveStock({ ...input, ctx }), verify: () => expect(inventory.availableQty(f.material)).toBe(before + q(10)) } } },
  { name: 'inventory.receiveStock/opening', permission: P.inventory.adjust, prepare: () => { const before = inventory.availableQty(f.material); return { request: {}, run: ctx => inventory.receiveStock({ materialId: f.material, qtyMicro: q(10), unitCost: c(100), sourceKind: 'opening', ctx }), verify: () => expect(inventory.availableQty(f.material)).toBe(before + q(10)) } } },
  { name: 'inventory.receiveStock/purchase', permission: P.purchases.manage, prepare: () => {
    // Arrange the same parent rows that the purchase owner writes before receipt.
    const purchase = purchasing.createPurchase({ supplierId: f.supplier, lines: [{ materialId: f.material, qtyMicro: q(10), unitCostMicro: c(100) }] }, env.ctx)
    const sourceRefId = scalar('SELECT id AS value FROM purchase_lines WHERE purchase_id = ?', purchase.id)
    db().prepare("DELETE FROM inventory_movements WHERE source_kind = 'purchase' AND source_ref_id = ?").run(sourceRefId)
    db().prepare("DELETE FROM fifo_layers WHERE source_kind = 'purchase' AND source_ref_id = ?").run(sourceRefId)
    const before = inventory.availableQty(f.material)
    return { request: {}, run: ctx => inventory.receiveStock({ materialId: f.material, qtyMicro: q(10), unitCost: c(100), sourceKind: 'purchase', sourceRefId, ctx }), verify: () => expect(inventory.availableQty(f.material)).toBe(before + q(10)) }
  } }
]

describe('POST-BL-01: direct service / registered IPC permission parity', () => {
  it.each(operations)('$name authorizes before any business effect and preserves the permitted path', async operation => {
    const limited = actor(operation.restrictedPermissions ?? [])
    const allowed = actor([operation.permission])
    const direct = operation.prepare()
    const before = snapshot()
    if (operation.channel) {
      expect(await call(operation.channel, direct.request, limited.windowId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(snapshot()).toEqual(before)
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => direct.run(limited.ctx)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
      expect(snapshot()).toEqual(before)
      expect(() => withTransaction(() => direct.run(limited.ctx))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
      expect(snapshot()).toEqual(before)
    }
    direct.run(allowed.ctx)
    expect(businessOnly(snapshot())).not.toEqual(businessOnly(before))
    direct.verify?.()
    const outer = operation.prepare(); const outerBefore = snapshot()
    withTransaction(() => outer.run(allowed.ctx))
    expect(businessOnly(snapshot())).not.toEqual(businessOnly(outerBefore))
    outer.verify?.()
    const adminCall = operation.prepare(); adminCall.run(env.ctx); adminCall.verify?.()
    if (operation.channel) {
      const ipc = operation.prepare(); const ipcBefore = snapshot()
      const result = await call(operation.channel, ipc.request, allowed.windowId)
      expect(result).toMatchObject(operation.retiredIPC ? { ok: false, error: { code: 'VALIDATION_ERROR' } } : { ok: true })
      if (operation.retiredIPC) expect(snapshot()).toEqual(ipcBefore)
      else expect(businessOnly(snapshot())).not.toEqual(businessOnly(ipcBefore))
    }
  })
})


describe('POST-BL-01 composition and early denial controls', () => {
  it('protects the audited global deposit 6000 to 0 mutation without changing recorded money', async () => {
    const limited = actor([]); const allowed = actor([P.settings.manage]); const before = snapshot()
    expect(settings.getDefaultDepositPercentBp()).toBe(6000)
    const request = { key: settings.SETTING_KEYS.depositPercentBp, value: 0 }
    expect(await call(C.settings.set, request, limited.windowId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    for (const write of [settings.setSetting, settings.setSettingInternal]) {
      expect(() => write(request.key, 0, limited.ctx)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
      expect(() => withTransaction(() => write(request.key, 0, limited.ctx))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    }
    expect(snapshot()).toEqual(before)
    settings.setSetting(request.key, 0, allowed.ctx)
    expect(settings.getDefaultDepositPercentBp()).toBe(0)
    expect(snapshot().customer_payments).toEqual(before.customer_payments)
    expect(snapshot().cash_transactions).toEqual(before.cash_transactions)
  })

  it('keeps denied stock at 100 and permits exactly one 10-unit / 1000-LYD receipt', () => {
    const limited = actor([]); const allowed = actor([P.inventory.adjust]); const before = snapshot()
    const input = { materialId: f.material, qtyMicro: q(10), unitCost: c(100), sourceKind: 'adjustment' as const }
    expect(inventory.availableQty(f.material)).toBe(q(100))
    expect(() => inventory.receiveStock({ ...input, ctx: limited.ctx })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => withTransaction(() => inventory.receiveStock({ ...input, ctx: limited.ctx }))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(snapshot()).toEqual(before)
    const result = inventory.receiveStock({ ...input, ctx: allowed.ctx })
    expect(inventory.availableQty(f.material)).toBe(q(110))
    expect(db().prepare('SELECT material_id, qty_received_micro, qty_remaining_micro, unit_cost_micro FROM fifo_layers WHERE id = ?').get(result.layerId)).toEqual({ material_id: f.material, qty_received_micro: q(10), qty_remaining_micro: q(10), unit_cost_micro: c(100) })
    expect(db().prepare('SELECT material_id, kind, qty_micro, actual_cost_minor, created_by FROM inventory_movements WHERE id = ?').get(result.movementId)).toEqual({ material_id: f.material, kind: 'adjustment_in', qty_micro: q(10), actual_cost_minor: m(1000), created_by: allowed.ctx.session.user.id })
    expect(snapshot().fifo_layers).toHaveLength(before.fifo_layers.length + 1)
    expect(snapshot().inventory_movements).toHaveLength(before.inventory_movements.length + 1)
  })

  it.each([P.materials.fullDelete, P.suppliers.fullDelete])('preserves existing purchase cleanup owner %s without purchases.fullDelete', permission => {
    const allowed = actor([permission])
    const documentNumber = key()
    const id = Number(db().prepare("INSERT INTO purchases (document_number, supplier_id, purchase_date, total_minor) VALUES (?, ?, '2026-10-15', 0)").run(documentNumber, f.supplier).lastInsertRowid)
    const before = snapshot()
    expect(() => purchasing.fullDeletePurchase({ id, confirmation: documentNumber }, allowed.ctx)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => withTransaction(() => purchasing.fullDeletePurchase({ id, confirmation: documentNumber }, allowed.ctx))).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(snapshot()).toEqual(before)
    withTransaction(() => purchasing.performFullDeletePurchase(id, allowed.ctx))
    expect(scalar('SELECT COUNT(*) AS value FROM purchases WHERE id = ?', id)).toBe(0)
  })

  it('rejects omitted contexts before generic receipt or consumption can write', () => {
    const before = snapshot()
    expect(() => inventory.receiveStock({ materialId: f.material, qtyMicro: q(10), unitCost: c(100), sourceKind: 'adjustment' })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => inventory.consumeMaterial({ materialId: f.material, physicalQtyMicro: q(2) })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => settings.setSetting(settings.SETTING_KEYS.companyName, 'No actor')).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => settings.setSettingInternal(settings.SETTING_KEYS.companyName, 'No actor')).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(snapshot()).toEqual(before)
  })

  it('requires the receipt owner permission rather than accepting an unrelated stock permission', () => {
    const purchaser = actor([P.purchases.manage]); const adjuster = actor([P.inventory.adjust]); const before = snapshot()
    expect(() => inventory.receiveStock({ materialId: f.material, qtyMicro: q(10), unitCost: c(100), sourceKind: 'adjustment', ctx: purchaser.ctx })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => inventory.receiveStock({ materialId: f.material, qtyMicro: q(10), unitCost: c(100), sourceKind: 'purchase', ctx: adjuster.ctx })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(snapshot()).toEqual(before)
  })

  it('denies invalid identifiers before exposing protected business validation', () => {
    const limited = actor([]); const before = snapshot()
    expect(() => products.updateProduct(-1, { defaultPriceMinor: NaN }, limited.ctx)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => invoices.deleteFinalInvoice(-1, limited.ctx)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => orders.reverseCustomerPayment(-1, limited.ctx)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(snapshot()).toEqual(before)
  })

  it('uses refreshed login permissions after the existing role revocation mechanism', () => {
    const operator = actor([P.products.manage])
    products.updateProduct(f.product, { name: 'Permitted' }, operator.ctx)
    admin.updateRole(operator.ctx.session.user.roleId!, { permissions: [] }, env.ctx)
    const refreshed = { session: login(operator.ctx.session.user.username, 'secret123', ++sequence).session }
    const before = snapshot()
    expect(() => products.updateProduct(f.product, { name: 'Forbidden' }, refreshed)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(snapshot()).toEqual(before)
  })
})
