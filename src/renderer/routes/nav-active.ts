import { NAV, type NavItem } from './nav'

/**
 * Pure route-matching helpers behind the sidebar's accordion state
 * (AppLayout.tsx) — kept in their own plain `.ts` module, separate
 * from any component, so they can be exercised directly in tests
 * against the real NAV config without a DOM/React rendering
 * environment (this project's renderer tests are otherwise all
 * source-text based — see step4-action-ui.test.ts).
 */

/**
 * Mirrors NavLink's own `end`/prefix matching (item.path === '/' is
 * exact; everything else also matches its own nested routes) so the
 * section that "contains the current route" is always the same one
 * react-router would itself mark active.
 */
export function isItemActive(pathname: string, item: NavItem): boolean {
  if (item.path === '/') return pathname === '/'
  return pathname === item.path || pathname.startsWith(`${item.path}/`)
}

/** The one collapsible section (a group with more than one item) the
 *  current URL falls inside, if any — derived straight from NAV and
 *  the route, never a hardcoded list of section/route names. */
export function sectionForPath(pathname: string): string | null {
  const group = NAV.find((g) => g.items.length > 1 && g.items.some((item) => isItemActive(pathname, item)))
  return group?.label ?? null
}
