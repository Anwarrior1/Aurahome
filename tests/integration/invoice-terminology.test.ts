import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer } from '@main/services/parties/parties.service'
import { createQuotation } from '@main/services/sales/quotations.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { issueRelease, recordDelivery } from '@main/services/production/production.service'
import { buildPreliminaryInvoice, buildFinalInvoice } from '@main/services/documents/documents.service'
import { renderPreliminaryInvoice, renderFinalInvoice } from '@main/reports/templates/documents.template'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * Terminology-only pass, verified against the actual rendered PDF HTML:
 *   "فاتورة أولية" → "فاتورة مبدئية"
 *   "فاتورة نهائية" → "فاتورة معتمدة"
 *
 * Document numbering (QT-/SO-/FI- prefixes), customer-safe content
 * rules, and every business/workflow gate are untouched — this test
 * asserts exactly that alongside the new title text.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const COMPANY = { name: 'AURA home' }

/**
 * Both customer documents, through the real gates. The preliminary
 * invoice is independent (it creates nothing); the approved invoice is
 * what produces the order, which then runs payment → permit → delivery.
 */
function fullOrder() {
  const customerId = createCustomer({ name: 'عميل' }, env.ctx)
  const quotation = createQuotation({
    customerId,
    lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
  }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(1000) }, env.ctx)
  issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
  recordDelivery({ orderId: order.id, kind: 'delivery' }, env.ctx)
  return { quotation, invoice, order }
}

describe('printed document titles use the new terminology', () => {
  it('the preliminary invoice PDF heading is EXACTLY "فاتورة مبدئية" — no "/ عرض سعر" suffix', () => {
    const { quotation } = fullOrder()
    const html = renderPreliminaryInvoice(buildPreliminaryInvoice(quotation.id), COMPANY)
    const heading = html.match(/<h1>([^<]*)<\/h1>/)?.[1]

    expect(heading).toBe('فاتورة مبدئية')
    expect(html).toContain('<title>فاتورة مبدئية')
    expect(html).not.toContain('عرض سعر')
    expect(html).not.toContain('فاتورة أولية')
    expect(html).not.toContain('الفاتورة الأولية')
    // Document numbering is an internal identifier, untouched.
    expect(quotation.documentNumber).toMatch(/^QT-/)
    expect(html).toContain(quotation.documentNumber)
  })

  it('the final invoice PDF is titled "فاتورة معتمدة"', () => {
    const { invoice } = fullOrder()
    const html = renderFinalInvoice(buildFinalInvoice(invoice.id), COMPANY)

    expect(html).toContain('فاتورة معتمدة')
    expect(html).toContain('<title>فاتورة معتمدة')
    expect(html).not.toContain('فاتورة نهائية')
    expect(html).not.toContain('الفاتورة النهائية')
    expect(invoice.documentNumber).toMatch(/^FI-/)
  })

  it('customer-safe content and totals are unaffected by the terminology change', () => {
    const { invoice } = fullOrder()
    const html = renderFinalInvoice(buildFinalInvoice(invoice.id), COMPANY)

    expect(html).toContain('1.000,00')
    for (const leak of ['التكلفة', 'الربح', 'الهامش', 'FIFO', 'د.ل التكلفة']) {
      expect(html).not.toContain(leak)
    }
  })

  it('document numbering is unchanged: QT- preliminary, FI- approved, SO- order', () => {
    const { quotation, invoice, order } = fullOrder()
    expect(quotation.documentNumber).toMatch(/^QT-/)
    expect(invoice.documentNumber).toMatch(/^FI-/)
    expect(order.documentNumber).toMatch(/^SO-/)
  })
})
