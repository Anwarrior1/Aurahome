import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
const ui = vi.hoisted(() => ({ permissions: [] as string[], rows: [] as unknown[] }))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: (key: string) => ui.permissions.includes(key) }) }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: vi.fn() }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@renderer/lib/useQuery', () => ({ useQuery: () => ({ data: undefined, loading: false, reload: vi.fn() }) }))
vi.mock('@renderer/lib/usePagedQuery', () => ({ usePagedQuery: () => ({ items: ui.rows, summary: { totalCount: ui.rows.length }, loading: false, pageIndex: 0, hasPrev: false, hasNext: false, next: vi.fn(), prev: vi.fn(), reload: vi.fn() }) }))
import { UncollectedProductsPage } from '@renderer/pages/uncollected/UncollectedProductsPage'
beforeEach(() => { vi.stubGlobal('React', React); ui.permissions = [P.uncollectedProducts.resume] })
afterEach(() => vi.unstubAllGlobals())
describe('Uncollected Product resume UI', () => {
  it.each([{ status: 'available', canResume: true }, { status: 'available', canResume: false }, { status: 'reserved', canResume: false }, { status: 'sold', canResume: false }, { status: 'resumed', canResume: false }])('renders only authoritative eligible resume controls for $status ($canResume)', state => {
    ui.rows = [{ id: 1, name: 'Product', sourceOrderId: 42, sourceOrderNumber: 'SO-42', transferredAt: '2026-09-15', quantityMicro: 1000000, ...state }]
    const html = renderToStaticMarkup(createElement(UncollectedProductsPage))
    expect(html.includes('>استئناف الطلب</button>')).toBe(state.canResume)
    expect(html).toContain('SO-42')
    ui.permissions = [P.uncollectedProducts.sell]
    expect(renderToStaticMarkup(createElement(UncollectedProductsPage))).not.toContain('>استئناف الطلب</button>')
  })
  it('confirms the original order and all products with a stable retry key, and exposes the historical resumed state', () => {
    const page = readFileSync('src/renderer/pages/uncollected/UncollectedProductsPage.tsx', 'utf8')
    expect(page).toContain('title="تأكيد استئناف الطلب"')
    expect(page).toContain('{resume?.row.sourceOrderNumber}')
    expect(page).toContain('confirmation: resume.row.sourceOrderNumber, requestKey: resume.requestKey')
    expect(page).toContain("'uncollectedProducts', 'resume'")
    expect(page).toContain('if (!resume || resuming) return')
    expect(page).toContain('await list.reload()')
    expect(page).toContain('resume?.row.resumeProducts.map')
    expect(page).toContain('expectedProductIds: resume.row.resumeProducts.map')
    expect(page).toContain('استئناف الطلب الأصلي')
    expect(page).toContain('بالكامل')
    expect(page).not.toContain('يتم استئناف هذا المنتج فقط')
    const order = readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')
    expect(order).toContain('!resumeFulfilmentBlocked && !releaseIssued')
    expect(order).toContain('!resumeFulfilmentBlocked && requiredCompletion')
    expect(order).toContain("!manufacturingIssued")
  })
})
