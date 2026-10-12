import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCustomer } from '@main/services/parties/parties.service'
import { createQuotation, getQuotation } from '@main/services/sales/quotations.service'
import {
  createFinalInvoice,
  getFinalInvoice,
  approveFinalInvoice
} from '@main/services/sales/final-invoices.service'
import { buildPreliminaryInvoice, buildFinalInvoice } from '@main/services/documents/documents.service'
import {
  renderPreliminaryInvoice,
  renderFinalInvoice
} from '@main/reports/templates/documents.template'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * The seven documented PDF combinations (CASE A–G), rendered from real
 * documents through the real templates.
 *
 * Each case is asserted here AND written to `.tmp/pdf-cases/` as
 * standalone HTML, from which the visual check converts real PDFs with
 * headless Chromium — the same engine Electron's `printToPDF` uses. The
 * asset URLs are rewritten to local paths so the bundled Cairo fonts
 * and the logo actually load, making the output true to what the app
 * produces.
 *
 * The invariant every case shares: whatever is hidden, the printed
 * final amount is always the document's own stored total.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const OUT = resolve('.tmp/pdf-cases')
const ASSETS = resolve('resources/assets')

const LINES = [
  {
    lineKind: 'custom' as const,
    description: 'خزانة مطبخ بأبواب قلاب',
    specifications: 'مفصلات مخفية بزاوية 180°، تشطيب مطفي، رفوف قابلة للتعديل',
    dimensions: '240 × 60 × 90 سم',
    colorCode: 'DEMO-G',
    accessories: 'مقبض ذهبي',
    quantityMicro: quantityFromDisplay(1),
    unitPriceMinor: moneyFromMajor(14_000)
  },
  {
    lineKind: 'custom' as const,
    description: 'وحدة تخزين جانبية',
    specifications: 'خشب زان طبيعي',
    dimensions: '80 × 40 × 200 سم',
    quantityMicro: quantityFromDisplay(2),
    unitPriceMinor: moneyFromMajor(1_500)
  }
]

const customer = (): number =>
  createCustomer(
    { name: 'مؤسسة النخبة للتجارة', phone: '0912345678', address: 'طرابلس — شارع الجمهورية' },
    env.ctx
  )

/** Renders standalone HTML whose asset URLs resolve on this machine. */
function standalone(html: string): string {
  return html
    .replace('app://assets/fonts/fonts.css', `file://${ASSETS}/fonts/fonts.css`)
    .replace('app://assets/brand/logo-full.jpeg', `file://${ASSETS}/brand/logo-full.jpeg`)
    .replace('app://assets/references/qr.jpeg', `file://${resolve('references/qr.jpeg')}`)
}

function writeCase(name: string, html: string): void {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(resolve(OUT, `${name}.html`), standalone(html), 'utf8')
}

interface CaseSpec {
  name: string
  requiresInstallation?: boolean
  requiresDelivery?: boolean
  printVisibility?: Record<string, boolean>
}

/** 14,000 + 2×1,500 = 17,000 goods, +1,000 install, +500 delivery = 18,500. */
const CHARGES = {
  meterPriceMinor: moneyFromMajor(250),
  installationPriceMinor: moneyFromMajor(1_000),
  deliveryPriceMinor: moneyFromMajor(500)
}
const EXPECTED_TOTAL = moneyFromMajor(18_500)

const CASES: CaseSpec[] = [
  { name: 'A-installation-and-delivery-visible' },
  { name: 'B-installation-hidden-delivery-visible', printVisibility: { installationPrice: false } },
  { name: 'C-installation-visible-delivery-hidden', printVisibility: { deliveryPrice: false } },
  {
    name: 'D-both-price-rows-hidden',
    printVisibility: { installationPrice: false, deliveryPrice: false, meterPrice: false }
  },
  { name: 'E-includes-installation-only', requiresInstallation: true, requiresDelivery: false },
  { name: 'F-includes-delivery-only', requiresInstallation: false, requiresDelivery: true },
  { name: 'G-includes-both', requiresInstallation: true, requiresDelivery: true }
]

