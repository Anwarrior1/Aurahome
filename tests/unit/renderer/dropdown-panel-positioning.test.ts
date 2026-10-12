import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const panel = readFileSync('src/renderer/components/materials/DropdownPanel.tsx', 'utf8')
const materialSelect = readFileSync('src/renderer/components/materials/SearchableMaterialSelect.tsx', 'utf8')
const colorSelect = readFileSync('src/renderer/components/materials/SearchableColorSelect.tsx', 'utf8')
const customerSelect = readFileSync('src/renderer/components/customers/SearchableCustomerSelect.tsx', 'utf8')
const css = readFileSync('src/renderer/styles/global.css', 'utf8')

describe('DropdownPanel — escapes the Modal via a real portal (item 4: no clipping)', () => {
  it('portals into document.body rather than rendering inline', () => {
    expect(panel).toContain("import { createPortal } from 'react-dom'")
    expect(panel).toMatch(/createPortal\(\s*<div[\s\S]*?document\.body\s*\)/)
  })

  it('renders nothing while closed (no DOM node left behind to overlap a sibling field)', () => {
    expect(panel).toMatch(/if \(!open \|\| !style\) return null/)
  })
})

describe('DropdownPanel — collision handling (item 4): flip + horizontal clamp, not hardcoded coordinates', () => {
  it('measures the real anchor element rather than using a fixed offset', () => {
    expect(panel).toContain('getBoundingClientRect()')
  })

  it('prefers opening below, but computes whether there is room and flips above otherwise', () => {
    expect(panel).toContain('spaceBelow')
    expect(panel).toContain('spaceAbove')
    expect(panel).toMatch(/placeBelow/)
  })

  it('clamps horizontally to the viewport instead of letting the panel run off-screen', () => {
    expect(panel).toMatch(/left < VIEWPORT_MARGIN/)
    expect(panel).toMatch(/left \+ width > vw - VIEWPORT_MARGIN/)
  })

  it('positions with `top` only — never `bottom` — including when flipped above', () => {
    // `position: fixed` + `bottom` + `height: auto` inside a flex
    // column collapsed to a near-zero rendered height in headless
    // Chrome (confirmed via CDP) — always computing `top` sidesteps
    // that entirely, in both placements.
    expect(panel).not.toMatch(/\bbottom:\s*vh/)
    expect(panel).toContain('const top = Math.max(VIEWPORT_MARGIN, anchor.top - TRIGGER_OFFSET - height)')
  })

  it('corrects the flipped-above placement once the panel\'s real height is known, via a ResizeObserver — not a hardcoded guess', () => {
    // The panel doesn't exist in the DOM yet on the first, provisional
    // pass (its height is unknowable then), so the initial "above"
    // guess uses spaceAbove as a stand-in; this observer re-measures
    // the panel's actual rendered height once mounted (firing once
    // immediately, and again if content height later changes, e.g.
    // search narrowing the option list) and repositions precisely.
    expect(panel).toContain('new ResizeObserver')
    expect(panel).toContain('panel.offsetHeight')
  })

  it('recomputes position on resize and on scroll (the Modal body itself scrolls)', () => {
    expect(panel).toContain("window.addEventListener('resize', reposition)")
    expect(panel).toContain("window.addEventListener('scroll', reposition, true)")
  })
})

describe('CORRECTION — RTL: the shared class\'s `inset-inline-start: 0` no longer overrides inline `left`', () => {
  it('resets the same logical property inline, on both placements, not a physical left/right substitute', () => {
    // In this app (`<html dir="rtl">`), `.customer-select__dropdown`'s
    // stylesheet `inset-inline-start: 0` resolves to a physical
    // `right: 0`. Left unaddressed, the CSS2.1 over-constrained rule
    // for RTL discards this panel's own `left` and solves position
    // from that `right` instead — which put the panel flush against
    // the viewport's right edge (over the Sidebar) regardless of
    // which field opened it (confirmed via CDP: identical wrong
    // position for three different triggers, until this fix). An
    // inline physical `right` would be a different cascade property
    // and would not reliably win against a logical one — resetting
    // `insetInlineStart` itself is what actually neutralizes it.
    expect(panel).toContain("insetInlineStart: 'auto'")
    expect(css).toMatch(/\.customer-select__dropdown\s*\{[^}]*inset-inline-start:\s*0/) // shared class itself is untouched
  })
})

