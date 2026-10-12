import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')
const wrapper = read('src/renderer/components/invoices/InvoiceItemMultiSelect.tsx')
const pages = [
  ['Preliminary', read('src/renderer/pages/quotations/QuotationsPage.tsx')],
  ['Approved', read('src/renderer/pages/invoices/FinalInvoicesPage.tsx')]
] as const

describe.each(pages)('%s invoice catalog selections', (_name, page) => {
  it('uses shared multi-select adapters for colors and accessories', () => {
    expect(page).toContain("from '@renderer/components/invoices/InvoiceItemMultiSelect'")
    expect(page).toContain('<InvoiceMaterialColorGroups')
    expect(page).toContain('<InvoiceMaterialMultiSelect')
    expect(page).not.toMatch(/<Select value=\{line\.colorCode\}/)
  })

  it('keeps each item selection set and historical wording in its own row state', () => {
    expect(page).toContain('groups={line.materialColors} saved={line.savedSelections}')
    expect(page).toContain('onColorsChange={(groups) => update({ materialColors: groups')
    expect(page).toContain('ids={line.accessoryIds} saved={line.savedSelections.selectedAccessories}')
    expect(page).toContain('onChange={(ids) => update({ accessoryIds: ids })}')
    expect(page).toContain('discardLegacyColors={line.discardLegacyColors}')
    expect(page).toContain('discardLegacy={line.discardLegacyAccessories}')
  })

  it('continues using the authoritative active color and accessories channels', () => {
    expect(page).toContain("('colors', 'list', { activeOnly: true })")
    expect(page).toContain("('materials', 'accessories')")
    expect(page).toContain('materials={accessories.data ?? []}')
    expect(page).toContain('searchPlaceholder="بحث عن إكسسوار..."')
  })

  it('saves ids and restores complete selection sets without changing the specifications field', () => {
    expect(page).toContain('materialColors: line.materialColors, retainedUnmappedColorIds: line.retainedUnmappedColorIds')
    expect(page).toContain('sourceLineId: line.id')
    expect(page).toContain('materialColors: line.selectedMaterials.flatMap')
    expect(page).toContain('accessoryIds: line.selectedAccessories.flatMap')
    expect(page).toContain('<Field label="المواصفات وملاحظات التصنيع">')
  })
})

it('delegates search and keyboard/portal behavior to the existing single selectors', () => {
  expect(wrapper).toContain("from '../materials/SearchableMaterialSelect'")
  expect(wrapper).toContain("from '../materials/SearchableColorSelect'")
  expect(wrapper).toContain('<SearchableMaterialSelect')
  expect(wrapper).toContain('<SearchableColorSelect')
  expect(wrapper).not.toContain('setQuery')
})
