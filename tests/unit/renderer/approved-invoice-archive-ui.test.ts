import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync('src/renderer/pages/invoices/FinalInvoicesPage.tsx', 'utf8')

describe('Approved Invoice archive organization', () => {
  it('has active and archived tabs backed by a bounded server query', () => {
    expect(page).toContain('الفواتير المعتمدة النشطة')
    expect(page).toContain('الفواتير المعتمدة المؤرشفة')
    expect(page).toContain('archived\n')
    expect(page).toContain("usePagedQuery<FinalInvoice")
    expect(page).toContain('{ limit: pageSize }')
    // DB-10: seek pagination, never a deep OFFSET.
    expect(page).not.toContain('offset')
    expect(page).toContain('<Pager')
  })

  it('keeps historical open/print/PDF actions and suppresses unapproval for archived orders', () => {
    expect(page).toContain('navigate(`/orders/${row.orderId}`)')
    expect(page).toContain("printDoc(row.id, 'print')")
    expect(page).toContain("printDoc(row.id, 'exportPdf')")
    expect(page).toContain("!row.orderArchivedAt && row.status === 'approved'")
    expect(page.match(/!row\.orderArchivedAt && row\.status === 'draft'/g)).toHaveLength(3)
  })
})
