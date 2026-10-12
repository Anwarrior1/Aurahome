import { describe, expect, it } from 'vitest'
import { filterMaterialTypeOptions, type MaterialTypeOption } from '@renderer/components/materials/SearchableMaterialSelect'

/**
 * `filterMaterialTypeOptions` is the real, executable filtering logic
 * behind the "نوع المادة" dropdown shared by the Preliminary and
 * Approved Invoice forms — run here directly (no jsdom is configured
 * for this renderer; see vitest.config.ts), exactly like
 * filterCustomerOptions is tested in searchable-customer-select.test.ts.
 *
 * Because it is a pure narrowing of whatever array is handed to it,
 * these tests also stand in for the "never widens visibility beyond
 * what was already loaded/permitted" guarantee.
 */
const MATERIALS: MaterialTypeOption[] = [
  { id: 1, sku: 'MDF-18W', name: 'MDF أبيض 18mm' },
  { id: 2, sku: 'WD-BEECH', name: 'خشب زان' },
  { id: 3, sku: 'WD-MOSKY', name: 'خشب موسكي' },
  { id: 4, sku: 'FB-GRY', name: 'قماش رمادي' }
]

describe('filterMaterialTypeOptions — name search (item 2)', () => {
  it('matches a partial Arabic name', () => {
    expect(filterMaterialTypeOptions(MATERIALS, 'خشب').map((m) => m.id).sort()).toEqual([2, 3])
  })

  it('matches a mixed Latin/Arabic name (item text contains both)', () => {
    expect(filterMaterialTypeOptions(MATERIALS, 'mdf').map((m) => m.id)).toEqual([1])
  })

  it('is case-insensitive for the Latin portion', () => {
    expect(filterMaterialTypeOptions(MATERIALS, 'MDF')).toEqual(filterMaterialTypeOptions(MATERIALS, 'mdf'))
  })

  it('ignores leading/trailing whitespace', () => {
    expect(filterMaterialTypeOptions(MATERIALS, '   زان   ').map((m) => m.id)).toEqual([2])
  })

  it('an empty or whitespace-only query returns the full given list unchanged', () => {
    expect(filterMaterialTypeOptions(MATERIALS, '')).toEqual(MATERIALS)
    expect(filterMaterialTypeOptions(MATERIALS, '   ')).toEqual(MATERIALS)
  })
})

describe('filterMaterialTypeOptions — code search (item 3)', () => {
  it('matches a partial SKU/code, case-insensitively', () => {
    expect(filterMaterialTypeOptions(MATERIALS, 'wd-').map((m) => m.id).sort()).toEqual([2, 3])
    expect(filterMaterialTypeOptions(MATERIALS, 'MDF-18').map((m) => m.id)).toEqual([1])
  })
})

describe('filterMaterialTypeOptions — no match', () => {
  it('returns an empty array for text matching nothing', () => {
    expect(filterMaterialTypeOptions(MATERIALS, 'no-such-material-xyz')).toEqual([])
  })
})

describe('filterMaterialTypeOptions — cannot widen visibility (item 12)', () => {
  it('is a pure narrowing of its own input: a material absent from the input can never appear in the output', () => {
    const restricted = MATERIALS.filter((m) => m.id !== 2) // as if already filtered to active-only upstream
    expect(filterMaterialTypeOptions(restricted, 'خشب').map((m) => m.id)).not.toContain(2)
  })

  it('an empty permitted list stays empty regardless of query', () => {
    expect(filterMaterialTypeOptions([], 'خشب')).toEqual([])
  })
})
