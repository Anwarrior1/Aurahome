import { and, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm'
import { idList, keysetBoundary, keysetOrder, keysetPage, normalizedSearch, type KeysetWindow, type PageRequest } from '../base/pagination'
import { getDatabase, getRawConnection } from '../../db/connection'
import { orders, orderLines, finalInvoices } from '../../db/schema/sales.schema'
import { workSheets, deliveries } from '../../db/schema/production.schema'
import {
  uncollectedProducts,
  uncollectedProductMaterials,
  uncollectedProductColors,
  uncollectedProductAccessories
} from '../../db/schema/uncollected-products.schema'
import { AppError, notFound } from '../../utils/errors'
import { nowIso, type ServiceContext } from '../base/service.types'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { hasPermission, requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import type { AuthSession } from '@shared/types/user.types'
import type { ItemSelections, ItemMaterialSelection, ColorSelection } from '@shared/documents/item-selections'
import { withImmediateTransaction } from '../../db/transactions'
import { orderPaymentPosition } from './final-invoices.service'
import { paymentStatusFor } from './orders.service'
import { orderCostBreakdown } from '../costing/costing.service'
import { multiplyDivideRounded } from '@shared/money/cost'
import { requireSafeNonNegativeInteger } from '../../utils/numeric'
import { isManufacturableOrderLine } from './order-line-manufacturing'

/**
 * "المنتجات غير المستلمة" — physical products that were actually
 * manufactured for a Customer Order the customer then abandoned.
 *
 * This module owns only the PRODUCT. `cancelOrder` transfers completed output
 * immediately; a worksheet already in production transfers at its later
 * completion. Both callers use their existing transaction.
 */

export type UncollectedStatus = 'available' | 'reserved' | 'sold' | 'resumed'

type Product = typeof uncollectedProducts.$inferSelect

/** Source IDs, current ownership, and retained manufacture are all checked in main. */
type OrderRow = typeof orders.$inferSelect
type OrderLineRow = typeof orderLines.$inferSelect

/**
 * Everything the resume rules read. The authoritative action uses live
 * single-row lookups; a list page preloads the same rows for all of its
 * source orders so the identical rules run with a fixed query count.
 */
interface ResumeFacts {
  productsOfOrder(orderId: number): Product[]
  invoiceLineExists(productId: number): boolean
  order(orderId: number): OrderRow | undefined
  orderLine(lineId: number): OrderLineRow | undefined
  linesOfOrder(orderId: number): OrderLineRow[]
  workSheet(id: number): typeof workSheets.$inferSelect | undefined
  finalInvoice(id: number): typeof finalInvoices.$inferSelect | undefined
  reachedCustomer(orderId: number): boolean
  paidMinor(orderId: number): number
}

const liveResumeFacts: ResumeFacts = {
  productsOfOrder: (orderId) => getDatabase().select().from(uncollectedProducts)
    .where(eq(uncollectedProducts.sourceOrderId, orderId)).orderBy(uncollectedProducts.id).all(),
  invoiceLineExists: (productId) =>
    Boolean(getDatabase().get(sql`SELECT id FROM final_invoice_lines WHERE uncollected_product_id = ${productId} LIMIT 1`)),
  order: (orderId) => getDatabase().select().from(orders).where(eq(orders.id, orderId)).get(),
  orderLine: (lineId) => getDatabase().select().from(orderLines).where(eq(orderLines.id, lineId)).get(),
  linesOfOrder: (orderId) => getDatabase().select().from(orderLines).where(eq(orderLines.orderId, orderId)).all(),
  workSheet: (id) => getDatabase().select().from(workSheets).where(eq(workSheets.id, id)).get(),
  finalInvoice: (id) => getDatabase().select().from(finalInvoices).where(eq(finalInvoices.id, id)).get(),
  reachedCustomer: (orderId) => hasReachedCustomer(orderId),
  paidMinor: (orderId) => orderPaymentPosition(orderId).paidMinor
}

function batchResumeFacts(sourceOrderIds: number[]): ResumeFacts {
  const db = getDatabase()
  const ids = [...new Set(sourceOrderIds)]
  if (!ids.length) return liveResumeFacts
  const products = db.select().from(uncollectedProducts)
    .where(inArray(uncollectedProducts.sourceOrderId, ids)).orderBy(uncollectedProducts.id).all()
  const productIds = products.map((product) => product.id)
  const invoiced = new Set(productIds.length
    ? db.all<{ productId: number }>(sql`SELECT DISTINCT uncollected_product_id AS productId FROM final_invoice_lines
        WHERE uncollected_product_id IN (${idList(productIds)})`).map((row) => row.productId)
    : [])
  const orderRows = new Map(db.select().from(orders).where(inArray(orders.id, ids)).all().map((order) => [order.id, order]))
  const lineIds = products.map((product) => product.sourceOrderLineId)
  const lines = db.select().from(orderLines)
    .where(lineIds.length ? or(inArray(orderLines.orderId, ids), inArray(orderLines.id, lineIds)) : inArray(orderLines.orderId, ids)).all()
  const sheetIds = products.map((product) => product.sourceWorkSheetId).filter((id): id is number => id !== null)
  const sheets = new Map((sheetIds.length ? db.select().from(workSheets).where(inArray(workSheets.id, sheetIds)).all() : [])
    .map((sheet) => [sheet.id, sheet]))
  const invoiceIds = [...orderRows.values()].map((order) => order.finalInvoiceId).filter((id): id is number => id !== null)
  const invoices = new Map((invoiceIds.length ? db.select().from(finalInvoices).where(inArray(finalInvoices.id, invoiceIds)).all() : [])
    .map((invoice) => [invoice.id, invoice]))
  const reached = new Set(db.all<{ orderId: number }>(sql`SELECT DISTINCT order_id AS orderId FROM deliveries
    WHERE order_id IN (${idList(ids)}) AND status = 'recorded'`).map((row) => row.orderId))
  const paid = new Map(db.all<{ orderId: number; paidMinor: number }>(sql`
    SELECT o.id AS orderId,
      COALESCE((SELECT SUM(amount_minor) FROM customer_payments WHERE order_id = o.id), 0)
        - COALESCE((SELECT SUM(amount_minor) FROM customer_payment_refunds WHERE order_id = o.id), 0) AS paidMinor
    FROM orders o WHERE o.id IN (${idList(ids)})
  `).map((row) => [row.orderId, row.paidMinor]))
  return {
    productsOfOrder: (orderId) => products.filter((product) => product.sourceOrderId === orderId),
    invoiceLineExists: (productId) => invoiced.has(productId),
    order: (orderId) => orderRows.get(orderId),
    orderLine: (lineId) => lines.find((line) => line.id === lineId),
    linesOfOrder: (orderId) => lines.filter((line) => line.orderId === orderId),
    workSheet: (id) => sheets.get(id),
    finalInvoice: (id) => invoices.get(id),
    reachedCustomer: (orderId) => reached.has(orderId),
    paidMinor: (orderId) => paid.get(orderId) ?? 0
  }
}

function resumeBlocker(product: Product, facts: ResumeFacts = liveResumeFacts): string | undefined {
  if (product.status !== 'available' || product.reservedInvoiceId || product.soldInvoiceId || product.soldOrderId)
    return 'لا يمكن استئناف الطلب إلا لمنتج متاح لم يتم حجزه أو بيعه'
  if (facts.invoiceLineExists(product.id))
    return 'المنتج مرتبط بفاتورة بيع ولا يمكن استئنافه'
  const order = facts.order(product.sourceOrderId)
  if (!order || order.archivedAt || order.completedAt || !order.cancelledAt)
    return 'لا يمكن استئناف طلب مؤرشف أو مكتمل أو دون سجل إلغاء'
  if (order.status !== 'cancelled') return 'الطلب الأصلي ليس في حالة تسمح بالاستئناف'
  const line = facts.orderLine(product.sourceOrderLineId)
  if (!line || line.orderId !== order.id || !isManufacturableOrderLine(line)
    || line.quantityMicro !== product.quantityMicro)
    return 'رابط بند الطلب الأصلي غير صالح للاستئناف'
  const sheet = product.sourceWorkSheetId ? facts.workSheet(product.sourceWorkSheetId) : undefined
  if (!sheet || sheet.orderId !== order.id || sheet.status !== 'completed' || sheet.reversedAt)
    return 'لا يمكن الاستئناف دون أمر التصنيع الأصلي المكتمل'
  const invoice = order.finalInvoiceId ? facts.finalInvoice(order.finalInvoiceId) : undefined
  if (!invoice || invoice.id !== product.sourceInvoiceId || invoice.orderId !== order.id
    || invoice.customerId !== order.customerId || invoice.status !== 'approved')
    return 'الفاتورة الأصلية ليست معتمدة ومرتبطة بالطلب الأصلي'
  if (facts.reachedCustomer(order.id)) return 'لا يمكن استئناف طلب تم تسليمه أو تركيبه أو استلامه'
  if (facts.paidMinor(order.id) < 0) return 'يوجد تعارض في صافي دفعات العميل'
  return undefined
}

function originalOrderProducts(orderId: number): Product[] {
  return liveResumeFacts.productsOfOrder(orderId)
}

/** Historical multi-line orders must return as one complete physical job. */
function orderResumeBlocker(products: Product[], facts: ResumeFacts = liveResumeFacts): string | undefined {
  for (const product of products) {
    const blocker = resumeBlocker(product, facts)
    if (blocker) return blocker
  }
  const lines = facts.linesOfOrder(products[0]!.sourceOrderId)
    .filter(isManufacturableOrderLine)
  if (lines.length !== products.length || lines.some(line => !products.some(product => product.sourceOrderLineId === line.id)))
    return 'لا يمكن استئناف الطلب دون جميع منتجاته المصنّعة وروابطها الأصلية'
  return undefined
}

function resumeCapabilities(product: Product, session?: AuthSession, facts: ResumeFacts = liveResumeFacts): {
  canResume: boolean; resumeProducts: Array<{ id: number; name: string }>
} {
  if (session && !hasPermission(session, P.uncollectedProducts.resume))
    return { canResume: false, resumeProducts: [] }
  const products = facts.productsOfOrder(product.sourceOrderId)
  const canResume = !orderResumeBlocker(products, facts)
  return { canResume, resumeProducts: canResume ? products.map(row => ({ id: row.id, name: row.name })) : [] }
}

/** Defensive guard for incomplete ownership states created before whole-order resumption. */
export function resumedOrderFulfilmentBlocked(orderId: number): boolean {
  return Boolean(getDatabase().get<{ found: number }>(sql`
    SELECT 1 AS found WHERE
      EXISTS(SELECT 1 FROM uncollected_products WHERE source_order_id = ${orderId} AND status = 'resumed')
      AND EXISTS(SELECT 1 FROM uncollected_products WHERE source_order_id = ${orderId} AND status != 'resumed')
  `)?.found)
}

export function assertResumedOrderFulfilmentReady(orderId: number): void {
  if (resumedOrderFulfilmentBlocked(orderId))
    throw new AppError('CONFLICT', 'حالة منتجات الطلب الأصلي غير مكتملة؛ لا يمكن إصدار إذن الخروج أو إتمام التسليم')
}

export function resumeOriginalOrder(
  input: { id: number; confirmation: string; requestKey: string; expectedProductIds: number[] }, ctx: ServiceContext
): { orderId: number; documentNumber: string; idempotent: boolean; resumedProductIds: number[] } {
  requirePermission(ctx.session, P.uncollectedProducts.resume)
  if (!input.requestKey?.trim()) throw new AppError('VALIDATION_ERROR', 'معرّف طلب الاستئناف مطلوب')
  return withImmediateTransaction(() => {
    const db = getDatabase()
    const product = db.select().from(uncollectedProducts).where(eq(uncollectedProducts.id, input.id)).get()
    if (!product) throw notFound('المنتج غير المستلم غير موجود')
    const order = db.select().from(orders).where(eq(orders.id, product.sourceOrderId)).get()
    if (!order) throw notFound('الطلب الأصلي غير موجود')
    if (input.confirmation !== order.documentNumber)
      throw new AppError('VALIDATION_ERROR', 'رقم الطلب الأصلي لا يطابق تأكيد الاستئناف')
    const products = originalOrderProducts(order.id)
    const productIds = products.map(row => row.id)
    if (!Array.isArray(input.expectedProductIds) || input.expectedProductIds.length !== productIds.length
      || new Set(input.expectedProductIds).size !== productIds.length
      || productIds.some(id => !input.expectedProductIds.includes(id)))
      throw new AppError('CONFLICT', 'تغيرت قائمة منتجات الطلب؛ حدّث الصفحة وأكد استئناف جميع المنتجات')
    const requestKey = input.requestKey.trim()
    // The initiating row owns the unique key; every product retains an append-only audit.
    const previousAudit = db.get<{ productId: number }>(sql`
      SELECT COALESCE(json_extract(details, '$.initiatingProductId'), CAST(entity_id AS INTEGER)) AS productId
      FROM audit_log WHERE action = 'uncollectedProducts.resume'
        AND json_valid(details) AND json_extract(details, '$.requestKey') = ${requestKey} LIMIT 1
    `)
    if (previousAudit && (previousAudit.productId !== product.id
      || product.resumeRequestKey !== requestKey || product.status !== 'resumed'))
      throw new AppError('CONFLICT', 'طلب الاستئناف سبق استخدامه؛ يلزم تأكيد جديد بعد تغير حالة المنتج')
    const previous = db.select().from(uncollectedProducts).where(eq(uncollectedProducts.resumeRequestKey, requestKey)).get()
    if (previous) {
      if (previous.id !== product.id || products.some(row => row.status !== 'resumed')
        || order.status !== 'confirmed' || order.archivedAt)
        throw new AppError('CONFLICT', 'طلب الاستئناف سبق استخدامه أو تغيرت حالة المنتج؛ حدّث الصفحة')
      return { orderId: order.id, documentNumber: order.documentNumber, idempotent: true,
        resumedProductIds: productIds }
    }
    const blocker = orderResumeBlocker(products)
    if (blocker) throw new AppError('CONFLICT', blocker)
    const resumedAt = nowIso()
    for (const row of products) {
      const changed = db.update(uncollectedProducts)
        .set({ status: 'resumed', resumedAt, resumedBy: ctx.session.user.id,
          resumeRequestKey: row.id === product.id ? requestKey : null })
        .where(and(eq(uncollectedProducts.id, row.id), eq(uncollectedProducts.status, 'available'))).run().changes
      if (changed !== 1) throw new AppError('CONFLICT', 'تغيرت حالة المنتج؛ حدّث الصفحة ثم حاول مجدداً')
    }
    const position = orderPaymentPosition(order.id)
    // Retain cancellation metadata and its audit. Only operational status/payment caches refresh.
    db.update(orders).set({ status: 'confirmed', paidMinor: position.paidMinor,
      remainingMinor: position.remainingMinor,
      paymentStatus: paymentStatusFor(order.totalMinor, position.paidMinor, order.depositRequiredMinor) })
      .where(eq(orders.id, order.id)).run()
    for (const row of products) {
      recordAuditEvent({ userId: ctx.session.user.id, action: 'uncollectedProducts.resume',
        entity: 'uncollected_products', entityId: String(row.id), details: {
          productId: row.id, initiatingProductId: product.id, resumedProductIds: productIds,
          sourceOrderId: order.id, sourceOrderNumber: order.documentNumber,
          sourceOrderLineId: row.sourceOrderLineId, sourceWorkSheetId: row.sourceWorkSheetId,
          previousStatus: row.status, resultingStatus: 'resumed', previousOrderStatus: order.status,
          resultingOrderStatus: 'confirmed', originalCancelledAt: order.cancelledAt, resumedAt, requestKey
        } })
    }
    recordAuditEvent({ userId: ctx.session.user.id, action: 'orders.resume', entity: 'orders',
      entityId: String(order.id), details: {
        productId: product.id, resumedProductIds: productIds,
        sourceOrderLineIds: products.map(row => row.sourceOrderLineId),
        sourceWorkSheetIds: [...new Set(products.map(row => row.sourceWorkSheetId))],
        previousStatus: 'cancelled', resultingStatus: 'confirmed',
        originalCancelledAt: order.cancelledAt, resumedAt, requestKey
      } })
    return { orderId: order.id, documentNumber: order.documentNumber, idempotent: false,
      resumedProductIds: productIds }
  })
}

export interface TransferOutcome {
  /** Ids created by this transfer, in line order. */
  productIds: number[]
  /** Why nothing was created, when nothing was. */
  skippedReason?: 'not_manufactured' | 'already_fulfilled' | 'no_manufactured_items'
}

/**
 * Did the factory actually build this order?
 *
 * The authoritative signal is a manufacturing order that reached
 * `completed` and was not reversed — planning, issuing or starting one
 * is not manufacturing, and a reversed one explicitly un-did its own
 * effects.
 */
function manufacturingWorkSheet(orderId: number): { id: number; documentNumber: string } | undefined {
  return getDatabase()
    .select({ id: workSheets.id, documentNumber: workSheets.documentNumber })
    .from(workSheets)
    .where(
      and(
        eq(workSheets.orderId, orderId),
        eq(workSheets.status, 'completed'),
        sql`${workSheets.reversedAt} IS NULL`,
        sql`${workSheets.startedAt} IS NOT NULL`,
        sql`${workSheets.completedAt} IS NOT NULL`
      )
    )
    .orderBy(workSheets.id)
    .get()
}

/** Has any part of this order already reached the customer? */
function hasReachedCustomer(orderId: number): boolean {
  return Boolean(
    getDatabase()
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(and(eq(deliveries.orderId, orderId), eq(deliveries.status, 'recorded')))
      .get()
  )
}

/**
 * Splits the order's authoritative ACTUAL cost across the manufactured
 * items it produced.
 *
 * The ERP attributes actual cost at ORDER level only (materials,
 * machines, workers, delivery and linked expenses are all recorded
 * against the order, never against one of its items), so an order that
 * produced several items has no per-item cost to read. Rather than
 * inventing one, this allocates deterministically and records which
 * rule was used on every row:
 *
 *  • one manufactured item  → it carries the whole actual order cost;
 *  • several                → each takes its share of the manufactured
 *    items' own selling value (relative sales value — a standard joint
 *    cost allocation, never an equal split), and the rounding remainder
 *    goes to the largest share first so the parts add back to the order
 *    total to the minor unit;
 *  • no selling value at all → nothing is claimed, rather than guessed.
 */
export function attributeActualCost(
  totalActualCostMinor: number,
  lineTotals: number[]
): { amounts: number[]; method: string } {
  requireSafeNonNegativeInteger(totalActualCostMinor, 'التكلفة الفعلية')
  for (const total of lineTotals) requireSafeNonNegativeInteger(total, 'قيمة البند')
  if (lineTotals.length === 0) return { amounts: [], method: 'unattributable' }
  if (lineTotals.length === 1) {
    return { amounts: [totalActualCostMinor], method: 'sole_manufactured_item' }
  }
  const basis = lineTotals.reduce((sum, value) => sum + BigInt(value), 0n)
  if (basis <= 0n) {
    return { amounts: lineTotals.map(() => 0), method: 'unattributable' }
  }
  // Floor each share, then hand the remaining minor units out
  // largest-share-first: deterministic, and the parts always sum to the
  // whole so no cost is created or lost by rounding.
  const numerators = lineTotals.map((total) => BigInt(totalActualCostMinor) * BigInt(total))
  const amounts = numerators.map((value) => Number(value / basis))
  let remainder = totalActualCostMinor - amounts.reduce((sum, value) => sum + value, 0)
  const order = numerators
    .map((value, index) => ({ index, fraction: value % basis, total: lineTotals[index]! }))
    .sort((a, b) => a.fraction === b.fraction
      ? b.total - a.total || a.index - b.index
      : a.fraction > b.fraction ? -1 : 1)
  for (const entry of order) {
    if (remainder <= 0) break
    amounts[entry.index] = amounts[entry.index]! + 1
    remainder -= 1
  }
  return { amounts, method: 'relative_sales_value' }
}

/**
 * BL-03: the three economic values of one physical product.
 *
 *  actual         — its persisted share of the source order's authoritative
 *                   actual cost (cost_basis_minor). Never rewritten by resale.
 *  customerCovered — the part of it paid for by money the original customer
 *                   RETAINED (receipts − refunds, the live customer ledger).
 *  factoryBorne   — actual − customerCovered: what resale still has to earn back.
 *
 * Retained money is order-level. It covers at most the order's total actual
 * cost, and that covered total is spread over the order's products with the
 * same largest-remainder rule that spread the cost itself, weighted by each
 * product's cost — so no product is covered above its own cost and the
 * covered parts add up exactly. Nothing is persisted: cost bases are frozen
 * rows and a cancelled order's ledger can no longer change, so the figures
 * are reproducible at any later time.
 */
export interface ProductEconomics {
  actualCostMinor: number
  customerCoveredMinor: number
  factoryBorneMinor: number
  /** Expenses recorded against this product to prepare it for resale. */
  preparationCostMinor: number
  /** False only for a legacy multi-item order whose cost was unattributable. */
  known: boolean
}

interface EconomicsRow {
  id: number
  sourceOrderId: number
  status: string
  soldOrderId: number | null
  costBasisMinor: number
  costBasisMethod: string
  costBasisOrderTotalMinor: number
  retainedMinor: number
  preparationMinor: number
  soldHere: number
  sourceHere: number
}

/** One statement: every product of every source order any matching product belongs to. */
function economicsRows(match: SQL, orderIds: SQL = sql`SELECT NULL`): EconomicsRow[] {
  return getDatabase().all<EconomicsRow>(sql`
    SELECT p.id, p.source_order_id AS sourceOrderId, p.status, p.sold_order_id AS soldOrderId,
      p.cost_basis_minor AS costBasisMinor, p.cost_basis_method AS costBasisMethod,
      p.cost_basis_order_total_minor AS costBasisOrderTotalMinor,
      MAX(COALESCE((SELECT SUM(amount_minor) FROM customer_payments WHERE order_id = p.source_order_id), 0)
        - COALESCE((SELECT SUM(amount_minor) FROM customer_payment_refunds WHERE order_id = p.source_order_id), 0), 0) AS retainedMinor,
      COALESCE((SELECT SUM(e.amount_minor) FROM expenses e WHERE e.uncollected_product_id = p.id), 0) AS preparationMinor,
      p.status = 'sold' AND p.sold_order_id IN (${orderIds}) AS soldHere,
      p.status = 'resumed' AND p.source_order_id IN (${orderIds}) AS sourceHere
    FROM uncollected_products p
    WHERE p.source_order_id IN (SELECT u.source_order_id FROM uncollected_products u WHERE ${match})
    ORDER BY p.source_order_id, p.id
  `)
}

function economicsOf(rows: EconomicsRow[]): Map<number, ProductEconomics> {
  const result = new Map<number, ProductEconomics>()
  const groups = new Map<number, EconomicsRow[]>()
  for (const row of rows) groups.set(row.sourceOrderId, [...(groups.get(row.sourceOrderId) ?? []), row])
  for (const group of groups.values()) {
    const known = !group.some((row) => row.costBasisMethod === 'unattributable' && row.costBasisOrderTotalMinor > 0)
    const costs = group.map((row) => row.costBasisMinor)
    const covered = attributeActualCost(
      Math.min(costs.reduce((sum, cost) => sum + cost, 0), group[0]!.retainedMinor),
      costs
    ).amounts
    group.forEach((row, index) => result.set(row.id, {
      actualCostMinor: row.costBasisMinor,
      customerCoveredMinor: covered[index] ?? 0,
      factoryBorneMinor: row.costBasisMinor - (covered[index] ?? 0),
      preparationCostMinor: row.preparationMinor,
      known
    }))
  }
  return result
}

export function productEconomics(productId: number): ProductEconomics | undefined {
  return economicsOf(economicsRows(sql`u.id = ${productId}`)).get(productId)
}

/** One realized retained margin per cancelled, actually manufactured source order.
 * The physical transfer and its frozen cost basis, rather than cancellation or
 * receipt alone, own recognition. A resumed order has no active event; if it is
 * cancelled again, the later cancellation is the new transfer event. */
export const retainedMarginEvents = sql`
  SELECT o.id AS order_id,
    MAX(MAX(p.transferred_at), o.cancelled_at) AS occurred_at,
    MAX(COALESCE((SELECT SUM(amount_minor) FROM customer_payments WHERE order_id = o.id), 0)
      - COALESCE((SELECT SUM(amount_minor) FROM customer_payment_refunds WHERE order_id = o.id), 0)
      - SUM(p.cost_basis_minor), 0) AS profit_minor
  FROM orders o
  JOIN uncollected_products p ON p.source_order_id = o.id AND p.status IN ('available', 'reserved', 'sold')
  JOIN order_lines l ON l.id = p.source_order_line_id AND l.order_id = o.id
    AND l.line_kind = 'custom' AND l.superseded_at IS NULL AND l.uncollected_product_id IS NULL
  JOIN work_sheets w ON w.id = p.source_work_sheet_id AND w.order_id = o.id
    AND w.status = 'completed' AND w.started_at IS NOT NULL AND w.reversed_at IS NULL
  WHERE o.status = 'cancelled' AND o.cancelled_at IS NOT NULL
  GROUP BY o.id
  HAVING COUNT(DISTINCT p.source_order_line_id) = (
    SELECT COUNT(*) FROM order_lines eligible WHERE eligible.order_id = o.id
      AND eligible.line_kind = 'custom' AND eligible.superseded_at IS NULL
      AND eligible.uncollected_product_id IS NULL
  ) AND SUM(p.cost_basis_minor) = MAX(p.cost_basis_order_total_minor)
`

/**
 * BL-03 resale cost of goods per order, for the orders `orderIds` (a subquery)
 * yields. A product sold on an order charges it its factory-borne cost plus its
 * preparation cost; a resumed product's preparation cost belongs to its source
 * order, which now carries the whole manufacture again. One statement.
 */
export function resaleCostsForOrders(orderIds: SQL): Map<number, ResaleCost> {
  const rows = economicsRows(sql`u.sold_order_id IN (${orderIds}) OR u.source_order_id IN (${orderIds})`, orderIds)
  const economics = economicsOf(rows)
  const byOrder = new Map<number, ResaleCost>()
  for (const row of rows) {
    const orderId = row.soldHere ? row.soldOrderId! : row.sourceHere ? row.sourceOrderId : undefined
    if (orderId === undefined) continue
    const item = economics.get(row.id)!
    const total = byOrder.get(orderId) ?? { factoryBorneMinor: 0, preparationMinor: 0 }
    if (row.soldHere) total.factoryBorneMinor += item.factoryBorneMinor
    total.preparationMinor += item.preparationCostMinor
    byOrder.set(orderId, total)
  }
  return byOrder
}

/**
 * BL-03: a resale-preparation cost may be recorded, corrected or removed only
 * while the product is still on the shelf. Once it is sold (its cost of goods
 * recognised on the buyer's order) or resumed (recognised on its source
 * order), the figure is historical.
 */
export function assertPreparationCostEditable(productId: number): void {
  const product = getDatabase().select().from(uncollectedProducts).where(eq(uncollectedProducts.id, productId)).get()
  if (!product) throw notFound('المنتج غير المستلم غير موجود')
  if (product.status !== 'available' && product.status !== 'reserved')
    throw new AppError('CONFLICT', 'لا يمكن تعديل تكلفة تجهيز منتج تم بيعه أو استئنافه')
}

export interface ResaleCost { factoryBorneMinor: number; preparationMinor: number }
export const NO_RESALE_COST: ResaleCost = { factoryBorneMinor: 0, preparationMinor: 0 }

/**
 * Copies one order item's frozen material/colour/accessory selections
 * onto the new product, preserving the Material → Colours grouping.
 * Only server-read snapshots are written, so the physical product keeps
 * the wording it was built with even if a catalog is renamed later.
 */
function copySelections(productId: number, selections: ItemSelections): void {
  const db = getDatabase()
  const materialRowIds = new Map<ItemMaterialSelection, number>()
  selections.selectedMaterials.forEach((material, position) => {
    const id = Number(
      db
        .insert(uncollectedProductMaterials)
        .values({ productId, materialId: material.materialId, position, nameSnapshot: material.name })
        .run().lastInsertRowid
    )
    materialRowIds.set(material, id)
  })

  // A colour keeps its grouping when it belongs to one of the copied
  // materials; anything the source never grouped stays ungrouped.
  const owner = new Map<ColorSelection, number>()
  for (const material of selections.selectedMaterials) {
    for (const color of material.colors ?? []) owner.set(color, materialRowIds.get(material)!)
  }
  const seen = new Set<string>()
  let position = 0
  const writeColor = (color: ColorSelection, materialSelectionId: number | null): void => {
    const key = JSON.stringify([color.colorId, color.code, color.name])
    if (seen.has(key)) return
    seen.add(key)
    db.insert(uncollectedProductColors)
      .values({
        productId,
        materialSelectionId,
        colorId: color.colorId,
        position: position++,
        codeSnapshot: color.code,
        nameSnapshot: color.name
      })
      .run()
  }
  for (const material of selections.selectedMaterials) {
    for (const color of material.colors ?? []) writeColor(color, materialRowIds.get(material)!)
  }
  for (const color of selections.selectedColors) writeColor(color, owner.get(color) ?? null)

  selections.selectedAccessories.forEach((accessory, index) => {
    db.insert(uncollectedProductAccessories)
      .values({
        productId,
        materialId: accessory.materialId,
        position: index,
        nameSnapshot: accessory.name
      })
      .run()
  })
}

/**
 * THE TRANSFER. Both cancellation and later worksheet completion call this
 * inside their transaction, so the relevant transition and output land together.
 *
 * Creates one product per manufactured item. Safe to re-enter: the
 * UNIQUE `source_order_line_id` makes a retry a no-op rather than a
 * duplicate.
 */
export function transferManufacturedProducts(
  input: { orderId: number; cancelReason: string },
  ctx: ServiceContext,
  loadSelections: (lines: Array<{ id: number } & Record<string, unknown>>) => Array<ItemSelections & { id: number }>
): TransferOutcome {
  if (!hasPermission(ctx.session, P.orders.cancel)) requirePermission(ctx.session, P.worksheets.issue)
  if (!getRawConnection().inTransaction)
    throw new AppError('CONFLICT', 'نقل المنتج يتطلب معاملة إلغاء الطلب أو إكمال التصنيع')
  const db = getDatabase()
  const order = db.select().from(orders).where(eq(orders.id, input.orderId)).get()
  if (!order) throw notFound('الطلب غير موجود')
  if (order.status !== 'cancelled') throw new AppError('CONFLICT', 'الطلب غير ملغى')

  // CASE C — anything already delivered/installed/handed over is with
  // the customer; it is not ours to resell.
  if (hasReachedCustomer(order.id)) return { productIds: [], skippedReason: 'already_fulfilled' }

  // CASE A — nothing was actually built.
  const sheet = manufacturingWorkSheet(order.id)
  if (!sheet) return { productIds: [], skippedReason: 'not_manufactured' }

  const eligible = db
    .select()
    .from(orderLines)
    .where(eq(orderLines.orderId, order.id))
    .orderBy(orderLines.id)
    .all()
    .filter(isManufacturableOrderLine)

  if (!eligible.length) return { productIds: [], skippedReason: 'no_manufactured_items' }

  // The owner reads authoritative actual costs; caller-supplied economic fields are not an input.
  const cost = orderCostBreakdown(order.id)
  const resale = resaleCostsForOrders(sql`SELECT ${order.id}`).get(order.id) ?? NO_RESALE_COST
  const actualCostMinor = cost.totalActualCostMinor - resale.factoryBorneMinor - resale.preparationMinor
  const costComponents = {
    materialMinor: cost.materialCostMinor - resale.factoryBorneMinor,
    machineMinor: cost.machineCostMinor, workerMinor: cost.workerCostMinor,
    deliveryMinor: cost.deliveryCostMinor, expenseMinor: cost.linkedExpensesMinor - resale.preparationMinor
  }

  // Cost is attributed across ALL eligible manufactured items, so a
  // partial re-run can never inflate an item's share.
  const { amounts, method } = attributeActualCost(
    actualCostMinor,
    eligible.map((line) => line.lineTotalMinor)
  )
  const shareByLine = new Map(eligible.map((line, index) => [line.id, amounts[index] ?? 0]))
  const costFields = (share: number) => ({
    costBasisMinor: share,
    costBasisMethod: method,
    costBasisOrderTotalMinor: actualCostMinor,
    costBasisMaterialMinor: actualCostMinor > 0
      ? multiplyDivideRounded(costComponents.materialMinor, share, actualCostMinor) : 0,
    costBasisMachineMinor: actualCostMinor > 0
      ? multiplyDivideRounded(costComponents.machineMinor, share, actualCostMinor) : 0,
    costBasisWorkerMinor: actualCostMinor > 0
      ? multiplyDivideRounded(costComponents.workerMinor, share, actualCostMinor) : 0,
    costBasisDeliveryMinor: actualCostMinor > 0
      ? multiplyDivideRounded(costComponents.deliveryMinor, share, actualCostMinor) : 0,
    costBasisExpenseMinor: actualCostMinor > 0
      ? multiplyDivideRounded(costComponents.expenseMinor, share, actualCostMinor) : 0
  })

  // A later explicit cancellation returns only reclaimed outputs to the shelf;
  // their frozen snapshots/source IDs and all earlier audit events survive.
  // BL-03: the resumed order may have gained or shed cost meanwhile, so the
  // returned product carries the order's actual cost as of THIS cancellation.
  if (order.status === 'cancelled') {
    for (const product of db.select().from(uncollectedProducts)
      .where(and(eq(uncollectedProducts.sourceOrderId, order.id), eq(uncollectedProducts.status, 'resumed'))).all()) {
      const cost = costFields(shareByLine.get(product.sourceOrderLineId) ?? 0)
      db.update(uncollectedProducts).set({ status: 'available', ...cost })
        .where(and(eq(uncollectedProducts.id, product.id), eq(uncollectedProducts.status, 'resumed'))).run()
      recordAuditEvent({ userId: ctx.session.user.id, action: 'uncollectedProducts.returnAfterResume',
        entity: 'uncollected_products', entityId: String(product.id), details: {
          sourceOrderId: order.id, sourceOrderLineId: product.sourceOrderLineId,
          sourceWorkSheetId: product.sourceWorkSheetId, previousStatus: 'resumed', resultingStatus: 'available',
          previousCostBasisMinor: product.costBasisMinor, costBasisMinor: cost.costBasisMinor,
          cancelReason: input.cancelReason, cancelledAt: order.cancelledAt
        } })
    }
  }

  // Idempotency: whatever this order already transferred stays as it is.
  const existing = new Set(
    db
      .select({ lineId: uncollectedProducts.sourceOrderLineId })
      .from(uncollectedProducts)
      .where(eq(uncollectedProducts.sourceOrderId, order.id))
      .all()
      .map((row) => row.lineId)
  )
  const pending = eligible.filter((line) => !existing.has(line.id))
  if (!pending.length) return { productIds: [] }

  const selections = new Map(
    loadSelections(pending as unknown as Array<{ id: number } & Record<string, unknown>>).map((row) => [
      row.id,
      row
    ])
  )
  const transferredAt = nowIso()
  const productIds: number[] = []

  for (const line of pending) {
    const share = shareByLine.get(line.id) ?? 0
    // The components are reported at the same share as the total they
    // add up to, so the breakdown always explains the basis figure.
    const productId = Number(
      db
        .insert(uncollectedProducts)
        .values({
          sourceOrderId: order.id,
          sourceOrderNumber: order.documentNumber,
          sourceOrderLineId: line.id,
          sourceInvoiceId: order.finalInvoiceId ?? null,
          sourceWorkSheetId: sheet.id,
          sourceWorkSheetNumber: sheet.documentNumber,
          name: line.description,
          description: line.description,
          specifications: line.specifications,
          dimensions: line.dimensions,
          quantityMicro: line.quantityMicro,
          originalUnitPriceMinor: line.unitPriceMinor,
          originalLineTotalMinor: line.lineTotalMinor,
          ...costFields(share),
          status: 'available',
          transferredAt,
          transferredBy: ctx.session.user.id,
          cancelReason: input.cancelReason,
          createdAt: transferredAt
        })
        .run().lastInsertRowid
    )
    const lineSelections = selections.get(line.id)
    if (lineSelections) copySelections(productId, lineSelections)
    productIds.push(productId)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'uncollectedProducts.transfer',
      entity: 'uncollected_products',
      entityId: String(productId),
      details: {
        sourceOrderId: order.id,
        sourceOrderNumber: order.documentNumber,
        sourceOrderLineId: line.id,
        sourceWorkSheetId: sheet.id,
        name: line.description,
        costBasisMinor: share,
        costBasisMethod: method,
        cancelReason: input.cancelReason
      }
    })
  }

  return { productIds }
}

