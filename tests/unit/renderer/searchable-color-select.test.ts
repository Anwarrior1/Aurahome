import { describe, expect, it } from 'vitest'
import {
  colorOptionValue,
  filterColorOptions,
  type ColorOption
} from '@renderer/components/materials/SearchableColorSelect'

/**
 * `filterColorOptions` is the real, executable filtering logic behind
 * the "كود اللون/التشطيب" dropdown shared by the Preliminary and
 * Approved Invoice forms — run here directly (no jsdom is configured
 * for this renderer; see vitest.config.ts), exactly like
 * filterMaterialTypeOptions is tested in searchable-material-select.test.ts.
 *
 * The option set below reuses the correction task's own examples
 * (DEMO-G / رمادي, DEMO-N / خشبي) so these tests double as a direct
 * check of the scenarios called out by name in the task.
 */
const COLORS: ColorOption[] = [
  { id: 1, code: 'DEMO-G', name: 'رمادي - تجريبي' },
  { id: 2, code: 'DEMO-N', name: 'خشبي طبيعي - تجريبي' },
  { id: 3, code: 'DEMO-W', name: 'أبيض - تجريبي' }
]

describe('filterColorOptions — search by code (item 2)', () => {
  it('matches the exact code from the task example', () => {
    expect(filterColorOptions(COLORS, 'DEMO-G').map((c) => c.id)).toEqual([1])
  })

  it('is case-insensitive for the Latin code', () => {
    expect(filterColorOptions(COLORS, 'demo-g')).toEqual(filterColorOptions(COLORS, 'DEMO-G'))
  })

  it('matches a partial code prefix shared by several rows', () => {
    expect(
      filterColorOptions(COLORS, 'DEMO-')
        .map((c) => c.id)
        .sort()
    ).toEqual([1, 2, 3])
  })
})

describe('filterColorOptions — search by Arabic color/finish name (item 3)', () => {
  it('matches the color name example from the task ("رمادي")', () => {
    expect(filterColorOptions(COLORS, 'رمادي').map((c) => c.id)).toEqual([1])
  })

  it('matches the finish name example from the task ("خشبي")', () => {
    expect(filterColorOptions(COLORS, 'خشبي').map((c) => c.id)).toEqual([2])
  })

  it('ignores leading/trailing whitespace', () => {
    expect(filterColorOptions(COLORS, '   رمادي   ').map((c) => c.id)).toEqual([1])
  })
})

describe('filterColorOptions — no match / empty query', () => {
  it('returns an empty array for text matching nothing', () => {
    expect(filterColorOptions(COLORS, 'no-such-color-xyz')).toEqual([])
  })

  it('an empty or whitespace-only query returns the full given list unchanged', () => {
    expect(filterColorOptions(COLORS, '')).toEqual(COLORS)
    expect(filterColorOptions(COLORS, '   ')).toEqual(COLORS)
  })
})

describe('filterColorOptions — cannot widen visibility', () => {
  it('is a pure narrowing of its own input: a color absent from the input can never appear in the output', () => {
    const restricted = COLORS.filter((c) => c.id !== 2)
    expect(filterColorOptions(restricted, 'خشبي').map((c) => c.id)).not.toContain(2)
  })
})

describe('color selection identity', () => {
  it('keeps invoice code mode as the default and exposes stable-id mode for material leaves', () => {
    expect(colorOptionValue(COLORS[0]!)).toBe('DEMO-G')
    expect(colorOptionValue(COLORS[0]!, 'id')).toBe('1')
  })
})

describe('SearchableColorSelect component source — dropdown, search field, "بدون" preservation (item 4)', () => {
  it('the search field only exists inside the opened dropdown, never permanently in the form', async () => {
    const { readFileSync } = await import('node:fs')
    const component = readFileSync(
      'src/renderer/components/materials/SearchableColorSelect.tsx',
      'utf8'
    )
    // The dropdown/search field now live inside <DropdownPanel>, which
    // itself renders nothing at all while closed (see DropdownPanel.tsx)
    // — still "only exists while open", just delegated.
    const dropdownStart = component.indexOf('<DropdownPanel')
    const searchInputIdx = component.indexOf('placeholder="بحث عن كود لون أو تشطيب...')
    expect(dropdownStart).toBeGreaterThan(-1)
    expect(searchInputIdx).toBeGreaterThan(dropdownStart)
  })

  it('uses the exact required no-result text', async () => {
    const { readFileSync } = await import('node:fs')
    const component = readFileSync(
      'src/renderer/components/materials/SearchableColorSelect.tsx',
      'utf8'
    )
    expect(component).toContain('لا يوجد كود لون/تشطيب مطابق')
  })

  it('the "بدون" row is always pinned, unaffected by search, and remains selectable', async () => {
    const { readFileSync } = await import('node:fs')
    const component = readFileSync(
      'src/renderer/components/materials/SearchableColorSelect.tsx',
      'utf8'
    )
    // Pinned from `filtered`, not `results` — search narrows the real
    // colors but never removes the "بدون" row itself.
    expect(component).toMatch(
      /results = useMemo\(\s*\(\) => \[\{ id: NONE_ID, code: '', name: noneLabel \}, \.\.\.filtered\]/
    )
    expect(component).toContain("onChange(color.id === NONE_ID ? '' : optionValue(color))")
  })

  it('reuses the existing searchable-dropdown CSS rather than introducing new styles', async () => {
    const { readFileSync } = await import('node:fs')
    const component = readFileSync(
      'src/renderer/components/materials/SearchableColorSelect.tsx',
      'utf8'
    )
    const css = readFileSync('src/renderer/styles/global.css', 'utf8')
    expect(component).toContain('className="customer-select"')
    expect(component).toContain('className="customer-select__trigger"')
    expect(component).toContain('className="customer-select__dropdown"')
    expect(css).not.toContain('.color-select')
  })

  it('stops propagation for every handled key, so Escape can never also close the surrounding invoice Modal', async () => {
    const { readFileSync } = await import('node:fs')
    const component = readFileSync(
      'src/renderer/components/materials/SearchableColorSelect.tsx',
      'utf8'
    )
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      const idx = component.indexOf(`event.key === '${key}'`)
      const branch = component.slice(idx, idx + 160)
      expect(branch).toContain('event.stopPropagation()')
    }
    const tabIdx = component.indexOf("event.key === 'Tab'")
    const tabBranch = component.slice(tabIdx, tabIdx + 200)
    expect(tabBranch).not.toContain('preventDefault')
  })
})

describe('Material leaf color picker integration', () => {
  it('reuses the searchable selector in stable-id mode and submits the numeric catalog id', async () => {
    const { readFileSync } = await import('node:fs')
    const form = readFileSync('src/renderer/pages/materials/MaterialFormModal.tsx', 'utf8')
    expect(form).toContain('<SearchableColorSelect')
    expect(form).toContain('valueMode="id"')
    expect(form).toContain("colorId: form.leafType === 'colored' ? Number(form.colorId) : null")
    expect(form).toContain('noneLabel="— اختر من كتالوج الألوان —"')
  })
})
