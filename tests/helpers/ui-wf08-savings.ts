import type { ServiceContext } from '@main/services/base/service.types'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { approveToOrder } from './sales-flow'
import { recordPayment } from '@main/services/sales/orders.service'
import { issueRelease, recordDelivery } from '@main/services/production/production.service'
import { createAccount } from '@main/services/finance/cash.service'
import { confirmSavingsAllocation, monthlyProfitSummary, setSavingsRateBp } from '@main/services/finance/profit.service'

export function uiWf08Fixture(ctx: ServiceContext) {
  const recordedAt = new Date().toISOString()
  const year = Number(recordedAt.slice(0, 4))
  const month = Number(recordedAt.slice(5, 7))
  const accountId = createAccount({ name: 'UIWF08 Cash', kind: 'cash', openingBalanceMinor: 1000000 }, ctx)
  const invoice = createFinalInvoice({ customerId: createCustomer({ name: 'UIWF08 Customer' }, ctx), lines: [{ lineKind: 'custom', description: 'UIWF08 Cabinet', quantityMicro: 1000000, unitPriceMinor: 5000000 }] }, ctx)
  const order = approveToOrder(invoice.id, ctx)
  recordPayment({ orderId: order.id, amountMinor: 5000000, cashAccountId: accountId }, ctx)
  issueRelease({ orderId: order.id, kind: 'transport' }, ctx)
  recordDelivery({ orderId: order.id, kind: 'delivery', recordedAt }, ctx)
  setSavingsRateBp(1000, ctx)
  confirmSavingsAllocation({ year, month }, ctx)
  setSavingsRateBp(10000, ctx)
  return { year, month, netProfitMinor: monthlyProfitSummary(year, month).netProfitMinor }
}
