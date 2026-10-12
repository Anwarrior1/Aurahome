import { assertResumedOrderFulfilmentReady } from '../sales/uncollected-products.service'
import { desc, eq, and, inArray, sql, type SQL } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import {
  workSheets,
  workSheetWorkers,
  releases,
  releaseWorkers,
  deliveries,
  deliveryWorkers,
  orderMaterialLines,
  orderMachineUsage,
  orderWorkerAssignments,
  workerTransactions,
  workers,
  machines,
  productMachineLines,
  productCommissionLines,
  plannedMaterials,
  plannedMachines,
  plannedWorkers,
  plannedOrderExpenses
} from '../../db/schema/production.schema'
import { orders, orderLines } from '../../db/schema/sales.schema'
import { products } from '../../db/schema/products.schema'
import { customers } from '../../db/schema/parties.schema'
import { materials } from '../../db/schema/catalog.schema'
import { AppError, notFound } from '../../utils/errors'
import { requirePermission } from '../../permissions/permission-guard'
import { nextDocumentNumber } from '../numbering.service'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, type ServiceContext } from '../base/service.types'
import { getOrderOrThrow, completeOrder, assertOrderOperational, authoritativeOrderPaymentPosition, supplyStandardLinesFromStock, transferCancelledOrderOutput } from '../sales/orders.service'
import { reverseWorkerEarnings } from './workers.service'
import { buildWorkSheet, buildRelease } from '../documents/documents.service'
import { stateToken } from '../../utils/state-token'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { availableQty, consumeMaterial, reverseConsumptionMovement } from '../inventory/inventory.service'
import { formatQuantity, quantity } from '@shared/quantity/quantity'
import { requireSafeNonNegativeInteger, requireSafePositiveInteger } from '../../utils/numeric'
import {
  COMPLETION_ACTION_LABEL,
  completionKindForPermit,
  EXIT_PERMIT_LABEL,
  EXIT_PERMIT_KINDS,
  isExitPermitKind,
  legacyUnlinkedCompletionKindForPermit,
  type CompletionKind,
  type ExitPermitKind,
  type IssuableExitPermitKind
} from '@shared/production/exit-permit'
import { MANUFACTURING_STARTED_REVERSAL_MESSAGE, manufacturingStarted } from '@shared/production/manufacturing-lifecycle'
import {
  idList,
  keysetBoundary,
  keysetOrder,
  keysetPage,
  normalizedSearch,
  type KeysetWindow,
  type PageRequest
} from '../base/pagination'
import { postFinishedGoodsProduction, onHandMicro } from './finished-goods.service'
import { runIdempotentFinancialCommand } from '../finance/idempotency.service'
export { reverseRelease } from './release-reversal.internal'
import { costOf, multiplyDivideRounded, unitCostMicro } from '@shared/money/cost'
import { isManufacturableOrderLine } from '../sales/order-line-manufacturing'
import {
  listPlannedMaterials,
  listPlannedMachines,
  listPlannedWorkers,
  listPlannedOrderExpenses,
  type PlannedMaterialInput
} from '../planning/planning.service'
import {
  activeReturnCostForWorkSheet,
  hasActiveReturnsForIssueLine,
  returnTotalsForIssueLine
} from './material-returns.service'

/**
 * Item 9: the production-order lifecycle.
 *
 * draft → ready → in_production → completed. Customer worksheets may be
 * cancelled only before start; a started job continues after its parent
 * Customer Order is cancelled. Stock worksheets retain their own cancellation
 * path. Backward moves are refused.
 */
export type ProductionStatus = 'draft' | 'ready' | 'in_production' | 'completed' | 'cancelled' | 'reversed'

const ALLOWED_TRANSITIONS: Record<ProductionStatus, ProductionStatus[]> = {
  draft: ['ready', 'cancelled'],
  // A short job can be issued and finished without anyone pausing to
  // press "start" — completing from `ready` stamps startedAt so the
  // timeline stays truthful. What stays forbidden is completing a draft
  // or a cancelled order, and any move backwards.
  ready: ['in_production', 'completed', 'cancelled'],
  in_production: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  reversed: []
}

const STATUS_LABEL: Record<ProductionStatus, string> = {
  draft: 'مسودة',
  ready: 'جاهز للتصنيع',
  in_production: 'قيد التصنيع',
  completed: 'مكتمل',
  cancelled: 'ملغى',
  reversed: 'تم التراجع'
}

/** States in which material/machine/labour may still be posted (item 12). */
const OPEN_FOR_POSTING: ProductionStatus[] = ['ready', 'in_production']

export function getWorkSheetOrThrow(id: number) {
  const sheet = getDatabase().select().from(workSheets).where(eq(workSheets.id, id)).get()
  if (!sheet) throw notFound('أمر التصنيع غير موجود')
  return sheet
}

function assertTransition(from: string, to: ProductionStatus): void {
  const allowed = ALLOWED_TRANSITIONS[from as ProductionStatus] ?? []
  if (!allowed.includes(to)) {
    throw new AppError(
      'CONFLICT',
      `لا يمكن نقل أمر التصنيع من "${STATUS_LABEL[from as ProductionStatus] ?? from}" إلى "${STATUS_LABEL[to]}"`
    )
  }
}

/**
 * Item 12: the gate every production posting goes through. Material,
 * machine usage and labour may only be posted against a production
 * order that exists and is still open — enforced HERE in main, not in
 * the renderer.
 */
function openWorkSheetForPosting(workSheetId: number) {
  const sheet = getWorkSheetOrThrow(workSheetId)
  if (sheet.orderId) {
    const parent = getOrderOrThrow(sheet.orderId)
    if (parent.status !== 'cancelled' || sheet.status !== 'in_production' || !sheet.startedAt)
      assertOrderOperational(sheet.orderId)
  }
  if (!OPEN_FOR_POSTING.includes(sheet.status as ProductionStatus)) {
    throw new AppError(
      'CONFLICT',
      `لا يمكن التسجيل على أمر تصنيع حالته "${STATUS_LABEL[sheet.status as ProductionStatus] ?? sheet.status}". يجب أن يكون جاهزاً أو قيد التصنيع`
    )
  }
  return sheet
}

export function assertProductionOpen(workSheetId: number) {
  const sheet = openWorkSheetForPosting(workSheetId)
  if (!sheet.orderId) throw new AppError('CONFLICT', 'إنتاج المخزون القياسي يتم فقط عبر صرف من المخزون من قائمة مكونات المنتج')
  return sheet
}

/** Legacy resource services must not change a finished manufacturing cost. */
export function assertResourceMutationOpen(link: { orderId?: number | null; workSheetId?: number | null }): void {
  if (link.workSheetId) {
    const sheet = assertProductionOpen(link.workSheetId)
    if (link.orderId !== undefined && link.orderId !== null && sheet.orderId !== link.orderId)
      throw new AppError('CONFLICT', 'مورد التصنيع لا يخص هذا الطلب')
    if (sheet.orderId) {
      const order = getOrderOrThrow(sheet.orderId)
      if (order.status === 'completed' || order.completedAt ||
        (order.status === 'cancelled' && (sheet.status !== 'in_production' || !sheet.startedAt)))
        throw new AppError('CONFLICT', 'لا يمكن تعديل موارد تصنيع طلب مكتمل أو ملغى خارج الإنتاج')
    }
    return
  }
  if (!link.orderId) throw new AppError('CONFLICT', 'سجل المورد غير مرتبط بأمر تصنيع أو طلب عميل')
  const order = assertOrderOperational(link.orderId)
  if (order.status === 'completed' || order.completedAt)
    throw new AppError('CONFLICT', 'لا يمكن تعديل موارد طلب مكتمل')
  if (getDatabase().get(sql`SELECT id FROM work_sheets WHERE order_id = ${link.orderId}
    AND (status = 'completed' OR completed_at IS NOT NULL) LIMIT 1`))
    throw new AppError('CONFLICT', 'لا يمكن تعديل موارد طلب له تصنيع مكتمل')
  const sheet = getDatabase().select().from(workSheets)
    .where(and(eq(workSheets.orderId, link.orderId), sql`${workSheets.status} != 'reversed'`)).get()
  if (sheet) {
    assertResourceMutationOpen({ workSheetId: sheet.id })
  } else if (order.status !== 'confirmed') {
    throw new AppError('CONFLICT', 'لا يمكن تعديل موارد طلب غير مفتوح للتصنيع')
  }
}

/**
 * BR-16/BR-42 + item 8: issues the Production Order ("أمر تصنيع").
 *
 * Customer Manufacturing Orders use this multi-stage path. Standard stock
 * production uses the atomic issueStandardStockFromBom command instead.
 */
