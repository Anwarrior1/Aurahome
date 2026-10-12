import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_PRINT_VISIBILITY,
  PRINT_VISIBILITY_KEYS,
  parsePrintVisibility,
  sanitizePrintVisibility,
  serializePrintVisibility,
  shouldPrint
} from '@shared/documents/print-visibility'

const read = (path: string): string => readFileSync(path, 'utf8')
const quotationsPage = read('src/renderer/pages/quotations/QuotationsPage.tsx')
const finalInvoicesPage = read('src/renderer/pages/invoices/FinalInvoicesPage.tsx')
const ui = read('src/renderer/components/ui/index.tsx')
const hook = read('src/renderer/components/invoices/usePrintVisibility.ts')
const css = read('src/renderer/styles/global.css')

/**
 * The visibility engine's own logic is pure, so it is tested for real
 * here; the form wiring is pinned as source text, matching every other
 * renderer test in this project (vitest runs in `node`, with no
 * jsdom/React Testing Library configured).
 */
describe('print-visibility engine (real logic)', () => {
  it('shouldPrint answers from the resolved map', () => {
    const visibility = parsePrintVisibility('{"deliveryPrice":false}')
    expect(shouldPrint(visibility, 'deliveryPrice')).toBe(false)
    expect(shouldPrint(visibility, 'installationPrice')).toBe(true)
  })

  it('round-trips a choice through storage', () => {
    const stored = serializePrintVisibility({ deliveryPrice: false, meterPrice: false })
    const parsed = parsePrintVisibility(stored)
    expect(parsed.deliveryPrice).toBe(false)
    expect(parsed.meterPrice).toBe(false)
    expect(parsed.installationPrice).toBe(true)
  })

  it('refuses keys that are not printable fields — internal data can never be toggled on', () => {
    for (const forbidden of ['costPrice', 'id', 'createdAt', 'estimatedMaterialMinor', 'createdBy']) {
      expect(PRINT_VISIBILITY_KEYS).not.toContain(forbidden)
      expect(sanitizePrintVisibility({ [forbidden]: true })).toEqual({})
    }
  })

  it('defaults reproduce the pre-feature printed appearance', () => {
    // What the templates already printed stays on...
    for (const key of ['description', 'quantity', 'unitPrice', 'subtotal', 'discount',
      'specifications', 'dimensions', 'colorCode', 'termsAndConditions'] as const) {
      expect(DEFAULT_PRINT_VISIBILITY[key]).toBe(true)
    }
    // ...and what they never printed stays off.
    expect(DEFAULT_PRINT_VISIBILITY.accessories).toBe(false)
    expect(DEFAULT_PRINT_VISIBILITY.notes).toBe(false)
  })
})

describe('the shared PrintToggle', () => {
  it('is a small checkbox carrying its meaning in title/aria-label, not visible text', () => {
    expect(ui).toContain('export function PrintToggle')
    expect(ui).toContain('title="إظهار في PDF"')
    expect(ui).toContain('aria-label="إظهار في PDF"')
    expect(css).toContain('.print-toggle {')
    expect(css).toMatch(/\.print-toggle \{[^}]*width: 13px/)
  })

  it('Field renders it beside the label, and only then drops the implicit <label> target', () => {
    // A <label> targets its first labelable descendant — with a toggle
    // present that would be the toggle, so those rows render as a div.
    expect(ui).toMatch(/print \? <div className="field">\{body\}<\/div> : <label className="field">\{body\}<\/label>/)
  })
})

