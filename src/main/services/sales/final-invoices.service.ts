import { recomputeOrderEstimate } from '../planning/planning.service'
import { plannedMaterials, plannedMachines, plannedWorkers, machines, workers, productMachineLines, productCommissionLines } from '../../db/schema/production.schema'
import { materials } from '../../db/schema/catalog.schema'
import { costOf, multiplyDivideRounded, unitCostMicro } from '@shared/money/cost'
import { isManufacturableOrderLine } from './order-line-manufacturing'
import { requireActiveCustomer } from '../parties/parties.service'
import { restoreSnapshotMaterialGroups } from '@shared/documents/item-selections'
import { and, eq, inArray, isNotNull, isNull, like, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { idList, keysetBoundary, keysetOrder, keysetPage, normalizedSearch, type KeysetWindow, type PageRequest } from '../base/pagination'
import {
  loadItemSelections,
  prepareItemSelections,
  insertItemSelections
} from './item-selections.service'
import type { ItemSelections, ItemSelectionInput } from '@shared/documents/item-selections'
import { getDatabase, getRawConnection } from '../../db/connection'
import { uncollectedProducts } from '../../db/schema/uncollected-products.schema'
import { withTransaction } from '../../db/transactions'
import {
  finalInvoices,
  finalInvoiceLines,
  finalInvoiceTerms,
  invoiceApprovalHistory,
  orders,
  orderLines,
  customerPayments,
  customerPaymentRefunds,
  customerPaymentRefundAllocations
} from '../../db/schema/sales.schema'
import { customers } from '../../db/schema/parties.schema'
import { products } from '../../db/schema/products.schema'
import { AppError, notFound } from '../../utils/errors'
import { nextDocumentNumber } from '../numbering.service'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, type ServiceContext } from '../base/service.types'
import {
  getOrderOrThrow,
  getOrder,
  orderCanArchive,
  paymentStatusFor,
  recordPayment
} from './orders.service'
import { computeDocumentTotals } from './document-totals'
import {
  serializePrintVisibility,
  type PrintVisibilityInput
} from '@shared/documents/print-visibility'
import { hasPermission, requirePermission } from '../../permissions/permission-guard'
import {
  assertSellable
} from './uncollected-products.service'
import { PERMISSION_KEYS, PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { manufacturingStarted, manufacturingStartedSql } from '@shared/production/manufacturing-lifecycle'
import type { AuthSession } from '@shared/types/user.types'
import { cashAccounts, cashTransactions } from '../../db/schema/finance.schema'
import { getTerms, getDefaultDepositPercentBp } from '../settings.service'
import { buildBomSnapshot } from '../products/products.service'

/**
 * THE APPROVED INVOICE ("الفاتورة المعتمدة") — the authoritative
 * commercial approval point, and the START of the operational workflow.
 *
 * Workflow pass. Before this pass the approved invoice was the LAST
 * document in the chain: it billed an order that had already been
 * produced, released and delivered. It now sits at the front:
 *
 *     approved invoice --approve--> customer order
 *                                        └── production planning
 *                                        └── (explicit) manufacturing order
 *
 * Three properties matter and are enforced here:
 *
 *  1. APPROVAL IS IDEMPOTENT. Approving an invoice that is already
 *     approved returns the order it already produced. It never creates
 *     a second one — and the database refuses to let it, through the
 *     UNIQUE `orders.final_invoice_id`, so a retry that races past this
 *     check still cannot duplicate an order.
 *
 *  2. APPROVAL FREEZES THE COMMERCIAL TERMS. `snapshot` (customer,
 *     lines, subtotal/discount/total) and the Terms text are frozen at
 *     that moment. Payment figures are deliberately NOT frozen: paid
 *     and remaining always come from the authoritative customer_payments
 *     ledger at render time, so collecting the balance later updates
 *     the payment block without rewriting the agreed terms (item 35).
 *
 *  3. A positive paidAmountMinor posts one canonical customer payment
 *     inside approval; its optional account receives the normal cash movement.
 *     No inventory or worker commission is posted at approval.
 *
 * Invoices created under the OLD workflow are still here, still linked
 * to the order they billed, and still render from their frozen
 * snapshot — `getFinalInvoice` normalises both shapes.
 */

export interface FinalInvoiceLineInput extends ItemSelectionInput {
  lineKind: 'standard' | 'custom' | 'material' | 'delivery' | 'installation'
  productId?: number | null
  materialId?: number | null
  description: string
  specifications?: string | null
  dimensions?: string | null
  materialType?: string | null
  colorCode?: string | null
  accessories?: string | null
  /** The Raw Material accessory picked from the catalog, if any. The
   *  stored `accessories` text is then its frozen snapshot. */
  accessoryMaterialId?: number | null
  /** The Raw Material picked for "نوع المادة", if any — same
   *  reference+snapshot shape as accessoryMaterialId. */
  materialTypeMaterialId?: number | null
  quantityMicro: number
  unitPriceMinor: number
  /**
   * Sells an EXISTING physical product from "المنتجات غير المستلمة"
   * instead of something still to be built. The price stays whatever
   * the user types — the product's historical build cost never forces
   * a selling price.
   */
  uncollectedProductId?: number | null
  notes?: string | null
}

export interface FinalInvoiceSnapshot {
  customer: { name: string; phone: string | null; address: string | null }
  /** The order this invoice produced; empty until it is approved. */
  orderNumber: string
  orderCreatedAt: string
  lines: Array<
    Partial<ItemSelections> & {
      materialType?: string | null
      description: string
      specifications: string | null
      dimensions: string | null
      colorCode: string | null
      accessories: string | null
      quantityMicro: number
      unitPriceMinor: number
      lineTotalMinor: number
    }
  >
  subtotalMinor: number
  discountMinor: number
  totalMinor: number
  /**
   * Frozen at approval alongside the rest of the agreed commercial
   * terms. Optional because snapshots written before these fields
   * existed simply do not carry them — readers fall back to the
   * invoice row, which defaults them to 0.
   */
  meterPriceMinor?: number
  installationPriceMinor?: number
  deliveryPriceMinor?: number
  /** The fulfilment statements as agreed ("يشمل التركيب/التوصيل"). */
  requiresInstallation?: boolean
  requiresDelivery?: boolean
}

/** Live paid/remaining straight from the payment ledger (item 33). */
export function orderPaymentPosition(orderId: number): {
  paidMinor: number
  remainingMinor: number
  paymentStatus: ReturnType<typeof paymentStatusFor>
} {
  const order = getOrderOrThrow(orderId)
  const row = getDatabase().get<{ paid: number }>(sql`
    SELECT
      COALESCE((SELECT SUM(amount_minor) FROM customer_payments WHERE order_id = ${orderId}), 0)
      - COALESCE((SELECT SUM(amount_minor) FROM customer_payment_refunds WHERE order_id = ${orderId}), 0)
      AS paid
  `)
  const paidMinor = row?.paid ?? 0
  return {
    paidMinor,
    remainingMinor: order.totalMinor - paidMinor,
    paymentStatus: paymentStatusFor(order.totalMinor, paidMinor, order.depositRequiredMinor)
  }
}

function getInvoiceOrThrow(id: number) {
  const invoice = getDatabase().select().from(finalInvoices).where(eq(finalInvoices.id, id)).get()
  if (!invoice) throw notFound('الفاتورة المعتمدة غير موجودة')
  return invoice
}

function invoicePaymentPosition(invoice: { orderId: number | null; status: string; totalMinor: number; depositRequiredMinor: number }) {
  if (!invoice.orderId) return { paidMinor: 0, remainingMinor: invoice.totalMinor, paymentStatus: 'unpaid' }
  const payment = orderPaymentPosition(invoice.orderId)
  // A correction draft previews its new commercial amount against REAL receipts.
  // The order's last approved financial snapshot changes only on reapproval.
  return invoice.status === 'draft' ? { paidMinor: payment.paidMinor,
    remainingMinor: invoice.totalMinor - payment.paidMinor,
    paymentStatus: paymentStatusFor(invoice.totalMinor, payment.paidMinor, invoice.depositRequiredMinor)
  } : payment
}

const FULFILLED_STANDARD_LOCK_MESSAGE =
  'تم صرف المنتج القياسي من المخزون بموجب إذن خروج لهذا الطلب؛ لا يمكن تعديل الصنف أو الكمية بعد الصرف، وأي كمية إضافية تتطلب إنشاء فاتورة جديدة'

function assertStandardStockNotFulfilled(orderId: number): void {
  if (getDatabase().get(sql`
    SELECT id FROM finished_goods_movements
    WHERE order_id = ${orderId} AND kind = 'sale_out'
    LIMIT 1
  `)) throw new AppError('CONFLICT', FULFILLED_STANDARD_LOCK_MESSAGE)
}

function assertInvoiceCorrectionSafe(invoice: typeof finalInvoices.$inferSelect): void {
  if (!invoice.orderId) throw new AppError('CONFLICT', 'الفاتورة لا تحمل رابط طلب قابل للتصحيح')
  const order = getOrderOrThrow(invoice.orderId)
  if (order.finalInvoiceId !== invoice.id || order.customerId !== invoice.customerId) throw new AppError('CONFLICT', 'فاتورة تاريخية من دورة قديمة بلا رابط تحويل موثوق؛ لا يمكن إعادة بناء طلبها تلقائياً')
  if (order.archivedAt) throw new AppError('CONFLICT', 'استعد الطلب المؤرشف أولاً')
  if (order.status === 'cancelled') throw new AppError('CONFLICT', 'لا يمكن إلغاء اعتماد فاتورة طلب ملغى')
  const db = getDatabase()
  assertStandardStockNotFulfilled(order.id)
  if (db.get(sql`SELECT id FROM deliveries WHERE order_id = ${order.id} AND status = 'recorded' LIMIT 1`)) throw new AppError('CONFLICT', 'لا يمكن إلغاء اعتماد الفاتورة قبل التراجع عن عملية التسليم والتركيب من وحدتها')
  if (db.get(sql`SELECT id FROM releases WHERE order_id = ${order.id} AND status = 'active' LIMIT 1`)) throw new AppError('CONFLICT', 'لا يمكن إلغاء اعتماد الفاتورة قبل التراجع عن إذن الخروج من وحدته')
  if (db.get(sql`SELECT id FROM work_sheets WHERE order_id = ${order.id} AND status != 'reversed' LIMIT 1`)) throw new AppError('CONFLICT', 'لا يمكن إلغاء اعتماد الفاتورة قبل التراجع عن أمر التصنيع من وحدته')
  if (order.completedAt || order.status === 'completed') throw new AppError('CONFLICT', 'تراجع عن إكمال الطلب أولاً من صفحة الطلب')
  if (db.get(sql`SELECT id FROM order_material_lines WHERE order_id = ${order.id} AND status = 'active' LIMIT 1`)
    || db.get(sql`SELECT t.id FROM inventory_movements t WHERE t.order_id = ${order.id} AND t.kind = 'consumption' AND NOT EXISTS(SELECT 1 FROM inventory_movements r WHERE r.reversal_of_movement_id = t.id) LIMIT 1`)
    || db.get(sql`SELECT id FROM order_machine_usage WHERE order_id = ${order.id} AND reversed_at IS NULL LIMIT 1`)
    || db.get(sql`SELECT id FROM order_worker_assignments WHERE order_id = ${order.id} AND reversed_at IS NULL LIMIT 1`)
    || db.get(sql`SELECT id FROM finished_goods_movements WHERE order_id = ${order.id} LIMIT 1`)
    || db.get(sql`SELECT id FROM material_returns WHERE order_id = ${order.id} AND status = 'active' LIMIT 1`)) throw new AppError('CONFLICT', 'توجد آثار إنتاج فعلية مستقلة على الطلب؛ تراجع عنها من وحدتها أولاً')
  if (!getFinalInvoiceLines(invoice.id).length) throw new AppError('CONFLICT', 'هذه الفاتورة التاريخية بلا بنود تحرير أصلية؛ لا يمكن إلغاء اعتمادها دون تخمين مستندها')
}

/** Customer change 02: unapproval needs zero net paid and manufacturing that never started (Package 01 predicate). */
function assertUnapprovalAllowed(invoice: typeof finalInvoices.$inferSelect): void {
  if (invoice.orderId) {
    assertStandardStockNotFulfilled(invoice.orderId)
    const sheets = getDatabase().all<{ status: string; startedAt: string | null; completedAt: string | null }>(
      sql`SELECT status, started_at AS startedAt, completed_at AS completedAt FROM work_sheets WHERE order_id = ${invoice.orderId}`
    )
    if (sheets.some((sheet) => manufacturingStarted(sheet))) throw new AppError('CONFLICT', 'لا يمكن إلغاء اعتماد الفاتورة بعد بدء التصنيع')
    if (orderPaymentPosition(invoice.orderId).paidMinor !== 0) {
      throw new AppError('CONFLICT', 'لا يمكن إلغاء اعتماد الفاتورة قبل استرداد كامل المبلغ المدفوع للعميل (صافي المدفوع يجب أن يكون صفراً)')
    }
  }
  assertInvoiceCorrectionSafe(invoice)
}

/**
 * Every record (from the schema's references to orders, order lines, invoices
 * and invoice lines) that is financial, operational or stock history rather
 * than the approval's own documents. Any of them keeps the invoice undeletable.
 * Customer payments/refunds are judged separately by paymentCycleUnprovable.
 */
function orderHistoryExists(orderId: SQLWrapper | number, invoiceId: SQLWrapper | number): SQL {
  return sql`(
    EXISTS(SELECT 1 FROM work_sheets WHERE order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM order_material_lines WHERE order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM order_machine_usage WHERE order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM order_worker_assignments WHERE order_id = ${orderId} OR order_line_id IN (SELECT id FROM order_lines WHERE order_id = ${orderId}))
    OR EXISTS(SELECT 1 FROM worker_transactions WHERE order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM inventory_movements WHERE order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM finished_goods_movements WHERE order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM material_returns WHERE order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM purchases WHERE customer_order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM expenses WHERE order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM releases WHERE order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM deliveries WHERE order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM uncollected_products WHERE source_order_id = ${orderId} OR sold_order_id = ${orderId}
      OR source_invoice_id = ${invoiceId} OR sold_invoice_id = ${invoiceId}
      OR source_order_line_id IN (SELECT id FROM order_lines WHERE order_id = ${orderId})
      OR source_invoice_line_id IN (SELECT id FROM final_invoice_lines WHERE final_invoice_id = ${invoiceId}))
  )`
}

/**
 * Owner policy (CC02B): a fully reversed payment/refund cycle may be hard-deleted with its
 * invoice/order — only when every row provably belongs to this order and the cycle is
 * cash-neutral per account. True means something cannot be proven, so nothing is deleted.
 */
function paymentCycleUnprovable(orderId: SQLWrapper | number, invoiceId: SQLWrapper | number): SQL {
  const payments = sql`SELECT id FROM customer_payments WHERE order_id = ${orderId}`
  const refunds = sql`SELECT id FROM customer_payment_refunds WHERE order_id = ${orderId}`
  const cycleCash = sql`(t.ref_table = 'customer_payments' AND t.ref_id IN (${payments}))
    OR (t.ref_table = 'customer_payment_refunds' AND t.ref_id IN (${refunds}))`
  return sql`(
    (SELECT COALESCE(SUM(amount_minor), 0) FROM customer_payments WHERE order_id = ${orderId})
      != (SELECT COALESCE(SUM(amount_minor), 0) FROM customer_payment_refunds WHERE order_id = ${orderId})
    OR EXISTS(SELECT 1 FROM customer_payments p WHERE (p.order_id = ${orderId} AND p.approved_invoice_id IS NOT NULL AND p.approved_invoice_id != ${invoiceId})
      OR (p.approved_invoice_id = ${invoiceId} AND p.order_id != ${orderId}))
    OR EXISTS(SELECT 1 FROM customer_payments p WHERE p.order_id = ${orderId} AND (
      (SELECT COUNT(*) FROM cash_transactions t WHERE t.ref_table = 'customer_payments' AND t.ref_id = p.id)
        != CASE WHEN p.cash_account_id IS NULL THEN 0 ELSE 1 END
      OR (p.cash_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cash_transactions t WHERE t.ref_table = 'customer_payments' AND t.ref_id = p.id
        AND t.account_id = p.cash_account_id AND t.direction = 'in' AND t.amount_minor = p.amount_minor AND t.reversal_of_id IS NULL AND t.transfer_group IS NULL))))
    OR EXISTS(SELECT 1 FROM customer_payment_refunds r WHERE r.order_id = ${orderId} AND (
      (SELECT COUNT(*) FROM cash_transactions t WHERE t.ref_table = 'customer_payment_refunds' AND t.ref_id = r.id) != 1
      OR NOT EXISTS(SELECT 1 FROM cash_transactions t WHERE t.ref_table = 'customer_payment_refunds' AND t.ref_id = r.id
        AND t.account_id = r.cash_account_id AND t.direction = 'out' AND t.amount_minor = r.amount_minor AND t.reversal_of_id IS NULL AND t.transfer_group IS NULL)
      OR (SELECT COALESCE(SUM(a.amount_minor), 0) FROM customer_payment_refund_allocations a WHERE a.refund_id = r.id) != r.amount_minor))
    OR EXISTS(SELECT 1 FROM customer_payment_refund_allocations a
      WHERE (a.refund_id IN (${refunds})) != (a.payment_id IN (${payments})))
    OR EXISTS(SELECT 1 FROM cash_transactions x WHERE x.reversal_of_id IN (SELECT t.id FROM cash_transactions t WHERE ${cycleCash}))
    OR EXISTS(SELECT 1 FROM cash_transactions t WHERE ${cycleCash} GROUP BY t.account_id
      HAVING SUM(CASE WHEN t.direction = 'in' THEN t.amount_minor ELSE -t.amount_minor END) != 0)
  )`
}

function assertUnapprovedInvoiceDeletable(invoice: typeof finalInvoices.$inferSelect): void {
  const order = getOrderOrThrow(invoice.orderId!)
  if (order.finalInvoiceId !== invoice.id || order.status !== 'awaiting_approval' || order.archivedAt) {
    throw new AppError('CONFLICT', 'لا يمكن حذف الفاتورة نهائياً إلا بعد إلغاء اعتمادها وبقاء طلبها بانتظار الاعتماد')
  }
  if (getDatabase().get<{ blocked: number }>(sql`SELECT (${orderHistoryExists(order.id, invoice.id)} OR ${paymentCycleUnprovable(order.id, invoice.id)}) AS blocked`)?.blocked) {
    throw new AppError('CONFLICT', 'لا يمكن حذف الفاتورة نهائياً لأن طلبها يحمل سجلاً مالياً أو تشغيلياً تاريخياً (دفعات أو استردادات أو تصنيع أو مشتريات أو مخزون) يجب الاحتفاظ به')
  }
}


export function unapproveFinalInvoice(input: { id: number; expectedRevision: number }, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.orders.unapproveInvoice)
  withTransaction(() => {
    const invoice = getInvoiceOrThrow(input.id)
    if (invoice.status !== 'approved') throw new AppError('CONFLICT', 'الفاتورة غير معتمدة أو تم إلغاء اعتمادها بالفعل')
    if (invoice.approvalRevision !== input.expectedRevision) throw new AppError('CONFLICT', 'تغير إصدار اعتماد الفاتورة. حدّث القائمة ثم حاول مجدداً')
    assertUnapprovalAllowed(invoice)
    const db = getDatabase()
    const before = getOrder(invoice.orderId!)
    db.insert(invoiceApprovalHistory).values({ invoiceId: invoice.id, revision: invoice.approvalRevision,
      snapshot: JSON.stringify({ invoice, lines: getFinalInvoiceLines(invoice.id), terms: getFinalInvoiceTerms(invoice.id), order: before.order, orderLines: before.lines }),
      createdBy: ctx.session.user.id, createdAt: nowIso()
    }).run()
    db.update(finalInvoices).set({ status: 'draft', issuedAt: null, issuedBy: null }).where(eq(finalInvoices.id, invoice.id)).run()
    db.update(orders).set({ status: 'awaiting_approval' }).where(eq(orders.id, invoice.orderId!)).run()
    // The sale is undone, so the physical products are unsold — but the
    // draft still lists them, so they are re-held for this same invoice
    // rather than released to everyone.
    releaseInvoiceProducts(invoice.id, ctx)
    syncInvoiceReservations(invoice.id, ctx)
    recordAuditEvent({ userId: ctx.session.user.id, action: 'finalInvoices.unapprove', entity: 'final_invoices', entityId: String(invoice.id), details: { documentNumber: invoice.documentNumber, orderId: invoice.orderId, beforeStatus: 'approved', afterStatus: 'draft', revision: invoice.approvalRevision, timestamp: nowIso() } })
  })
}