// ─────────────────────────────────────────── reading

export interface UncollectedProductFilter {
  search?: string
  status?: UncollectedStatus
  /** Narrows to what one cancelled Customer Order produced. */
  sourceOrderId?: number
}

const MAX_PAGE = 100

/**
 * Everything on a product that is an INTERNAL figure: what it cost the
 * factory to build, and the prices it has carried. None of it leaves
 * main for a session without `uncollectedProducts.viewCost` — it is
 * absent from the payload, not merely hidden by the renderer.
 */
const INTERNAL_MONEY_FIELDS = [
  'costBasisMinor',
  'costBasisMethod',
  'costBasisOrderTotalMinor',
  'costBasisMaterialMinor',
  'costBasisMachineMinor',
  'costBasisWorkerMinor',
  'costBasisDeliveryMinor',
  'costBasisExpenseMinor',
  'soldPriceMinor',
  'originalUnitPriceMinor',
  'originalLineTotalMinor'
] as const

const LIST_INTERNAL_MONEY_FIELDS = ['costBasisMinor', 'soldPriceMinor'] as const

function omit<T extends Record<string, unknown>>(
  row: T,
  fields: readonly string[]
): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) if (!fields.includes(key)) safe[key] = value
  return safe
}

/** Internal cost is a separate privilege from seeing the product. */
function maySeeCost(session?: AuthSession): boolean {
  return session ? hasPermission(session, P.uncollectedProducts.viewCost) : true
}

