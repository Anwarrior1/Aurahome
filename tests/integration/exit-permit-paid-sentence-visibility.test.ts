import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer, customerBalances } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrderOrThrow, recordPayment } from '@main/services/sales/orders.service'
import { issueRelease, listReleases } from '@main/services/production/production.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { buildRelease } from '@main/services/documents/documents.service'
import { renderRelease } from '@main/reports/templates/documents.template'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

const paidSentence = 'تم سداد كامل قيمة الطلب. يُسمح بخروج الطلب من المصنع والتوجه لموقع التركيب.'
const company = { name: 'AURA home' }

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function createOrder(paid: boolean, totalMajor = 1000) {
  const customerId = createCustomer({ name: paid ? 'عميل مسدد' : 'عميل غير مسدد' }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    requiresInstallation: true,
    lines: [{
      lineKind: 'custom',
      description: 'مطبخ اختبار إذن الخروج',
      quantityMicro: quantityFromDisplay(1),
      unitPriceMinor: moneyFromMajor(totalMajor)
    }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  if (paid) recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
  return getOrderOrThrow(order.id)
}

function partiallyPaidOrder() {
  const order = createOrder(false, 10_000)
  recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(6_400) }, env.ctx)
  return getOrderOrThrow(order.id)
}

function render(releaseId: number): string {
  return renderRelease(buildRelease(releaseId), company)
}