export function issueWorkSheet(
  input: {
    orderId?: number
    productId?: number
    quantityMicro?: number
    workerIds?: number[]
    notes?: string
    overrideDepositRequirement?: boolean
  },
  ctx: ServiceContext
): { id: number; documentNumber: string } {
  return withTransaction(() => {
    // Issuing a customer Manufacturing Order now posts stock as part of
    // the same business transaction. Both authorities are therefore
    // required in the service (IPC visibility alone is not security).
    requirePermission(ctx.session, P.worksheets.issue)
    if (input.orderId) requirePermission(ctx.session, P.inventory.consume)

    if (input.orderId && input.productId) {
      throw new AppError('VALIDATION_ERROR', 'أمر التصنيع إمّا لطلب عميل أو لإنتاج مخزون، وليس الاثنين معاً')
    }
    if (!input.orderId) {
      throw new AppError('CONFLICT', 'إنتاج المخزون القياسي يتم فقط عبر صرف من المخزون من قائمة مكونات المنتج')
    }

    if (input.orderId) {
      const order = assertOrderOperational(input.orderId)
      if (order.status === 'cancelled') {
        throw new AppError('CONFLICT', 'لا يمكن إصدار أمر تصنيع لطلب ملغى')
      }
      if (order.status === 'completed' || order.completedAt) throw new AppError('CONFLICT', 'تراجع عن إكمال الطلب أولاً قبل إصدار التصنيع')
      const hasManufacturableLine = getDatabase()
        .select()
        .from(orderLines)
        .where(eq(orderLines.orderId, input.orderId))
        .all()
        .some(isManufacturableOrderLine)
      if (!hasManufacturableLine) {
        throw new AppError('CONFLICT', 'لا يحتوي هذا الطلب على بنود مخصّصة للتصنيع — المنتجات القياسية تُصرف من المخزون الجاهز، وبنود المنتجات غير المستلمة مصنّعة بالفعل؛ لا يحتاج أمر تصنيع')
      }
      if (getDatabase().get(sql`SELECT id FROM releases WHERE order_id = ${input.orderId} AND status = 'active' LIMIT 1`)
        || getDatabase().get(sql`SELECT id FROM deliveries WHERE order_id = ${input.orderId} AND status = 'recorded' LIMIT 1`)) throw new AppError('CONFLICT', 'تراجع عن التسليم وإذن الخروج أولاً قبل إصدار التصنيع')
      // Any persisted worksheet makes this one-time action complete.
      // Cancel currently preserves posted inventory/cost history, so a
      // cancelled worksheet must not reopen a path that could issue the
      // same plan twice.
      const existing = getDatabase()
        .select({ documentNumber: workSheets.documentNumber })
        .from(workSheets)
        .where(and(eq(workSheets.orderId, input.orderId), sql`${workSheets.status} != 'reversed'`))
        .get()
      if (existing) {
        throw new AppError('CONFLICT', `صدر أمر تصنيع لهذا الطلب بالفعل (${existing.documentNumber})`)
      }
    }

    const documentNumber = nextDocumentNumber('MO')
    const issuedAt = nowIso()
    const id = Number(
      getDatabase()
        .insert(workSheets)
        .values({
          documentNumber,
        orderId: input.orderId,
        productId: null,
        quantityMicro: 0,
          // Issued production orders start ready — the gate that had to
          // be satisfied to get here has already been satisfied.
          status: 'ready',
          issuedAt,
          notes: input.notes ?? null,
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    for (const workerId of input.workerIds ?? []) {
      getDatabase().insert(workSheetWorkers).values({ workSheetId: id, workerId }).run()
    }
    // Item 10: the production order opens with its material report
    // already filled in — the custom plan priced on the preliminary
    // invoice, or the standard product's frozen BOM.
    const materialCount = seedWorkSheetMaterials({
      workSheetId: id,
      orderId: input.orderId ?? null,
      productId: null,
      quantityMicro: undefined
    })
    // The machine half of the same snapshot (migration 0006), now also
    // falling back to the product's own Product Components "الآلات"
    // list for stock production. Planning only — no order_machine_usage
    // row and no actual cost is created by issuing a production order.
    const machineCount = seedWorkSheetMachines({
      workSheetId: id,
      orderId: input.orderId ?? null,
      productId: null,
      quantityMicro: undefined
    })
    // The worker-commission half of the same planning snapshot: the
    // product's standard commission, or the order's own planned
    // workers. Planning only — no order_worker_assignments row and no
    // payable commission is created by issuing a production order.
    const workerCount = seedWorkSheetWorkers({
      workSheetId: id,
      orderId: input.orderId ?? null,
      productId: null,
      quantityMicro: undefined
    })
    const expenseCount = seedWorkSheetOrderExpenses(id, input.orderId)

    // Customer-order planning becomes actual usage at this exact point.
    // Free-text/non-inventory plan rows stay planning-only; every row
    // linked to a Raw Material is validated as a group first, then
    // consumed through the existing FIFO service so its historical cost
    // layers and frozen issue snapshots remain authoritative.
    const issuedMaterials: Array<{
      lineId: number; materialId: number; quantityMicro: number; actualCostMinor: number
    }> = []
    if (input.orderId) {
      const planned = inventoryPlannedMaterials(id)
      const shortage = plannedMaterialShortages(planned)[0]
      if (shortage) {
        throw new AppError(
          'CONFLICT',
          `لا يمكن إصدار أمر التصنيع. الرصيد المتاح لمادة ${shortage.materialName} هو ${formatQuantity(quantity(shortage.availableMicro), shortage.unit)}، والكمية المطلوبة هي ${formatQuantity(quantity(shortage.requiredMicro), shortage.unit)}.`
        )
      }
      for (const line of planned) {
        if (line.qtyMicro <= 0) continue
        const issued = consumeForOrder({
          workSheetId: id,
          materialId: line.materialId,
          physicalQtyMicro: line.qtyMicro,
          colorCode: line.colorCode ?? undefined,
          notes: line.notes ?? undefined
        }, ctx)
        issuedMaterials.push({
          lineId: issued.id,
          materialId: line.materialId,
          quantityMicro: line.qtyMicro,
          actualCostMinor: issued.actualCostMinor
        })
      }
    }

    getDatabase().update(workSheets).set({ documentSnapshot: JSON.stringify(buildWorkSheet(id, ctx)) }).where(eq(workSheets.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'worksheets.issue',
      entity: 'work_sheets',
      entityId: String(id),
      details: {
        documentNumber,
        workSheetId: id,
        orderId: input.orderId ?? null,
        productId: input.productId ?? null,
        plannedMaterialCount: materialCount,
        plannedMachineCount: machineCount,
        plannedWorkerCount: workerCount,
        plannedOrderExpenseCount: expenseCount,
        issuedMaterials,
        actualMaterialCostMinor: issuedMaterials.reduce((sum, line) => sum + line.actualCostMinor, 0)
      }
    })
    return { id, documentNumber }
  })
}

function inventoryPlannedMaterials(workSheetId: number) {
  return listPlannedMaterials({ workSheetId }).filter(
    (line): line is typeof line & { materialId: number } => line.materialId !== null
  )
}

/** Required vs available per raw material, grouped; the whole group is validated before any issue. */
function plannedMaterialShortages(
  planned: Array<{ materialId: number; materialName: string; qtyMicro: number; unit: string | null }>
) {
  const required = new Map<number, { materialId: number; materialName: string; unit: string; requiredMicro: number }>()
  for (const line of planned) {
    if (line.qtyMicro <= 0) continue
    const current = required.get(line.materialId)
    required.set(line.materialId, {
      materialId: line.materialId,
      materialName: current?.materialName ?? line.materialName,
      unit: current?.unit ?? line.unit ?? '',
      requiredMicro: (current?.requiredMicro ?? 0) + line.qtyMicro
    })
  }
  return [...required.values()]
    .map((line) => ({ ...line, availableMicro: availableQty(line.materialId) }))
    .filter((line) => line.availableMicro < line.requiredMicro)
}

const WHOLE_UNIT_MICRO = 1_000_000

function requireProducedUnits(quantityMicro: number): void {
  requireSafePositiveInteger(quantityMicro, 'الكمية المصنّعة')
  if (quantityMicro % WHOLE_UNIT_MICRO !== 0) {
    throw new AppError('VALIDATION_ERROR', 'الكمية المصنّعة يجب أن تكون عدداً صحيحاً من الوحدات')
  }
}

/** BOM × produced quantity, the same scaling a stock production order is seeded with. */
function standardStockRequirement(productId: number, quantityMicro: number) {
  const product = getDatabase().select().from(products).where(eq(products.id, productId)).get()
  if (!product) throw notFound('المنتج غير موجود')
  const bom = getDatabase().all<{ materialId: number; materialName: string; unit: string; qtyMicro: number }>(sql`
    SELECT m.id AS materialId, m.name AS materialName, m.unit, pbl.qty_micro AS qtyMicro
    FROM product_bom_lines pbl INNER JOIN materials m ON m.id = pbl.material_id
    WHERE pbl.product_id = ${productId} ORDER BY pbl.id
  `)
  if (!bom.length) throw new AppError('VALIDATION_ERROR', 'لا توجد قائمة مواد لهذا المنتج — أضف المواد أولاً')
  const lines = bom.map((line) => {
    requireSafePositiveInteger(line.qtyMicro, 'كمية المادة في قائمة المكونات')
    return { ...line, qtyMicro: multiplyDivideRounded(line.qtyMicro, quantityMicro, WHOLE_UNIT_MICRO) }
  })
  return { product, lines }
}

/** Read-only preview for «صرف من المخزون»; the command re-validates everything in its own transaction. */
export function standardStockIssuePreview(input: { productId: number; quantityMicro: number }) {
  requireProducedUnits(input.quantityMicro)
  const { product, lines } = standardStockRequirement(input.productId, input.quantityMicro)
  const shortages = new Map(plannedMaterialShortages(lines).map((line) => [line.materialId, line]))
  const readyMicro = onHandMicro(input.productId)
  return {
    productId: product.id,
    productName: product.name,
    quantityMicro: input.quantityMicro,
    lines: lines.map((line) => ({
      ...line,
      availableMicro: availableQty(line.materialId),
      shortageMicro: shortages.has(line.materialId)
        ? shortages.get(line.materialId)!.requiredMicro - shortages.get(line.materialId)!.availableMicro
        : 0
    })),
    canIssue: shortages.size === 0,
    readyMicro,
    readyAfterMicro: readyMicro + input.quantityMicro
  }
}

/**
 * BL-04 «صرف من المخزون»: one atomic, idempotent stock Manufacturing Order.
 * Materials, configured machines and named worker commissions all scale with
 * the produced quantity and enter the same completed FG value.
 */
export function issueStandardStockFromBom(
  input: { productId: number; quantityMicro: number; requestKey: string },
  ctx: ServiceContext
): { workSheetId: number; documentNumber: string; finishedGoodsMovementId: number; totalCostMinor: number } {
  requirePermission(ctx.session, P.products.manage)
  requirePermission(ctx.session, P.inventory.consume)
  requireProducedUnits(input.quantityMicro)
  const { requestKey, ...payload } = input
  return runIdempotentFinancialCommand({
    commandScope: 'products.issueStockFromBom',
    requestKey,
    payload,
    ctx,
    execute: () => withTransaction(() => {
      const { product, lines } = standardStockRequirement(input.productId, input.quantityMicro)
      const shortages = plannedMaterialShortages(lines)
      if (shortages.length) {
        throw new AppError('CONFLICT', `المواد غير كافية لتصنيع الكمية كاملة: ${shortages
          .map((line) => `${line.materialName} (المطلوب ${formatQuantity(quantity(line.requiredMicro), line.unit)}، المتاح ${formatQuantity(quantity(line.availableMicro), line.unit)})`)
          .join('، ')}`)
      }
      const at = nowIso()
      const documentNumber = nextDocumentNumber('MO')
      const workSheetId = Number(getDatabase().insert(workSheets).values({
        documentNumber,
        orderId: null,
        productId: product.id,
        quantityMicro: input.quantityMicro,
        status: 'ready',
        issuedAt: at,
        notes: 'صرف من المخزون — إنتاج منتج قياسي',
        createdBy: ctx.session.user.id,
        createdAt: at
      }).run().lastInsertRowid)
      seedWorkSheetMaterials({ workSheetId, productId: product.id, quantityMicro: input.quantityMicro })
      seedWorkSheetMachines({ workSheetId, productId: product.id, quantityMicro: input.quantityMicro })
      seedWorkSheetWorkers({ workSheetId, productId: product.id, quantityMicro: input.quantityMicro })
      for (const line of inventoryPlannedMaterials(workSheetId)) {
        consumeForOrderInternal({ workSheetId, materialId: line.materialId, physicalQtyMicro: line.qtyMicro }, ctx, true)
      }
      const completed = completeProductionInternal(workSheetId, ctx)
      const totalCostMinor = productionActualCostMinor(workSheetId)
      const finishedGoodsMovementId = completed.finishedGoodsMovementId!
      getDatabase().update(workSheets).set({ documentSnapshot: JSON.stringify(buildWorkSheet(workSheetId, ctx)) }).where(eq(workSheets.id, workSheetId)).run()
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'products.issueStockFromBom',
        entity: 'work_sheets',
        entityId: String(workSheetId),
        details: { productId: product.id, quantityMicro: input.quantityMicro, documentNumber, finishedGoodsMovementId, totalCostMinor, requestKey }
      })
      return { workSheetId, documentNumber, finishedGoodsMovementId, totalCostMinor }
    })
  })
}

/** Item 9: draft/ready → in production. */
export function startProduction(id: number, ctx: ServiceContext): { startedAt: string } {
  requirePermission(ctx.session, P.worksheets.issue)
  return withTransaction(() => {
    const sheet = getWorkSheetOrThrow(id)
    if (!sheet.orderId) throw new AppError('CONFLICT', 'أمر تصنيع المخزون التاريخي للعرض فقط؛ استخدم صرف من المخزون لإنتاج جديد')
    if (sheet.orderId) assertOrderOperational(sheet.orderId)
    if (sheet.status === 'draft') assertTransition(sheet.status, 'ready')
    assertTransition(sheet.status === 'draft' ? 'ready' : sheet.status, 'in_production')

    const startedAt = nowIso()
    getDatabase()
      .update(workSheets)
      .set({ status: 'in_production', startedAt: sheet.startedAt ?? startedAt })
      .where(eq(workSheets.id, id))
      .run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'worksheets.start',
      entity: 'work_sheets',
      entityId: String(id),
      details: { startedAt }
    })
    return { startedAt }
  })
}

