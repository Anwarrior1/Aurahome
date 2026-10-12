import { getRawConnection } from '@main/db/connection'
import { approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrderOrThrow } from '@main/services/sales/orders.service'
import type { ServiceContext } from '@main/services/base/service.types'
import { issueRelease, recordDelivery } from '@main/services/production/production.service'

/**
 * The canonical way a Customer Order comes into existence after the
 * workflow pass: an APPROVED INVOICE is approved, and that approval
 * creates the order.
 *
 * Returns the order row itself, so a test reads `.id`,
 * `.documentNumber`, `.totalMinor` and everything else straight off it.
 */
export function approveToOrder(invoiceId: number, ctx: ServiceContext) {
  const result = approveFinalInvoice(invoiceId, ctx)
  return getOrderOrThrow(result.orderId)
}

/** Complete a test order through the same permit and physical event as production. */
export function fulfillOrder(orderId: number, ctx: ServiceContext, recordedAt?: string) {
  const permit = getRawConnection().prepare("SELECT id FROM releases WHERE order_id = ? AND status = 'active'").get(orderId) as { id: number } | undefined
  const release = permit ?? issueRelease({ orderId, kind: 'delivery' }, ctx)
  return recordDelivery({ orderId, releaseId: release.id, kind: 'handover', recordedAt }, ctx)
}
