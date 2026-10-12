import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '@renderer/pages/dashboard/DashboardPage'
import { fmtMoney } from '@renderer/lib/format'

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))

const state = vi.hoisted(() => ({ data: undefined as unknown }))
vi.mock('@renderer/lib/useQuery', () => ({
  useQuery: () => ({ data: state.data, loading: false })
}))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: () => true }) }))
vi.mock('@renderer/state/selected-date.store', () => ({
  useSelectedDate: () => ({ selectedDateIso: '2026-09-14', isToday: true })
}))

function render(): string {
  return renderToStaticMarkup(createElement(DashboardPage))
}

beforeEach(() => { state.data = undefined })

describe('Dashboard remaining profit card', () => {
  it('shows the backend value with the shared card, currency formatter and SVG icon', () => {
    state.data = { profits: { netProfitMinor: 19000000, completedOrderCount: 1, remainingProfitMinor: 15540000 } }
    const markup = render()
    expect(markup).toContain('المتبقي بعد الخصومات والمسحوبات')
    expect(markup).toContain(fmtMoney(15540000))
    expect(markup).toContain('lucide-circle-dollar-sign')
    expect(markup).toMatch(/stat stat--brand[\s\S]*stat__value money[\s\S]*stat__label/)
    expect(markup).toContain('صافي ربح 9/2026')
  })

  it('omits the card when the backend omits permission-restricted data', () => {
    state.data = { profits: { netProfitMinor: 19000000, completedOrderCount: 1 } }
    expect(render()).not.toContain('المتبقي بعد الخصومات والمسحوبات')
  })

  it('renders refreshed zero and negative results without a frontend total', () => {
    for (const remainingProfitMinor of [15540000, 0, -123456]) {
      state.data = { profits: { netProfitMinor: 19000000, completedOrderCount: 1, remainingProfitMinor } }
      expect(render()).toContain(fmtMoney(remainingProfitMinor))
      expect(render()).toContain('المتبقي بعد الخصومات والمسحوبات')
    }
  })
})