/** Actual resource posting belongs only to completeProduction's once-only transaction. */
function recognizeManufacturingCommissions(sheet: { id: number; orderId: number | null }, completedAt: string, ctx: ServiceContext): void {
  const db = getDatabase()
  const planned = listPlannedWorkers(sheet.orderId ? { orderId: sheet.orderId } : { workSheetId: sheet.id })
  if (!sheet.orderId && planned.some((line) => line.workerId === null && line.estimatedCostMinor > 0))
    throw new AppError('CONFLICT', 'لا يمكن إكمال تصنيع مخزون بعمولة عامل دون تعيين عامل')
  for (const line of planned) {
    if (line.workerId === null || line.estimatedCostMinor <= 0) continue
    requireSafePositiveInteger(line.estimatedCostMinor, 'عمولة العامل المخططة')
    db.insert(orderWorkerAssignments).values({
      orderId: sheet.orderId, workSheetId: sheet.id, workerId: line.workerId,
      method: 'fixed', amountMinor: line.estimatedCostMinor, earned: false,
      notes: `عمولة تجهيز الإنتاج: ${line.workerName}`
    }).run()
  }
  const assignments = db.all<{ id: number; workerId: number; amountMinor: number }>(sql`
    SELECT id, worker_id AS workerId, amount_minor AS amountMinor FROM order_worker_assignments
    WHERE earned = 0 AND reversed_at IS NULL AND amount_minor > 0
      AND (work_sheet_id = ${sheet.id} OR (${sheet.orderId} IS NOT NULL AND order_id = ${sheet.orderId} AND work_sheet_id IS NULL))
    ORDER BY id
  `)
  for (const assignment of assignments) {
    db.insert(workerTransactions).values({
      workerId: assignment.workerId, kind: 'earning', amountMinor: assignment.amountMinor,
      orderId: sheet.orderId, assignmentId: assignment.id,
      notes: 'مستحقات عند إنهاء التصنيع', createdBy: ctx.session.user.id, createdAt: completedAt
    }).run()
    db.update(orderWorkerAssignments).set({ earned: true, earnedAt: completedAt })
      .where(eq(orderWorkerAssignments.id, assignment.id)).run()
  }
  if (assignments.length) recordAuditEvent({
    userId: ctx.session.user.id, action: 'workers.commission.recognize', entity: 'work_sheets',
    entityId: String(sheet.id), details: {
      assignmentIds: assignments.map((a) => a.id),
      totalMinor: assignments.reduce((sum, a) => sum + a.amountMinor, 0)
    }
  })
}

/** Private issuance snapshots: called only while the owning lifecycle creates a new worksheet. */
function seedWorkSheetMaterials(input: {
  workSheetId: number
  orderId?: number | null
  productId?: number | null
  quantityMicro?: number
}): number {
  const db = getDatabase()
  const insert = (line: PlannedMaterialInput & { sortOrder: number }): void => {
    db.insert(plannedMaterials)
      .values({
        workSheetId: input.workSheetId,
        materialId: line.materialId ?? null,
        materialName: line.materialName,
        qtyMicro: line.qtyMicro,
        unit: line.unit ?? null,
        dimensions: line.dimensions ?? null,
        thickness: line.thickness ?? null,
        colorCode: line.colorCode ?? null,
        notes: line.notes ?? null,
        estimatedUnitCostMicro: line.estimatedUnitCostMicro ?? 0,
        estimatedTotalMinor: costOf(line.qtyMicro, unitCostMicro(line.estimatedUnitCostMicro ?? 0)),
        sortOrder: line.sortOrder,
        createdAt: nowIso()
      })
      .run()
  }

  let count = 0

  if (input.orderId) {
    const planned = listPlannedMaterials({ orderId: input.orderId })
    if (planned.length) {
      planned.forEach((line, index) => {
        insert({ ...line, sortOrder: index })
        count += 1
      })
      return count
    }
    // No custom plan — fall back to the BOM snapshots on the order lines.
    const lines = db.select().from(orderLines).where(eq(orderLines.orderId, input.orderId)).all()
      .filter(isManufacturableOrderLine)
    for (const orderLine of lines) {
      if (!orderLine.bomSnapshot) continue
      const bom = JSON.parse(orderLine.bomSnapshot) as {
        lines: Array<{ materialId: number; materialName: string; qtyMicro: number; unit: string; dimensions?: string }>
      }
      for (const bomLine of bom.lines ?? []) {
        insert({
          materialId: bomLine.materialId,
          materialName: bomLine.materialName,
          // The BOM is per unit — scale it by how many were ordered.
          qtyMicro: multiplyDivideRounded(bomLine.qtyMicro, orderLine.quantityMicro, 1_000_000),
          unit: bomLine.unit,
          dimensions: bomLine.dimensions ?? null,
          colorCode: orderLine.colorCode,
          sortOrder: count
        })
        count += 1
      }
    }
    return count
  }

  // Stock production: derive straight from the product's live BOM.
  if (input.productId) {
    const bomRows = db
      .select({
        materialId: materials.id,
        materialName: materials.name,
        unit: materials.unit,
        qtyMicro: sql<number>`pbl.qty_micro`,
        dimensions: sql<string | null>`pbl.dimensions`
      })
      .from(sql`product_bom_lines pbl`)
      .innerJoin(materials, sql`${materials.id} = pbl.material_id`)
      .where(sql`pbl.product_id = ${input.productId}`)
      .all()
    const multiplier = input.quantityMicro ?? 1_000_000
    for (const row of bomRows) {
      insert({
        materialId: row.materialId,
        materialName: row.materialName,
        qtyMicro: multiplyDivideRounded(row.qtyMicro, multiplier, 1_000_000),
        unit: row.unit,
        dimensions: row.dimensions ?? null,
        sortOrder: count
      })
      count += 1
    }
  }
  return count
}

function seedWorkSheetMachines(input: {
  workSheetId: number
  orderId?: number | null
  productId?: number | null
  quantityMicro?: number
}): number {
  const db = getDatabase()
  let count = 0
  if (input.orderId) {
    for (const line of listPlannedMachines({ orderId: input.orderId })) {
      db.insert(plannedMachines)
        .values({
          workSheetId: input.workSheetId,
          machineId: line.machineId,
          machineName: line.machineName,
          usageQtyMicro: line.usageQtyMicro,
          usageUnit: line.usageUnit,
          rateMicro: line.rateMicro,
          // Carried for internal planned-vs-actual comparison inside the
          // ERP; the factory document's DTO has no field for it.
          estimatedCostMinor: line.estimatedCostMinor,
          notes: line.notes,
          createdAt: nowIso()
        })
        .run()
      count += 1
    }
    return count
  }

  if (input.productId) {
    const rows = db
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
      .where(eq(productMachineLines.productId, input.productId))
      .all()
    const multiplier = input.quantityMicro ?? 1_000_000
    for (const row of rows) {
      const usageQtyMicro = multiplyDivideRounded(row.usageQtyMicro, multiplier, 1_000_000)
      const rate = row.rateMicro ?? row.defaultRateMicro
      db.insert(plannedMachines)
        .values({
          workSheetId: input.workSheetId,
          machineId: row.machineId,
          machineName: row.machineName,
          usageQtyMicro,
          usageUnit: row.costingUnit,
          rateMicro: rate,
          estimatedCostMinor: costOf(usageQtyMicro, unitCostMicro(rate)),
          notes: row.notes,
          createdAt: nowIso()
        })
        .run()
      count += 1
    }
  }
  return count
}

function seedWorkSheetWorkers(input: {
  workSheetId: number
  orderId?: number | null
  productId?: number | null
  quantityMicro?: number
}): number {
  const db = getDatabase()
  let count = 0
  if (input.orderId) {
    for (const line of listPlannedWorkers({ orderId: input.orderId })) {
      db.insert(plannedWorkers)
        .values({
          workSheetId: input.workSheetId,
          workerId: line.workerId,
          workerName: line.workerName,
          commissionMode: line.commissionMode,
          meterRateMicro: line.meterRateMicro,
          meterQtyMicro: line.meterQtyMicro,
          estimatedCostMinor: line.estimatedCostMinor,
          notes: line.notes,
          createdAt: nowIso()
        })
        .run()
      count += 1
    }
    return count
  }

  if (input.productId) {
    const rows = db
      .select({
        workerId: productCommissionLines.workerId,
        workerName: workers.name,
        amountMinor: productCommissionLines.amountMinor,
        notes: productCommissionLines.notes
      })
      .from(productCommissionLines)
      .leftJoin(workers, eq(workers.id, productCommissionLines.workerId))
      .where(eq(productCommissionLines.productId, input.productId))
      .all()
    const multiplier = input.quantityMicro ?? 1_000_000
    for (const row of rows) {
      db.insert(plannedWorkers)
        .values({
          workSheetId: input.workSheetId,
          workerId: row.workerId,
          // No worker chosen yet on the standard config — a clear
          // generic label, never a blank name.
          workerName: row.workerName ?? 'عمولة تصنيع قياسية',
          commissionMode: 'estimated',
          estimatedCostMinor: multiplyDivideRounded(row.amountMinor, multiplier, 1_000_000),
          notes: row.notes,
          createdAt: nowIso()
        })
        .run()
      count += 1
    }
  }
  return count
}

function seedWorkSheetOrderExpenses(workSheetId: number, orderId?: number | null): number {
  if (!orderId) return 0
  const rows = listPlannedOrderExpenses({ orderId })
  for (const row of rows) {
    getDatabase().insert(plannedOrderExpenses).values({
      workSheetId,
      expenseName: row.expenseName,
      amountMinor: row.amountMinor,
      sortOrder: row.sortOrder,
      createdAt: nowIso()
    }).run()
  }
  return rows.length
}

function recognizePreparedMachineUsage(sheet: { id: number; orderId: number | null }, completedAt: string, ctx: ServiceContext): void {
  const db = getDatabase()
  const planned = listPlannedMachines(sheet.orderId ? { orderId: sheet.orderId } : { workSheetId: sheet.id })
  if (!sheet.orderId && planned.some((line) => line.machineId === null && line.usageQtyMicro > 0))
    throw new AppError('CONFLICT', 'لا يمكن إكمال تصنيع مخزون بآلة غير محددة')
  const lines = planned.filter((line) => line.machineId !== null && line.usageQtyMicro > 0)
  const ids: number[] = []
  for (const line of lines) {
    requireSafeNonNegativeInteger(line.estimatedCostMinor, 'تكلفة الآلة المخططة')
    ids.push(Number(db.insert(orderMachineUsage).values({
      orderId: sheet.orderId, workSheetId: sheet.id, machineId: line.machineId!,
      usageQtyMicro: line.usageQtyMicro, rateMicro: line.rateMicro ?? 0,
      calculatedMinor: line.estimatedCostMinor, finalAmountMinor: line.estimatedCostMinor,
      notes: `آلة تجهيز الإنتاج: ${line.machineName}`, createdAt: completedAt
    }).run().lastInsertRowid))
  }
  if (ids.length) recordAuditEvent({
    userId: ctx.session.user.id, action: 'machines.usage.recognize', entity: 'work_sheets',
    entityId: String(sheet.id), details: {
      usageIds: ids, totalMinor: lines.reduce((sum, line) => sum + line.estimatedCostMinor, 0)
    }
  })
}

/**
 * Completing production — a single, real, audited event (item 12).
 *
 * There is no stage checklist to satisfy: the factory works from the
 * printed production order and the user marks it complete when it is
 * done. Completion still matters downstream, because the exit permit
 * will not be issued until it has happened. A stock production order
 * posts its output into finished goods at its actual production cost.
 */
export function completeProduction(
  id: number,
  ctx: ServiceContext
): { completedAt: string; finishedGoodsMovementId?: number } {
  requirePermission(ctx.session, P.worksheets.issue)
  if (!getWorkSheetOrThrow(id).orderId)
    throw new AppError('CONFLICT', 'أمر تصنيع المخزون التاريخي للعرض فقط؛ استخدم صرف من المخزون لإنتاج جديد')
  return completeProductionInternal(id, ctx)
}

