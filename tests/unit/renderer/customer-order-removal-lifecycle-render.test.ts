import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

const ui = vi.hoisted(() => ({ permissions: [] as string[], detail: {} as unknown }))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: (key: string) => ui.permissions.includes(key) }) }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: vi.fn() }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useParams: () => ({ id: '1' }) }))
vi.mock('@renderer/lib/useQuery', () => ({ useQuery: (group: string, method: string) => ({
  data: group === 'orders' && method === 'get' ? ui.detail : undefined,
  loading: false, reload: vi.fn(), error: undefined
}) }))
import { OrderDetailPage } from '@renderer/pages/orders/OrderDetailPage'

beforeEach(() => { vi.stubGlobal('React', React); ui.permissions = [P.orders.cancel, P.payments.refund] })
afterEach(() => vi.unstubAllGlobals())
describe('rendered Customer Order removal lifecycle', () => {
  it.each([
    { stage: 'unpaid pre-manufacturing', paidMinor: 0, issued: false, cancel: false, refund: false },
    { stage: 'paid pre-manufacturing', paidMinor: 300000, issued: false, cancel: false, refund: true },
    { stage: 'fully refunded pre-manufacturing', paidMinor: 0, issued: false, cancel: false, refund: false },
    { stage: 'issued Manufacturing Order', paidMinor: 0, issued: true, cancel: false, refund: false },
    { stage: 'completed Manufacturing Order', paidMinor: 0, issued: true, cancel: true, refund: false },
    { stage: 'paid completed Manufacturing Order', paidMinor: 200000, issued: true, cancel: true, refund: false }
  ])('hides unavailable actions entirely for $stage', (state) => {
    ui.detail = {
      order: { id: 1, documentNumber: 'SO-1', status: 'confirmed', totalMinor: 200000, paidMinor: state.paidMinor,
        remainingMinor: 200000 - state.paidMinor, depositRequiredMinor: 0, createdAt: '2026-09-14', archivedAt: null },
      actions: { canCancel: state.cancel, canRefundPayment: state.refund, refundableMinor: state.paidMinor },
      workflow: { manufacturingIssued: state.issued, releaseIssued: false, requiredCompletion: null },
      lines: [], payments: []
    }
    const html = renderToStaticMarkup(createElement(OrderDetailPage))
    expect(html.includes('إلغاء الطلب')).toBe(state.cancel)
    expect(html.includes('استرداد دفعة')).toBe(state.refund)
    ui.permissions = []
    expect(renderToStaticMarkup(createElement(OrderDetailPage))).not.toContain('إلغاء الطلب')
  })
})
