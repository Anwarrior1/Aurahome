import { desc, eq, and, sql, type SQL } from 'drizzle-orm'
import { keysetBoundary, keysetOrder, keysetPage, normalizedSearch, type KeysetWindow, type PageRequest } from '../base/pagination'
import { getDatabase, getRawConnection } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import {
  customers,
  purchases,
  purchaseLines,
  supplierPayments,
  suppliers
} from '../../db/schema/parties.schema'
import { orders } from '../../db/schema/sales.schema'
import { materials } from '../../db/schema/catalog.schema'
import { cashAccounts, cashTransactions } from '../../db/schema/finance.schema'
import { fifoLayers, inventoryMovements } from '../../db/schema/inventory.schema'
import { receiveStock } from '../inventory/inventory.service'
import { unitCostMicro, costOf, deriveUnitCost, multiplyDivideRounded } from '@shared/money/cost'
import { money } from '@shared/money/money'
import { AppError, notFound } from '../../utils/errors'
import { nextDocumentNumber } from '../numbering.service'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { dayStart, nowIso, today, type ServiceContext } from '../base/service.types'
import {
  postCashMovement,
  adjustCashMovementForRef,
  removeCashMovementForRef
} from '../finance/cash.service'
import { hasPermission, requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { runOptionalIdempotentFinancialCommand } from '../finance/idempotency.service'
import { requireSafeNonNegativeInteger, requireSafePositiveInteger } from '../../utils/numeric'

export interface PurchaseLineInput {
  materialId: number
  /**
   * Item 7/16 — give EITHER:
   *  • `qtyMicro`: the quantity already in the material's base stock
   *    unit (unchanged behaviour, and the only option when the
   *    material has no purchase-unit conversion configured), OR
   *  • `purchaseQtyMicro`: the quantity in the material's configured
   *    PURCHASE unit (e.g. 2 "علبة") — the server converts it to base
   *    stock units using the material's own purchaseUnitFactorMicro,
   *    and refuses if no conversion is configured for that material.
   * Supplying both is rejected — one line has one true quantity.
   */
  qtyMicro?: number
  purchaseQtyMicro?: number
  /** A unit cost already in BASE stock-unit terms (LYD×1e6). */
  unitCostMicro?: number
  /** A unit cost in PURCHASE-unit terms — converted down to the base
   *  unit via the same factor, so the FIFO layer never records the
   *  purchase-unit price by mistake (item 16's worked example). */
  purchaseUnitCostMicro?: number
  /** Either a unit cost (one of the two above) or the line total; the
   *  remaining piece is always derived, never both required. */
  lineTotalMinor?: number
  batchCode?: string | null
}

function assertCustomerOrderExists(customerOrderId: number | null | undefined, newLink = false): void {
  if (customerOrderId == null) return
  const order = getDatabase()
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(eq(orders.id, customerOrderId))
    .get()
  if (!order) {
    throw notFound('الطلب المرتبط غير موجود')
  }
  if (newLink && order.status === 'awaiting_approval') {
    throw new AppError('CONFLICT', 'الطلب بانتظار إعادة اعتماد الفاتورة؛ أعد اعتماد الفاتورة قبل أي عملية عليه')
  }
}

/**
 * Item 7/16 — resolves one purchase line to a BASE-stock-unit quantity
 * and unit cost, converting from the material's purchase unit when the
 * line was entered that way.
 *
 * The conversion is deliberately narrow: it only ever turns a
 * purchase-unit quantity/cost into the equivalent base-unit
 * quantity/cost BEFORE anything reaches FIFO — from that point on,
 * every downstream table (purchase_lines, fifo_layers,
 * inventory_movements) holds exactly the same shape it always has, in
 * the material's base unit. FIFO itself never learns a purchase unit
 * exists.
 */
function resolvePurchaseLine(
  line: PurchaseLineInput
): PurchaseLineInput & {
  qtyMicro: number
  unit: ReturnType<typeof unitCostMicro>
  lineTotal: number
} {
  if (line.qtyMicro !== undefined && line.purchaseQtyMicro !== undefined) {
    throw new AppError(
      'VALIDATION_ERROR',
      'حدد الكمية بوحدة المخزون أو بوحدة الشراء، وليس كلاهما معاً'
    )
  }

  let qtyMicro: number
  let lineTotalMinor = line.lineTotalMinor
  let unitCostMicroValue = line.unitCostMicro
  if (line.unitCostMicro !== undefined) requireSafeNonNegativeInteger(line.unitCostMicro, 'تكلفة الوحدة')
  if (line.purchaseUnitCostMicro !== undefined) requireSafeNonNegativeInteger(line.purchaseUnitCostMicro, 'تكلفة وحدة الشراء')
  if (lineTotalMinor !== undefined) requireSafeNonNegativeInteger(lineTotalMinor, 'إجمالي البند')

  if (line.purchaseQtyMicro !== undefined) {
    requireSafePositiveInteger(line.purchaseQtyMicro, 'الكمية')
    const material = getDatabase()
      .select()
      .from(materials)
      .where(eq(materials.id, line.materialId))
      .get()
    if (!material) throw notFound('المادة غير موجودة')
    if (!material.purchaseUnit || !material.purchaseUnitFactorMicro) {
      throw new AppError(
        'VALIDATION_ERROR',
        `المادة "${material.name}" ليس لها وحدة شراء محددة — استخدم وحدة المخزون مباشرة`
      )
    }
    // e.g. 2 "علبة" (2_000_000) × 50 قطعة/علبة (50_000_000) ÷ 1e6 = 100 قطعة.
    qtyMicro = multiplyDivideRounded(line.purchaseQtyMicro, material.purchaseUnitFactorMicro, 1_000_000)

    // A purchase-unit cost is a total for that many purchase units,
    // converted straight to a line total — never per-base-unit yet.
    if (line.purchaseUnitCostMicro !== undefined) {
      lineTotalMinor = costOf(line.purchaseQtyMicro, unitCostMicro(line.purchaseUnitCostMicro))
      unitCostMicroValue = undefined // always derive the base-unit cost from the total below
    }
  } else {
    if (line.qtyMicro === undefined) {
      throw new AppError('VALIDATION_ERROR', 'الكمية يجب أن تكون أكبر من صفر')
    }
    requireSafePositiveInteger(line.qtyMicro, 'الكمية')
    qtyMicro = line.qtyMicro
  }

  const unit =
    unitCostMicroValue !== undefined
      ? unitCostMicro(unitCostMicroValue)
      : deriveUnitCost(money(lineTotalMinor ?? 0), qtyMicro)
  const lineTotal = lineTotalMinor ?? costOf(qtyMicro, unit)
  requireSafeNonNegativeInteger(unit, 'تكلفة الوحدة')
  requireSafeNonNegativeInteger(lineTotal, 'إجمالي البند')

  return { ...line, qtyMicro, unit, lineTotal }
}

type ResolvedPurchaseLine = ReturnType<typeof resolvePurchaseLine>

function insertPurchaseLines(
  purchaseId: number,
  purchaseDate: string,
  resolved: ResolvedPurchaseLine[],
  ctx: ServiceContext
): void {
  for (const line of resolved) {
    const lineId = Number(
      getDatabase()
        .insert(purchaseLines)
        .values({
          purchaseId,
          materialId: line.materialId,
          qtyMicro: line.qtyMicro,
          unitCostMicro: line.unit,
          lineTotalMinor: line.lineTotal,
          batchCode: line.batchCode ?? null
        })
        .run().lastInsertRowid
    )
    receiveStock({
      materialId: line.materialId,
      qtyMicro: line.qtyMicro,
      unitCost: line.unit,
      sourceKind: 'purchase',
      sourceRefId: lineId,
      batchCode: line.batchCode ?? null,
      receivedAt: dayStart(purchaseDate),
      ctx
    })
  }
}

/**
 * BR-22: a purchase raises physical stock and creates the FIFO cost
 * layers that will later price consumption. Historical purchase cost
 * is preserved forever and is never touched by a market-price change
 * (BR-7/BR-8). BR-52: there is no purchase-return path anywhere.
 */
export function createPurchase(
  input: {
    supplierId: number
    customerOrderId?: number | null
    purchaseDate?: string
    notes?: string
    lines: PurchaseLineInput[]
    paidNowMinor?: number
    cashAccountId?: number
    requestKey?: string
  },
  ctx: ServiceContext
): { id: number; documentNumber: string; totalMinor: number } {
  requirePermission(ctx.session, P.purchases.manage)
  if (!input.lines.length) throw new AppError('VALIDATION_ERROR', 'يجب إضافة صنف واحد على الأقل')
  if (input.paidNowMinor !== undefined) {
    requireSafeNonNegativeInteger(input.paidNowMinor, 'المبلغ المدفوع')
  }
  if (!getDatabase().select().from(suppliers).where(eq(suppliers.id, input.supplierId)).get()) {
    throw notFound('المورد غير موجود')
  }
  assertCustomerOrderExists(input.customerOrderId, true)
  if (input.customerOrderId != null) requirePermission(ctx.session, P.orders.view)

  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'purchases.create',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        const purchaseDate = input.purchaseDate ?? today()
        const documentNumber = nextDocumentNumber('PO')

        const resolved = input.lines.map((line) => resolvePurchaseLine(line))

        const totalMinor = resolved.reduce((sum, line) => money(sum + line.lineTotal), money(0))

        const purchaseId = Number(
          getDatabase()
            .insert(purchases)
            .values({
              documentNumber,
              supplierId: input.supplierId,
              customerOrderId: input.customerOrderId ?? null,
              purchaseDate,
              totalMinor,
              paidMinor: 0,
              notes: input.notes ?? null,
              createdBy: ctx.session.user.id,
              createdAt: nowIso()
            })
            .run().lastInsertRowid
        )

        insertPurchaseLines(purchaseId, purchaseDate, resolved, ctx)

        if (input.paidNowMinor && input.paidNowMinor > 0) {
          paySupplier(
            {
              supplierId: input.supplierId,
              purchaseId,
              amountMinor: input.paidNowMinor,
              cashAccountId: input.cashAccountId
            },
            ctx
          )
        }

        recordAuditEvent({
          userId: ctx.session.user.id,
          action: 'purchases.create',
          entity: 'purchases',
          entityId: String(purchaseId),
          details: {
            documentNumber,
            customerOrderId: input.customerOrderId ?? null,
            totalMinor,
            lines: resolved.length
          }
        })

        return { id: purchaseId, documentNumber, totalMinor }
      })
  })
}

