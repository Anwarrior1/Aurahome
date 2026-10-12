import type { ServiceContext } from '@main/services/base/service.types'
import { createCustomer } from '@main/services/parties/parties.service'
import { createQuotation } from '@main/services/sales/quotations.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { issueWorkSheet, issueRelease } from '@main/services/production/production.service'
import { approveToOrder } from './sales-flow'

/** Fictional documents, issued by the existing owners on a disposable database. */
export function sec01Documents(ctx: ServiceContext) {
  const customerId = createCustomer({ name: 'SEC01 fictional customer', phone: 'SEC01 private phone', address: 'SEC01 private address' }, ctx)
  const input = { customerId, depositPercentBp: 0, lines: [{ lineKind: 'custom' as const, description: 'SEC01 cabinet', quantityMicro: 1000000, unitPriceMinor: 1234567 }] }
  const quotation = createQuotation(input, ctx)
  const invoice = createFinalInvoice(input, ctx)
  const order = approveToOrder(invoice.id, ctx)
  const worksheet = issueWorkSheet({ orderId: order.id }, ctx)
  // A release is legitimate for an order with no outstanding manufacturing worksheet.
  const releases = (['installation', 'delivery'] as const).map((kind) => {
    const releaseInvoice = createFinalInvoice({ ...input, requiresInstallation: kind === 'installation' }, ctx)
    const releaseOrder = approveToOrder(releaseInvoice.id, ctx)
    return issueRelease({ orderId: releaseOrder.id, kind }, ctx)
  })
  return { orderId: order.id, documents: {
    preliminary_invoice: quotation.id,
    final_invoice: invoice.id,
    work_sheet: worksheet.id,
    installation_release: releases[0].id,
    delivery_release: releases[1].id
  } }
}
