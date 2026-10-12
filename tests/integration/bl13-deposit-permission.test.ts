import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer, customerBalances } from '@main/services/parties/parties.service'
import { createProduct } from '@main/services/products/products.service'
import { createFinalInvoice, createStandardFinalInvoice, updateFinalInvoice, getFinalInvoice, approveFinalInvoice, unapproveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrder, recordPayment } from '@main/services/sales/orders.service'
import { getDefaultDepositPercentBp, setSetting, SETTING_KEYS } from '@main/services/settings.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import type { ServiceContext } from '@main/services/base/service.types'

let env: TestEnv
let customerId: number
let nextUser = 0
const TOTAL = 1_000_000
const line = { lineKind: 'custom' as const, description: 'Custom', quantityMicro: 1_000_000, unitPriceMinor: TOTAL }
const ctx = (permissions: string[]): ServiceContext => ({ session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions } })
const db = () => getRawConnection()
const rows = (table: 'final_invoices' | 'orders' | 'customer_payments' | 'customer_payment_refunds' | 'cash_transactions' | 'audit_log') =>
  (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const audit = (id: number) => db().prepare("SELECT action, details FROM audit_log WHERE entity = 'final_invoices' AND entity_id = ? ORDER BY id").all(String(id)) as Array<{ action: string; details: string }>
const create = (input: { depositPercentBp?: number } = {}, actor = env.ctx) =>
  createFinalInvoice({ customerId, lines: [line], ...input }, actor)
const deposit = (id: number) => {
  const invoice = getFinalInvoice(id).invoice
  return { percent: invoice.depositPercentBp, required: invoice.depositRequiredMinor, total: invoice.totalMinor, status: invoice.status }
}
const integrity = () => {
  expect(db().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(db().pragma('foreign_key_check')).toEqual([])
}

beforeEach(() => {
  env = setupTestDatabase()
  customerId = createCustomer({ name: 'BL13 customer' }, env.ctx)
})
afterEach(() => env.cleanup())

describe('BL-13 Approved Invoice deposit permission on migrated SQLite', () => {
  it('uses the configured default implicitly; explicit deviation needs override on custom and Standard creation', () => {
    setSetting(SETTING_KEYS.depositPercentBp, 4500, env.ctx)
    expect(getDefaultDepositPercentBp()).toBe(4500)
    const manager = ctx([P.finalInvoices.manage])
    const standardId = createProduct({ code: 'BL13-STD', name: 'Standard', defaultPriceMinor: TOTAL }, env.ctx)
    expect(deposit(create({}, manager).id)).toMatchObject({ percent: 4500, required: 450_000 })
    expect(deposit(create({ depositPercentBp: 4500 }, manager).id).percent).toBe(4500)
    expect(() => create({ depositPercentBp: 0 }, manager)).toThrow(/صلاحية/)
    expect(() => createStandardFinalInvoice({ customerId, productId: standardId, quantityMicro: 1_000_000, depositPercentBp: 0 }, manager)).toThrow(/صلاحية/)
    expect(rows('final_invoices')).toBe(2)
    expect(deposit(create({ depositPercentBp: 0 }, ctx([P.finalInvoices.manage, P.orders.overrideDeposit])).id)).toMatchObject({ percent: 0, required: 0 })
    expect(deposit(createStandardFinalInvoice({ customerId, productId: standardId, quantityMicro: 1_000_000, depositPercentBp: 3000 }, ctx([P.finalInvoices.manage, P.orders.overrideDeposit])).id)).toMatchObject({ percent: 3000, required: 300_000 })
    expect(getDefaultDepositPercentBp()).toBe(4500)
    integrity()
  })

  it('requires ordinary management at the direct creation service, even for the default or with only override', () => {
    const beforeAudit = rows('audit_log')
    expect(() => create({}, ctx([]))).toThrow(/صلاحية/)
    expect(() => create({ depositPercentBp: 0 }, ctx([P.orders.overrideDeposit]))).toThrow(/صلاحية/)
    expect(rows('final_invoices')).toBe(0)
    expect(rows('audit_log')).toBe(beforeAudit)
    expect(deposit(create({}, ctx([P.orders.manage])).id).percent).toBe(6000)
    integrity()
  })

  it('permits every percentage transition with both grants, records exact changes, and leaves money/AR untouched', () => {
    const id = create({}, ctx([P.finalInvoices.manage])).id
    const actor = ctx([P.finalInvoices.manage, P.orders.overrideDeposit])
    const beforeMoney = { payments: rows('customer_payments'), refunds: rows('customer_payment_refunds'), cash: rows('cash_transactions'), ar: customerBalances(undefined, customerId)[0].remainingMinor }
    for (const [from, to] of [[6000, 0], [0, 3000], [3000, 5000], [5000, 8000], [8000, 6000]]) {
      const before = deposit(id)
      expect(before.percent).toBe(from)
      updateFinalInvoice(id, { depositPercentBp: to }, actor)
      const after = deposit(id)
      expect(after).toMatchObject({ percent: to, total: TOTAL, status: 'draft' })
      expect(JSON.parse(audit(id).at(-1)!.details)).toMatchObject({
        oldDepositPercentBp: from, newDepositPercentBp: to,
        oldDepositRequiredMinor: before.required, newDepositRequiredMinor: after.required
      })
      expect({ payments: rows('customer_payments'), refunds: rows('customer_payment_refunds'), cash: rows('cash_transactions'), ar: customerBalances(undefined, customerId)[0].remainingMinor }).toEqual(beforeMoney)
    }
    integrity()
  })

  it('denies any changed percentage without override, but allows unchanged and unrelated draft edits', () => {
    const id = create().id
    const manager = ctx([P.finalInvoices.manage])
    const oldAudit = audit(id)
    for (const value of [0, 3000, 8000]) {
      expect(() => updateFinalInvoice(id, { depositPercentBp: value }, manager)).toThrow(/صلاحية/)
      expect(deposit(id)).toMatchObject({ percent: 6000, required: 600_000, total: TOTAL })
      expect(audit(id)).toEqual(oldAudit)
    }
    updateFinalInvoice(id, { depositPercentBp: 6000, notes: 'ordinary correction' }, manager)
    expect(getFinalInvoice(id).invoice.notes).toBe('ordinary correction')
    updateFinalInvoice(id, { address: 'ordinary address' }, manager)
    expect(getFinalInvoice(id).invoice.address).toBe('ordinary address')
    expect(audit(id).at(-1)!.action).toBe('finalInvoices.update')
    expect(JSON.parse(audit(id).at(-1)!.details)).not.toHaveProperty('oldDepositPercentBp')
    expect(rows('orders')).toBe(0)
    integrity()
  })

  it('retains approval freeze and blocks unapproval/edit/reapproval as an override bypass', () => {
    const id = create().id
    const orderId = approveFinalInvoice(id, env.ctx).orderId
    const manager = ctx([P.finalInvoices.manage])
    expect(() => updateFinalInvoice(id, { depositPercentBp: 0 }, ctx([P.finalInvoices.manage, P.orders.overrideDeposit]))).toThrow(/بعد اعتمادها/)
    expect(() => unapproveFinalInvoice({ id, expectedRevision: 1 }, manager)).toThrow(/صلاحية/)
    unapproveFinalInvoice({ id, expectedRevision: 1 }, env.ctx)
    const beforeAudit = audit(id)
    expect(() => updateFinalInvoice(id, { depositPercentBp: 0 }, manager)).toThrow(/صلاحية/)
    expect(audit(id)).toEqual(beforeAudit)
    expect(deposit(id).percent).toBe(6000)
    expect(getOrder(orderId).order.depositPercentBp).toBe(6000)
    approveFinalInvoice(id, env.ctx)
    expect(getOrder(orderId).order).toMatchObject({ status: 'confirmed', depositPercentBp: 6000, depositRequiredMinor: 600_000, paidMinor: 0, remainingMinor: TOTAL })
    expect(customerBalances(undefined, customerId)[0].remainingMinor).toBe(TOTAL)
    integrity()
  })

  it('does not change an existing receipt, receivable, or history after an attempted approved term edit', () => {
    const id = create().id
    const orderId = approveFinalInvoice(id, env.ctx).orderId
    recordPayment({ orderId, amountMinor: 200_000 }, env.ctx)
    const before = {
      payments: db().prepare('SELECT * FROM customer_payments WHERE order_id = ?').all(orderId),
      refunds: rows('customer_payment_refunds'), cash: rows('cash_transactions'),
      ar: customerBalances(undefined, customerId)[0].remainingMinor,
      order: getOrder(orderId).order, invoice: deposit(id), audit: audit(id)
    }
    expect(before.payments).toHaveLength(1)
    expect(before.ar).toBe(800_000)
    expect(() => updateFinalInvoice(id, { depositPercentBp: 0 }, ctx([P.finalInvoices.manage, P.orders.overrideDeposit]))).toThrow(/بعد اعتمادها/)
    expect(() => unapproveFinalInvoice({ id, expectedRevision: 1 }, env.ctx)).toThrow(/صافي المدفوع/)
    expect({
      payments: db().prepare('SELECT * FROM customer_payments WHERE order_id = ?').all(orderId),
      refunds: rows('customer_payment_refunds'), cash: rows('cash_transactions'),
      ar: customerBalances(undefined, customerId)[0].remainingMinor,
      order: getOrder(orderId).order, invoice: deposit(id), audit: audit(id)
    }).toEqual(before)
    integrity()
  })

  it('guards direct IPC, including default view and explicit create/update attempts', async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    const webContentsId = 61_000 + ++nextUser
    const roleId = createRole({ name: `BL13 manager ${nextUser}`, permissions: [P.finalInvoices.view, P.finalInvoices.manage] }, env.ctx)
    createUser({ username: `bl13manager${nextUser}`, password: 'secret123', fullName: 'BL13 manager', roleId }, env.ctx)
    login(`bl13manager${nextUser}`, 'secret123', webContentsId)
    const event = { sender: { id: webContentsId } } as IpcMainInvokeEvent
    const call = (channel: string, request?: unknown) => handlers.get(channel)!(event, request)
    expect(await call(C.finalInvoices.depositDefault)).toMatchObject({ ok: true, data: { depositPercentBp: 6000 } })
    const created = await call(C.finalInvoices.create, { customerId, lines: [line] })
    expect(created.ok).toBe(true)
    const id = (created.data as { id: number }).id
    const prior = audit(id)
    expect(await call(C.finalInvoices.update, { id, depositPercentBp: 0 })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await call(C.finalInvoices.create, { customerId, lines: [line], depositPercentBp: 0 })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(deposit(id)).toMatchObject({ percent: 6000, required: 600_000 })
    expect(rows('final_invoices')).toBe(1)
    expect(audit(id)).toEqual(prior)
    expect(await call(C.finalInvoices.update, { id, notes: 'permitted edit' })).toMatchObject({ ok: true })
    expect(getFinalInvoice(id).invoice.notes).toBe('permitted edit')
    integrity()
  })
})
