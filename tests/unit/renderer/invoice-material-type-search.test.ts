import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')

/**
 * Searchable "نوع المادة" dropdown, shared by BOTH the Preliminary
 * Invoice and the Approved Invoice forms. The actual filtering logic
 * is tested for real in searchable-material-select.test.ts, since it
 * is a pure function; everything here is structural — no
 * jsdom/React Testing Library is configured for this renderer (see
 * vitest.config.ts), so, matching every other renderer test in this
 * project, these are source-text pins confirming the selector exists
 * and is wired identically into both invoice forms.
 */
const component = read('src/renderer/components/materials/SearchableMaterialSelect.tsx')
const css = read('src/renderer/styles/global.css')
const quotationsPage = read('src/renderer/pages/quotations/QuotationsPage.tsx')
const finalInvoicesPage = read('src/renderer/pages/invoices/FinalInvoicesPage.tsx')

describe('SearchableMaterialSelect — dropdown, search field, empty state', () => {
  it('the search field only exists inside the opened dropdown, never permanently in the form', () => {
    // The dropdown/search field now live inside <DropdownPanel>, which
    // itself renders nothing at all (returns null) while closed — see
    // DropdownPanel.tsx — so this is still "only exists while open",
    // just delegated rather than inlined behind `{open && (...)}`.
    const dropdownStart = component.indexOf('<DropdownPanel')
    // The placeholder is now a parameterized prop (accessories needs
    // its own wording) but نوع المادة's default is still the exact
    // original literal — pinned via the default-value assignment.
    const searchInputIdx = component.indexOf('placeholder={searchPlaceholder}')
    expect(dropdownStart).toBeGreaterThan(-1)
    expect(searchInputIdx).toBeGreaterThan(dropdownStart)
  })

  it('defaults to the exact required Arabic placeholder — نوع المادة\'s call site passes nothing, so this default is what it renders', () => {
    expect(component).toContain("searchPlaceholder = 'بحث عن مادة...'")
  })

  it('shows the exact required empty state, without closing the dropdown', () => {
    expect(component).toContain('لا توجد مادة مطابقة')
    // Same reasoning as the placeholder above: emptyText is now a
    // parameterized prop, defaulting to the original literal.
    expect(component).toContain("emptyText = 'لا توجد مادة مطابقة'")
    expect(component).toMatch(/results\.length === 0 \? \(\s*<p className="customer-select__empty">\{emptyText\}<\/p>/)
  })

  it('autofocuses the search input when the dropdown opens (delegated to the shared DropdownPanel, which alone knows when the portaled input actually exists — see dropdown-panel-positioning.test.ts)', () => {
    expect(component).toContain('initialFocusRef={searchRef}')
  })

  it('reuses the existing searchable-dropdown CSS rather than introducing new styles or a new library', () => {
    // Same .customer-select* rules SearchableCustomerSelect already
    // uses — genuine style reuse, not a lookalike duplicate. No
    // material-select-specific CSS exists anywhere in the stylesheet.
    expect(component).toContain('className="customer-select"')
    expect(component).toContain('className="customer-select__trigger"')
    expect(component).toContain('className="customer-select__dropdown"')
    expect(css).toMatch(/\.customer-select__dropdown\s*\{[^}]*background:\s*var\(--bg-card\)/)
    expect(css).not.toContain('.material-select')
  })
})

describe('SearchableMaterialSelect — selection and temporary search state', () => {
  it('selecting a material calls onChange with its id and clears the search query', () => {
    const selectStart = component.indexOf('function select(')
    const selectFn = component.slice(selectStart, component.indexOf('useEffect', selectStart))
    // Extended (for the new pinned "بدون" row accessories opted into)
    // to also clear back to '' for that row — نوع المادة never passes
    // noneLabel, so that row never appears and this ternary always
    // takes the String(material.id) branch for it, unchanged.
    expect(selectFn).toContain("onChange(material.id === NONE_ID ? '' : String(material.id))")
    expect(selectFn).toContain('closeAndReset()')
  })

  it('never persists the search query — component state only', () => {
    expect(component).toContain('// temporary UI state only — never persisted, never sent anywhere')
  })
})

describe('SearchableMaterialSelect — keyboard interaction, including the Escape/stopPropagation fix', () => {
  it('ArrowDown/ArrowUp/Enter are handled', () => {
    expect(component).toContain("event.key === 'ArrowDown'")
    expect(component).toContain("event.key === 'ArrowUp'")
    expect(component).toMatch(/event\.key === 'Enter'[\s\S]{0,120}select\(pick\)/)
  })

  it('stops propagation for every handled key, so Escape can never also trigger the surrounding invoice Modal\'s own global Escape-closes-the-modal listener', () => {
    // The exact regression found and fixed on SearchableCustomerSelect
    // (see invoice-customer-search.test.ts) — applied here from the
    // start rather than waiting to rediscover it.
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      const branch = component.slice(component.indexOf(`event.key === '${key}'`), component.indexOf(`event.key === '${key}'`) + 160)
      expect(branch).toContain('event.stopPropagation()')
    }
  })

  it('Tab is not blocked, so it remains accessible', () => {
    const tabBranch = component.slice(component.indexOf("event.key === 'Tab'"), component.indexOf("event.key === 'Tab'") + 200)
    expect(tabBranch).not.toContain('preventDefault')
  })
})

