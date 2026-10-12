import { fulfillOrder } from '../helpers/sales-flow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import { createAccount } from '@main/services/finance/cash.service'
import {
  createFinalInvoice, approveFinalInvoice, unapproveFinalInvoice, deleteFinalInvoice, getFinalInvoice, listFinalInvoices, orderPaymentPosition
} from '@main/services/sales/final-invoices.service'
import { refundPayment, archiveOrder } from '@main/services/sales/orders.service'
import { issueWorkSheet, startProduction, completeProduction } from '@main/services/production/production.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

const NOT_ZERO_PAID = /استرداد كامل/
const STARTED = /بعد بدء التصنيع/

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 40200
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

function tables(exclude: string[] = []) {
  const raw = getRawConnection()
  return (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
    .filter(({ name }) => !exclude.includes(name))
    .map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}" ${name === 'sqlite_sequence' && exclude.includes('audit_log') ? "WHERE name != 'audit_log'" : ''} ORDER BY rowid`).all()])
}
function rows(table: string, where = '', ...params: unknown[]) {
  return getRawConnection().prepare(`SELECT * FROM ${table} ${where} ORDER BY rowid`).all(...params)
}
function authenticate(permissions: string[]) {
  const roleId = createRole({ name: 'CC02 role', permissions }, env.ctx)
  createUser({ username: 'cc02-user', fullName: 'CC02', password: 'secret123', roleId }, env.ctx)
  login('cc02-user', 'secret123', windowId)
}
function call(channel: string, request: unknown) { return handlers.get(channel)!(event, request) }

function seed(paidMajor = 0) {
  const customerId = createCustomer({ name: 'عميل CC02' }, env.ctx)
  const accountId = createAccount({ name: 'صندوق CC02', kind: 'cash' }, env.ctx)
  const invoice = createFinalInvoice({
    customerId, depositPercentBp: 0,
    ...(paidMajor ? { paidAmountMinor: m(paidMajor), initialCashAccountId: accountId } : {}),
    lines: [{ lineKind: 'custom', description: 'مطبخ CC02', quantityMicro: q(1), unitPriceMinor: m(10000) }]
  }, env.ctx)
  const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
  return { invoiceId: invoice.id, orderId, accountId, customerId }
}
const revision = (id: number) => getFinalInvoice(id).invoice.approvalRevision
const unapprove = (id: number) => unapproveFinalInvoice({ id, expectedRevision: revision(id) }, env.ctx)
function fullRefund(f: ReturnType<typeof seed>) {
  refundPayment({ orderId: f.orderId, amountMinor: orderPaymentPosition(f.orderId).paidMinor, cashAccountId: f.accountId, requestKey: crypto.randomUUID() }, env.ctx)
  expect(orderPaymentPosition(f.orderId).paidMinor).toBe(0)
}
function expectRejectedWithoutResidue(operation: () => unknown, message: RegExp) {
  const before = tables()
  expect(operation).toThrow(message)
  expect(tables()).toEqual(before)
}
function listed(archived: boolean) {
  return listFinalInvoices({ archived }).items.map((row) => row.id)
}

