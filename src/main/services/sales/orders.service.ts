import { orderPaymentPosition } from './final-invoices.service'
import {paymentHistoryRows, paymentHistoryOrder, type PaymentHistoryEntry} from './payment-history'
import {
  transferManufacturedProducts,
  resumedOrderFulfilmentBlocked,
  assertResumedOrderFulfilmentReady,
  releaseCancelledResale,
} from './uncollected-products.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { requirePermission } from '../../permissions/permission-guard'
import { loadItemSelections } from './item-selections.service'
import { and, eq, like, or, sql, type SQL } from 'drizzle-orm'
import {
  idList,
  keysetBoundary,
  keysetOrder,
  keysetPage,
  normalizedSearch,
  type KeysetWindow,
  type PageRequest
} from '../base/pagination'
import { getDatabase } from '../../db/connection'
import { withTransaction, withImmediateTransaction } from '../../db/transactions'
import {
  orders,
  orderLines,
  quotations,
  customerPayments,
  customerPaymentRefunds,
  customerPaymentRefundAllocations,
  finalInvoices
} from '../../db/schema/sales.schema'
import { customers } from '../../db/schema/parties.schema'
import { deliveries, orderWorkerAssignments, releases } from '../../db/schema/production.schema'
import { AppError, notFound } from '../../utils/errors'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, today, type ServiceContext } from '../base/service.types'
import { postCashMovement, removeCashMovementForRef } from '../finance/cash.service'
import { recordWorkerEarnings, reverseWorkerEarnings } from '../production/workers.service'
import {
  issueFromStock,
  orderFulfilledFromStock,
  reverseFinishedGoodsIssuesForOrder
} from '../production/finished-goods.service'
import { reverseCancelledOrderReleases } from '../production/release-reversal.internal'
import { getRawConnection } from '../../db/connection'
import { clearNotificationConditionState } from '../notifications/notification-state.service'
import {
  runIdempotentFinancialCommand,
  runOptionalIdempotentFinancialCommand
} from '../finance/idempotency.service'
import { isManufacturableOrderLine, isStandardStockLine } from './order-line-manufacturing'
import {
  completionKindForPermit,
  isExitPermitKind,
  legacyUnlinkedCompletionKindForPermit,
  type ExitPermitKind
} from '@shared/production/exit-permit'
import { manufacturingStartedSql } from '@shared/production/manufacturing-lifecycle'

export type PaymentStatus = 'unpaid' | 'partial' | 'deposit_met' | 'paid'

/** Public service boundary for consumers that must never trust cached order totals. */
export function authoritativeOrderPaymentPosition(orderId: number) {
  return orderPaymentPosition(orderId)
}

export function paymentStatusFor(
  totalMinor: number,
  paidMinor: number,
  depositRequiredMinor: number
): PaymentStatus {
  if (paidMinor <= 0) return 'unpaid'
  if (paidMinor >= totalMinor) return 'paid'
  if (paidMinor >= depositRequiredMinor) return 'deposit_met'
  return 'partial'
}


export interface OrderListFilter {
  archived?: boolean
  includeArchived?: boolean
  search?: string
  customerId?: number
  status?: string
  paymentStatus?: string
  from?: string
  to?: string
}

/** Bounded customer-order history, newest first, with batched action eligibility. */
export function listOrders(filter: OrderListFilter = {}, request: PageRequest = {}) {
  const normalized = {
    archived: filter.includeArchived ? undefined : Boolean(filter.archived),
    includeArchived: filter.includeArchived || undefined,
    search: normalizedSearch(filter.search),
    customerId: filter.customerId,
    status: filter.status,
    paymentStatus: filter.paymentStatus,
    from: filter.from,
    to: filter.to
  }
  const clauses: SQL[] = []
  if (!normalized.includeArchived)
    clauses.push(
      normalized.archived ? sql`${orders.archivedAt} IS NOT NULL` : sql`${orders.archivedAt} IS NULL`
    )
  // An unapproved invoice's order is out of the active workflow until reapproval.
  clauses.push(sql`${orders.status} != 'awaiting_approval'`)
  if (normalized.customerId) clauses.push(eq(orders.customerId, normalized.customerId))
  if (normalized.status) clauses.push(eq(orders.status, normalized.status))
  if (normalized.paymentStatus) clauses.push(eq(orders.paymentStatus, normalized.paymentStatus))
  if (normalized.from) clauses.push(sql`${orders.createdAt} >= ${normalized.from}`)
  if (normalized.to) clauses.push(sql`${orders.createdAt} <= ${normalized.to}`)
  if (normalized.search) {
    const p = `%${normalized.search}%`
    clauses.push(or(like(orders.documentNumber, p), like(customers.name, p))!)
  }
  return keysetPage({
    scope: 'orders.list',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => {
      const rows = getDatabase()
        .select({
          id: orders.id,
          documentNumber: orders.documentNumber,
          customerId: orders.customerId,
          customerName: customers.name,
          status: orders.status,
          archivedAt: orders.archivedAt,
          totalMinor: orders.totalMinor,
          depositRequiredMinor: orders.depositRequiredMinor,
          paidMinor: orders.paidMinor,
          remainingMinor: orders.remainingMinor,
          paymentStatus: orders.paymentStatus,
          requiresInstallation: orders.requiresInstallation,
          requiresDelivery: orders.requiresDelivery,
          completedAt: orders.completedAt,
          createdAt: orders.createdAt
        })
        .from(orders)
        .innerJoin(customers, eq(orders.customerId, customers.id))
        .where(and(...clauses, keysetBoundary([sql`${orders.id}`], window)))
        .orderBy(keysetOrder([sql`${orders.id}`], window))
        .limit(window.take)
        .all()
      const eligibility = orderActionEligibilities(rows)
      return rows.map((order) => ({ ...order, ...eligibility.get(order.id)! }))
    },
    summary: () => undefined
  })
}

/**
 * Every full-delete preview blocker, as one set-based predicate for orders
 * whose manufacturing was never issued. Kept structurally parallel to
 * fullDeletePreview; equivalence with the per-order preview is tested.
 */
function fullDeleteBlockedOrderIds(orderIds: number[]): Set<number> {
  // Every Customer Order is created by approving a commercial invoice.
  // Therefore every order is posted history even before payment or production.
  return new Set(orderIds)
}

/**
 * Batched equivalent of orderActionEligibility for one bounded page: a fixed
 * number of statements, identical business rules and the same live ledger.
 */
export function orderActionEligibilities(
  rows: Array<{ id: number; status: string; archivedAt: string | null }>
): Map<number, ReturnType<typeof orderActionEligibility>> {
  const result = new Map<number, ReturnType<typeof orderActionEligibility>>()
  if (!rows.length) return result
  const facts = new Map(
    getDatabase().all<{
      id: number; paidMinor: number; everIssued: number; refundBlocked: number; manufacturingCompleted: number
      manufacturingInProduction: number; activeManufacturing: number; recordedFulfilment: number
      fulfilledFromStock: number; resaleOnly: number
    }>(sql`
      SELECT o.id,
        COALESCE((SELECT SUM(amount_minor) FROM customer_payments WHERE order_id = o.id), 0)
          - COALESCE((SELECT SUM(amount_minor) FROM customer_payment_refunds WHERE order_id = o.id), 0) AS paidMinor,
        EXISTS (SELECT 1 FROM work_sheets WHERE order_id = o.id) AS everIssued,
        ${refundLifecycleBlockedSql(sql`o.id`)} AS refundBlocked,
        EXISTS (SELECT 1 FROM work_sheets WHERE order_id = o.id AND status = 'completed' AND reversed_at IS NULL) AS manufacturingCompleted,
        EXISTS (SELECT 1 FROM work_sheets WHERE order_id = o.id AND status = 'in_production'
          AND started_at IS NOT NULL) AS manufacturingInProduction,
        EXISTS (SELECT 1 FROM work_sheets WHERE order_id = o.id AND status != 'reversed') AS activeManufacturing,
        (${RESALE_ONLY}) AS resaleOnly,
        EXISTS (SELECT 1 FROM deliveries WHERE order_id = o.id AND status = 'recorded') AS recordedFulfilment,
        EXISTS (
          SELECT 1 FROM finished_goods_movements m
          WHERE m.order_id = o.id AND m.kind = 'sale_out'
            AND NOT EXISTS (SELECT 1 FROM finished_goods_movements r WHERE r.reversal_of_movement_id = m.id)
        ) AS fulfilledFromStock
      FROM orders o WHERE o.id IN (${idList(rows.map((row) => row.id))})
    `).map((row) => [row.id, row])
  )
  const deleteCandidates = rows.filter((order) => {
    const fact = facts.get(order.id)!
    return !order.archivedAt && order.status === 'confirmed' && fact.paidMinor === 0 && !fact.everIssued
  })
  const blocked = fullDeleteBlockedOrderIds(deleteCandidates.map((order) => order.id))
  for (const order of rows) {
    const fact = facts.get(order.id)!
    const payment = !order.archivedAt && order.status === 'confirmed' ? { paidMinor: fact.paidMinor } : null
    const manufacturingEverIssued = Boolean(fact.everIssued)
    result.set(order.id, {
      canDeleteCancel:
        payment !== null && payment.paidMinor === 0 && !manufacturingEverIssued && !blocked.has(order.id),
      canCancel:
        payment !== null &&
        payment.paidMinor >= 0 &&
        (Boolean(fact.manufacturingCompleted) || Boolean(fact.manufacturingInProduction) ||
          (!fact.activeManufacturing &&
            (Boolean(fact.fulfilledFromStock) ||
              (Boolean(fact.resaleOnly) && payment.paidMinor === 0)))) &&
        !fact.recordedFulfilment,
      canArchive: orderCanArchive(order),
      canRefundPayment: payment !== null && payment.paidMinor > 0 && !fact.refundBlocked,
      refundableMinor: Math.max(payment?.paidMinor ?? 0, 0)
    })
  }
  return result
}

