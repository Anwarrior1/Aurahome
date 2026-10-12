import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery } from '@renderer/lib/useQuery'

const hooks = vi.hoisted(() => ({ cleanups: [] as Array<() => void>, call: vi.fn() }))
vi.mock('react', () => ({
  useState: () => [undefined, vi.fn()],
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => undefined | (() => void)) => {
    const cleanup = effect()
    if (cleanup) hooks.cleanups.push(cleanup)
  }
}))
vi.mock('@renderer/lib/api', () => ({ call: hooks.call, ApiError: class extends Error {} }))

beforeEach(() => {
  hooks.cleanups = []
  hooks.call.mockReset().mockResolvedValue({})
  vi.stubGlobal('window', new EventTarget())
})
afterEach(() => {
  hooks.cleanups.forEach((cleanup) => cleanup())
  vi.unstubAllGlobals()
})

describe('Withdrawal financial query refresh', () => {
  it('re-reads profit, Dashboard and cash queries after a correction and cleans up listeners', () => {
    useQuery('profit', 'withdrawals', {})
    useQuery('profit', 'monthly', { year: 2026, month: 9 })
    useQuery('dashboard', 'summary', { year: 2026, month: 9 })
    useQuery('cash', 'accounts')
    expect(hooks.call).toHaveBeenCalledTimes(4)
    window.dispatchEvent(new Event('profit-withdrawals-changed'))
    expect(hooks.call).toHaveBeenCalledTimes(8)
    expect(hooks.call).toHaveBeenCalledWith('dashboard', 'summary', { year: 2026, month: 9 })
    hooks.cleanups.forEach((cleanup) => cleanup())
    window.dispatchEvent(new Event('profit-withdrawals-changed'))
    expect(hooks.call).toHaveBeenCalledTimes(8)
  })

  it('does not fetch disabled financial queries or refresh unrelated modules', () => {
    useQuery('dashboard', 'summary', {}, { enabled: false })
    useQuery('customers', 'list')
    expect(hooks.call).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('profit-withdrawals-changed'))
    expect(hooks.call).toHaveBeenCalledTimes(1)
  })
})


describe('Recurring expense reversal refresh', () => {
  it('re-reads recurring definitions, all expense views, cash, profits, Dashboard and affected reports', () => {
    useQuery('expenses', 'listRecurring', {})
    useQuery('expenses', 'list', { from: '2026-09-01', to: '2026-09-30' })
    useQuery('expenses', 'list', { from: '2026-09-01', to: '2026-11-30' })
    useQuery('cash', 'accounts')
    useQuery('profit', 'monthly', { year: 2026, month: 9 })
    useQuery('dashboard', 'summary', { year: 2026, month: 9 })
    useQuery('reports', 'build', { key: 'expenses', from: '2026-09-01', to: '2026-09-30' })
    useQuery('reports', 'build', { key: 'monthly_profit', year: 2026, month: 9 })
    expect(hooks.call).toHaveBeenCalledTimes(8)
    window.dispatchEvent(new Event('recurring-expense-reversed'))
    expect(hooks.call).toHaveBeenCalledTimes(16)
    hooks.cleanups.forEach((cleanup) => cleanup())
    window.dispatchEvent(new Event('recurring-expense-reversed'))
    expect(hooks.call).toHaveBeenCalledTimes(16)
  })

  it('keeps disabled queries, unrelated modules and unrelated reports unchanged', () => {
    useQuery('expenses', 'list', {}, { enabled: false })
    useQuery('dashboard', 'summary', {}, { enabled: false })
    useQuery('reports', 'build', { key: 'expenses' }, { enabled: false })
    useQuery('reports', 'build', { key: 'sales' })
    useQuery('reports', 'available')
    useQuery('customers', 'list')
    expect(hooks.call).toHaveBeenCalledTimes(3)
    window.dispatchEvent(new Event('recurring-expense-reversed'))
    expect(hooks.call).toHaveBeenCalledTimes(3)
  })
})
