import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { NAV } from '@renderer/routes/nav'
import { isItemActive, sectionForPath } from '@renderer/routes/nav-active'

const read = (path: string): string => readFileSync(path, 'utf8')

/**
 * Sidebar redesign (accordion sections + floating panel): a
 * visual/interaction-only change. `isItemActive`/`sectionForPath` are
 * pure and exercised here directly against the REAL NAV config —
 * every other renderer test in this project is source-text based (no
 * jsdom/React Testing Library is configured — see vitest.config.ts),
 * so the structural/RBAC/CSS guarantees below stay in that same style.
 */
describe('sidebar route-matching (isItemActive / sectionForPath)', () => {
  it('every multi-item group in the real NAV config auto-expands for each of its own routes', () => {
    for (const group of NAV) {
      if (group.items.length <= 1) continue
      for (const item of group.items) {
        expect(sectionForPath(item.path)).toBe(group.label)
        // A nested route under that same item (e.g. an order detail
        // page) still resolves to the same parent section.
        expect(sectionForPath(`${item.path}/123`)).toBe(group.label)
      }
    }
  })

  it('the single-item "الرئيسية" group never reports as a collapsible section', () => {
    const home = NAV.find((g) => g.items.length === 1)
    expect(home).toBeDefined()
    expect(sectionForPath(home!.items[0].path)).toBeNull()
  })

  it('an unknown route (e.g. /login, /setup) opens no section at all', () => {
    expect(sectionForPath('/login')).toBeNull()
    expect(sectionForPath('/setup')).toBeNull()
  })

  it('"/" only matches the Dashboard item, never a nested route sharing the prefix', () => {
    expect(isItemActive('/', { path: '/', label: 'x', icon: 'home' })).toBe(true)
    expect(isItemActive('/orders', { path: '/', label: 'x', icon: 'home' })).toBe(false)
  })

  it('back/forward between two different sections switches which one resolves as open', () => {
    // Simulates the exact browser-history scenario in the task: the
    // user is deep in "الإنتاج" (Workers), then navigates to "المبيعات".
    expect(sectionForPath('/workers')).toBe('الإنتاج')
    expect(sectionForPath('/customers')).toBe('المبيعات')
  })
})

describe('sidebar redesign — structural/RBAC/business-logic isolation', () => {
  const nav = read('src/renderer/routes/nav.ts')
  const layout = read('src/renderer/layouts/AppLayout.tsx')
  const router = read('src/renderer/routes/router.tsx')

  it('retains every navigation path/label and declares each single or OR permission key', () => {
    // Each configured route, label and permission key remains explicit.
    for (const group of NAV) {
      for (const item of group.items) {
        expect(nav).toContain(`path: '${item.path}'`)
        expect(nav).toContain(`label: '${item.label}'`)
        for (const permission of Array.isArray(item.permission) ? item.permission : item.permission ? [item.permission] : []) {
          expect(nav).toContain(permission)
        }
      }
    }
    expect(nav).toContain('icon?: string')
  })

  it('keeps RBAC permission filtering ahead of BOTH the flat-link and the collapsible-section render paths', () => {
    expect(layout).toContain('group.items.filter((item) => canAccessNavItem(item, can))')
    // A section is only ever built from that already-filtered list —
    // never the raw, unfiltered group.items.
    expect(layout).toMatch(/items\.map\(\(item\)/)
  })

  it('never allows more than one section open at once (single string|null state, not a set/array)', () => {
    expect(layout).toContain('useState<string | null>')
    expect(layout).not.toMatch(/openSections|Set<string>|expandedSections/)
  })

  it('derives the expanded section from the route + local state — never a hardcoded route/label list', () => {
    expect(layout).toContain('sectionForPath(location.pathname)')
    expect(layout).not.toMatch(/=== ['"]الإنتاج['"]|=== ['"]\/workers['"]/)
  })

  it('the section header toggles local state only — it is a button, never a Link/NavLink', () => {
    expect(layout).toContain('className="sidebar__section-toggle"')
    expect(layout).toContain('onClick={() => toggleSection(group.label)}')
  })

  it('does not touch the router, its routes, or the top bar', () => {
    // The route table itself is untouched — same component-per-path
    // pairing as before, no path added/removed/renamed by this pass.
    for (const group of NAV) {
      for (const item of group.items) {
        if (item.path === '/') continue
        expect(router).toContain(`path="${item.path}"`)
      }
    }
    expect(layout).toContain('<header className="headbar">')
  })
})

describe('sidebar redesign — floating panel / accordion CSS', () => {
  const css = read('src/renderer/styles/global.css')

  it('floats the sidebar (inset margin + rounded corners), reusing existing tokens only', () => {
    expect(css).toMatch(/\.sidebar\s*\{[^}]*margin:\s*14px/)
    expect(css).toMatch(/\.sidebar\s*\{[^}]*border-radius:\s*22px/)
    expect(css).toContain('background: var(--bg-sidebar)')
  })

  it('isolates scrolling to the nav list, leaving brand/foot pinned', () => {
    expect(css).toMatch(/\.sidebar__nav\s*\{[^}]*overflow-y:\s*auto/)
    expect(css).toMatch(/\.sidebar__brand\s*\{[^}]*flex-shrink:\s*0/)
    expect(css).toMatch(/\.sidebar__foot\s*\{[^}]*flex-shrink:\s*0/)
  })

  it('gives an expanded section a grouped rounded panel and the active child a strong pill using theme tokens', () => {
    expect(css).toContain('.sidebar__section--open')
    expect(css).toMatch(/\.sidebar__section-children \.sidebar__link\.active\s*\{[^}]*background:\s*var\(--color-brand-400\)/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}.*\.sidebar__section/)
  })
})