/** Open customer orders for alerts: every active one, identity fields only. */
export function openOrderAlertRows(): Array<{ id: number; documentNumber: string; customerName: string; createdAt: string }> {
  return getDatabase().all(sql`
    SELECT o.id, o.document_number AS documentNumber, c.name AS customerName, o.created_at AS createdAt
    FROM orders o
    INNER JOIN customers c ON c.id = o.customer_id
    WHERE o.archived_at IS NULL AND o.status = 'confirmed'
    ORDER BY o.id DESC
  `)
}

/**
 * Every current line resells an existing Uncollected Product, so the order
 * has nothing to manufacture (issueWorkSheet refuses it) and was never issued.
 */
const RESALE_ONLY = sql.raw(`(SELECT COUNT(*) > 0 AND COUNT(*) = COUNT(uncollected_product_id)
    FROM order_lines WHERE order_id = o.id AND superseded_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM work_sheets WHERE order_id = o.id)`)

function resaleOnlyOrder(orderId: number): boolean {
  return Boolean(getDatabase().get<{ found: number }>(
    sql`SELECT 1 AS found FROM orders o WHERE o.id = ${orderId} AND ${RESALE_ONLY}`
  )?.found)
}

/** Issuance is historical: reversed/cancelled worksheets still cross this boundary. */
function manufacturingOrderEverIssued(orderId: number): boolean {
  return Boolean(
    getDatabase().get<{ found: number }>(sql`
    SELECT 1 AS found FROM work_sheets WHERE order_id = ${orderId} LIMIT 1
  `)?.found
  )
}

/** Historical reversal is safe; an active worksheet, actual start, or fulfillment is not. */
function refundLifecycleBlockedSql(orderId: number | SQL): SQL {
  return sql`(
    EXISTS (SELECT 1 FROM work_sheets w WHERE w.order_id = ${orderId}
      AND (w.status != 'reversed' OR ${sql.raw(manufacturingStartedSql('w'))}))
    OR EXISTS (SELECT 1 FROM releases WHERE order_id = ${orderId} AND status = 'active')
    OR EXISTS (SELECT 1 FROM deliveries WHERE order_id = ${orderId} AND status = 'recorded')
    OR EXISTS (SELECT 1 FROM finished_goods_movements m WHERE m.order_id = ${orderId}
      AND m.kind = 'sale_out' AND NOT EXISTS (
        SELECT 1 FROM finished_goods_movements r WHERE r.reversal_of_movement_id = m.id))
  )`
}

function refundLifecycleBlocked(orderId: number): boolean {
  return Boolean(getDatabase().get<{ blocked: number }>(sql`SELECT ${refundLifecycleBlockedSql(orderId)} AS blocked`)?.blocked)
}

/** Match the completed, unreversed worksheet boundary used by physical-product transfer. */
function manufacturingOrderCompleted(orderId: number): boolean {
  return Boolean(
    getDatabase().get<{ found: number }>(sql`
    SELECT 1 AS found FROM work_sheets
    WHERE order_id = ${orderId} AND status = 'completed' AND reversed_at IS NULL LIMIT 1
  `)?.found
  )
}

/** Internal customer manufacturing permits cancellation from start, while work continues. */
function manufacturingOrderInProduction(orderId: number): boolean {
  return Boolean(
    getDatabase().get<{ found: number }>(sql`
    SELECT 1 AS found FROM work_sheets
    WHERE order_id = ${orderId} AND status = 'in_production' AND started_at IS NOT NULL
    LIMIT 1
  `)?.found
  )
}

function activeManufacturingOrderExists(orderId: number): boolean {
  return Boolean(getDatabase().get(sql`
    SELECT 1 FROM work_sheets WHERE order_id = ${orderId} AND status != 'reversed' LIMIT 1
  `))
}

/** Recorded fulfilment must not become cancellable when the payment guard is removed. */
function orderHasRecordedFulfilment(orderId: number): boolean {
  return Boolean(
    getDatabase().get<{ found: number }>(sql`
    SELECT 1 AS found FROM deliveries WHERE order_id = ${orderId} AND status = 'recorded' LIMIT 1
  `)?.found
  )
}

export function assertOrderNotAwaitingApproval(order: { status: string }): void {
  if (order.status === 'awaiting_approval') throw new AppError('CONFLICT', 'الطلب بانتظار إعادة اعتماد الفاتورة؛ أعد اعتماد الفاتورة قبل أي عملية عليه')
}

export function orderCanArchive(order: { status: string; archivedAt: string | null }): boolean {
  return !order.archivedAt && (order.status === 'completed' || order.status === 'cancelled')
}

/** Business eligibility only; callers must also enforce the existing action permission. */
function orderActionEligibility(order: { id: number; status: string; archivedAt: string | null }) {
  const payment =
    !order.archivedAt && order.status === 'confirmed' ? orderPaymentPosition(order.id) : null
  const manufacturingEverIssued = manufacturingOrderEverIssued(order.id)
  const financiallyUnpaid = payment?.paidMinor === 0
  // The trash entry reaches the existing ordinary/full-delete workflow, so
  // its visibility also honours the same non-payment safety preview used by
  // that workflow.  Dependencies that the established full-delete path can
  // safely unwind are not blockers; genuine blockers remain hidden.
  const canEnterDeleteWorkflow =
    payment !== null &&
    financiallyUnpaid &&
    !manufacturingEverIssued &&
    fullDeletePreview(order.id).blockers.length === 0
  return {
    // This value is consumed by the list's destructive-action icon.  It is
    // intentionally based on the live receipt/refund ledger, not the cached
    // columns returned with the order row.  Other delete blockers are still
    // resolved by the existing preview before a delete can commit.
    canDeleteCancel: canEnterDeleteWorkflow,
    canCancel:
      payment !== null &&
      payment.paidMinor >= 0 &&
      (manufacturingOrderCompleted(order.id) || manufacturingOrderInProduction(order.id) ||
        (!activeManufacturingOrderExists(order.id) &&
          (orderFulfilledFromStock(order.id) ||
            (resaleOnlyOrder(order.id) && payment.paidMinor === 0)))) &&
      !orderHasRecordedFulfilment(order.id),
    canArchive: orderCanArchive(order),
    canRefundPayment: payment !== null && payment.paidMinor > 0 && !refundLifecycleBlocked(order.id),
    refundableMinor: Math.max(payment?.paidMinor ?? 0, 0)
  }
}

/** Re-read main-process state, never a renderer-supplied balance or badge. */
export function assertOrderDeleteCancelEligible(id: number) {
  const order = getOrderOrThrow(id)
  const payment = orderPaymentPosition(id)
  if (payment.paidMinor > 0) {
    throw new AppError('CONFLICT', 'لا يمكن حذف الطلب قبل استرداد كامل المبلغ المدفوع للعميل')
  }
  if (payment.paidMinor < 0) {
    throw new AppError('CONFLICT', 'لا يمكن حذف الطلب لوجود تعارض في صافي دفعات العميل')
  }
  if (manufacturingOrderEverIssued(id)) {
    throw new AppError('CONFLICT', 'لا يمكن حذف الطلب بعد إصدار أمر التصنيع. استخدم إلغاء الطلب')
  }
  if (order.archivedAt || order.status !== 'confirmed') {
    throw new AppError(
      'CONFLICT',
      'لا يمكن حذف الطلب إلا إذا كان طلباً مؤكداً غير مؤرشف وتسمح بقية ضوابط الحذف بذلك'
    )
  }
  return order
}

/** Cancellation requires real output or a started job explicitly closed without output. */
function assertOrderCancellationEligible(id: number) {
  const order = getOrderOrThrow(id)
  const fulfilledFromStock = orderFulfilledFromStock(id)
  // A resale-only order sells an existing product: it cancels without
  // manufacturing, but only once the resale customer is fully refunded.
  if (resaleOnlyOrder(id)) {
    if (orderPaymentPosition(id).paidMinor !== 0)
      throw new AppError('CONFLICT', 'يجب استرداد كامل المبلغ المدفوع للعميل قبل إلغاء طلب إعادة البيع')
  } else if (!manufacturingOrderEverIssued(id) && !fulfilledFromStock) {
    throw new AppError(
      'CONFLICT',
      'لا يمكن إلغاء الطلب قبل إصدار أمر التصنيع. استخدم حذف الطلب إذا كان مؤهلاً للحذف'
    )
  }
  if (activeManufacturingOrderExists(id)) {
    if (!manufacturingOrderCompleted(id) && !manufacturingOrderInProduction(id))
      throw new AppError('CONFLICT', 'لا يمكن إلغاء الطلب قبل بدء أمر التصنيع')
  } else if (!fulfilledFromStock && !resaleOnlyOrder(id)) {
    throw new AppError('CONFLICT', 'لا يمكن إلغاء الطلب قبل اكتمال أمر التصنيع')
  }
  if (orderPaymentPosition(id).paidMinor < 0) {
    throw new AppError('CONFLICT', 'لا يمكن إلغاء الطلب لوجود تعارض في صافي دفعات العميل')
  }
  if (orderHasRecordedFulfilment(id)) {
    throw new AppError('CONFLICT', 'لا يمكن إلغاء الطلب بعد تسجيل التسليم أو التركيب أو الاستلام')
  }
  if (!orderActionEligibility(order).canCancel) {
    throw new AppError('CONFLICT', 'لا يمكن إلغاء الطلب إلا إذا كان طلباً مؤكداً غير مؤرشف')
  }
  return order
}

