import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import type { ServiceContext } from '@main/services/base/service.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCustomer, customerBalances, customerStatement } from '@main/services/parties/parties.service'
import { approveFinalInvoice, createFinalInvoice, getFinalInvoice, orderPaymentPosition, unapproveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { approveToOrder } from '../helpers/sales-flow'
import { cancelOrder, deleteOrder, fullDeleteOrder, getOrder, getOrderOrThrow, listOrders, recordPayment, refundPayment } from '@main/services/sales/orders.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { getProductionOrder, issueWorkSheet, reverseWorkSheet, startProduction } from '@main/services/production/production.service'
import { manufacturingStarted } from '@shared/production/manufacturing-lifecycle'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { bindSessionToWebContents, createSession } from '@main/auth/session'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function context(permissions: string[]): ServiceContext {
  return { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions } }
}

function seed(initialMajor = 5_400) {
  const customerId = createCustomer({ name: 'عميل استرداد' }, env.ctx)
  const accountId = createAccount({ name: 'صندوق الاسترداد', kind: 'cash' }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    paidAmountMinor: moneyFromMajor(initialMajor),
    initialCashAccountId: accountId,
    lines: [{ lineKind: 'custom', description: 'طلب 9000', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(9_000) }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  return { customerId, accountId, invoiceId: invoice.id, orderId: order.id }
}

function refund(f: ReturnType<typeof seed>, amount = 5_400, requestKey = crypto.randomUUID()) {
  return refundPayment({
    orderId: f.orderId,
    amountMinor: moneyFromMajor(amount),
    cashAccountId: f.accountId,
    requestKey
  }, env.ctx)
}

function count(table: string): number {
  return (getRawConnection().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
}

function reverseUnstarted(orderId: number) {
  const issued = issueWorkSheet({ orderId }, env.ctx)
  const production = getProductionOrder(issued.id)
  expect(manufacturingStarted(production.sheet)).toBe(false)
  reverseWorkSheet({ id: issued.id, expectedToken: production.reversalToken, confirmation: issued.documentNumber, reason: 'Customer ended deal before start' }, env.ctx)
  const reversed = getProductionOrder(issued.id).sheet
  expect(reversed).toMatchObject({ status: 'reversed', startedAt: null, completedAt: null, reversedAt: expect.any(String) })
  expect(manufacturingStarted(reversed)).toBe(false)
  return issued
}

describe('pre-manufacturing customer payment refund', () => {
  it('exposes authoritative eligibility and performs full refund without changing the order total or invoice', () => {
    const f = seed()
    const invoiceBefore = getFinalInvoice(f.invoiceId)
    const operationalBefore = {
      inventory: count('inventory_movements'),
      returns: count('material_returns'),
      uncollected: count('uncollected_products')
    }
    expect(getOrder(f.orderId).actions).toMatchObject({ canRefundPayment: true, refundableMinor: moneyFromMajor(5_400) })

    const result = refund(f)

    expect(result).toMatchObject({ paidMinor: 0, remainingMinor: moneyFromMajor(9_000), paymentStatus: 'unpaid', idempotent: false })
    expect(getOrderOrThrow(f.orderId)).toMatchObject({ totalMinor: moneyFromMajor(9_000), paidMinor: 0, remainingMinor: moneyFromMajor(9_000) })
    expect(customerBalances(undefined, f.customerId)[0]).toMatchObject({ paidMinor: 0, remainingMinor: moneyFromMajor(9_000) })
    expect(accountBalance(f.accountId)).toBe(0)
    expect({ inventory: count('inventory_movements'), returns: count('material_returns'), uncollected: count('uncollected_products') }).toEqual(operationalBefore)
    const invoiceAfter = getFinalInvoice(f.invoiceId)
    expect(invoiceAfter.invoice).toEqual(invoiceBefore.invoice)
    expect(invoiceAfter.lines).toEqual(invoiceBefore.lines)
    expect(invoiceAfter.snapshot).toEqual(invoiceBefore.snapshot)
    expect(invoiceAfter.terms).toEqual(invoiceBefore.terms)
    expect(getOrder(f.orderId).actions).toMatchObject({ canRefundPayment: false, refundableMinor: 0 })
  })

  it('supports partial refunds and rejects zero, negative, and excess amounts', () => {
    const f = seed()
    expect(refund(f, 2_000)).toMatchObject({ paidMinor: moneyFromMajor(3_400), remainingMinor: moneyFromMajor(5_600) })
    expect(orderPaymentPosition(f.orderId)).toMatchObject({ paidMinor: moneyFromMajor(3_400), remainingMinor: moneyFromMajor(5_600) })
    expect(getOrder(f.orderId).actions).toMatchObject({ refundableMinor: moneyFromMajor(3_400), canRefundPayment: true, canCancel: false, canDeleteCancel: false })
    expect(listOrders({}).items[0]).toMatchObject({ canCancel: false, canDeleteCancel: false })
    expect(() => cancelOrder({ orderId: f.orderId, reason: 'Partial is not enough' }, env.ctx)).toThrow(/قبل (إصدار|اكتمال)/)
    expect(() => deleteOrder(f.orderId, env.ctx)).toThrow(/استرداد كامل/)
    expect(() => fullDeleteOrder({ id: f.orderId, confirmation: getOrderOrThrow(f.orderId).documentNumber }, env.ctx)).toThrow(/استرداد كامل/)
    expect(() => refund(f, 3_401)).toThrow(/أكبر من المبلغ القابل/)
    expect(() => refundPayment({ orderId: f.orderId, amountMinor: 0, cashAccountId: f.accountId, requestKey: 'zero-key' }, env.ctx)).toThrow(/أكبر من صفر/)
    expect(() => refundPayment({ orderId: f.orderId, amountMinor: -1, cashAccountId: f.accountId, requestKey: 'negative-key' }, env.ctx)).toThrow(/أكبر من صفر/)
  })

  it('full refund removes only the financial blocker; explicit deletion remains separate', () => {
    const f = seed()
    refund(f)
    expect(getOrder(f.orderId)).toMatchObject({
      order: { status: 'confirmed', totalMinor: moneyFromMajor(9_000), paidMinor: 0, remainingMinor: moneyFromMajor(9_000) },
      actions: { canRefundPayment: false, refundableMinor: 0, canCancel: false, canDeleteCancel: false }
    })
    expect(listOrders({}).items[0]).toMatchObject({ canCancel: false, canDeleteCancel: false })
    expect(() => cancelOrder({ orderId: f.orderId, reason: 'Separate explicit cancellation' }, env.ctx)).toThrow(/قبل إصدار/)
    expect(() => fullDeleteOrder({ id: f.orderId, confirmation: getOrderOrThrow(f.orderId).documentNumber }, env.ctx)).toThrow(/سجل تجاري مُرحّل/)
    expect(getOrder(f.orderId).order.id).toBe(f.orderId)
  })

  it('net paid zero does not bypass an unrelated existing delete blocker', () => {
    const f = seed()
    refund(f)
    unapproveFinalInvoice({ id: f.invoiceId, expectedRevision: 1 }, env.ctx)
    approveFinalInvoice(f.invoiceId, env.ctx)
    expect(getOrder(f.orderId).actions).toMatchObject({ canCancel: false, canDeleteCancel: false })
    expect(listOrders({}).items[0]).toMatchObject({ canCancel: false, canDeleteCancel: false })
    expect(() => fullDeleteOrder({ id: f.orderId, confirmation: getOrderOrThrow(f.orderId).documentNumber }, env.ctx)).toThrow(/تم منع/)
  })

  it('preserves the receipt, binds the refund to its exact ID, posts one cash-out, audits it, and shows both history rows', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 1, 0, 5))
    try {
      const f = seed()
      const receipt = getRawConnection().prepare('SELECT * FROM customer_payments WHERE order_id = ?').get(f.orderId) as { id: number; amount_minor: number }
      const beforeBalance = accountBalance(f.accountId)
      vi.setSystemTime(new Date(2026, 9, 1, 0, 10))
      const result = refund(f, 2_000)

      expect(getRawConnection().prepare('SELECT * FROM customer_payments WHERE id = ?').get(receipt.id)).toMatchObject({ amount_minor: moneyFromMajor(5_400) })
      expect(getRawConnection().prepare('SELECT * FROM customer_payment_refund_allocations WHERE refund_id = ?').all(result.refundId)).toEqual([
        expect.objectContaining({ payment_id: receipt.id, amount_minor: moneyFromMajor(2_000) })
      ])
      expect(getRawConnection().prepare("SELECT * FROM cash_transactions WHERE ref_table = 'customer_payment_refunds' AND ref_id = ?").all(result.refundId)).toEqual([
        expect.objectContaining({ direction: 'out', amount_minor: moneyFromMajor(2_000), account_id: f.accountId, notes: null })
      ])
      expect(getRawConnection().prepare('SELECT reason FROM customer_payment_refunds WHERE id = ?').get(result.refundId)).toEqual({ reason: '' })
      expect(accountBalance(f.accountId)).toBe(beforeBalance - moneyFromMajor(2_000))
      const audit = getRawConnection().prepare("SELECT * FROM audit_log WHERE action = 'orders.payment.refund' AND entity_id = ?").get(String(result.refundId)) as { user_id: number; details: string }
      expect(audit.user_id).toBe(env.ctx.session.user.id)
      expect(JSON.parse(audit.details)).toMatchObject({
        orderId: f.orderId, amountMinor: moneyFromMajor(2_000), cashAccountId: f.accountId,
        paidMinor: moneyFromMajor(3_400), remainingMinor: moneyFromMajor(5_600)
      })
      expect(JSON.parse(audit.details)).not.toHaveProperty('reason')
      expect(getOrder(f.orderId).payments.map((row) => [row.entryType, row.amountMinor])).toEqual([
        ['refund', -moneyFromMajor(2_000)], ['payment', moneyFromMajor(5_400)]
      ])
      expect(customerStatement(f.customerId, env.ctx).payments.items.map((row) => row.entryType)).toEqual(['refund', 'payment'])
      expect(getOrder(f.orderId).payments.map((row) => row.effectiveBusinessDay)).toEqual(['2026-10-01', '2026-10-01'])
    } finally { vi.useRealTimers() }
  })


  it('is idempotent for retry/double-click and rejects reuse of a request key for different input', () => {
    const f = seed()
    const key = crypto.randomUUID()
    const first = refund(f, 2_000, key)
    const second = refund(f, 2_000, key)
    expect(second).toMatchObject({ refundId: first.refundId, idempotent: true })
    expect(count('customer_payment_refunds')).toBe(1)
    expect(count('customer_payment_refund_allocations')).toBe(1)
    expect(getRawConnection().prepare("SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'customer_payment_refunds'").get()).toEqual({ c: 1 })
    expect(() => refund(f, 1_000, key)).toThrow(/عملية مختلفة/)
    issueWorkSheet({ orderId: f.orderId, overrideDepositRequirement: true }, env.ctx)
    expect(() => refund(f, 2_000, key)).toThrow(/التراجع عن المستندات/)
    expect(count('customer_payment_refunds')).toBe(1)
  })

  it('does not let Approved Invoice approval retry recreate the refunded initial payment', () => {
    const f = seed()
    refund(f)
    expect(approveFinalInvoice(f.invoiceId, env.ctx)).toMatchObject({ orderId: f.orderId, alreadyApproved: true })
    expect(count('customer_payments')).toBe(1)
    expect(count('customer_payment_refunds')).toBe(1)
    expect(getOrderOrThrow(f.orderId).paidMinor).toBe(0)
  })

  it('requires a real active payout account with sufficient authoritative balance', () => {
    const f = seed()
    const emptyAccount = createAccount({ name: 'صندوق فارغ', kind: 'cash' }, env.ctx)
    expect(() => refundPayment({ orderId: f.orderId, amountMinor: moneyFromMajor(1), cashAccountId: emptyAccount, requestKey: crypto.randomUUID() }, env.ctx)).toThrow(/لا يكفي/)
    getRawConnection().prepare('UPDATE cash_accounts SET active = 0 WHERE id = ?').run(f.accountId)
    expect(() => refund(f, 1)).toThrow(/غير نشط/)
    expect(count('customer_payment_refunds')).toBe(0)
  })

  it('refunds after a legitimate pre-start reversal, keeps worksheet history, and permits zero-net unapproval', () => {
    const f = seed()
    const sheet = reverseUnstarted(f.orderId)
    expect(getOrder(f.orderId).actions).toMatchObject({ canRefundPayment: true, refundableMinor: moneyFromMajor(5_400) })
    expect(listOrders({}).items[0]).toMatchObject({ canRefundPayment: true, refundableMinor: moneyFromMajor(5_400) })
    expect(refund(f)).toMatchObject({ paidMinor: 0, remainingMinor: moneyFromMajor(9_000) })
    expect(count('customer_payment_refunds')).toBe(1)
    expect(count('customer_payment_refund_allocations')).toBe(1)
    expect(getRawConnection().prepare("SELECT COUNT(*) AS c FROM cash_transactions WHERE kind = 'customer_payment_refund'").get()).toEqual({ c: 1 })
    expect(accountBalance(f.accountId)).toBe(0)
    unapproveFinalInvoice({ id: f.invoiceId, expectedRevision: 1 }, env.ctx)
    expect(getFinalInvoice(f.invoiceId).invoice.status).toBe('draft')
    expect(getOrder(f.orderId).order.status).toBe('awaiting_approval')
    expect(getProductionOrder(sheet.id).sheet.status).toBe('reversed')
  })

  it('blocks refunds while an unstarted worksheet is active and after manufacturing actually starts', () => {
    const f = seed()
    const sheet = issueWorkSheet({ orderId: f.orderId }, env.ctx)
    expect(getOrder(f.orderId).actions.canRefundPayment).toBe(false)
    expect(() => refund(f)).toThrow(/التراجع عن المستندات/)
    startProduction(sheet.id, env.ctx)
    expect(manufacturingStarted(getProductionOrder(sheet.id).sheet)).toBe(true)
    expect(getOrder(f.orderId).actions.canRefundPayment).toBe(false)
    expect(() => refund(f)).toThrow(/بدء التصنيع/)
    const current = getProductionOrder(sheet.id)
    expect(() => reverseWorkSheet({ id: sheet.id, expectedToken: current.reversalToken, confirmation: sheet.documentNumber, reason: 'Too late' }, env.ctx)).toThrow(/بعد بدء التصنيع/)
    expect(count('customer_payment_refunds')).toBe(0)
  })

  it('uses ledger amounts for partial and multiple receipts after reversal, with FIFO allocations and one cash-out', () => {
    const f = seed()
    refund(f, 500)
    recordPayment({ orderId: f.orderId, amountMinor: moneyFromMajor(2_000), cashAccountId: f.accountId }, env.ctx)
    recordPayment({ orderId: f.orderId, amountMinor: moneyFromMajor(1_500), cashAccountId: f.accountId }, env.ctx)
    reverseUnstarted(f.orderId)
    expect(getOrder(f.orderId).actions).toMatchObject({ canRefundPayment: true, refundableMinor: moneyFromMajor(8_400) })
    expect(listOrders({}).items[0]).toMatchObject({ canRefundPayment: true, refundableMinor: moneyFromMajor(8_400) })
    const result = refund(f, 8_400)
    expect(result.paidMinor).toBe(0)
    expect(getRawConnection().prepare('SELECT amount_minor FROM customer_payment_refund_allocations WHERE refund_id = ? ORDER BY id').all(result.refundId)).toEqual([
      { amount_minor: moneyFromMajor(4_900) }, { amount_minor: moneyFromMajor(2_000) }, { amount_minor: moneyFromMajor(1_500) }
    ])
    expect(accountBalance(f.accountId)).toBe(0)
    expect(count('customer_payments')).toBe(3)
  })

  it('refunds a partial deposit after reversal and rejects an unfunded payout account atomically', () => {
    const f = seed(2_000)
    reverseUnstarted(f.orderId)
    expect(getOrder(f.orderId).actions).toMatchObject({ canRefundPayment: true, refundableMinor: moneyFromMajor(2_000) })
    const empty = createAccount({ name: 'Unfunded reversal payout', kind: 'cash' }, env.ctx)
    const before = { order: getOrderOrThrow(f.orderId), cash: accountBalance(f.accountId), refunds: count('customer_payment_refunds'), allocations: count('customer_payment_refund_allocations') }
    expect(() => refundPayment({ orderId: f.orderId, amountMinor: moneyFromMajor(500), cashAccountId: empty, requestKey: crypto.randomUUID() }, env.ctx)).toThrow(/لا يكفي/)
    expect(getOrderOrThrow(f.orderId)).toEqual(before.order)
    expect(accountBalance(f.accountId)).toBe(before.cash)
    expect(count('customer_payment_refunds')).toBe(before.refunds)
    expect(count('customer_payment_refund_allocations')).toBe(before.allocations)
    expect(refund(f, 500)).toMatchObject({ paidMinor: moneyFromMajor(1_500) })
    expect(getOrder(f.orderId).actions.refundableMinor).toBe(moneyFromMajor(1_500))
  })

  it('does not offer a refund without a payment after pre-start reversal', () => {
    const f = seed(0)
    reverseUnstarted(f.orderId)
    expect(getOrder(f.orderId).actions).toMatchObject({ canRefundPayment: false, refundableMinor: 0 })
    expect(() => refund(f, 1)).toThrow(/أكبر من المبلغ القابل/)
    expect(count('customer_payment_refunds')).toBe(0)
  })

  it('revalidates lifecycle in the transaction so issuance followed by a stale refund attempt cannot commit', () => {
    const f = seed()
    expect(getOrder(f.orderId).actions.canRefundPayment).toBe(true)
    issueWorkSheet({ orderId: f.orderId }, env.ctx)
    expect(() => refund(f)).toThrow(/التراجع عن المستندات/)
    expect(count('customer_payment_refunds')).toBe(0)
  })

  it('rolls back refund row, allocation, order totals, cash, and audit on financial movement failure', () => {
    const f = seed()
    reverseUnstarted(f.orderId)
    const before = { order: getOrderOrThrow(f.orderId), cash: accountBalance(f.accountId), audit: count('audit_log') }
    getRawConnection().exec("CREATE TRIGGER fail_refund_cash BEFORE INSERT ON cash_transactions WHEN NEW.kind = 'customer_payment_refund' BEGIN SELECT RAISE(ABORT, 'forced refund cash failure'); END")
    expect(() => refund(f, 2_000)).toThrow(/forced refund cash failure/)
    expect(count('customer_payment_refunds')).toBe(0)
    expect(count('customer_payment_refund_allocations')).toBe(0)
    expect(getOrderOrThrow(f.orderId)).toEqual(before.order)
    expect(accountBalance(f.accountId)).toBe(before.cash)
    expect(count('audit_log')).toBe(before.audit)
  })

  it('rolls back the cash movement and every business effect if audit persistence fails', () => {
    const f = seed()
    const beforeBalance = accountBalance(f.accountId)
    getRawConnection().exec("CREATE TRIGGER fail_refund_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'orders.payment.refund' BEGIN SELECT RAISE(ABORT, 'forced refund audit failure'); END")
    expect(() => refund(f, 2_000)).toThrow(/forced refund audit failure/)
    expect(count('customer_payment_refunds')).toBe(0)
    expect(count('customer_payment_refund_allocations')).toBe(0)
    expect(getRawConnection().prepare("SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'customer_payment_refunds'").get()).toEqual({ c: 0 })
    expect(accountBalance(f.accountId)).toBe(beforeBalance)
    expect(getOrderOrThrow(f.orderId)).toMatchObject({ paidMinor: moneyFromMajor(5_400), remainingMinor: moneyFromMajor(3_600) })
  })

  it('requires the narrow refund permission in the service', () => {
    const f = seed()
    reverseUnstarted(f.orderId)
    expect(() => refundPayment({ orderId: f.orderId, amountMinor: moneyFromMajor(1), cashAccountId: f.accountId, requestKey: crypto.randomUUID() }, context([P.payments.manage]))).toThrow(/صلاحية/)
  })

  it('rejects unauthorized direct IPC and accepts an authorized direct IPC call once', async () => {
    const f = seed()
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter(); spy.mockRestore()
    const request = { orderId: f.orderId, amountMinor: moneyFromMajor(1_000), cashAccountId: f.accountId, requestKey: crypto.randomUUID() }
    const limited = { ...context([P.payments.manage]).session, sessionId: `${env.ctx.session.sessionId}-limited` }
    createSession(limited); bindSessionToWebContents(91, limited.sessionId)
    const unauthorized = await handlers.get(IPC_CHANNELS.orders.refundPayment)!({ sender: { id: 91 } } as never, request)
    expect(unauthorized).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(count('customer_payment_refunds')).toBe(0)
    const authorized = await handlers.get(IPC_CHANNELS.orders.refundPayment)!({ sender: { id: 1 } } as never, request)
    expect(authorized).toMatchObject({ ok: true, data: { paidMinor: moneyFromMajor(4_400) } })
    expect(count('customer_payment_refunds')).toBe(1)
    const manufactured = seed()
    const sheet = issueWorkSheet({ orderId: manufactured.orderId }, env.ctx)
    const blocked = await handlers.get(IPC_CHANNELS.orders.refundPayment)!({ sender: { id: 1 } } as never, {
      ...request, orderId: manufactured.orderId, cashAccountId: manufactured.accountId,
      requestKey: crypto.randomUUID()
    })
    expect(blocked).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(count('customer_payment_refunds')).toBe(1)
    const production = getProductionOrder(sheet.id)
    reverseWorkSheet({ id: sheet.id, expectedToken: production.reversalToken, confirmation: sheet.documentNumber, reason: 'Undo pre-start issuance' }, env.ctx)
    const afterReversal = await handlers.get(IPC_CHANNELS.orders.refundPayment)!({ sender: { id: 1 } } as never, {
      ...request, orderId: manufactured.orderId, cashAccountId: manufactured.accountId,
      requestKey: crypto.randomUUID()
    })
    expect(afterReversal).toMatchObject({ ok: true, data: { paidMinor: moneyFromMajor(4_400) } })
    expect(count('customer_payment_refunds')).toBe(2)
  })

  it('keeps cancellation/deletion separate and leaves integrity intact', () => {
    const f = seed()
    refund(f)
    expect(getOrderOrThrow(f.orderId)).toMatchObject({ status: 'confirmed', totalMinor: moneyFromMajor(9_000) })
    expect(getFinalInvoice(f.invoiceId).invoice.status).toBe('approved')
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
