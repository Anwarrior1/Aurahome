import { fulfillOrder } from '../helpers/sales-flow'
import { issueWorkSheet as issueLifecycleWorkSheet, completeProduction as completeLifecycleProduction } from '@main/services/production/production.service'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import {
  approveFinalInvoice,
  createFinalInvoice,
  getFinalInvoice,
  listFinalInvoices
} from '@main/services/sales/final-invoices.service'
import {
  archiveOrder,
  cancelOrder,
  getOrderOrThrow
} from '@main/services/sales/orders.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let customerId: number

beforeEach(() => {
  env = setupTestDatabase()
  customerId = createCustomer({ name: 'عميل أرشيف الفواتير' }, env.ctx)
})

afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})

function createInvoice(description: string, amount = 9000) {
  return createFinalInvoice({
    customerId,
    depositPercentBp: 0,
    lines: [{
      lineKind: 'custom',
      description,
      specifications: `مواصفات ${description}`,
      quantityMicro: q(1),
      unitPriceMinor: m(amount)
    }]
  }, env.ctx)
}

function approve(description: string) {
  const invoice = createInvoice(description)
  const approval = approveFinalInvoice(invoice.id, env.ctx)
  return { invoice, order: getOrderOrThrow(approval.orderId) }
}

function completedArchived(description: string) {
  const result = approve(description)
  fulfillOrder(result.order.id, env.ctx)
  archiveOrder({ id: result.order.id, archive: true }, env.ctx)
  return result
}

function page(
  filter: Parameters<typeof listFinalInvoices>[0] = {},
  session = env.ctx.session,
  request: { limit?: number; cursor?: string } = {}
) {
  const result = listFinalInvoices(filter, session, request)
  return { ...result, rows: result.items as Array<Record<string, unknown>>, total: result.summary.totalCount }
}