export function getOrder(id: number) {
  const db = getDatabase()
  const order = db.select().from(orders).where(eq(orders.id, id)).get()
  if (!order) throw notFound('الطلب غير موجود')
  const currentCustomer = db
    .select()
    .from(customers)
    .where(eq(customers.id, order.customerId))
    .get()
  const identityInvoice = db
    .select({ snapshot: finalInvoices.snapshot })
    .from(finalInvoices)
    .where(eq(finalInvoices.orderId, id))
    .get()
  const frozenCustomer = identityInvoice?.snapshot
    ? (
        JSON.parse(identityInvoice.snapshot) as {
          customer?: { name: string; phone: string | null; address: string | null }
        }
      ).customer
    : undefined
  const customer =
    currentCustomer && frozenCustomer ? { ...currentCustomer, ...frozenCustomer } : currentCustomer

  // Persisted workflow facts travel with the ordinary order detail so
  // action visibility does not depend on the caller also having list
  // permissions for every downstream document module.
  const workflow = db.get<{
    manufacturingIssued: number
    manufacturingInProduction: number
    releaseIssued: number
    deliveryDone: number
    installationDone: number
    activeCompletion: number
  }>(sql`
    SELECT
      EXISTS(SELECT 1 FROM deliveries WHERE order_id = ${id} AND status = 'recorded') AS activeCompletion,
      EXISTS(SELECT 1 FROM work_sheets WHERE order_id = ${id} AND status != 'reversed') AS manufacturingIssued,
      EXISTS(SELECT 1 FROM work_sheets WHERE order_id = ${id} AND status = 'in_production' AND started_at IS NOT NULL) AS manufacturingInProduction,
      EXISTS(SELECT 1 FROM releases WHERE order_id = ${id} AND status = 'active') AS releaseIssued,
      EXISTS(
        SELECT 1 FROM deliveries
        WHERE order_id = ${id} AND status = 'recorded'
          AND kind IN ('delivery', 'delivery_installation', 'handover')
      ) AS deliveryDone,
      EXISTS(
        SELECT 1 FROM deliveries
        WHERE order_id = ${id} AND status = 'recorded'
          AND kind IN ('installation', 'delivery_installation')
      ) AS installationDone
  `)!
  const permit = db.get<{
    id: number
    kind: string
    address: string | null
  }>(sql`
    SELECT id, kind, address
    FROM releases
    WHERE order_id = ${id} AND status = 'active'
    ORDER BY id ASC
    LIMIT 1
  `)
  const permitWorkers = permit
    ? db.all<{ workerId: number; name: string }>(sql`
        SELECT rw.worker_id AS workerId, w.name AS name
        FROM release_workers rw
        JOIN workers w ON w.id = rw.worker_id
        WHERE rw.release_id = ${permit.id}
        ORDER BY w.name ASC
      `)
    : []
  const permitKind =
    permit && isExitPermitKind(permit.kind) ? (permit.kind as ExitPermitKind) : undefined
  const requiredKind = permitKind ? completionKindForPermit(permitKind) : undefined
  const legacyCompletionKind = permitKind ? legacyUnlinkedCompletionKindForPermit(permitKind) : null
  const completionExists =
    permit && requiredKind
      ? Boolean(
          db.get<{ found: number }>(sql`
        SELECT 1 AS found
        FROM deliveries
        WHERE status = 'recorded'
          AND (
            release_id = ${permit.id}
            OR (
              release_id IS NULL
              AND order_id = ${id}
              AND (kind = ${requiredKind} OR kind = ${legacyCompletionKind})
            )
          )
        LIMIT 1
      `)?.found
        )
      : false
  return {
    order,
    actions: orderActionEligibility(order),
    customer,
    workflow: {
      manufacturingIssued: Boolean(workflow.manufacturingIssued),
      manufacturingInProduction: Boolean(workflow.manufacturingInProduction),
      // BL-04: manufacturing/preparation only for custom lines; standard lines from ready stock.
      needsManufacturing: db.select().from(orderLines).where(eq(orderLines.orderId, id)).all().some(isManufacturableOrderLine),
      standardStockPending: standardStockPending(id),
      resumeFulfilmentBlocked: resumedOrderFulfilmentBlocked(id),
      releaseIssued: Boolean(workflow.releaseIssued),
      deliveryDone: Boolean(workflow.deliveryDone),
      installationDone: Boolean(workflow.installationDone),
      activeCompletion: Boolean(workflow.activeCompletion),
      requiredCompletion:
        permit && permitKind && !completionExists
          ? {
              releaseId: permit.id,
              permitKind,
              completionKind: requiredKind!,
              address: permit.address,
              workers: permitWorkers
            }
          : null
    },
    lines: loadItemSelections(
      'order',
      db
        .select()
        .from(orderLines)
        .where(and(eq(orderLines.orderId, id), sql`${orderLines.supersededAt} IS NULL`))
        .orderBy(orderLines.id)
        .all()
    ),
    payments: db.all<PaymentHistoryEntry>(sql`
      SELECT * FROM (${paymentHistoryRows('order', id)}) entries
      ORDER BY ${paymentHistoryOrder}
    `)
  }
}

export function getOrderOrThrow(id: number) {
  const order = getDatabase().select().from(orders).where(eq(orders.id, id)).get()
  if (!order) throw notFound('الطلب غير موجود')
  return order
}

/** All production decisions must use the currently approved commercial version. */
export function assertOrderOperational(id: number) {
  const order = getOrderOrThrow(id)
  if (order.archivedAt)
    throw new AppError('CONFLICT', 'استعد الطلب المؤرشف أولاً قبل تغيير دورة العمل')
  if (order.status === 'awaiting_approval')
    throw new AppError('CONFLICT', 'يجب إعادة اعتماد الفاتورة قبل متابعة دورة الطلب')
  if (order.finalInvoiceId) {
    const invoice = getDatabase()
      .select({ status: finalInvoices.status })
      .from(finalInvoices)
      .where(eq(finalInvoices.id, order.finalInvoiceId))
      .get()
    if (invoice?.status !== 'approved')
      throw new AppError('CONFLICT', 'الفاتورة غير معتمدة؛ أعد اعتمادها قبل متابعة دورة الطلب')
  }
  return order
}

export function archiveOrder(input: { id: number; archive: boolean }, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.orders.archive)
  withTransaction(() => {
    const order = getOrderOrThrow(input.id)
    if (Boolean(order.archivedAt) === input.archive)
      throw new AppError('CONFLICT', 'تم تغيير حالة الأرشفة بالفعل. حدّث القائمة')
    if (input.archive && !orderActionEligibility(order).canArchive)
      throw new AppError('CONFLICT', 'يمكن أرشفة طلب مكتمل أو ملغى فقط')
    const archivedAt = input.archive ? nowIso() : null
    getDatabase()
      .update(orders)
      .set({ archivedAt, archivedBy: input.archive ? ctx.session.user.id : null })
      .where(eq(orders.id, input.id))
      .run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: input.archive ? 'orders.archive' : 'orders.restore',
      entity: 'orders',
      entityId: String(input.id),
      details: {
        documentNumber: order.documentNumber,
        before: order.archivedAt,
        after: archivedAt,
        status: order.status
      }
    })
  })
}

/** Manual completion has its own undo; delivery-owned completion is undone in that module. */
export function reverseOrderCompletion(input: { id: number }, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.orders.complete)
  withTransaction(() => {
    const order = assertOrderOperational(input.id)
    if (!order.completedAt || order.status !== 'completed')
      throw new AppError('CONFLICT', 'الطلب غير مكتمل أو تم التراجع بالفعل')
    if (
      getDatabase().get(
        sql`SELECT id FROM deliveries WHERE order_id = ${input.id} AND status = 'recorded' LIMIT 1`
      )
    )
      throw new AppError('CONFLICT', 'تراجع عن عملية التسليم والتركيب من وحدتها أولاً')
    reverseWorkerEarnings(input.id, ctx)
    getDatabase()
      .update(orders)
      .set({ status: 'confirmed', completedAt: null })
      .where(eq(orders.id, input.id))
      .run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.completion.reverse',
      entity: 'orders',
      entityId: String(input.id),
      details: { before: order.completedAt, after: null, documentNumber: order.documentNumber }
    })
  })
}

/**
 * Correct a confirmed order's non-commercial fields (item 7 of the
 * sales-workflow pass: "edit the final invoice when business rules
 * permit it"). Pricing, lines, quantities and totals are deliberately
 * NOT editable here — commercial terms are frozen at approval and
 * owned by the Approved Invoice editor. Correction requires explicit
 * downstream reversals, invoice unapproval, normal editing and reapproval;
 * historical document revisions remain intact. Only address and notes
 * — pure corrections with no financial
 * or production consequence — may be corrected in place; nothing
 * here touches total/paid/remaining/customer balance/cash accounts,
 * so no recalculation is needed.
 */
export function updateOrder(
  id: number,
  input: { address?: string; notes?: string },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.orders.manage)
  return withTransaction(() => {
    const order = getOrderOrThrow(id)
    assertOrderNotAwaitingApproval(order)
    if (order.status === 'cancelled') {
      throw new AppError('CONFLICT', 'لا يمكن تعديل طلب ملغى')
    }

    getDatabase()
      .update(orders)
      .set({
        address: input.address ?? order.address,
        notes: input.notes ?? order.notes
      })
      .where(eq(orders.id, id))
      .run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.update',
      entity: 'orders',
      entityId: String(id),
      details: input
    })
  })
}

