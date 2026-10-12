import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const purchasesPage = readFileSync('src/renderer/pages/purchases/PurchasesPage.tsx', 'utf8')
const orderPage = readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')
const selector = readFileSync('src/renderer/components/orders/SearchableOrderSelect.tsx', 'utf8')

describe('order-linked purchase UI', () => {
  it('provides the searchable create/edit selector and restores the saved order', () => {
    expect(purchasesPage).toContain('<Field label="الطلب المرتبط">')
    expect(purchasesPage).toContain('customerOrderId: detail.purchase.customerOrderId == null')
    expect(purchasesPage).toContain('customerOrderId: can(P.orders.view)')
    expect(purchasesPage).toContain('form.customerOrderId ? Number(form.customerOrderId) : null')
    expect(selector).toContain('بحث برقم الطلب أو اسم العميل...')
    expect(selector).toContain('شراء عام / بدون طلب')
  })

  it('adds a searchable order filter without replacing supplier/date filters', () => {
    expect(purchasesPage).toContain('mode="filter"')
    expect(purchasesPage).toContain("unassignedOnly: orderFilter === 'general' || undefined")
    expect(selector).toContain('كل الطلبات')
    expect(selector).toContain('شراء عام')
    expect(purchasesPage).toContain('<Field label="المورد">')
    expect(purchasesPage).toContain('<Field label="النطاق">')
  })

  it('shows the linked order column and the order-details purchases card', () => {
    expect(purchasesPage).toContain("key: 'order', header: 'الطلب المرتبط'")
    expect(orderPage).toContain('<Card title="مشتريات الطلب">')
    expect(orderPage).toContain('<Stat label="إجمالي مشتريات الطلب"')
    expect(orderPage).toContain('فتح الفاتورة')
    expect(orderPage).toContain('navigate(`/purchases?open=${row.id}`)')
    expect(purchasesPage).toContain('title={`عرض فاتورة الشراء')
  })
})