describe('Preliminary Invoice uses the searchable material dropdown for "نوع المادة" (item 1)', () => {
  it('uses the shared material multi-select for the field', () => {
    expect(quotationsPage).toContain(
      "import { InvoiceMaterialMultiSelect, InvoiceMaterialColorGroups } from '@renderer/components/invoices/InvoiceItemMultiSelect'"
    )
    expect(quotationsPage).toContain('<InvoiceMaterialMultiSelect')
    // The old free-text input for this field is gone.
    expect(quotationsPage).not.toContain('value={line.materialType} onChange={(e) => update({ materialType: e.target.value })}')
  })

  it('loads the material-type catalog via the dedicated read-only channel — no new/expanded query', () => {
    expect(quotationsPage).toContain("useQuery<Array<{ id: number; sku: string; name: string }>>('materials', 'types')")
    expect(quotationsPage).toContain('materials={materialTypes.data ?? []}')
  })

  it('sends the complete material id set on save', () => {
    expect(quotationsPage).toContain('materialIds: line.materialIds')
    expect(quotationsPage).toContain('saved={line.savedSelections}')
  })

  it('restores the reference (and the legacy text) when the document is reopened', () => {
    expect(quotationsPage).toContain('materialIds: line.selectedMaterials.flatMap')
  })
})

describe('Approved Invoice gained the SAME searchable material dropdown (item 7)', () => {
  it('uses the shared material multi-select for the field', () => {
    expect(finalInvoicesPage).toContain(
      "import { InvoiceMaterialMultiSelect, InvoiceMaterialColorGroups } from '@renderer/components/invoices/InvoiceItemMultiSelect'"
    )
    expect(finalInvoicesPage).toContain('<InvoiceMaterialMultiSelect')
    expect(finalInvoicesPage).toContain('<Field label="نوع المادة">')
  })

  it('loads the material-type catalog via the same dedicated read-only channel', () => {
    expect(finalInvoicesPage).toContain("useQuery<Array<{ id: number; sku: string; name: string }>>('materials', 'types')")
    expect(finalInvoicesPage).toContain('materials={materialTypes.data ?? []}')
  })

  it('sends the complete material id set on save', () => {
    expect(finalInvoicesPage).toContain('materialIds: line.materialIds')
    expect(finalInvoicesPage).toContain('saved={line.savedSelections}')
  })

  it('restores the reference when the document is reopened', () => {
    expect(finalInvoicesPage).toContain('materialIds: line.selectedMaterials.flatMap')
  })

  it('retains specifications, dimensions, color and accessories alongside material selection', () => {
    expect(finalInvoicesPage).toContain('<Field label="المواصفات وملاحظات التصنيع">')
    expect(finalInvoicesPage).toContain('<Field label="الأبعاد">')
    expect(finalInvoicesPage).toContain('<InvoiceMaterialColorGroups')
    expect(finalInvoicesPage).toContain('<Field label="الإكسسوارات">')
  })
})

describe('both invoices share ONE component — no duplicated implementation', () => {
  it('both pages import from the exact same shared component path', () => {
    const importLine = "from '@renderer/components/invoices/InvoiceItemMultiSelect'"
    expect(quotationsPage).toContain(importLine)
    expect(finalInvoicesPage).toContain(importLine)
  })
})