function completeProductionInternal(
  id: number,
  ctx: ServiceContext
): { completedAt: string; finishedGoodsMovementId?: number } {
  const sheet = getWorkSheetOrThrow(id)
  if (sheet.orderId) {
    const parent = getOrderOrThrow(sheet.orderId)
    if (parent.status !== 'cancelled' || sheet.status !== 'in_production' || !sheet.startedAt)
      assertOrderOperational(sheet.orderId)
  }
  assertTransition(sheet.status, 'completed')

  return withTransaction(() => {
    const completedAt = nowIso()
    const completed = getDatabase()
      .update(workSheets)
      .set({
        status: 'completed',
        // Completing straight from `ready` still records when the work
        // actually began, so the production timeline is never blank.
        startedAt: sheet.startedAt ?? completedAt,
        completedAt
      })
      .where(and(eq(workSheets.id, id), eq(workSheets.status, sheet.status)))
      .run().changes
    // Exactly-once: a stale or repeated completion commits nothing (commission recognition included).
    if (completed !== 1) throw new AppError('CONFLICT', 'تم إنهاء تصنيع هذا الأمر بالفعل')

    // CC04/CC04B: prepared commissions and machines become actual here, before finished goods read the cost.
    recognizeManufacturingCommissions(sheet, completedAt, ctx)
    recognizePreparedMachineUsage(sheet, completedAt, ctx)

    let finishedGoodsMovementId: number | undefined
    if (sheet.productId && sheet.quantityMicro > 0) {
      finishedGoodsMovementId = postFinishedGoodsProduction(
        {
          productId: sheet.productId,
          workSheetId: id,
          qtyMicro: sheet.quantityMicro,
          totalCostMinor: productionActualCostMinor(id)
        },
        ctx
      )
    }
    if (sheet.orderId) {
      const parent = getOrderOrThrow(sheet.orderId)
      if (parent.status === 'cancelled')
        transferCancelledOrderOutput(sheet.orderId, parent.cancelReason ?? 'إلغاء الطلب', ctx)
    }

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'worksheets.complete',
      entity: 'work_sheets',
      entityId: String(id),
      details: { completedAt, finishedGoodsMovementId }
    })
    return { completedAt, finishedGoodsMovementId }
  })
}

/**
 * Item 22 — safe deletion of a production order.
 *
 * Hard delete only while it has produced nothing: no consumed stock, no
 * machine or labour posting, no finished goods. A production order that
 * really ran is cancelled instead — FIFO history is never deleted to
 * make a document disappear.
 */
export function productionDeletionBlockers(workSheetId: number): string[] {
  const db = getDatabase()
  const count = (query: ReturnType<typeof sql>): number => db.get<{ c: number }>(query)?.c ?? 0
  const blockers: string[] = []

  if (count(sql`SELECT COUNT(*) AS c FROM order_material_lines WHERE work_sheet_id = ${workSheetId}`) > 0) {
    blockers.push('صُرفت مواد فعلية من المخزون على هذا الأمر')
  }
  if (count(sql`SELECT COUNT(*) AS c FROM order_machine_usage WHERE work_sheet_id = ${workSheetId}`) > 0) {
    blockers.push('يوجد استخدام آلات مسجّل')
  }
  if (count(sql`SELECT COUNT(*) AS c FROM order_worker_assignments WHERE work_sheet_id = ${workSheetId}`) > 0) {
    blockers.push('توجد مستحقات عمال مسجّلة')
  }
  if (count(sql`SELECT COUNT(*) AS c FROM finished_goods_movements WHERE work_sheet_id = ${workSheetId}`) > 0) {
    blockers.push('أُدخلت بضاعة جاهزة للمخزون من هذا الأمر')
  }
  return blockers
}

/** Issuance itself is historical; use cancellation/reversal, never deletion. */
export function deleteProductionOrder(id: number, ctx: ServiceContext): void {
  const sheet = getWorkSheetOrThrow(id)
  void ctx
  throw new AppError(
    'CONFLICT',
    `أمر التصنيع ${sheet.documentNumber} مستند تشغيلي مُصدر ولا يمكن حذفه نهائياً؛ استخدم الإلغاء أو التراجع للحفاظ على تاريخه`
  )
}

/**
 * A customer worksheet can be cancelled before start. Once started, cancel
 * the commercial Customer Order instead and complete the physical work.
 * Stock-production cancellation retains its existing posted-cost history.
 */
export function cancelProductionOrder(
  input: { id: number; reason: string },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.worksheets.reverse)
  return withTransaction(() => {
    const sheet = getWorkSheetOrThrow(input.id)
    if (!sheet.orderId) throw new AppError('CONFLICT', 'لا يمكن إلغاء أمر تصنيع المخزون؛ إنتاج المخزون القياسي يتم بعملية صرف ذرية واحدة')
    assertTransition(sheet.status, 'cancelled')
    if (sheet.orderId && manufacturingStarted(sheet))
      throw new AppError('CONFLICT', 'لا يمكن إلغاء أمر تصنيع طلب عميل بعد بدء التصنيع؛ ألغِ طلب العميل واترك التصنيع مستمراً')
    if (!input.reason?.trim()) throw new AppError('VALIDATION_ERROR', 'سبب الإلغاء مطلوب')

    getDatabase()
      .update(workSheets)
      .set({ status: 'cancelled', cancelledAt: nowIso(), cancelReason: input.reason })
      .where(eq(workSheets.id, input.id))
      .run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'worksheets.cancel',
      entity: 'work_sheets',
      entityId: String(input.id),
      details: { reason: input.reason }
    })
  })
}

function workSheetReversalToken(id: number): string {
  const sheet = getWorkSheetOrThrow(id)
  const db = getDatabase()
  return stateToken({ sheet,
    materials: db.all(sql`SELECT * FROM order_material_lines WHERE work_sheet_id = ${id} ORDER BY id`),
    machines: db.all(sql`SELECT * FROM order_machine_usage WHERE work_sheet_id = ${id} ORDER BY id`),
    workers: db.all(sql`SELECT * FROM order_worker_assignments WHERE work_sheet_id = ${id} ORDER BY id`),
    allocations: db.all(sql`SELECT a.*, l.qty_remaining_micro FROM fifo_allocations a JOIN fifo_layers l ON l.id = a.layer_id WHERE a.movement_id IN (SELECT movement_id FROM order_material_lines WHERE work_sheet_id = ${id}) ORDER BY a.id`),
    order: sheet.orderId ? getOrderOrThrow(sheet.orderId) : null,
    permits: sheet.orderId ? db.all(sql`SELECT id, status FROM releases WHERE order_id = ${sheet.orderId} ORDER BY id`) : [],
    deliveries: sheet.orderId ? db.all(sql`SELECT id, status FROM deliveries WHERE order_id = ${sheet.orderId} ORDER BY id`) : []
  })
}

function assertNoUncollectedOutput(orderId: number): void {
  if (getDatabase().get(sql`SELECT id FROM uncollected_products WHERE source_order_id = ${orderId} LIMIT 1`)) {
    throw new AppError(
      'CONFLICT',
      'لا يمكن استعادة مواد تصنيع منتج له سجل في المنتجات غير المستلمة'
    )
  }
}

/** Undo ONLY this customer Manufacturing Order; later modules must be undone explicitly. */
/** Owned pre-start reversal; these row mutations are deliberately not exported. */
function reverseWorkSheetResources(assignments: Array<{ id: number }>, machines: Array<{ id: number }>, ctx: ServiceContext): void {
  const db = getDatabase()
  for (const assignment of assignments) {
    const row = db.select().from(orderWorkerAssignments).where(eq(orderWorkerAssignments.id, assignment.id)).get()
    if (!row || row.reversedAt || row.earned)
      throw new AppError('CONFLICT', 'يجب عكس استحقاق الإكمال قبل التراجع عن تعيين العامل')
    db.update(orderWorkerAssignments).set({ reversedAt: nowIso(), reversedBy: ctx.session.user.id })
      .where(eq(orderWorkerAssignments.id, row.id)).run()
    recordAuditEvent({ userId: ctx.session.user.id, action: 'orders.worker.assignment.reverse',
      entity: 'order_worker_assignments', entityId: String(row.id), details: row })
  }
  for (const machine of machines) {
    const row = db.select().from(orderMachineUsage).where(eq(orderMachineUsage.id, machine.id)).get()
    if (!row || row.reversedAt) throw new AppError('CONFLICT', 'تم التراجع عن استخدام الآلة بالفعل')
    db.update(orderMachineUsage).set({ reversedAt: nowIso(), reversedBy: ctx.session.user.id })
      .where(eq(orderMachineUsage.id, row.id)).run()
    recordAuditEvent({ userId: ctx.session.user.id, action: 'orders.machine.reverse',
      entity: 'order_machine_usage', entityId: String(row.id), details: row })
  }
}

export function reverseWorkSheet(input: { id: number; expectedToken: string; confirmation: string; reason: string }, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.worksheets.reverse)
  withTransaction(() => {
    const sheet = getWorkSheetOrThrow(input.id)
    if (!sheet.orderId || sheet.productId) throw new AppError('CONFLICT', 'هذا التراجع مخصص لتصنيع طلب عميل؛ إنتاج المخزون الجاهز له قواعد مستقلة')
    const sourceOrder = getOrderOrThrow(sheet.orderId)
    if (sourceOrder.archivedAt) throw new AppError('CONFLICT', 'لا يمكن التراجع عن أمر تصنيع تابع لطلب مؤرشف')
    const order = assertOrderOperational(sheet.orderId)
    assertNoUncollectedOutput(sheet.orderId)
    if (sheet.status === 'reversed') throw new AppError('CONFLICT', 'تم التراجع عن أمر التصنيع بالفعل')
    if (manufacturingStarted(sheet)) throw new AppError('CONFLICT', MANUFACTURING_STARTED_REVERSAL_MESSAGE)
    const db = getDatabase()
    if (db.get(sql`SELECT id FROM deliveries WHERE order_id = ${sheet.orderId} AND status = 'recorded' LIMIT 1`)) throw new AppError('CONFLICT', 'لا يمكن التراجع عن أمر التصنيع قبل التراجع عن عملية التسليم والتركيب المرتبطة')
    if (db.get(sql`SELECT id FROM releases WHERE order_id = ${sheet.orderId} AND status = 'active' LIMIT 1`)) throw new AppError('CONFLICT', 'لا يمكن التراجع عن أمر التصنيع قبل التراجع عن إذن الخروج المرتبط')
    if (order.completedAt || order.status === 'completed') throw new AppError('CONFLICT', 'تراجع عن إكمال الطلب أولاً من صفحة الطلب')
    if (db.get(sql`SELECT id FROM finished_goods_movements WHERE work_sheet_id = ${input.id} LIMIT 1`)) throw new AppError('CONFLICT', 'توجد حركة مخزون جاهز مرتبطة؛ لا يمكن عكسها من تصنيع طلب العميل')
    if (workSheetReversalToken(input.id) !== input.expectedToken) throw new AppError('CONFLICT', 'تغير أمر التصنيع أو آثاره منذ المعاينة. حدّث الصفحة ثم أكّد مجدداً')
    if (input.confirmation.trim() !== sheet.documentNumber || !input.reason.trim()) throw new AppError('VALIDATION_ERROR', 'اكتب رقم أمر التصنيع وسبب التراجع للتأكيد')
    const materials = db.select().from(orderMaterialLines).where(and(eq(orderMaterialLines.workSheetId, input.id), eq(orderMaterialLines.status, 'active'))).all()
    const machines = db.select().from(orderMachineUsage).where(and(eq(orderMachineUsage.workSheetId, input.id), sql`${orderMachineUsage.reversedAt} IS NULL`)).all()
    const assignments = db.select().from(orderWorkerAssignments).where(and(eq(orderWorkerAssignments.workSheetId, input.id), sql`${orderWorkerAssignments.reversedAt} IS NULL`)).all()
    if ([...materials, ...machines, ...assignments].some((row) => row.orderId !== sheet.orderId)) throw new AppError('CONFLICT', 'توجد آثار قديمة بلا رابط طلب موثوق. يلزم فحص الروابط قبل التراجع')
    if (db.get(sql`SELECT t.id FROM inventory_movements t WHERE t.order_id = ${sheet.orderId} AND t.kind = 'consumption'
      AND NOT EXISTS(SELECT 1 FROM inventory_movements r WHERE r.reversal_of_movement_id = t.id)
      AND (SELECT COUNT(*) FROM order_material_lines l WHERE l.movement_id = t.id AND l.status = 'active' AND l.order_id = ${sheet.orderId}) != 1 LIMIT 1`)) throw new AppError('CONFLICT', 'توجد حركة صرف قديمة بلا رابط مادة موثوق؛ لا يمكن التراجع قبل فحص الروابط')
    // Canonical material reversal refuses active returns and incomplete valuation links.
    for (const line of materials) assertConsumptionCorrectionSafe(line)
    const beforeCostMinor = productionActualCostMinor(input.id)
    const documentSnapshot = JSON.stringify(buildWorkSheet(input.id, ctx))
    reverseWorkSheetResources(assignments, machines, ctx)
    for (const line of [...materials].reverse()) reverseMaterialConsumptionAuthorized({ id: line.id, reason: input.reason }, ctx)
    const reversedAt = nowIso()
    const changed = db.update(workSheets).set({ status: 'reversed', reversedAt, reversedBy: ctx.session.user.id, documentSnapshot })
      .where(and(eq(workSheets.id, input.id), sql`${workSheets.status} != 'reversed'`)).run().changes
    if (changed !== 1) throw new AppError('CONFLICT', 'تم التراجع عن أمر التصنيع بالفعل')
    recordAuditEvent({ userId: ctx.session.user.id, action: 'worksheets.reverse', entity: 'work_sheets', entityId: String(input.id), details: {
      orderId: sheet.orderId, documentNumber: sheet.documentNumber, beforeStatus: sheet.status, afterStatus: 'reversed',
      materialLineIds: materials.map((m) => m.id), movementIds: materials.map((m) => m.movementId),
      machineUsageIds: machines.map((m) => m.id), assignmentIds: assignments.map((a) => a.id),
      beforeCostMinor, afterCostMinor: productionActualCostMinor(input.id), reason: input.reason, reversedAt
    } })
  })
}