export function listUncollectedProducts(filter: UncollectedProductFilter = {}, session?: AuthSession, request: PageRequest = {}) {
  const normalized = { status: filter.status, sourceOrderId: filter.sourceOrderId, search: normalizedSearch(filter.search) }
  const clauses: SQL[] = []
  if (normalized.status) clauses.push(eq(uncollectedProducts.status, normalized.status))
  if (normalized.sourceOrderId) clauses.push(eq(uncollectedProducts.sourceOrderId, normalized.sourceOrderId))
  if (normalized.search) {
    const p = `%${normalized.search}%`
    clauses.push(or(like(uncollectedProducts.name, p), like(uncollectedProducts.sourceOrderNumber, p))!)
  }
  const where = clauses.length ? and(...clauses) : undefined
  // An unauthorised session never receives the internal figures — they
  // are absent from the payload, not merely hidden by the renderer.
  const visible = maySeeCost(session)
  return keysetPage({
    scope: 'uncollectedProducts.list',
    filters: normalized,
    request,
    defaultLimit: 25,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id as number],
    fetch: (window: KeysetWindow) => {
      const products = getDatabase()
        .select()
        .from(uncollectedProducts)
        .where(and(where, keysetBoundary([sql`${uncollectedProducts.id}`], window)))
        .orderBy(keysetOrder([sql`${uncollectedProducts.id}`], window))
        .limit(window.take)
        .all()
      const facts = batchResumeFacts(products.map((product) => product.sourceOrderId))
      const capabilities = new Map<number, ReturnType<typeof resumeCapabilities>>()
      return products.map((product): Record<string, unknown> => {
        const row = {
          id: product.id,
          name: product.name,
          sourceOrderId: product.sourceOrderId,
          sourceOrderNumber: product.sourceOrderNumber,
          dimensions: product.dimensions,
          quantityMicro: product.quantityMicro,
          status: product.status,
          transferredAt: product.transferredAt,
          costBasisMinor: product.costBasisMinor,
          soldInvoiceId: product.soldInvoiceId,
          soldOrderId: product.soldOrderId,
          soldAt: product.soldAt,
          soldPriceMinor: product.soldPriceMinor
        }
        // Capabilities are a property of the whole source order.
        const capability = capabilities.get(product.sourceOrderId) ?? resumeCapabilities(product, session, facts)
        capabilities.set(product.sourceOrderId, capability)
        return { ...(visible ? row : omit(row, LIST_INTERNAL_MONEY_FIELDS)), ...capability }
      })
    },
    summary: () => ({
      totalCount: getDatabase()
        .select({ count: sql<number>`COUNT(*)` })
        .from(uncollectedProducts)
        .where(where)
        .get()?.count ?? 0
    })
  })
}