/** BR-81: record a customer payment and refresh the order's money state. */
export function recordPayment(
  input: {
    approvedInvoiceId?: number
    orderId: number
    amountMinor: number
    cashAccountId?: number
    paidAt?: string
    notes?: string
    requestKey?: string
  },
  ctx: ServiceContext
): { paidMinor: number; remainingMinor: number; paymentStatus: PaymentStatus } {
  requirePermission(ctx.session, P.payments.manage)
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new AppError('VALIDATION_ERROR', 'المبلغ يجب أن يكون أكبر من صفر')

  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope:
      input.approvedInvoiceId === undefined
        ? 'orders.recordPayment'
        : 'finalInvoices.initialPayment',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        const db = getDatabase()
        const order = getOrderOrThrow(input.orderId)
        if (input.approvedInvoiceId !== undefined) {
          const invoice = db
            .select()
            .from(finalInvoices)
            .where(eq(finalInvoices.id, input.approvedInvoiceId))
            .get()
          if (
            !invoice ||
            invoice.status !== 'draft' ||
            invoice.orderId !== null ||
            order.finalInvoiceId !== invoice.id ||
            order.customerId !== invoice.customerId ||
            input.amountMinor !== invoice.paidAmountMinor ||
            (input.cashAccountId ?? null) !== invoice.initialCashAccountId
          )
            throw new AppError('CONFLICT', 'مصدر دفعة اعتماد الفاتورة غير صالح أو تم ترحيله بالفعل')
        }
        assertOrderNotAwaitingApproval(order)
        if (order.status === 'cancelled') {
          throw new AppError('CONFLICT', 'لا يمكن تسجيل دفعة على طلب ملغى')
        }
        const before = orderPaymentPosition(order.id)
        if (input.amountMinor > before.remainingMinor) {
          throw new AppError('VALIDATION_ERROR', 'المبلغ أكبر من الرصيد المتبقي على الطلب')
        }

        const paymentId = Number(
          db
            .insert(customerPayments)
            .values({
              orderId: order.id,
              customerId: order.customerId,
              approvedInvoiceId: input.approvedInvoiceId ?? null,
              amountMinor: input.amountMinor,
              cashAccountId: input.cashAccountId ?? null,
              paidAt: input.paidAt ?? today(),
              notes: input.notes ?? null,
              createdBy: ctx.session.user.id,
              createdAt: nowIso()
            })
            .run().lastInsertRowid
        )

        const paidMinor = before.paidMinor + input.amountMinor
        const remainingMinor = order.totalMinor - paidMinor
        const paymentStatus = paymentStatusFor(
          order.totalMinor,
          paidMinor,
          order.depositRequiredMinor
        )

        db.update(orders)
          .set({ paidMinor, remainingMinor, paymentStatus })
          .where(eq(orders.id, order.id))
          .run()

        postCashMovement({
          accountId: input.cashAccountId,
          direction: 'in',
          amountMinor: input.amountMinor,
          kind: 'customer_payment',
          refTable: 'customer_payments',
          refId: paymentId,
          occurredAt: input.paidAt ?? today(),
          ctx
        })

        recordAuditEvent({
          userId: ctx.session.user.id,
          action: 'orders.payment',
          entity: 'customer_payments',
          entityId: String(paymentId),
          details: {
            orderId: order.id,
            amountMinor: input.amountMinor,
            paymentStatus,
            ...(input.approvedInvoiceId !== undefined
              ? { source: 'approved_invoice', sourceId: input.approvedInvoiceId }
              : {})
          }
        })

        return { paidMinor, remainingMinor, paymentStatus }
      })
  })
}

export interface RefundPaymentInput {
  orderId: number
  amountMinor: number
  cashAccountId: number
  requestKey: string
  refundedAt?: string
}

export interface RefundPaymentResult {
  refundId: number
  paidMinor: number
  remainingMinor: number
  paymentStatus: PaymentStatus
  idempotent: boolean
}

/** Remaining value of exact receipts after their persisted refund allocations. */
function refundablePayments(orderId: number): Array<{ id: number; remainingMinor: number }> {
  return getDatabase().all<{ id: number; remainingMinor: number }>(sql`
    SELECT p.id,
           p.amount_minor - COALESCE(SUM(a.amount_minor), 0) AS remainingMinor
    FROM customer_payments p
    LEFT JOIN customer_payment_refund_allocations a ON a.payment_id = p.id
    WHERE p.order_id = ${orderId}
    GROUP BY p.id, p.amount_minor
    HAVING remainingMinor > 0
    ORDER BY p.id ASC
  `)
}

/**
 * An append-only customer refund. It never edits/deletes the original receipt:
 * allocation rows bind the refund to exact payment IDs and one canonical
 * outward cash row records the real payout.
 */
export function refundPayment(input: RefundPaymentInput, ctx: ServiceContext): RefundPaymentResult {
  requirePermission(ctx.session, P.payments.refund)
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new AppError('VALIDATION_ERROR', 'مبلغ الاسترداد يجب أن يكون أكبر من صفر')
  if (!input.requestKey?.trim()) throw new AppError('VALIDATION_ERROR', 'معرّف طلب الاسترداد مطلوب')

  const { requestKey, ...payload } = input
  return runIdempotentFinancialCommand({
    commandScope: 'orders.refundPayment',
    requestKey,
    payload,
    ctx,
    validate: () => {
      const order = assertOrderOperational(input.orderId)
      if (order.status !== 'confirmed')
        throw new AppError('CONFLICT', 'لا يمكن استرداد دفعة إلا لطلب مؤكد قائم')
      if (refundLifecycleBlocked(order.id))
        throw new AppError('CONFLICT', 'لا يمكن الاسترداد بعد بدء التصنيع أو قبل التراجع عن المستندات التشغيلية المرتبطة')
    },
    onReplay: (original) => ({ ...original, idempotent: true }),
    execute: () =>
      withTransaction(() => {
        const db = getDatabase()
        const order = assertOrderOperational(input.orderId)
        if (order.status !== 'confirmed')
          throw new AppError('CONFLICT', 'لا يمكن استرداد دفعة إلا لطلب مؤكد قائم')
        if (refundLifecycleBlocked(order.id))
          throw new AppError('CONFLICT', 'لا يمكن الاسترداد بعد بدء التصنيع أو قبل التراجع عن المستندات التشغيلية المرتبطة')

        // Recheck before idempotency lookup so a replay cannot bypass a later
        // manufacturing start or active downstream document.
        const existing = db
          .select()
          .from(customerPaymentRefunds)
          .where(eq(customerPaymentRefunds.requestKey, input.requestKey.trim()))
          .get()
        if (existing) {
          if (
            existing.createdBy !== ctx.session.user.id ||
            existing.orderId !== input.orderId ||
            existing.amountMinor !== input.amountMinor ||
            existing.cashAccountId !== input.cashAccountId ||
            (input.refundedAt !== undefined && existing.refundedAt !== input.refundedAt)
          ) {
            throw new AppError('CONFLICT', 'معرّف الاسترداد مستخدم لعملية مختلفة')
          }
          const position = orderPaymentPosition(existing.orderId)
          return { refundId: existing.id, ...position, idempotent: true }
        }

        const available = refundablePayments(order.id)
        const allocatedRefundableMinor = available.reduce(
          (sum, payment) => sum + payment.remainingMinor,
          0
        )
        const position = orderPaymentPosition(order.id)
        if (position.paidMinor < 0 || allocatedRefundableMinor !== position.paidMinor)
          throw new AppError('CONFLICT', 'توجد مشكلة في مطابقة دفعات العميل مع سجلات الاسترداد')
        const refundableMinor = position.paidMinor
        if (input.amountMinor > refundableMinor)
          throw new AppError('VALIDATION_ERROR', 'مبلغ الاسترداد أكبر من المبلغ القابل للاسترداد')

        const account = db.get<{ id: number; active: number; balanceMinor: number }>(sql`
      SELECT a.id, a.active,
             a.opening_balance_minor
               + COALESCE(SUM(CASE WHEN t.direction = 'in' THEN t.amount_minor ELSE -t.amount_minor END), 0)
               AS balanceMinor
      FROM cash_accounts a
      LEFT JOIN cash_transactions t ON t.account_id = a.id
      WHERE a.id = ${input.cashAccountId}
      GROUP BY a.id
    `)
        if (!account) throw notFound('الحساب النقدي غير موجود')
        if (!account.active) throw new AppError('CONFLICT', 'الحساب النقدي غير نشط')
        if (account.balanceMinor < input.amountMinor)
          throw new AppError('CONFLICT', 'رصيد الحساب النقدي لا يكفي لتنفيذ الاسترداد')

        const refundedAt = input.refundedAt ?? nowIso()
        const refundId = Number(
          db
            .insert(customerPaymentRefunds)
            .values({
              orderId: order.id,
              customerId: order.customerId,
              amountMinor: input.amountMinor,
              cashAccountId: input.cashAccountId,
              refundedAt,
              // Legacy storage column retained for migration compatibility. The active
              // refund workflow collects no note/reason and stores no invented text.
              reason: '',
              requestKey: input.requestKey.trim(),
              createdBy: ctx.session.user.id,
              createdAt: nowIso()
            })
            .run().lastInsertRowid
        )

        let left = input.amountMinor
        const allocations: Array<{ paymentId: number; amountMinor: number }> = []
        for (const payment of available) {
          if (left === 0) break
          const amountMinor = Math.min(left, payment.remainingMinor)
          db.insert(customerPaymentRefundAllocations)
            .values({
              refundId,
              paymentId: payment.id,
              amountMinor
            })
            .run()
          allocations.push({ paymentId: payment.id, amountMinor })
          left -= amountMinor
        }
        if (left !== 0) throw new AppError('CONFLICT', 'تعذر ربط الاسترداد بالدفعات الأصلية')

        const paidMinor = refundableMinor - input.amountMinor
        if (paidMinor < 0) throw new AppError('CONFLICT', 'لا يمكن أن يصبح صافي المدفوع سالباً')
        const remainingMinor = order.totalMinor - paidMinor
        const paymentStatus = paymentStatusFor(
          order.totalMinor,
          paidMinor,
          order.depositRequiredMinor
        )
        db.update(orders)
          .set({ paidMinor, remainingMinor, paymentStatus })
          .where(eq(orders.id, order.id))
          .run()

        postCashMovement({
          accountId: input.cashAccountId,
          direction: 'out',
          amountMinor: input.amountMinor,
          kind: 'customer_payment_refund',
          refTable: 'customer_payment_refunds',
          refId: refundId,
          occurredAt: refundedAt,
          ctx
        })
        recordAuditEvent({
          userId: ctx.session.user.id,
          action: 'orders.payment.refund',
          entity: 'customer_payment_refunds',
          entityId: String(refundId),
          details: {
            orderId: order.id,
            amountMinor: input.amountMinor,
            cashAccountId: input.cashAccountId,
            refundedAt,
            requestKey: input.requestKey.trim(),
            allocations,
            paidMinor,
            remainingMinor,
            paymentStatus
          }
        })
        clearNotificationConditionState(`incomplete_order:${order.id}`)
        return { refundId, paidMinor, remainingMinor, paymentStatus, idempotent: false }
      })
  })
}