/** A draft is the only editable state — an approved invoice is frozen. */
function assertDraft(id: number) {
  const invoice = getInvoiceOrThrow(id)
  if (invoice.status === 'cancelled') {
    throw new AppError('CONFLICT', 'الفاتورة المعتمدة ملغاة — لا يمكن تعديلها')
  }
  if (invoice.status !== 'draft') {
    throw new AppError(
      'CONFLICT',
      'لا يمكن تعديل فاتورة معتمدة بعد اعتمادها — الشروط التجارية مجمّدة وقد أنشأت طلب عميل'
    )
  }
  if (invoice.orderId) assertInvoiceCorrectionSafe(invoice)
  return invoice
}

/**
 * The Approved Invoice list, plus the two COMPANY-WIDE financial
 * summaries shown above it.
 *
 * Those summaries are separately permissioned business data, so they
 * are computed here and simply ARE NOT PRESENT in the response when the
 * session may not see them — the renderer cannot "forget" to hide a
 * card it was never given, and a direct IPC call gets nothing either.
 * The same rule redacts each row's live payment position, which is the
 * per-customer half of the same outstanding-balance question.
 *
 * `session` is optional so the existing internal callers (and tests)
 * that ask for the plain list keep working unchanged; the IPC handler
 * always passes it.
 */