/** The frozen specification, grouped Material → Colours for display. */
export function uncollectedProductSelections(productId: number): ItemSelections {
  const db = getRawConnection()
  const materials = db
    .prepare(
      'SELECT id, material_id, name_snapshot FROM uncollected_product_materials WHERE product_id = ? ORDER BY position'
    )
    .all(productId) as Array<{ id: number; material_id: number | null; name_snapshot: string }>
  const byRow = new Map<number, ItemMaterialSelection>()
  const selectedMaterials: ItemMaterialSelection[] = materials.map((row) => {
    const selection: ItemMaterialSelection = { materialId: row.material_id, name: row.name_snapshot, colors: [] }
    byRow.set(row.id, selection)
    return selection
  })
  const selectedColors: ColorSelection[] = []
  const colors = db
    .prepare(
      'SELECT material_selection_id, color_id, code_snapshot, name_snapshot FROM uncollected_product_colors WHERE product_id = ? ORDER BY position'
    )
    .all(productId) as Array<{
    material_selection_id: number | null
    color_id: number | null
    code_snapshot: string
    name_snapshot: string | null
  }>
  for (const row of colors) {
    const color: ColorSelection = { colorId: row.color_id, code: row.code_snapshot, name: row.name_snapshot }
    selectedColors.push(color)
    if (row.material_selection_id !== null) byRow.get(row.material_selection_id)?.colors!.push(color)
  }
  const selectedAccessories = (
    db
      .prepare(
        'SELECT material_id, name_snapshot FROM uncollected_product_accessories WHERE product_id = ? ORDER BY position'
      )
      .all(productId) as Array<{ material_id: number | null; name_snapshot: string }>
  ).map((row) => ({ materialId: row.material_id, name: row.name_snapshot }))

  return { selectedMaterials, selectedColors, selectedAccessories }
}

