import { getRawConnection } from '@main/db/connection'
import { adjustFinishedGoods } from '@main/services/production/finished-goods.service'
import { issueRelease } from '@main/services/production/production.service'
import type { ServiceContext } from '@main/services/base/service.types'

/** Opening/count stock fixture; never represents new BOM production. */
export function seedFinishedGoods(input: { productId: number; workSheetId?: number | null; qtyMicro: number; totalCostMinor: number }, ctx: ServiceContext): number {
  return adjustFinishedGoods({ ...input, direction: 'in', notes: 'Test opening stock/count fixture' }, ctx).id
}

/** Exercise stock issue through its authoritative permit owner. */
export function issueStockForOrder(input: { orderId: number }, ctx: ServiceContext) {
  issueRelease({ ...input, kind: 'delivery' }, ctx)
  const rows = getRawConnection().prepare("SELECT id, total_cost_minor AS totalCostMinor FROM finished_goods_movements WHERE order_id=? AND kind='sale_out' ORDER BY id").all(input.orderId) as { id: number; totalCostMinor: number }[]
  return { issuedLines: rows.length, totalCostMinor: rows.reduce((n, r) => n + r.totalCostMinor, 0) }
}

export function issueFinishedGoodsForOrder(input: { productId: number; orderId: number; qtyMicro: number; notes?: string }, ctx: ServiceContext) {
  issueStockForOrder({ orderId: input.orderId }, ctx)
  return getRawConnection().prepare("SELECT id, total_cost_minor AS totalCostMinor FROM finished_goods_movements WHERE order_id=? AND product_id=? AND kind='sale_out' ORDER BY id DESC LIMIT 1").get(input.orderId, input.productId) as { id: number; totalCostMinor: number }
}