export function paySupplier(
  input: {
    supplierId: number
    purchaseId?: number
    amountMinor: number
    cashAccountId?: number
    paidAt?: string
    notes?: string
    requestKey?: string
  },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.purchases.paySupplier)
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')

  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'purchases.paySupplier',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        const supplier = getDatabase()
          .select()
          .from(suppliers)
          .where(eq(suppliers.id, input.supplierId))
          .get()
        if (!supplier) throw notFound('المورد غير موجود')
        if (input.purchaseId) {
          const purchase = getDatabase()
            .select()
            .from(purchases)
            .where(eq(purchases.id, input.purchaseId))
            .get()
          if (!purchase) throw notFound('فاتورة الشراء غير موجودة')
          if (purchase.supplierId !== input.supplierId) {
            throw new AppError('VALIDATION_ERROR', 'فاتورة الشراء لا تخص المورد المحدد')
          }
        }
        const paidAt = input.paidAt ?? today()
        assertSupplierPaymentDate(paidAt)
        const paymentId = Number(
          getDatabase()
            .insert(supplierPayments)
            .values({
              supplierId: input.supplierId,
              purchaseId: input.purchaseId ?? null,
              amountMinor: input.amountMinor,
              cashAccountId: input.cashAccountId ?? null,
              paidAt,
              notes: input.notes ?? null,
              createdBy: ctx.session.user.id,
              createdAt: nowIso()
            })
            .run().lastInsertRowid
        )

        if (input.purchaseId) {
          getDatabase().run(
            sql`UPDATE purchases SET paid_minor = paid_minor + ${input.amountMinor} WHERE id = ${input.purchaseId}`
          )
        }

        postCashMovement({
          accountId: input.cashAccountId,
          direction: 'out',
          amountMinor: input.amountMinor,
          kind: 'supplier_payment',
          refTable: 'supplier_payments',
          refId: paymentId,
          occurredAt: paidAt,
          ctx
        })

        recordAuditEvent({
          userId: ctx.session.user.id,
          action: 'purchases.pay',
          entity: 'supplier_payments',
          entityId: String(paymentId),
          details: input
        })
        return paymentId
      })
  })
}