export function getUncollectedProduct(id: number, session?: AuthSession): Record<string, unknown> {
  const product = getDatabase()
    .select()
    .from(uncollectedProducts)
    .where(eq(uncollectedProducts.id, id))
    .get()
  if (!product) throw notFound('المنتج غير موجود')

  const selections = uncollectedProductSelections(id)
  const soldInvoice = product.soldInvoiceId
    ? getDatabase()
        .select({ id: finalInvoices.id, documentNumber: finalInvoices.documentNumber })
        .from(finalInvoices)
        .where(eq(finalInvoices.id, product.soldInvoiceId))
        .get()
    : undefined
  const soldOrder = product.soldOrderId
    ? getDatabase()
        .select({ id: orders.id, documentNumber: orders.documentNumber })
        .from(orders)
        .where(eq(orders.id, product.soldOrderId))
        .get()
    : undefined

  if (!maySeeCost(session))
    return { ...omit(product, INTERNAL_MONEY_FIELDS), ...selections, soldInvoice, soldOrder, ...resumeCapabilities(product, session) }
  // BL-03: actual / customer-covered / factory-borne, the preparation spent
  // before resale, and — once sold — what the resale really earned.
  const economics = productEconomics(id)!
  const preparationCosts = getDatabase().all<{ id: number; amountMinor: number; description: string; spentAt: string }>(sql`
    SELECT id, amount_minor AS amountMinor, description, spent_at AS spentAt
    FROM expenses WHERE uncollected_product_id = ${id} ORDER BY id
  `)
  const resaleProfitMinor = product.status === 'sold' && product.soldPriceMinor !== null
    ? product.soldPriceMinor - economics.factoryBorneMinor - economics.preparationCostMinor
    : null
  return { ...product, ...selections, soldInvoice, soldOrder, ...resumeCapabilities(product, session),
    economics, preparationCosts, resaleProfitMinor }
}