export function listFinalInvoices(
  filter: {
    search?: string
    status?: string
    orderId?: number
    archived?: boolean
  } = {},
  session?: AuthSession,
  request: PageRequest = {}
) {
  const normalized = {
    search: normalizedSearch(filter.search),
    status: filter.status,
    orderId: filter.orderId,
    archived: Boolean(filter.archived)
  }
  const clauses: SQL[] = []
  // The linked Customer Order owns the only archive lifecycle. Drafts and
  // legacy invoices with no order remain active; an invoice is archived for
  // list purposes only while its stable order FK points at an archived order.
  clauses.push(
    normalized.archived
      ? and(isNotNull(finalInvoices.orderId), isNotNull(orders.archivedAt))!
      : or(isNull(finalInvoices.orderId), isNull(orders.archivedAt))!
  )
  if (normalized.status) clauses.push(eq(finalInvoices.status, normalized.status))
  if (normalized.orderId) clauses.push(eq(finalInvoices.orderId, normalized.orderId))
  if (normalized.search) {
    const p = `%${normalized.search}%`
    clauses.push(
      or(
        like(finalInvoices.documentNumber, p),
        like(customers.name, p),
        like(orders.documentNumber, p)
      )!
    )
  }
  const db = getDatabase()
  const where = and(...clauses)
  const canSeeOutstanding = !session || hasPermission(session, PERMISSION_KEYS.finalInvoices.viewOutstanding)
  const canSeeApprovedTotal = !session || hasPermission(session, PERMISSION_KEYS.finalInvoices.viewApprovedTotal)

  return keysetPage({
    scope: 'finalInvoices.list',
    filters: normalized,
    request,
    defaultLimit: 25,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => {
      const rows = db
        .select({
          id: finalInvoices.id,
          documentNumber: finalInvoices.documentNumber,
          orderId: finalInvoices.orderId,
          orderNumber: orders.documentNumber,
          orderArchivedAt: orders.archivedAt,
          orderStatus: orders.status,
          // Lifecycle eligibility in the same statement (DB-10 budget): mirrors the mutation guards.
          manufacturingStarted: sql<number>`EXISTS(SELECT 1 FROM work_sheets w WHERE w.order_id = ${finalInvoices.orderId} AND ${sql.raw(manufacturingStartedSql('w'))})`,
          deletable: sql<number>`(${finalInvoices.status} = 'draft' AND (${finalInvoices.orderId} IS NULL OR (
            ${orders.status} = 'awaiting_approval' AND ${orders.archivedAt} IS NULL AND ${orders.finalInvoiceId} = ${finalInvoices.id}
            AND NOT ${orderHistoryExists(finalInvoices.orderId, finalInvoices.id)}
            AND NOT ${paymentCycleUnprovable(finalInvoices.orderId, finalInvoices.id)})))`,
          customerId: finalInvoices.customerId,
          customerName: customers.name,
          status: finalInvoices.status,
          approvalRevision: finalInvoices.approvalRevision,
          issuedAt: finalInvoices.issuedAt,
          totalMinor: finalInvoices.totalMinor,
          depositRequiredMinor: finalInvoices.depositRequiredMinor,
          cancelReason: finalInvoices.cancelReason,
          createdAt: finalInvoices.createdAt,
          orderTotalMinor: orders.totalMinor,
          orderDepositRequiredMinor: orders.depositRequiredMinor
        })
        .from(finalInvoices)
        // LEFT JOIN: a draft has no order yet, and must still be listed.
        .leftJoin(orders, eq(finalInvoices.orderId, orders.id))
        .innerJoin(customers, eq(finalInvoices.customerId, customers.id))
        .where(and(where, keysetBoundary([sql`${finalInvoices.id}`], window)))
        .orderBy(keysetOrder([sql`${finalInvoices.id}`], window))
        .limit(window.take)
        .all()
      const orderIds = [...new Set(rows.map((row) => row.orderId).filter((id): id is number => id !== null))]
      const paid = new Map(orderIds.length
        ? db.all<{ orderId: number; paidMinor: number }>(sql`
            SELECT o.id AS orderId,
              COALESCE((SELECT SUM(amount_minor) FROM customer_payments WHERE order_id = o.id), 0)
                - COALESCE((SELECT SUM(amount_minor) FROM customer_payment_refunds WHERE order_id = o.id), 0) AS paidMinor
            FROM orders o WHERE o.id IN (${idList(orderIds)})
          `).map((row) => [row.orderId, row.paidMinor])
        : [])
      // Paid/remaining are always live (item 33) — never read off the snapshot;
      // the same rules as invoicePaymentPosition/orderPaymentPosition.
      return rows.map(({ orderTotalMinor, orderDepositRequiredMinor, manufacturingStarted: started, deletable, ...row }) => {
        let payment: { paidMinor: number; remainingMinor: number; paymentStatus: string }
        if (!row.orderId) {
          payment = { paidMinor: 0, remainingMinor: row.totalMinor, paymentStatus: 'unpaid' }
        } else {
          const paidMinor = paid.get(row.orderId) ?? 0
          payment = row.status === 'draft'
            ? { paidMinor, remainingMinor: row.totalMinor - paidMinor, paymentStatus: paymentStatusFor(row.totalMinor, paidMinor, row.depositRequiredMinor) }
            : { paidMinor, remainingMinor: orderTotalMinor! - paidMinor, paymentStatus: paymentStatusFor(orderTotalMinor!, paidMinor, orderDepositRequiredMinor!) }
        }
        // The CC02 rule only; the remaining correction blockers are reported when the action runs.
        const lifecycle = {
          canUnapprove: row.status === 'approved' && Boolean(row.orderId) && !row.orderArchivedAt && !started && payment.paidMinor === 0,
          canDelete: Boolean(deletable),
          canArchive: row.status === 'approved' && Boolean(row.orderId) && orderCanArchive({ status: row.orderStatus!, archivedAt: row.orderArchivedAt })
        }
        const priced = { ...row, ...payment, ...lifecycle }
        if (canSeeOutstanding) return priced
        // Strip the live receivable position; the document's own
        // agreed total stays, since that is the row's own content.
        const rest: Record<string, unknown> = { ...priced }
        delete rest.paidMinor
        delete rest.remainingMinor
        delete rest.paymentStatus
        return rest as Omit<typeof priced, 'paidMinor' | 'remainingMinor' | 'paymentStatus'>
      })
    },
    // Company summaries describe the full filtered archive bucket, not just
    // the visible page. The live outstanding expression mirrors
    // invoicePaymentPosition/orderPaymentPosition without loading unbounded
    // rows into memory.
    summary: () => {
      const aggregate = db
        .select({
          totalCount: sql<number>`COUNT(*)`,
          totalApprovedMinor: sql<number>`COALESCE(SUM(CASE WHEN ${finalInvoices.status} != 'cancelled' THEN ${finalInvoices.totalMinor} ELSE 0 END), 0)`,
          totalOutstandingMinor: sql<number>`COALESCE(SUM(CASE
            WHEN ${finalInvoices.status} = 'cancelled' THEN 0
            WHEN ${finalInvoices.orderId} IS NULL THEN ${finalInvoices.totalMinor}
            WHEN ${finalInvoices.status} = 'draft' THEN ${finalInvoices.totalMinor} -
              (COALESCE((SELECT SUM(amount_minor) FROM customer_payments WHERE order_id = ${finalInvoices.orderId}), 0)
               - COALESCE((SELECT SUM(amount_minor) FROM customer_payment_refunds WHERE order_id = ${finalInvoices.orderId}), 0))
            ELSE ${orders.totalMinor} -
              (COALESCE((SELECT SUM(amount_minor) FROM customer_payments WHERE order_id = ${finalInvoices.orderId}), 0)
               - COALESCE((SELECT SUM(amount_minor) FROM customer_payment_refunds WHERE order_id = ${finalInvoices.orderId}), 0))
          END), 0)`
        })
        .from(finalInvoices)
        .leftJoin(orders, eq(finalInvoices.orderId, orders.id))
        .innerJoin(customers, eq(finalInvoices.customerId, customers.id))
        .where(where)
        .get()
      return {
        totalCount: aggregate?.totalCount ?? 0,
        ...(canSeeApprovedTotal ? { totalApprovedMinor: aggregate?.totalApprovedMinor ?? 0 } : {}),
        ...(canSeeOutstanding ? { totalOutstandingMinor: aggregate?.totalOutstandingMinor ?? 0 } : {})
      }
    }
  })
}

