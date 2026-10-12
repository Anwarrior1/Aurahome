import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import {
  createQuotation,
  getQuotation,
  updateQuotation,
  createRevision
} from '@main/services/sales/quotations.service'
import {
  createFinalInvoice,
  getFinalInvoice,
  updateFinalInvoice,
  approveFinalInvoice
} from '@main/services/sales/final-invoices.service'
import { getOrderOrThrow } from '@main/services/sales/orders.service'
import {
  buildPreliminaryInvoice,
  buildFinalInvoice
} from '@main/services/documents/documents.service'
import {
  renderPreliminaryInvoice,
  renderFinalInvoice
} from '@main/reports/templates/documents.template'
import { computeDocumentTotals } from '@main/services/sales/document-totals'
import { quotations, finalInvoices } from '@main/db/schema/sales.schema'
import { stockLevels } from '@main/services/inventory/valuation.service'
import { formatMoney, money, moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import {
  DEFAULT_PRINT_VISIBILITY,
  parsePrintVisibility,
  sanitizePrintVisibility,
  PRINT_VISIBILITY_KEYS
} from '@shared/documents/print-visibility'
import { eq } from 'drizzle-orm'

/**
 * سعر المتر / سعر التركيب / سعر التوصيل, and per-field PDF visibility,
 * on BOTH customer documents.
 *
 * The two ideas under test are deliberately independent:
 *  • installation and delivery are CHARGES — each joins the total
 *    exactly once, and سعر المتر never joins it at all (this document
 *    model has no metre-based quantity to derive a price from);
 *  • visibility is PRESENTATION — hiding a row removes it from the PDF
 *    and changes no stored figure whatsoever.
 */
let env: TestEnv
beforeEach(() => {
  env = setupTestDatabase()
})
afterEach(() => env.cleanup())

const LINE = {
  lineKind: 'custom' as const,
  description: 'خزانة مطبخ',
  quantityMicro: quantityFromDisplay(1),
  unitPriceMinor: moneyFromMajor(14_000)
}
/** The app's own display format, so assertions never hard-code a locale. */
const shown = (major: number): string => formatMoney(money(moneyFromMajor(major)))
const customer = (): number => createCustomer({ name: 'عميل تجريبي', phone: '0912345678' }, env.ctx)

/** 14,000 goods + 1,000 installation + 500 delivery = 15,500. */
const CHARGED = {
  meterPriceMinor: moneyFromMajor(250),
  installationPriceMinor: moneyFromMajor(1_000),
  deliveryPriceMinor: moneyFromMajor(500)
}

function makeQuotation(extra: Record<string, unknown> = {}): number {
  return createQuotation({ customerId: customer(), lines: [LINE], ...CHARGED, ...extra }, env.ctx)
    .id
}
function makeInvoice(extra: Record<string, unknown> = {}): number {
  return createFinalInvoice(
    { customerId: customer(), lines: [LINE], ...CHARGED, ...extra },
    env.ctx
  ).id
}

// ---------------------------------------------------------------- 1-4

describe('the three commercial fields persist on both documents (items 1-4)', () => {
  it('Preliminary Invoice persists meter price, installation price and delivery price', () => {
    const { quotation } = getQuotation(makeQuotation())
    expect(quotation.meterPriceMinor).toBe(moneyFromMajor(250))
    expect(quotation.installationPriceMinor).toBe(moneyFromMajor(1_000))
    expect(quotation.deliveryPriceMinor).toBe(moneyFromMajor(500))
  })

  it('Approved Invoice persists all three', () => {
    const { invoice } = getFinalInvoice(makeInvoice())
    expect(invoice.meterPriceMinor).toBe(moneyFromMajor(250))
    expect(invoice.installationPriceMinor).toBe(moneyFromMajor(1_000))
    expect(invoice.deliveryPriceMinor).toBe(moneyFromMajor(500))
  })

  it('they survive an edit/reopen round trip on both documents', () => {
    const qId = makeQuotation()
    updateQuotation(qId, { installationPriceMinor: moneyFromMajor(2_000) }, env.ctx)
    const reopenedQ = getQuotation(qId).quotation
    expect(reopenedQ.installationPriceMinor).toBe(moneyFromMajor(2_000))
    // Untouched fields keep their value rather than resetting to zero.
    expect(reopenedQ.deliveryPriceMinor).toBe(moneyFromMajor(500))
    expect(reopenedQ.meterPriceMinor).toBe(moneyFromMajor(250))

    const iId = makeInvoice()
    updateFinalInvoice(iId, { deliveryPriceMinor: moneyFromMajor(750) }, env.ctx)
    const reopenedI = getFinalInvoice(iId).invoice
    expect(reopenedI.deliveryPriceMinor).toBe(moneyFromMajor(750))
    expect(reopenedI.installationPriceMinor).toBe(moneyFromMajor(1_000))
  })

  it('a Preliminary Invoice revision carries the commercial values forward', () => {
    const revision = createRevision(makeQuotation(), env.ctx)
    const { quotation } = getQuotation(revision.id)
    expect(quotation.installationPriceMinor).toBe(moneyFromMajor(1_000))
    expect(quotation.deliveryPriceMinor).toBe(moneyFromMajor(500))
    expect(quotation.meterPriceMinor).toBe(moneyFromMajor(250))
  })
})

// ---------------------------------------------------------------- 5-8

describe('charges join the total exactly once (items 5-8)', () => {
  it('installation is added exactly once to the Preliminary Invoice total', () => {
    const withCharge = getQuotation(makeQuotation({ deliveryPriceMinor: 0 })).quotation
    const without = getQuotation(
      createQuotation(
        { customerId: customer(), lines: [LINE], installationPriceMinor: 0, deliveryPriceMinor: 0 },
        env.ctx
      ).id
    ).quotation
    expect(withCharge.totalMinor - without.totalMinor).toBe(moneyFromMajor(1_000))
    // Goods subtotal keeps its original meaning — charges are NOT folded in.
    expect(withCharge.subtotalMinor).toBe(moneyFromMajor(14_000))
  })

  it('delivery is added exactly once', () => {
    const withCharge = getQuotation(makeQuotation({ installationPriceMinor: 0 })).quotation
    expect(withCharge.totalMinor).toBe(moneyFromMajor(14_500))
  })

  it('both together are counted once each — 14,000 + 1,000 + 500 = 15,500', () => {
    expect(getQuotation(makeQuotation()).quotation.totalMinor).toBe(moneyFromMajor(15_500))
    expect(getFinalInvoice(makeInvoice()).invoice.totalMinor).toBe(moneyFromMajor(15_500))
  })

  it('سعر المتر never changes a total — it is commercial information only', () => {
    const base = getQuotation(
      createQuotation({ customerId: customer(), lines: [LINE] }, env.ctx).id
    ).quotation
    const withMeter = getQuotation(
      createQuotation(
        { customerId: customer(), lines: [LINE], meterPriceMinor: moneyFromMajor(999) },
        env.ctx
      ).id
    ).quotation
    expect(withMeter.totalMinor).toBe(base.totalMinor)
    expect(withMeter.subtotalMinor).toBe(base.subtotalMinor)
  })

  it('the advance payment is a percentage of the total INCLUDING the charges', () => {
    const { quotation } = getQuotation(makeQuotation({ depositPercentBp: 6000 }))
    // 60% of 15,500 — not of the 14,000 goods subtotal.
    expect(quotation.depositRequiredMinor).toBe(moneyFromMajor(9_300))
  })

  it('the remaining balance uses the same charged total', () => {
    const { quotation } = getQuotation(makeQuotation({ depositPercentBp: 6000 }))
    expect(quotation.remainingMinor).toBe(moneyFromMajor(6_200))
    expect(quotation.depositRequiredMinor + quotation.remainingMinor).toBe(quotation.totalMinor)
  })

  it('a percentage discount applies to goods AND charges, and an amount discount cannot exceed them', () => {
    const percent = computeDocumentTotals([LINE], 'percent', 1000 /* 10% */, 6000, {
      installationPriceMinor: moneyFromMajor(1_000),
      deliveryPriceMinor: moneyFromMajor(500)
    })
    expect(percent.discountMinor).toBe(moneyFromMajor(1_550))
    expect(percent.totalMinor).toBe(moneyFromMajor(13_950))

    const clamped = computeDocumentTotals([LINE], 'amount', moneyFromMajor(99_999), 6000, {
      installationPriceMinor: moneyFromMajor(1_000),
      deliveryPriceMinor: moneyFromMajor(500)
    })
    expect(clamped.discountMinor).toBe(moneyFromMajor(15_500))
    expect(clamped.totalMinor).toBe(0)
  })

  it('a document with no charges is arithmetically identical to before the feature', () => {
    const before = computeDocumentTotals([LINE], 'percent', 1000, 6000)
    const explicitZero = computeDocumentTotals([LINE], 'percent', 1000, 6000, {
      installationPriceMinor: 0,
      deliveryPriceMinor: 0
    })
    expect(explicitZero).toEqual(before)
    expect(before.totalMinor).toBe(moneyFromMajor(12_600))
  })
})

// --------------------------------------------------------------- 9-13

describe('PDF visibility shows and hides rows without touching the arithmetic (items 9-13)', () => {
  const show = (id: number): string =>
    renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' })

  it('shows the installation row when visibility is true', () => {
    const html = show(makeQuotation({ printVisibility: { installationPrice: true } }))
    expect(html).toContain('سعر التركيب')
  })

  it('hides the installation row when visibility is false', () => {
    const html = show(makeQuotation({ printVisibility: { installationPrice: false } }))
    expect(html).not.toContain('سعر التركيب')
  })

  it('a hidden installation charge still participates in the invoice total', () => {
    const id = makeQuotation({
      printVisibility: { installationPrice: false, deliveryPrice: false }
    })
    const { quotation } = getQuotation(id)
    // Stored total is unchanged...
    expect(quotation.totalMinor).toBe(moneyFromMajor(15_500))
    const dto = buildPreliminaryInvoice(id)
    // ...and the PDF's final amount is that same total, not a second
    // "PDF total" recomputed from only the visible rows.
    expect(dto.installationPrice).toBeUndefined()
    expect(dto.deliveryPrice).toBeUndefined()
    expect(dto.totalAfterDiscount).toBe(shown(15_500))
  })

  it('shows and hides the delivery row the same way, on both documents', () => {
    expect(show(makeQuotation({ printVisibility: { deliveryPrice: true } }))).toContain(
      'سعر التوصيل'
    )
    expect(show(makeQuotation({ printVisibility: { deliveryPrice: false } }))).not.toContain(
      'سعر التوصيل'
    )

    const visible = buildFinalInvoice(makeInvoice({ printVisibility: { deliveryPrice: true } }))
    const hidden = buildFinalInvoice(makeInvoice({ printVisibility: { deliveryPrice: false } }))
    expect(renderFinalInvoice(visible, { name: 'AURA' })).toContain('سعر التوصيل')
    expect(renderFinalInvoice(hidden, { name: 'AURA' })).not.toContain('سعر التوصيل')
    expect(hidden.totalAfterDiscount).toBe(visible.totalAfterDiscount)
  })

  it('meter-price visibility works and never affects the total', () => {
    expect(show(makeQuotation({ printVisibility: { meterPrice: true } }))).toContain('سعر المتر')
    const hidden = makeQuotation({ printVisibility: { meterPrice: false } })
    expect(show(hidden)).not.toContain('سعر المتر')
    expect(getQuotation(hidden).quotation.meterPriceMinor).toBe(moneyFromMajor(250))
    expect(getQuotation(hidden).quotation.totalMinor).toBe(moneyFromMajor(15_500))
  })

  it('a zero charge prints no row at all, so the breakdown never shows an empty line', () => {
    const html = show(
      makeQuotation({ installationPriceMinor: 0, deliveryPriceMinor: 0, meterPriceMinor: 0 })
    )
    expect(html).not.toContain('سعر التركيب')
    expect(html).not.toContain('سعر التوصيل')
    expect(html).not.toContain('سعر المتر')
    // The final amount is still printed.
    expect(html).toContain('الإجمالي النهائي')
  })
})

// --------------------------------------------------------------- 14-16

describe('visibility persistence and legacy documents (items 14-16)', () => {
  it('print visibility survives save → reopen on both documents', () => {
    const qId = makeQuotation({ printVisibility: { deliveryPrice: false, accessories: true } })
    const storedQ = parsePrintVisibility(getQuotation(qId).quotation.printVisibility)
    expect(storedQ.deliveryPrice).toBe(false)
    expect(storedQ.accessories).toBe(true)

    const iId = makeInvoice({ printVisibility: { installationPrice: false } })
    expect(
      parsePrintVisibility(getFinalInvoice(iId).invoice.printVisibility).installationPrice
    ).toBe(false)
  })

  it('an update that sends no visibility leaves the saved choice alone', () => {
    const id = makeQuotation({ printVisibility: { deliveryPrice: false } })
    updateQuotation(id, { installationPriceMinor: moneyFromMajor(1) }, env.ctx)
    expect(parsePrintVisibility(getQuotation(id).quotation.printVisibility).deliveryPrice).toBe(
      false
    )
  })

  it('unknown keys from a renderer are never persisted', () => {
    expect(
      sanitizePrintVisibility({ deliveryPrice: false, hackerKey: true, costPrice: true })
    ).toEqual({ deliveryPrice: false })
    // Non-boolean values are dropped too.
    expect(sanitizePrintVisibility({ deliveryPrice: 'yes' })).toEqual({})
  })

  it('a legacy document with no stored configuration keeps its original printed appearance', () => {
    const id = makeQuotation()
    // Simulate a row written before this feature existed.
    getDatabase()
      .update(quotations)
      .set({ printVisibility: null })
      .where(eq(quotations.id, id))
      .run()
    const dto = buildPreliminaryInvoice(id)
    // Everything the template printed before is still printed...
    expect(dto.subtotal).not.toBe('')
    expect(dto.lines[0]?.description).toBe('خزانة مطبخ')
    expect(dto.lines[0]?.quantity).not.toBe('')
    expect(dto.customer.phone).toBe('0912345678')
    expect(dto.termsAndConditions).toBeDefined()
    // ...and what it never printed stays unprinted.
    expect(dto.lines[0]?.accessories).toBeUndefined()
    expect(dto.notes).toBeUndefined()
    expect(parsePrintVisibility(null)).toEqual(DEFAULT_PRINT_VISIBILITY)
  })

  it('an unparseable or partial configuration still resolves to a complete map', () => {
    expect(parsePrintVisibility('not json')).toEqual(DEFAULT_PRINT_VISIBILITY)
    const partial = parsePrintVisibility('{"deliveryPrice":false}')
    expect(partial.deliveryPrice).toBe(false)
    expect(Object.keys(partial).sort()).toEqual([...PRINT_VISIBILITY_KEYS].sort())
  })

  it('every existing printable field can be hidden, and hiding them empties only the PDF', () => {
    const allOff = Object.fromEntries(PRINT_VISIBILITY_KEYS.map((key) => [key, false]))
    const id = makeQuotation({ printVisibility: allOff })
    const dto = buildPreliminaryInvoice(id)
    expect(dto.customer.phone).toBeUndefined()
    expect(dto.subtotal).toBe('')
    expect(dto.discount).toBeUndefined()
    expect(dto.termsAndConditions).toBeUndefined()
    expect(dto.depositRequired).toBeUndefined()
    // The stored document is untouched.
    const { quotation } = getQuotation(id)
    expect(quotation.totalMinor).toBe(moneyFromMajor(15_500))
    expect(quotation.depositRequiredMinor).toBeGreaterThan(0)
    // And the customer still sees what they owe.
    expect(dto.totalAfterDiscount).toBe(shown(15_500))
  })
})

// --------------------------------------------------------------- 17-19

describe('"يشمل تركيباً" / "يشمل توصيلاً" (items 17-19)', () => {
  const render = (id: number): string =>
    renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' })

  it('يشمل تركيباً = true prints "يشمل التركيب" when visibility allows it', () => {
    const html = render(makeQuotation({ requiresInstallation: true, requiresDelivery: false }))
    expect(html).toContain('يشمل التركيب')
    expect(html).not.toContain('يشمل التوصيل')
  })

  it('يشمل تركيباً = false never prints the claim, whatever the visibility says', () => {
    const html = render(
      makeQuotation({
        requiresInstallation: false,
        printVisibility: { includesInstallation: true }
      })
    )
    expect(html).not.toContain('يشمل التركيب')
  })

  it('visibility can suppress a true statement without changing the stored fact', () => {
    const id = makeQuotation({
      requiresInstallation: true,
      printVisibility: { includesInstallation: false }
    })
    expect(render(id)).not.toContain('يشمل التركيب')
    expect(getQuotation(id).quotation.requiresInstallation).toBe(true)
  })

  it('يشمل توصيلاً behaves equivalently, and both print together when both apply', () => {
    const both = render(makeQuotation({ requiresInstallation: true, requiresDelivery: true }))
    expect(both).toContain('يشمل التركيب')
    expect(both).toContain('يشمل التوصيل')

    const deliveryOnly = render(
      makeQuotation({ requiresInstallation: false, requiresDelivery: true })
    )
    expect(deliveryOnly).toContain('يشمل التوصيل')
    expect(deliveryOnly).not.toContain('يشمل التركيب')
  })

  it('the statement is independent of the charge: included with no price, priced with no claim', () => {
    const includedFree = render(
      makeQuotation({ requiresInstallation: true, installationPriceMinor: 0 })
    )
    expect(includedFree).toContain('يشمل التركيب')
    expect(includedFree).not.toContain('سعر التركيب')

    const pricedNotIncluded = render(
      makeQuotation({ requiresInstallation: false, installationPriceMinor: moneyFromMajor(800) })
    )
    expect(pricedNotIncluded).not.toContain('يشمل التركيب')
    expect(pricedNotIncluded).toContain('سعر التركيب')
  })

  it('the Approved Invoice prints the same statements', () => {
    const html = renderFinalInvoice(
      buildFinalInvoice(makeInvoice({ requiresInstallation: true, requiresDelivery: true })),
      { name: 'AURA' }
    )
    expect(html).toContain('يشمل التركيب')
    expect(html).toContain('يشمل التوصيل')
  })
})

// --------------------------------------------------------------- 20-24

describe('existing workflows are unchanged (items 20-24)', () => {
  it('the Preliminary Invoice remains standalone — it still creates no order', () => {
    const id = makeQuotation()
    const { quotation } = getQuotation(id)
    expect(quotation.status).toBe('draft')
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM orders').get()).toEqual({ c: 0 })
  })

  it('Approved Invoice approval still works and still creates exactly one Customer Order', () => {
    const id = makeInvoice()
    const result = approveFinalInvoice(id, env.ctx)
    expect(result.alreadyApproved).toBe(false)
    expect(result.orderNumber).toMatch(/^SO-/)
    // Idempotent, exactly as before.
    expect(approveFinalInvoice(id, env.ctx).alreadyApproved).toBe(true)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM orders').get()).toEqual({ c: 1 })
  })

  it('the Customer Order carries the charged total and the commercial values', () => {
    const id = makeInvoice()
    const { orderId } = approveFinalInvoice(id, env.ctx)
    const order = getOrderOrThrow(orderId)
    expect(order.totalMinor).toBe(moneyFromMajor(15_500))
    expect(order.remainingMinor).toBe(moneyFromMajor(15_500))
    expect(order.installationPriceMinor).toBe(moneyFromMajor(1_000))
    expect(order.deliveryPriceMinor).toBe(moneyFromMajor(500))
    expect(order.meterPriceMinor).toBe(moneyFromMajor(250))
  })

  it('approval freezes the commercial values into the snapshot', () => {
    const id = makeInvoice()
    approveFinalInvoice(id, env.ctx)
    const { snapshot } = getFinalInvoice(id)
    expect(snapshot.installationPriceMinor).toBe(moneyFromMajor(1_000))
    expect(snapshot.deliveryPriceMinor).toBe(moneyFromMajor(500))
    expect(snapshot.meterPriceMinor).toBe(moneyFromMajor(250))
    expect(snapshot.totalMinor).toBe(moneyFromMajor(15_500))
    // An approved document renders from that frozen snapshot.
    const html = renderFinalInvoice(buildFinalInvoice(id), { name: 'AURA' })
    expect(html).toContain('سعر التركيب')
    expect(html).toContain('سعر التوصيل')
  })

  it('the بيان / مواصفات PDF separation remains intact', () => {
    const id = makeQuotation({
      lines: [{ ...LINE, specifications: 'أبواب قلاب، مفصلات مخفية' }]
    })
    const html = renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' })
    // Specifications live in their own bordered box, in their own row —
    // never merged into the البيان cell.
    expect(html).toContain('spec-row')
    expect(html).toContain('spec-box')
    expect(html).toMatch(/<div class="spec-label">المواصفات وملاحظات التصنيع<\/div>/)
    const descriptionCell = html.slice(html.indexOf('<td><div>'), html.indexOf('</div></td>'))
    expect(descriptionCell).not.toContain('مفصلات مخفية')
  })

  it('the new fields cause no stock, cash or payment side effects', () => {
    const stockBefore = stockLevels({})
    const cash = (): unknown =>
      getRawConnection().prepare('SELECT COUNT(*) AS c FROM cash_transactions').get()
    const cashBefore = cash()

    const id = makeInvoice()
    approveFinalInvoice(id, env.ctx)

    expect(stockLevels({})).toEqual(stockBefore)
    expect(cash()).toEqual(cashBefore)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM customer_payments').get()).toEqual(
      { c: 0 }
    )
    expect(
      getRawConnection().prepare('SELECT COUNT(*) AS c FROM inventory_movements').get()
    ).toEqual({ c: 0 })
  })

  it('the Approved Invoice line/terms behaviour is untouched', () => {
    const id = makeInvoice()
    const { lines, invoice } = getFinalInvoice(id)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.lineTotalMinor).toBe(moneyFromMajor(14_000))
    expect(invoice.subtotalMinor).toBe(moneyFromMajor(14_000))
  })
})

