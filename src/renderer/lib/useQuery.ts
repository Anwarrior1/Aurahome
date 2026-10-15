import { useCallback, useEffect, useState } from 'react'
import { call, ApiError } from './api'

/**
 * Minimal data-loading hook. Deliberately small: this ERP runs against
 * a local SQLite file, so there is no network latency to smooth over
 * and no cache-invalidation machinery worth the complexity.
 */
export function useQuery<T>(
  group: keyof Window['erp'],
  method: string,
  payload?: unknown,
  options: { enabled?: boolean } = {}
) {
  const enabled = options.enabled ?? true
  const key = JSON.stringify(payload ?? null)
  const [data, setData] = useState<T | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(enabled)

  const reload = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError(undefined)
    try {
      setData(await call<T>(group, method, payload ? JSON.parse(key) : undefined))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'حدث خطأ غير متوقع')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, method, key, enabled])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!['colors', 'materials', 'categories'].includes(group)) return
    const refresh = () => { void reload() }
    window.addEventListener('catalog-changed', refresh)
    return () => window.removeEventListener('catalog-changed', refresh)
  }, [group, reload])

  useEffect(() => {
    if (!enabled || !['profit', 'dashboard', 'cash'].includes(group)) return
    const refresh = () => { void reload() }
    window.addEventListener('profit-withdrawals-changed', refresh)
    return () => window.removeEventListener('profit-withdrawals-changed', refresh)
  }, [group, enabled, reload])

  useEffect(() => {
    const financialReport = group === 'reports' && method === 'build' &&
      ['expenses', 'monthly_profit'].includes((JSON.parse(key) as { key?: string } | null)?.key ?? '')
    if (!enabled || (!['expenses', 'cash', 'profit', 'dashboard'].includes(group) && !financialReport)) return
    const refresh = () => { void reload() }
    window.addEventListener('recurring-expense-reversed', refresh)
    return () => window.removeEventListener('recurring-expense-reversed', refresh)
  }, [group, method, key, enabled, reload])

  useEffect(() => {
    if (!enabled || group !== 'customers' || method !== 'list') return
    const refresh = () => { void reload() }
    window.addEventListener('customer-lifecycle-changed', refresh)
    return () => window.removeEventListener('customer-lifecycle-changed', refresh)
  }, [group, method, enabled, reload])

  return { data, error, loading, reload }
}