export function getFinalInvoiceLines(invoiceId: number) {
  return loadItemSelections(
    'finalInvoice',
    getDatabase()
      .select()
      .from(finalInvoiceLines)
      .where(eq(finalInvoiceLines.finalInvoiceId, invoiceId))
      .orderBy(finalInvoiceLines.id)
      .all()
  )
}

/**
 * The Approved Invoice's selected Terms/Conditions, in catalog order
 * (item 9) — `termIndex` is exactly that catalog position, so ordering
 * by it reproduces the configured global order regardless of the order
 * the user picked them in.
 */
export function getFinalInvoiceTerms(invoiceId: number) {
  return getDatabase()
    .select()
    .from(finalInvoiceTerms)
    .where(eq(finalInvoiceTerms.finalInvoiceId, invoiceId))
    .orderBy(finalInvoiceTerms.termIndex)
    .all()
}

/**
 * Validates a set of catalog indexes and inserts one snapshot row per
 * index — the one place that actually writes `final_invoice_terms`,
 * shared by both entry points that can select terms:
 *
 *  • `addFinalInvoiceTerms`, for an already-saved draft invoice;
 *  • `createFinalInvoice`, for terms picked before the invoice existed
 *    at all (item 4 of the create-flow pass) — inserted inside the
 *    SAME transaction as the invoice and its lines, so the create is
 *    genuinely atomic: invoice + items + terms, or none of them.
 *
 * Caller-provided `toAdd` must already be deduplicated (both against
 * the request itself and, where relevant, against what the invoice
 * already has) — this function only validates and writes.
 */
function insertTermRows(invoiceId: number, toAdd: number[], catalog: string[]): void {
  for (const index of toAdd) {
    if (!Number.isInteger(index) || index < 0 || index >= catalog.length) {
      throw new AppError('VALIDATION_ERROR', 'أحد البنود المحددة غير موجود في قائمة البنود والشروط')
    }
  }
  const db = getDatabase()
  for (const index of toAdd) {
    db.insert(finalInvoiceTerms)
      .values({
        finalInvoiceId: invoiceId,
        termIndex: index,
        termText: catalog[index]!,
        createdAt: nowIso()
      })
      .run()
  }
}

/**
 * Item 3/4/5/6: pick one or more terms from the ONE authoritative global
 * catalog (`getTerms()` — never duplicated, never hardcoded here) onto
 * an ALREADY-SAVED Approved Invoice. Wording is frozen the moment a
 * term is picked (item 10), so a later edit to the global catalog can
 * never rewrite an invoice that already selected it — draft or approved.
 *
 * Only a draft may be edited (reuses the same lock `updateFinalInvoice`
 * already enforces — item 12/15). An index already on this invoice is
 * silently skipped rather than erroring (item 6's duplicate guard); the
 * UNIQUE (final_invoice_id, term_index) index backs this at the
 * database level too.
 */
export function addFinalInvoiceTerms(
  invoiceId: number,
  termIndexes: number[],
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.finalInvoices.manage)
  assertDraft(invoiceId)
  if (!termIndexes.length) return

  const catalog = getTerms()
  const existing = new Set(getFinalInvoiceTerms(invoiceId).map((row) => row.termIndex))
  // Dedup the request itself too, so a client sending [2,2,4] behaves
  // exactly like [2,4].
  const toAdd = [...new Set(termIndexes)].filter((index) => !existing.has(index))
  if (!toAdd.length) return

  withTransaction(() => {
    insertTermRows(invoiceId, toAdd, catalog)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'finalInvoices.terms.add',
      entity: 'final_invoice_terms',
      entityId: String(invoiceId),
      details: { termIndexes: toAdd }
    })
  })
}

/**
 * Item 8: removes ONE term's association/snapshot from THIS invoice
 * only — the global catalog it was picked from is never touched.
 */
export function removeFinalInvoiceTerm(
  invoiceId: number,
  termRowId: number,
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.finalInvoices.manage)
  return withTransaction(() => {
    assertDraft(invoiceId)
    const row = getDatabase()
      .select()
      .from(finalInvoiceTerms)
      .where(
        and(eq(finalInvoiceTerms.id, termRowId), eq(finalInvoiceTerms.finalInvoiceId, invoiceId))
      )
      .get()
    if (!row) throw notFound('البند غير موجود على هذه الفاتورة')

    getDatabase().delete(finalInvoiceTerms).where(eq(finalInvoiceTerms.id, termRowId)).run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'finalInvoices.terms.remove',
      entity: 'final_invoice_terms',
      entityId: String(invoiceId),
      details: { termRowId, termIndex: row.termIndex }
    })
  })
}

/**
 * Normalises both document generations into one shape:
 *  • a legacy invoice renders from its frozen `snapshot`;
 *  • an approved invoice renders from the snapshot frozen at approval;
 *  • a draft renders live from its own editable lines.
 */
export function getFinalInvoice(id: number) {
  const invoice = getInvoiceOrThrow(id)
  const lines = getFinalInvoiceLines(id)
  const customer = getDatabase()
    .select()
    .from(customers)
    .where(eq(customers.id, invoice.customerId))
    .get()
  const order = invoice.orderId
    ? getDatabase().select().from(orders).where(eq(orders.id, invoice.orderId)).get()
    : undefined

  const snapshot: FinalInvoiceSnapshot = invoice.status !== 'draft' && invoice.snapshot
    ? (JSON.parse(invoice.snapshot) as FinalInvoiceSnapshot)
    : {
        customer: {
          name: customer?.name ?? '',
          phone: customer?.phone ?? null,
          address: customer?.address ?? invoice.address ?? null
        },
        orderNumber: order?.documentNumber ?? '',
        orderCreatedAt: order?.createdAt ?? invoice.createdAt,
        lines: lines.map((line) => ({
          description: line.description,
          specifications: line.specifications,
          dimensions: line.dimensions,
          selectedMaterials: line.selectedMaterials,
          selectedColors: line.selectedColors,
          selectedAccessories: line.selectedAccessories,
          materialType: line.materialType,
          colorCode: line.colorCode,
          accessories: line.accessories,
          quantityMicro: line.quantityMicro,
          unitPriceMinor: line.unitPriceMinor,
          lineTotalMinor: line.lineTotalMinor
        })),
        subtotalMinor: invoice.subtotalMinor,
        discountMinor: invoice.discountMinor,
        totalMinor: invoice.totalMinor,
        meterPriceMinor: invoice.meterPriceMinor,
        installationPriceMinor: invoice.installationPriceMinor,
        deliveryPriceMinor: invoice.deliveryPriceMinor,
        requiresInstallation: invoice.requiresInstallation,
        requiresDelivery: invoice.requiresDelivery
      }

  // Old 0030 JSON snapshots keep their wording; use only matching migrated
  // child snapshots to recover a material association, never live catalog data.
  snapshot.lines = snapshot.lines.map((line, index) =>
    line.selectedMaterials
      ? {
          ...line,
          selectedMaterials: restoreSnapshotMaterialGroups(
            line.selectedMaterials,
            line.selectedColors ?? [],
            lines[index]
          )
        }
      : line
  )

  return {
    invoice,
    lines,
    terms: getFinalInvoiceTerms(id),
    snapshot,
    payment: invoicePaymentPosition(invoice)
  }
}

function insertInvoiceLines(
  invoiceId: number,
  lines: FinalInvoiceLineInput[],
  lineTotals: number[],
  selectionSets: ItemSelections[] = prepareItemSelections(lines)
): void {
  const db = getDatabase()
  lines.forEach((line, index) => {
    const selections = selectionSets[index]!
    const lineId = Number(
      db
        .insert(finalInvoiceLines)
        .values({
          finalInvoiceId: invoiceId,
          lineKind: line.lineKind,
          productId: line.productId ?? null,
          materialId: line.materialId ?? null,
          description: line.description,
          specifications: line.specifications ?? null,
          dimensions: line.dimensions ?? null,
          colorCode: selections.selectedColors[0]?.code ?? null,
          accessoryMaterialId: selections.selectedAccessories[0]?.materialId ?? null,
          accessories: selections.selectedAccessories[0]?.name ?? null,
          materialTypeMaterialId: selections.selectedMaterials[0]?.materialId ?? null,
          materialType: selections.selectedMaterials[0]?.name ?? null,
          quantityMicro: line.quantityMicro,
          unitPriceMinor: line.unitPriceMinor,
          uncollectedProductId: line.uncollectedProductId ?? null,
          lineTotalMinor: lineTotals[index] ?? 0,
          // BR-46: the product's components are copied at invoice time, so
          // a later product edit never rewrites this document.
          bomSnapshot: line.productId ? buildBomSnapshot(line.productId) : null,
          notes: line.notes ?? null
        })
        .run().lastInsertRowid
    )
    insertItemSelections('finalInvoice', lineId, selections)
  })
}

/** A draft records an instruction only; the normal payment service posts at approval. */
function validateInitialPayment(
  amountMinor: number,
  accountId: number | null,
  totalMinor: number,
  ctx: ServiceContext
): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
    throw new AppError(
      'VALIDATION_ERROR',
      'المدفوع يجب أن يكون مبلغاً غير سالب بدقة العملة المعتمدة'
    )
  if (amountMinor > totalMinor)
    throw new AppError('VALIDATION_ERROR', 'المبلغ أكبر من الرصيد المتبقي على الطلب')
  if (amountMinor > 0 || accountId !== null) requirePermission(ctx.session, P.payments.manage)
  if (
    accountId !== null &&
    (!Number.isSafeInteger(accountId) ||
      accountId <= 0 ||
      !getDatabase().select().from(cashAccounts).where(eq(cashAccounts.id, accountId)).get())
  )
    throw new AppError('VALIDATION_ERROR', 'الحساب النقدي غير موجود')
}