describe('PDF cases A–G — Preliminary Invoice', () => {
  for (const spec of CASES) {
    it(`CASE ${spec.name}`, () => {
      const id = createQuotation(
        {
          customerId: customer(),
          lines: LINES,
          ...CHARGES,
          requiresInstallation: spec.requiresInstallation ?? false,
          requiresDelivery: spec.requiresDelivery ?? false,
          printVisibility: spec.printVisibility,
          notes: 'يرجى تأكيد الأبعاد النهائية قبل بدء التصنيع.'
        },
        env.ctx
      ).id
      const dto = buildPreliminaryInvoice(id)
      const html = renderPreliminaryInvoice(dto, {
        name: 'AURA home',
        phone: '0910000000',
        address: 'طرابلس — ليبيا'
      })
      writeCase(`preliminary-${spec.name}`, html)

      // The stored total never depends on what is shown.
      expect(getQuotation(id).quotation.totalMinor).toBe(EXPECTED_TOTAL)

      const pv = spec.printVisibility ?? {}
      expect(html.includes('سعر التركيب')).toBe(pv.installationPrice !== false)
      expect(html.includes('سعر التوصيل')).toBe(pv.deliveryPrice !== false)
      expect(html.includes('سعر المتر')).toBe(pv.meterPrice !== false)
      expect(html.includes('يشمل التركيب')).toBe(Boolean(spec.requiresInstallation))
      expect(html.includes('يشمل التوصيل')).toBe(Boolean(spec.requiresDelivery))
      // The specifications box survives in every case.
      expect(html).toContain('spec-box')
      // No empty row is left where a hidden one used to be.
      expect(html).not.toMatch(/<tr><td>[^<]*<\/td><td class="num"><\/td><\/tr>/)
    })
  }
})

describe('PDF cases A–G — Approved Invoice', () => {
  for (const spec of CASES) {
    it(`CASE ${spec.name}`, () => {
      const id = createFinalInvoice(
        {
          customerId: customer(),
          lines: LINES,
          ...CHARGES,
          requiresInstallation: spec.requiresInstallation ?? false,
          requiresDelivery: spec.requiresDelivery ?? false,
          printVisibility: spec.printVisibility,
          notes: 'تم الاتفاق على التسليم خلال 30 يوماً.'
        },
        env.ctx
      ).id
      // Approve it, so the case renders from the FROZEN snapshot —
      // the path a real customer PDF takes.
      approveFinalInvoice(id, env.ctx)
      const html = renderFinalInvoice(buildFinalInvoice(id), {
        name: 'AURA home',
        phone: '0910000000',
        address: 'طرابلس — ليبيا'
      })
      writeCase(`approved-${spec.name}`, html)

      expect(getFinalInvoice(id).invoice.totalMinor).toBe(EXPECTED_TOTAL)
      const pv = spec.printVisibility ?? {}
      expect(html.includes('سعر التركيب')).toBe(pv.installationPrice !== false)
      expect(html.includes('سعر التوصيل')).toBe(pv.deliveryPrice !== false)
      expect(html.includes('يشمل التركيب')).toBe(Boolean(spec.requiresInstallation))
      expect(html.includes('يشمل التوصيل')).toBe(Boolean(spec.requiresDelivery))
      expect(html).toContain('spec-box')
    })
  }
})

describe('CASE D — the hidden-rows invariant, stated explicitly', () => {
  it('both charge rows hidden, yet the printed final amount is still the real total', () => {
    const id = createQuotation(
      {
        customerId: customer(),
        lines: LINES,
        ...CHARGES,
        printVisibility: { installationPrice: false, deliveryPrice: false }
      },
      env.ctx
    ).id
    const dto = buildPreliminaryInvoice(id)
    const { quotation } = getQuotation(id)

    expect(dto.installationPrice).toBeUndefined()
    expect(dto.deliveryPrice).toBeUndefined()
    // 17,000 goods on the page, 18,500 payable — the charges are inside
    // the total even though their rows are not printed.
    expect(quotation.subtotalMinor).toBe(moneyFromMajor(17_000))
    expect(quotation.totalMinor).toBe(EXPECTED_TOTAL)
    expect(quotation.installationPriceMinor).toBe(moneyFromMajor(1_000))
    expect(quotation.deliveryPriceMinor).toBe(moneyFromMajor(500))
    // There is exactly one total — no separate "PDF total" exists.
    expect(dto.totalAfterDiscount).not.toBe(dto.subtotal)
  })
})
