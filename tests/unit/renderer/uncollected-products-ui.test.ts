import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')
const orderDetail = read('src/renderer/pages/orders/OrderDetailPage.tsx')
const page = read('src/renderer/pages/uncollected/UncollectedProductsPage.tsx')
const invoices = read('src/renderer/pages/invoices/FinalInvoicesPage.tsx')
const nav = read('src/renderer/routes/nav.ts')
const router = read('src/renderer/routes/router.tsx')
const documents = read('src/main/reports/templates/documents.template.ts')
const workSheets = read('src/renderer/pages/worksheets/WorkSheetsPage.tsx')

/**
 * The renderer half of "المنتجات غير المستلمة". Enforcement is in main
 * (tests/ipc/rbac-uncollected-products.test.ts); these pins make sure
 * the UI asks the same questions main answers, and that no second
 * cancellation path was introduced alongside the existing one.
 */
describe('1. the existing cancellation action stays the only one', () => {
  it('there is still exactly one "إلغاء الطلب" control, opening the same dialog and calling the same channel', () => {
    expect(orderDetail.match(/>إلغاء الطلب</g)).toHaveLength(1)
    expect(orderDetail.match(/openDialog\('cancel'/g)).toHaveLength(1)
    expect(orderDetail.match(/call\('orders', 'cancel'/g)).toHaveLength(1)
    // The same confirmation dialog, with the same mandatory reason.
    expect(orderDetail).toContain("dialog === 'cancel'")
    expect(orderDetail).toContain('<Field label="سبب الإلغاء" required>')
  })

  it('no transfer, archive or restore action was added anywhere near it', () => {
    expect(orderDetail).not.toContain("'transferToUncollected'")
    expect(orderDetail).not.toContain("call('uncollectedProducts', 'transfer'")
    // The page only ever READS the products a cancellation produced.
    expect(orderDetail.match(/'uncollectedProducts',\s*\n?\s*'[a-zA-Z]+'/g)).toEqual([
      "'uncollectedProducts',\n    'forOrder'"
    ])
  })

  it('the cancelled order links to what it physically left behind', () => {
    expect(orderDetail).toContain('تم تحويل المنتج إلى المنتجات غير المستلمة')
    // Gated on the view permission AND on the order actually being
    // cancelled, read from the DTO so the hook runs before the page's
    // early returns.
    expect(orderDetail).toContain('can(P.uncollectedProducts.view) && detail.data?.order?.status === \'cancelled\'')
  })
})

describe('the page is gated, bounded and cost-aware', () => {
  it('the sidebar entry and the route ask the same permission', () => {
    const item = nav.slice(nav.indexOf("path: '/uncollected-products'"), nav.indexOf("path: '/uncollected-products'") + 170)
    expect(item).toContain('permission: P.uncollectedProducts.view')
    expect(item).toContain('المنتجات غير المستلمة')
    const route = router.slice(router.indexOf('path="/uncollected-products"'), router.indexOf('path="/uncollected-products"') + 130)
    expect(route).toContain('protect(P.uncollectedProducts.view,')
  })

  it('it pages through the server rather than loading the whole history', () => {
    expect(page).toContain('{ limit: pageSize }')
    expect(page).not.toContain('offset')
    expect(page).toContain('list.summary?.totalCount')
    // never an unbounded request
    expect(page).not.toMatch(/limit:\s*(0|undefined|1000000)/)
  })

  it('the two statuses are named exactly as specified', () => {
    expect(page).toContain("available: { label: 'متاح للبيع'")
    expect(page).toContain("sold: { label: 'تم البيع'")
  })

  it('cost columns are built from what main sent, gated on the cost permission', () => {
    expect(page).toContain('can(P.uncollectedProducts.viewCost)')
    expect(page).toMatch(/\.\.\.\(showCost\s*\n?\s*\?\s*\[/)
    expect(page).toContain('{showCost && (')
  })
})

describe('Manufacturing Order operational history boundary', () => {
  it('uses the bounded operational endpoint while cancelled-order detail keeps the historical endpoint', () => {
    expect(workSheets).toContain("'production', 'listOperationalWorkSheets'")
    expect(workSheets).toContain('{ limit: pageSize }')
    expect(workSheets).not.toContain('offset')
    expect(workSheets).toContain('list.summary?.totalCount')
    expect(orderDetail).toContain("'production', 'listWorkSheets', { orderId, includeReversed: true }, { mode: 'append', limit: 100 }")
  })
})

describe('resale reuses the Approved Invoice item architecture', () => {
  it('the picker is on the existing invoice line, gated on the sell permission', () => {
    expect(invoices).toContain('can(P.uncollectedProducts.sell)')
    expect(invoices).toContain("'uncollectedProducts',\n    'available'")
    expect(invoices).toContain('uncollectedProductId: line.uncollectedProductId ? Number(line.uncollectedProductId) : null')
    // no parallel sales screen
    expect(invoices).not.toContain("call('uncollectedProducts', 'sell'")
  })

  it('picking one fills the specification but never the price', () => {
    const block = invoices.slice(invoices.indexOf('بيع منتج جاهز'), invoices.indexOf('بيع منتج جاهز') + 900)
    expect(block).toContain('specifications: picked.specifications')
    expect(block).toContain('dimensions: picked.dimensions')
    expect(block).not.toContain('unitPrice: picked')
  })
})

describe('26. customer documents carry no internal cost', () => {
  it('the document template has no notion of an uncollected product or its cost basis', () => {
    expect(documents).not.toContain('costBasis')
    expect(documents).not.toContain('uncollectedProduct')
    expect(documents).not.toContain('المنتجات غير المستلمة')
  })
})