/**
 * Undoes ONE customer payment and its paired cash effect, leaving the
 * order itself (and every other payment on it) untouched — the exact
 * mirror of `recordPayment`'s increment. Needed only when a payment's
 * cash row must go without the whole order going with it (Cash Account
 * full delete: the order is not owned by the account being removed,
 * only this one payment's money-in was). `orders.paidMinor` is a
 * stored, incrementally-maintained figure (never derived live), so it
 * — and `remainingMinor`/`paymentStatus` — must be corrected here
 * exactly as `recordPayment` set them, in reverse.
 *
 * Owns a transaction for the payment/cash reversal and required audit;
 * existing cleanup owners can compose it inside their outer transaction.
 */
export function reverseCustomerPayment(paymentId: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.cash.fullDelete)
  return withTransaction(() => {
    const payment = getDatabase()
      .select()
      .from(customerPayments)
      .where(eq(customerPayments.id, paymentId))
      .get()
    if (!payment) throw notFound('الدفعة غير موجودة')
    const order = getOrderOrThrow(payment.orderId)
    assertOrderNotAwaitingApproval(order)
    const started = sql.raw(manufacturingStartedSql('w'))
    if (getDatabase().get(sql`SELECT 1 FROM work_sheets w
      WHERE w.order_id = ${order.id} AND ${started} LIMIT 1`)) {
      throw new AppError('CONFLICT', 'لا يمكن التراجع عن دفعة العميل بعد بدء التصنيع')
    }

    const paidMinor = order.paidMinor - payment.amountMinor
    const remainingMinor = order.totalMinor - paidMinor
    const paymentStatus = paymentStatusFor(order.totalMinor, paidMinor, order.depositRequiredMinor)

    getDatabase().delete(customerPayments).where(eq(customerPayments.id, paymentId)).run()
    removeCashMovementForRef('customer_payments', paymentId)
    getDatabase()
      .update(orders)
      .set({ paidMinor, remainingMinor, paymentStatus })
      .where(eq(orders.id, order.id))
      .run()

    clearNotificationConditionState(`incomplete_order:${order.id}`)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.payment.reverse',
      entity: 'customer_payments',
      entityId: String(paymentId),
      details: {
        description: `Customer payment reversal (#${paymentId}) on order ${order.documentNumber}`,
        orderId: order.id,
        amountMinor: payment.amountMinor,
        paidMinor,
        remainingMinor
      }
    })
  })
}

function currentStandardStockLines(orderId: number) {
  return getDatabase().select().from(orderLines).where(eq(orderLines.orderId, orderId)).all().filter(isStandardStockLine)
}

/**
 * BL-04 legacy guard: before this fix a customer Manufacturing Order could
 * also build the standard lines. Its issuance snapshot records which lines it
 * covered; a sheet without that record is treated as covering them.
 */
function manufacturingCoversStandardLines(orderId: number): boolean {
  const lineIds = new Set(currentStandardStockLines(orderId).map((line) => line.id))
  if (!lineIds.size) return false
  return getDatabase()
    .all<{ snapshot: string | null }>(sql`SELECT document_snapshot AS snapshot FROM work_sheets WHERE order_id = ${orderId} AND status != 'reversed'`)
    .some(({ snapshot }) => {
      const sourceLines = snapshot ? (JSON.parse(snapshot) as { sourceLines?: Array<{ id: number }> }).sourceLines : undefined
      return !sourceLines || sourceLines.some((line) => lineIds.has(line.id))
    })
}

/** Standard lines still waiting for ready stock (never negative stock, never marked supplied). */
export function standardStockPending(orderId: number): boolean {
  return currentStandardStockLines(orderId).length > 0 && !orderFulfilledFromStock(orderId) && !manufacturingCoversStandardLines(orderId)
}

/**
 * BL-04 commitment point: standard lines leave the factory only as issued ready
 * stock. Called inside the Exit Permit issuance transaction; insufficient
 * ready stock refuses that step and the order stays pending (never negative).
 */
export function supplyStandardLinesFromStock(orderId: number, ctx: ServiceContext): void {
  if (standardStockPending(orderId)) fulfillFromStock({ orderId }, ctx)
}

/**
 * Legacy entry name retained for compatibility, but no longer an independent
 * fulfillment command: only the active Exit Permit transaction may issue stock.
 *
 * Every standard line on the order is issued from stock at the stock's
 * own production cost, which then feeds the order's actual cost — so a
 * sale from stock is as accurately costed as a manufactured one. If any
 * line has insufficient stock the whole thing rolls back: a half-issued
 * order would leave the goods and the paperwork out of step.
 */
export function fulfillFromStock(
  input: { orderId: number },
  ctx: ServiceContext
): { issuedLines: number; totalCostMinor: number } {
  requirePermission(ctx.session, P.releases.issue)
  if (!getRawConnection().inTransaction || !getRawConnection().prepare(
    "SELECT id FROM releases WHERE order_id = ? AND status = 'active'"
  ).get(input.orderId)) throw new AppError('CONFLICT', 'صرف المخزون الجاهز يتطلب معاملة إصدار إذن خروج')
  const order = assertOrderOperational(input.orderId)
  if (order.status === 'cancelled') {
    throw new AppError('CONFLICT', 'لا يمكن الصرف من المخزون لطلب ملغى')
  }
  const lines = getDatabase()
    .select()
    .from(orderLines)
    .where(and(eq(orderLines.orderId, input.orderId), sql`${orderLines.supersededAt} IS NULL`))
    .all()
    .filter(isStandardStockLine)
  if (!lines.length) {
    throw new AppError(
      'VALIDATION_ERROR',
      'لا توجد بنود منتجات قياسية في هذا الطلب يمكن صرفها من المخزون الجاهز'
    )
  }
  return withTransaction(() => {
    // Re-checked inside the transaction: a retry/double-click issues nothing twice.
    if (orderFulfilledFromStock(input.orderId)) {
      throw new AppError('CONFLICT', 'تم صرف هذا الطلب من المخزون الجاهز بالفعل')
    }
    if (manufacturingCoversStandardLines(input.orderId)) {
      throw new AppError('CONFLICT', 'صدر أمر تصنيع شمل المنتجات القياسية في هذا الطلب — لا يمكن صرفها من المخزون الجاهز أيضاً')
    }
    let totalCostMinor = 0
    for (const line of lines) {
      const result = issueFromStock(
        {
          productId: line.productId!,
          orderId: input.orderId,
          qtyMicro: line.quantityMicro,
          notes: `صرف من المخزون الجاهز للطلب ${order.documentNumber}`
        },
        ctx
      )
      totalCostMinor += result.totalCostMinor
    }
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.fulfillFromStock',
      entity: 'orders',
      entityId: String(input.orderId),
      details: { issuedLines: lines.length, totalCostMinor }
    })
    return { issuedLines: lines.length, totalCostMinor }
  })
}

/**
 * Customer orders exist only after final-invoice approval, so every row is
 * already posted commercial history. Dependency-specific blockers are still
 * returned for useful diagnostics, but the posted-history blocker always
 * prevents either legacy hard-delete implementation from running.
 */
export function orderDeletionBlockers(orderId: number): string[] {
  const db = getDatabase()
  const count = (query: ReturnType<typeof sql>): number => db.get<{ c: number }>(query)?.c ?? 0
  const blockers: string[] = [POSTED_ORDER_HISTORY_BLOCKER]
  if (
    scalarCount(
      'SELECT COUNT(*) AS c FROM invoice_approval_history WHERE invoice_id IN (SELECT id FROM final_invoices WHERE order_id = ?)',
      orderId
    ) > 0
  )
    blockers.push('توجد نسخ تاريخية لتصحيح اعتماد الفاتورة؛ لا يمكن حذف سجل التصحيح نهائياً')

  if (count(sql`SELECT COUNT(*) AS c FROM customer_payments WHERE order_id = ${orderId}`) > 0) {
    blockers.push('توجد دفعات مسجّلة على الطلب')
  }
  if (count(sql`SELECT COUNT(*) AS c FROM work_sheets WHERE order_id = ${orderId}`) > 0) {
    blockers.push('صدر أمر تصنيع لهذا الطلب')
  }
  if (count(sql`SELECT COUNT(*) AS c FROM order_material_lines WHERE order_id = ${orderId}`) > 0) {
    blockers.push('صُرفت مواد من المخزون على الطلب')
  }
  if (count(sql`SELECT COUNT(*) AS c FROM order_machine_usage WHERE order_id = ${orderId}`) > 0) {
    blockers.push('يوجد استخدام آلات مسجّل')
  }
  if (
    count(sql`SELECT COUNT(*) AS c FROM order_worker_assignments WHERE order_id = ${orderId}`) > 0
  ) {
    blockers.push('يوجد تعيين عمال ومستحقات')
  }
  if (count(sql`SELECT COUNT(*) AS c FROM releases WHERE order_id = ${orderId}`) > 0) {
    blockers.push('صدر إذن خروج')
  }
  if (count(sql`SELECT COUNT(*) AS c FROM deliveries WHERE order_id = ${orderId}`) > 0) {
    blockers.push('سُجّل تسليم أو تركيب')
  }
  // Retain the legacy shape diagnostic in addition to the unconditional
  // posted-order blocker above.
  if (
    count(
      sql`SELECT COUNT(*) AS c FROM final_invoices WHERE order_id = ${orderId} AND id != COALESCE((SELECT final_invoice_id FROM orders WHERE id = ${orderId}), 0)`
    ) > 0
  ) {
    blockers.push('صدرت فاتورة معتمدة')
  }
  if (count(sql`SELECT COUNT(*) AS c FROM expenses WHERE order_id = ${orderId}`) > 0) {
    blockers.push('توجد مصروفات مرتبطة بالطلب')
  }
  if (
    count(sql`SELECT COUNT(*) AS c FROM finished_goods_movements WHERE order_id = ${orderId}`) > 0
  ) {
    blockers.push('صُرفت بضاعة جاهزة على الطلب')
  }
  if (count(sql`SELECT COUNT(*) AS c FROM purchases WHERE customer_order_id = ${orderId}`) > 0) {
    blockers.push('توجد فواتير شراء مرتبطة بالطلب')
  }
  return blockers
}

