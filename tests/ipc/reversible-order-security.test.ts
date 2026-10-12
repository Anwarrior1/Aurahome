import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { savePlannedMaterials } from '@main/services/planning/planning.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { createFinalInvoice, approveFinalInvoice, getFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrder, archiveOrder } from '@main/services/sales/orders.service'
import { issueWorkSheet, completeProduction, getProductionOrder, issueRelease, listReleases, recordDelivery, cancelDelivery } from '@main/services/production/production.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 19800
let event: IpcMainInvokeEvent
beforeEach(async () => {
  env = setupTestDatabase()
  event = { sender: { id: ++windowId } } as IpcMainInvokeEvent
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})
afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})
function authenticate(permissions: string[]) {
  const roleId = createRole({ name: 'صلاحيات تصحيح محددة', permissions }, env.ctx)
  createUser({ username: 'step-user', fullName: 'مستخدم التصحيح', password: 'secret123', roleId }, env.ctx)
  login('step-user', 'secret123', windowId)
}
function call(channel: string, request: unknown) { return handlers.get(channel)!(event, request) }
function state() {
  return ['orders', 'final_invoices', 'order_lines', 'work_sheets', 'releases', 'deliveries', 'customer_payments', 'cash_transactions', 'inventory_movements', 'fifo_layers', 'fifo_allocations', 'invoice_approval_history'].map((table) => getRawConnection().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
}
function seed(start = true) {
  const customerId = createCustomer({ name: 'عميل منع تجاوز IPC' }, env.ctx)
  const invoice = createFinalInvoice({ customerId, paidAmountMinor: m(start ? 1000 : 0), requiresDelivery: true, depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'طلب', quantityMicro: q(1), unitPriceMinor: m(1000) }] }, env.ctx)
  const approval = approveFinalInvoice(invoice.id, env.ctx)
  const categoryId = createCategory({ name: 'مواد التصحيح' }, env.ctx)
  const materialId = createMaterial({ sku: 'IPC-STEP', name: 'لوح', categoryId, unit: 'لوح', pricingRule: 'exact', currentMarketPriceMicro: c(10) }, env.ctx)
  const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
  createPurchase({ supplierId, customerOrderId: approval.orderId, lines: [{ materialId, qtyMicro: q(10), unitCostMicro: c(10) }] }, env.ctx)
  savePlannedMaterials({ orderId: approval.orderId }, [{ materialId, materialName: 'لوح', qtyMicro: q(5), estimatedUnitCostMicro: c(10) }], env.ctx)
  const sheet = issueWorkSheet({ orderId: approval.orderId }, env.ctx)
  if (!start) return { invoice, approval, sheet, materialId, sheetRequest: { id: sheet.id, expectedToken: getProductionOrder(sheet.id).reversalToken, confirmation: sheet.documentNumber, reason: 'تصحيح' } }
  completeProduction(sheet.id, env.ctx)
  const permit = issueRelease({ orderId: approval.orderId, kind: 'transport' }, env.ctx)
  const delivery = recordDelivery({ orderId: approval.orderId, releaseId: permit.id, kind: 'delivery', actualCostMinor: m(50) }, env.ctx)
  const detail = getProductionOrder(sheet.id)
  return { invoice, approval, sheet, permit, delivery, materialId, sheetRequest: { id: sheet.id, expectedToken: detail.reversalToken, confirmation: sheet.documentNumber, reason: 'تصحيح' },
    permitRequest: { id: permit.id, expectedToken: listReleases({ orderId: approval.orderId }).items[0].reversalToken } }
}