export function createFinalInvoice(
  input: {
    customerId: number
    lines: FinalInvoiceLineInput[]
    discountKind?: 'none' | 'amount' | 'percent'
    discountValue?: number
    depositPercentBp?: number
    requiresInstallation?: boolean
    requiresDelivery?: boolean
    /** Commercial rate per metre — informational, never part of a total. */
    meterPriceMinor?: number
    /** Additional charges; each is added to the total exactly once. */
    installationPriceMinor?: number
    deliveryPriceMinor?: number
    /** Which fields this document may show on its PDF. */
    paidAmountMinor?: number
    initialCashAccountId?: number | null
    printVisibility?: PrintVisibilityInput
    address?: string
    notes?: string
    /**
     * Create-flow pass: terms picked in the UI before the invoice has
     * an id yet — the same catalog indexes `addFinalInvoiceTerms`
     * takes. Optional and empty by default; a brand-new invoice starts
     * with no existing term rows, so unlike `addFinalInvoiceTerms` there
     * is nothing to dedup against but the request itself.
     */
    termIndexes?: number[]
  },
  ctx: ServiceContext
): { id: number; documentNumber: string } {
  requirePermission(ctx.session, P.finalInvoices.manage)
  if (!input.lines.length) throw new AppError('VALIDATION_ERROR', 'يجب إضافة صنف واحد على الأقل')
  requireActiveCustomer(input.customerId)

  // Validated up front, before the transaction opens — a bad index
  // fails the whole create cleanly rather than mid-transaction.
  const catalog = getTerms()
  const termsToAdd = [...new Set(input.termIndexes ?? [])]

  return withTransaction(() => {
    const defaultDepositPercentBp = getDefaultDepositPercentBp()
    if (input.depositPercentBp !== undefined && input.depositPercentBp !== defaultDepositPercentBp) {
      requirePermission(ctx.session, P.orders.overrideDeposit)
    }
    const depositPercentBp = input.depositPercentBp ?? defaultDepositPercentBp
    const totals = computeDocumentTotals(
      input.lines,
      input.discountKind ?? 'none',
      input.discountValue ?? 0,
      depositPercentBp,
      {
        installationPriceMinor: input.installationPriceMinor,
        deliveryPriceMinor: input.deliveryPriceMinor
      }
    )
    validateInitialPayment(
      input.paidAmountMinor ?? 0,
      input.initialCashAccountId ?? null,
      totals.totalMinor,
      ctx
    )
    const documentNumber = nextDocumentNumber('FI')

    const id = Number(
      getDatabase()
        .insert(finalInvoices)
        .values({
          documentNumber,
          customerId: input.customerId,
          orderId: null,
          status: 'draft',
          subtotalMinor: totals.subtotalMinor,
          discountKind: input.discountKind ?? 'none',
          discountValue: input.discountValue ?? 0,
          discountMinor: totals.discountMinor,
          totalMinor: totals.totalMinor,
          paidAmountMinor: input.paidAmountMinor ?? 0,
          initialCashAccountId: input.initialCashAccountId ?? null,
          depositPercentBp,
          depositRequiredMinor: totals.depositRequiredMinor,
          requiresInstallation: input.requiresInstallation ?? false,
          requiresDelivery: input.requiresDelivery ?? false,
          meterPriceMinor: input.meterPriceMinor ?? 0,
          installationPriceMinor: totals.installationPriceMinor,
          deliveryPriceMinor: totals.deliveryPriceMinor,
          printVisibility: input.printVisibility
            ? serializePrintVisibility(input.printVisibility)
            : null,
          address: input.address ?? null,
          notes: input.notes ?? null,
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    for (const line of input.lines) {
      if (line.uncollectedProductId) assertSellable(line.uncollectedProductId, null)
    }
    insertInvoiceLines(id, input.lines, totals.lineTotals)
    // Holds each claimed physical product against THIS invoice, so a
    // second draft cannot claim the same one.
    syncInvoiceReservations(id, ctx)
    // Item 4/5: the invoice header, its items and its selected terms
    // are one logical create — all in this same transaction, so a bad
    // term index (or any other failure) leaves no partially-created
    // invoice behind at all, not even one with no terms.
    insertTermRows(id, termsToAdd, catalog)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'finalInvoices.create',
      entity: 'final_invoices',
      entityId: String(id),
      details: {
        documentNumber,
        totalMinor: totals.totalMinor,
        depositPercentBp,
        depositRequiredMinor: totals.depositRequiredMinor,
        termIndexes: termsToAdd,
        paidAmountMinor: input.paidAmountMinor ?? 0,
        initialCashAccountId: input.initialCashAccountId ?? null
      }
    })
    return { id, documentNumber }
  })
}

export function updateFinalInvoice(
  id: number,
  input: {
    lines?: FinalInvoiceLineInput[]
    discountKind?: 'none' | 'amount' | 'percent'
    discountValue?: number
    depositPercentBp?: number
    requiresInstallation?: boolean
    requiresDelivery?: boolean
    meterPriceMinor?: number
    installationPriceMinor?: number
    deliveryPriceMinor?: number
    paidAmountMinor?: number
    initialCashAccountId?: number | null
    printVisibility?: PrintVisibilityInput
    address?: string
    notes?: string
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.finalInvoices.manage)
  withTransaction(() => {
    const invoice = assertDraft(id)
    const db = getDatabase()
    const depositPercentBp = input.depositPercentBp ?? invoice.depositPercentBp
    const depositChanged = depositPercentBp !== invoice.depositPercentBp
    if (depositChanged) requirePermission(ctx.session, P.orders.overrideDeposit)
    const discountKind = (input.discountKind ?? invoice.discountKind) as
      'none' | 'amount' | 'percent'
    const discountValue = input.discountValue ?? invoice.discountValue

    const lines: FinalInvoiceLineInput[] =
      input.lines ??
      getFinalInvoiceLines(id).map((line) => ({
        lineKind: line.lineKind as FinalInvoiceLineInput['lineKind'],
        productId: line.productId,
        materialId: line.materialId,
        description: line.description,
        specifications: line.specifications,
        dimensions: line.dimensions,
        materialType: line.materialType,
        materialTypeMaterialId: line.materialTypeMaterialId,
        colorCode: line.colorCode,
        accessories: line.accessories,
        accessoryMaterialId: line.accessoryMaterialId,
        quantityMicro: line.quantityMicro,
        unitPriceMinor: line.unitPriceMinor,
        // Carried explicitly: an update that does not resend its lines
        // must not silently drop which physical product they sell.
        uncollectedProductId: line.uncollectedProductId,
        notes: line.notes
      }))
    if (!lines.length) throw new AppError('VALIDATION_ERROR', 'يجب إضافة صنف واحد على الأقل')

    const totals = computeDocumentTotals(lines, discountKind, discountValue, depositPercentBp, {
      installationPriceMinor: input.installationPriceMinor ?? invoice.installationPriceMinor,
      deliveryPriceMinor: input.deliveryPriceMinor ?? invoice.deliveryPriceMinor
    })

    const paidAmountMinor = input.paidAmountMinor ?? invoice.paidAmountMinor
    const initialCashAccountId =
      input.initialCashAccountId === undefined
        ? invoice.initialCashAccountId
        : input.initialCashAccountId
    if (invoice.orderId) {
      if (paidAmountMinor !== invoice.paidAmountMinor || initialCashAccountId !== invoice.initialCashAccountId) throw new AppError('CONFLICT', 'الدفعة الأولية رُحّلت سابقاً؛ تصحيح المال يتم من دفعات العميل وليس بإعادة اعتماد الفاتورة')
    } else validateInitialPayment(paidAmountMinor, initialCashAccountId, totals.totalMinor, ctx)

    if (input.lines) {
      const selectionSets = prepareItemSelections(lines, getFinalInvoiceLines(id))
      db.delete(finalInvoiceLines).where(eq(finalInvoiceLines.finalInvoiceId, id)).run()
      for (const line of lines) {
        if (line.uncollectedProductId) assertSellable(line.uncollectedProductId, id)
      }
      insertInvoiceLines(id, lines, totals.lineTotals, selectionSets)
      // Re-claims what the invoice still sells and releases what it
      // dropped, so a removed line frees its product immediately.
      syncInvoiceReservations(id, ctx)
    }

    db.update(finalInvoices)
      .set({
        subtotalMinor: totals.subtotalMinor,
        discountKind,
        discountValue,
        discountMinor: totals.discountMinor,
        totalMinor: totals.totalMinor,
        paidAmountMinor,
        initialCashAccountId,
        depositPercentBp,
        depositRequiredMinor: totals.depositRequiredMinor,
        requiresInstallation: input.requiresInstallation ?? invoice.requiresInstallation,
        requiresDelivery: input.requiresDelivery ?? invoice.requiresDelivery,
        meterPriceMinor: input.meterPriceMinor ?? invoice.meterPriceMinor,
        installationPriceMinor: totals.installationPriceMinor,
        deliveryPriceMinor: totals.deliveryPriceMinor,
        // Only rewritten when the caller sent a choice — omitting it
        // must never silently reset a document back to defaults.
        printVisibility: input.printVisibility
          ? serializePrintVisibility(input.printVisibility)
          : invoice.printVisibility,
        address: input.address ?? invoice.address,
        notes: input.notes ?? invoice.notes
      })
      .where(eq(finalInvoices.id, id))
      .run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'finalInvoices.update',
      entity: 'final_invoices',
      entityId: String(id),
      details: {
        lineCount: input.lines?.length,
        paidAmountMinor: input.paidAmountMinor,
        initialCashAccountId: input.initialCashAccountId,
        ...(depositChanged ? {
          oldDepositPercentBp: invoice.depositPercentBp,
          newDepositPercentBp: depositPercentBp,
          oldDepositRequiredMinor: invoice.depositRequiredMinor,
          newDepositRequiredMinor: totals.depositRequiredMinor
        } : {})
      }
    })
  })
}

