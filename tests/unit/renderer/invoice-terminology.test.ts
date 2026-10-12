import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')

/**
 * Terminology-only pass:
 *   الفواتير الأولية / الفاتورة الأولية → الفواتير المبدئية / الفاتورة المبدئية
 *   الفواتير النهائية / الفاتورة النهائية → الفواتير المعتمدة / الفاتورة المعتمدة
 *
 * No route, permission, icon, table, service, or workflow rule changes
 * — only the Arabic label a person reads.
 */
describe('preliminary/final invoice terminology (UI)', () => {
  it('sidebar shows the new sales-section labels', () => {
    const nav = read('src/renderer/routes/nav.ts')
    expect(nav).toContain("label: 'الفواتير المبدئية'")
    expect(nav).toContain("label: 'الفواتير المعتمدة'")
    // The old labels are gone, but the routes/permissions/icons behind
    // them are untouched.
    expect(nav).not.toContain("label: 'الفواتير الأولية'")
    expect(nav).not.toContain("label: 'الفواتير النهائية'")
    expect(nav).toContain("path: '/quotations'")
    expect(nav).toContain("icon: 'quotations'")
    expect(nav).toContain('permission: P.quotations.view')
    expect(nav).toContain("path: '/final-invoices'")
    expect(nav).toContain("icon: 'finalInvoices'")
  })

  it('the preliminary invoice list page uses the new page title and empty state', () => {
    const page = read('src/renderer/pages/quotations/QuotationsPage.tsx')
    expect(page).toContain('الفواتير المبدئية')
    expect(page).toContain('لا توجد فواتير مبدئية')
    expect(page).not.toContain('الفواتير الأولية')
    expect(page).not.toContain('فواتير أولية')
    // The route/component/IPC group name are internal and untouched.
    expect(page).toContain("'quotations'")
  })

  it('the final invoice list page uses the new page title and empty state', () => {
    const page = read('src/renderer/pages/invoices/FinalInvoicesPage.tsx')
    expect(page).toContain('title="الفواتير المعتمدة"')
    expect(page).toContain('لا توجد فواتير معتمدة')
    expect(page).not.toContain('الفواتير النهائية')
    expect(page).not.toContain('فواتير نهائية')
    expect(page).toContain("'finalInvoices'")
  })

  it('order/production/delivery screens reference the renamed final invoice consistently', () => {
    for (const path of [
      'src/renderer/pages/orders/OrdersPage.tsx',
      'src/renderer/pages/orders/OrderDetailPage.tsx',
      'src/renderer/pages/deliveries/DeliveriesPage.tsx'
    ]) {
      const source = read(path)
      expect(source).not.toContain('الفاتورة النهائية')
      expect(source).not.toContain('فاتورة نهائية')
    }
  })

  it('no stale old-terminology label remains anywhere in the renderer, main services or docs', () => {
    const suspects = [
      'src/renderer/pages/settings/SettingsPage.tsx',
      'src/renderer/pages/products/ProductsPage.tsx',
      'src/renderer/pages/worksheets/ProductionOrderPage.tsx',
      'src/renderer/pages/users/UsersPage.tsx',
      'src/main/services/sales/quotations.service.ts',
      'src/main/services/sales/orders.service.ts',
      'src/main/services/sales/final-invoices.service.ts',
      'src/main/services/planning/planning.service.ts',
      'src/main/reports/templates/documents.template.ts'
    ]
    for (const path of suspects) {
      const source = read(path)
      for (const stale of ['الفاتورة الأولية', 'الفواتير الأولية', 'فاتورة أولية', 'فواتير أولية', 'الفاتورة النهائية', 'الفواتير النهائية', 'فاتورة نهائية', 'فواتير نهائية']) {
        expect(source, `${path} still contains "${stale}"`).not.toContain(stale)
      }
    }
  })

  it('the printed document templates use the new terminology in their titles', () => {
    const templates = read('src/main/reports/templates/documents.template.ts')
    expect(templates).toContain('فاتورة مبدئية')
    expect(templates).toContain('فاتورة معتمدة')
    expect(templates).not.toContain('فاتورة أولية')
    expect(templates).not.toContain('فاتورة نهائية')
    // The preliminary invoice heading is exactly "فاتورة مبدئية" — no
    // "/ عرض سعر" suffix.
    expect(templates).not.toContain('عرض سعر')
    // Internal technical identifiers (kind strings, DTO/type names,
    // document-number prefixes) are explicitly out of scope and stay.
    expect(templates).toContain('renderPreliminaryInvoice')
    expect(templates).toContain('renderFinalInvoice')
  })
})