function purchaseRows(where: SQL | undefined, window?: KeysetWindow) {
  const query = getDatabase()
    .select({
      id: purchases.id,
      documentNumber: purchases.documentNumber,
      supplierId: purchases.supplierId,
      supplierName: suppliers.name,
      customerOrderId: purchases.customerOrderId,
      customerOrderNumber: orders.documentNumber,
      customerName: customers.name,
      purchaseDate: purchases.purchaseDate,
      totalMinor: purchases.totalMinor,
      paidMinor: purchases.paidMinor,
      notes: purchases.notes
    })
    .from(purchases)
    .innerJoin(suppliers, eq(purchases.supplierId, suppliers.id))
    .leftJoin(orders, eq(purchases.customerOrderId, orders.id))
    .leftJoin(customers, eq(orders.customerId, customers.id))
  const rows = window
    ? query
        .where(and(where, keysetBoundary([sql`${purchases.id}`], window)))
        .orderBy(keysetOrder([sql`${purchases.id}`], window))
        .limit(window.take)
        .all()
    : query.where(where).orderBy(desc(purchases.id)).all()
  return rows.map((row) => ({
    ...row,
    paymentStatus:
      row.paidMinor >= row.totalMinor ? 'paid' : row.paidMinor > 0 ? 'partial' : 'unpaid'
  }))
}

export function listPurchases(
  filter: {
    supplierId?: number
    customerOrderId?: number
    unassignedOnly?: boolean
    from?: string
    to?: string
    search?: string
  } = {},
  request: PageRequest = {}
) {
  const normalized = {
    supplierId: filter.supplierId,
    customerOrderId: filter.customerOrderId,
    unassignedOnly: filter.unassignedOnly || undefined,
    from: filter.from,
    to: filter.to,
    search: normalizedSearch(filter.search)
  }
  const clauses: SQL[] = []
  if (normalized.supplierId) clauses.push(eq(purchases.supplierId, normalized.supplierId))
  if (normalized.customerOrderId) clauses.push(eq(purchases.customerOrderId, normalized.customerOrderId))
  if (normalized.unassignedOnly) clauses.push(sql`${purchases.customerOrderId} IS NULL`)
  if (normalized.from) clauses.push(sql`${purchases.purchaseDate} >= ${normalized.from}`)
  if (normalized.to) clauses.push(sql`${purchases.purchaseDate} <= ${normalized.to}`)
  if (normalized.search) clauses.push(sql`${purchases.documentNumber} LIKE ${'%' + normalized.search + '%'}`)
  const where = clauses.length ? and(...clauses) : undefined
  return keysetPage({
    scope: 'purchases.list',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => purchaseRows(where, window),
    summary: () => undefined
  })
}

/** Read-only job attribution. This does not participate in production
 * planning or actual FIFO-based profitability. Scoped to one order. */
export function purchasesForOrder(orderId: number) {
  assertCustomerOrderExists(orderId)
  const linkedPurchases = purchaseRows(eq(purchases.customerOrderId, orderId))
  return {
    orderId,
    purchases: linkedPurchases,
    totalMinor: linkedPurchases.reduce((sum, purchase) => sum + purchase.totalMinor, 0)
  }
}

export function getPurchase(id: number) {
  const purchase = getDatabase().select().from(purchases).where(eq(purchases.id, id)).get()
  if (!purchase) throw notFound('فاتورة الشراء غير موجودة')
  const supplier = getDatabase()
    .select({ name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.id, purchase.supplierId))
    .get()
  const linkedOrder = purchase.customerOrderId
    ? getDatabase()
        .select({ documentNumber: orders.documentNumber, customerName: customers.name })
        .from(orders)
        .innerJoin(customers, eq(orders.customerId, customers.id))
        .where(eq(orders.id, purchase.customerOrderId))
        .get()
    : undefined
  const lines = getDatabase()
    .select()
    .from(purchaseLines)
    .where(eq(purchaseLines.purchaseId, id))
    .all()
  // Same shape orders.getOrder() already exposes its payments in — so
  // the Edit Purchase Invoice screen can show/preselect the account
  // that actually paid for it, without a second, parallel query.
  const payments = getDatabase()
    .select()
    .from(supplierPayments)
    .where(eq(supplierPayments.purchaseId, id))
    .orderBy(desc(supplierPayments.id))
    .all()
  return {
    purchase: {
      ...purchase,
      supplierName: supplier?.name ?? '',
      customerOrderNumber: linkedOrder?.documentNumber ?? null,
      customerName: linkedOrder?.customerName ?? null,
      paymentStatus:
        purchase.paidMinor >= purchase.totalMinor
          ? 'paid'
          : purchase.paidMinor > 0
            ? 'partial'
            : 'unpaid'
    },
    lines,
    payments
  }
}