describe('Approved Invoices derive archive visibility from their Customer Order', () => {
  it('keeps an active linked invoice in the active list only', () => {
    const { invoice, order } = approve('نشطة')
    expect(page().rows).toMatchObject([{ id: invoice.id, orderId: order.id, orderArchivedAt: null }])
    expect(page({ archived: true }).rows).toEqual([])
  })

  it('moves a completed order invoice to archived visibility and restores it automatically', () => {
    const { invoice, order } = completedArchived('مكتملة')
    expect(page().rows).toEqual([])
    expect(page({ archived: true }).rows).toMatchObject([{ id: invoice.id, orderId: order.id }])

    archiveOrder({ id: order.id, archive: false }, env.ctx)
    expect(page().rows).toMatchObject([{ id: invoice.id, orderId: order.id, orderArchivedAt: null }])
    expect(page({ archived: true }).rows).toEqual([])
  })

  it('applies the same derived visibility to an archived cancelled order', () => {
    const { invoice, order } = approve('ملغاة')
    completeLifecycleProduction(issueLifecycleWorkSheet({ orderId: order.id, overrideDepositRequirement: true }, env.ctx).id, env.ctx)
    cancelOrder({ orderId: order.id, reason: 'طلب العميل' }, env.ctx)
    archiveOrder({ id: order.id, archive: true }, env.ctx)
    expect(page().rows).toEqual([])
    expect(page({ archived: true, status: 'approved' }).rows).toMatchObject([{ id: invoice.id }])
  })

  it('preserves the invoice, its snapshots, figures, lines and stable relation exactly', () => {
    const { invoice, order } = approve('تاريخية محفوظة')
    const before = getFinalInvoice(invoice.id)
    const invoiceRowsBefore = getRawConnection().prepare('SELECT * FROM final_invoices WHERE id = ?').all(invoice.id)
    const linesBefore = getRawConnection().prepare('SELECT * FROM final_invoice_lines WHERE final_invoice_id = ? ORDER BY id').all(invoice.id)
    const paymentsBefore = getRawConnection().prepare('SELECT * FROM customer_payments WHERE order_id = ? ORDER BY id').all(order.id)

    fulfillOrder(order.id, env.ctx)
    archiveOrder({ id: order.id, archive: true }, env.ctx)

    expect(getFinalInvoice(invoice.id)).toEqual(before)
    expect(getRawConnection().prepare('SELECT * FROM final_invoices WHERE id = ?').all(invoice.id)).toEqual(invoiceRowsBefore)
    expect(getRawConnection().prepare('SELECT * FROM final_invoice_lines WHERE final_invoice_id = ? ORDER BY id').all(invoice.id)).toEqual(linesBefore)
    expect(getRawConnection().prepare('SELECT * FROM customer_payments WHERE order_id = ? ORDER BY id').all(order.id)).toEqual(paymentsBefore)
    expect(getRawConnection().prepare('SELECT final_invoice_id FROM orders WHERE id = ?').get(order.id)).toEqual({ final_invoice_id: invoice.id })
  })

  it('keeps an invoice without a linked Customer Order active', () => {
    const draft = createInvoice('مسودة بلا طلب')
    completedArchived('فاتورة أخرى مؤرشفة')
    expect(page().rows).toMatchObject([{ id: draft.id, orderId: null, orderArchivedAt: null }])
    expect(page({ archived: true }).rows).not.toContainEqual(expect.objectContaining({ id: draft.id }))
  })

  it('uses one predicate for count, search, status and bounded pagination', () => {
    const first = completedArchived('بحث أرشيف ألف')
    const second = completedArchived('بحث أرشيف باء')
    approve('نشطة خارج الأرشيف')

    const filter = { archived: true, search: 'عميل أرشيف الفواتير', status: 'approved' }
    const firstPage = page(filter, env.ctx.session, { limit: 1 })
    const secondPage = page(filter, env.ctx.session, { limit: 1, cursor: firstPage.nextCursor! })
    expect(firstPage).toMatchObject({ total: 2, hasMore: true })
    expect(secondPage).toMatchObject({ total: 2, hasMore: false, nextCursor: null })
    expect([firstPage.rows[0]?.id, secondPage.rows[0]?.id].sort()).toEqual([first.invoice.id, second.invoice.id].sort())
    // A cursor is bound to its filters and cannot be replayed against another bucket.
    expect(() => page({ archived: false, search: 'عميل أرشيف الفواتير' }, env.ctx.session, { cursor: firstPage.nextCursor! })).toThrow()
    expect(page({ archived: false, search: 'عميل أرشيف الفواتير' }).total).toBe(1)
  })

  it('does not let an orderId filter bypass active/archived semantics', () => {
    const { invoice, order } = completedArchived('استعلام مباشر')
    expect(listFinalInvoices({ orderId: order.id }).items).toEqual([])
    expect(listFinalInvoices({ orderId: order.id, archived: true }).items).toMatchObject([{ id: invoice.id }])
  })

  it('classifies every historical invoice carrying the same order FK consistently', () => {
    const { invoice, order } = completedArchived('فاتورة التحويل الأساسية')
    const historical = createInvoice('مراجعة تاريخية')
    getRawConnection().prepare(
      "UPDATE final_invoices SET order_id = ?, status = 'approved', issued_at = '2026-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(order.id, historical.id)

    expect(page().rows).toEqual([])
    expect(page({ archived: true }).rows.map((row) => row.id).sort()).toEqual([invoice.id, historical.id].sort())
    expect(getRawConnection().prepare('SELECT final_invoice_id FROM orders WHERE id = ?').get(order.id)).toEqual({ final_invoice_id: invoice.id })
  })

  it('keeps archived invoices viewable but redacts live receivables without their permission', () => {
    const { invoice } = completedArchived('صلاحيات')
    const limited = {
      ...env.ctx.session,
      user: { ...env.ctx.session.user, isAdmin: false },
      permissions: [P.finalInvoices.view]
    }
    const result = page({ archived: true }, limited)
    expect(result.rows).toMatchObject([{ id: invoice.id, totalMinor: m(9000) }])
    expect(result.rows[0]).not.toHaveProperty('paidMinor')
    expect(result.rows[0]).not.toHaveProperty('remainingMinor')
    expect(result.summary.totalApprovedMinor).toBeUndefined()
    expect(result.summary.totalOutstandingMinor).toBeUndefined()
    expect(getFinalInvoice(invoice.id).invoice.id).toBe(invoice.id)
  })

  it('does not create duplicate invoice records while archive state changes', () => {
    const { invoice, order } = completedArchived('بلا تكرار')
    archiveOrder({ id: order.id, archive: false }, env.ctx)
    archiveOrder({ id: order.id, archive: true }, env.ctx)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS count FROM final_invoices WHERE id = ?').get(invoice.id)).toEqual({ count: 1 })
    expect(page({ archived: true }).rows.filter((row) => row.id === invoice.id)).toHaveLength(1)
  })
})
