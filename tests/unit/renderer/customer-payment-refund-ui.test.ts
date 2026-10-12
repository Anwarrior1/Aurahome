import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')

describe('Customer Order refund UI', () => {
  it('uses backend eligibility and the narrow permission for the exact refund action', () => {
    expect(page).toContain('can(P.payments.refund) && detail.data!.actions.canRefundPayment')
    expect(page).toContain('استرداد دفعة')
    expect(page).toContain('financialCall(')
    expect(page).toContain("'refundPayment'")
  })

  it('shows only the authoritative financial fields and preserves signed history', () => {
    for (const label of [
      'إجمالي الطلب',
      'المدفوع الحالي',
      'المبلغ القابل للاسترداد',
      'مبلغ الاسترداد (د.ل)',
      'الحساب/الصندوق'
    ]) {
      expect(page).toContain(label)
    }
    const refundDialog = page.slice(
      page.indexOf("<Modal open={dialog === 'refund'"),
      page.indexOf("<Modal open={dialog === 'worksheet'")
    )
    expect(refundDialog).not.toContain('ملاحظات / سبب الاسترداد')
    expect(refundDialog).not.toContain('reason:')
    expect(page).toContain("row.entryType === 'refund' ? 'استرداد دفعة' : 'دفعة عميل'")
    expect(page).toContain('rowKey={(row) => row.rowKey}')
  })
})
