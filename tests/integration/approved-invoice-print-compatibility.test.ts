import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getDatabase } from '@main/db/connection'
import { finalInvoices } from '@main/db/schema/sales.schema'
import { createCustomer } from '@main/services/parties/parties.service'
import {
  approveFinalInvoice,
  createFinalInvoice,
  getFinalInvoice
} from '@main/services/sales/final-invoices.service'
import { renderDocumentHtml } from '@main/services/documents/print.service'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function approvedInvoice(): number {
  const customerId = createCustomer(
    { name: 'عميل الطباعة', phone: '0912345678', address: 'طرابلس' },
    env.ctx
  )
  const { id } = createFinalInvoice(
    {
      customerId,
      lines: [{
        lineKind: 'custom',
        description: 'خزانة تاريخية',
        specifications: 'مواصفات محفوظة',
        dimensions: '200 × 80 سم',
        materialType: 'خشب زان',
        colorCode: 'أبيض مطفي',
        accessories: 'مقبض معدني',
        quantityMicro: quantityFromDisplay(2),
        unitPriceMinor: moneyFromMajor(150)
      }],
      printVisibility: {
        specifications: true,
        materialType: true,
        colorCode: true,
        accessories: true,
        termsAndConditions: true
      }
    },
    env.ctx
  )
  approveFinalInvoice(id, env.ctx)
  return id
}

describe('Approved Invoice print compatibility', () => {
  it('renders a newly approved invoice through the production print entry point', () => {
    const id = approvedInvoice()
    const before = getFinalInvoice(id).invoice

    const { html, documentNumber } = renderDocumentHtml('final_invoice', id, env.ctx)

    expect(documentNumber).toBe(before.documentNumber)
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('خزانة تاريخية')
    expect(html).toContain('مواصفات محفوظة')
    expect(html).toContain('300,00 د.ل')
    expect(getFinalInvoice(id).invoice.totalMinor).toBe(before.totalMinor)
  })

  it('renders an older sparse snapshot without inventing or changing invoice data', () => {
    const id = approvedInvoice()
    const before = getFinalInvoice(id)
    const legacySnapshot = JSON.parse(before.invoice.snapshot!) as {
      lines: Array<Record<string, unknown>>
      [key: string]: unknown
    }
    for (const line of legacySnapshot.lines) {
      delete line.selectedMaterials
      delete line.selectedColors
      delete line.selectedAccessories
    }
    delete legacySnapshot.meterPriceMinor
    delete legacySnapshot.installationPriceMinor
    delete legacySnapshot.deliveryPriceMinor
    delete legacySnapshot.requiresInstallation
    delete legacySnapshot.requiresDelivery
    const frozenLegacyJson = JSON.stringify(legacySnapshot)
    getDatabase().update(finalInvoices)
      .set({ snapshot: frozenLegacyJson })
      .where(eq(finalInvoices.id, id))
      .run()

    const { html } = renderDocumentHtml('final_invoice', id, env.ctx)

    expect(html).toContain('خزانة تاريخية')
    expect(html).toContain('خشب زان')
    expect(html).toContain('أبيض مطفي')
    expect(html).toContain('مقبض معدني')
    expect(html).toContain('مواصفات محفوظة')
    expect(html).toContain('300,00 د.ل')
    const after = getFinalInvoice(id)
    expect(after.invoice.snapshot).toBe(frozenLegacyJson)
    expect(after.invoice.totalMinor).toBe(before.invoice.totalMinor)
  })
})
