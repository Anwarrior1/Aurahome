import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCustomer } from '@main/services/parties/parties.service'
import { createQuotation, getQuotation } from '@main/services/sales/quotations.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { updateQuotation } from '@main/services/sales/quotations.service'
import { buildPreliminaryInvoice, buildFinalInvoice } from '@main/services/documents/documents.service'
import {
  renderPreliminaryInvoice,
  renderFinalInvoice
} from '@main/reports/templates/documents.template'
import { formatMoney, money, moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * BUG FIX — the PDF item table's `<thead>` and every row's `<td>`s were
 * static HTML: unchecking "الكمية" already made the DTO's `quantity`
 * string empty, but the template still rendered the "الكمية" header
 * and a (blank) quantity `<td>` for every line — an unchecked column
 * still occupied a column, just with nothing printed inside it.
 *
 * These tests assert the STRUCTURAL absence of a hidden column — no
 * header text, no cell at all — not merely an empty value inside a
 * cell that is still there.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const LINE = {
  lineKind: 'custom' as const,
  description: 'خزانة مطبخ',
  quantityMicro: quantityFromDisplay(2),
  unitPriceMinor: moneyFromMajor(1_000)
}
const customer = (): number => createCustomer({ name: 'عميل تجريبي' }, env.ctx)

/**
 * The stylesheet is inlined into every document's own <style> block
 * (see document-styles.ts), and its source comments are plain prose —
 * one happens to mention "البيان" itself, describing the spec-box's
 * relationship to it. `body()` strips that block so a `.not.toContain`
 * check reflects what actually prints, not incidental text sitting
 * inside a CSS comment (the exact false-positive class this project
 * has hit before with the fulfilment-statement wording).
 */
function body(html: string): string {
  return html.replace(/<style>[\s\S]*?<\/style>/, '')
}

function preliminaryHtml(printVisibility?: Record<string, boolean>): string {
  const id = createQuotation({ customerId: customer(), lines: [LINE], printVisibility }, env.ctx).id
  return body(renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' }))
}
function approvedHtml(printVisibility?: Record<string, boolean>): string {
  const id = createFinalInvoice({ customerId: customer(), lines: [LINE], printVisibility }, env.ctx).id
  approveFinalInvoice(id, env.ctx)
  return body(renderFinalInvoice(buildFinalInvoice(id), { name: 'AURA' }))
}

/** How many `<th>` cells the item table's header row has. */
function headCellCount(html: string): number {
  const theadMatch = html.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/)
  expect(theadMatch).not.toBeNull()
  return (theadMatch?.[1].match(/<th/g) ?? []).length
}
/** How many `<td>` cells the FIRST item row has (excludes the spec-row). */
function firstRowCellCount(html: string): number {
  const tbodyStart = html.indexOf('<tbody>')
  const firstRow = html.slice(tbodyStart, html.indexOf('</tr>', tbodyStart) + 5)
  return (firstRow.match(/<td/g) ?? []).length
}

// ------------------------------------------------- the exact reported bug

describe('CONFIRMED BUG — quantity=false must remove the column entirely (Preliminary Invoice)', () => {
  it('with quantity visible: header present, value present, 5 header cells (# + 4 columns)', () => {
    const html = preliminaryHtml({ quantity: true })
    expect(html).toContain('الكمية')
    expect(headCellCount(html)).toBe(5)
    expect(firstRowCellCount(html)).toBe(5)
    // The formatted quantity value appears somewhere in the row.
    const tbodyStart = html.indexOf('<tbody>')
    const firstRow = html.slice(tbodyStart, html.indexOf('</tr>', tbodyStart))
    expect(firstRow).toMatch(/>2</)
  })

  it('with quantity hidden: no "الكمية" header text anywhere, one fewer header cell, one fewer cell per row, no "2" quantity cell', () => {
    const html = preliminaryHtml({ quantity: false })
    expect(html).not.toContain('الكمية')
    expect(headCellCount(html)).toBe(4) // # + description + unitPrice + lineTotal
    expect(firstRowCellCount(html)).toBe(4)
    // The stored quantity (2) still exists internally (see the
    // "calculations unaffected" describe block below) but must not
    // appear anywhere as a printed quantity cell.
    const tbodyStart = html.indexOf('<tbody>')
    const firstRow = html.slice(tbodyStart, html.indexOf('</tr>', tbodyStart))
    expect(firstRow).not.toMatch(/<td class="num">2<\/td>/)
  })
})

describe('CONFIRMED BUG — same fix on the Approved Invoice', () => {
  it('quantity visible → header + value present', () => {
    const html = approvedHtml({ quantity: true })
    expect(html).toContain('الكمية')
    expect(headCellCount(html)).toBe(5)
  })

  it('quantity hidden → header entirely absent, column count reduced', () => {
    const html = approvedHtml({ quantity: false })
    expect(html).not.toContain('الكمية')
    expect(headCellCount(html)).toBe(4)
    expect(firstRowCellCount(html)).toBe(4)
  })
})

// ------------------------------------------------- every item field, audited

describe('every item-level visibility field is respected (both documents)', () => {
  it('البيان (description): hidden removes its column and text', () => {
    const html = preliminaryHtml({ description: false })
    expect(html).not.toContain('البيان')
    expect(html).not.toContain('خزانة مطبخ')
    expect(headCellCount(html)).toBe(4)
  })

  it('سعر الوحدة (unitPrice): hidden removes its column', () => {
    const html = preliminaryHtml({ unitPrice: false })
    expect(html).not.toContain('سعر الوحدة')
    expect(headCellCount(html)).toBe(4)
  })

  it('إجمالي الصنف (lineTotal): hidden removes its column', () => {
    const html = preliminaryHtml({ lineTotal: false })
    expect(html).not.toContain('>الإجمالي<')
    expect(headCellCount(html)).toBe(4)
  })

  it('المواصفات (specifications), كود اللون/التشطيب, الإكسسوارات: hidden individually removes only that detail from the spec box', () => {
    const id = createQuotation(
      {
        customerId: customer(),
        lines: [{
          ...LINE,
          specifications: 'أبواب قلاب',
          colorCode: 'DEMO-G',
          accessories: 'مقبض ذهبي'
        }],
        // accessories defaults to false (pre-existing, unrelated to this
        // bug) — enabled explicitly so this test isolates colorCode.
        printVisibility: { colorCode: false, accessories: true }
      },
      env.ctx
    ).id
    const html = body(renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' }))
    expect(html).toContain('أبواب قلاب')
    expect(html).toContain('مقبض ذهبي')
    expect(html).not.toContain('كود اللون/التشطيب')
    expect(html).not.toContain('DEMO-G')
  })

  it('سعر المتر, هاتف العميل, عنوان العميل: hidden individually never print', () => {
    const id = createQuotation(
      {
        customerId: createCustomer({ name: 'عميل', phone: '0912345678', address: 'طرابلس' }, env.ctx),
        lines: [LINE],
        meterPriceMinor: moneyFromMajor(50),
        printVisibility: { meterPrice: false, customerPhone: false, customerAddress: false }
      },
      env.ctx
    ).id
    const html = body(renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' }))
    expect(html).not.toContain('سعر المتر')
    expect(html).not.toContain('0912345678')
    expect(html).not.toContain('طرابلس')
  })

  it('سعر التركيب, سعر التوصيل: hidden individually never print', () => {
    const id = createQuotation(
      {
        customerId: customer(),
        lines: [LINE],
        installationPriceMinor: moneyFromMajor(90),
        deliveryPriceMinor: moneyFromMajor(40),
        printVisibility: { installationPrice: false, deliveryPrice: false }
      },
      env.ctx
    ).id
    const html = body(renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' }))
    expect(html).not.toContain('سعر التركيب')
    expect(html).not.toContain('سعر التوصيل')
  })
})

// ------------------------------------------------- combinations A-F

describe('visibility combinations produce a correctly-shaped table (both documents)', () => {
  it('CASE A — description only', () => {
    const html = preliminaryHtml({ description: true, quantity: false, unitPrice: false, lineTotal: false })
    expect(headCellCount(html)).toBe(2) // # + description
    expect(html).toContain('البيان')
    expect(html).not.toContain('الكمية')
    expect(html).not.toContain('سعر الوحدة')
  })

  it('CASE B — description + quantity', () => {
    const html = preliminaryHtml({ description: true, quantity: true, unitPrice: false, lineTotal: false })
    expect(headCellCount(html)).toBe(3)
    expect(html).toContain('البيان')
    expect(html).toContain('الكمية')
    expect(html).not.toContain('سعر الوحدة')
  })

  it('CASE C — description + unit price + total', () => {
    const html = preliminaryHtml({ description: true, quantity: false, unitPrice: true, lineTotal: true })
    expect(headCellCount(html)).toBe(4)
    expect(html).not.toContain('الكمية')
    expect(html).toContain('سعر الوحدة')
    expect(html).toContain('>الإجمالي<')
  })

  it('CASE D — quantity hidden, unit price visible', () => {
    const html = preliminaryHtml({ quantity: false, unitPrice: true })
    expect(html).not.toContain('الكمية')
    expect(html).toContain('سعر الوحدة')
  })

  it('CASE E — unit price hidden, quantity visible', () => {
    const html = preliminaryHtml({ quantity: true, unitPrice: false })
    expect(html).toContain('الكمية')
    expect(html).not.toContain('سعر الوحدة')
  })

  it('CASE F — several optional columns hidden at once', () => {
    const html = preliminaryHtml({ quantity: false, unitPrice: false, lineTotal: false })
    expect(headCellCount(html)).toBe(2) // # + description only
    expect(firstRowCellCount(html)).toBe(2)
    expect(html).toContain('البيان')
    expect(html).not.toContain('الكمية')
    expect(html).not.toContain('سعر الوحدة')
    expect(html).not.toContain('>الإجمالي<')
  })

  it('all four item columns hidden: table still renders validly with just the # column', () => {
    const html = preliminaryHtml({ description: false, quantity: false, unitPrice: false, lineTotal: false })
    expect(headCellCount(html)).toBe(1)
    expect(firstRowCellCount(html)).toBe(1)
  })

  it('the same combination behaves identically on the Approved Invoice', () => {
    const html = approvedHtml({ quantity: false, unitPrice: false, lineTotal: false })
    expect(headCellCount(html)).toBe(2)
    expect(html).toContain('البيان')
    expect(html).not.toContain('الكمية')
  })
})

// ------------------------------------------------- specRow colspan adjusts

describe('the specifications box spans exactly the visible columns, never more or fewer', () => {
  it('colspan matches the number of visible item columns after quantity is hidden', () => {
    const id = createQuotation(
      {
        customerId: customer(),
        lines: [{ ...LINE, specifications: 'ملاحظة تصنيع' }],
        printVisibility: { quantity: false }
      },
      env.ctx
    ).id
    const html = body(renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' }))
    // 3 visible columns remain: description, unitPrice, lineTotal.
    expect(html).toMatch(/<tr class="spec-row"><td><\/td><td colspan="3">/)
  })

  it('colspan is clamped to at least 1 even if every column is hidden', () => {
    const id = createQuotation(
      {
        customerId: customer(),
        lines: [{ ...LINE, specifications: 'ملاحظة' }],
        printVisibility: { description: false, quantity: false, unitPrice: false, lineTotal: false }
      },
      env.ctx
    ).id
    const html = body(renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' }))
    expect(html).toMatch(/<tr class="spec-row"><td><\/td><td colspan="1">/)
  })
})

// ------------------------------------------------- ?? vs || audit

describe('explicit false always wins — no `visibility.x || default` bug', () => {
  it('an explicitly-false stored key is never treated as unset (would flip back to the true default)', () => {
    const id = createQuotation({ customerId: customer(), lines: [LINE], printVisibility: { quantity: false } }, env.ctx).id
    const { quotation } = getQuotation(id)
    const dto = buildPreliminaryInvoice(id)
    // Confirms the resolution used {...DEFAULT, ...saved} (or an
    // equivalent explicit-false-respecting merge) and not `saved || default`,
    // which would have treated stored `false` as falsy-and-thus-"unset".
    expect(quotation.printVisibility).toContain('"quantity":false')
    expect(dto.itemColumns.quantity).toBe(false)
    expect(dto.lines[0]?.quantity).toBe('')
  })

  it('an unset key still resolves to the true default on the same document', () => {
    const id = createQuotation({ customerId: customer(), lines: [LINE], printVisibility: { quantity: false } }, env.ctx).id
    const dto = buildPreliminaryInvoice(id)
    expect(dto.itemColumns.unitPrice).toBe(true) // untouched key keeps its default
  })
})

// ------------------------------------------------- persistence: saved state is authoritative

describe('the PDF uses the SAVED visibility state, not defaults or unsaved UI state', () => {
  it('uncheck quantity, save, reopen, generate PDF — quantity stays hidden', () => {
    const id = createQuotation({ customerId: customer(), lines: [LINE] }, env.ctx).id
    // Initially default (visible).
    expect(renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' })).toContain('الكمية')

    // "Uncheck" and save — mirrors the exact reported repro steps.
    updateQuotation(id, { printVisibility: { quantity: false } }, env.ctx)

    // Reopen (a fresh read from the database) and regenerate.
    const html = body(renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' }))
    expect(html).not.toContain('الكمية')
    expect(headCellCount(html)).toBe(4)

    // Re-enable and regenerate — the column returns.
    updateQuotation(id, { printVisibility: { quantity: true } }, env.ctx)
    const restored = renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' })
    expect(restored).toContain('الكمية')
    expect(headCellCount(restored)).toBe(5)
  })

  it('legacy documents (no stored configuration) still show every column, exactly as before this feature', () => {
    const html = preliminaryHtml(undefined)
    expect(headCellCount(html)).toBe(5)
    expect(html).toContain('البيان')
    expect(html).toContain('الكمية')
    expect(html).toContain('سعر الوحدة')
    expect(html).toContain('>الإجمالي<')
  })
})

// ------------------------------------------------- calculations unaffected

describe('hiding a column never changes a stored value or a calculation', () => {
  it('quantity, installation and delivery stay fully in the stored figures and totals when hidden from the PDF', () => {
    const id = createQuotation(
      {
        customerId: customer(),
        lines: [LINE], // qty 2 × 1,000 = 2,000
        installationPriceMinor: moneyFromMajor(90),
        deliveryPriceMinor: moneyFromMajor(40),
        printVisibility: { quantity: false, installationPrice: false, deliveryPrice: false }
      },
      env.ctx
    ).id
    const { quotation } = getQuotation(id)
    expect(quotation.totalMinor).toBe(moneyFromMajor(2_130)) // 2,000 + 90 + 40
    expect(quotation.installationPriceMinor).toBe(moneyFromMajor(90))
    expect(quotation.deliveryPriceMinor).toBe(moneyFromMajor(40))

    const dto = buildPreliminaryInvoice(id)
    expect(dto.installationPrice).toBeUndefined()
    expect(dto.deliveryPrice).toBeUndefined()
    expect(dto.itemColumns.quantity).toBe(false)
    // The printed final amount is still the real, full total.
    expect(dto.totalAfterDiscount).toBe(formatMoney(money(moneyFromMajor(2_130))))
  })
})