/** The production order's own actual cost: material + machine + labour. */
export function productionActualCostMinor(workSheetId: number): number {
  const db = getDatabase()
  const material =
    db.get<{ total: number }>(
      sql`SELECT COALESCE(SUM(actual_cost_minor), 0) AS total FROM order_material_lines WHERE work_sheet_id = ${workSheetId} AND status = 'active'`
    )?.total ?? 0
  const machine =
    db.get<{ total: number }>(
      sql`SELECT COALESCE(SUM(final_amount_minor), 0) AS total FROM order_machine_usage WHERE work_sheet_id = ${workSheetId} AND reversed_at IS NULL`
    )?.total ?? 0
  const labour =
    db.get<{ total: number }>(
      sql`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM order_worker_assignments WHERE work_sheet_id = ${workSheetId} AND reversed_at IS NULL`
    )?.total ?? 0
  return material - activeReturnCostForWorkSheet(workSheetId) + machine + labour
}

/** Full internal production-order view (item 11). */
export function getProductionOrder(id: number) {
  const sheet = getWorkSheetOrThrow(id)
  const order = sheet.orderId ? getDatabase().select().from(orders).where(eq(orders.id, sheet.orderId)).get() : undefined
  const customer = order
    ? getDatabase().select().from(customers).where(eq(customers.id, order.customerId)).get()
    : undefined
  const product = sheet.productId
    ? getDatabase().select().from(products).where(eq(products.id, sheet.productId)).get()
    : undefined

  return {
    sheet: { ...sheet, statusLabel: STATUS_LABEL[sheet.status as ProductionStatus] ?? sheet.status },
    historicalLines: sheet.status === 'reversed' && sheet.documentSnapshot ? (JSON.parse(sheet.documentSnapshot) as { sourceLines?: Array<{ id: number; description: string; quantityMicro: number; dimensions: string | null; colorCode: string | null; accessories: string | null; specifications: string | null }> }).sourceLines : undefined,
    reversalToken: workSheetReversalToken(id),
    order: order ?? null,
    customerName: customer?.name ?? null,
    product: product ?? null,
    plannedMaterials: listPlannedMaterials({ workSheetId: id }),
    // CC04B: the resources authored in تجهيز الإنتاج (the order's, or a stock order's own snapshot).
    preparedWorkers: listPlannedWorkers(sheet.orderId ? { orderId: sheet.orderId } : { workSheetId: id }),
    preparedMachines: listPlannedMachines(sheet.orderId ? { orderId: sheet.orderId } : { workSheetId: id }),
    workers: workSheetWorkersFor(id),
    materialLines: materialLinesForWorkSheet(id),
    machineUsage: getDatabase()
      .select()
      .from(orderMachineUsage)
      .where(and(eq(orderMachineUsage.workSheetId, id), sql`${orderMachineUsage.reversedAt} IS NULL`))
      .all(),
    assignments: getDatabase()
      .select()
      .from(orderWorkerAssignments)
      .where(and(eq(orderWorkerAssignments.workSheetId, id), sql`${orderWorkerAssignments.reversedAt} IS NULL`))
      .all(),
    actualCostMinor: productionActualCostMinor(id)
  }
}

const workSheetListColumns = {
  id: workSheets.id,
  documentNumber: workSheets.documentNumber,
  orderId: workSheets.orderId,
  orderNumber: orders.documentNumber,
  orderArchivedAt: orders.archivedAt,
  productId: workSheets.productId,
  productName: products.name,
  quantityMicro: workSheets.quantityMicro,
  status: workSheets.status,
  issuedAt: workSheets.issuedAt,
  startedAt: workSheets.startedAt,
  completedAt: workSheets.completedAt,
  notes: workSheets.notes
}

function fetchWorkSheetPage(where: SQL | undefined, window: KeysetWindow) {
  return getDatabase()
    .select(workSheetListColumns)
    .from(workSheets)
    // LEFT joins: a stock production order has no customer order, and a
    // customer production order has no product.
    .leftJoin(orders, eq(workSheets.orderId, orders.id))
    .leftJoin(products, eq(workSheets.productId, products.id))
    .where(and(where, keysetBoundary([sql`${workSheets.id}`], window)))
    .orderBy(keysetOrder([sql`${workSheets.id}`], window))
    .limit(window.take)
    .all()
    .map((row) => ({
      ...row,
      statusLabel: STATUS_LABEL[row.status as ProductionStatus] ?? row.status
    }))
}

/** Bounded Manufacturing Order history, newest first (id is the unique seek key). */
export function listWorkSheets(
  filter: { orderId?: number; status?: string; search?: string; includeReversed?: boolean } = {},
  request: PageRequest = {}
) {
  const normalized = { orderId: filter.orderId, status: filter.status, includeReversed: filter.includeReversed || undefined, search: normalizedSearch(filter.search) }
  const clauses = []
  if (!normalized.includeReversed && normalized.status !== 'reversed') clauses.push(sql`${workSheets.status} != 'reversed'`)
  if (normalized.orderId) clauses.push(eq(workSheets.orderId, normalized.orderId))
  if (normalized.status) clauses.push(eq(workSheets.status, normalized.status))
  if (normalized.search) clauses.push(sql`${workSheets.documentNumber} LIKE ${'%' + normalized.search + '%'}`)
  const where = clauses.length ? and(...clauses) : undefined
  return keysetPage({
    scope: 'production.listWorkSheets',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => fetchWorkSheetPage(where, window),
    summary: () => undefined
  })
}

/**
 * The normal Manufacturing Orders page is an operational work list.
 *
 * A completed customer worksheet leaves that list only after every
 * current physical order line has a committed Uncollected Product that
 * points back to both this exact worksheet and this exact order line.
 * Partial/legacy transfers therefore remain visible. The historical
 * order-scoped list above deliberately remains unchanged.
 */
export function listOperationalWorkSheets(
  filter: { status?: string; search?: string } = {},
  request: PageRequest = {}
) {
  const normalized = { status: filter.status, search: normalizedSearch(filter.search) }
  const clauses = [
    sql`${workSheets.status} != 'reversed'`,
    sql`NOT (
      ${workSheets.status} = 'completed'
      AND ${workSheets.orderId} IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM order_lines eligible_line
        WHERE eligible_line.order_id = ${workSheets.orderId}
          AND eligible_line.superseded_at IS NULL
          AND eligible_line.line_kind = 'custom'
          AND eligible_line.uncollected_product_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM order_lines eligible_line
        WHERE eligible_line.order_id = ${workSheets.orderId}
          AND eligible_line.superseded_at IS NULL
          AND eligible_line.line_kind = 'custom'
          AND eligible_line.uncollected_product_id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM uncollected_products transferred_output
            WHERE transferred_output.source_work_sheet_id = ${workSheets.id}
              AND transferred_output.source_order_id = ${workSheets.orderId}
              AND transferred_output.source_order_line_id = eligible_line.id
              AND transferred_output.status != 'resumed'
          )
      )
    )`
  ]
  if (normalized.status) clauses.push(eq(workSheets.status, normalized.status))
  if (normalized.search) clauses.push(sql`${workSheets.documentNumber} LIKE ${'%' + normalized.search + '%'}`)
  const where = and(...clauses)
  return keysetPage({
    scope: 'production.listOperationalWorkSheets',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    defaultLimit: 25,
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => fetchWorkSheetPage(where, window),
    summary: () => ({
      totalCount: getDatabase()
        .select({ count: sql<number>`COUNT(*)` })
        .from(workSheets)
        .where(where)
        .get()?.count ?? 0
    })
  })
}

/** The production order currently open for an order, if any. */
export function openWorkSheetForOrder(orderId: number) {
  return getDatabase()
    .select()
    .from(workSheets)
    .where(
      and(
        eq(workSheets.orderId, orderId),
        sql`${workSheets.status} IN ('draft', 'ready', 'in_production')`
      )
    )
    .orderBy(desc(workSheets.id))
    .get()
}

/** True when this order has at least one COMPLETED production order. */
export function hasCompletedProduction(orderId: number): boolean {
  const row = getDatabase().get<{ c: number }>(
    sql`SELECT COUNT(*) AS c FROM work_sheets WHERE order_id = ${orderId} AND status = 'completed'`
  )
  return (row?.c ?? 0) > 0
}

/** True when this order ever had a production order issued at all. */
export function hasAnyProduction(orderId: number): boolean {
  const row = getDatabase().get<{ c: number }>(
    sql`SELECT COUNT(*) AS c FROM work_sheets WHERE order_id = ${orderId} AND status != 'reversed'`
  )
  return (row?.c ?? 0) > 0
}

export function workSheetWorkersFor(workSheetId: number) {
  return getDatabase()
    .select({ workerId: workers.id, name: workers.name })
    .from(workSheetWorkers)
    .innerJoin(workers, eq(workSheetWorkers.workerId, workers.id))
    .where(eq(workSheetWorkers.workSheetId, workSheetId))
    .all()
}

