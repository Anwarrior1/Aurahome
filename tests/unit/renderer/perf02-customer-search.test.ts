import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneElement, type ReactElement, type ReactNode } from 'react'

// Same dependency-tracked hook driver used by DB-10, with stable setters and
// batched effects. It executes the actual page, hook and API unwrap; only the
// transport responses and clock are controlled. No search algorithm is copied.
const runtime = vi.hoisted(() => {
  const r = {
    slots: [] as any[],
    deps: [] as any[],
    cleanups: [] as any[],
    pending: [] as any[],
    i: 0,
    e: 0,
    render: (() => {}) as () => void,
    alive: true,
    rendering: false,
    dirty: false
  }
  const same = (a: any[], b: any[]) =>
    a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  return {
    r,
    hooks: {
      useState(initial: any) {
        const i = r.i++
        if (!(i in r.slots)) {
          const slot: any = {
            value: typeof initial === 'function' ? initial() : initial,
            active: true
          }
          slot.set = (v: any) => {
            if (!r.alive || !slot.active) return
            const next = typeof v === 'function' ? v(slot.value) : v
            if (Object.is(next, slot.value)) return
            slot.value = next
            r.dirty = true
            if (!r.rendering) r.render()
          }
          r.slots[i] = slot
        }
        return [r.slots[i].value, r.slots[i].set]
      },
      useRef(initial: any) {
        const i = r.i++
        if (!(i in r.slots)) r.slots[i] = { current: initial }
        return r.slots[i]
      },
      useCallback(fn: any, deps: any[]) {
        const i = r.i++,
          old = r.slots[i]
        if (old && same(old.deps, deps)) return old.fn
        r.slots[i] = { fn, deps }
        return fn
      },
      useEffect(fn: any, deps: any[]) {
        const i = r.e++
        if (same(r.deps[i], deps)) return
        r.deps[i] = deps
        r.pending.push(() => {
          r.cleanups[i]?.()
          r.cleanups[i] = fn()
        })
      }
    }
  }
})
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...runtime.hooks,
  useLayoutEffect: runtime.hooks.useEffect
}))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: () => true }) }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
import { CustomersPage } from '@renderer/pages/customers/CustomersPage'

