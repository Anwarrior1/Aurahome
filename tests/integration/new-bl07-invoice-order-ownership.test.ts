import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import type { ServiceContext } from '@main/services/base/service.types'
import { createCustomer } from '@main/services/parties/parties.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import * as orders from '@main/services/sales/orders.service'
import * as invoices from '@main/services/sales/final-invoices.service'
import { issueWorkSheet, startProduction } from '@main/services/production/production.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let account: number
const raw = () => getRawConnection()
function snapshot() {
  return Object.fromEntries((raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
function draft() {
  return invoices.createFinalInvoice({ customerId: createCustomer({ name: 'Customer' }, env.ctx), depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'Cabinet', quantityMicro: q(1), unitPriceMinor: m(10000) }] }, env.ctx).id
}
function oldConversion(id: number) {
  const loaded = invoices.getFinalInvoice(id)
  const helper = (orders as unknown as Record<string, unknown>).createOrderFromApprovedInvoice
  if (typeof helper === 'function') return (helper as (input: unknown, ctx: ServiceContext) => { id: number })({ invoice: loaded.invoice, lines: loaded.lines, customerId: loaded.invoice.customerId }, env.ctx)
  return undefined
}
function noHelperExports() {
  expect(Object.keys(orders)).not.toContain('createOrderFromApprovedInvoice')
  expect(Object.keys(invoices)).not.toContain('createOrderFromApprovedInvoice')
}
beforeEach(() => { env = setupTestDatabase(); account = createAccount({ name: 'Cash', kind: 'cash' }, env.ctx) })
afterEach(() => {
  try { expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); expect(raw().pragma('foreign_key_check')).toEqual([]) } finally { env.cleanup() }
})

describe('NEW-BL-07 approval owns invoice-to-order conversion', () => {
  it.each([false, true])('removes independent Draft conversion (caller-created transaction=%s) without business effects', transactional => {
    const id = draft(); const before = snapshot()
    if (transactional) withTransaction(() => oldConversion(id)); else oldConversion(id)
    expect(snapshot()).toEqual(before); noHelperExports()
    expect(invoices.getFinalInvoice(id).invoice).toMatchObject({ status: 'draft', totalMinor: m(10000), orderId: null })
    expect(raw().prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 0 })
  })
  it('blocks the original invalid 1,000 payment consequence because no helper-created order exists', () => {
    const id = draft(); const before = snapshot(); const result = oldConversion(id)
    if (result) orders.recordPayment({ orderId: result.id, amountMinor: m(1000), cashAccountId: account }, env.ctx)
    expect(snapshot()).toEqual(before); noHelperExports()
    expect(() => orders.recordPayment({ orderId: 1, amountMinor: m(1000), cashAccountId: account }, env.ctx)).toThrow()
    expect(snapshot()).toEqual(before); expect(accountBalance(account)).toBe(0)
  })
  it('keeps repeated independent attempts and unauthorized public approval mutation-free', () => {
    const id = draft(); const before = snapshot()
    const restricted = { ...env.ctx, session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [] } }
    for (let i = 0; i < 3; i++) {
      withTransaction(() => oldConversion(id)); expect(snapshot()).toEqual(before)
      expect(() => invoices.approveFinalInvoice(id, restricted)).toThrow(); expect(snapshot()).toEqual(before)
    }
    noHelperExports()
  })
  it('approves exactly once with correct linkage/lines/audit and permits a legitimate 1,000 payment and manufacturing', () => {
    const id = draft(); const approved = invoices.approveFinalInvoice(id, env.ctx)
    expect(invoices.getFinalInvoice(id).invoice).toMatchObject({ status: 'approved', orderId: approved.orderId })
    expect(orders.getOrder(approved.orderId).order).toMatchObject({ status: 'confirmed', finalInvoiceId: id, totalMinor: m(10000) })
    expect(orders.getOrder(approved.orderId).lines).toHaveLength(1)
    expect(orders.getOrder(approved.orderId).lines[0]).toMatchObject({ description: 'Cabinet', quantityMicro: q(1), lineTotalMinor: m(10000) })
    const before = snapshot(); expect(invoices.approveFinalInvoice(id, env.ctx)).toMatchObject({ orderId: approved.orderId, alreadyApproved: true }); expect(snapshot()).toEqual(before)
    expect(raw().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='orders.create'").get()).toEqual({ n: 1 })
    orders.recordPayment({ orderId: approved.orderId, amountMinor: m(1000), cashAccountId: account }, env.ctx)
    expect(orders.getOrderOrThrow(approved.orderId)).toMatchObject({ paidMinor: m(1000), remainingMinor: m(9000) }); expect(accountBalance(account)).toBe(m(1000))
    const sheet = issueWorkSheet({ orderId: approved.orderId }, env.ctx); startProduction(sheet.id, env.ctx)
  })
  it('unapproves into awaiting_approval and reapproves the same order with one current set of lines', () => {
    const id = draft(); const first = invoices.approveFinalInvoice(id, env.ctx)
    invoices.unapproveFinalInvoice({ id, expectedRevision: 1 }, env.ctx)
    expect(invoices.getFinalInvoice(id).invoice).toMatchObject({ status: 'draft', orderId: first.orderId })
    expect(orders.getOrderOrThrow(first.orderId).status).toBe('awaiting_approval')
    expect(orders.listOrders().items).toHaveLength(0)
    const next = invoices.approveFinalInvoice(id, env.ctx, 1)
    expect(next.orderId).toBe(first.orderId); expect(orders.listOrders().items).toHaveLength(1)
    expect(raw().prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 1 })
    expect(raw().prepare('SELECT COUNT(*) AS n FROM order_lines WHERE superseded_at IS NULL').get()).toEqual({ n: 1 })
    const before = snapshot(); invoices.approveFinalInvoice(id, env.ctx); expect(snapshot()).toEqual(before)
  })
  it('preserves approval rollback when the existing order audit insert fails', () => {
    const id = draft(); const before = snapshot()
    raw().exec("CREATE TRIGGER new07_fail BEFORE INSERT ON audit_log WHEN NEW.action='orders.create' BEGIN SELECT RAISE(ABORT, 'injected approval failure'); END")
    try { expect(() => invoices.approveFinalInvoice(id, env.ctx)).toThrow(/injected approval failure/); expect(snapshot()).toEqual(before) } finally { raw().exec('DROP TRIGGER new07_fail') }
    invoices.approveFinalInvoice(id, env.ctx); expect(raw().prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 1 })
  })
  it('preserves registered IPC permission and approval with no independent conversion channel', async () => {
    const id = draft(); const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>()
    const electron = await import('electron'); const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
    const role = createRole({ name: 'Restricted', permissions: [] }, env.ctx); createUser({ username: 'restricted', password: 'secret123', fullName: 'Restricted', roleId: role }, env.ctx); login('restricted', 'secret123', 92)
    const invoke = (windowId: number) => handlers.get(C.finalInvoices.approve)!({ sender: { id: windowId } } as IpcMainInvokeEvent, { id })
    const before = snapshot(); expect(await invoke(92)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } }); expect(snapshot()).toEqual(before)
    expect(await invoke(1)).toMatchObject({ ok: true }); expect(raw().prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 1 })
    expect([...handlers.keys()].some(key => /createOrderFromApprovedInvoice|orders:create/.test(key))).toBe(false); noHelperExports()
  })
})