/** Exit Permit issuance commits Standard FG; unpaid balances remain receivable. */
export function issueRelease(
  input: {
    orderId: number
    kind: IssuableExitPermitKind
    workerIds?: number[]
    notes?: string
    showPaidExitSentence?: boolean
    unpaidReleaseOverride?: boolean
  },
  ctx: ServiceContext
): { id: number; documentNumber: string } {
  requirePermission(ctx.session, P.releases.issue)
  return withTransaction(() => {
    // Re-read inside the issuance transaction. These persisted totals,
    // not renderer input, decide both the gate and the frozen snapshot.
    const order = assertOrderOperational(input.orderId)
    assertResumedOrderFulfilmentReady(input.orderId)
    if (order.status === 'cancelled')
      throw new AppError('CONFLICT', 'لا يمكن إصدار إذن خروج لطلب ملغى')
    if (order.status !== 'confirmed' || order.completedAt)
      throw new AppError('CONFLICT', 'لا يمكن إصدار إذن خروج لطلب غير مؤكد أو مكتمل')
    const existingRelease = getDatabase()
      .select({ documentNumber: releases.documentNumber })
      .from(releases)
      .where(and(eq(releases.orderId, input.orderId), eq(releases.status, 'active')))
      .get()
    if (existingRelease) {
      throw new AppError('CONFLICT', `صدر إذن خروج لهذا الطلب بالفعل (${existingRelease.documentNumber})`)
    }
    // Item 22 is unchanged: payment override never overrides production.
    if (hasAnyProduction(input.orderId) && !hasCompletedProduction(input.orderId)) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن إصدار إذن الخروج قبل إكمال أمر التصنيع الخاص بالطلب'
      )
    }

    // Freeze the authoritative receipt position without gating fulfillment.
    const { paidMinor } = authoritativeOrderPaymentPosition(input.orderId)
    const fullyPaid = paidMinor >= order.totalMinor
    const remainingMinor = Math.max(order.totalMinor - paidMinor, 0)
    const authorizationType = fullyPaid ? 'fully_paid' : 'unpaid'

    const prefix = input.kind === 'installation'
      ? 'IA'
      : input.kind === 'transport'
        ? 'TR'
        : input.kind === 'delivery_installation'
          ? 'DI'
          : 'DR'
    const documentNumber = nextDocumentNumber(prefix)
    const authorizedAt = nowIso()
    const id = Number(
      getDatabase()
        .insert(releases)
        .values({
          documentNumber,
          orderId: input.orderId,
          kind: input.kind,
          authorizedAt,
          address: order.address,
          notes: input.notes ?? null,
          showPaidExitSentence: input.showPaidExitSentence ?? true,
          authorizationType,
          orderTotalMinorAtIssue: order.totalMinor,
          paidMinorAtIssue: paidMinor,
          remainingMinorAtIssue: remainingMinor,
          unpaidOverrideReason: null,
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    // Persist the owning permit before issuing stock; both roll back together.
    supplyStandardLinesFromStock(input.orderId, ctx)
    for (const workerId of input.workerIds ?? []) {
      getDatabase().insert(releaseWorkers).values({ releaseId: id, workerId }).run()
    }
    getDatabase().update(releases).set({ documentSnapshot: JSON.stringify(buildRelease(id)) }).where(eq(releases.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'releases.issue',
      entity: 'releases',
      entityId: String(id),
      details: {
        documentNumber,
        releaseId: id,
        kind: input.kind,
        orderId: input.orderId,
        authorizationType,
        authorizedByUserId: ctx.session.user.id,
        authorizedAt,
        orderTotalMinor: order.totalMinor,
        paidMinor,
        remainingMinor,
        unpaidOverrideReason: null,
        showPaidExitSentence: input.showPaidExitSentence ?? true
      }
    })
    return { id, documentNumber }
  })
}

/** SQL mirror of the shared permit → completion resolver, generated from it. */
function permitCompletionKindSql(kindColumn: SQL, resolver: (kind: ExitPermitKind) => CompletionKind | null): SQL {
  const permitKinds: ExitPermitKind[] = ['handover', ...EXIT_PERMIT_KINDS]
  return sql`CASE ${kindColumn} ${sql.join(
    permitKinds.map((kind) => sql`WHEN ${kind} THEN ${resolver(kind)}`),
    sql` `
  )} ELSE NULL END`
}

/** True when the permit's single completion event is already recorded. */
function releaseCompletionRecordedSql(): SQL {
  const completion = permitCompletionKindSql(sql`r.kind`, completionKindForPermit)
  const legacy = permitCompletionKindSql(sql`r.kind`, legacyUnlinkedCompletionKindForPermit)
  return sql`CASE WHEN ${completion} IS NULL THEN 0 ELSE EXISTS (
    SELECT 1 FROM deliveries d
    WHERE d.status = 'recorded'
      AND (
        d.release_id = r.id
        OR (d.release_id IS NULL AND d.order_id = r.order_id AND (d.kind = ${completion} OR d.kind = ${legacy}))
      )
  ) END`
}

/**
 * Set-based enrichment for one bounded permit page: worker teams, completion
 * state and optimistic reversal tokens are read with a fixed number of
 * queries regardless of page size.
 */
function enrichReleasePage<T extends { id: number; kind: string; orderId: number }>(rows: T[]) {
  if (!rows.length) return []
  const db = getDatabase()
  const ids = idList(rows.map((row) => row.id))
  const teams = new Map<number, Array<{ workerId: number; name: string }>>()
  for (const member of db.all<{ releaseId: number; workerId: number; name: string }>(sql`
    SELECT rw.release_id AS releaseId, w.id AS workerId, w.name
    FROM release_workers rw
    INNER JOIN workers w ON w.id = rw.worker_id
    WHERE rw.release_id IN (${ids})
    ORDER BY rw.release_id, rw.worker_id
  `)) {
    const team = teams.get(member.releaseId) ?? []
    team.push({ workerId: member.workerId, name: member.name })
    teams.set(member.releaseId, team)
  }
  const recorded = new Set(
    db.all<{ id: number }>(sql`
      SELECT r.id FROM releases r WHERE r.id IN (${ids}) AND ${releaseCompletionRecordedSql()} = 1
    `).map((row) => row.id)
  )
  const permits = new Map(
    db.select().from(releases).where(inArray(releases.id, rows.map((row) => row.id))).all()
      .map((permit) => [permit.id, permit])
  )
  const permitDeliveries = new Map<number, Array<{ id: number; status: string }>>()
  for (const delivery of db.all<{ releaseId: number; id: number; status: string }>(sql`
    SELECT release_id AS releaseId, id, status FROM deliveries WHERE release_id IN (${ids}) ORDER BY release_id, id
  `)) {
    const list = permitDeliveries.get(delivery.releaseId) ?? []
    list.push({ id: delivery.id, status: delivery.status })
    permitDeliveries.set(delivery.releaseId, list)
  }
  return rows.map((row) => {
    const completionKind = isExitPermitKind(row.kind) ? completionKindForPermit(row.kind) : null
    return {
      ...row,
      // Same serialized state as releaseReversalToken(id) so reversal checks agree.
      reversalToken: stateToken({ permit: permits.get(row.id), deliveries: permitDeliveries.get(row.id) ?? [] }),
      workers: teams.get(row.id) ?? [],
      completionKind,
      completionRecorded: completionKind ? recorded.has(row.id) : false
    }
  })
}

export interface ReleaseListFilter {
  orderId?: number
  kind?: string
  search?: string
  includeReversed?: boolean
  /** Active permits on operational orders whose completion is not recorded yet. */
  awaitingCompletion?: boolean
}

export function listReleases(filter: ReleaseListFilter = {}, request: PageRequest = {}) {
  const normalized = {
    orderId: filter.orderId,
    kind: filter.kind,
    includeReversed: filter.includeReversed || undefined,
    awaitingCompletion: filter.awaitingCompletion || undefined,
    search: normalizedSearch(filter.search)
  }
  const clauses = []
  if (!normalized.includeReversed || normalized.awaitingCompletion) clauses.push(eq(releases.status, 'active'))
  if (normalized.orderId) clauses.push(eq(releases.orderId, normalized.orderId))
  if (normalized.kind) clauses.push(eq(releases.kind, normalized.kind))
  if (normalized.search) clauses.push(sql`${releases.documentNumber} LIKE ${'%' + normalized.search + '%'}`)
  if (normalized.awaitingCompletion) {
    clauses.push(sql`${orders.archivedAt} IS NULL AND ${orders.status} NOT IN ('cancelled', 'awaiting_approval')`)
    clauses.push(sql`NOT EXISTS (
      SELECT 1 FROM releases r WHERE r.id = ${releases.id} AND ${releaseCompletionRecordedSql()} = 1
    )`)
  }
  const where = clauses.length ? and(...clauses) : undefined
  return keysetPage({
    scope: 'production.listReleases',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => enrichReleasePage(
      getDatabase()
        .select({
          id: releases.id,
          documentNumber: releases.documentNumber,
          orderId: releases.orderId,
          orderNumber: orders.documentNumber,
          kind: releases.kind,
          authorizedAt: releases.authorizedAt,
          status: releases.status,
          orderStatus: orders.status,
          orderArchivedAt: orders.archivedAt,
          address: releases.address,
          notes: releases.notes,
          showPaidExitSentence: releases.showPaidExitSentence,
          authorizationType: releases.authorizationType,
          orderTotalMinorAtIssue: releases.orderTotalMinorAtIssue,
          paidMinorAtIssue: releases.paidMinorAtIssue,
          remainingMinorAtIssue: releases.remainingMinorAtIssue,
          unpaidOverrideReason: releases.unpaidOverrideReason,
          createdBy: releases.createdBy
        })
        .from(releases)
        .innerJoin(orders, eq(releases.orderId, orders.id))
        .where(and(where, keysetBoundary([sql`${releases.id}`], window)))
        .orderBy(keysetOrder([sql`${releases.id}`], window))
        .limit(window.take)
        .all()
    ),
    summary: () => undefined
  })
}

export function releaseWorkersFor(releaseId: number) {
  return getDatabase()
    .select({ workerId: workers.id, name: workers.name })
    .from(releaseWorkers)
    .innerJoin(workers, eq(releaseWorkers.workerId, workers.id))
    .where(eq(releaseWorkers.releaseId, releaseId))
    .all()
}

/**
 * BR-60/BR-106: the single completion operation authorized by an Exit
 * Permit completes the order for profit-recognition purposes and carries
 * its own actual cost, kept separate from anything charged to the customer.
 */
export function recordDelivery(
  input: {
    orderId: number
    kind: CompletionKind
    releaseId?: number
    workerIds?: number[]
    recordedAt?: string
    scheduledAt?: string
    address?: string
    actualCostMinor?: number
    notes?: string
  },
  ctx: ServiceContext
): { id: number; completedAt: string } {
  requirePermission(ctx.session, P.deliveries.register)
  return withTransaction(() => {
    // Re-read every prerequisite and the existing fulfilment events in
    // the transaction. A retry or concurrent click can never post the
    // same one-time delivery/installation step twice.
    const order = assertOrderOperational(input.orderId)
    assertResumedOrderFulfilmentReady(input.orderId)
    if (order.status === 'cancelled')
      throw new AppError('CONFLICT', 'لا يمكن تسجيل تسليم لطلب ملغى')
    if (hasAnyProduction(input.orderId) && !hasCompletedProduction(input.orderId)) {
      throw new AppError('CONFLICT', 'لا يمكن تسجيل التسليم قبل إكمال أمر التصنيع')
    }
    const permits = getDatabase().select().from(releases).where(and(eq(releases.orderId, input.orderId), eq(releases.status, 'active'))).all()
    if (!permits.length) {
      throw new AppError('CONFLICT', 'لا يمكن تسجيل التسليم قبل إصدار إذن خروج للطلب')
    }
    const permit = input.releaseId
      ? permits.find((candidate) => candidate.id === input.releaseId)
      : permits[0]
    if (!permit) {
      throw new AppError('VALIDATION_ERROR', 'إذن الخروج المحدد لا يخص هذا الطلب')
    }
    if (!isExitPermitKind(permit.kind)) {
      throw new AppError('CONFLICT', 'نوع إذن الخروج التاريخي غير مدعوم لإتمام هذه العملية')
    }
    const requiredKind = completionKindForPermit(permit.kind)
    const legacyCompletionKind = legacyUnlinkedCompletionKindForPermit(permit.kind)
    if (input.kind !== requiredKind) {
      throw new AppError(
        'CONFLICT',
        `${EXIT_PERMIT_LABEL[permit.kind]} يسمح فقط بإجراء «${COMPLETION_ACTION_LABEL[requiredKind]}»`
      )
    }

    const existingCompletion = getDatabase()
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(and(
        eq(deliveries.status, 'recorded'),
        sql`
          ${deliveries.releaseId} = ${permit.id}
          OR (
            ${deliveries.releaseId} IS NULL
            AND ${deliveries.orderId} = ${input.orderId}
            AND (
              ${deliveries.kind} = ${requiredKind}
              OR ${deliveries.kind} = ${legacyCompletionKind}
            )
          )
        `
      ))
      .get()
    if (existingCompletion) {
      throw new AppError('CONFLICT', 'تم تسجيل العملية المعتمدة بهذا الإذن بالفعل')
    }
    requireSafeNonNegativeInteger(input.actualCostMinor ?? 0, 'التكلفة الفعلية')

    const recordedAt = input.recordedAt ?? nowIso()
    const id = Number(
      getDatabase()
        .insert(deliveries)
        .values({
          orderId: input.orderId,
          kind: input.kind,
          releaseId: permit.id,
          scheduledAt: input.scheduledAt ?? null,
          recordedAt,
          address: input.address ?? order.address,
          actualCostMinor: input.actualCostMinor ?? 0,
          status: 'recorded',
          notes: input.notes ?? null,
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    const actualWorkerIds = input.workerIds ?? releaseWorkersFor(permit.id).map((worker) => worker.workerId)
    for (const workerId of new Set(actualWorkerIds)) {
      getDatabase().insert(deliveryWorkers).values({ deliveryId: id, workerId }).run()
    }

    const completedAt = completeOrder({ orderId: input.orderId, deliveryId: id }, ctx).completedAt

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'deliveries.record',
      entity: 'deliveries',
      entityId: String(id),
      details: {
        ...input,
        releaseId: permit.id,
        permitKind: permit.kind,
        requiredCompletionKind: requiredKind,
        actualWorkerIds: [...new Set(actualWorkerIds)],
        completedAt
      }
    })
    return { id, completedAt }
  })
}

/**
 * A posted completion is safely reversed, never physically deleted.
 * The immutable row and creation audit remain, while active completion,
 * order status and actual costing derive only from recorded rows.
 */
export function cancelDelivery(
  input: { id: number; reason?: string },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.deliveries.deleteOrReverse)
  withTransaction(() => {
    // Re-read and conditionally update inside one transaction so a
    // repeated Trash click can never reverse cost/status twice.
    const delivery = getDatabase().select().from(deliveries).where(eq(deliveries.id, input.id)).get()
    if (!delivery) throw notFound('سجل العملية غير موجود')
    assertOrderOperational(delivery.orderId)
    if (delivery.status !== 'recorded') {
      throw new AppError('CONFLICT', 'تم حذف هذه العملية بالفعل')
    }

    const reversedAt = nowIso()
    const reason = input.reason?.trim() || 'حذف العملية من قسم التسليم والتركيب'
    const changed = getDatabase()
      .update(deliveries)
      .set({ status: 'cancelled', cancelledAt: reversedAt, cancelReason: reason })
      .where(and(eq(deliveries.id, input.id), eq(deliveries.status, 'recorded')))
      .run().changes
    if (changed !== 1) throw new AppError('CONFLICT', 'تم حذف هذه العملية بالفعل')

    const remainingCompletion = getDatabase().get<{ found: number }>(sql`
      SELECT 1 AS found
      FROM deliveries
      WHERE order_id = ${delivery.orderId} AND status = 'recorded'
      LIMIT 1
    `)
    let orderReopened = false
    if (!remainingCompletion) {
      const order = getOrderOrThrow(delivery.orderId)
      if (order.status === 'completed' || order.completedAt) {
        reverseWorkerEarnings(delivery.orderId, ctx)
        getDatabase()
          .update(orders)
          .set({ status: 'confirmed', completedAt: null })
          .where(eq(orders.id, delivery.orderId))
          .run()
        orderReopened = true
      }
    }

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'deliveries.reverse',
      entity: 'deliveries',
      entityId: String(input.id),
      details: {
        completionId: delivery.id,
        orderId: delivery.orderId,
        releaseId: delivery.releaseId,
        operationKind: delivery.kind,
        previousActualCostMinor: delivery.actualCostMinor,
        reversedByUserId: ctx.session.user.id,
        reversedAt,
        reason,
        orderReopened
      }
    })
  })
}

