import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveFinalInvoice, createFinalInvoice, updateFinalInvoice, getFinalInvoice, deleteFinalInvoice, cancelFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrder, recordPayment, refundPayment, fullDeleteOrder, cancelOrder, reverseCustomerPayment } from '@main/services/sales/orders.service'
import { issueWorkSheet, completeProduction } from '@main/services/production/production.service'
import { createCustomer, customerBalances, customerStatement } from '@main/services/parties/parties.service'
import { accountBalance, createAccount } from '@main/services/finance/cash.service'
import { getRawConnection, closeDatabase } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { buildFinalInvoice } from '@main/services/documents/documents.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import type { ServiceContext } from '@main/services/base/service.types'

let env: TestEnv
const TOTAL = 10_000_000
const line = { lineKind: 'custom' as const, description: 'مطبخ', quantityMicro: 1_000_000, unitPriceMinor: TOTAL }
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())
function draft(paidAmountMinor = 0, account = true) {
  const customerId = createCustomer({ name: 'عميل الدفعة الأولية' }, env.ctx)
  const accountId = account ? createAccount({ name: 'صندوق', kind: 'cash' }, env.ctx) : undefined
  const invoice = createFinalInvoice({ customerId, lines: [line], paidAmountMinor, initialCashAccountId: accountId, depositPercentBp: 6000 }, env.ctx)
  return { ...invoice, customerId, accountId }
}
function count(table: string): number { return (getRawConnection().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c }
function integrity(): void {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
}

describe('Approved Invoice actual initial payment', () => {
  it.each([0, 3_000_000, 6_000_000, 7_000_000, TOTAL])('posts %i minor units through the ordinary payment ledger without gating manufacturing', (paid) => {
    const f = draft(paid)
    expect(count('customer_payments')).toBe(0)
    const approved = approveFinalInvoice(f.id, env.ctx)
    const loaded = getOrder(approved.orderId)
    expect(loaded.order).toMatchObject({ totalMinor: TOTAL, paidMinor: paid, remainingMinor: TOTAL - paid, depositRequiredMinor: 6_000_000 })
    expect(loaded.payments).toHaveLength(paid ? 1 : 0)
    if (paid) expect(loaded.payments[0]).toMatchObject({ amountMinor: paid, approvedInvoiceId: f.id, customerId: f.customerId, cashAccountId: f.accountId, createdBy: env.ctx.session.user.id })
    expect(accountBalance(f.accountId!)).toBe(paid)
    expect(customerBalances()[0]).toMatchObject({ paidMinor: paid, remainingMinor: TOTAL - paid })
    expect(customerStatement(f.customerId).payments.items).toHaveLength(paid ? 1 : 0)
    expect(getFinalInvoice(f.id).payment).toMatchObject({ paidMinor: paid, remainingMinor: TOTAL - paid })
    expect(buildFinalInvoice(f.id).paidAmount).toBeDefined()
    expect(issueWorkSheet({ orderId: approved.orderId }, env.ctx).id).toBeGreaterThan(0)
    integrity()
  })

  it('draft edits post nothing, preserve omitted payment fields, and approve only the latest amount', () => {
    const f = draft(3_000_000)
    updateFinalInvoice(f.id, { paidAmountMinor: 6_000_000 }, env.ctx)
    updateFinalInvoice(f.id, { notes: 'تصحيح' }, env.ctx)
    expect(getFinalInvoice(f.id).invoice).toMatchObject({ paidAmountMinor: 6_000_000, initialCashAccountId: f.accountId })
    expect(count('customer_payments')).toBe(0)
    expect(accountBalance(f.accountId!)).toBe(0)
    const approved = approveFinalInvoice(f.id, env.ctx)
    expect(getOrder(approved.orderId).payments).toMatchObject([{ amountMinor: 6_000_000 }])
    expect(() => updateFinalInvoice(f.id, { paidAmountMinor: 3_000_000 }, env.ctx)).toThrow(/بعد اعتمادها/)
  })

  it.each([-1000, 11_000_000, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid persisted amount %s without posting', (amount) => {
    expect(() => draft(amount)).toThrow()
    expect(count('final_invoices')).toBe(0)
    expect(count('orders')).toBe(0)
    expect(count('customer_payments')).toBe(0)
  })

  it('revalidates stored amount/account at approval and rolls back a failed payment or a later approval failure', () => {
    const f = draft(3_000_000)
    const db = getRawConnection()
    db.prepare('UPDATE final_invoices SET paid_amount_minor = -1000 WHERE id = ?').run(f.id)
    expect(() => approveFinalInvoice(f.id, env.ctx)).toThrow()
    db.prepare('UPDATE final_invoices SET paid_amount_minor = 3000000, initial_cash_account_id = 99999 WHERE id = ?').run(f.id)
    expect(() => approveFinalInvoice(f.id, env.ctx)).toThrow(/الحساب/)
    db.prepare('UPDATE final_invoices SET initial_cash_account_id = ? WHERE id = ?').run(f.accountId, f.id)
    const auditCount = count('audit_log')
    for (const trigger of [
      "CREATE TRIGGER forced_failure BEFORE INSERT ON cash_transactions BEGIN SELECT RAISE(ABORT, 'payment failed'); END",
      "CREATE TRIGGER forced_failure BEFORE UPDATE OF status ON final_invoices WHEN NEW.status = 'approved' BEGIN SELECT RAISE(ABORT, 'approval failed'); END"
    ]) {
      db.exec(trigger)
      expect(() => approveFinalInvoice(f.id, env.ctx)).toThrow(/failed/)
      expect(getFinalInvoice(f.id).invoice).toMatchObject({ status: 'draft', orderId: null })
      expect(count('orders')).toBe(0)
      expect(count('customer_payments')).toBe(0)
      expect(count('cash_transactions')).toBe(0)
      expect(count('audit_log')).toBe(auditCount)
      db.exec('DROP TRIGGER forced_failure')
      integrity()
    }
  })

  it('duplicate approval/restart creates one payment; later normal payments accumulate and satisfy the same gate', () => {
    const f = draft(3_000_000)
    const approved = approveFinalInvoice(f.id, env.ctx)
    for (let i = 0; i < 3; i++) expect(approveFinalInvoice(f.id, env.ctx)).toMatchObject({ orderId: approved.orderId, alreadyApproved: true })
    closeDatabase()
    expect(getOrder(approved.orderId).order).toMatchObject({ paidMinor: 3_000_000, remainingMinor: 7_000_000 })
    expect(approveFinalInvoice(f.id, env.ctx).alreadyApproved).toBe(true)
    recordPayment({ orderId: approved.orderId, amountMinor: 3_000_000, cashAccountId: f.accountId }, env.ctx)
    expect(getOrder(approved.orderId).order.paidMinor).toBe(6_000_000)
    expect(issueWorkSheet({ orderId: approved.orderId }, env.ctx).id).toBeGreaterThan(0)
    recordPayment({ orderId: approved.orderId, amountMinor: 4_000_000, cashAccountId: f.accountId }, env.ctx)
    expect(getOrder(approved.orderId).order.remainingMinor).toBe(0)
    expect(getOrder(approved.orderId).payments).toHaveLength(3)
    expect(accountBalance(f.accountId!)).toBe(TOTAL)
    const audits = getRawConnection().prepare("SELECT details FROM audit_log WHERE action = 'orders.payment'").all() as Array<{ details: string }>
    expect(audits).toHaveLength(3)
    expect(audits.map(a => JSON.parse(a.details)).filter(a => a.source === 'approved_invoice')).toEqual([expect.objectContaining({ sourceId: f.id, amountMinor: 3_000_000, orderId: approved.orderId })])
    expect(() => getRawConnection().prepare('UPDATE customer_payments SET approved_invoice_id = ? WHERE approved_invoice_id IS NULL').run(f.id)).toThrow(/UNIQUE/)
    integrity()
  })

  it('allows the existing account-free payment option without inventing cash/method values', () => {
    const f = draft(3_000_000, false)
    const approved = approveFinalInvoice(f.id, env.ctx)
    expect(getOrder(approved.orderId).payments).toMatchObject([{ cashAccountId: null, amountMinor: 3_000_000 }])
    expect(count('cash_transactions')).toBe(0)
    integrity()
  })

  it('approved deletion stays blocked; cancellation requires an explicit canonical refund first', () => {
    const f = draft(3_000_000)
    const approved = approveFinalInvoice(f.id, env.ctx)
    expect(() => deleteFinalInvoice(f.id, env.ctx)).toThrow(/لا يمكن حذف/)
    expect(() => cancelFinalInvoice({ id: f.id, reason: 'خطأ' }, env.ctx)).toThrow(/يجب إلغاء الطلب/)
    expect(() => cancelOrder({ orderId: approved.orderId, reason: 'خطأ' }, env.ctx)).toThrow(/قبل (إصدار|اكتمال)/)
    refundPayment({ orderId: approved.orderId, amountMinor: 3_000_000, cashAccountId: f.accountId!, requestKey: crypto.randomUUID() }, env.ctx)
    completeProduction(issueWorkSheet({ orderId: approved.orderId, overrideDepositRequirement: true }, env.ctx).id, env.ctx)
    cancelOrder({ orderId: approved.orderId, reason: 'خطأ' }, env.ctx)
    cancelFinalInvoice({ id: f.id, reason: 'خطأ' }, env.ctx)
    expect(getOrder(approved.orderId).payments).toHaveLength(2)
    expect(accountBalance(f.accountId!)).toBe(0)
    integrity()
  })

  it('canonical full deletion is refused and preserves invoice, payment/refund and cash history', () => {
    const f = draft(3_000_000)
    const approved = approveFinalInvoice(f.id, env.ctx)
    refundPayment({ orderId: approved.orderId, amountMinor: 3_000_000, cashAccountId: f.accountId!, requestKey: crypto.randomUUID() }, env.ctx)
    expect(() => fullDeleteOrder({ id: approved.orderId, confirmation: approved.orderNumber }, env.ctx)).toThrow(/سجل تجاري مُرحّل/)
    expect(count('customer_payments')).toBe(1)
    expect(count('customer_payment_refunds')).toBe(1)
    expect(count('cash_transactions')).toBe(2)
    expect(accountBalance(f.accountId!)).toBe(0)
    expect(count('final_invoices')).toBe(1)
    expect(getRawConnection().prepare("SELECT details FROM audit_log WHERE action = 'orders.payment'").all()).toHaveLength(1)
    integrity()
  })

  it('canonical payment reversal does not let approval replay repost the payment', () => {
    const f = draft(3_000_000)
    const approved = approveFinalInvoice(f.id, env.ctx)
    withTransaction(() => reverseCustomerPayment(getOrder(approved.orderId).payments[0]!.id, env.ctx))
    expect(approveFinalInvoice(f.id, env.ctx).alreadyApproved).toBe(true)
    expect(getOrder(approved.orderId).payments).toHaveLength(0)
    expect(accountBalance(f.accountId!)).toBe(0)
    integrity()
  })

  it('backend and direct authenticated IPC enforce approval plus payment permission and stored invoice context', async () => {
    const f = draft(3_000_000)
    const limited: ServiceContext = { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [P.orders.manage] } }
    expect(() => approveFinalInvoice(f.id, limited)).toThrow()
    expect(() => updateFinalInvoice(f.id, { paidAmountMinor: 6_000_000 }, limited)).toThrow()
    expect(count('orders')).toBe(0)
    const handlers = new Map<string, (e: IpcMainInvokeEvent, p: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter(); spy.mockRestore()
    const roleId = createRole({ name: 'اعتماد دون دفع', permissions: [P.orders.manage] }, env.ctx)
    createUser({ username: 'invoice-only', password: 'secret123', fullName: 'اعتماد', roleId }, env.ctx)
    login('invoice-only', 'secret123', 9410)
    const event = { sender: { id: 9410 } } as IpcMainInvokeEvent
    const result = await handlers.get(IPC_CHANNELS.finalInvoices.approve)!(event, { id: f.id, paidAmountMinor: 1, orderId: 999 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    expect(count('orders')).toBe(0)
    const zero = draft(0, false)
    expect((await handlers.get(IPC_CHANNELS.finalInvoices.approve)!(event, { id: zero.id })).ok).toBe(true)
    login('owner', 'secret123', 9410)
    const approvedResult = await handlers.get(IPC_CHANNELS.finalInvoices.approve)!(event, { id: f.id, paidAmountMinor: 1, orderId: 999 })
    expect(approvedResult.ok).toBe(true)
    expect(getFinalInvoice(f.id).payment.paidMinor).toBe(3_000_000)
    const again = await handlers.get(IPC_CHANNELS.finalInvoices.approve)!(event, { id: f.id })
    expect(again.ok).toBe(true)
    expect(count('customer_payments')).toBe(1)
    const invalid = await handlers.get(IPC_CHANNELS.finalInvoices.update)!(event, { id: zero.id, paidAmountMinor: -1000 })
    expect(invalid.ok).toBe(false)
    integrity()
  })
})
