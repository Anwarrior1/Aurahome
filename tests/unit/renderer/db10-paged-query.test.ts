import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A minimal synchronous hook runtime: enough React semantics (state, refs,
 * callbacks, dependency-tracked effects) to drive usePagedQuery exactly as a
 * component would, without a DOM renderer.
 */
const runtime = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    effectDeps: [] as Array<unknown[] | undefined>,
    cleanups: [] as Array<(() => void) | undefined>,
    index: 0,
    effectIndex: 0,
    pending: [] as Array<() => void>,
    rerender: (() => undefined) as () => void
  }
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    useState<T>(initial: T | (() => T)) {
      const i = state.index++
      if (!(i in state.slots)) state.slots[i] = typeof initial === 'function' ? (initial as () => T)() : initial
      const set = (value: T | ((previous: T) => T)) => {
        const next = typeof value === 'function' ? (value as (previous: T) => T)(state.slots[i] as T) : value
        if (Object.is(next, state.slots[i])) return
        state.slots[i] = next
        state.rerender()
      }
      return [state.slots[i] as T, set] as const
    },
    useRef<T>(initial: T) {
      const i = state.index++
      if (!(i in state.slots)) state.slots[i] = { current: initial }
      return state.slots[i] as { current: T }
    },
    useCallback<T>(fn: T, deps: unknown[]) {
      const i = state.index++
      const stored = state.slots[i] as { fn: T; deps: unknown[] } | undefined
      if (stored && same(stored.deps, deps)) return stored.fn
      state.slots[i] = { fn, deps }
      return fn
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const i = state.effectIndex++
      if (same(state.effectDeps[i], deps)) return
      state.effectDeps[i] = deps
      state.pending.push(() => {
        state.cleanups[i]?.()
        state.cleanups[i] = effect() ?? undefined
      })
    }
  }
  return { state, react }
})
vi.mock('react', () => runtime.react)

const api = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ call: api.call, ApiError: class ApiError extends Error {} }))

import { usePagedQuery } from '@renderer/lib/usePagedQuery'

type Hook = ReturnType<typeof usePagedQuery<{ id: number }, { total: number }>>

