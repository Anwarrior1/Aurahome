import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')
const router = readFileSync('src/main/ipc/router.ts', 'utf8')

describe('order planning commission and expense UI', () => {
  it('shows the two commission modes and keeps the meter total read-only', () => {
    expect(page).toContain('<option value="estimated">تقديرية / يدوية</option>')
    expect(page).toContain('<option value="meter">حسب المتر</option>')
    expect(page).toContain('label="سعر المتر (د.ل)"')
    expect(page).toContain('label="عدد الأمتار"')
    expect(page).toContain('label="الإجمالي"')
    expect(page).toContain('readOnly aria-readonly="true"')
  })

  it('keeps estimated commission separate from the meter inputs', () => {
    expect(page).toContain("line.commissionMode === 'estimated'")
    expect(page).toContain('label="العمولة التقديرية (د.ل)"')
    expect(page).not.toContain('label="اسم البند"')
  })

  it('adds the matching expense tab, line editor, total, and save action', () => {
    expect(page).toContain("setTab('expenses')}>مصروفات الطلب")
    expect(page).toContain('label="اسم المصروف"')
    expect(page).toContain('label="السعر (د.ل)"')
    expect(page).toContain('>+ إضافة مصروف</Button>')
    expect(page).toContain('label="إجمالي مصروفات الطلب"')
    expect(page).toContain("call('orders', 'savePlannedExpenses'")
  })

  it('uses the existing summary cards for all four components and total', () => {
    for (const label of ['تكلفة المواد', 'تكلفة الآلات', 'عمولات العمال', 'مصروفات الطلب', 'إجمالي التكلفة التقديرية']) {
      expect(page).toContain(`label="${label}"`)
    }
  })

  it('keeps expense writes behind the existing orders.manage permission', () => {
    // Pinned to this handler only (the old lazy match ran past it into later routes).
    const start = router.indexOf('IPC_CHANNELS.orders.savePlannedExpenses,')
    expect(router.slice(start, router.indexOf('IPC_CHANNELS.', start + 1))).toContain('permission: P.productionPrep.manage')
  })
})
