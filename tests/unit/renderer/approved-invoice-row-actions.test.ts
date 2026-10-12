import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync('src/renderer/pages/invoices/FinalInvoicesPage.tsx', 'utf8')

describe('Approved Invoices row actions', () => {
  it('CC02: gates unapprove, permanent delete and archive/unarchive on the backend lifecycle flags', () => {
    expect(page).toContain('disabled={unapprovingId !== undefined || !row.canUnapprove}')
    expect(page).toContain("row.status === 'draft' && row.canDelete && can(P.finalInvoices.remove)")
    expect(page).toContain("row.status === 'approved' && row.orderId && can(P.orders.archive) && <Button size=\"sm\" variant=\"secondary\" disabled={!row.canArchive}")
    expect(page).toContain('أرشفة</Button>')
    expect(page).toContain('{row.orderArchivedAt && can(P.orders.archive) && ')
    expect(page).toContain('إلغاء الأرشفة</Button>')
    expect(page).toContain("await call('orders', archive ? 'archive' : 'restore', { id: row.orderId })")
  })
  it('removes only the cancel action from this page', () => {
    expect(page).not.toContain('title="إلغاء الفاتورة"')
    expect(page).not.toContain('aria-label="إلغاء الفاتورة"')
    expect(page).not.toContain('cancelInvoice(row)')
    expect(page).not.toContain("'finalInvoices', 'cancel'")
    expect(page).not.toMatch(/\bBan\b/)
  })

  it('keeps the existing view, print and PDF actions in the same row-actions group', () => {
    expect(page).toContain('<div className="row-actions">')
    expect(page).toContain('title="فتح الطلب" aria-label="فتح الطلب"')
    expect(page).toContain("navigate(`/orders/${row.orderId}`)")
    expect(page).toContain('title="طباعة" aria-label="طباعة"')
    expect(page).toContain("printDoc(row.id, 'print')")
    expect(page).toContain('title="تصدير PDF" aria-label="تصدير PDF"')
    expect(page).toContain("printDoc(row.id, 'exportPdf')")
  })

  it('keeps unrelated draft actions intact', () => {
    expect(page).toContain('اعتماد وإنشاء طلب')
    expect(page).toContain('title="تعديل" aria-label="تعديل"')
    expect(page).toContain(`title={row.orderId ? 'حذف نهائي' : 'حذف المسودة'} aria-label={row.orderId ? 'حذف نهائي' : 'حذف المسودة'}`)
  })
})
