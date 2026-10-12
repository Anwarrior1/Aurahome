import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')
const finalInvoices = read('src/renderer/pages/invoices/FinalInvoicesPage.tsx')
const quotations = read('src/renderer/pages/quotations/QuotationsPage.tsx')
const customers = read('src/renderer/pages/customers/CustomersPage.tsx')
const roleEditor = read('src/renderer/pages/users/UsersPage.tsx')
const orderDetail = read('src/renderer/pages/orders/OrderDetailPage.tsx')
const nav = read('src/renderer/routes/nav.ts')
const router = read('src/renderer/routes/router.tsx')

/**
 * The renderer half of the commercial-document RBAC pass. Hiding a
 * control is never the enforcement (that lives in main — see
 * tests/ipc/rbac-commercial-documents.test.ts); these pins make sure
 * the UI asks the SAME question main answers, so a user is not shown a
 * button that will only fail.
 */
describe('Approved Invoice page asks for the precise permissions', () => {
  it('create/edit, approve and delete are three different questions', () => {
    expect(finalInvoices).toContain('can(P.finalInvoices.manage)')
    expect(finalInvoices).toContain('can(P.finalInvoices.approve)')
    expect(finalInvoices).toContain('can(P.finalInvoices.remove)')
    // the Customer Order's own edit permission no longer stands in for
    // any of them
    expect(finalInvoices).not.toContain('can(P.orders.manage)')
  })

  it('the approve button is gated on approval alone', () => {
    const approveBlock = finalInvoices.slice(
      finalInvoices.indexOf("can(P.finalInvoices.approve)"),
      finalInvoices.indexOf("can(P.finalInvoices.approve)") + 320
    )
    expect(approveBlock).toContain('اعتماد وإنشاء طلب')
  })

  it('the company-wide summaries render only when main actually sent them', () => {
    // Not `can(...)` in the renderer: the values are absent from the
    // DTO entirely for an unauthorised session, so their presence IS
    // the authorisation.
    expect(finalInvoices).toContain('totalBilled !== undefined')
    expect(finalInvoices).toContain('totalOutstanding !== undefined')
    expect(finalInvoices).toContain('list.summary?.totalApprovedMinor')
    expect(finalInvoices).toContain('list.summary?.totalOutstandingMinor')
    // and they are no longer re-derived client-side from the rows
    expect(finalInvoices).not.toContain('approved.reduce')
  })

  it('the receivable columns disappear rather than render empty when redacted', () => {
    expect(finalInvoices).toContain('canSeeReceivables')
    expect(finalInvoices).toMatch(/\.\.\.\(canSeeReceivables\s*\n?\s*\?\s*\[/)
  })
})

describe('Preliminary Invoice page reflects that it approves nothing', () => {
  it('uses the issue permission, and a delete key separate from editing', () => {
    expect(quotations).toContain('can(P.quotations.issue)')
    expect(quotations).toContain('can(P.quotations.remove)')
    expect(quotations).not.toContain('P.quotations.approve')
  })

  it('the issue control still says "إصدار للعميل", never "اعتماد"', () => {
    const issueBlock = quotations.slice(
      quotations.indexOf('can(P.quotations.issue)'),
      quotations.indexOf('can(P.quotations.issue)') + 300
    )
    expect(issueBlock).toContain('إصدار للعميل')
    expect(issueBlock).not.toContain('اعتماد')
  })
})

describe('Customers page separates archiving from editing', () => {
  it('editing and archiving ask their own permission, and nothing asks for a delete key that no longer exists', () => {
    expect(customers).toContain('can(P.customers.manage)')
    expect(customers).toContain('can(P.customers.archive)')
    expect(customers).not.toContain('customers.fullDelete')
  })

  it('no permanent-delete workflow was introduced — the only removal is the pre-existing history-free cleanup', () => {
    // It stays behind `manage` and behind `!row.hasHistory`, exactly as
    // it was before the permission pass; no new button, no new channel.
    expect(customers).toContain('can(P.customers.manage) && !row.hasHistory')
    expect(customers.match(/openAction\(row, 'remove'\)/g)).toHaveLength(1)
  })
})

describe('Production Preparation asks for its own permissions on the Customer Order page', () => {
  it('the section is shown on its view permission, not on a cost-visibility key', () => {
    expect(orderDetail).toContain('can(P.productionPrep.view) && (')
    // it used to be gated on the ESTIMATED-COST key, which conflated
    // "may open this section" with "may see money"
    expect(orderDetail).not.toContain('{can(P.orders.viewEstimatedCost) && (\n        <Card')
  })

  it('the snapshot is only requested when the section may be seen', () => {
    expect(orderDetail).toContain("'planningSnapshot', { id: orderId }, { enabled: can(P.productionPrep.view) }")
  })

  it('editing inside the section needs the manage permission, not order editing', () => {
    expect(orderDetail).toContain('const configEditable = can(P.productionPrep.manage)')
  })

  it('the cost/profit card keeps its own independent permissions', () => {
    expect(orderDetail).toContain('can(P.orders.viewEstimatedCost) || can(P.orders.viewExpectedProfit)')
  })
})

describe('BUG FIX — Approved Invoices sidebar/route used the wrong permission', () => {
  it('the sidebar entry is gated on finalInvoices.view, not orders.view', () => {
    // The exact reported bug: a user holding "عرض الفواتير المعتمدة"
    // never saw "الفواتير المعتمدة" in the sidebar, because the nav
    // item still checked the Customer Order's own view permission —
    // a leftover from before Approved Invoices had a permission
    // identity of its own.
    const item = nav.slice(nav.indexOf("path: '/final-invoices'") - 20, nav.indexOf("path: '/final-invoices'") + 160)
    expect(item).toContain('permission: P.finalInvoices.view')
    expect(item).not.toContain('permission: P.orders.view')
  })

  it('the route guard is gated on the same permission as the sidebar entry', () => {
    const route = router.slice(router.indexOf("path=\"/final-invoices\""), router.indexOf("path=\"/final-invoices\"") + 120)
    expect(route).toContain('protect(P.finalInvoices.view,')
    expect(route).not.toContain('protect(P.orders.view, <FinalInvoicesPage')
  })

  it('طلبات العملاء keeps its own, separate permission — unaffected by this fix', () => {
    const ordersItem = nav.slice(nav.indexOf("path: '/orders'"), nav.indexOf("path: '/orders'") + 100)
    expect(ordersItem).toContain('permission: P.orders.view')
    const ordersRoute = router.slice(router.indexOf('path="/orders"'), router.indexOf('path="/orders"') + 80)
    expect(ordersRoute).toContain('protect(P.orders.view,')
  })

  it('الفواتير المبدئية keeps its own permission — unaffected by this fix', () => {
    const item = nav.slice(nav.indexOf("path: '/quotations'"), nav.indexOf("path: '/quotations'") + 110)
    expect(item).toContain('permission: P.quotations.view')
  })
})

describe('the role editor stays fully dynamic', () => {
  it('renders groups, counts and Select All from the permission catalog itself', () => {
    // Nothing is hardcoded: sections come from PERMISSION_SECTIONS and
    // the rows from the IPC-delivered catalog, so new keys and the
    // corrected grouping appear with correct counters automatically.
    expect(roleEditor).toContain('PERMISSION_SECTIONS.map')
    expect(roleEditor).toContain("useQuery<Permission[]>('admin', 'permissions')")
    expect(roleEditor).toContain('bySection.set(permission.section')
    expect(roleEditor).toContain('{selectedCount}/{items.length}')
    expect(roleEditor).toContain('setSectionPermissions(section.key, true)')
    expect(roleEditor).toContain('setSectionPermissions(section.key, false)')
    // sensitive rows keep their marker
    expect(roleEditor).toContain('{permission.sensitive && <Badge tone="warning">حساسة</Badge>}')
    // an empty group is not drawn at all
    expect(roleEditor).toContain('if (!items.length) return null')
  })
})
