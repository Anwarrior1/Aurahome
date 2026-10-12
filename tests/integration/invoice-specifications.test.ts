import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCustomer } from '@main/services/parties/parties.service'
import { createQuotation, getQuotation, updateQuotation } from '@main/services/sales/quotations.service'
import { createFinalInvoice, getFinalInvoice, updateFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { buildPreliminaryInvoice, buildFinalInvoice } from '@main/services/documents/documents.service'
import { renderPreliminaryInvoice, renderFinalInvoice } from '@main/reports/templates/documents.template'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())
const longNotes = Array.from({ length: 140 }, (_, i) => `ملاحظة تصنيع ${i + 1}: يجب مطابقة اتجاه الخشب والتشطيب واعتماد القياسات قبل تركيب المفصلات.`).join('\n')
const line = { lineKind: 'custom' as const, description: 'خزانة', quantityMicro: quantityFromDisplay(2), unitPriceMinor: moneyFromMajor(1000) }

describe.each(['preliminary', 'approved'] as const)('%s specifications', (kind) => {
  it('retains independent saved notes through edits and snapshots, prints complete multiline Arabic, and preserves totals', () => {
    const customerId = createCustomer({ name: 'عميل المواصفات' }, env.ctx)
    const create = kind === 'preliminary' ? createQuotation : createFinalInvoice
    const get = kind === 'preliminary' ? getQuotation : getFinalInvoice
    const update = kind === 'preliminary' ? updateQuotation : updateFinalInvoice
    const id = create({ customerId, lines: [{ ...line, specifications: 'مواصفات تاريخية' }, { ...line, specifications: 'ملاحظات الصنف الثاني' }] }, env.ctx).id
    const before = get(id)
    expect(before.lines.map(l => l.specifications)).toEqual(['مواصفات تاريخية', 'ملاحظات الصنف الثاني'])
    update(id, { lines: [{ ...line, specifications: longNotes }, { ...line, specifications: 'ملاحظات الصنف الثاني' }] }, env.ctx)
    const saved = get(id)
    expect(saved.lines.map(l => l.specifications)).toEqual([longNotes, 'ملاحظات الصنف الثاني'])
    const total = (document: typeof saved): number => 'quotation' in document ? document.quotation.totalMinor : document.invoice.totalMinor
    expect(total(saved)).toBe(moneyFromMajor(4000))
    expect(total(saved)).toBe(total(before))
    if (kind === 'approved') approveFinalInvoice(id, env.ctx)
    const html = kind === 'preliminary'
      ? renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' })
      : renderFinalInvoice(buildFinalInvoice(id), { name: 'AURA' })
    expect(html).toContain('<div class="spec-label">المواصفات وملاحظات التصنيع</div>')
    expect(html).toContain(longNotes)
    expect(html).toContain('ملاحظات الصنف الثاني')
    expect(html).toContain('white-space: pre-wrap')
    expect(html).toContain('overflow-wrap: anywhere')
    mkdirSync(resolve('tmp/pdfs'), { recursive: true })
    writeFileSync(resolve(`tmp/pdfs/${kind}-long-notes.html`), html.replaceAll('app://assets/', `file://${resolve('resources/assets')}/`))
  })

  it('keeps the existing specifications visibility key and historical stored content', () => {
    const customerId = createCustomer({ name: 'عميل الطباعة' }, env.ctx)
    const create = kind === 'preliminary' ? createQuotation : createFinalInvoice
    const get = kind === 'preliminary' ? getQuotation : getFinalInvoice
    const id = create({ customerId, lines: [{ ...line, specifications: 'بيانات محفوظة مخفية' }], printVisibility: { specifications: false } }, env.ctx).id
    if (kind === 'approved') approveFinalInvoice(id, env.ctx)
    const html = kind === 'preliminary'
      ? renderPreliminaryInvoice(buildPreliminaryInvoice(id), { name: 'AURA' })
      : renderFinalInvoice(buildFinalInvoice(id), { name: 'AURA' })
    expect(html).not.toContain('بيانات محفوظة مخفية')
    expect(html).not.toContain('<div class="spec-label">')
    expect(get(id).lines[0].specifications).toBe('بيانات محفوظة مخفية')
  })
})
