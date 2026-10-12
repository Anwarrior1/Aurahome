import { useCallback, useEffect, useRef, useState } from 'react'
import type { CursorPage } from '@shared/pagination/cursor-page'
import { call, ApiError } from './api'

interface PagedState<T, S, R> {
  /** The latest full response (header fields of a statement-style endpoint). */
  response: R | undefined
  items: T[]
  summary: S | undefined
  nextCursor: string | null
  prevCursor: string | null
  /** Cursor that produced the currently shown page (undefined = first page). */
  cursor: string | undefined
  pageIndex: number
}

function initialState<T, S, R>(): PagedState<T, S, R> {
  return { response: undefined, items: [], summary: undefined, nextCursor: null, prevCursor: null, cursor: undefined, pageIndex: 0 }
}

/**
 * Loads one server-bounded page of a DB-10 cursor endpoint.
 *
 * - `pages` mode replaces the rows (previous/next navigation);
 *   `append` mode accumulates "load more" pages without duplicates.
 * - Any filter change restarts traversal from the first page.
 * - Only the newest request may update state, so a slow response for an
 *   older filter can never overwrite the current one.
 * - Totals always come from the server `summary`, never from loaded rows.
 */
export function usePagedQuery<T, S = undefined, R = CursorPage<T, S>>(
  group: keyof Window['erp'],
  method: string,
  filters: Record<string, unknown> | undefined,
  options: {
    mode?: 'pages' | 'append'
    limit?: number
    enabled?: boolean
    rowKey?: (row: T) => string | number
    /** Selects the page from a response that nests it (statements). */
    pageOf?: (response: R) => CursorPage<T, S>
  } = {}
) {
  const mode = options.mode ?? 'pages'
  const enabled = options.enabled ?? true
  const limit = options.limit
  const key = JSON.stringify(filters ?? {})
  const rowKeyRef = useRef(options.rowKey)
  rowKeyRef.current = options.rowKey
  const pageOfRef = useRef(options.pageOf)
  pageOfRef.current = options.pageOf
  const sequence = useRef(0)
  const [state, setState] = useState<PagedState<T, S, R>>(initialState)
  const stateRef = useRef(state)
  stateRef.current = state
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(enabled)

  const load = useCallback(
    async (cursor: string | undefined, how: 'replace' | 'append', pageIndex: number) => {
      const requestId = ++sequence.current
      setLoading(true)
      setError(undefined)
      try {
        const response = await call<R>(group, method, {
          ...(JSON.parse(key) as Record<string, unknown>),
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {})
        })
        if (requestId !== sequence.current) return
        const page = pageOfRef.current ? pageOfRef.current(response) : (response as unknown as CursorPage<T, S>)
        setState((previous) => {
          if (how === 'append') {
            const keyOf = rowKeyRef.current ?? ((row: T) => (row as { id: number }).id)
            const seen = new Set(previous.items.map(keyOf))
            return {
              response,
              items: [...previous.items, ...page.items.filter((row) => !seen.has(keyOf(row)))],
              summary: page.summary,
              nextCursor: page.nextCursor,
              prevCursor: previous.prevCursor,
              cursor: previous.cursor,
              pageIndex
            }
          }
          return {
            response,
            items: page.items,
            summary: page.summary,
            nextCursor: page.nextCursor,
            prevCursor: page.prevCursor,
            cursor,
            pageIndex
          }
        })
      } catch (err) {
        if (requestId !== sequence.current) return
        setError(err instanceof ApiError ? err.message : 'حدث خطأ غير متوقع')
      } finally {
        if (requestId === sequence.current) setLoading(false)
      }
    },
    [group, method, key, limit]
  )

  useEffect(() => {
    if (!enabled) {
      sequence.current += 1
      setState(initialState())
      setLoading(false)
      return
    }
    setState(initialState())
    void load(undefined, 'replace', 0)
  }, [load, enabled])

  /** Re-reads what is shown: the current page, or the first page for load-more lists. */
  const reload = useCallback(async () => {
    if (!enabled) return
    const current = stateRef.current
    if (mode === 'append' || !current.cursor) return load(undefined, 'replace', 0)
    return load(current.cursor, 'replace', current.pageIndex)
  }, [enabled, load, mode])

  const next = useCallback(async () => {
    const current = stateRef.current
    if (!current.nextCursor) return
    return load(current.nextCursor, mode === 'append' ? 'append' : 'replace', current.pageIndex + 1)
  }, [load, mode])

  const prev = useCallback(async () => {
    const current = stateRef.current
    if (mode === 'append' || !current.prevCursor) return
    return current.pageIndex <= 1
      ? load(undefined, 'replace', 0)
      : load(current.prevCursor, 'replace', current.pageIndex - 1)
  }, [load, mode])

  useEffect(() => {
    if (!enabled || !['profit', 'dashboard', 'cash'].includes(group)) return
    const refresh = () => { void reload() }
    window.addEventListener('profit-withdrawals-changed', refresh)
    return () => window.removeEventListener('profit-withdrawals-changed', refresh)
  }, [group, enabled, reload])

  useEffect(() => {
    if (!enabled || !['expenses', 'cash', 'profit', 'dashboard'].includes(group)) return
    const refresh = () => { void reload() }
    window.addEventListener('recurring-expense-reversed', refresh)
    return () => window.removeEventListener('recurring-expense-reversed', refresh)
  }, [group, enabled, reload])

  useEffect(() => {
    if (!enabled || group !== 'customers' || method !== 'list') return
    const refresh = () => { void reload() }
    window.addEventListener('customer-lifecycle-changed', refresh)
    return () => window.removeEventListener('customer-lifecycle-changed', refresh)
  }, [group, method, enabled, reload])

  return {
    response: state.response,
    items: state.items,
    summary: state.summary,
    loading,
    error,
    pageIndex: state.pageIndex,
    hasNext: Boolean(state.nextCursor),
    hasPrev: mode === 'pages' && state.pageIndex > 0,
    next,
    prev,
    reload
  }
}

export type PagedQuery<T, S = undefined, R = CursorPage<T, S>> = ReturnType<typeof usePagedQuery<T, S, R>>