export function deliveryWorkersFor(deliveryId: number) {
  return getDatabase()
    .select({ workerId: workers.id, name: workers.name })
    .from(deliveryWorkers)
    .innerJoin(workers, eq(deliveryWorkers.workerId, workers.id))
    .where(eq(deliveryWorkers.deliveryId, deliveryId))
    .all()
}

export function deliveriesForOrder(orderId: number) {
  return getDatabase().select().from(deliveries).where(eq(deliveries.orderId, orderId)).all()
}

/**
 * Item 28: fulfilment state is DERIVED from the delivery events that
 * actually exist, never stored as a flag someone could set by hand.
 * Cancelled events are excluded, so voiding the last one correctly
 * takes the order back to "not delivered".
 */
export type FulfillmentStatus =
  | 'not_delivered'
  | 'delivered'
  | 'installed'
  | 'delivered_installed'
  | 'handed_over'

export function fulfillmentStatus(orderId: number): FulfillmentStatus {
  const events = getDatabase()
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.orderId, orderId), eq(deliveries.status, 'recorded')))
    .all()
  if (!events.length) return 'not_delivered'

  const kinds = new Set(events.map((event) => event.kind))
  const delivered = kinds.has('delivery') || kinds.has('delivery_installation')
  const installed = kinds.has('installation') || kinds.has('delivery_installation')
  if (delivered && installed) return 'delivered_installed'
  if (installed) return 'installed'
  if (delivered) return 'delivered'
  return 'handed_over'
}

export function listDeliveries(
  filter: { from?: string; to?: string; kind?: string; orderId?: number } = {},
  request: PageRequest = {}
) {
  // The normal module is the active operational list. Reversed rows
  // remain in the database and audit history but no longer appear here.
  const normalized = { from: filter.from, to: filter.to, kind: filter.kind, orderId: filter.orderId }
  const clauses = [eq(deliveries.status, 'recorded')]
  if (normalized.kind) clauses.push(eq(deliveries.kind, normalized.kind))
  if (normalized.orderId) clauses.push(eq(deliveries.orderId, normalized.orderId))
  if (normalized.from) clauses.push(sql`${deliveries.recordedAt} >= ${normalized.from}`)
  if (normalized.to) clauses.push(sql`${deliveries.recordedAt} <= ${normalized.to}`)
  const where = and(...clauses)
  return keysetPage({
    scope: 'production.listDeliveries',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => {
      const rows = getDatabase()
        .select({
          id: deliveries.id,
          orderId: deliveries.orderId,
          orderNumber: orders.documentNumber,
          customerName: customers.name,
          kind: deliveries.kind,
          releaseId: deliveries.releaseId,
          releaseNumber: releases.documentNumber,
          scheduledAt: deliveries.scheduledAt,
          recordedAt: deliveries.recordedAt,
          address: deliveries.address,
          actualCostMinor: deliveries.actualCostMinor,
          status: deliveries.status,
          cancelReason: deliveries.cancelReason,
          notes: deliveries.notes
        })
        .from(deliveries)
        .innerJoin(orders, eq(deliveries.orderId, orders.id))
        .innerJoin(customers, eq(orders.customerId, customers.id))
        .leftJoin(releases, eq(deliveries.releaseId, releases.id))
        .where(and(where, keysetBoundary([sql`${deliveries.id}`], window)))
        .orderBy(keysetOrder([sql`${deliveries.id}`], window))
        .limit(window.take)
        .all()
      if (!rows.length) return []
      const teams = new Map<number, string[]>()
      for (const member of getDatabase().all<{ deliveryId: number; name: string }>(sql`
        SELECT dw.delivery_id AS deliveryId, w.name
        FROM delivery_workers dw
        INNER JOIN workers w ON w.id = dw.worker_id
        WHERE dw.delivery_id IN (${idList(rows.map((row) => row.id))})
        ORDER BY dw.delivery_id, dw.worker_id
      `)) {
        const team = teams.get(member.deliveryId) ?? []
        team.push(member.name)
        teams.set(member.deliveryId, team)
      }
      return rows.map((row) => ({ ...row, workers: teams.get(row.id) ?? [] }))
    },
    summary: () => undefined
  })
}

/**
 * BR-11/BR-12: consuming material for an order. The three values —
 * physical quantity, actual FIFO cost, and the commercial quantity
 * and value charged — are stored side by side, never collapsed.
 */
export function consumeForOrder(
  input: {
    /** Item 12: consumption now belongs to a production order. Either
     *  identifier may be given — the other is resolved from it. */
    workSheetId?: number
    orderId?: number
    materialId: number
    physicalQtyMicro: number
    manualCommercialQtyMicro?: number
    overrideCommercialValueMinor?: number
    colorCode?: string
    notes?: string
  },
  ctx: ServiceContext
): { id: number; actualCostMinor: number; commercialValueMinor: number } {
  return consumeForOrderInternal(input, ctx, false)
}

function consumeForOrderInternal(
  input: Parameters<typeof consumeForOrder>[0],
  ctx: ServiceContext,
  atomicStockIssue: boolean
): { id: number; actualCostMinor: number; commercialValueMinor: number } {
  requirePermission(ctx.session, P.inventory.consume)
  // Resolve the production order this consumption belongs to. Passing
  // only an orderId is still accepted (that is what every existing
  // caller does) — it resolves to that order's open production order,
  // and fails loudly if there is none rather than silently consuming
  // stock outside of production.
  let sheet = input.workSheetId ? (atomicStockIssue ? openWorkSheetForPosting(input.workSheetId) : assertProductionOpen(input.workSheetId)) : undefined
  if (!sheet) {
    if (!input.orderId) {
      throw new AppError('VALIDATION_ERROR', 'يجب تحديد أمر التصنيع أو الطلب')
    }
    const open = openWorkSheetForOrder(input.orderId)
    if (!open) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن صرف مواد قبل إصدار أمر تصنيع للطلب. أصدر أمر التصنيع أولاً'
      )
    }
    sheet = assertProductionOpen(open.id)
  }

  const orderId = sheet.orderId ?? input.orderId ?? null
  if (input.orderId && sheet.orderId && sheet.orderId !== input.orderId) {
    throw new AppError('VALIDATION_ERROR', 'أمر التصنيع لا يخص هذا الطلب')
  }
  if (orderId) {
    const order = getOrderOrThrow(orderId)
    if (order.status === 'cancelled' &&
      !(sheet.orderId === orderId && sheet.status === 'in_production' && sheet.startedAt)) {
      throw new AppError('CONFLICT', 'لا يمكن صرف مواد لطلب ملغى')
    }
  }

  // The stock deduction and the order's cost line must land together —
  // stock must never be deducted without the matching BR-12 record.
  // better-sqlite3 nests transactions as savepoints, so the inner
  // transaction inside consumeMaterial joins this one.
  return withTransaction(() => {
    const result = consumeMaterial({
      materialId: input.materialId,
      physicalQtyMicro: input.physicalQtyMicro,
      orderId: orderId ?? undefined,
      workSheetId: sheet!.id,
      manualCommercialQtyMicro: input.manualCommercialQtyMicro,
      overrideCommercialValueMinor: input.overrideCommercialValueMinor,
      ctx
    })

    const id = Number(
      getDatabase()
        .insert(orderMaterialLines)
        .values({
          orderId,
          workSheetId: sheet!.id,
          materialId: input.materialId,
          movementId: result.movementId,
          physicalQtyMicro: result.physicalQtyMicro,
          actualCostMinor: result.actualCostMinor,
          commercialQtyMicro: result.commercialQtyMicro,
          commercialValueMinor: result.commercialValueMinor,
          pricingRuleUsed: result.pricingRuleUsed,
          colorCode: input.colorCode ?? null,
          notes: input.notes ?? null,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.material.consume',
      entity: 'order_material_lines',
      entityId: String(id),
      details: {
        orderId,
        workSheetId: sheet!.id,
        materialId: input.materialId,
        physicalQtyMicro: result.physicalQtyMicro,
        actualCostMinor: result.actualCostMinor,
        commercialValueMinor: result.commercialValueMinor
      }
    })

    return {
      id,
      actualCostMinor: result.actualCostMinor,
      commercialValueMinor: result.commercialValueMinor
    }
  })
}

