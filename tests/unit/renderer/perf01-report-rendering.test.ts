import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const state = vi.hoisted(() => ({ report: {} as Record<string, unknown> }))
vi.mock('@renderer/lib/useQuery', () => ({
  useQuery: (_group: string, method: string) => ({
    loading: false,
    data:
      method === 'available'
        ? [{ key: 'sales', label: 'Fictional report', needsPeriod: false }]
        : state.report
  })
}))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: () => true }) }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: vi.fn() }) }))
import { ReportsPage } from '@renderer/pages/reports/ReportsPage'

// Real React server rendering of the actual page and DataTable, not a copied calculation.
// Interactive navigation/reset is covered by the compiled Electron regression harness.
describe('PERF-01 actual report page bounded initial presentation', () => {
  it.each([0, 1, 49, 50, 51, 10_034])(
    'bounds %i logical rows without changing the DTO, order, money, metadata or totals',
    (count) => {
      const rows = Array.from({ length: count }, (_, i) => ({
        identity: `fictional-${i}`,
        amount: `${i}.015 LYD`
      }))
      const dto = {
        title: 'Fictional full report',
        columns: ['identity', 'amount'],
        rows,
        period: { from: '2026-10-01', to: '2026-10-31' },
        totals: { 'FULL TOTAL': '987654.015 LYD' }
      }
      const snapshot = JSON.stringify(dto)
      for (const row of rows) Object.freeze(row)
      Object.freeze(rows)
      state.report = dto
      const html = renderToStaticMarkup(createElement(ReportsPage))
      const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? ''
      expect((body.match(/<tr\b/g) ?? []).length).toBe(Math.min(count, 50))
      expect(html).toContain('987654.015 LYD')
      expect(html).toContain('Fictional full report')
      expect(JSON.stringify(dto)).toBe(snapshot)
      expect(rows.length).toBe(count)
      for (let i = 0; i < Math.min(count, 50); i++) {
        expect(body).toContain(`fictional-${i}<`)
        expect(body).toContain(`${i}.015 LYD`)
        if (i)
          expect(body.indexOf(`fictional-${i - 1}<`)).toBeLessThan(body.indexOf(`fictional-${i}<`))
      }
      if (count > 50) expect(body).not.toContain('fictional-50<')
      if (!count) expect(html).toContain('لا توجد بيانات لهذا التقرير')
    }
  )
})