interface PurchaseArtifact {
  lineId: number
  layerId: number
  movementId: number
}

/** Backend-only safety decision for correcting or deleting a receipt. */
function unusedPurchaseArtifacts(purchaseId: number): PurchaseArtifact[] {
  const db = getDatabase()
  const lines = db
    .select()
    .from(purchaseLines)
    .where(eq(purchaseLines.purchaseId, purchaseId))
    .all()
  const artifacts: PurchaseArtifact[] = []

  for (const line of lines) {
    const linkedLayers = db
      .select()
      .from(fifoLayers)
      .where(and(eq(fifoLayers.sourceKind, 'purchase'), eq(fifoLayers.sourceRefId, line.id)))
      .all()
    if (linkedLayers.length !== 1) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن تصحيح فاتورة الشراء لأن ربط إيصال المخزون التاريخي غير مكتمل'
      )
    }
    const layer = linkedLayers[0]!
    if (layer.qtyRemainingMicro !== layer.qtyReceivedMicro) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن تعديل أو حذف هذه الفاتورة لأن جزءاً من مخزونها استُخدم بالفعل. يجب الحفاظ على تكلفة الشراء التاريخية'
      )
    }
    const allocationCount =
      db.get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM fifo_allocations WHERE layer_id = ${layer.id}`
      )?.c ?? 0
    if (allocationCount > 0) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن تعديل أو حذف هذه الفاتورة لوجود توزيعات تكلفة تاريخية مرتبطة بها'
      )
    }

    let movements = db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.kind, 'purchase'),
          eq(inventoryMovements.sourceKind, 'purchase'),
          eq(inventoryMovements.sourceRefId, line.id)
        )
      )
      .all()
    // Pre-0004 rows had no explicit source link. Match only when the
    // historical receipt is completely unambiguous; otherwise block.
    if (!movements.length) {
      movements = db
        .select()
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.kind, 'purchase'),
            eq(inventoryMovements.materialId, line.materialId),
            eq(inventoryMovements.qtyMicro, line.qtyMicro),
            eq(inventoryMovements.actualCostMinor, line.lineTotalMinor),
            eq(inventoryMovements.createdAt, layer.receivedAt),
            sql`${inventoryMovements.sourceKind} IS NULL`
          )
        )
        .all()
    }
    if (movements.length !== 1) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن تصحيح فاتورة الشراء القديمة تلقائياً لأن حركة الاستلام غير قابلة للتحديد بشكل آمن'
      )
    }
    const movement = movements[0]!
    const reversalCount =
      db.get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM inventory_movements WHERE reversal_of_movement_id = ${movement.id}`
      )?.c ?? 0
    if (reversalCount > 0) {
      throw new AppError('CONFLICT', 'لا يمكن تعديل أو حذف فاتورة مرتبطة بحركة عكس سابقة')
    }
    artifacts.push({ lineId: line.id, layerId: layer.id, movementId: movement.id })
  }
  return artifacts
}

/**
 * Non-throwing twin of `unusedPurchaseArtifacts`, for the full-delete
 * preview: the same per-line safety checks, but every failure becomes
 * a blocker message instead of aborting, so the whole invoice can be
 * inspected in one pass. A line that fails is simply left out of
 * `artifacts` — it is never force-included.
 */
