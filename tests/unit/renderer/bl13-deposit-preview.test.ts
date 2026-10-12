import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { depositPreviewPercent } from '@renderer/lib/format'

describe('BL-13 deposit preview', () => {
  it('treats only absence as default and keeps explicit zero', () => {
    expect(depositPreviewPercent('', 6000)).toBe(60)
    expect(depositPreviewPercent('', 4500)).toBe(45)
    expect(depositPreviewPercent('0', 6000)).toBe(0)
    expect(depositPreviewPercent('30', 6000)).toBe(30)
  })

  it('uses the same preview rule in both invoice editors and restricts Approved Invoice editing', () => {
    const approved = readFileSync('src/renderer/pages/invoices/FinalInvoicesPage.tsx', 'utf8')
    const preliminary = readFileSync('src/renderer/pages/quotations/QuotationsPage.tsx', 'utf8')
    expect(approved).toContain('depositPreviewPercent(form.depositPercent, defaultDepositPercentBp)')
    expect(preliminary).toContain('depositPreviewPercent(form.depositPercent, 6000)')
    expect(approved).toContain('disabled={!can(P.orders.overrideDeposit)}')
    expect(approved).toContain("depositPercentBp: can(P.orders.overrideDeposit) && form.depositPercent !== ''")
    expect(preliminary).not.toContain('orders.overrideDeposit')
  })
})
