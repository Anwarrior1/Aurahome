import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WithdrawalsPage } from '@renderer/pages/withdrawals/WithdrawalsPage'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

const state = vi.hoisted(() => ({ manage: false }))
vi.mock('@renderer/state/session.store', () => ({
  useSession: () => ({ can: (permission: string) => permission !== P.withdrawals.manage || state.manage })
}))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: vi.fn() }) }))
vi.mock('@renderer/lib/useQuery', () => ({
  useQuery: () => ({ loading: false, reload: vi.fn(), data: [] })
}))
vi.mock('@renderer/lib/usePagedQuery', () => ({
  usePagedQuery: () => ({
    loading: false, reload: vi.fn(), next: vi.fn(), prev: vi.fn(), pageIndex: 0, hasNext: false, hasPrev: false,
    items: [{ id: 1, amountMinor: 2000000, person: 'المالك', notes: 'اختبار', withdrawnAt: '2026-09-14', cashAccountId: null, createdAt: '2026-09-14T10:00:00.000Z' }],
    summary: { availableMinor: 15540000, totalWithdrawnMinor: 2000000 }
  })
}))

beforeEach(() => { state.manage = false })

function render(): string { return renderToStaticMarkup(createElement(WithdrawalsPage)) }

describe('Profit withdrawal action visibility', () => {
  it('shows compact accessible Pencil/Trash SVG icons with the existing action styles for managers', () => {
    state.manage = true
    const markup = render()
    expect(markup).toContain('class="row-actions"')
    expect(markup).toContain('class="icon-btn" title="تعديل" aria-label="تعديل"')
    expect(markup).toContain('class="icon-btn icon-btn--danger" title="حذف" aria-label="حذف"')
    expect(markup).toContain('lucide-pencil')
    expect(markup).toContain('lucide-trash')
    expect(markup).not.toMatch(/>تعديل<|>حذف</)
  })

  it('keeps withdrawals readable but omits edit/delete controls without management permission', () => {
    const markup = render()
    expect(markup).toContain('المالك')
    expect(markup).not.toContain('lucide-pencil')
    expect(markup).not.toContain('lucide-trash')
  })
})
