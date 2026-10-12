import type { ServiceContext } from '@main/services/base/service.types'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { issueWorkSheet, startProduction, consumeForOrder, completeProduction } from '@main/services/production/production.service'
import { approveToOrder } from './sales-flow'
import { getRawConnection } from '@main/db/connection'

export function uiWf07Fixture(ctx: ServiceContext) {
  const materialId = createMaterial({ sku: 'UIWF07-BOARD', name: 'UIWF07 Board', categoryId: createCategory({ name: 'UIWF07' }, ctx), unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: 100000000 }, ctx)
  createPurchase({ supplierId: createSupplier({ name: 'UIWF07 Supplier' }, ctx), lines: [{ materialId, qtyMicro: 100000000, unitCostMicro: 100000000 }] }, ctx)
  function worksheet(name: string, status: 'ready' | 'in_production' | 'completed') {
    const invoice = createFinalInvoice({ customerId: createCustomer({ name }, ctx), depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'Cabinet', quantityMicro: 1000000, unitPriceMinor: 5000000 }] }, ctx)
    const order = approveToOrder(invoice.id, ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, ctx)
    if (status !== 'ready') startProduction(sheet.id, ctx)
    const issue = consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: 10000000 }, ctx)
    if (status === 'completed') completeProduction(sheet.id, ctx)
    return { orderId: order.id, sheetId: sheet.id, lineId: issue.id }
  }
  return { materialId, completed: worksheet('UIWF07 Completed', 'completed'), active: worksheet('UIWF07 Active', 'in_production'), ready: worksheet('UIWF07 Ready', 'ready') }
}

export function uiWf07Snapshot() {
  const raw = getRawConnection()
  return Object.fromEntries((raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => [name, raw.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()]))
}