export function deleteOrder(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.orders.fullDelete)
  const order = assertOrderDeleteCancelEligible(id)
  const blockers = orderDeletionBlockers(id)
  if (blockers.length) {
    throw new AppError(
      'CONFLICT',
      `لا يمكن حذف الطلب نهائياً: ${blockers.join('، ')}. استخدم "إلغاء الطلب" للحفاظ على السجل التاريخي`
    )
  }

  withImmediateTransaction(() => {
    const db = getDatabase()
    assertOrderDeleteCancelEligible(id)
    if (orderDeletionBlockers(id).length)
      throw new AppError('CONFLICT', 'تغيرت ضوابط حذف الطلب. حدّث الصفحة ثم حاول مجدداً')
    // Only the order's own lines and its frozen planning snapshot go
    // with it — both are meaningless without it and neither is a
    // financial or inventory record.
    db.delete(orderLines).where(eq(orderLines.orderId, id)).run()
    db.run(sql`DELETE FROM planned_materials WHERE order_id = ${id}`)
    db.run(sql`DELETE FROM planned_machines WHERE order_id = ${id}`)
    db.run(sql`DELETE FROM planned_workers WHERE order_id = ${id}`)
    db.run(sql`DELETE FROM planned_order_expenses WHERE order_id = ${id}`)
    // The approved invoice that created it returns to DRAFT and lets go
    // of the order, so it can be corrected and approved again — it was
    // never cancelled, only consumed. Clearing the link first is also
    // what keeps the order's own FK valid as the row disappears.
    if (order.finalInvoiceId) {
      db.run(
        sql`UPDATE final_invoices SET status = 'draft', order_id = NULL, issued_at = NULL, snapshot = NULL WHERE id = ${order.finalInvoiceId}`
      )
    }
    db.delete(orders).where(eq(orders.id, id)).run()
    // A LEGACY order converted from a preliminary invoice returns that
    // invoice to "approved" exactly as it always did.
    if (order.quotationId) {
      db.update(quotations)
        .set({ status: 'approved' })
        .where(eq(quotations.id, order.quotationId))
        .run()
    }
  })

  recordAuditEvent({
    userId: ctx.session.user.id,
    action: 'orders.delete',
    entity: 'orders',
    entityId: String(id),
    details: { documentNumber: order.documentNumber, totalMinor: order.totalMinor }
  })
}

export interface FullDeletePreview {
  orderId: number
  documentNumber: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}

const POSTED_ORDER_HISTORY_BLOCKER =
  'طلب العميل سجل تجاري مُرحّل ناتج عن اعتماد فاتورة؛ استخدم إلغاء الاعتماد أو الإلغاء أو العكس مع إبقاء المستندات التاريخية'

const FULL_DELETE_DEPENDENCIES: Array<[string, string, string, boolean?]> = [
  [
    'payments',
    'دفعات واستردادات العميل',
    `SELECT
    (SELECT COUNT(*) FROM customer_payments WHERE order_id = ?)
    + (SELECT COUNT(*) FROM customer_payment_refunds WHERE order_id = ?) AS c`,
    true
  ],
  ['productionOrders', 'أوامر التصنيع', 'SELECT COUNT(*) AS c FROM work_sheets WHERE order_id = ?'],
  [
    'materialConsumption',
    'حركات صرف المواد',
    'SELECT COUNT(*) AS c FROM order_material_lines WHERE order_id = ? OR work_sheet_id IN (SELECT id FROM work_sheets WHERE order_id = ?)',
    true
  ],
  [
    'machineCosts',
    'تكاليف واستخدام الآلات',
    'SELECT COUNT(*) AS c FROM order_machine_usage WHERE order_id = ? OR work_sheet_id IN (SELECT id FROM work_sheets WHERE order_id = ?)',
    true
  ],
  [
    'workerCosts',
    'تعيينات ومستحقات العمال',
    'SELECT COUNT(*) AS c FROM order_worker_assignments WHERE order_id = ? OR work_sheet_id IN (SELECT id FROM work_sheets WHERE order_id = ?)',
    true
  ],
  [
    'workerLedger',
    'قيود استحقاق العمال',
    'SELECT COUNT(*) AS c FROM worker_transactions WHERE order_id = ?'
  ],
  ['exitPermits', 'أذونات الخروج', 'SELECT COUNT(*) AS c FROM releases WHERE order_id = ?'],
  [
    'deliveries',
    'سجلات التسليم والتركيب',
    'SELECT COUNT(*) AS c FROM deliveries WHERE order_id = ?'
  ],
  [
    'finalInvoices',
    'الفواتير المعتمدة',
    'SELECT COUNT(*) AS c FROM final_invoices WHERE order_id = ?'
  ],
  ['expenses', 'المصروفات المرتبطة', 'SELECT COUNT(*) AS c FROM expenses WHERE order_id = ?'],
  [
    'purchases',
    'فواتير الشراء المرتبطة',
    'SELECT COUNT(*) AS c FROM purchases WHERE customer_order_id = ?'
  ],
  [
    'finishedGoods',
    'حركات البضاعة الجاهزة',
    'SELECT COUNT(*) AS c FROM finished_goods_movements WHERE order_id = ?'
  ],
  [
    'plannedMaterials',
    'لقطات المواد المخططة',
    'SELECT COUNT(*) AS c FROM planned_materials WHERE order_id = ? OR work_sheet_id IN (SELECT id FROM work_sheets WHERE order_id = ?)',
    true
  ],
  [
    'plannedMachines',
    'لقطات الآلات المخططة',
    'SELECT COUNT(*) AS c FROM planned_machines WHERE order_id = ?'
  ],
  [
    'plannedWorkers',
    'لقطات العمال المخططة',
    'SELECT COUNT(*) AS c FROM planned_workers WHERE order_id = ?'
  ],
  [
    'plannedOrderExpenses',
    'مصروفات الطلب المخططة',
    'SELECT COUNT(*) AS c FROM planned_order_expenses WHERE order_id = ? OR work_sheet_id IN (SELECT id FROM work_sheets WHERE order_id = ?)',
    true
  ]
]

function scalarCount(statement: string, ...params: number[]): number {
  const row = getRawConnection()
    .prepare(statement)
    .get(...params) as { c: number } | undefined
  return Number(row?.c ?? 0)
}

