import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CustomerCountBadge } from '@renderer/pages/customers/CustomersPage'

const customersPage = readFileSync('src/renderer/pages/customers/CustomersPage.tsx', 'utf8')
const orderPage = readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')
const ui = readFileSync('src/renderer/components/ui/index.tsx', 'utf8')
const css = readFileSync('src/renderer/styles/global.css', 'utf8')
const tokens = readFileSync('src/renderer/theme/tokens.css', 'utf8')
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> }

describe('Customer Change 05 — Customers title badge', () => {
  it.each([0, 7, 120, 1250])('renders %i as a separate accessible badge', (count) => {
    const html = renderToStaticMarkup(createElement(CustomerCountBadge, { count }))
    expect(html).toContain('class="customer-count-badge"')
    expect(html).toContain(`aria-label="عدد العملاء المطابقين: ${count}"`)
    expect(html).toContain(`>${count}</span>`)
  })

  it('uses the server summary beside the unchanged title, never current-page length', () => {
    expect(customersPage).toContain("usePagedQuery<Customer, { totalCount: number }>('customers', 'list', { search, state })")
    expect(customersPage).toContain('<span>العملاء</span>')
    expect(customersPage).toContain('<CustomerCountBadge count={list.summary?.totalCount ?? 0} />')
    expect(customersPage).not.toMatch(/CustomerCountBadge count=\{list\.items\.length\}/)
    expect(customersPage).not.toMatch(/العملاء\s*\([^)]*\)/)
    expect(ui).toContain('title: ReactNode')
  })

  it('uses token-integrated liquid glass styling with light/dark paths and no dependency', () => {
    expect(css).toContain('.customer-count-badge')
    expect(css).toContain("@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))")
    expect(css).toContain('backdrop-filter: blur(')
    expect(css).toContain(":root[data-theme='dark'] .customer-count-badge")
    expect(css).toContain('var(--text-primary)')
    expect(css).toContain('var(--border-default)')
    expect(tokens).toContain(":root[data-theme='dark']")
    expect(Object.keys(pkg.dependencies).some((name) => /glass|blur/i.test(name))).toBe(false)
  })
})

describe('Customer Change 05 — Order Details presentation only', () => {
  it('removes actual cost/profit UI and preserves the estimated card', () => {
    expect(orderPage).not.toContain('التكلفة والربح الفعلي')
    expect(orderPage).not.toContain("useQuery<ActualCosting>('orders', 'costing'")
    expect(orderPage).not.toContain('actualCosting.reload()')
    expect(orderPage).toContain('التكلفة التقديرية والربح المتوقع')
    expect(orderPage).toContain('إجمالي التكلفة التقديرية')
    expect(orderPage).toContain('الربح المتوقع')
  })

  it('leaves the authoritative backend costing and reporting surfaces in place', () => {
    const router = readFileSync('src/main/ipc/router.ts', 'utf8')
    const costing = readFileSync('src/main/services/costing/costing.service.ts', 'utf8')
    const reports = readFileSync('src/main/services/reports/reports.service.ts', 'utf8')
    expect(router).toContain('IPC_CHANNELS.orders.costing')
    expect(costing).toContain('orderCostBreakdown')
    expect(costing).toContain('totalActualCostMinor')
    expect(costing).toContain('actualProfitMinor')
    expect(reports).toContain('orderProfitabilityReport')
  })
})