let renderHistory: ReactElement[] = []
let tree: ReactElement
const list = vi.fn()
const statement = vi.fn()
function elements(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const e = node as ReactElement<any>
  return [e, ...elements(e.props.children)]
}
function element(name: string) {
  return elements(tree).find((e) => typeof e.type === 'function' && e.type.name === name)!
}
function input() {
  return elements(tree).find((e) => e.props.placeholder === 'الاسم أو رقم الهاتف')!.props
}
function table() {
  return element('DataTable').props
}
function visible() {
  return table().loading ? [] : table().rows
}
function pager() {
  return element('Pager').props
}
function mount() {
  const { r } = runtime
  let queryKey: string | null = null
  function resolveQuery(node: ReactNode): ReactNode {
    if (Array.isArray(node)) return node.map(resolveQuery)
    if (!node || typeof node !== 'object' || !('props' in node)) return node
    const e = node as ReactElement<any>
    if (typeof e.type === 'function' && e.type.name === 'CustomerQuery') {
      if (e.key !== queryKey) {
        r.slots.splice(r.i).forEach((slot) => {
          if (slot) slot.active = false
        })
        r.deps.splice(r.e)
        r.cleanups.splice(r.e).forEach((fn) => fn?.())
        queryKey = e.key
      }
      return (e.type as (props: any) => ReactElement)(e.props)
    }
    return cloneElement(e, {}, resolveQuery(e.props.children))
  }
  r.render = () => {
    if (!r.alive || r.rendering) return
    r.rendering = true
    do {
      r.dirty = false
      r.i = 0
      r.e = 0
      tree = resolveQuery(CustomersPage()) as ReactElement
      renderHistory.push(tree)
      while (r.pending.length) r.pending.shift()!()
    } while (r.dirty)
    r.rendering = false
  }
  r.render()
}
function change(value: string) {
  input().onChange({ target: { value }, currentTarget: { value } })
}
const row = (name: string, id = 1) => ({
  id,
  name,
  phone: null,
  address: null,
  notes: null,
  active: true,
  hasHistory: true,
  orderCount: 2,
  totalMinor: 15000,
  paidMinor: 10000,
  remainingMinor: 5000
})
const page = (name: string, cursor: string | null = null) => ({
  ok: true,
  data: {
    items: [row(name)],
    summary: { totalCount: cursor ? 51 : 1 },
    nextCursor: cursor,
    prevCursor: null,
    hasMore: !!cursor
  }
})
function deferred() {
  let resolve!: (value: any) => void
  const promise = new Promise<any>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const flush = () => vi.advanceTimersByTimeAsync(0)
const settle = () => vi.advanceTimersByTimeAsync(300)

beforeEach(async () => {
  renderHistory = []
  vi.useFakeTimers()
  Object.assign(runtime.r, {
    slots: [],
    deps: [],
    cleanups: [],
    pending: [],
    i: 0,
    e: 0,
    alive: true,
    rendering: false,
    dirty: false
  })
  list.mockReset().mockImplementation((p) => Promise.resolve(page(p.search || 'default')))
  statement.mockReset().mockResolvedValue({
    ok: true,
    data: {
      customer: row('selected'),
      balance: { remainingMinor: 5000 },
      orders: { items: [], nextCursor: null, prevCursor: null },
      payments: { items: [], nextCursor: null, prevCursor: null },
      preliminaryInvoices: { items: [], nextCursor: null, prevCursor: null },
      approvedInvoices: { items: [], nextCursor: null, prevCursor: null }
    }
  })
  const window = new EventTarget() as any
  window.erp = { customers: { list, statement } }
  vi.stubGlobal('window', window)
  mount()
  await flush()
  list.mockClear()
})
afterEach(() => {
  runtime.r.cleanups.forEach((fn) => fn?.())
  runtime.r.alive = false
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('PERF-02 actual customer page and paged-query lifecycle', () => {
  it('RED-01 updates input immediately and issues only one final request for a 13-character burst', async () => {
    const term = 'NO-MATCH-PERF'
    for (let i = 1; i <= term.length; i++) {
      change(term.slice(0, i))
      expect(input().value).toBe(term.slice(0, i))
      await vi.advanceTimersByTimeAsync(5)
    }
    expect(list).toHaveBeenCalledTimes(0)
    await settle()
    expect(list.mock.calls.map(([p]) => p)).toEqual([{ search: term, state: 'active' }])
    expect(visible().map((r: any) => r.name)).toEqual([term])
  })
  it('RED-02 shows exactly the last query rather than intermediate results', async () => {
    change('first')
    change('final')
    await settle()
    expect(list.mock.calls.map(([p]) => p.search)).toEqual(['final'])
    expect(visible()).toEqual([row('final')])
  })
  it('RED-03 preserves the existing latest-request guard for reverse response order', async () => {
    const old = deferred(),
      latest = deferred()
    list.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    change('old')
    await settle()
    change('new')
    await settle()
    latest.resolve(page('new'))
    await flush()
    old.resolve(page('old'))
    await flush()
    expect(visible()).toEqual([row('new')])
  })
  it('RED-04 never presents an in-flight old response as current during pending input', async () => {
    const old = deferred()
    list.mockReturnValueOnce(old.promise)
    change('old')
    await settle()
    list.mockClear()
    change('new')
    expect(input().value).toBe('new')
    expect(list).toHaveBeenCalledTimes(0)
    old.resolve(page('old'))
    await flush()
    expect(visible()).toEqual([])
    expect(table().loading).toBe(true)
    await settle()
    expect(list.mock.calls.map(([p]) => p.search)).toEqual(['new'])
    expect(visible()).toEqual([row('new')])
  })
  it('RED-05 suppresses obsolete rows and disables paging throughout pending debounce', async () => {
    list.mockResolvedValueOnce(page('old', 'next-old'))
    change('old')
    await settle()
    expect(visible()).toEqual([row('old')])
    change('new')
    expect(visible()).toEqual([])
    expect(pager().loading).toBe(true)
    expect(
      elements(element('PageHeader').props.title).some(
        (e) => typeof e.type === 'function' && e.type.name === 'CustomerCountBadge'
      )
    ).toBe(false)
    await settle()
    expect(visible()).toEqual([row('new')])
  })
  it('never renders old rows under the newly settled input before query effects reset state', async () => {
    change('old')
    await settle()
    renderHistory = []
    change('new')
    await settle()
    for (const render of renderHistory) {
      const nodes = elements(render),
        search = nodes.find((e) => e.props.placeholder === 'الاسم أو رقم الهاتف')!.props
      const table = nodes.find(
        (e) => typeof e.type === 'function' && e.type.name === 'DataTable'
      )!.props
      if (search.value === 'new' && !table.loading) expect(table.rows).toEqual([row('new')])
    }
  })
  it('RED-06 clears immediately and cancels a pending filtered request', async () => {
    change('filtered')
    await settle()
    list.mockClear()
    change('pending')
    change('')
    await flush()
    expect(input().value).toBe('')
    expect(list.mock.calls.map(([p]) => p)).toEqual([{ search: '', state: 'active' }])
    expect(visible()).toEqual([row('default')])
    await settle()
    expect(list).toHaveBeenCalledTimes(1)
  })
  it('keeps whitespace-only default-list resets and clears a later default page immediately', async () => {
    change('filtered')
    await settle()
    list.mockResolvedValueOnce(page('default', 'next'))
    change('   ')
    await flush()
    expect(list).toHaveBeenLastCalledWith({ search: '   ', state: 'active' })
    pager().onNext()
    await flush()
    expect(pager().pageIndex).toBe(1)
    list.mockClear()
    change('')
    await flush()
    expect(list.mock.calls.map(([p]) => p)).toEqual([{ search: '', state: 'active' }])
    expect(pager().pageIndex).toBe(0)
  })
  it('RED-07 preserves cursor navigation and resets it when the settled search changes', async () => {
    list.mockResolvedValueOnce(page('one', 'next'))
    change('needle')
    await settle()
    list.mockResolvedValueOnce(page('two'))
    pager().onNext()
    await flush()
    expect(list).toHaveBeenLastCalledWith({ search: 'needle', state: 'active', cursor: 'next' })
    expect(pager().pageIndex).toBe(1)
    change('new')
    await settle()
    expect(list).toHaveBeenLastCalledWith({ search: 'new', state: 'active' })
    expect(pager().pageIndex).toBe(0)
  })
  it('RED-07 keeps lifecycle filtering and financial row values unchanged', async () => {
    element('Select').props.onChange({ target: { value: 'archived' } })
    await flush()
    expect(list).toHaveBeenLastCalledWith({ search: '', state: 'archived' })
    change('needle')
    await settle()
    expect(list).toHaveBeenLastCalledWith({ search: 'needle', state: 'archived' })
    expect(visible()).toEqual([row('needle')])
    expect(table().rowKey(row('needle', 7))).toBe(7)
  })
  it('RED-07 selects history by the actual customer identity', async () => {
    const customer = table().rows[0]
    const actions = table().columns.at(-1).render(customer)
    const eye = elements(actions).find((e) => e.props['aria-label'] === 'سجل العميل')!
    eye.props.onClick()
    await flush()
    expect(statement.mock.calls.every(([p]) => p.id === customer.id)).toBe(true)
    expect(statement).toHaveBeenCalledTimes(4)
  })
  it('RED-08 has no Enter submission or search button to redefine', () => {
    expect(input().onKeyDown).toBeUndefined()
    expect(input().onKeyUp).toBeUndefined()
    expect(elements(tree).filter((e) => e.type === 'button' && e.props.type === 'submit')).toEqual(
      []
    )
  })
  it('RED-09 does not search intermediate composition text and preserves committed Arabic', async () => {
    input().onCompositionStart?.()
    change('ع')
    await settle()
    change('عم')
    await settle()
    expect(input().value).toBe('عم')
    expect(list).toHaveBeenCalledTimes(0)
    input().onCompositionEnd?.({ currentTarget: { value: 'عميل' } })
    await settle()
    expect(input().value).toBe('عميل')
    expect(list.mock.calls.map(([p]) => p.search)).toEqual(['عميل'])
    expect(visible()).toEqual([row('عميل')])
  })
  it('RED-10 deduplicates only existing trim-equivalent terms without changing input text', async () => {
    change('ab')
    await settle()
    list.mockClear()
    change(' ab ')
    await settle()
    expect(input().value).toBe(' ab ')
    expect(list).toHaveBeenCalledTimes(0)
    expect(visible()).toEqual([row('ab')])
    change('a b')
    await settle()
    expect(list).toHaveBeenLastCalledWith({ search: 'a b', state: 'active' })
  })
  it.each([' '.repeat(201), ' ' + 'a'.repeat(200)])(
    'preserves raw over-limit validation even when trimming would disguise it',
    async (value) => {
      list.mockResolvedValueOnce({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'نص البحث أطول من الحد المسموح' }
      })
      change(value)
      await settle()
      expect(list).toHaveBeenLastCalledWith({ search: value, state: 'active' })
      expect(element('ErrorNote').props.children).toBe('نص البحث أطول من الحد المسموح')
      expect(visible()).toEqual([])
    }
  )
  it('RED-11 cancels the timer on unmount and drops late responses like React does', async () => {
    change('pending')
    runtime.r.cleanups.forEach((fn) => fn?.())
    runtime.r.alive = false
    await settle()
    expect(list).toHaveBeenCalledTimes(0)
  })
  it('preserves request errors without stale rows or invented data', async () => {
    list.mockResolvedValueOnce({ ok: false, error: { code: 'FORBIDDEN', message: 'غير مسموح' } })
    change('denied')
    await settle()
    expect(visible()).toEqual([])
    expect(element('ErrorNote').props.children).toBe('غير مسموح')
  })
  it('restores an unchanged settled query without a duplicate when pending input is reverted', async () => {
    change('ab')
    await settle()
    list.mockClear()
    change('temporary')
    change('ab')
    await settle()
    expect(list).toHaveBeenCalledTimes(0)
    expect(visible()).toEqual([row('ab')])
  })
})