describe('CC02 change 1 — unapproval requires zero net paid and manufacturing never started', () => {
  it('A: no payment + manufacturing never started → unapprove succeeds', () => {
    const f = seed()
    unapprove(f.invoiceId)
    expect(getFinalInvoice(f.invoiceId).invoice.status).toBe('draft')
  })

  it.each([3000, 10000])('B/C: paid %i + manufacturing never started → rejected with zero residue', (paid) => {
    const f = seed(paid)
    expectRejectedWithoutResidue(() => unapprove(f.invoiceId), NOT_ZERO_PAID)
    expect(getFinalInvoice(f.invoiceId).invoice.status).toBe('approved')
  })

  it('D: payment → full refund → net paid 0 + never started → unapprove succeeds', () => {
    const f = seed(4000)
    fullRefund(f)
    unapprove(f.invoiceId)
    expect(getFinalInvoice(f.invoiceId).invoice.status).toBe('draft')
  })

  it('a pre-start Manufacturing Order that was reversed does not block unapproval (Package 01 reversal still pre-start only)', () => {
    const f = seed()
    const sheet = issueWorkSheet({ orderId: f.orderId }, env.ctx)
    getRawConnection().prepare("UPDATE work_sheets SET status='reversed' WHERE id=?").run(sheet.id)
    unapprove(f.invoiceId)
    expect(getFinalInvoice(f.invoiceId).invoice.status).toBe('draft')
  })

  it.each(['started', 'completed', 'cancelled-after-start'] as const)('E: manufacturing %s + net paid 0 → rejected permanently with zero residue', (stage) => {
    const f = seed()
    const sheet = issueWorkSheet({ orderId: f.orderId }, env.ctx)
    startProduction(sheet.id, env.ctx)
    if (stage === 'completed') completeProduction(sheet.id, env.ctx)
    if (stage === 'cancelled-after-start') getRawConnection().prepare("UPDATE work_sheets SET status='cancelled' WHERE id=?").run(sheet.id)
    expectRejectedWithoutResidue(() => unapprove(f.invoiceId), STARTED)
  })

  it('F: payment fully refunded, then manufacturing started → unapproval still rejected with zero residue', () => {
    const f = seed(5000)
    fullRefund(f)
    const sheet = issueWorkSheet({ orderId: f.orderId }, env.ctx)
    startProduction(sheet.id, env.ctx)
    expectRejectedWithoutResidue(() => unapprove(f.invoiceId), STARTED)
  })

  it('M: direct IPC unapproval is held to the same rules with zero residue', async () => {
    const paid = seed(3000)
    authenticate([P.orders.unapproveInvoice])
    let before = tables()
    expect(await call(C.finalInvoices.unapprove, { id: paid.invoiceId, expectedRevision: revision(paid.invoiceId) }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringMatching(NOT_ZERO_PAID) } })
    expect(tables()).toEqual(before)
    fullRefund(paid)
    const sheet = issueWorkSheet({ orderId: paid.orderId }, env.ctx)
    startProduction(sheet.id, env.ctx)
    before = tables()
    expect(await call(C.finalInvoices.unapprove, { id: paid.invoiceId, expectedRevision: revision(paid.invoiceId) }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringMatching(STARTED) } })
    expect(tables()).toEqual(before)
  })

  it('UI eligibility: list rows expose canUnapprove exactly as the backend rule', () => {
    const free = seed()
    const paid = seed(1000)
    const started = seed()
    startProduction(issueWorkSheet({ orderId: started.orderId }, env.ctx).id, env.ctx)
    const byId = new Map(listFinalInvoices({}).items.map((row) => [row.id, row]))
    expect(byId.get(free.invoiceId)).toMatchObject({ canUnapprove: true, canDelete: false })
    expect(byId.get(paid.invoiceId)).toMatchObject({ canUnapprove: false, canDelete: false })
    expect(byId.get(started.invoiceId)).toMatchObject({ canUnapprove: false, canDelete: false })
  })
})

