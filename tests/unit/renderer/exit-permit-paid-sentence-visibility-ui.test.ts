import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')

describe('Exit/Installation Permit paid-sentence option UI', () => {
  it('uses the existing compact RTL checkbox pattern and defaults new permits to visible', () => {
    expect(page).toContain('<span>إظهار عبارة سداد كامل قيمة الطلب</span>')
    expect(page).toContain('className="checkbox-row"')
    expect(page).toContain("showPaidExitSentence: 'true'")
    expect(page).toContain("checked={form.showPaidExitSentence !== 'false'}")
  })

  it('sends only a boolean document-visibility option to release issuance', () => {
    expect(page).toContain("showPaidExitSentence: form.showPaidExitSentence !== 'false'")
    expect(page).not.toMatch(/showPaidExitSentence[\s\S]{0,100}(paidMinor|remainingMinor|payment)/)
  })

  it('shows the unpaid balance without blocking issuance', () => {
    expect(page).toContain('<strong>الطلب غير مسدد بالكامل.</strong>')
    expect(page).toContain('المبلغ المتبقي: {fmtMoney(order.remainingMinor)}')
    expect(page).not.toContain('<span>السماح بخروج الطلب رغم وجود رصيد متبقٍ</span>')
    expect(page).not.toContain('سبب السماح بالخروج')
    expect(page).not.toContain('unpaidReleaseOverrideReason')
    expect(page).toContain('<Field label="المكلّف (فريق التركيب/التسليم)">')
  })

  it('keeps the release action available with unpaid balance', () => {
    expect(page).not.toContain('can(P.releases.overrideUnpaid)')
    expect(page).not.toContain("form.unpaidReleaseOverride === 'true'")
    expect(page).toContain('disabled={processing}')
  })
})