function purchaseArtifactsPreview(purchaseId: number): {
  artifacts: PurchaseArtifact[]
  blockers: string[]
} {
  const db = getDatabase()
  const lines = db
    .select()
    .from(purchaseLines)
    .where(eq(purchaseLines.purchaseId, purchaseId))
    .all()
  const artifacts: PurchaseArtifact[] = []
  const blockers: string[] = []

  for (const line of lines) {
    const linkedLayers = db
      .select()
      .from(fifoLayers)
      .where(and(eq(fifoLayers.sourceKind, 'purchase'), eq(fifoLayers.sourceRefId, line.id)))
      .all()
    if (linkedLayers.length !== 1) {
      blockers.push(`ربط إيصال المخزون التاريخي لصنف #${line.id} غير مكتمل`)
      continue
    }
    const layer = linkedLayers[0]!
    if (layer.qtyRemainingMicro !== layer.qtyReceivedMicro) {
      blockers.push(
        'جزء من مخزون هذه الفاتورة استُخدم بالفعل — يجب الحفاظ على تكلفة الشراء التاريخية لتلك الحركة'
      )
      continue
    }
    const allocationCount =
      db.get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM fifo_allocations WHERE layer_id = ${layer.id}`
      )?.c ?? 0
    if (allocationCount > 0) {
      blockers.push('توجد توزيعات تكلفة تاريخية مرتبطة بمخزون هذه الفاتورة')
      continue
    }

    let movements = db
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.kind, 'purchase'),
          eq(inventoryMovements.sourceKind, 'purchase'),
          eq(inventoryMovements.sourceRefId, line.id)
        )
      )
      .all()
    if (!movements.length) {
      movements = db
        .select()
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.kind, 'purchase'),
            eq(inventoryMovements.materialId, line.materialId),
            eq(inventoryMovements.qtyMicro, line.qtyMicro),
            eq(inventoryMovements.actualCostMinor, line.lineTotalMinor),
            eq(inventoryMovements.createdAt, layer.receivedAt),
            sql`${inventoryMovements.sourceKind} IS NULL`
          )
        )
        .all()
    }
    if (movements.length !== 1) {
      blockers.push(`حركة استلام المخزون لصنف #${line.id} غير قابلة للتحديد بشكل آمن`)
      continue
    }
    const movement = movements[0]!
    const reversalCount =
      db.get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM inventory_movements WHERE reversal_of_movement_id = ${movement.id}`
      )?.c ?? 0
    if (reversalCount > 0) {
      blockers.push('توجد حركة عكس سابقة مرتبطة بمخزون هذه الفاتورة')
      continue
    }
    artifacts.push({ lineId: line.id, layerId: layer.id, movementId: movement.id })
  }
  return { artifacts, blockers: [...new Set(blockers)] }
}

export interface PurchaseFullDeletePreview {
  purchaseId: number
  documentNumber: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}

const POSTED_PURCHASE_HISTORY_BLOCKER =
  'فاتورة الشراء سجل تجاري ومخزني مُرحّل؛ لا يمكن حذفها أو حذف إيصالاتها ودفعاتها التاريخية. استخدم مسار التصحيح أو العكس عند توفره'

function scalarCount(statement: string, ...params: unknown[]): number {
  const row = getRawConnection()
    .prepare(statement)
    .get(...params) as { c: number } | undefined
  return Number(row?.c ?? 0)
}

/**
 * Discovers everything caused BY this purchase invoice — its own
 * payments, the cash effect those payments posted, and the inventory
 * receipts it created — without mutating anything. Never counts a
 * payment/movement merely because it shares the same supplier or
 * material; every row here is tied to this exact purchase.
 */
export function purchaseFullDeletePreview(id: number): PurchaseFullDeletePreview {
  const { purchase } = getPurchase(id)
  const { artifacts, blockers } = purchaseArtifactsPreview(id)
  const postedLineCount = scalarCount(
    'SELECT COUNT(*) AS c FROM purchase_lines WHERE purchase_id = ?',
    id
  )
  const paymentCount = scalarCount(
    'SELECT COUNT(*) AS c FROM supplier_payments WHERE purchase_id = ?',
    id
  )
  const cashCount = scalarCount(
    `SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'supplier_payments' AND ref_id IN (SELECT id FROM supplier_payments WHERE purchase_id = ?)`,
    id
  )
  const dependencies: Array<{ key: string; label: string; count: number }> = []
  if (paymentCount > 0)
    dependencies.push({ key: 'payments', label: 'دفعات المورد', count: paymentCount })
  if (cashCount > 0)
    dependencies.push({ key: 'cashTransactions', label: 'الحركات المالية', count: cashCount })
  if (artifacts.length > 0)
    dependencies.push({
      key: 'inventoryMovements',
      label: 'حركات المخزون',
      count: artifacts.length
    })

  // Purchases have no draft state: their lines post receipt movements and
  // FIFO cost layers immediately. Parent deletion must never erase them.
  if (postedLineCount > 0 || paymentCount > 0 || artifacts.length > 0) {
    blockers.unshift(POSTED_PURCHASE_HISTORY_BLOCKER)
  }

  return {
    purchaseId: id,
    documentNumber: purchase.documentNumber,
    dependencies,
    blockers: [...new Set(blockers)]
  }
}

/**
 * The cascade implementation shared by the public full-delete and by the
 * material and supplier full-delete paths that remove a purchase as part
 * of a larger operation. It has no confirmation token of its own, so it
 * must only be called from a path that already has one.
 *
 * Every caller receives the preview's blockers verbatim — creating a
 * purchase posts inventory and FIFO immediately, so a purchase with
 * posted history is never deletable through here.
 */
export function performFullDeletePurchase(
  id: number,
  ctx: ServiceContext,
  cascadedFrom?: string
): { removed: true; summary: Record<string, number> } {
  // Existing material/supplier cleanup owners compose this same unused-purchase writer.
  if (!hasPermission(ctx.session, P.materials.fullDelete) && !hasPermission(ctx.session, P.suppliers.fullDelete)) {
    requirePermission(ctx.session, P.purchases.fullDelete)
  }
  return withTransaction(() => {
    const { purchase } = getPurchase(id)
    const preview = purchaseFullDeletePreview(id)
    const blockers = preview.blockers
    if (blockers.length) {
      throw new AppError(
        'CONFLICT',
        `تعذر حذف فاتورة الشراء بالكامل لحماية سجل التكلفة: ${blockers.join('، ')}`
      )
    }
    const raw = getRawConnection()
    const summary = Object.fromEntries(
      preview.dependencies.map((item) => [item.key, item.count])
    ) as Record<string, number>

    raw
      .prepare(
        `DELETE FROM cash_transactions WHERE ref_table = 'supplier_payments' AND ref_id IN (SELECT id FROM supplier_payments WHERE purchase_id = ?)`
      )
      .run(id)
    raw.prepare('DELETE FROM supplier_payments WHERE purchase_id = ?').run(id)

    // Recomputed rather than reusing the preview's artifacts, so a
    // change between preview and execution is caught rather than acted
    // on blindly — matches performFullDeleteOrder's own re-check.
    const artifacts = unusedPurchaseArtifacts(id)
    for (const artifact of artifacts) {
      raw.prepare('DELETE FROM inventory_movements WHERE id = ?').run(artifact.movementId)
      raw.prepare('DELETE FROM fifo_layers WHERE id = ?').run(artifact.layerId)
    }
    raw.prepare('DELETE FROM purchase_lines WHERE purchase_id = ?').run(id)
    raw.prepare('DELETE FROM purchases WHERE id = ?').run(id)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'purchases.full_delete',
      entity: 'purchases',
      entityId: String(id),
      details: {
        fullDelete: true,
        description: cascadedFrom
          ? `Full Purchase Invoice deletion (${purchase.documentNumber}) cascaded from ${cascadedFrom}`
          : `Full Purchase Invoice deletion (${purchase.documentNumber})`,
        documentNumber: purchase.documentNumber,
        cascadedFrom: cascadedFrom ?? null,
        summary
      }
    })
    return { removed: true, summary }
  })
}

export function fullDeletePurchase(
  input: { id: number; confirmation: string },
  ctx: ServiceContext
): { removed: true; summary: Record<string, number> } {
  requirePermission(ctx.session, P.purchases.fullDelete)
  const { purchase } = getPurchase(input.id)
  if (input.confirmation.trim() !== purchase.documentNumber) {
    throw new AppError(
      'VALIDATION_ERROR',
      `اكتب رقم الفاتورة ${purchase.documentNumber} لتأكيد الحذف النهائي`
    )
  }
  return withTransaction(() => performFullDeletePurchase(input.id, ctx))
}

/**
 * Undoes ONE supplier payment and its paired cash effect, leaving the
 * purchase invoice itself untouched — the mirror of `paySupplier`'s
 * increment. Used by the user-facing payment Delete action and by Cash
 * Account full deletion when that wider cleanup owns the transaction.
 * `purchases.paidMinor` is stored/incremental, never derived live, so
 * it is corrected here exactly as `paySupplier` set it, in reverse.
 *
 * The operation opens its own transaction and is also safe when reused
 * from a wider transactional cleanup such as Cash Account full delete.
 */
function assertSupplierPaymentDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(value)
  const parsed = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : null
  if (
    !match ||
    !parsed ||
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() !== Number(match[2]) - 1 ||
    parsed.getUTCDate() !== Number(match[3])
  ) {
    throw new AppError('VALIDATION_ERROR', 'تاريخ الدفعة غير صالح')
  }
}

function supplierPaymentCashRows(paymentId: number) {
  return getDatabase()
    .select()
    .from(cashTransactions)
    .where(
      and(eq(cashTransactions.refTable, 'supplier_payments'), eq(cashTransactions.refId, paymentId))
    )
    .all()
}

function assertSupplierPaymentCashLink(
  payment: typeof supplierPayments.$inferSelect,
  cashRows: ReturnType<typeof supplierPaymentCashRows>
): void {
  if (!payment.cashAccountId && cashRows.length === 0) return
  if (
    payment.cashAccountId &&
    cashRows.length === 1 &&
    cashRows[0]!.accountId === payment.cashAccountId &&
    cashRows[0]!.direction === 'out' &&
    cashRows[0]!.kind === 'supplier_payment' &&
    cashRows[0]!.amountMinor === payment.amountMinor
  )
    return
  throw new AppError('CONFLICT', 'لا يمكن تصحيح الدفعة لأن رابط حركتها النقدية غير مكتمل أو مكرر')
}

function recomputePurchasePaidMinor(purchaseId: number): void {
  getDatabase().run(sql`
    UPDATE purchases
    SET paid_minor = COALESCE((
      SELECT SUM(amount_minor)
      FROM supplier_payments
      WHERE purchase_id = ${purchaseId}
    ), 0)
    WHERE id = ${purchaseId}
  `)
}

export function updateSupplierPayment(
  paymentId: number,
  input: {
    amountMinor: number
    cashAccountId?: number | null
    paidAt: string
    notes?: string | null
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.purchases.editSupplierPayment)
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')
  assertSupplierPaymentDate(input.paidAt)

  withTransaction(() => {
    const payment = getDatabase()
      .select()
      .from(supplierPayments)
      .where(eq(supplierPayments.id, paymentId))
      .get()
    if (!payment) throw notFound('الدفعة غير موجودة أو تم حذفها')
    const cashRows = supplierPaymentCashRows(paymentId)
    assertSupplierPaymentCashLink(payment, cashRows)

    const nextAccountId =
      input.cashAccountId === undefined ? payment.cashAccountId : input.cashAccountId
    if (
      nextAccountId &&
      !getDatabase().select().from(cashAccounts).where(eq(cashAccounts.id, nextAccountId)).get()
    ) {
      throw notFound('الحساب النقدي غير موجود')
    }

    getDatabase()
      .update(supplierPayments)
      .set({
        amountMinor: input.amountMinor,
        cashAccountId: nextAccountId,
        paidAt: input.paidAt,
        notes: input.notes === undefined ? payment.notes : input.notes
      })
      .where(eq(supplierPayments.id, paymentId))
      .run()

    if (cashRows.length === 1 && nextAccountId) {
      adjustCashMovementForRef('supplier_payments', paymentId, {
        amountMinor: input.amountMinor,
        accountId: nextAccountId,
        occurredAt: input.paidAt
      })
    } else if (cashRows.length === 1) {
      removeCashMovementForRef('supplier_payments', paymentId)
    } else if (nextAccountId) {
      postCashMovement({
        accountId: nextAccountId,
        direction: 'out',
        amountMinor: input.amountMinor,
        kind: 'supplier_payment',
        refTable: 'supplier_payments',
        refId: paymentId,
        occurredAt: input.paidAt,
        ctx
      })
    }

    if (payment.purchaseId) recomputePurchasePaidMinor(payment.purchaseId)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'purchases.pay.update',
      entity: 'supplier_payments',
      entityId: String(paymentId),
      details: {
        paymentId,
        supplierId: payment.supplierId,
        purchaseId: payment.purchaseId,
        before: {
          amountMinor: payment.amountMinor,
          cashAccountId: payment.cashAccountId,
          paidAt: payment.paidAt,
          notes: payment.notes
        },
        after: {
          amountMinor: input.amountMinor,
          cashAccountId: nextAccountId,
          paidAt: input.paidAt,
          notes: input.notes === undefined ? payment.notes : input.notes
        },
        amountDeltaMinor: input.amountMinor - payment.amountMinor
      }
    })
  })
}

export function reverseSupplierPayment(paymentId: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.purchases.deleteSupplierPayment)
  withTransaction(() => {
    const payment = getDatabase()
      .select()
      .from(supplierPayments)
      .where(eq(supplierPayments.id, paymentId))
      .get()
    if (!payment) throw notFound('الدفعة غير موجودة أو تم حذفها')
    const cashRows = supplierPaymentCashRows(paymentId)
    assertSupplierPaymentCashLink(payment, cashRows)

    const deleted = getDatabase()
      .delete(supplierPayments)
      .where(eq(supplierPayments.id, paymentId))
      .run().changes
    if (deleted !== 1) throw new AppError('CONFLICT', 'تم حذف الدفعة بالفعل')
    removeCashMovementForRef('supplier_payments', paymentId)
    if (payment.purchaseId) recomputePurchasePaidMinor(payment.purchaseId)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'purchases.pay.reverse',
      entity: 'supplier_payments',
      entityId: String(paymentId),
      details: {
        description: `Supplier payment reversal (#${paymentId})`,
        paymentId,
        supplierId: payment.supplierId,
        purchaseId: payment.purchaseId,
        amountMinor: payment.amountMinor,
        cashAccountId: payment.cashAccountId,
        paidAt: payment.paidAt,
        notes: payment.notes,
        reversedByUserId: ctx.session.user.id,
        reversedAt: nowIso()
      }
    })
  })
}