// --------------------------------------------------------- schema/migration

describe('migration 0019 against an isolated database', () => {
  it('adds the commercial columns to all three tables and visibility to the two documents', () => {
    const cols = (table: string): string[] =>
      (
        getRawConnection().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      ).map((column) => column.name)
    for (const table of ['quotations', 'final_invoices', 'orders']) {
      expect(cols(table)).toEqual(
        expect.arrayContaining([
          'meter_price_minor',
          'installation_price_minor',
          'delivery_price_minor'
        ])
      )
    }
    expect(cols('quotations')).toContain('print_visibility')
    expect(cols('final_invoices')).toContain('print_visibility')
    // Deliberately NOT on orders: an order is not a customer-facing PDF.
    expect(cols('orders')).not.toContain('print_visibility')
  })

  it('the money columns default to zero, so every pre-existing row stays valid', () => {
    const id = createQuotation({ customerId: customer(), lines: [LINE] }, env.ctx).id
    const { quotation } = getQuotation(id)
    expect(quotation.meterPriceMinor).toBe(0)
    expect(quotation.installationPriceMinor).toBe(0)
    expect(quotation.deliveryPriceMinor).toBe(0)
    expect(quotation.printVisibility).toBeNull()
    expect(quotation.totalMinor).toBe(moneyFromMajor(14_000))
  })

  it('the journal stays strictly increasing, so the migrator cannot silently skip it', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
      entries: Array<{ when: number; tag: string }>
    }
    const whens = journal.entries.map((entry) => entry.when)
    expect(whens.every((when, index) => index === 0 || when > whens[index - 1])).toBe(true)
    expect(
      journal.entries.some((entry) => entry.tag === '0019_invoice_charges_print_visibility')
    ).toBe(true)
    expect(journal.entries.some((entry) => entry.tag === '0037_reversible_order_steps')).toBe(true)
  })

  it('money is validated as integer minor units — no floating-point money enters the model', () => {
    const id = makeInvoice()
    const row = getDatabase().select().from(finalInvoices).where(eq(finalInvoices.id, id)).get()
    for (const value of [
      row?.meterPriceMinor,
      row?.installationPriceMinor,
      row?.deliveryPriceMinor
    ]) {
      expect(Number.isInteger(value)).toBe(true)
    }
  })
})