/** Convenience: an approved invoice for one standard product. */
export function createStandardFinalInvoice(
  input: {
    customerId: number
    productId: number
    quantityMicro: number
    unitPriceMinor?: number
    discountKind?: 'none' | 'amount' | 'percent'
    discountValue?: number
    depositPercentBp?: number
    requiresInstallation?: boolean
    requiresDelivery?: boolean
    dimensions?: string
    colorCode?: string
    accessories?: string
    specifications?: string
    address?: string
    notes?: string
  },
  ctx: ServiceContext
): { id: number; documentNumber: string } {
  const product = getDatabase()
    .select()
    .from(products)
    .where(eq(products.id, input.productId))
    .get()
  if (!product) throw notFound('المنتج غير موجود')
  if (input.quantityMicro <= 0) {
    throw new AppError('VALIDATION_ERROR', 'الكمية يجب أن تكون أكبر من صفر')
  }
  return createFinalInvoice(
    {
      ...input,
      lines: [
        {
          lineKind: 'standard',
          productId: product.id,
          description: product.name,
          specifications: input.specifications ?? product.description ?? null,
          dimensions: input.dimensions ?? null,
          colorCode: input.colorCode ?? null,
          accessories: input.accessories ?? null,
          quantityMicro: input.quantityMicro,
          unitPriceMinor: input.unitPriceMinor ?? product.defaultPriceMinor
        }
      ]
    },
    ctx
  )
}

export interface ApprovalResult {
  invoiceId: number
  orderId: number
  orderNumber: string
  /** True when the invoice was already approved — nothing was created. */
  alreadyApproved: boolean
}

/**
 * THE authoritative invoice → order transition.
 *
 * Idempotent by design (Test 3/4): an invoice that already carries an
 * order returns that order untouched. Everything else happens in one
 * transaction — freeze the snapshot, create the order with its lines,
 * seed the order's production configuration from the product defaults —
 * so a failure anywhere leaves no half-approved document behind.
 */
export function approveFinalInvoice(id: number, ctx: ServiceContext, expectedRevision?: number): ApprovalResult {
  requirePermission(ctx.session, P.finalInvoices.approve)
  return withTransaction(() => {
    const invoice = getInvoiceOrThrow(id)

    if (invoice.status === 'cancelled') {
      throw new AppError('CONFLICT', 'الفاتورة المعتمدة ملغاة — لا يمكن اعتمادها')
    }
    // Idempotent: a retry, a double click or a replayed IPC request finds
    // the order that already exists and returns it.
    if (invoice.orderId && invoice.status === 'approved') {
      const existing = getOrderOrThrow(invoice.orderId)
      return {
        invoiceId: id,
        orderId: existing.id,
        orderNumber: existing.documentNumber,
        alreadyApproved: true
      }
    }

    const reapproval = Boolean(invoice.orderId)
    if (expectedRevision !== undefined && expectedRevision !== invoice.approvalRevision) throw new AppError('CONFLICT', 'تغير إصدار الفاتورة منذ عرضه؛ حدّث القائمة قبل الاعتماد')
    if (reapproval) assertInvoiceCorrectionSafe(invoice)

    const lines = getFinalInvoiceLines(id)
    if (!lines.length) {
      throw new AppError('VALIDATION_ERROR', 'لا يمكن اعتماد فاتورة بلا بنود')
    }
    const customer = getDatabase()
      .select()
      .from(customers)
      .where(eq(customers.id, invoice.customerId))
      .get()
    if (!customer) throw notFound('العميل غير موجود')

    requireActiveCustomer(invoice.customerId)
    if (!reapproval) validateInitialPayment(
      invoice.paidAmountMinor,
      invoice.initialCashAccountId,
      invoice.totalMinor,
      ctx
    )
    const db = getDatabase()
    const approvedAt = nowIso()
    const termsSnapshot = JSON.stringify(getTerms())

    // The order first — it is what the frozen snapshot names.
    const order = createOrderFromApprovedInvoice(
      {
        invoice: { ...invoice, termsSnapshot },
        existingOrderId: invoice.orderId ?? undefined,
        lines,
        customerId: invoice.customerId
      },
      ctx
    )

    // The durable invoice→order link survives unapproval, even if a payment was
    // corrected separately. Reapproval NEVER posts another initial payment.
    if (!reapproval && invoice.paidAmountMinor > 0) {
      recordPayment(
        {
          orderId: order.id,
          amountMinor: invoice.paidAmountMinor,
          cashAccountId: invoice.initialCashAccountId ?? undefined,
          approvedInvoiceId: invoice.id
        },
        ctx
      )
    }

    const snapshot: FinalInvoiceSnapshot = {
      customer: {
        name: customer.name,
        phone: customer.phone,
        address: customer.address ?? invoice.address
      },
      orderNumber: order.documentNumber,
      orderCreatedAt: getOrderOrThrow(order.id).createdAt,
      lines: lines.map((line) => ({
        description: line.description,
        specifications: line.specifications,
        dimensions: line.dimensions,
        selectedMaterials: line.selectedMaterials,
        selectedColors: line.selectedColors,
        selectedAccessories: line.selectedAccessories,
        materialType: line.materialType,
        colorCode: line.colorCode,
        accessories: line.accessories,
        quantityMicro: line.quantityMicro,
        unitPriceMinor: line.unitPriceMinor,
        lineTotalMinor: line.lineTotalMinor
      })),
      subtotalMinor: invoice.subtotalMinor,
      discountMinor: invoice.discountMinor,
      totalMinor: invoice.totalMinor,
      meterPriceMinor: invoice.meterPriceMinor,
      installationPriceMinor: invoice.installationPriceMinor,
      deliveryPriceMinor: invoice.deliveryPriceMinor,
      requiresInstallation: invoice.requiresInstallation,
      requiresDelivery: invoice.requiresDelivery
    }

    db.update(finalInvoices)
      .set({
        status: 'approved',
        approvalRevision: invoice.approvalRevision + 1,
        orderId: order.id,
        issuedAt: approvedAt,
        issuedBy: ctx.session.user.id,
        snapshot: JSON.stringify(snapshot),
        termsSnapshot
      })
      .where(eq(finalInvoices.id, id))
      .run()

    // The physical products this invoice sells leave stock for good.
    // Nothing is manufactured and no raw material is consumed — the
    // items already exist; approval only records who now owns them.
    markProductsSold({ invoiceId: id, orderId: order.id }, ctx)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: reapproval ? 'finalInvoices.reapprove' : 'finalInvoices.approve',
      entity: 'final_invoices',
      entityId: String(id),
      details: {
        documentNumber: invoice.documentNumber,
        orderId: order.id,
        orderNumber: order.documentNumber,
        totalMinor: invoice.totalMinor,
        initialPaymentMinor: reapproval ? 0 : invoice.paidAmountMinor,
        previousRevision: invoice.approvalRevision,
        revision: invoice.approvalRevision + 1
      }
    })
    return {
      invoiceId: id,
      orderId: order.id,
      orderNumber: order.documentNumber,
      alreadyApproved: false
    }
  })
}

/**
 * Item 37: an approved invoice is never hard-deleted — voiding keeps
 * the row, its number and its frozen snapshot.
 *
 * An approved invoice that produced a LIVE order cannot be voided: the
 * order is its financial consequence and must be cancelled first, or
 * the two records would contradict each other.
 */
export function cancelFinalInvoice(
  input: { id: number; reason: string },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.finalInvoices.cancel)
  withTransaction(() => {
    const invoice = getInvoiceOrThrow(input.id)
    if (invoice.status === 'cancelled') {
      throw new AppError('CONFLICT', 'الفاتورة المعتمدة ملغاة بالفعل')
    }
    if (!input.reason?.trim()) throw new AppError('VALIDATION_ERROR', 'سبب الإلغاء مطلوب')

    if (invoice.orderId) {
      const order = getDatabase().select().from(orders).where(eq(orders.id, invoice.orderId)).get()
      if (order && order.status !== 'cancelled') {
        throw new AppError(
          'CONFLICT',
          `لا يمكن إلغاء الفاتورة المعتمدة لأنها أنشأت طلب العميل ${order.documentNumber}. يجب إلغاء الطلب أولاً`
        )
      }
    }

    getDatabase()
      .update(finalInvoices)
      .set({ status: 'cancelled', cancelledAt: nowIso(), cancelReason: input.reason })
      .where(eq(finalInvoices.id, input.id))
      .run()
    // A voided invoice owns nothing: whatever physical products it sold or
    // held return to "متاح للبيع" in this same transaction.
    releaseInvoiceProducts(input.id, ctx)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'finalInvoices.cancel',
      entity: 'final_invoices',
      entityId: String(input.id),
      details: { reason: input.reason, orderId: invoice.orderId }
    })
  })
}

/**
 * A draft has no financial consequence, so it may be removed outright. An
 * UNAPPROVED invoice (draft that still carries its order) takes its unposted
 * order with it; any payment/refund/manufacturing/stock history blocks this.
 */