/** Discovers and validates the complete downstream graph without mutating it. */
export function fullDeletePreview(id: number): FullDeletePreview {
  const order = getOrderOrThrow(id)
  const dependencies = FULL_DELETE_DEPENDENCIES.map(([key, label, statement, twice]) => ({
    key,
    label,
    count: scalarCount(statement, id, ...(twice ? [id] : []))
  })).filter((item) => item.count > 0)
  const raw = getRawConnection()
  const blockers: string[] = [POSTED_ORDER_HISTORY_BLOCKER]
  if (manufacturingOrderEverIssued(id))
    blockers.push('لا يمكن حذف الطلب بعد إصدار أمر التصنيع. استخدم إلغاء الطلب')
  if (
    scalarCount(
      'SELECT COUNT(*) AS c FROM invoice_approval_history WHERE invoice_id IN (SELECT id FROM final_invoices WHERE order_id = ?)',
      id
    ) > 0
  )
    blockers.push('توجد نسخ تاريخية لتصحيح اعتماد الفاتورة؛ لا يمكن حذف سجل التصحيح نهائياً')
  if (scalarCount('SELECT COUNT(*) AS c FROM purchases WHERE customer_order_id = ?', id) > 0) {
    blockers.push(
      'توجد فواتير شراء مرتبطة بالطلب؛ افصل ارتباطها أو احذفها وفق ضوابط المشتريات أولاً'
    )
  }
  const lines = raw
    .prepare(
      `
    SELECT id, status, movement_id AS movementId, reversal_movement_id AS reversalMovementId,
           physical_qty_micro AS physicalQtyMicro
    FROM order_material_lines
    WHERE order_id = ? OR work_sheet_id IN (SELECT id FROM work_sheets WHERE order_id = ?)
  `
    )
    .all(id, id) as Array<{
    id: number
    status: string
    movementId: number | null
    reversalMovementId: number | null
    physicalQtyMicro: number
  }>
  const knownMovements = new Set<number>()

  for (const line of lines) {
    if (!line.movementId) {
      blockers.push(`سجل صرف المادة #${line.id} لا يحمل رابط حركة مخزون كاملاً`)
      continue
    }
    knownMovements.add(line.movementId)
    if (line.reversalMovementId) knownMovements.add(line.reversalMovementId)
    const movement = raw
      .prepare('SELECT kind, qty_micro AS qtyMicro FROM inventory_movements WHERE id = ?')
      .get(line.movementId) as { kind: string; qtyMicro: number } | undefined
    const allocationTotal = raw
      .prepare(
        'SELECT COALESCE(SUM(qty_micro), 0) AS qty FROM fifo_allocations WHERE movement_id = ?'
      )
      .get(line.movementId) as { qty: number } | undefined
    const allocated = Number(allocationTotal?.qty ?? 0)
    if (
      !movement ||
      movement.kind !== 'consumption' ||
      allocated !== line.physicalQtyMicro ||
      movement.qtyMicro !== line.physicalQtyMicro
    ) {
      blockers.push(
        `لا يمكن استعادة طبقات التكلفة بأمان لسجل الصرف #${line.id} لأن تفاصيل الحركة أو التوزيع غير متطابقة`
      )
    }
    const reversal = raw
      .prepare('SELECT id FROM inventory_movements WHERE reversal_of_movement_id = ?')
      .all(line.movementId) as Array<{ id: number }>
    for (const row of reversal) knownMovements.add(row.id)
    if (line.status === 'active' && reversal.length) {
      blockers.push(`سجل الصرف #${line.id} نشط لكنه يحمل حركة عكس؛ يلزم تصحيح هذا التعارض أولاً`)
    }
    if (line.status === 'reversed' && !reversal.length) {
      blockers.push(`سجل الصرف #${line.id} معلّم كمعكوس دون حركة استعادة موثقة`)
    }
  }

  const orderMovements = raw
    .prepare('SELECT id, kind FROM inventory_movements WHERE order_id = ?')
    .all(id) as Array<{ id: number; kind: string }>
  const unknown = orderMovements.filter((movement) => !knownMovements.has(movement.id))
  if (unknown.length)
    blockers.push('توجد حركات مخزون مرتبطة بالطلب لا يمكن نسبها بأمان إلى سجلات صرف موثقة')

  if (knownMovements.size) {
    const placeholders = [...knownMovements].map(() => '?').join(',')
    const remainderRow = raw
      .prepare(
        `
      SELECT COUNT(*) AS c FROM material_remainders
      WHERE available = 1 AND layer_id IN (
        SELECT DISTINCT layer_id FROM fifo_allocations WHERE movement_id IN (${placeholders})
      )
    `
      )
      .get(...knownMovements) as { c: number } | undefined
    const remainderCount = Number(remainderRow?.c ?? 0)
    if (remainderCount > 0) {
      blockers.push(
        'توجد قصاصات قابلة للاستخدام على طبقات التكلفة المتأثرة ولا يمكن إثبات تبعيتها لهذا الطلب بأمان'
      )
    }
  }

  for (const payment of raw
    .prepare('SELECT id, cash_account_id AS accountId FROM customer_payments WHERE order_id = ?')
    .all(id) as Array<{ id: number; accountId: number | null }>) {
    const cashRows = scalarCount(
      "SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'customer_payments' AND ref_id = ?",
      payment.id
    )
    if (payment.accountId && cashRows !== 1)
      blockers.push(`الأثر النقدي للدفعة #${payment.id} غير مكتمل أو مكرر`)
    if (!payment.accountId && cashRows > 0)
      blockers.push(`الدفعة #${payment.id} تحمل أثراً نقدياً غير متوقع`)
  }
  for (const refund of raw
    .prepare('SELECT id FROM customer_payment_refunds WHERE order_id = ?')
    .all(id) as Array<{ id: number }>) {
    const cashRows = scalarCount(
      "SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'customer_payment_refunds' AND ref_id = ?",
      refund.id
    )
    if (cashRows !== 1)
      blockers.push(`الأثر النقدي لاسترداد الدفعة #${refund.id} غير مكتمل أو مكرر`)
  }
  for (const expense of raw
    .prepare('SELECT id, cash_account_id AS accountId FROM expenses WHERE order_id = ?')
    .all(id) as Array<{ id: number; accountId: number | null }>) {
    const cashRows = scalarCount(
      "SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = ?",
      expense.id
    )
    if (expense.accountId && cashRows !== 1)
      blockers.push(`الأثر النقدي للمصروف #${expense.id} غير مكتمل أو مكرر`)
  }

  return {
    orderId: id,
    documentNumber: order.documentNumber,
    dependencies,
    blockers: [...new Set(blockers)]
  }
}

/**
 * Privileged test/mistake cleanup. This is deliberately not cancellation:
 * it removes the complete operation while preserving its source quotation
 * and the append-only high-level audit event.
 */
export function fullDeleteOrder(
  input: { id: number; confirmation: string },
  ctx: ServiceContext
): { removed: true; summary: Record<string, number> } {
  requirePermission(ctx.session, P.orders.fullDelete)
  const order = assertOrderDeleteCancelEligible(input.id)
  if (input.confirmation !== order.documentNumber) {
    throw new AppError(
      'VALIDATION_ERROR',
      `اكتب رقم الطلب ${order.documentNumber} لتأكيد حذف العملية بالكامل`
    )
  }
  return withImmediateTransaction(() => {
    assertOrderDeleteCancelEligible(input.id)
    return performFullDeleteOrder(input.id, ctx)
  })
}

/**
 * The unwinding itself, with no confirmation-token check of its own.
 * It MUST be called from inside an open transaction so a caller that
 * removes the order as one step of a larger operation (deleting the
 * preliminary invoice the order was converted from, Part B) reuses
 * exactly this logic instead of duplicating a second delete path, and
 * still rolls the whole thing back as one unit.
 *
 * `cascadedFrom` only enriches the audit description; it never changes
 * what is removed.
 */