function hasPurchasePayments(purchaseId: number): boolean {
  const count =
    getDatabase().get<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM supplier_payments WHERE purchase_id = ${purchaseId}`
    )?.c ?? 0
  return count > 0
}

function samePurchaseLines(
  existing: Array<typeof purchaseLines.$inferSelect>,
  resolved: ResolvedPurchaseLine[]
): boolean {
  return (
    existing.length === resolved.length &&
    existing.every((line, index) => {
      const next = resolved[index]!
      return (
        line.materialId === next.materialId &&
        line.qtyMicro === next.qtyMicro &&
        line.unitCostMicro === next.unit &&
        line.lineTotalMinor === next.lineTotal &&
        (line.batchCode ?? null) === (next.batchCode ?? null)
      )
    })
  )
}

export function updatePurchase(
  id: number,
  input: {
    supplierId?: number
    customerOrderId?: number | null
    purchaseDate?: string
    notes?: string | null
    lines?: PurchaseLineInput[]
    /** Item — moving the ONE existing supplier payment (if any) to a
     *  different cash/bank account. `undefined` leaves it untouched;
     *  `null` is refused (a real payment cannot go "unassigned"). */
    cashAccountId?: number | null
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.purchases.manage)
  const { purchase, lines, payments } = getPurchase(id)
  const supplierId = input.supplierId ?? purchase.supplierId
  if (!getDatabase().select().from(suppliers).where(eq(suppliers.id, supplierId)).get()) {
    throw notFound('المورد غير موجود')
  }
  if (input.lines && !input.lines.length) {
    throw new AppError('VALIDATION_ERROR', 'يجب إضافة صنف واحد على الأقل')
  }

  const resolved = input.lines?.map(resolvePurchaseLine)
  const linesChanged = resolved ? !samePurchaseLines(lines, resolved) : false
  const dateChanged =
    input.purchaseDate !== undefined && input.purchaseDate !== purchase.purchaseDate
  const supplierChanged = supplierId !== purchase.supplierId
  const customerOrderId =
    input.customerOrderId === undefined ? purchase.customerOrderId : input.customerOrderId
  const customerOrderChanged = customerOrderId !== purchase.customerOrderId
  assertCustomerOrderExists(customerOrderId, customerOrderChanged)
  if (customerOrderChanged) requirePermission(ctx.session, P.orders.view)
  const paymentsExist = purchase.paidMinor > 0 || hasPurchasePayments(id)

  if (paymentsExist && (linesChanged || supplierChanged)) {
    throw new AppError(
      'CONFLICT',
      'لا يمكن تغيير المورد أو قيمة فاتورة مرتبطة بدفعة مالية. صحّح الدفعة أولاً أو استخدم إجراءً مالياً معتمداً'
    )
  }

  // Moving the payment's cash account is a distinct, narrower
  // operation from everything above: it never touches lines, FIFO,
  // stock or the supplier — only which account the money is shown as
  // having come out of. Validated up front so a bad request never
  // reaches the transaction.
  const accountChangeRequested = input.cashAccountId !== undefined
  let paymentToMove: (typeof payments)[number] | undefined
  if (accountChangeRequested) {
    if (payments.length === 0) {
      throw new AppError(
        'CONFLICT',
        'لا توجد دفعة مسجّلة على فاتورة الشراء هذه لتغيير حسابها النقدي'
      )
    }
    if (payments.length > 1) {
      throw new AppError(
        'CONFLICT',
        'توجد أكثر من دفعة مسجّلة على هذه الفاتورة — صحّح الحساب النقدي لكل دفعة على حدة بدلاً من تعديلها من الفاتورة'
      )
    }
    if (input.cashAccountId === null) {
      throw new AppError('VALIDATION_ERROR', 'يجب اختيار حساب نقدي صالح لدفعة مسجّلة بالفعل')
    }
    if (
      !getDatabase()
        .select()
        .from(cashAccounts)
        .where(eq(cashAccounts.id, input.cashAccountId!))
        .get()
    ) {
      throw notFound('الحساب النقدي غير موجود')
    }
    paymentToMove = payments[0]
  }
  const accountChanged = Boolean(
    accountChangeRequested && paymentToMove && input.cashAccountId !== paymentToMove.cashAccountId
  )

  return withTransaction(() => {
    let artifacts: PurchaseArtifact[] = []
    if (linesChanged || dateChanged) artifacts = unusedPurchaseArtifacts(id)

    if (linesChanged || dateChanged) {
      for (const artifact of artifacts) {
        getDatabase()
          .delete(inventoryMovements)
          .where(eq(inventoryMovements.id, artifact.movementId))
          .run()
        getDatabase().delete(fifoLayers).where(eq(fifoLayers.id, artifact.layerId)).run()
      }
      getDatabase().delete(purchaseLines).where(eq(purchaseLines.purchaseId, id)).run()
      const effectiveLines =
        resolved ??
        lines.map((line) => ({
          ...line,
          unit: unitCostMicro(line.unitCostMicro),
          lineTotal: line.lineTotalMinor
        }))
      insertPurchaseLines(id, input.purchaseDate ?? purchase.purchaseDate, effectiveLines, ctx)
    }

    const totalMinor = linesChanged
      ? resolved!.reduce((sum, line) => sum + line.lineTotal, 0)
      : purchase.totalMinor
    getDatabase()
      .update(purchases)
      .set({
        supplierId,
        customerOrderId,
        purchaseDate: input.purchaseDate ?? purchase.purchaseDate,
        notes: input.notes !== undefined ? input.notes : purchase.notes,
        totalMinor
      })
      .where(eq(purchases.id, id))
      .run()

    // Move the payment's financial effect from the old account to the
    // new one. Since accountBalance() is always derived live (SUM per
    // account), re-pointing this single supplier_payments row — and
    // its one paired cash_transactions row — IS the complete reversal:
    // the old account's sum drops by amountMinor, the new account's
    // sum gains it, and there is still exactly one active movement,
    // never two (item 12).
    if (accountChanged && paymentToMove) {
      getDatabase()
        .update(supplierPayments)
        .set({ cashAccountId: input.cashAccountId! })
        .where(eq(supplierPayments.id, paymentToMove.id))
        .run()
      if (paymentToMove.cashAccountId) {
        // A real cash movement already exists for this payment (item
        // 11) — re-point it rather than posting a second one.
        adjustCashMovementForRef('supplier_payments', paymentToMove.id, {
          accountId: input.cashAccountId!
        })
      } else {
        // paySupplier() never posts a ledger row when no account was
        // given (postCashMovement short-circuits on a falsy accountId)
        // — so there is nothing to re-point yet; post it for the first
        // time now that a real account is being assigned.
        postCashMovement({
          accountId: input.cashAccountId!,
          direction: 'out',
          amountMinor: paymentToMove.amountMinor,
          kind: 'supplier_payment',
          refTable: 'supplier_payments',
          refId: paymentToMove.id,
          occurredAt: paymentToMove.paidAt,
          ctx
        })
      }
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'purchases.changePaymentAccount',
        entity: 'supplier_payments',
        entityId: String(paymentToMove.id),
        details: {
          purchaseId: id,
          amountMinor: paymentToMove.amountMinor,
          fromAccountId: paymentToMove.cashAccountId,
          toAccountId: input.cashAccountId
        }
      })
    }

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'purchases.update',
      entity: 'purchases',
      entityId: String(id),
      details: {
        linesChanged,
        dateChanged,
        supplierChanged,
        customerOrderChanged,
        fromCustomerOrderId: purchase.customerOrderId,
        toCustomerOrderId: customerOrderId,
        accountChanged,
        totalMinor
      }
    })
  })
}

export function deletePurchase(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.purchases.manage)
  const { purchase } = getPurchase(id)
  if (purchaseFullDeletePreview(id).blockers.includes(POSTED_PURCHASE_HISTORY_BLOCKER)) {
    throw new AppError('CONFLICT', POSTED_PURCHASE_HISTORY_BLOCKER)
  }
  if (purchase.paidMinor > 0 || hasPurchasePayments(id)) {
    throw new AppError(
      'CONFLICT',
      'لا يمكن حذف فاتورة مرتبطة بدفعة مورد أو حركة نقدية. يجب الحفاظ على التاريخ المالي'
    )
  }

  withTransaction(() => {
    const artifacts = unusedPurchaseArtifacts(id)
    for (const artifact of artifacts) {
      getDatabase()
        .delete(inventoryMovements)
        .where(eq(inventoryMovements.id, artifact.movementId))
        .run()
      getDatabase().delete(fifoLayers).where(eq(fifoLayers.id, artifact.layerId)).run()
    }
    getDatabase().delete(purchaseLines).where(eq(purchaseLines.purchaseId, id)).run()
    getDatabase().delete(purchases).where(eq(purchases.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'purchases.delete',
      entity: 'purchases',
      entityId: String(id),
      details: { documentNumber: purchase.documentNumber, totalMinor: purchase.totalMinor }
    })
  })
}