export function deleteFinalInvoice(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.finalInvoices.remove)
  withTransaction(() => {
    const invoice = getInvoiceOrThrow(id)
    if (invoice.status !== 'draft') {
      throw new AppError('CONFLICT', 'لا يمكن حذف فاتورة معتمدة — يمكن إلغاؤها مع حفظ سجلها')
    }
    if (invoice.orderId) assertUnapprovedInvoiceDeletable(invoice)
    const db = getDatabase()
    const approvalHistory = invoice.orderId
      ? db.select().from(invoiceApprovalHistory).where(eq(invoiceApprovalHistory.invoiceId, id)).all()
      : []
    releaseInvoiceProducts(id, ctx)
    let reversedCycle: { paymentIds: number[]; refundIds: number[]; cashTransactionIds: number[] } | null = null
    if (invoice.orderId) {
      const orderId = invoice.orderId
      const ids = (query: SQL) => db.all<{ id: number }>(query).map((row) => row.id)
      reversedCycle = {
        paymentIds: ids(sql`SELECT id FROM customer_payments WHERE order_id = ${orderId} ORDER BY id`),
        refundIds: ids(sql`SELECT id FROM customer_payment_refunds WHERE order_id = ${orderId} ORDER BY id`),
        cashTransactionIds: ids(sql`SELECT id FROM cash_transactions
          WHERE (ref_table = 'customer_payments' AND ref_id IN (SELECT id FROM customer_payments WHERE order_id = ${orderId}))
             OR (ref_table = 'customer_payment_refunds' AND ref_id IN (SELECT id FROM customer_payment_refunds WHERE order_id = ${orderId}))
          ORDER BY id`)
      }
      // Owner-approved hard delete of the proven, cash-neutral payment/refund cycle (by exact ids only).
      if (reversedCycle.refundIds.length) {
        db.delete(customerPaymentRefundAllocations).where(inArray(customerPaymentRefundAllocations.refundId, reversedCycle.refundIds)).run()
      }
      if (reversedCycle.cashTransactionIds.length) db.delete(cashTransactions).where(inArray(cashTransactions.id, reversedCycle.cashTransactionIds)).run()
      if (reversedCycle.refundIds.length) db.delete(customerPaymentRefunds).where(inArray(customerPaymentRefunds.id, reversedCycle.refundIds)).run()
      if (reversedCycle.paymentIds.length) db.delete(customerPayments).where(inArray(customerPayments.id, reversedCycle.paymentIds)).run()
      db.update(orders).set({ finalInvoiceId: null }).where(eq(orders.id, invoice.orderId)).run()
      db.delete(invoiceApprovalHistory).where(eq(invoiceApprovalHistory.invoiceId, id)).run()
    }
    db.delete(finalInvoiceLines).where(eq(finalInvoiceLines.finalInvoiceId, id)).run()
    db.delete(finalInvoiceTerms).where(eq(finalInvoiceTerms.finalInvoiceId, id)).run()
    db.delete(finalInvoices).where(eq(finalInvoices.id, id)).run()
    if (invoice.orderId) {
      // planned_* and order_lines (with their selections) cascade from the order.
      db.delete(orders).where(eq(orders.id, invoice.orderId)).run()
    }
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'finalInvoices.delete',
      entity: 'final_invoices',
      entityId: String(id),
      // The approval snapshots leave the tables, so the append-only audit keeps them.
      details: { documentNumber: invoice.documentNumber, orderId: invoice.orderId, afterUnapproval: Boolean(invoice.orderId), approvalHistory, reversedCycle }
    })
  })
}

/** Convenience for the order screen: the invoice that created the order. */
export function finalInvoiceForOrder(orderId: number) {
  return getDatabase()
    .select()
    .from(finalInvoices)
    .where(and(eq(finalInvoices.orderId, orderId), eq(finalInvoices.status, 'approved')))
    .get()
}

/** Kept for the customer-payment screens: total collected on an order. */
export function paidTotalMinor(orderId: number): number {
  return orderPaymentPosition(orderId).paidMinor
}

// Private physical-product primitives owned only by the invoice commands above.
/**
 * Claims products for a draft invoice and releases any it no longer
 * uses. Called inside the invoice's own transaction after its lines are
 * written, so the reservation always matches what the invoice says.
 *
 * A SOLD product is never re-claimable, and the UNIQUE index on
 * `final_invoice_lines.uncollected_product_id` means two invoices can
 * never hold the same physical product even under a race.
 */
function syncInvoiceReservations(invoiceId: number, ctx: ServiceContext): void {
  if (!getRawConnection().inTransaction || getInvoiceOrThrow(invoiceId).status !== 'draft')
    throw new AppError('CONFLICT', 'حجز المنتج يتطلب معاملة الفاتورة المسودة')
  const db = getDatabase()
  const claimed = (
    getRawConnection()
      .prepare(
        'SELECT uncollected_product_id AS id FROM final_invoice_lines WHERE final_invoice_id = ? AND uncollected_product_id IS NOT NULL'
      )
      .all(invoiceId) as Array<{ id: number }>
  ).map((row) => row.id)

  // Release anything this invoice reserved but no longer references.
  for (const row of db
    .select()
    .from(uncollectedProducts)
    .where(eq(uncollectedProducts.reservedInvoiceId, invoiceId))
    .all()) {
    if (!claimed.includes(row.id) && row.status === 'reserved') {
      db.update(uncollectedProducts)
        .set({ status: 'available', reservedInvoiceId: null })
        .where(eq(uncollectedProducts.id, row.id))
        .run()
    }
  }

  for (const id of claimed) {
    const product = db.select().from(uncollectedProducts).where(eq(uncollectedProducts.id, id)).get()
    if (!product) throw notFound('المنتج غير المستلم غير موجود')
    if (product.status === 'resumed') throw new AppError('CONFLICT', 'تم استئناف المنتج إلى طلبه الأصلي ولا يمكن بيعه')
    if (product.status === 'sold') {
      throw new AppError('CONFLICT', `المنتج "${product.name}" تم بيعه بالفعل ولا يمكن بيعه مرة أخرى`)
    }
    if (product.status === 'reserved' && product.reservedInvoiceId !== invoiceId) {
      throw new AppError('CONFLICT', `المنتج "${product.name}" محجوز على فاتورة أخرى`)
    }
    if (product.status !== 'reserved' || product.reservedInvoiceId !== invoiceId) {
      db.update(uncollectedProducts)
        .set({ status: 'reserved', reservedInvoiceId: invoiceId })
        .where(eq(uncollectedProducts.id, id))
        .run()
    }
  }
  void ctx
}

/**
 * Approval is the sale. Inside the approval transaction each reserved
 * product becomes SOLD and is linked to the invoice and the Customer
 * Order it was sold on — the second half of the audit trail that starts
 * at the original cancelled order.
 */
function markProductsSold(
  input: { invoiceId: number; orderId: number },
  ctx: ServiceContext
): void {
  const invoice = getInvoiceOrThrow(input.invoiceId)
  const order = getOrderOrThrow(input.orderId)
  if (!getRawConnection().inTransaction || invoice.status !== 'approved' || invoice.orderId !== order.id || order.status !== 'confirmed' || order.completedAt)
    throw new AppError('CONFLICT', 'بيع المنتج يتطلب معاملة اعتماد فاتورته وطلبه')
  const db = getDatabase()
  const lines = getRawConnection()
    .prepare(
      'SELECT uncollected_product_id AS id, line_total_minor AS total FROM final_invoice_lines WHERE final_invoice_id = ? AND uncollected_product_id IS NOT NULL'
    )
    .all(input.invoiceId) as Array<{ id: number; total: number }>
  if (!lines.length) return

  const soldAt = nowIso()
  for (const line of lines) {
    const product = db
      .select()
      .from(uncollectedProducts)
      .where(eq(uncollectedProducts.id, line.id))
      .get()
    if (!product) throw notFound('المنتج غير المستلم غير موجود')
    if (product.status === 'resumed') throw new AppError('CONFLICT', 'تم استئناف المنتج إلى طلبه الأصلي ولا يمكن بيعه')
    // Re-approval of the same invoice keeps its own sale; anything else
    // that is already sold is refused rather than sold twice.
    if (product.status === 'sold' && product.soldInvoiceId !== input.invoiceId) {
      throw new AppError('CONFLICT', `المنتج "${product.name}" تم بيعه بالفعل`)
    }
    db.update(uncollectedProducts)
      .set({
        status: 'sold',
        reservedInvoiceId: null,
        soldInvoiceId: input.invoiceId,
        soldOrderId: input.orderId,
        soldAt,
        soldPriceMinor: line.total
      })
      .where(eq(uncollectedProducts.id, line.id))
      .run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'uncollectedProducts.sold',
      entity: 'uncollected_products',
      entityId: String(line.id),
      details: {
        invoiceId: input.invoiceId,
        orderId: input.orderId,
        soldPriceMinor: line.total,
        costBasisMinor: product.costBasisMinor,
        sourceOrderId: product.sourceOrderId
      }
    })
  }
}

/** Releases every product an invoice held — used when it is unapproved
 *  or cancelled, so a physical product is never stranded as sold. */
function releaseInvoiceProducts(invoiceId: number, ctx: ServiceContext): void {
  if (!getRawConnection().inTransaction || !['draft', 'cancelled'].includes(getInvoiceOrThrow(invoiceId).status))
    throw new AppError('CONFLICT', 'تحرير المنتج يتطلب معاملة عكس الفاتورة')
  const db = getDatabase()
  const held = db
    .select()
    .from(uncollectedProducts)
    .where(
      or(
        eq(uncollectedProducts.soldInvoiceId, invoiceId),
        eq(uncollectedProducts.reservedInvoiceId, invoiceId)
      )
    )
    .all()
  // Validate every buyer before clearing any sale ownership.
  for (const product of held) {
    if (product.soldOrderId && db.get(sql`SELECT id FROM orders WHERE id = ${product.soldOrderId}
      AND (status = 'completed' OR completed_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM deliveries WHERE order_id = orders.id AND status = 'recorded'))`))
      throw new AppError('CONFLICT', 'لا يمكن تحرير منتج وصل إلى العميل')
  }
  for (const product of held) {
    if (product.status === 'resumed') throw new AppError('CONFLICT', 'لا يمكن تحرير منتج مستأنف إلى البيع')
    db.update(uncollectedProducts)
      .set({
        status: 'available',
        reservedInvoiceId: null,
        soldInvoiceId: null,
        soldOrderId: null,
        soldAt: null,
        soldPriceMinor: null
      })
      .where(eq(uncollectedProducts.id, product.id))
      .run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'uncollectedProducts.released',
      entity: 'uncollected_products',
      entityId: String(product.id),
      details: { invoiceId, previousStatus: product.status }
    })
  }
}


/**
 * THE authoritative invoice → order transition (workflow pass).
 *
 * Called only from `approveFinalInvoice`, inside its transaction. Every
 * line — including its component snapshot, colour code and agreed price
 * — is COPIED, so the order is self-contained and immune to later
 * master-data edits (BR-8/BR-46/BR-70).
 *
 * It then seeds the order's OWN production configuration from the
 * product defaults (Part 9). From that moment the order owns its plan:
 * editing a product master later can never rewrite it.
 *
 * Creating an order posts nothing — no inventory movement, no worker
 * commission, no cash — and issues no manufacturing order. Production
 * is a separate, explicit decision taken on the order itself (Part 6).
 */