function materialConsumptionOrThrow(id: number) {
  const line = getDatabase().select().from(orderMaterialLines).where(eq(orderMaterialLines.id, id)).get()
  if (!line) throw notFound('سجل صرف المادة غير موجود')
  return line
}

function assertConsumptionCorrectionSafe(line: typeof orderMaterialLines.$inferSelect): void {
  if (line.status === 'reversed') throw new AppError('CONFLICT', 'تم عكس سجل الصرف بالفعل')
  if (line.orderId) {
    const order = assertOrderOperational(line.orderId)
    if (getDatabase().get(sql`SELECT id FROM work_sheets WHERE order_id = ${line.orderId} AND status = 'completed' LIMIT 1`))
      throw new AppError('CONFLICT', 'لا يمكن تعديل صرف أمر تصنيع مكتمل لأن تكلفة الإنتاج أصبحت تاريخية')
    assertNoUncollectedOutput(line.orderId)
    if (order.completedAt || getDatabase().get(sql`SELECT id FROM releases WHERE order_id = ${line.orderId} AND status = 'active' LIMIT 1`)
      || getDatabase().get(sql`SELECT id FROM deliveries WHERE order_id = ${line.orderId} AND status = 'recorded' LIMIT 1`)) throw new AppError('CONFLICT', 'تراجع عن التسليم والتركيب وإذن الخروج وإكمال الطلب أولاً قبل تصحيح صرف التصنيع')
  }
  if (!line.movementId) {
    throw new AppError('CONFLICT', 'لا يمكن تصحيح هذا السجل القديم لأن رابط حركة المخزون غير مكتمل')
  }
  const linked = getDatabase().get<{ kind: string; orderId: number | null; materialId: number; qtyMicro: number; costMinor: number }>(sql`SELECT kind, order_id AS orderId, material_id AS materialId, qty_micro AS qtyMicro, actual_cost_minor AS costMinor FROM inventory_movements WHERE id = ${line.movementId}`)
  if (!linked || linked.kind !== 'consumption' || linked.orderId !== line.orderId || linked.materialId !== line.materialId || linked.qtyMicro !== line.physicalQtyMicro || linked.costMinor !== line.actualCostMinor) throw new AppError('CONFLICT', 'رابط حركة الصرف لا يطابق سجل المادة؛ لا يمكن استعادة مخزون غير موثوق')
  if ((getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM order_material_lines WHERE movement_id = ${line.movementId}`)?.c ?? 0) !== 1) throw new AppError('CONFLICT', 'حركة الصرف مرتبطة بأكثر من سجل مادة؛ يلزم فحص الروابط التاريخية')
  if (hasActiveReturnsForIssueLine(line.id)) {
    throw new AppError(
      'CONFLICT',
      'لا يمكن عكس أو تصحيح سجل الصرف لوجود مرتجع مادة فعّال مرتبط به. اعكس المرتجع أولاً'
    )
  }
  if (line.workSheetId) {
    const sheet = getWorkSheetOrThrow(line.workSheetId)
    if (!sheet.orderId) throw new AppError('CONFLICT', 'صرف أمر تصنيع المخزون التاريخي للعرض فقط؛ لا يمكن تصحيحه تلقائياً')
    if (sheet.status === 'completed') {
      throw new AppError(
        'CONFLICT',
        'لا يمكن تعديل صرف أمر تصنيع مكتمل لأن تكلفة الإنتاج أصبحت تاريخية'
      )
    }
  }
}

function reverseMaterialConsumptionInternal(
  line: typeof orderMaterialLines.$inferSelect,
  reason: string,
  ctx: ServiceContext
): number {
  assertConsumptionCorrectionSafe(line)
  const reversed = reverseConsumptionMovement({
    movementId: line.movementId!,
    sourceRefId: line.id,
    reason,
    ctx
  })
  getDatabase()
    .update(orderMaterialLines)
    .set({
      status: 'reversed',
      reversedAt: nowIso(),
      reversedBy: ctx.session.user.id,
      reversalMovementId: reversed.reversalMovementId
    })
    .where(eq(orderMaterialLines.id, line.id))
    .run()
  return reversed.reversalMovementId
}

export function reverseMaterialConsumption(
  input: { id: number; reason: string },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.inventory.consume)
  reverseMaterialConsumptionAuthorized(input, ctx)
}

function reverseMaterialConsumptionAuthorized(
  input: { id: number; reason: string },
  ctx: ServiceContext
): void {
  const line = materialConsumptionOrThrow(input.id)
  if (!input.reason.trim()) throw new AppError('VALIDATION_ERROR', 'سبب عكس الصرف مطلوب')
  withTransaction(() => {
    const reversalMovementId = reverseMaterialConsumptionInternal(line, input.reason, ctx)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.material.reverse',
      entity: 'order_material_lines',
      entityId: String(line.id),
      details: {
        orderId: line.orderId,
        workSheetId: line.workSheetId,
        materialId: line.materialId,
        physicalQtyMicro: line.physicalQtyMicro,
        actualCostMinor: line.actualCostMinor,
        reversalMovementId,
        reason: input.reason,
        actualProductionCostMinor: line.workSheetId
          ? productionActualCostMinor(line.workSheetId)
          : null
      }
    })
  })
}

export function correctMaterialConsumption(
  input: {
    id: number
    materialId: number
    physicalQtyMicro: number
    manualCommercialQtyMicro?: number
    overrideCommercialValueMinor?: number
    colorCode?: string | null
    notes?: string | null
    reason: string
  },
  ctx: ServiceContext
): { id: number; actualCostMinor: number; commercialValueMinor: number } {
  requirePermission(ctx.session, P.inventory.consume)
  const original = materialConsumptionOrThrow(input.id)
  requireSafePositiveInteger(input.physicalQtyMicro, 'الكمية')
  if (!input.reason.trim()) throw new AppError('VALIDATION_ERROR', 'سبب التصحيح مطلوب')

  return withTransaction(() => {
    const reversalMovementId = reverseMaterialConsumptionInternal(original, input.reason, ctx)
    const result = consumeMaterial({
      materialId: input.materialId,
      physicalQtyMicro: input.physicalQtyMicro,
      orderId: original.orderId ?? undefined,
      workSheetId: original.workSheetId ?? undefined,
      manualCommercialQtyMicro: input.manualCommercialQtyMicro,
      overrideCommercialValueMinor: input.overrideCommercialValueMinor,
      reason: `تصحيح لسجل الصرف #${original.id}`,
      ctx
    })
    const replacementId = Number(
      getDatabase()
        .insert(orderMaterialLines)
        .values({
          orderId: original.orderId,
          workSheetId: original.workSheetId,
          materialId: input.materialId,
          movementId: result.movementId,
          physicalQtyMicro: result.physicalQtyMicro,
          actualCostMinor: result.actualCostMinor,
          commercialQtyMicro: result.commercialQtyMicro,
          commercialValueMinor: result.commercialValueMinor,
          pricingRuleUsed: result.pricingRuleUsed,
          colorCode: input.colorCode ?? null,
          notes: input.notes ?? null,
          correctionOfLineId: original.id,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    getDatabase()
      .update(orderMaterialLines)
      .set({ replacementLineId: replacementId })
      .where(eq(orderMaterialLines.id, original.id))
      .run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.material.correct',
      entity: 'order_material_lines',
      entityId: String(original.id),
      details: {
        replacementLineId: replacementId,
        reversalMovementId,
        from: {
          materialId: original.materialId,
          physicalQtyMicro: original.physicalQtyMicro,
          actualCostMinor: original.actualCostMinor
        },
        to: {
          materialId: input.materialId,
          physicalQtyMicro: result.physicalQtyMicro,
          actualCostMinor: result.actualCostMinor
        },
        reason: input.reason,
        actualProductionCostMinor: original.workSheetId
          ? productionActualCostMinor(original.workSheetId)
          : null
      }
    })
    return {
      id: replacementId,
      actualCostMinor: result.actualCostMinor,
      commercialValueMinor: result.commercialValueMinor
    }
  })
}

/** The same shape as materialLinesForOrder, keyed by production order. */
export function materialLinesForWorkSheet(workSheetId: number) {
  const rows = getDatabase()
    .select({
      id: orderMaterialLines.id,
      materialId: orderMaterialLines.materialId,
      materialName: materials.name,
      materialSku: materials.sku,
      unit: materials.unit,
      physicalQtyMicro: orderMaterialLines.physicalQtyMicro,
      actualCostMinor: orderMaterialLines.actualCostMinor,
      commercialQtyMicro: orderMaterialLines.commercialQtyMicro,
      commercialValueMinor: orderMaterialLines.commercialValueMinor,
      pricingRuleUsed: orderMaterialLines.pricingRuleUsed,
      colorCode: orderMaterialLines.colorCode,
      notes: orderMaterialLines.notes,
      status: orderMaterialLines.status,
      reversalMovementId: orderMaterialLines.reversalMovementId,
      replacementLineId: orderMaterialLines.replacementLineId
    })
    .from(orderMaterialLines)
    .innerJoin(materials, eq(orderMaterialLines.materialId, materials.id))
    .where(eq(orderMaterialLines.workSheetId, workSheetId))
    .all()
  return rows.map((row) => {
    const returned = returnTotalsForIssueLine(row.id)
    return {
      ...row,
      returnedQtyMicro: returned.qtyMicro,
      returnedCostMinor: returned.costMinor,
      netConsumedQtyMicro: row.physicalQtyMicro - returned.qtyMicro,
      netCostMinor: row.actualCostMinor - returned.costMinor
    }
  })
}

export function materialLinesForOrder(orderId: number) {
  const rows = getDatabase()
    .select({
      id: orderMaterialLines.id,
      materialId: orderMaterialLines.materialId,
      materialName: materials.name,
      materialSku: materials.sku,
      unit: materials.unit,
      physicalQtyMicro: orderMaterialLines.physicalQtyMicro,
      actualCostMinor: orderMaterialLines.actualCostMinor,
      commercialQtyMicro: orderMaterialLines.commercialQtyMicro,
      commercialValueMinor: orderMaterialLines.commercialValueMinor,
      pricingRuleUsed: orderMaterialLines.pricingRuleUsed,
      colorCode: orderMaterialLines.colorCode,
      notes: orderMaterialLines.notes
    })
    .from(orderMaterialLines)
    .innerJoin(materials, eq(orderMaterialLines.materialId, materials.id))
    .where(and(eq(orderMaterialLines.orderId, orderId), eq(orderMaterialLines.status, 'active')))
    .all()
  return rows.map((row) => {
    const returned = returnTotalsForIssueLine(row.id)
    return {
      ...row,
      returnedQtyMicro: returned.qtyMicro,
      returnedCostMinor: returned.costMinor,
      netConsumedQtyMicro: row.physicalQtyMicro - returned.qtyMicro,
      netCostMinor: row.actualCostMinor - returned.costMinor
    }
  })
}