describe('both invoice forms carry the same commercial fields (Preliminary + Approved)', () => {
  for (const [name, page] of [
    ['Preliminary Invoice', quotationsPage],
    ['Approved Invoice', finalInvoicesPage]
  ] as const) {
    it(`${name}: has سعر المتر / سعر التركيب / سعر التوصيل inputs`, () => {
      expect(page).toContain('<Field label="سعر المتر"')
      expect(page).toContain('<Field label="سعر التركيب"')
      expect(page).toContain('<Field label="سعر التوصيل"')
    })

    it(`${name}: states which of them affect the total`, () => {
      expect(page).toContain('hint="معلومة تجارية — لا تدخل في الإجمالي"')
      expect(page.match(/hint="يُضاف إلى الإجمالي"/g)).toHaveLength(2)
    })

    it(`${name}: sends all three as integer minor units plus the visibility map`, () => {
      expect(page).toContain('meterPriceMinor: toMinor(form.meterPrice)')
      expect(page).toContain('installationPriceMinor: installationPrice')
      expect(page).toContain('deliveryPriceMinor: deliveryPrice')
      expect(page).toContain('printVisibility: print.payload()')
    })

    it(`${name}: previews the total in the same order the service computes it`, () => {
      // charges added once, before the discount; deposit after it.
      expect(page).toContain('const chargedSubtotal = subtotal + installationPrice + deliveryPrice')
      expect(page).toContain('const total = chargedSubtotal - discount')
      expect(page).toMatch(/Math\.min\(toMinor\(form\.discountValue\), chargedSubtotal\)/)
      // سعر المتر is deliberately not in the arithmetic.
      expect(page).not.toContain('+ meterPrice')
    })

    it(`${name}: restores the saved values and print choices when reopened`, () => {
      expect(page).toContain('print.load(')
      expect(page).toMatch(/meterPrice: detail\.\w+\.meterPriceMinor/)
      expect(page).toMatch(/installationPrice: detail\.\w+\.installationPriceMinor/)
      expect(page).toMatch(/deliveryPrice: detail\.\w+\.deliveryPriceMinor/)
    })

    it(`${name}: has the business include-flags, each as EXACTLY ONE checkbox — no separate print toggle beside it`, () => {
      expect(page).toContain('يشمل تركيباً')
      expect(page).toContain('يشمل توصيلاً')
      // Exactly one checkbox input drives each flag.
      expect(page.match(/checked=\{form\.requiresInstallation\}/g)).toHaveLength(1)
      expect(page.match(/checked=\{form\.requiresDelivery\}/g)).toHaveLength(1)
      // No duplicated PDF-visibility control sits beside either one —
      // the single checkbox's own checked state is what the PDF reads.
      expect(page).not.toContain("print.toggle('includesInstallation')")
      expect(page).not.toContain("print.toggle('includesDelivery')")
      expect(page).not.toContain('<PrintToggle')
    })

    it(`${name}: puts a print toggle on the printable money/detail fields`, () => {
      for (const key of ['meterPrice', 'installationPrice', 'deliveryPrice',
        'subtotal', 'discount', 'depositRequired', 'remainingBalance', 'notes']) {
        expect(page).toContain(`print={print.toggle('${key}')}`)
      }
    })

    it(`${name}: states item-field visibility once, not per row`, () => {
      expect(page).toContain('إظهار بنود الأصناف في PDF')
      for (const key of ['description', 'quantity', 'unitPrice', 'lineTotal',
        'specifications', 'dimensions', 'colorCode', 'accessories']) {
        expect(page).toContain(`...print.toggle('${key}')`)
      }
    })

    it(`${name}: the final amount itself is never hideable — it is what the customer owes`, () => {
      const finalField = page.slice(page.indexOf('hint="يشمل التركيب والتوصيل"') - 200,
        page.indexOf('hint="يشمل التركيب والتوصيل"') + 120)
      expect(finalField).not.toContain('print={print.toggle')
    })
  }
})

describe('the visibility hook is shared, so the two forms cannot drift', () => {
  it('both pages use it', () => {
    const importLine = "from '@renderer/components/invoices/usePrintVisibility'"
    expect(quotationsPage).toContain(importLine)
    expect(finalInvoicesPage).toContain(importLine)
  })

  it('it starts from the shared defaults and reloads a document\'s saved choice', () => {
    expect(hook).toContain('DEFAULT_PRINT_VISIBILITY')
    expect(hook).toContain('parsePrintVisibility(stored)')
  })

  it('a new form starts clean — resetForm clears the print choices too', () => {
    expect(quotationsPage).toContain('print.reset()')
    expect(finalInvoicesPage).toContain('print.reset()')
  })
})