describe('step-by-step reversal and archive direct IPC security', () => {
  it('rejects every sensitive action even with an authenticated management role and valid forged payload', async () => {
    const f = seed()
    authenticate([P.orders.view, P.orders.manage, P.worksheets.view, P.worksheets.issue, P.releases.view, P.releases.issue])
    const before = state()
    for (const [channel, request] of [
      [C.production.reverseWorkSheet, f.sheetRequest], [C.production.reverseRelease, f.permitRequest],
      [C.finalInvoices.unapprove, { id: f.invoice.id, expectedRevision: 1 }],
      [C.orders.archive, { id: f.approval.orderId }], [C.orders.restore, { id: f.approval.orderId }],
      [C.orders.reverseCompletion, { id: f.approval.orderId }]
    ] as const) {
      const result = await call(channel, request)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
      expect(state()).toEqual(before)
    }
  })
  it('preserves the existing delivery permission model and rejects a view-only direct reversal', async () => {
    const f = seed()
    authenticate([P.orders.view])
    const before = state()
    const result = await call(C.production.cancelDelivery, { id: f.delivery.id })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    expect(state()).toEqual(before)
  })
  it('enforces downstream dependencies for an authorized direct caller, not just the renderer', async () => {
    const f = seed()
    authenticate([P.worksheets.reverse, P.releases.reverse, P.orders.unapproveInvoice, P.inventory.consume])
    const before = state()
    for (const [channel, request] of [[C.production.reverseRelease, f.permitRequest], [C.production.reverseWorkSheet, f.sheetRequest], [C.finalInvoices.unapprove, { id: f.invoice.id, expectedRevision: 1 }], [C.production.reverseMaterialConsumption, { id: getProductionOrder(f.sheet.id).materialLines[0].id, reason: 'تجاوز مزور' }]] as const) {
      const result = await call(channel, request)
      expect(result.ok).toBe(false)
      if (!result.ok) { expect(result.error.code).toBe('CONFLICT'); expect(result.error.message).toMatch(
        channel === C.production.reverseWorkSheet || channel === C.finalInvoices.unapprove
          ? /بعد بدء التصنيع/
          : channel === C.production.reverseMaterialConsumption ? /تكلفة الإنتاج|التسليم/ : /التسليم/
      ) }
      expect(state()).toEqual(before)
    }
  })
  it('rejects direct Manufacturing Order reversal for an archived source order before any downstream mutation', async () => {
    const f = seed()
    archiveOrder({ id: f.approval.orderId, archive: true }, env.ctx)
    authenticate([P.worksheets.reverse])
    const before = state()

    const result = await call(C.production.reverseWorkSheet, f.sheetRequest)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT')
      expect(result.error.message).toBe('لا يمكن التراجع عن أمر تصنيع تابع لطلب مؤرشف')
    }
    expect(state()).toEqual(before)
    expect(getProductionOrder(f.sheet.id).sheet.status).toBe('completed')
  })

  it('does not let a missing reversal permission bypass the archived-order guard', async () => {
    const f = seed()
    archiveOrder({ id: f.approval.orderId, archive: true }, env.ctx)
    authenticate([P.worksheets.view])
    const before = state()

    const result = await call(C.production.reverseWorkSheet, f.sheetRequest)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    expect(state()).toEqual(before)
  })
  it('validates typed manufacturing confirmation and rejects concurrent/stale requests atomically', async () => {
    const f = seed(false)
    authenticate([P.worksheets.reverse])
    const request = { ...f.sheetRequest, expectedToken: getProductionOrder(f.sheet.id).reversalToken }
    const before = state()
    const invalid = await call(C.production.reverseWorkSheet, { ...request, confirmation: 'wrong' })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('VALIDATION_ERROR')
    expect(state()).toEqual(before)
    const results = await Promise.all([call(C.production.reverseWorkSheet, request), call(C.production.reverseWorkSheet, request)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(getOrder(f.approval.orderId).workflow.manufacturingIssued).toBe(false)
    expect(getProductionOrder(f.sheet.id).sheet.status).toBe('reversed')
    expect(availableQty(f.materialId)).toBe(q(10))
    expect(getRawConnection().prepare("SELECT COUNT(*) AS c FROM inventory_movements WHERE kind='consumption_reversal'").get()).toEqual({ c: 1 })
    const duplicate = results.find((r) => !r.ok)!
    if (!duplicate.ok) expect(duplicate.error.code).toBe('CONFLICT')
  })
  it('unapproves the same invoice/order through its focused permission and cannot replay the old approval revision', async () => {
    const f = seed(false)
    const { reverseWorkSheet } = await import('@main/services/production/production.service')
    reverseWorkSheet({ ...f.sheetRequest, expectedToken: getProductionOrder(f.sheet.id).reversalToken }, env.ctx)
    authenticate([P.orders.unapproveInvoice])
    expect((await call(C.finalInvoices.unapprove, { id: f.invoice.id, expectedRevision: 1 })).ok).toBe(true)
    expect(getFinalInvoice(f.invoice.id).invoice.status).toBe('draft')
    expect(getOrder(f.approval.orderId).order.status).toBe('awaiting_approval')
    const before = state()
    const replay = await call(C.finalInvoices.unapprove, { id: f.invoice.id, expectedRevision: 1 })
    expect(replay.ok).toBe(false)
    expect(state()).toEqual(before)
  })
  it('archives/restores the same ID with bounded server filtering and validates pagination against direct bypass', async () => {
    const f = seed()
    authenticate([P.orders.archive, P.orders.view])
    expect((await call(C.orders.archive, { id: f.approval.orderId })).ok).toBe(true)
    const active = await call(C.orders.list, { limit: 1 })
    expect(active).toMatchObject({ ok: true, data: { items: [] } })
    const archived = await call(C.orders.list, { archived: true, limit: 1 })
    expect(archived).toMatchObject({ ok: true, data: { items: [{ id: f.approval.orderId }] } })
    for (const request of [{ limit: 101 }, { limit: 0 }, { cursor: 'not a cursor' }, { archived: 'true' }]) {
      const invalid = await call(C.orders.list, request)
      expect(invalid.ok).toBe(false)
      if (!invalid.ok) expect(invalid.error.code).toBe('VALIDATION_ERROR')
    }
    expect((await call(C.orders.restore, { id: f.approval.orderId })).ok).toBe(true)
    expect(getOrder(f.approval.orderId).order.documentNumber).toBe(f.approval.orderNumber)
  })
  it('requires completion authority independently and refuses archiving an unfinished order', async () => {
    const f = seed()
    cancelDelivery({ id: f.delivery.id }, env.ctx)
    authenticate([P.orders.archive])
    const before = state()
    const result = await call(C.orders.archive, { id: f.approval.orderId })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CONFLICT')
    expect(state()).toEqual(before)
    recordDelivery({ orderId: f.approval.orderId, releaseId: f.permit.id, kind: 'delivery' }, env.ctx)
    archiveOrder({ id: f.approval.orderId, archive: true }, env.ctx)
    expect(getOrder(f.approval.orderId).order.status).toBe('completed')
  })
})