/** The picker source for a new sale: only what is genuinely sellable. */
export function availableUncollectedProducts(search?: string): Array<Record<string, unknown>> {
  const clauses = [eq(uncollectedProducts.status, 'available')]
  if (search?.trim()) {
    const p = `%${search.trim()}%`
    clauses.push(or(like(uncollectedProducts.name, p), like(uncollectedProducts.sourceOrderNumber, p))!)
  }
  return getDatabase()
    .select({
      id: uncollectedProducts.id,
      name: uncollectedProducts.name,
      sourceOrderNumber: uncollectedProducts.sourceOrderNumber,
      specifications: uncollectedProducts.specifications,
      dimensions: uncollectedProducts.dimensions,
      quantityMicro: uncollectedProducts.quantityMicro
    })
    .from(uncollectedProducts)
    .where(and(...clauses))
    .orderBy(desc(uncollectedProducts.id))
    .limit(MAX_PAGE)
    .all()
}

/** Traceability the cancelled Customer Order shows: what it produced. */
export function productsFromOrder(orderId: number): Array<{ id: number; name: string; status: string }> {
  return getDatabase()
    .select({ id: uncollectedProducts.id, name: uncollectedProducts.name, status: uncollectedProducts.status })
    .from(uncollectedProducts)
    .where(eq(uncollectedProducts.sourceOrderId, orderId))
    .orderBy(uncollectedProducts.id)
    .all()
}