export function performFullDeleteOrder(
  orderId: number,
  ctx: ServiceContext,
  cascadedFrom?: string
): { removed: true; summary: Record<string, number> } {
  // `performFullDeleteOrder` is also reused by the preliminary-invoice
  // cascade, so the invariant belongs here as well as in the public wrapper.
  // No internal caller may erase a paid order by skipping the IPC preview.
  //
  // There is no way to waive a blocker: every caller, public or
  // internal, gets the preview's blockers verbatim.
  const order = assertOrderDeleteCancelEligible(orderId)
  const preview = fullDeletePreview(orderId)
  const blockers = preview.blockers
  if (blockers.length) {
    throw new AppError(
      'CONFLICT',
      `تم منع حذف العملية بالكامل لحماية المخزون والسجل المالي: ${blockers.join('، ')}`
    )
  }
  const raw = getRawConnection()
  const summary = Object.fromEntries(
    preview.dependencies.map((item) => [item.key, item.count])
  ) as Record<string, number>
  const sheetIds = (
    raw.prepare('SELECT id FROM work_sheets WHERE order_id = ?').all(orderId) as Array<{
      id: number
    }>
  ).map((row) => row.id)
  const materialLines = raw
    .prepare(
      `
    SELECT id, status, movement_id AS movementId
    FROM order_material_lines WHERE order_id = ?
  `
    )
    .all(orderId) as Array<{ id: number; status: string; movementId: number }>

  // Documents and real-world events unwind from the outside in.
  // Clear the order's own link before the invoice row goes, or its
  // foreign key would fail mid-delete.
  raw.prepare('UPDATE orders SET final_invoice_id = NULL WHERE id = ?').run(orderId)
  raw
    .prepare(
      'DELETE FROM final_invoice_lines WHERE final_invoice_id IN (SELECT id FROM final_invoices WHERE order_id = ?)'
    )
    .run(orderId)
  raw.prepare('DELETE FROM final_invoices WHERE order_id = ?').run(orderId)
  raw
    .prepare(
      'DELETE FROM delivery_workers WHERE delivery_id IN (SELECT id FROM deliveries WHERE order_id = ?)'
    )
    .run(orderId)
  raw.prepare('DELETE FROM deliveries WHERE order_id = ?').run(orderId)
  raw
    .prepare(
      'DELETE FROM release_workers WHERE release_id IN (SELECT id FROM releases WHERE order_id = ?)'
    )
    .run(orderId)
  raw.prepare('DELETE FROM releases WHERE order_id = ?').run(orderId)

  // Linked costs and their paired ledger effects.
  raw
    .prepare(
      "DELETE FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id IN (SELECT id FROM expenses WHERE order_id = ?)"
    )
    .run(orderId)
  raw.prepare('DELETE FROM expenses WHERE order_id = ?').run(orderId)
  raw
    .prepare(
      "DELETE FROM cash_transactions WHERE ref_table = 'worker_transactions' AND ref_id IN (SELECT id FROM worker_transactions WHERE order_id = ?)"
    )
    .run(orderId)
  raw.prepare('DELETE FROM worker_transactions WHERE order_id = ?').run(orderId)
  raw
    .prepare(
      'DELETE FROM order_machine_usage WHERE order_id = ? OR work_sheet_id IN (SELECT id FROM work_sheets WHERE order_id = ?)'
    )
    .run(orderId, orderId)
  raw
    .prepare(
      'DELETE FROM order_worker_assignments WHERE order_id = ? OR work_sheet_id IN (SELECT id FROM work_sheets WHERE order_id = ?)'
    )
    .run(orderId, orderId)

  // Restore each still-active consumption to its exact historical FIFO layers.
  for (const line of materialLines) {
    if (line.status !== 'active') continue
    const allocations = raw
      .prepare(
        'SELECT layer_id AS layerId, qty_micro AS qtyMicro FROM fifo_allocations WHERE movement_id = ?'
      )
      .all(line.movementId) as Array<{ layerId: number; qtyMicro: number }>
    for (const allocation of allocations) {
      raw
        .prepare(
          'UPDATE fifo_layers SET qty_remaining_micro = qty_remaining_micro + ? WHERE id = ?'
        )
        .run(allocation.qtyMicro, allocation.layerId)
    }
  }
  const movementIds = materialLines.map((line) => line.movementId)
  if (movementIds.length) {
    const placeholders = movementIds.map(() => '?').join(',')
    raw
      .prepare(`DELETE FROM fifo_allocations WHERE movement_id IN (${placeholders})`)
      .run(...movementIds)
  }
  raw
    .prepare(
      'UPDATE order_material_lines SET replacement_line_id = NULL, correction_of_line_id = NULL WHERE order_id = ? OR work_sheet_id IN (SELECT id FROM work_sheets WHERE order_id = ?)'
    )
    .run(orderId, orderId)
  raw
    .prepare(
      'DELETE FROM order_material_lines WHERE order_id = ? OR work_sheet_id IN (SELECT id FROM work_sheets WHERE order_id = ?)'
    )
    .run(orderId, orderId)
  if (movementIds.length) {
    const placeholders = movementIds.map(() => '?').join(',')
    raw
      .prepare(`DELETE FROM inventory_movements WHERE reversal_of_movement_id IN (${placeholders})`)
      .run(...movementIds)
    raw.prepare(`DELETE FROM inventory_movements WHERE id IN (${placeholders})`).run(...movementIds)
  }
  raw.prepare('DELETE FROM finished_goods_movements WHERE order_id = ?').run(orderId)

  // Production-order snapshots/stages/crews are removed only after all actual effects.
  for (const sheetId of sheetIds) {
    raw.prepare('DELETE FROM planned_materials WHERE work_sheet_id = ?').run(sheetId)
    raw.prepare('DELETE FROM planned_order_expenses WHERE work_sheet_id = ?').run(sheetId)
    raw.prepare('DELETE FROM work_sheet_workers WHERE work_sheet_id = ?').run(sheetId)
  }
  raw.prepare('DELETE FROM work_sheets WHERE order_id = ?').run(orderId)

  // Removing both the payment and its paired cash entry exactly restores cash.
  raw
    .prepare(
      "DELETE FROM cash_transactions WHERE ref_table = 'customer_payment_refunds' AND ref_id IN (SELECT id FROM customer_payment_refunds WHERE order_id = ?)"
    )
    .run(orderId)
  raw
    .prepare(
      'DELETE FROM customer_payment_refund_allocations WHERE refund_id IN (SELECT id FROM customer_payment_refunds WHERE order_id = ?)'
    )
    .run(orderId)
  raw.prepare('DELETE FROM customer_payment_refunds WHERE order_id = ?').run(orderId)
  raw
    .prepare(
      "DELETE FROM cash_transactions WHERE ref_table = 'customer_payments' AND ref_id IN (SELECT id FROM customer_payments WHERE order_id = ?)"
    )
    .run(orderId)
  raw.prepare('DELETE FROM customer_payments WHERE order_id = ?').run(orderId)
  raw.prepare('DELETE FROM planned_materials WHERE order_id = ?').run(orderId)
  raw.prepare('DELETE FROM planned_machines WHERE order_id = ?').run(orderId)
  raw.prepare('DELETE FROM planned_workers WHERE order_id = ?').run(orderId)
  raw.prepare('DELETE FROM planned_order_expenses WHERE order_id = ?').run(orderId)
  raw.prepare('DELETE FROM order_lines WHERE order_id = ?').run(orderId)
  raw.prepare('DELETE FROM orders WHERE id = ?').run(orderId)
  if (order.quotationId)
    raw.prepare("UPDATE quotations SET status = 'approved' WHERE id = ?").run(order.quotationId)

  recordAuditEvent({
    userId: ctx.session.user.id,
    action: 'orders.full_delete',
    entity: 'orders',
    entityId: String(orderId),
    details: {
      fullDelete: true,
      // Auto-generated description (Part E): the operator is never
      // asked to type a reason, so the audit trail describes itself
      // — what was deleted, its document number and exactly which
      // dependent records went with it.
      description: cascadedFrom
        ? `Full Customer Order deletion (${order.documentNumber}) cascaded from ${cascadedFrom}`
        : `Full Customer Order deletion (${order.documentNumber})`,
      documentNumber: order.documentNumber,
      cascadedFrom: cascadedFrom ?? null,
      summary,
      quotationPreserved: Boolean(order.quotationId)
    }
  })
  return { removed: true, summary }
}

/**
 * The ONE cancellation action ("إلغاء الطلب"), unchanged in how it is
 * reached and confirmed.
 *
 * It gains one consequence: if the factory actually built this order's
 * items and none of them ever reached the customer, the physical
 * products do not evaporate with the paperwork — each manufactured item
 * is transferred, in THIS transaction, into "المنتجات غير المستلمة" so
 * it can be sold to someone else. Cancellation and transfer therefore
 * both happen or neither does.
 *
 * Started manufacturing keeps running after commercial cancellation. Its output
 * transfers here if already completed, or atomically at later completion.
 * Cancellation never refunds or changes receipts or incurred costs.
 */
export function transferCancelledOrderOutput(
  orderId: number,
  cancelReason: string,
  ctx: ServiceContext
) {
  const order = getOrderOrThrow(orderId)
  if (order.status !== 'cancelled') throw new AppError('CONFLICT', 'الطلب غير ملغى')
  return transferManufacturedProducts(
    { orderId, cancelReason },
    ctx,
    (lines) => loadItemSelections('order', lines as never) as never
  )
}

export function cancelOrder(
  input: { orderId: number; reason: string },
  ctx: ServiceContext
): { transferredProductIds: number[] } {
  requirePermission(ctx.session, P.orders.cancel)
  return withImmediateTransaction(() => {
    const order = assertOrderCancellationEligible(input.orderId)
    if (!input.reason?.trim()) throw new AppError('VALIDATION_ERROR', 'سبب الإلغاء مطلوب')

    getDatabase()
      .update(orders)
      .set({ status: 'cancelled', cancelledAt: nowIso(), cancelReason: input.reason })
      .where(eq(orders.id, order.id))
      .run()
    const reversedReleaseIds = reverseCancelledOrderReleases(order.id, ctx)
    const finishedGoodsReversalIds = orderFulfilledFromStock(order.id)
      ? reverseFinishedGoodsIssuesForOrder(order.id, input.reason, ctx)
      : []
    const transfer = transferCancelledOrderOutput(order.id, input.reason, ctx)

    // Risk 04: an undelivered resold product goes back on the Uncollected shelf.
    const releasedProductIds = releaseCancelledResale(order.id, input.reason, ctx)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.cancel',
      entity: 'orders',
      entityId: String(order.id),
      details: {
        reason: input.reason,
        paidMinor: order.paidMinor,
        nonRefundable: true,
        reversedReleaseIds,
        finishedGoodsReversalIds,
        transferredProductIds: transfer.productIds,
        transferSkippedReason: transfer.skippedReason,
        releasedProductIds
      }
    })
    return { transferredProductIds: transfer.productIds }
  })
}

/**
 * The only completion transition: a recorded physical event under an active
 * Exit Permit. The service boundary verifies persisted evidence itself.
 */
export function completeOrder(
  input: { orderId: number; deliveryId?: number },
  ctx: ServiceContext
): { completedAt: string } {
  requirePermission(ctx.session, P.deliveries.register)
  return withTransaction(() => {
    const order = assertOrderOperational(input.orderId)
    assertResumedOrderFulfilmentReady(input.orderId)
    if (order.status !== 'confirmed' || order.completedAt)
      throw new AppError('CONFLICT', 'لا يمكن إكمال طلب غير مؤكد أو مكتمل بالفعل')
    const physical = input.deliveryId
      ? getDatabase().select().from(deliveries).where(and(eq(deliveries.id, input.deliveryId), eq(deliveries.orderId, order.id), eq(deliveries.status, 'recorded'))).get()
      : undefined
    const permit = physical?.releaseId
      ? getDatabase().select().from(releases).where(and(eq(releases.id, physical.releaseId), eq(releases.orderId, order.id), eq(releases.status, 'active'))).get()
      : undefined
    if (!physical?.recordedAt || !permit || !isExitPermitKind(permit.kind) || physical.kind !== completionKindForPermit(permit.kind))
      throw new AppError('CONFLICT', 'إكمال الطلب يتطلب تسجيل العملية الفعلية بإذن خروج فعّال')
    if (getDatabase().get(sql`SELECT id FROM work_sheets WHERE order_id = ${order.id} AND status NOT IN ('completed', 'reversed', 'cancelled') LIMIT 1`))
      throw new AppError('CONFLICT', 'لا يمكن إكمال الطلب قبل إكمال أمر التصنيع')
    if (standardStockPending(order.id))
      throw new AppError('CONFLICT', 'لا يمكن إكمال الطلب قبل صرف المنتجات القياسية بإذن خروج')
    const completedAt = physical.recordedAt

    getDatabase()
      .update(orders)
      .set({ status: 'completed', completedAt })
      .where(eq(orders.id, order.id))
      .run()

    clearNotificationConditionState(`incomplete_order:${order.id}`)

    recordWorkerEarnings(order.id, completedAt, ctx)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.complete',
      entity: 'orders',
      entityId: String(order.id),
      details: { completedAt, deliveryId: physical.id, releaseId: permit.id }
    })
    return { completedAt }
  })
}

export function orderWorkerAssignmentsFor(orderId: number) {
  return getDatabase()
    .select()
    .from(orderWorkerAssignments)
    .where(
      and(
        eq(orderWorkerAssignments.orderId, orderId),
        sql`${orderWorkerAssignments.reversedAt} IS NULL`
      )
    )
    .all()
}