describe('CC02 change 2 — permanent delete only after valid unapproval', () => {
  it('H: an approved invoice cannot be deleted (service + IPC) with zero residue', async () => {
    const f = seed()
    expectRejectedWithoutResidue(() => deleteFinalInvoice(f.invoiceId, env.ctx), /معتمدة/)
    authenticate([P.finalInvoices.remove])
    const before = tables()
    expect(await call(C.finalInvoices.remove, { id: f.invoiceId })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(tables()).toEqual(before)
  })

  it('G: after valid unapproval the invoice and its unposted order are permanently deleted; audit history is kept', () => {
    const f = seed()
    unapprove(f.invoiceId)
    expect(listFinalInvoices({}).items.find((row) => row.id === f.invoiceId)).toMatchObject({ canDelete: true })
    const auditBefore = rows('audit_log')
    deleteFinalInvoice(f.invoiceId, env.ctx)
    expect(rows('final_invoices', 'WHERE id = ?', f.invoiceId)).toEqual([])
    expect(rows('final_invoice_lines', 'WHERE final_invoice_id = ?', f.invoiceId)).toEqual([])
    expect(rows('invoice_approval_history', 'WHERE invoice_id = ?', f.invoiceId)).toEqual([])
    expect(rows('orders', 'WHERE id = ?', f.orderId)).toEqual([])
    expect(rows('order_lines', 'WHERE order_id = ?', f.orderId)).toEqual([])
    const audit = rows('audit_log') as Array<{ action: string }>
    expect(audit.slice(0, auditBefore.length)).toEqual(auditBefore)
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['finalInvoices.approve', 'finalInvoices.unapprove', 'finalInvoices.delete']))
  })

  it('G/M: permanent deletion after unapproval also works through IPC', async () => {
    const f = seed()
    unapprove(f.invoiceId)
    authenticate([P.finalInvoices.remove])
    expect(await call(C.finalInvoices.remove, { id: f.invoiceId })).toMatchObject({ ok: true })
    expect(rows('orders', 'WHERE id = ?', f.orderId)).toEqual([])
  })

  it('I (owner decision CC02B): a fully refunded pre-start invoice is hard-deleted with its exact cycle; nothing orphaned', async () => {
    const f = seed(4000)
    fullRefund(f)
    unapprove(f.invoiceId)
    expect(listFinalInvoices({}).items.find((row) => row.id === f.invoiceId)).toMatchObject({ canDelete: true })
    authenticate([P.finalInvoices.remove])
    expect(await call(C.finalInvoices.remove, { id: f.invoiceId })).toMatchObject({ ok: true })
    for (const table of ['customer_payments', 'customer_payment_refunds']) expect(rows(table, 'WHERE order_id = ?', f.orderId)).toEqual([])
    expect(rows('orders', 'WHERE id = ?', f.orderId)).toEqual([])
    // Remaining FK/orphan safety is asserted by afterEach (foreign_key_check / integrity_check).
  })

  it('an unapproved invoice with reversed manufacturing history is refused (inventory history is preserved)', () => {
    const f = seed()
    const sheet = issueWorkSheet({ orderId: f.orderId }, env.ctx)
    getRawConnection().prepare("UPDATE work_sheets SET status='reversed' WHERE id=?").run(sheet.id)
    unapprove(f.invoiceId)
    expectRejectedWithoutResidue(() => deleteFinalInvoice(f.invoiceId, env.ctx), /سجل/)
  })

  it('a never-approved draft still deletes as before', () => {
    const customerId = createCustomer({ name: 'مسودة CC02' }, env.ctx)
    const draft = createFinalInvoice({ customerId, lines: [{ lineKind: 'custom', description: 'مسودة', quantityMicro: q(1), unitPriceMinor: m(10) }] }, env.ctx)
    deleteFinalInvoice(draft.id, env.ctx)
    expect(rows('final_invoices', 'WHERE id = ?', draft.id)).toEqual([])
  })
})

describe('CC02 change 3 — approved invoice archive / unarchive reuses the order archive', () => {
  function completedInvoice() {
    const f = seed()
    const sheet = issueWorkSheet({ orderId: f.orderId }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    fulfillOrder(f.orderId, env.ctx)
    return f
  }

  it('J/K/L: archive moves the invoice to the archived list, unarchive returns it; no business data changes', async () => {
    const f = completedInvoice()
    authenticate([P.orders.archive])
    expect(listFinalInvoices({}).items.find((row) => row.id === f.invoiceId)).toMatchObject({ canArchive: true, orderStatus: 'completed' })
    const before = tables(['audit_log', 'orders'])
    const orderBefore = rows('orders', 'WHERE id = ?', f.orderId)

    expect(await call(C.orders.archive, { id: f.orderId })).toMatchObject({ ok: true })
    expect(listed(false)).not.toContain(f.invoiceId)
    expect(listed(true)).toContain(f.invoiceId)
    expect(getFinalInvoice(f.invoiceId).invoice.status).toBe('approved')
    expect(tables(['audit_log', 'orders'])).toEqual(before)
    const archivedOrder = rows('orders', 'WHERE id = ?', f.orderId) as Array<Record<string, unknown>>
    expect({ ...archivedOrder[0], archived_at: null, archived_by: null }).toEqual(orderBefore[0])

    expect(await call(C.orders.restore, { id: f.orderId })).toMatchObject({ ok: true })
    expect(listed(true)).not.toContain(f.invoiceId)
    expect(listed(false)).toContain(f.invoiceId)
    expect(tables(['audit_log', 'orders'])).toEqual(before)
    expect(rows('orders', 'WHERE id = ?', f.orderId)).toEqual(orderBefore)
  })

  it('M: an in-progress (not completed/cancelled) approved invoice cannot be archived directly, zero residue; permission is enforced', async () => {
    const active = seed()
    expect(listFinalInvoices({}).items.find((row) => row.id === active.invoiceId)).toMatchObject({ canArchive: false })
    authenticate([P.orders.view])
    const done = completedInvoice()
    const before = tables()
    expect(await call(C.orders.archive, { id: done.orderId })).toMatchObject({ ok: false })
    expect(tables()).toEqual(before)
    expectRejectedWithoutResidue(() => archiveOrder({ id: active.orderId, archive: true }, env.ctx), /مكتمل أو ملغى/)
  })
})
