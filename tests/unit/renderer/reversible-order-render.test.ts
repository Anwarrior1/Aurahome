import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

const ui = vi.hoisted(() => ({ permissions: [] as string[], orders: [] as unknown[], permits: [] as unknown[], queries: [] as Array<{ group: string; method: string; payload: unknown }> }))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: (key: string) => ui.permissions.includes(key) }) }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: vi.fn() }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@renderer/lib/useQuery', () => ({ useQuery: (group: string, method: string, payload: unknown) => {
  ui.queries.push({ group, method, payload })
  return { data: group === 'orders' ? ui.orders : ui.permits, loading: false, reload: vi.fn(), error: undefined }
} }))
vi.mock('@renderer/lib/usePagedQuery', () => ({ usePagedQuery: (group: string, method: string, payload: unknown, options: unknown) => {
  ui.queries.push({ group, method, payload, options } as never)
  const items = group === 'orders' ? ui.orders : ui.permits
  return { items, summary: undefined, loading: false, error: undefined, pageIndex: 0, hasPrev: false, hasNext: items.length >= 50, next: vi.fn(), prev: vi.fn(), reload: vi.fn() }
} }))
import { ManufacturingReversalButton } from '@renderer/components/orders/ManufacturingReversalButton'
import { OrdersPage } from '@renderer/pages/orders/OrdersPage'
import { ReleasesPage } from '@renderer/pages/releases/ReleasesPage'

beforeEach(() => {
  // Node Vitest uses classic JSX; production Vite uses automatic JSX.
  vi.stubGlobal('React', React)
  ui.permissions = []; ui.orders = []; ui.permits = []; ui.queries = []
})
afterEach(() => vi.unstubAllGlobals())
describe('real rendered reversal/archive controls (no live application database)', () => {
  it('does not render Manufacturing Order reversal for an unauthorized user', () => {
    expect(renderToStaticMarkup(createElement(ManufacturingReversalButton, { id: 1, sheet: { status: 'ready' }, onReversed: async () => {} }))).toBe('')
  })
  it('renders the Arabic button but never executes reversal or opens confirmation automatically', () => {
    ui.permissions = [P.worksheets.reverse]
    const html = renderToStaticMarkup(createElement(ManufacturingReversalButton, { id: 1, sheet: { status: 'ready' }, onReversed: async () => {} }))
    expect(html).toContain('تراجع عن أمر التصنيع')
    expect(html).toContain('btn--secondary')
    expect(html).not.toContain('role="dialog"')
  })
  it.each([
    { status: 'in_production', startedAt: '2025-01-01T08:00:00Z' },
    { status: 'completed', startedAt: '2025-01-01T08:00:00Z', completedAt: '2025-01-02T08:00:00Z' },
    { status: 'cancelled', startedAt: '2025-01-01T08:00:00Z' }
  ])('CC01-D: never renders Manufacturing Order reversal once manufacturing started ($status), even with permission', (sheet) => {
    ui.permissions = [P.worksheets.reverse]
    expect(renderToStaticMarkup(createElement(ManufacturingReversalButton, { id: 1, sheet, onReversed: async () => {} }))).toBe('')
  })
  it('does not render Manufacturing Order reversal for an archived source order even with permission', () => {
    ui.permissions = [P.worksheets.reverse]
    const html = renderToStaticMarkup(createElement(ManufacturingReversalButton, {
      id: 1,
      sheet: { status: 'ready' },
      sourceOrderArchived: true,
      onReversed: async () => {}
    }))
    expect(html).toBe('')
  })
  it('renders one server-bounded 50-row active page and permission-gates archive', () => {
    ui.orders = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, documentNumber: 'ROW-' + (index + 1), customerName: 'عميل', status: 'completed', canDeleteCancel: false, canArchive: true, totalMinor: 1000000, paidMinor: 1000000, remainingMinor: 0, depositRequiredMinor: 0, paymentStatus: 'paid', completedAt: '2025-01-01', createdAt: '2025-01-01' }))
    const forbidden = renderToStaticMarkup(createElement(OrdersPage))
    expect(forbidden).toContain('الطلبات النشطة')
    expect(forbidden).toContain('الطلبات المؤرشفة')
    expect(forbidden).toContain('ROW-50')
    expect(forbidden).not.toContain('aria-label="أرشفة الطلب"')
    // The page size is enforced by main; the renderer never asks by OFFSET.
    expect(ui.queries[0]).toMatchObject({ group: 'orders', method: 'list', payload: { archived: false }, options: { limit: 50 } })
    expect(JSON.stringify(ui.queries[0])).not.toContain('offset')
    ui.permissions = [P.orders.archive]
    expect(renderToStaticMarkup(createElement(OrdersPage))).toContain('aria-label="أرشفة الطلب"')
  })
  it.each([
    { status: 'confirmed', remainingMinor: 10000000, canDeleteCancel: true, canArchive: false },
    { status: 'confirmed', remainingMinor: 7000000, canDeleteCancel: false, canArchive: false },
    { status: 'confirmed', remainingMinor: 0, canDeleteCancel: false, canArchive: false },
    { status: 'completed', remainingMinor: 0, canDeleteCancel: false, canArchive: true },
    { status: 'cancelled', remainingMinor: 7000000, canDeleteCancel: false, canArchive: true }
  ])('renders the exact action matrix for $status with remaining=$remainingMinor', (state) => {
    ui.permissions = [P.orders.cancel, P.orders.fullDelete, P.orders.archive]
    ui.orders = [{ id: 1, documentNumber: 'MATRIX', customerName: 'Customer', totalMinor: 10000000,
      paidMinor: 10000000 - state.remainingMinor, depositRequiredMinor: 0, paymentStatus: 'paid',
      completedAt: null, createdAt: '2026-09-14', ...state }]
    const html = renderToStaticMarkup(createElement(OrdersPage))
    expect(html.includes('aria-label="حذف"')).toBe(state.canDeleteCancel)
    expect(html.includes('aria-label="أرشفة الطلب"')).toBe(state.canArchive)
    expect(html).not.toContain('role="dialog"')
    expect(html).toContain('aria-label="عرض"')
    expect(html).toContain('aria-label="طباعة الفاتورة المعتمدة"')
    expect(html).toContain('aria-label="تصدير PDF"')
    ui.permissions = []
    const forbidden = renderToStaticMarkup(createElement(OrdersPage))
    expect(forbidden).not.toContain('aria-label="حذف"')
    expect(forbidden).not.toContain('aria-label="أرشفة الطلب"')
  })
  it('renders permit undo only with its authority and only for active permits', () => {
    ui.permits = [{ id: 1, documentNumber: 'EP-1', orderId: 1, kind: 'installation', status: 'active', authorizedAt: '2025-01-01', workers: [] }, { id: 2, documentNumber: 'EP-2', orderId: 1, kind: 'installation', status: 'reversed', authorizedAt: '2025-01-01', workers: [] }]
    expect(renderToStaticMarkup(createElement(ReleasesPage))).not.toContain('> تراجع<')
    ui.permissions = [P.releases.reverse]
    const html = renderToStaticMarkup(createElement(ReleasesPage))
    expect(html).toContain('تم التراجع')
    expect(html.match(/> تراجع</g)).toHaveLength(1)
  })
})