function mount(read: () => Hook): { current: () => Hook } {
  const { state } = runtime
  let result: Hook
  const render = () => {
    state.index = 0
    state.effectIndex = 0
    result = read()
    while (state.pending.length) state.pending.shift()!()
  }
  state.rerender = render
  render()
  return { current: () => result }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const page = (ids: number[], next: string | null = null, prev: string | null = null) => ({ items: ids.map((id) => ({ id })), nextCursor: next, prevCursor: prev, hasMore: next !== null, summary: { total: 999 } })

beforeEach(() => {
  Object.assign(runtime.state, { slots: [], effectDeps: [], cleanups: [], index: 0, effectIndex: 0, pending: [] })
  api.call.mockReset()
  vi.stubGlobal('window', new EventTarget())
})
afterEach(() => vi.unstubAllGlobals())

describe('usePagedQuery — bounded renderer contract', () => {
  it('ignores a slow response for an older filter so it can never overwrite the current one', async () => {
    const slow = deferred<ReturnType<typeof page>>()
    const fast = deferred<ReturnType<typeof page>>()
    api.call.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
    let filters = { search: 'old' }
    const hook = mount(() => usePagedQuery<{ id: number }, { total: number }>('expenses', 'list', filters))
    filters = { search: 'new' }
    runtime.state.rerender()
    fast.resolve(page([2]))
    await flush()
    slow.resolve(page([1]))
    await flush()
    expect(hook.current().items).toEqual([{ id: 2 }])
    expect(api.call.mock.calls.map((args) => args[2])).toEqual([{ search: 'old' }, { search: 'new' }])
  })

  it('pages with server cursors, restarts on filter change, and returns to the first page without a cursor', async () => {
    api.call
      .mockResolvedValueOnce(page([10, 9], 'c1'))
      .mockResolvedValueOnce(page([8, 7], 'c2', 'p2'))
      .mockResolvedValueOnce(page([10, 9], 'c1'))
      .mockResolvedValueOnce(page([5]))
    let filters: Record<string, unknown> = { status: 'a' }
    const hook = mount(() => usePagedQuery<{ id: number }, { total: number }>('orders', 'list', filters, { limit: 2 }))
    await flush()
    expect(hook.current()).toMatchObject({ items: [{ id: 10 }, { id: 9 }], pageIndex: 0, hasNext: true, hasPrev: false, summary: { total: 999 } })
    await hook.current().next()
    expect(hook.current()).toMatchObject({ items: [{ id: 8 }, { id: 7 }], pageIndex: 1, hasPrev: true })
    expect(api.call).toHaveBeenLastCalledWith('orders', 'list', { status: 'a', limit: 2, cursor: 'c1' })
    await hook.current().prev()
    expect(api.call).toHaveBeenLastCalledWith('orders', 'list', { status: 'a', limit: 2 })
    expect(hook.current().pageIndex).toBe(0)
    filters = { status: 'b' }
    runtime.state.rerender()
    await flush()
    expect(api.call).toHaveBeenLastCalledWith('orders', 'list', { status: 'b', limit: 2 })
    expect(hook.current()).toMatchObject({ items: [{ id: 5 }], pageIndex: 0, hasNext: false })
  })

  it('appends load-more pages without duplicates and reload restarts from the first page', async () => {
    api.call
      .mockResolvedValueOnce(page([3, 2], 'c1'))
      .mockResolvedValueOnce(page([2, 1]))
      .mockResolvedValueOnce(page([4, 3], 'c9'))
    const hook = mount(() => usePagedQuery<{ id: number }, { total: number }>('workers', 'statement', { id: 1 }, { mode: 'append' }))
    await flush()
    await hook.current().next()
    expect(hook.current().items.map((row) => row.id)).toEqual([3, 2, 1])
    expect(hook.current().hasNext).toBe(false)
    await hook.current().reload()
    expect(api.call).toHaveBeenLastCalledWith('workers', 'statement', { id: 1 })
    expect(hook.current().items.map((row) => row.id)).toEqual([4, 3])
  })

  it('keeps showing a server error without inventing rows, and re-reads financial pages on refresh events', async () => {
    const { ApiError } = await import('@renderer/lib/api')
    api.call.mockRejectedValueOnce(new ApiError('مؤشر الصفحة غير صالح')).mockResolvedValue(page([1]))
    const hook = mount(() => usePagedQuery<{ id: number }, { total: number }>('profit', 'withdrawals', {}))
    await flush()
    expect(hook.current()).toMatchObject({ items: [], error: 'مؤشر الصفحة غير صالح' })
    window.dispatchEvent(new Event('profit-withdrawals-changed'))
    await flush()
    expect(hook.current()).toMatchObject({ items: [{ id: 1 }], error: undefined })
  })
})

describe('screens consume bounded data and server totals (source contracts)', () => {
  const read = (path: string) => readFileSync(`src/renderer/${path}`, 'utf8')

  it('Expenses totals come from main, never from reducing loaded rows', () => {
    const page = read('pages/expenses/ExpensesPage.tsx')
    expect(page).toContain('const linkedTotal = list.summary?.linkedMinor ?? 0')
    expect(page).toContain("useQuery<ExpenseSummary>('expenses', 'summary', { from: monthFrom, to: monthTo })")
    expect(page).toContain('monthSummary.data?.fixedNonSalaryMinor')
    expect(page).toContain('monthSummary.data?.variableMinor')
    expect(page).not.toMatch(/rows\.filter\([^)]*\)\.reduce/)
    expect(page).not.toContain("useQuery<Expense[]>('expenses', 'list'")
  })

  it('no growing-history screen requests OFFSET pages or unbounded limits', () => {
    for (const path of [
      'pages/orders/OrdersPage.tsx', 'pages/invoices/FinalInvoicesPage.tsx', 'pages/worksheets/WorkSheetsPage.tsx',
      'pages/uncollected/UncollectedProductsPage.tsx', 'pages/audit/AuditPage.tsx', 'pages/cash/CashPage.tsx',
      'pages/expenses/ExpensesPage.tsx', 'pages/purchases/PurchasesPage.tsx', 'pages/quotations/QuotationsPage.tsx',
      'pages/releases/ReleasesPage.tsx', 'pages/deliveries/DeliveriesPage.tsx', 'pages/inventory/InventoryPage.tsx',
      'pages/withdrawals/WithdrawalsPage.tsx', 'pages/customers/CustomersPage.tsx', 'pages/employees/EmployeesPage.tsx',
      'pages/workers/WorkersPage.tsx', 'pages/suppliers/SuppliersPage.tsx'
    ]) {
      const source = read(path)
      expect(source, path).toContain('usePagedQuery')
      expect(source, path).not.toMatch(/offset:/)
      expect(source, path).not.toMatch(/limit:\s*(300|500|1000)/)
    }
  })

  it('selectors search on the server instead of loading every customer/permit', () => {
    expect(read('pages/deliveries/DeliveriesPage.tsx')).toContain("awaitingCompletion: true, search: permitSearch || undefined")
    expect(read('pages/customers/CustomersPage.tsx')).not.toContain("'customers', 'balances'")
    expect(read('pages/suppliers/SuppliersPage.tsx')).toContain('payment.purchaseDocumentNumber')
  })
})