describe('Exit/Installation Permit paid-sentence visibility', () => {
  it('prints the sentence exactly once for an eligible paid order when checked', () => {
    const order = createOrder(true)
    const release = issueRelease({
      orderId: order.id,
      kind: 'installation',
      showPaidExitSentence: true
    }, env.ctx)
    const html = render(release.id)

    expect(html.split(paidSentence)).toHaveLength(2)
    expect(html).toContain(`<div class="notice">${paidSentence}</div>`)
  })

  it('removes the whole notice block and its layout space when unchecked', () => {
    const order = createOrder(true)
    const release = issueRelease({
      orderId: order.id,
      kind: 'installation',
      showPaidExitSentence: false
    }, env.ctx)
    const html = render(release.id)

    expect(html).not.toContain(paidSentence)
    expect(html).not.toContain('<div class="notice">')
    expect(html).not.toMatch(/<div class="notice">\s*<\/div>/)
  })

  it('cannot print the claim for an unpaid order even when the stored option is checked', () => {
    const order = createOrder(false)
    const permit = issueRelease({
      orderId: order.id,
      kind: 'installation',
      showPaidExitSentence: true
    }, env.ctx)
    const releaseId = permit.id

    const dto = buildRelease(releaseId)
    expect(dto.balanceConfirmedPaid).toBe(false)
    expect(dto.showPaidExitSentence).toBe(true)
    expect(renderRelease(dto, company)).not.toContain(paidSentence)
  })

  it('persists the unchecked choice and uses it when the permit is reopened', () => {
    const order = createOrder(true)
    const release = issueRelease({
      orderId: order.id,
      kind: 'installation',
      showPaidExitSentence: false
    }, env.ctx)

    expect(listReleases({ orderId: order.id }).items[0]?.showPaidExitSentence).toBe(false)
    expect(buildRelease(release.id).showPaidExitSentence).toBe(false)
    expect(render(release.id)).not.toContain(paidSentence)
  })

  it('preserves the previous visible behaviour for a legacy null option', () => {
    const order = createOrder(true)
    const releaseId = Number(getRawConnection().prepare(`
      INSERT INTO releases
        (document_number, order_id, kind, authorized_at, show_paid_exit_sentence)
      VALUES (?, ?, 'installation', ?, NULL)
    `).run('IA-LEGACY-PAID', order.id, new Date().toISOString()).lastInsertRowid)

    const dto = buildRelease(releaseId)
    expect(dto.showPaidExitSentence).toBe(true)
    expect(renderRelease(dto, company)).toContain(paidSentence)
  })

  it('does not alter payment records or balances when the option is toggled', () => {
    const order = createOrder(true)
    const db = getRawConnection()
    const before = getOrderOrThrow(order.id)
    const paymentsBefore = db.prepare('SELECT COUNT(*) AS count FROM customer_payments WHERE order_id = ?')
      .get(order.id) as { count: number }

    issueRelease({
      orderId: order.id,
      kind: 'installation',
      showPaidExitSentence: false
    }, env.ctx)

    const after = getOrderOrThrow(order.id)
    const paymentsAfter = db.prepare('SELECT COUNT(*) AS count FROM customer_payments WHERE order_id = ?')
      .get(order.id) as { count: number }
    expect(after.paidMinor).toBe(before.paidMinor)
    expect(after.remainingMinor).toBe(before.remainingMinor)
    expect(paymentsAfter.count).toBe(paymentsBefore.count)
  })

  it('keeps the historical checked default when callers omit the option', () => {
    const order = createOrder(true)
    const release = issueRelease({ orderId: order.id, kind: 'installation' }, env.ctx)

    expect(buildRelease(release.id).showPaidExitSentence).toBe(true)
    expect(render(release.id)).toContain(paidSentence)
  })

  it('allows a partially paid installation without an override', () => {
    const order = partiallyPaidOrder()

    issueRelease({ orderId: order.id, kind: 'installation' }, env.ctx)
    expect(listReleases({ orderId: order.id }).items[0]).toMatchObject({ authorizationType: 'unpaid', remainingMinorAtIssue: moneyFromMajor(3_600) })
  })

  it('requires ordinary release permission, not historical override permission', () => {
    const order = partiallyPaidOrder()
    const roleId = createRole({ name: 'مُصدر إذن فقط', permissions: [P.releases.issue] }, env.ctx)
    createUser({ username: 'release-only', password: 'secret123', fullName: 'مستخدم إصدار', roleId }, env.ctx)
    const { session } = login('release-only', 'secret123', 501)

    expect(issueRelease({
      orderId: order.id,
      kind: 'installation',
      unpaidReleaseOverride: true
    }, { session }).id).toBeGreaterThan(0)
    expect(listReleases({ orderId: order.id }).items).toHaveLength(1)
  })

  it('issues an unpaid permit without requiring a reason', () => {
    const order = partiallyPaidOrder()

    const release = issueRelease({
      orderId: order.id,
      kind: 'installation',
      unpaidReleaseOverride: true
    }, env.ctx)

    expect(listReleases({ orderId: order.id }).items[0]).toMatchObject({
      id: release.id,
      authorizationType: 'unpaid',
      unpaidOverrideReason: null
    })
  })

  it('issues, persists and audits an unpaid release with exact snapshots', () => {
    const order = partiallyPaidOrder()
    const release = issueRelease({
      orderId: order.id,
      kind: 'installation',
      showPaidExitSentence: true,
      unpaidReleaseOverride: true
    }, env.ctx)

    const listed = listReleases({ orderId: order.id }).items[0]
    expect(listed).toMatchObject({
      id: release.id,
      authorizationType: 'unpaid',
      orderTotalMinorAtIssue: moneyFromMajor(10_000),
      paidMinorAtIssue: moneyFromMajor(6_400),
      remainingMinorAtIssue: moneyFromMajor(3_600),
      unpaidOverrideReason: null,
      createdBy: env.ctx.session.user.id
    })

    const event = getRawConnection().prepare(`
      SELECT user_id, action, entity_id, details, created_at
      FROM audit_log WHERE action = 'releases.issue'
      ORDER BY id DESC LIMIT 1
    `).get() as {
      user_id: number; action: string; entity_id: string; details: string; created_at: string
    }
    const details = JSON.parse(event.details) as Record<string, unknown>
    expect(event.user_id).toBe(env.ctx.session.user.id)
    expect(event.entity_id).toBe(String(release.id))
    expect(event.created_at).toBeTruthy()
    expect(details).toMatchObject({
      orderId: order.id,
      releaseId: release.id,
      authorizationType: 'unpaid',
      authorizedByUserId: env.ctx.session.user.id,
      orderTotalMinor: moneyFromMajor(10_000),
      paidMinor: moneyFromMajor(6_400),
      remainingMinor: moneyFromMajor(3_600),
      unpaidOverrideReason: null,
      showPaidExitSentence: true
    })
  })

  it('prints the unpaid balance and never prints the paid claim or override notice', () => {
    const order = partiallyPaidOrder()
    const release = issueRelease({
      orderId: order.id,
      kind: 'installation',
      showPaidExitSentence: true,
      unpaidReleaseOverride: true
    }, env.ctx)
    const dto = buildRelease(release.id)
    const html = renderRelease(dto, company)

    expect(dto.authorizationType).toBe('unpaid')
    expect(dto.balanceConfirmedPaid).toBe(false)
    expect(dto.remainingAtIssue).toBe('3.600,00 د.ل')
    expect(html).not.toContain(paidSentence)
    expect(html).not.toContain('تم التصريح بخروج الطلب بموافقة إدارية')
    expect(html).toContain('3.600,00 د.ل')
    expect(html).not.toContain('سبب التصريح')
    expect(html).not.toContain('التحصيل عند التركيب')
    expect(html).toContain('غير مسدد بالكامل')
  })

  it('preserves a legacy saved reason but never renders it in the PDF HTML', () => {
    const order = partiallyPaidOrder()
    const legacyReason = 'سبب تاريخي محفوظ'
    const release = issueRelease({
      orderId: order.id,
      kind: 'installation',
      unpaidReleaseOverride: true
    }, env.ctx)

    getRawConnection().prepare('UPDATE releases SET unpaid_override_reason = ? WHERE id = ?')
      .run(legacyReason, release.id)

    const stored = getRawConnection().prepare('SELECT unpaid_override_reason FROM releases WHERE id = ?')
      .get(release.id) as { unpaid_override_reason: string | null }
    const html = render(release.id)
    expect(stored.unpaid_override_reason).toBe(legacyReason)
    expect(html).not.toContain('سبب التصريح')
    expect(html).not.toContain(legacyReason)
    expect(html).toContain('3.600,00 د.ل')
  })

  it('keeps the unpaid permit snapshot unchanged after later collection', () => {
    const order = partiallyPaidOrder()
    const release = issueRelease({
      orderId: order.id,
      kind: 'installation',
      unpaidReleaseOverride: true
    }, env.ctx)

    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(3_600) }, env.ctx)
    expect(getOrderOrThrow(order.id).remainingMinor).toBe(0)

    const dto = buildRelease(release.id)
    expect(dto.authorizationType).toBe('unpaid')
    expect(dto.balanceConfirmedPaid).toBe(false)
    expect(dto.remainingAtIssue).toBe('3.600,00 د.ل')
    const html = renderRelease(dto, company)
    expect(html).toContain('3.600,00 د.ل')
    expect(html).not.toContain(paidSentence)
  })

  it('has zero payment, receivable, customer-balance or cash effect', () => {
    const order = partiallyPaidOrder()
    const db = getRawConnection()
    const financialState = () => ({
      order: db.prepare(`SELECT total_minor, paid_minor, remaining_minor, payment_status
        FROM orders WHERE id = ?`).get(order.id),
      invoice: db.prepare('SELECT total_minor FROM final_invoices WHERE id = ?')
        .get(order.finalInvoiceId),
      payments: db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount_minor), 0) AS total
        FROM customer_payments WHERE order_id = ?`).get(order.id),
      cash: db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount_minor), 0) AS total
        FROM cash_transactions`).get(),
      customer: customerBalances().find((row) => row.customerId === order.customerId)
    })
    const before = financialState()

    issueRelease({
      orderId: order.id,
      kind: 'installation',
      unpaidReleaseOverride: true
    }, env.ctx)

    expect(financialState()).toEqual(before)
  })

  it('supports unpaid handover permits too', () => {
    const order = partiallyPaidOrder()
    expect(issueRelease({
      orderId: order.id,
      kind: 'delivery',
      unpaidReleaseOverride: true
    }, env.ctx).id).toBeGreaterThan(0)
  })
})