function createOrderFromApprovedInvoice(
  input: {
    /** Reapproval reuses the existing commercial conversion, never a new order. */
    existingOrderId?: number
    invoice: {
      id: number
      documentNumber: string
      totalMinor: number
      subtotalMinor: number
      discountMinor: number
      depositPercentBp: number
      depositRequiredMinor: number
      requiresInstallation: boolean
      requiresDelivery: boolean
      /** Commercial values agreed on the invoice, carried for history.
       *  They create no stock, cash, purchase or production effect. */
      meterPriceMinor: number
      installationPriceMinor: number
      deliveryPriceMinor: number
      address: string | null
      termsSnapshot: string | null
      notes: string | null
    }
    lines: Array<
      Partial<ItemSelections> & {
        lineKind: string
        productId: number | null
        materialId: number | null
        description: string
        specifications: string | null
        dimensions: string | null
        materialType: string | null
        colorCode: string | null
        accessories: string | null
        accessoryMaterialId: number | null
        materialTypeMaterialId: number | null
        quantityMicro: number
        unitPriceMinor: number
        lineTotalMinor: number
        bomSnapshot: string | null
        /** Set when this line sells an ALREADY-BUILT product from
         *  "المنتجات غير المستلمة" — carried onto the order line so the
         *  order itself records that nothing here is to be manufactured. */
        uncollectedProductId?: number | null
        notes: string | null
      }
    >
    customerId: number
  },
  ctx: ServiceContext
): { id: number; documentNumber: string } {
  if (!getRawConnection().inTransaction) throw new AppError('CONFLICT', 'إنشاء طلب العميل يتطلب معاملة اعتماد الفاتورة')
  const db = getDatabase()
  requireActiveCustomer(input.customerId)
  const { invoice } = input
  const existing = input.existingOrderId ? getOrderOrThrow(input.existingOrderId) : undefined
  if (
    existing &&
    (existing.status !== 'awaiting_approval' ||
      existing.finalInvoiceId !== invoice.id ||
      existing.customerId !== input.customerId)
  ) {
    throw new AppError('CONFLICT', 'رابط إعادة اعتماد الفاتورة وطلب العميل غير صالح')
  }
  const documentNumber = existing?.documentNumber ?? nextDocumentNumber('SO')
  const commercial = {
    subtotalMinor: invoice.subtotalMinor,
    discountMinor: invoice.discountMinor,
    totalMinor: invoice.totalMinor,
    depositPercentBp: invoice.depositPercentBp,
    depositRequiredMinor: invoice.depositRequiredMinor,
    requiresInstallation: invoice.requiresInstallation,
    requiresDelivery: invoice.requiresDelivery,
    meterPriceMinor: invoice.meterPriceMinor,
    installationPriceMinor: invoice.installationPriceMinor,
    deliveryPriceMinor: invoice.deliveryPriceMinor,
    address: invoice.address,
    termsSnapshot: invoice.termsSnapshot,
    notes: invoice.notes
  }

  const orderId =
    existing?.id ??
    Number(
      db
        .insert(orders)
        .values({
          documentNumber,
          finalInvoiceId: invoice.id,
          customerId: input.customerId,
          status: 'confirmed',
          ...commercial,
          paidMinor: 0,
          remainingMinor: invoice.totalMinor,
          paymentStatus: 'unpaid',
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
  if (existing) {
    const paidMinor =
      db.get<{ paid: number }>(sql`
      SELECT
        COALESCE((SELECT SUM(amount_minor) FROM customer_payments WHERE order_id = ${orderId}), 0)
        - COALESCE((SELECT SUM(amount_minor) FROM customer_payment_refunds WHERE order_id = ${orderId}), 0)
        AS paid
    `)?.paid ?? 0
    db.update(orders)
      .set({
        ...commercial,
        status: 'confirmed',
        completedAt: null,
        paidMinor,
        remainingMinor: invoice.totalMinor - paidMinor,
        paymentStatus: paymentStatusFor(invoice.totalMinor, paidMinor, invoice.depositRequiredMinor)
      })
      .where(eq(orders.id, orderId))
      .run()
    // Historical assignments retain their exact line IDs. Only current lines feed the order.
    db.update(orderLines)
      .set({ supersededAt: nowIso() })
      .where(and(eq(orderLines.orderId, orderId), sql`${orderLines.supersededAt} IS NULL`))
      .run()
  }

  const selectionSets = input.lines.map((line) =>
    line.selectedMaterials && line.selectedColors && line.selectedAccessories
      ? {
          selectedMaterials: line.selectedMaterials,
          selectedColors: line.selectedColors,
          selectedAccessories: line.selectedAccessories
        }
      : undefined
  )
  const fallback = selectionSets.some((s) => !s) ? prepareItemSelections(input.lines) : []
  for (const [index, line] of input.lines.entries()) {
    const orderLineId = Number(
      db
        .insert(orderLines)
        .values({
          orderId,
          lineKind: line.lineKind,
          productId: line.productId,
          materialId: line.materialId,
          description: line.description,
          specifications: line.specifications,
          dimensions: line.dimensions,
          materialType: line.materialType,
          materialTypeMaterialId: line.materialTypeMaterialId,
          colorCode: line.colorCode,
          accessories: line.accessories,
          // Approval carries the accessory link across unchanged: the
          // order line keeps both the frozen snapshot and the reference.
          accessoryMaterialId: line.accessoryMaterialId,
          quantityMicro: line.quantityMicro,
          unitPriceMinor: line.unitPriceMinor,
          lineTotalMinor: line.lineTotalMinor,
          bomSnapshot: line.bomSnapshot,
          uncollectedProductId: line.uncollectedProductId ?? null,
          notes: line.notes
        })
        .run().lastInsertRowid
    )
    insertItemSelections('order', orderLineId, selectionSets[index] ?? fallback[index]!)
  }

  // Part 9: the product master is a TEMPLATE; the order takes its own
  // snapshot of it here and owns it from now on.
  if (!existing) seedOrderProductionConfig(orderId)

  recordAuditEvent({
    userId: ctx.session.user.id,
    action: existing ? 'orders.commercial.resynchronize' : 'orders.create',
    entity: 'orders',
    entityId: String(orderId),
    details: { documentNumber, approvedInvoice: invoice.documentNumber, finalInvoiceId: invoice.id }
  })
  return { id: orderId, documentNumber }
}


/** Private first-approval template snapshot; existing-order resynchronization retains its own plan. */
function seedOrderProductionConfig(orderId: number): void {
  const db = getDatabase()
  const lines = db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).all()
    .filter(isManufacturableOrderLine)

  let sortOrder = 0
  for (const line of lines) {
    const multiplier = line.quantityMicro

    // ---- materials ----
    const bomLines = line.bomSnapshot
      ? ((JSON.parse(line.bomSnapshot) as {
          lines: Array<{ materialId: number; materialName: string; qtyMicro: number; unit: string; dimensions?: string | null }>
        }).lines ?? [])
      : []
    for (const bomLine of bomLines) {
      const material = bomLine.materialId
        ? db.select().from(materials).where(eq(materials.id, bomLine.materialId)).get()
        : undefined
      const qtyMicro = multiplyDivideRounded(bomLine.qtyMicro, multiplier, 1_000_000)
      const unitCost = material?.currentMarketPriceMicro ?? 0
      db.insert(plannedMaterials)
        .values({
          orderId,
          materialId: bomLine.materialId ?? null,
          materialName: bomLine.materialName,
          qtyMicro,
          unit: bomLine.unit ?? material?.unit ?? null,
          dimensions: bomLine.dimensions ?? null,
          thickness: material?.thickness ?? null,
          colorCode: line.colorCode,
          estimatedUnitCostMicro: unitCost,
          estimatedTotalMinor: costOf(qtyMicro, unitCostMicro(unitCost)),
          sortOrder: sortOrder++,
          createdAt: nowIso()
        })
        .run()
    }

    if (!line.productId) continue

    // ---- machines (never inventory) ----
    const machineRows = db
      .select({
        machineId: machines.id,
        machineName: machines.name,
        costingUnit: machines.costingUnit,
        usageQtyMicro: productMachineLines.usageQtyMicro,
        rateMicro: productMachineLines.rateMicro,
        defaultRateMicro: machines.defaultRateMicro,
        notes: productMachineLines.notes
      })
      .from(productMachineLines)
      .innerJoin(machines, eq(machines.id, productMachineLines.machineId))
      .where(eq(productMachineLines.productId, line.productId))
      .all()
    for (const row of machineRows) {
      const usageQtyMicro = multiplyDivideRounded(row.usageQtyMicro, multiplier, 1_000_000)
      const rateMicro = row.rateMicro ?? row.defaultRateMicro
      db.insert(plannedMachines)
        .values({
          orderId,
          machineId: row.machineId,
          machineName: row.machineName,
          usageQtyMicro,
          usageUnit: row.costingUnit,
          rateMicro,
          estimatedCostMinor: costOf(usageQtyMicro, unitCostMicro(rateMicro)),
          notes: row.notes,
          createdAt: nowIso()
        })
        .run()
    }

    // ---- worker commission (never a material, never yet payable) ----
    const commissionRows = db
      .select({
        workerId: productCommissionLines.workerId,
        workerName: workers.name,
        amountMinor: productCommissionLines.amountMinor,
        notes: productCommissionLines.notes
      })
      .from(productCommissionLines)
      .leftJoin(workers, eq(workers.id, productCommissionLines.workerId))
      .where(eq(productCommissionLines.productId, line.productId))
      .all()
    for (const row of commissionRows) {
      db.insert(plannedWorkers)
        .values({
          orderId,
          workerId: row.workerId,
          workerName: row.workerName ?? 'عمولة تصنيع قياسية',
          commissionMode: 'estimated',
          estimatedCostMinor: multiplyDivideRounded(row.amountMinor, multiplier, 1_000_000),
          notes: row.notes,
          createdAt: nowIso()
        })
        .run()
    }
  }

  recomputeOrderEstimate(orderId)
}
