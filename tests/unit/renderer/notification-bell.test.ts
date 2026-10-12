import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')

/**
 * Notifications Bell: a real, data-connected Top Bar control. No
 * jsdom/React Testing Library is configured for this renderer (see
 * vitest.config.ts) — matching every other renderer test in this
 * project, these are source-text pins over the actual component/CSS,
 * not rendered-DOM assertions. The underlying data/RBAC/dedup/read-
 * state behavior is covered for real in
 * tests/integration/notifications.test.ts.
 */
describe('notification bell — placement, badge, dropdown, theme, click-through', () => {
  const bell = read('src/renderer/components/layout/NotificationBell.tsx')
  const layout = read('src/renderer/layouts/AppLayout.tsx')
  const css = read('src/renderer/styles/global.css')

  it('is placed inside the existing headbar__actions cluster — never disturbing AURA/HOME/date-nav/greeting', () => {
    expect(layout).toMatch(/<div className="headbar__actions">\s*\{[^}]*<NotificationBell \/>\}/)
    expect(layout).toContain("import { NotificationBell } from '@renderer/components/layout/NotificationBell'")
  })

  it('is only rendered for a user who can see at least one of its two categories', () => {
    expect(layout).toContain('(can(P.inventory.view) || can(P.orders.view)) && <NotificationBell />')
  })

  it('uses the existing icon-button style and lucide Bell icon, consistent with other Top Bar controls', () => {
    expect(bell).toContain("import { Bell, AlertTriangle, Clock, Trash2 } from 'lucide-react'")
    expect(bell).toContain('className="headbar-icon-btn"')
  })

  it('hides the badge at zero and shows the live unread count otherwise', () => {
    expect(bell).toContain('unreadCount > 0 && (')
    expect(bell).toContain('className="notif-bell__badge"')
  })

  it('theme-aware via existing tokens only — every surface/text color is a token, not a new hardcoded value', () => {
    expect(css).toMatch(/\.notif-bell__badge\s*\{[^}]*background:\s*var\(--color-danger\)/)
    expect(css).toMatch(/\.notif-dropdown\s*\{[^}]*background:\s*var\(--bg-card\)/)
    expect(css).toMatch(/\.notif-item__desc\s*\{[^}]*color:\s*var\(--text-secondary\)/)
    // #fff for the badge's own text is the same established exception
    // already used by .toast--success/.toast--error (white text on a
    // solid semantic-color background) — not a new/arbitrary color.
    expect(css).toContain('.toast--error { background: var(--color-danger); color: #fff; }')
  })

  it('positions the dropdown so it cannot run off the RTL-left edge, with its own internal scroll and a sensible max height', () => {
    expect(css).toMatch(/\.notif-dropdown\s*\{[^}]*inset-inline-end:\s*0/)
    expect(css).toMatch(/\.notif-dropdown\s*\{[^}]*max-height:\s*420px/)
    expect(css).toMatch(/\.notif-dropdown__list\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('long descriptions wrap instead of overflowing', () => {
    expect(css).toMatch(/\.notif-item__desc\s*\{[^}]*overflow-wrap:\s*anywhere/)
  })

  it('marks read on open and uses dedicated notification-only dismissal calls', () => {
    expect(bell).toContain("call('notifications', 'markAllRead')")
    expect(bell).toContain("call('notifications', 'dismiss', { notificationKey: item.key })")
    expect(bell).toContain("call('notifications', 'clearAll')")
  })

  it('offers a subtle per-row trash action without nesting buttons', () => {
    expect(bell).toContain('className="notif-item__delete"')
    expect(bell).toContain('aria-label="حذف الإشعار"')
    expect(bell).toContain('<Trash2 size={14}')
    expect(bell).toContain('<div\n                    key={item.key}')
  })

  it('optimistically hides a deleted item so its row, badge and final empty state update immediately', () => {
    expect(bell).toContain('const [hiddenKeys, setHiddenKeys]')
    expect(bell).toContain('.filter((item) => !hiddenKeys.has(item.key))')
    // DB-10: the feed is bounded, so the badge starts from main's full unread count
    // and subtracts only optimistically hidden unread rows.
    expect(bell).toContain('const hiddenUnread = (data?.items ?? []).filter((item) => hiddenKeys.has(item.key) && !item.read).length')
    expect(bell).toContain('const unreadCount = Math.max((data?.unreadCount ?? 0) - hiddenUnread, 0)')
    expect(bell).toContain('لا توجد إشعارات حالياً')
  })

  it('clear all is compact, conditional, and requires the Arabic confirmation with both actions', () => {
    expect(bell).toContain('className="notif-dropdown__clear"')
    expect(bell).toContain('هل تريد مسح جميع الإشعارات؟')
    expect(bell).toContain('onClose={() => setConfirmClear(false)}')
    expect(bell).toContain('>إلغاء</Button>')
    expect(css).toMatch(/\.notif-dropdown__clear\s*\{[^}]*background:\s*transparent/)
  })

  it('delete stops row navigation while the rest of the row keeps its existing route behavior', () => {
    expect(bell).toContain('event.stopPropagation()')
    expect(bell).toContain('onClick={() => openItem(item)}')
    expect(bell).toContain('navigate(item.route)')
  })

  it('clicking an item closes the dropdown and navigates via the existing router — using the server-supplied route, not a hardcoded one', () => {
    expect(bell).toContain('navigate(item.route)')
    expect(bell).toContain("from 'react-router-dom'")
  })

  it('polls periodically so the badge does not go stale indefinitely', () => {
    expect(bell).toMatch(/setInterval\(\(\) => void reload\(\), POLL_MS\)/)
  })
})

describe('notifications service — reuses existing authorities, never a second inventory/order calculation', () => {
  const service = read('src/main/services/notifications/notifications.service.ts')
  const lifecycle = read('src/main/services/notifications/notification-state.service.ts')

  it('low-stock reuses stockLevels() (the same query /inventory already uses) — no separate SUM/stock arithmetic', () => {
    expect(service).toContain("from '../inventory/valuation.service'")
    expect(service).toContain('stockLevels({})')
    expect(service).not.toMatch(/SUM\(/)
  })

  it('incomplete orders read the existing order status authority in one bounded-work query (DB-10)', () => {
    const ordersService = read('src/main/services/sales/orders.service.ts')
    expect(service).toContain("from '../sales/orders.service'")
    expect(service).toContain('openOrderAlertRows()')
    // No per-order eligibility enrichment and no deep OFFSET walk just to build alert keys.
    expect(service).not.toContain('listOrders(')
    expect(service).not.toContain('offset')
    expect(ordersService).toContain("WHERE o.archived_at IS NULL AND o.status = 'confirmed'")
    expect(service).not.toMatch(/status:\s*['"](?!confirmed)/)
  })

  it('each category is gated by the exact same permission key its own existing screen already requires', () => {
    expect(service).toContain('hasPermission(session, P.inventory.view)')
    expect(service).toContain('hasPermission(session, P.orders.view)')
  })

  it('persists per-user dismissals without changing business records and prunes only resolved keys', () => {
    expect(service).toContain('notificationDismissals')
    expect(service).toContain('userId: session.user.id')
    expect(service).toContain('${notificationDismissals.notificationKey} NOT IN ${active}')
    expect(service).toContain('json_each(${JSON.stringify(activeKeys)})')
    expect(service).not.toMatch(/update\((materials|orders)\)/)
  })

  it('clears only notification metadata when an underlying condition resolves between polls', () => {
    expect(lifecycle).toContain('clearLowStockStateIfResolved')
    expect(lifecycle).toContain('db.delete(notificationReads)')
    expect(lifecycle).toContain('db.delete(notificationDismissals)')
    expect(lifecycle).not.toMatch(/update\((materials|orders|inventoryMovements)\)/)
  })
})
