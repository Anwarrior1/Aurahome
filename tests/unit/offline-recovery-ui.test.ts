import { describe, expect, it } from 'vitest'
import { renderArabicRecoveryPreview, type RecoveryPreviewScreen } from '../../src/main/recovery/offline-ui'

const screens: RecoveryPreviewScreen[] = [
  'start', 'select', 'inspect', 'validation', 'risk', 'decision', 'preservation',
  'activation-pending', 'financial-review', 'completion'
]

describe('independent Arabic recovery preview', () => {
  it.each(screens)('renders %s as RTL development-only UI without operational activation', (screen) => {
    const html = renderArabicRecoveryPreview(screen, {
      archiveSha256: 'a'.repeat(64), unverifiedDate: '2026-01-01', validationPassed: true
    })
    expect(html).toContain('lang="ar" dir="rtl"')
    expect(html).toContain('عرض تجريبي فقط')
    expect(html).toContain('Windows')
    expect(html).not.toContain('تمت الاستعادة بنجاح')
    expect(html).not.toMatch(/<button[^>]*>استعد الآن<\/button>/)
  })

  it('shows unknown origin, unverified date, transaction-loss warning and exact archive hash', () => {
    const html = renderArabicRecoveryPreview('risk', {
      archiveSha256: 'b'.repeat(64), unverifiedDate: '<unsafe>', validationPassed: true
    })
    expect(html).toContain('UNKNOWN ORIGIN')
    expect(html).toContain('b'.repeat(64))
    expect(html).toContain('غير موثّق')
    expect(html).toContain('العمليات الأحدث')
    expect(html).toContain('&lt;unsafe&gt;')
    expect(html).not.toContain('<unsafe>')
  })

  it('cannot depict financial approval when technical validation failed', () => {
    expect(() => renderArabicRecoveryPreview('financial-review', {
      archiveSha256: 'c'.repeat(64), unverifiedDate: '2026-01-01', validationPassed: false
    })).toThrow()
  })
})
