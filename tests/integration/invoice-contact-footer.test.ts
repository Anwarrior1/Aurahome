import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CustomerDocumentDTO } from '@main/reports/dto/customer-document.dto'
import {
  renderFinalInvoice,
  renderPreliminaryInvoice
} from '@main/reports/templates/documents.template'

const DOCUMENT: CustomerDocumentDTO = {
  documentNumber: 'TEST-001',
  issuedAt: '13/09/2026',
  customer: { name: 'عميل الاختبار' },
  lines: [{ description: 'بند', quantity: '1', unitPrice: '100 د.ل', lineTotal: '100 د.ل' }],
  itemColumns: { description: true, quantity: true, unitPrice: true, lineTotal: true },
  subtotal: '100 د.ل',
  totalAfterDiscount: '100 د.ل'
}

const FOOTER_CONTENT = [
  '091 1717111',
  '092 1217111',
  'طريق الجديدة بالقرب من مركز اللافي',
  'AURA HOME',
  'امسح لعرض موقعنا'
]

describe('AURA HOME customer invoice contact footer', () => {
  for (const [name, render] of [
    ['Preliminary Invoice', renderPreliminaryInvoice],
    ['Approved Invoice', renderFinalInvoice]
  ] as const) {
    it(`renders the exact shared contact information and local QR in ${name}`, () => {
      const html = render(DOCUMENT, { name: 'AURA home' })

      for (const value of FOOTER_CONTENT) expect(html).toContain(value)
      expect(html).toContain('app://assets/references/qr.jpeg')
      expect(html.match(/class="invoice-contact-footer"/g)).toHaveLength(1)
      expect(html.match(/<svg /g)).toHaveLength(4)
      expect(html).toContain('<bdi dir="ltr">091 1717111</bdi>')
      expect(html).toContain('<bdi dir="ltr">092 1217111</bdi>')
      expect(html).toContain('break-inside: avoid')
    })
  }

  it('uses the supplied QR file and packages that exact reference asset', () => {
    const qr = readFileSync(resolve('references/qr.jpeg'))
    expect(qr.subarray(0, 3).toString('hex')).toBe('ffd8ff')
    const builder = readFileSync(resolve('electron-builder.yml'), 'utf8')
    expect(builder).toContain('from: references/qr.jpeg')
    expect(builder).toContain('to: references/qr.jpeg')
  })

  it('does not add the customer contact footer to internal documents', () => {
    const source = readFileSync(resolve('src/main/reports/templates/documents.template.ts'), 'utf8')
    const invoiceCalls = source.match(/\$\{invoiceContactFooter\(\)\}/g) ?? []
    expect(invoiceCalls).toHaveLength(2)
    expect(source.indexOf('${invoiceContactFooter()}')).toBeGreaterThan(source.indexOf('renderPreliminaryInvoice'))
    expect(source.lastIndexOf('${invoiceContactFooter()}')).toBeGreaterThan(source.indexOf('renderFinalInvoice'))
    expect(source.lastIndexOf('${invoiceContactFooter()}')).toBeLessThan(source.indexOf('renderWorkSheet'))
  })
})