// ─────────────────────────────────────────── resale lifecycle

/**
 * Risk 04: the order that bought an existing product was cancelled before it
 * reached the customer (cancelOrder refuses once fulfilment is recorded). The
 * SAME product returns to the shelf with its BL-03 lineage untouched; the
 * cancelled invoice line lets go of its one-line-per-product claim so a later
 * invoice can sell it. The order line keeps its link and the audit keeps the
 * attempted sale. Cancelled orders never recognise revenue or cost of goods.
 */
export function releaseCancelledResale(orderId: number, cancelReason: string, ctx: ServiceContext): number[] {
  requirePermission(ctx.session, P.orders.cancel)
  const order = getDatabase().select().from(orders).where(eq(orders.id, orderId)).get()
  if (!getRawConnection().inTransaction || order?.status !== 'cancelled' || order.completedAt || hasReachedCustomer(orderId))
    throw new AppError('CONFLICT', 'تحرير المنتج يتطلب معاملة إلغاء طلب البيع قبل التسليم')
  const db = getDatabase()
  const sold = db.select().from(uncollectedProducts)
    .where(and(eq(uncollectedProducts.soldOrderId, orderId), eq(uncollectedProducts.status, 'sold'))).all()
  for (const product of sold) {
    db.update(uncollectedProducts)
      .set({ status: 'available', reservedInvoiceId: null, soldInvoiceId: null, soldOrderId: null, soldAt: null, soldPriceMinor: null })
      .where(and(eq(uncollectedProducts.id, product.id), eq(uncollectedProducts.status, 'sold'))).run()
    db.run(sql`UPDATE final_invoice_lines SET uncollected_product_id = NULL WHERE uncollected_product_id = ${product.id}`)
    recordAuditEvent({ userId: ctx.session.user.id, action: 'uncollectedProducts.resaleCancelled',
      entity: 'uncollected_products', entityId: String(product.id), details: {
        orderId, invoiceId: product.soldInvoiceId, soldPriceMinor: product.soldPriceMinor,
        previousStatus: 'sold', resultingStatus: 'available', cancelReason
      } })
  }
  return sold.map((product) => product.id)
}