describe('CORRECTION — DropdownPanel width is EXACTLY the trigger\'s width, never wider (never a comfortable-minimum widen)', () => {
  it('derives width directly from the anchor — no widening constant of any kind', () => {
    expect(panel).toContain('const width = Math.min(anchor.width, vw - VIEWPORT_MARGIN * 2)')
    // The previous "widen narrow triggers up to a comfortable minimum"
    // behavior is exactly what caused the panel to spill past its own
    // field — removed entirely, not just renamed.
    expect(panel).not.toContain('COMFORTABLE_MIN_WIDTH')
    expect(panel).not.toMatch(/Math\.max\(anchor\.width,/)
  })

  it('still caps width to the viewport as a last-resort safety net only, not as the sizing mechanism', () => {
    expect(panel).toMatch(/Math\.min\(anchor\.width, vw - VIEWPORT_MARGIN \* 2\)/)
  })

  it('aligns to the anchor\'s own left edge directly (width==anchor.width makes both edges match simultaneously)', () => {
    expect(panel).toContain('let left = anchor.left')
    // The old "grow toward the trailing edge" formula only existed to
    // absorb the widening this correction removes.
    expect(panel).not.toContain('anchor.right - width')
  })

  it('overrides the shared .customer-select__dropdown class\'s min-width (240px, sized for the wider Customer field) via inline minWidth/maxWidth, without editing that shared class', () => {
    expect(panel).toContain('minWidth: width, maxWidth: width')
    expect(css).toContain('min-width: 240px') // shared class itself is untouched
  })
})

describe('DropdownPanel — z-index (item 5): above the Modal, below toasts, no arbitrary extreme value', () => {
  it('uses a specific, reasoned z-index between the Modal backdrop (50) and toasts (100)', () => {
    expect(panel).toContain('PANEL_Z_INDEX = 60')
    expect(css).toMatch(/\.modal-backdrop[\s\S]{0,400}z-index:\s*50/)
    expect(css).toMatch(/\.toasts[\s\S]{0,200}z-index:\s*100/)
  })
})

describe('DropdownPanel — outside-click safety with a portaled panel', () => {
  it('checks both the trigger container AND the portaled panel itself, not just the container', () => {
    // With the panel portaled out of the trigger\'s own DOM subtree, a
    // click on an option is NOT inside containerRef — checking only
    // that would misfire "outside click" on every selection.
    expect(panel).toContain('anchorRef.current?.contains(target)')
    expect(panel).toContain('panelRef.current?.contains(target)')
  })

  it('listens on the capture phase, so the Modal\'s own bubble-phase stopPropagation (on its dialog box) can never swallow an outside click first', () => {
    expect(panel).toContain("document.addEventListener('mousedown', onOutsideClick, true)")
    expect(panel).toContain("document.removeEventListener('mousedown', onOutsideClick, true)")
  })
})

describe('both searchable selectors are wired to the shared coordinator + panel (item 8: one shared fix, not duplicated)', () => {
  it('SearchableMaterialSelect uses useSingleOpenDropdown and DropdownPanel', () => {
    expect(materialSelect).toContain("import { DropdownPanel } from './DropdownPanel'")
    expect(materialSelect).toContain("import { useSingleOpenDropdown } from './dropdownCoordinator'")
    expect(materialSelect).toContain('useSingleOpenDropdown()')
    expect(materialSelect).toContain('<DropdownPanel')
    // No more local useState for the open/closed flag.
    expect(materialSelect).not.toMatch(/const \[open, setOpen\] = useState/)
  })

  it('SearchableColorSelect uses useSingleOpenDropdown and DropdownPanel', () => {
    expect(colorSelect).toContain("import { DropdownPanel } from './DropdownPanel'")
    expect(colorSelect).toContain("import { useSingleOpenDropdown } from './dropdownCoordinator'")
    expect(colorSelect).toContain('useSingleOpenDropdown()')
    expect(colorSelect).toContain('<DropdownPanel')
    expect(colorSelect).not.toMatch(/const \[open, setOpen\] = useState/)
  })

  it('the search query resets on every close path, including one forced by a sibling dropdown opening (item 2)', () => {
    for (const component of [materialSelect, colorSelect]) {
      expect(component).toMatch(/if \(!open\) setQuery\(''\)/)
    }
  })

  it('autofocus is delegated to DropdownPanel (it alone knows when the portaled input actually exists)', () => {
    for (const component of [materialSelect, colorSelect]) {
      expect(component).toContain('initialFocusRef={searchRef}')
    }
    expect(panel).toContain('initialFocusRef?.current?.focus()')
    // Timed off `style` actually being set — the same render where the
    // portal's children (the search input included) are committed —
    // not off `open` alone, which fires one render too early.
    expect(panel).toMatch(/if \(open && style\) initialFocusRef\?\.current\?\.focus\(\)/)
  })
})

describe('the Customer selector — explicitly out of scope — is untouched', () => {
  it('does not import the new coordinator or panel', () => {
    expect(customerSelect).not.toContain('dropdownCoordinator')
    expect(customerSelect).not.toContain('DropdownPanel')
  })

  it('still manages its own local open state exactly as before', () => {
    expect(customerSelect).toMatch(/useState\(false\)/)
  })
})
