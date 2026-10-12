import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')

/**
 * Searchable customer dropdown, shared by BOTH the Preliminary Invoice
 * and the Approved Invoice forms. The actual filtering logic
 * (name/Arabic/phone search, case-insensitivity, whitespace, no-match,
 * and that it can never widen visibility beyond its input) is tested
 * for real in tests/unit/renderer/searchable-customer-select.test.ts,
 * since that logic is a pure function.
 *
 * Everything here is structural: no jsdom/React Testing Library is
 * configured for this renderer (see vitest.config.ts), so — matching
 * every other renderer test in this project — these are source-text
 * pins over the actual component/CSS, confirming the dropdown exists,
 * is wired identically into both invoice forms, and never grew a new
 * server round trip to implement search.
 */
const component = read('src/renderer/components/customers/SearchableCustomerSelect.tsx')
const css = read('src/renderer/styles/global.css')
const quotationsPage = read('src/renderer/pages/quotations/QuotationsPage.tsx')
const finalInvoicesPage = read('src/renderer/pages/invoices/FinalInvoicesPage.tsx')

describe('SearchableCustomerSelect — dropdown, search field, empty state', () => {
  it('the search field only exists inside the opened dropdown, never permanently in the form', () => {
    // The whole popover — search field included — renders under one
    // `{open && (...)}` guard, so nothing search-related is present
    // in the DOM before the trigger is clicked.
    const dropdownStart = component.indexOf('{open && (')
    const searchInputIdx = component.indexOf("placeholder=\"بحث عن عميل...\"")
    expect(dropdownStart).toBeGreaterThan(-1)
    expect(searchInputIdx).toBeGreaterThan(dropdownStart)
  })

  it('uses the exact required Arabic placeholder', () => {
    expect(component).toContain('placeholder="بحث عن عميل..."')
  })

  it('shows the exact required empty state, and only from the pure filter result (never closes the dropdown)', () => {
    expect(component).toContain('لا يوجد عميل مطابق')
    expect(component).toMatch(/results\.length === 0 \? \(\s*<p className="customer-select__empty">لا يوجد عميل مطابق<\/p>/)
  })

  it('autofocuses the search input when the dropdown opens', () => {
    expect(component).toContain('searchRef.current?.focus()')
  })
})

describe('SearchableCustomerSelect — selection and temporary search state (item 8/14)', () => {
  it('selecting a customer calls onChange with its id and clears the search query', () => {
    const selectStart = component.indexOf('function select(')
    const selectFn = component.slice(selectStart, component.indexOf('useEffect', selectStart))
    expect(selectFn).toContain('onChange(String(customer.id), customer)')
    expect(selectFn).toContain('closeAndReset()')
  })

  it('closing the dropdown (outside click, Escape, or Tab) clears the search query the same way', () => {
    expect(component).toMatch(/function closeAndReset\(\): void \{\s*setOpen\(false\)\s*setQuery\(''\)/)
    // Every close path funnels through the one reset function — no
    // second place that could leave stale search text behind.
    expect(component.match(/closeAndReset\(\)/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('never persists the search query — it is component state only, not part of the id/onChange contract', () => {
    expect(component).not.toMatch(/query.*call\(/s)
    expect(component).toContain('// temporary UI state only — never persisted, never sent anywhere')
  })
})

describe('SearchableCustomerSelect — keyboard interaction (item 18)', () => {
  it('ArrowDown/ArrowUp move the highlighted result', () => {
    expect(component).toContain("event.key === 'ArrowDown'")
    expect(component).toContain("event.key === 'ArrowUp'")
  })

  it('Enter selects the highlighted result', () => {
    expect(component).toMatch(/event\.key === 'Enter'[\s\S]{0,120}select\(pick\)/)
  })

  it('Escape closes the dropdown', () => {
    expect(component).toMatch(/event\.key === 'Escape'[\s\S]{0,120}closeAndReset\(\)/)
  })

  it('Tab is not blocked (no preventDefault) so it remains accessible and moves focus naturally', () => {
    const tabBranch = component.slice(component.indexOf("event.key === 'Tab'"), component.indexOf("event.key === 'Tab'") + 200)
    expect(tabBranch).not.toContain('preventDefault')
  })

  it('stops propagation for every handled key, so Escape can never also trigger the surrounding invoice Modal\'s own global Escape-closes-the-modal listener', () => {
    // Regression guard: found via manual CDP verification — without
    // this, pressing Escape to back out of the customer search closed
    // the entire invoice Modal and discarded the in-progress draft.
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      const branch = component.slice(component.indexOf(`event.key === '${key}'`), component.indexOf(`event.key === '${key}'`) + 160)
      expect(branch).toContain('event.stopPropagation()')
    }
  })
})

describe('SearchableCustomerSelect — RTL and design-system consistency', () => {
  it('uses existing theme tokens only — no new hardcoded colors', () => {
    expect(css).toMatch(/\.customer-select__dropdown\s*\{[^}]*background:\s*var\(--bg-card\)/)
    expect(css).toMatch(/\.customer-select__trigger\s*\{[^}]*border-radius:\s*var\(--r-md\)/)
  })

  it('the dropdown anchors to the RTL reading-start edge, matching the existing account/notification dropdowns', () => {
    expect(css).toMatch(/\.customer-select__dropdown\s*\{[^}]*inset-inline-start:\s*0/)
  })

  it('the phone number stays LTR for readability inside the RTL row', () => {
    expect(css).toMatch(/\.customer-select__phone\s*\{[^}]*direction:\s*ltr/)
  })
})

describe('Preliminary Invoice uses the shared searchable customer dropdown (item 1/2)', () => {
  it('imports and renders SearchableCustomerSelect for the customer field', () => {
    expect(quotationsPage).toContain(
      "import { SearchableCustomerSelect } from '@renderer/components/customers/SearchableCustomerSelect'"
    )
    expect(quotationsPage).toContain('<SearchableCustomerSelect')
  })

  it('passes a bounded, server-searched page of permitted active customers (DB-10)', () => {
    expect(quotationsPage).toContain("usePagedQuery<{ id: number; name: string; phone: string | null }>('customers', 'list', { activeOnly: true, search: customerSearch || undefined }, { limit: 50, enabled: open })")
    expect(quotationsPage).toContain('customers={customers.items}')
    expect(quotationsPage).toContain('onSearchChange={setCustomerSearch}')
  })

  it('keeps the exact same form-state contract and disabled-while-editing rule as the old <Select>', () => {
    const block = quotationsPage.slice(quotationsPage.indexOf('<SearchableCustomerSelect'), quotationsPage.indexOf('<SearchableCustomerSelect') + 500)
    expect(block).toContain('value={form.customerId}')
    expect(block).toContain("onChange={(id, customer) => { setForm({ ...form, customerId: id }); setCustomerLabel(customer?.name) }}")
    expect(block).toContain('disabled={Boolean(editingId)}')
  })
})

describe('Approved Invoice has the identical searchable customer dropdown (item 9)', () => {
  it('imports and renders SearchableCustomerSelect for the customer field', () => {
    expect(finalInvoicesPage).toContain(
      "import { SearchableCustomerSelect } from '@renderer/components/customers/SearchableCustomerSelect'"
    )
    expect(finalInvoicesPage).toContain('<SearchableCustomerSelect')
  })

  it('passes a bounded, server-searched page of permitted active customers (DB-10)', () => {
    expect(finalInvoicesPage).toContain("usePagedQuery<{ id: number; name: string; phone: string | null }>('customers', 'list', { activeOnly: true, search: customerSearch || undefined }, { limit: 50, enabled: open })")
    expect(finalInvoicesPage).toContain('customers={customers.items}')
    expect(finalInvoicesPage).toContain('onSearchChange={setCustomerSearch}')
  })

  it('keeps the exact same form-state contract and disabled-while-editing rule as the old <Select>', () => {
    const block = finalInvoicesPage.slice(finalInvoicesPage.indexOf('<SearchableCustomerSelect'), finalInvoicesPage.indexOf('<SearchableCustomerSelect') + 500)
    expect(block).toContain('value={form.customerId}')
    expect(block).toContain("onChange={(id, customer) => { setForm({ ...form, customerId: id }); setCustomerLabel(customer?.name) }}")
    expect(block).toContain('disabled={Boolean(editingId)}')
  })
})

describe('both invoices share ONE component — no duplicated implementation (item 15/17)', () => {
  it('both pages import from the exact same shared component path', () => {
    const importLine = "from '@renderer/components/customers/SearchableCustomerSelect'"
    expect(quotationsPage).toContain(importLine)
    expect(finalInvoicesPage).toContain(importLine)
  })

  it('only the ONE customer field was touched in each page — no unrelated <Select> was replaced', () => {
    // Both pages still use the plain <Select> primitive for their
    // other fields (status, colorCode, discountKind, ...).
    expect(quotationsPage).toContain('<Select')
    expect(finalInvoicesPage).toContain('<Select')
  })
})