/** Validates an invoice line's claim before anything is written. */
export function assertSellable(productId: number, invoiceId: number | null): void {
  const product = getDatabase()
    .select()
    .from(uncollectedProducts)
    .where(eq(uncollectedProducts.id, productId))
    .get()
  if (!product) throw notFound('المنتج غير المستلم غير موجود')
  if (product.status === 'resumed') throw new AppError('CONFLICT', 'تم استئناف المنتج إلى طلبه الأصلي ولا يمكن بيعه')
  if (product.status === 'sold') {
    throw new AppError('CONFLICT', `المنتج "${product.name}" تم بيعه بالفعل ولا يمكن بيعه مرة أخرى`)
  }
  if (product.status === 'reserved' && product.reservedInvoiceId !== invoiceId) {
    throw new AppError('CONFLICT', `المنتج "${product.name}" محجوز على فاتورة أخرى`)
  }
  // BL-03: without an attributable cost the resale would silently carry zero cost of goods.
  if (product.costBasisMethod === 'unattributable' && product.costBasisOrderTotalMinor > 0)
    throw new AppError('CONFLICT', `لا يمكن بيع المنتج "${product.name}" لأن تكلفة تصنيعه الفعلية غير قابلة للنسب إليه`)
}

/** Read guard shared by the IPC handlers. */
export function requireUncollectedView(session: AuthSession): void {
  requirePermission(session, P.uncollectedProducts.view)
}
