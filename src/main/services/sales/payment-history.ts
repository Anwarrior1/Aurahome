import {sql} from 'drizzle-orm'

export interface PaymentHistoryEntry {
  rowKey: string
  id: number
  entryType: 'payment' | 'refund'
  orderId: number
  customerId: number
  approvedInvoiceId: number | null
  amountMinor: number
  cashAccountId: number | null
  paidAt: string
  notes: string | null
  createdBy: number | null
  createdAt: string
  effectiveBusinessDay: string
  executionAt: string
}

// Contract C: day, actual creation instant, then the established ID/type tie.
// Source IDs are only deterministic tie-breakers, never a global event clock.
export const paymentHistoryColumns = [sql`effectiveBusinessDay`, sql`executionAt`, sql`id`, sql`entryType`]
export const paymentHistoryOrder = sql.join(paymentHistoryColumns.map(column => sql`${column} DESC`), sql`, `)

/** Shared read model only: original effective/creation fields are never rewritten. */
export function paymentHistoryRows(scope: 'order' | 'customer', id: number) {
  const column = sql.raw(scope === 'order' ? 'order_id' : 'customer_id')
  return sql`
    SELECT events.*,
      CASE
        WHEN paidAt GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(paidAt) = paidAt THEN paidAt
        WHEN paidAt GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ]*' THEN COALESCE(date(paidAt, 'localtime'), '')
        ELSE ''
      END AS effectiveBusinessDay,
      CASE
        WHEN createdAt GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ]*'
          THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', createdAt), '')
        ELSE ''
      END AS executionAt
    FROM (
      SELECT 'payment-' || id AS rowKey, id, 'payment' AS entryType,
             order_id AS orderId, customer_id AS customerId, approved_invoice_id AS approvedInvoiceId,
             amount_minor AS amountMinor, cash_account_id AS cashAccountId, paid_at AS paidAt,
             notes, created_by AS createdBy, created_at AS createdAt
      FROM customer_payments WHERE ${column} = ${id}
      UNION ALL
      SELECT 'refund-' || id AS rowKey, id, 'refund' AS entryType,
             order_id AS orderId, customer_id AS customerId, NULL AS approvedInvoiceId,
             -amount_minor AS amountMinor, cash_account_id AS cashAccountId, refunded_at AS paidAt,
             reason AS notes, created_by AS createdBy, created_at AS createdAt
      FROM customer_payment_refunds WHERE ${column} = ${id}
    ) events
  `
}
