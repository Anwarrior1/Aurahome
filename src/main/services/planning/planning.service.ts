import { requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { asc, eq, sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import {
  plannedMaterials,
  plannedMachines,
  plannedWorkers,
  plannedOrderExpenses
} from '../../db/schema/production.schema'
import { quotations, orders, orderLines } from '../../db/schema/sales.schema'
import { colorFinishCatalog, materials } from '../../db/schema/catalog.schema'
import { machines, workers } from '../../db/schema/production.schema'
import { AppError, notFound } from '../../utils/errors'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, type ServiceContext } from '../base/service.types'
import { costOf, unitCostMicro } from '@shared/money/cost'
import { requireSafeNonNegativeInteger, requireSafePositiveInteger } from '../../utils/numeric'
import { isManufacturableOrderLine } from '../sales/order-line-manufacturing'
import { PRODUCTION_PREP_LOCKED_MESSAGE } from '@shared/production/manufacturing-lifecycle'

/**
 * PLANNING — the internal costing estimate on a preliminary invoice, and
 * the planned material requirement that flows from it to the production
 * order.
 *
 * Two rules shape everything here:
 *
 *  1. Planned ≠ actual. Nothing in this file touches stock, FIFO or the
 *     payment ledger. Actual consumption stays in order_material_lines.
 *
 *  2. Each step FREEZES its own copy. Quotation lines are copied to the
 *     order at conversion and to the production order at issuance, so
 *     the factory can adjust 12 boards to 13 without the approved
 *     preliminary invoice ever changing.
 */

export type PlannedScope = { quotationId?: number; orderId?: number; workSheetId?: number }

export interface PlannedMaterialInput {
  /** Existing row identity, used only to preserve an orphaned historical
   *  color-code snapshot during replace-all saves. */
  id?: number
  materialId?: number | null
  materialName: string
  qtyMicro: number
  unit?: string | null
  dimensions?: string | null
  thickness?: string | null
  colorCode?: string | null
  notes?: string | null
  estimatedUnitCostMicro?: number
}

export interface PlannedMachineInput {
  /** Existing row identity. It lets the service retain a frozen rate, or
   *  preserve a legacy manual total when no rate snapshot exists. */
  id?: number
  machineId?: number | null
  machineName: string
  usageQtyMicro?: number
  usageUnit?: string | null
  /** Accepted only for migration-era callers; never trusted for an
   *  automatic line selected from the machine register. */
  estimatedCostMinor?: number
  notes?: string | null
}

export interface PlannedWorkerInput {
  workerId?: number | null
  workerName: string
  commissionMode?: 'estimated' | 'meter'
  /** Used only by estimated mode. Ignored for meter mode. */
  estimatedCostMinor?: number
  /** LYD × 10^6 per metre, matching every other rate in the ERP. */
  meterRateMicro?: number | null
  /** Metres × 10^6, matching the shared quantity convention. */
  meterQtyMicro?: number | null
  notes?: string | null
}

export interface PlannedOrderExpenseInput {
  expenseName: string
  amountMinor: number
}

function requirePlanningPermission(scope: PlannedScope, ctx: ServiceContext): void {
  if (scope.orderId !== undefined) {
    requirePermission(ctx.session, P.productionPrep.manage)
    requirePermission(ctx.session, P.orders.view)
  }
  if (scope.workSheetId !== undefined) requirePermission(ctx.session, P.worksheets.issue)
  if (scope.quotationId !== undefined) requirePermission(ctx.session, P.quotations.manage)
}

function scopeColumn(scope: PlannedScope) {
  if (scope.quotationId) return eq(plannedMaterials.quotationId, scope.quotationId)
  if (scope.orderId) return eq(plannedMaterials.orderId, scope.orderId)
  if (scope.workSheetId) return eq(plannedMaterials.workSheetId, scope.workSheetId)
  throw new AppError('VALIDATION_ERROR', 'يجب تحديد الفاتورة المبدئية أو الطلب أو أمر التصنيع')
}

/** Line total = unit cost × quantity, rounded once at the line (AD-1). */
function lineTotalMinor(qtyMicro: number, unitCostMicroValue: number): number {
  return costOf(qtyMicro, unitCostMicro(unitCostMicroValue))
}

export function listPlannedMaterials(scope: PlannedScope) {
  return getDatabase()
    .select({
      id: plannedMaterials.id,
      materialId: plannedMaterials.materialId,
      materialName: plannedMaterials.materialName,
      qtyMicro: plannedMaterials.qtyMicro,
      unit: plannedMaterials.unit,
      dimensions: plannedMaterials.dimensions,
      thickness: plannedMaterials.thickness,
      colorCode: plannedMaterials.colorCode,
      notes: plannedMaterials.notes,
      estimatedUnitCostMicro: plannedMaterials.estimatedUnitCostMicro,
      estimatedTotalMinor: plannedMaterials.estimatedTotalMinor,
      sortOrder: plannedMaterials.sortOrder
    })
    .from(plannedMaterials)
    .where(scopeColumn(scope))
    .orderBy(asc(plannedMaterials.sortOrder), asc(plannedMaterials.id))
    .all()
}

export function listPlannedMachines(scope: PlannedScope) {
  // Same three scopes as materials since 0006 — quotation, order, and
  // the production order the plan was snapshotted onto.
  const where = scope.quotationId
    ? eq(plannedMachines.quotationId, scope.quotationId)
    : scope.orderId
      ? eq(plannedMachines.orderId, scope.orderId)
      : eq(plannedMachines.workSheetId, scope.workSheetId!)
  return getDatabase().select().from(plannedMachines).where(where).orderBy(asc(plannedMachines.id)).all()
}

export function listPlannedWorkers(scope: PlannedScope) {
  // Same three scopes as machines since the Product Components pass —
  // quotation, order, and the production order the plan was snapshotted onto.
  const where = scope.quotationId
    ? eq(plannedWorkers.quotationId, scope.quotationId)
    : scope.orderId
      ? eq(plannedWorkers.orderId, scope.orderId)
      : eq(plannedWorkers.workSheetId, scope.workSheetId!)
  return getDatabase().select().from(plannedWorkers).where(where).orderBy(asc(plannedWorkers.id)).all()
}

export function listPlannedOrderExpenses(scope: Pick<PlannedScope, 'orderId' | 'workSheetId'>) {
  const where = scope.orderId
    ? eq(plannedOrderExpenses.orderId, scope.orderId)
    : eq(plannedOrderExpenses.workSheetId, scope.workSheetId!)
  return getDatabase()
    .select()
    .from(plannedOrderExpenses)
    .where(where)
    .orderBy(asc(plannedOrderExpenses.sortOrder), asc(plannedOrderExpenses.id))
    .all()
}

/** Meter commission = integer micro-metres × integer micro-LYD rate. */
export function plannedWorkerTotalMinor(line: PlannedWorkerInput): number {
  const mode = line.commissionMode ?? 'estimated'
  if (mode === 'estimated') {
    const amount = line.estimatedCostMinor ?? 0
    requireSafeNonNegativeInteger(amount, 'العمولة التقديرية')
    return amount
  }

  const rate = line.meterRateMicro
  const metres = line.meterQtyMicro
  requireSafeNonNegativeInteger(rate as number, 'سعر المتر')
  requireSafeNonNegativeInteger(metres as number, 'عدد الأمتار')
  return lineTotalMinor(metres as number, rate as number)
}

/**
 * Replaces the planned material list for one scope. Used by the
 * preliminary-invoice costing editor and by the production order's
 * material editor — the same shape, different owner.
 */
export function savePlannedMaterials(
  scope: PlannedScope,
  lines: PlannedMaterialInput[],
  ctx: ServiceContext
): void {
  requirePlanningPermission(scope, ctx)
  withTransaction(() => {
    assertScopeEditable(scope)
    const previousById = new Map(listPlannedMaterials(scope).map((line) => [line.id, line]))
    getDatabase().delete(plannedMaterials).where(scopeColumn(scope)).run()
    lines.forEach((line, index) => {
      if (!line.materialName?.trim()) {
        throw new AppError('VALIDATION_ERROR', 'اسم المادة مطلوب')
      }
      requireSafePositiveInteger(line.qtyMicro, `الكمية المطلوبة من "${line.materialName}"`)
      const colorCode = line.colorCode?.trim() || null
      if (colorCode) {
        const catalogColor = getDatabase()
          .select({ code: colorFinishCatalog.code, active: colorFinishCatalog.active })
          .from(colorFinishCatalog)
          .where(eq(colorFinishCatalog.code, colorCode))
          .get()
        const historicalSnapshot = line.id ? previousById.get(line.id)?.colorCode === colorCode : false
        if ((!catalogColor || !catalogColor.active) && !historicalSnapshot) {
          throw new AppError('VALIDATION_ERROR', 'اختر اللون/التشطيب من الكتالوج المعتمد')
        }
      }
      const unitCost = line.estimatedUnitCostMicro ?? 0
      requireSafeNonNegativeInteger(unitCost, 'تكلفة الوحدة التقديرية')
      getDatabase()
        .insert(plannedMaterials)
        .values({
          quotationId: scope.quotationId ?? null,
          orderId: scope.orderId ?? null,
          workSheetId: scope.workSheetId ?? null,
          materialId: line.materialId ?? null,
          materialName: line.materialName,
          qtyMicro: line.qtyMicro,
          unit: line.unit ?? null,
          dimensions: line.dimensions ?? null,
          thickness: line.thickness ?? null,
          colorCode,
          notes: line.notes ?? null,
          estimatedUnitCostMicro: unitCost,
          estimatedTotalMinor: lineTotalMinor(line.qtyMicro, unitCost),
          sortOrder: index,
          createdAt: nowIso()
        })
        .run()
    })
    recomputeScopeEstimate(scope)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: auditActionFor(scope, 'plannedMaterials'),
      entity: 'planned_materials',
      entityId: String(scope.quotationId ?? scope.orderId ?? scope.workSheetId),
      details: { scope, lineCount: lines.length }
    })
  })
}

export function savePlannedMachines(
  scope: PlannedScope,
  lines: PlannedMachineInput[],
  ctx: ServiceContext
): void {
  requirePlanningPermission(scope, ctx)
  withTransaction(() => {
    assertScopeEditable(scope)
    const where = scope.quotationId
      ? eq(plannedMachines.quotationId, scope.quotationId)
      : scope.orderId
        ? eq(plannedMachines.orderId, scope.orderId)
        : eq(plannedMachines.workSheetId, scope.workSheetId!)
    const previousById = new Map(listPlannedMachines(scope).map((line) => [line.id, line]))
    getDatabase().delete(plannedMachines).where(where).run()
    for (const line of lines) {
      if (!line.machineName?.trim()) throw new AppError('VALIDATION_ERROR', 'اسم الآلة مطلوب')
      const previous = line.id ? previousById.get(line.id) : undefined
      const machineId = line.machineId ?? null
      const usageQtyMicro = line.usageQtyMicro ?? 0
      const sameMachine = Boolean(previous && previous.machineId === machineId)
      const unchangedLegacy = Boolean(
        previous && previous.rateMicro === null && sameMachine && previous.usageQtyMicro === usageQtyMicro
      )

      let machineName: string
      let usageUnit: string | null
      let rateMicro: number | null
      let estimatedCostMinor: number

      if (unchangedLegacy) {
        // A pre-0022 row has only its historical total. Preserve it
        // verbatim until the user changes the machine or usage rather
        // than reverse-engineering a rate that was never stored.
        machineName = previous!.machineName
        usageUnit = previous!.usageUnit
        rateMicro = null
        estimatedCostMinor = previous!.estimatedCostMinor
      } else {
        if (!machineId) {
          throw new AppError('VALIDATION_ERROR', 'اختر آلة من سجل الآلات لحساب التكلفة تلقائياً')
        }
        requireSafePositiveInteger(usageQtyMicro, 'الاستخدام المتوقع للآلة')
        const frozenRate = sameMachine ? previous?.rateMicro : null
        const hasFrozenRate = frozenRate !== null && frozenRate !== undefined
        const machine = hasFrozenRate
          ? undefined
          : getDatabase().select().from(machines).where(eq(machines.id, machineId)).get()
        if (!hasFrozenRate && (!machine || !machine.active)) {
          throw notFound('الآلة المحددة غير موجودة أو غير مفعلة')
        }
        // Keeping the prior rate when the same automatic line is edited
        // protects historical order costing from later master-price
        // changes. Selecting a different/new machine snapshots its
        // current configured rate instead.
        const resolvedRate = hasFrozenRate
          ? frozenRate
          : machine!.defaultRateMicro
        if (!Number.isSafeInteger(resolvedRate) || resolvedRate <= 0) {
          throw new AppError('VALIDATION_ERROR', `لم تُضبط تكلفة الوحدة للآلة "${machine?.name ?? previous?.machineName ?? line.machineName}"`)
        }
        rateMicro = resolvedRate
        machineName = sameMachine && previous ? previous.machineName : machine!.name
        usageUnit = sameMachine && previous ? previous.usageUnit : machine!.costingUnit
        estimatedCostMinor = lineTotalMinor(usageQtyMicro, resolvedRate)
      }
      getDatabase()
        .insert(plannedMachines)
        .values({
          quotationId: scope.quotationId ?? null,
          orderId: scope.orderId ?? null,
          workSheetId: scope.workSheetId ?? null,
          machineId,
          machineName,
          usageQtyMicro,
          usageUnit,
          rateMicro,
          estimatedCostMinor,
          notes: line.notes ?? null,
          createdAt: nowIso()
        })
        .run()
    }
    recomputeScopeEstimate(scope)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: auditActionFor(scope, 'plannedMachines'),
      entity: 'planned_machines',
      entityId: String(scope.quotationId ?? scope.orderId ?? scope.workSheetId),
      details: { scope, lineCount: lines.length }
    })
  })
}

export function savePlannedWorkers(
  scope: PlannedScope,
  lines: PlannedWorkerInput[],
  ctx: ServiceContext
): void {
  requirePlanningPermission(scope, ctx)
  withTransaction(() => {
    assertScopeEditable(scope)
    const where = scope.quotationId
      ? eq(plannedWorkers.quotationId, scope.quotationId)
      : scope.orderId
        ? eq(plannedWorkers.orderId, scope.orderId)
        : eq(plannedWorkers.workSheetId, scope.workSheetId!)
    getDatabase().delete(plannedWorkers).where(where).run()
    for (const line of lines) {
      if (!line.workerName?.trim()) throw new AppError('VALIDATION_ERROR', 'اسم العامل مطلوب')
      const commissionMode = line.commissionMode ?? 'estimated'
      const estimatedCostMinor = plannedWorkerTotalMinor(line)
      getDatabase()
        .insert(plannedWorkers)
        .values({
          quotationId: scope.quotationId ?? null,
          orderId: scope.orderId ?? null,
          workerId: line.workerId ?? null,
          workerName: line.workerName,
          commissionMode,
          meterRateMicro: commissionMode === 'meter' ? line.meterRateMicro : null,
          meterQtyMicro: commissionMode === 'meter' ? line.meterQtyMicro : null,
          estimatedCostMinor,
          notes: line.notes ?? null,
          createdAt: nowIso()
        })
        .run()
    }
    recomputeScopeEstimate(scope)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: auditActionFor(scope, 'plannedWorkers'),
      entity: 'planned_workers',
      entityId: String(scope.quotationId ?? scope.orderId ?? scope.workSheetId),
      details: { scope, lineCount: lines.length }
    })
  })
}

export function savePlannedOrderExpenses(
  orderId: number,
  lines: PlannedOrderExpenseInput[],
  ctx: ServiceContext
): void {
  requirePlanningPermission({ orderId }, ctx)
  const scope = { orderId }
  withTransaction(() => {
    assertScopeEditable(scope)
    getDatabase().delete(plannedOrderExpenses).where(eq(plannedOrderExpenses.orderId, orderId)).run()
    lines.forEach((line, index) => {
      if (!line.expenseName?.trim()) throw new AppError('VALIDATION_ERROR', 'اسم المصروف مطلوب')
      requireSafeNonNegativeInteger(line.amountMinor, 'سعر المصروف')
      getDatabase().insert(plannedOrderExpenses).values({
        orderId,
        expenseName: line.expenseName.trim(),
        amountMinor: line.amountMinor,
        sortOrder: index,
        createdAt: nowIso()
      }).run()
    })
    recomputeOrderEstimate(orderId)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.plannedExpenses.update',
      entity: 'planned_order_expenses',
      entityId: String(orderId),
      details: { orderId, lineCount: lines.length }
    })
  })
}

/**
 * An approved quotation is frozen (BR-45), and so is an order's own
 * planned snapshot — only a draft quotation and an OPEN production
 * order may have their planned lines edited.
 */
function assertScopeEditable(scope: PlannedScope): void {
  // Workflow pass: the CUSTOMER ORDER is the production-planning point.
  // Its configuration is editable for as long as the order is open, and
  // frozen the moment the order is completed or cancelled.
  if (scope.orderId) {
    const order = getDatabase().select().from(orders).where(eq(orders.id, scope.orderId)).get()
    if (!order) throw notFound('الطلب غير موجود')
    if (order.status === 'awaiting_approval' || order.archivedAt) throw new AppError('CONFLICT', 'أعد اعتماد الفاتورة أو استعد الطلب أولاً قبل تصحيح تجهيز الإنتاج')
    if (order.status === 'cancelled') {
      throw new AppError('CONFLICT', 'لا يمكن تعديل تجهيز الإنتاج لطلب ملغى')
    }
    if (order.completedAt) {
      throw new AppError('CONFLICT', 'لا يمكن تعديل تجهيز الإنتاج بعد إكمال الطلب')
    }
    if (getDatabase().get(sql`SELECT id FROM work_sheets WHERE order_id = ${scope.orderId} AND status = 'completed' LIMIT 1`)) {
      throw new AppError('CONFLICT', PRODUCTION_PREP_LOCKED_MESSAGE)
    }
    // BL-04: preparation exists only for custom manufacturing demand.
    if (!getDatabase().select().from(orderLines).where(eq(orderLines.orderId, scope.orderId)).all().some(isManufacturableOrderLine)) {
      throw new AppError('CONFLICT', 'تجهيز الإنتاج مخصص للبنود المخصّصة — المنتجات القياسية تُصرف من المخزون الجاهز')
    }
    return
  }
  if (scope.workSheetId) {
    // Retired stock worksheets remain historical, not a second production plan.
    const sheet = getDatabase().get<{ orderId: number | null; status: string }>(sql`SELECT order_id AS orderId, status FROM work_sheets WHERE id = ${scope.workSheetId}`)
    if (!sheet?.orderId) throw new AppError('CONFLICT', 'أمر تصنيع المخزون التاريخي للعرض فقط')
    // IPC also requires ready/in_production; the completed lock must hold for direct service calls too.
    if (sheet.status === 'completed') {
      throw new AppError('CONFLICT', PRODUCTION_PREP_LOCKED_MESSAGE)
    }
    return
  }
  if (scope.quotationId) {
    // The preliminary invoice is a customer-facing document only: it no
    // longer collects or owns any internal production configuration.
    throw new AppError(
      'CONFLICT',
      'الفاتورة المبدئية مستند تجاري للعميل فقط — تجهيز الإنتاج يتم من طلب العميل'
    )
  }
  throw new AppError('VALIDATION_ERROR', 'نطاق غير صالح')
}

/** Each scope keeps its OWN aggregate estimate in step with its lines. */
function recomputeScopeEstimate(scope: PlannedScope): void {
  if (scope.quotationId) recomputeQuotationEstimate(scope.quotationId)
  else if (scope.orderId) recomputeOrderEstimate(scope.orderId)
}

function auditActionFor(scope: PlannedScope, what: string): string {
  const owner = scope.workSheetId ? 'production' : scope.orderId ? 'orders' : 'quotations'
  return `${owner}.${what}.update`
}

/**
 * Keeps the quotation's aggregate estimate columns in step with its
 * planned lines, so the expected-profit figure and the order it is
 * copied onto are always derived from what the user actually entered.
 * `estimatedOtherMinor` stays manual — it has no lines behind it.
 */
export function recomputeQuotationEstimate(quotationId: number): void {
  const db = getDatabase()
  const material =
    db.get<{ total: number }>(
      sql`SELECT COALESCE(SUM(estimated_total_minor), 0) AS total FROM planned_materials WHERE quotation_id = ${quotationId}`
    )?.total ?? 0
  const machine =
    db.get<{ total: number }>(
      sql`SELECT COALESCE(SUM(estimated_cost_minor), 0) AS total FROM planned_machines WHERE quotation_id = ${quotationId}`
    )?.total ?? 0
  const worker =
    db.get<{ total: number }>(
      sql`SELECT COALESCE(SUM(estimated_cost_minor), 0) AS total FROM planned_workers WHERE quotation_id = ${quotationId}`
    )?.total ?? 0

  db.update(quotations)
    .set({
      estimatedMaterialMinor: material,
      estimatedMachineMinor: machine,
      estimatedWorkerMinor: worker
    })
    .where(eq(quotations.id, quotationId))
    .run()
}

/**
 * Part 5: the Customer Order's INTERNAL estimated manufacturing cost,
 * derived from the production configuration the order itself owns —
 *
 *   estimated material + estimated machine + estimated worker commission
 *
 * `estimatedOtherMinor` stays manual; it has no planned lines behind it.
 * These figures are internal and never reach a customer-facing document.
 */
export function recomputeOrderEstimate(orderId: number): void {
  const db = getDatabase()
  const material =
    db.get<{ total: number }>(
      sql`SELECT COALESCE(SUM(estimated_total_minor), 0) AS total FROM planned_materials WHERE order_id = ${orderId}`
    )?.total ?? 0
  const machine =
    db.get<{ total: number }>(
      sql`SELECT COALESCE(SUM(estimated_cost_minor), 0) AS total FROM planned_machines WHERE order_id = ${orderId}`
    )?.total ?? 0
  const worker =
    db.get<{ total: number }>(
      sql`SELECT COALESCE(SUM(estimated_cost_minor), 0) AS total FROM planned_workers WHERE order_id = ${orderId}`
    )?.total ?? 0
  // Order-expense total is intentionally derived directly from its
  // child lines; there is no stale/overridable aggregate column.

  db.update(orders)
    .set({
      estimatedMaterialMinor: material,
      estimatedMachineMinor: machine,
      estimatedWorkerMinor: worker
    })
    .where(eq(orders.id, orderId))
    .run()
}

/**
 * The Customer Order's COMMERCIAL + PLANNING view — the order's OWN
 * production configuration and the internal estimate derived from it,
 * never actual execution.
 *
 * Workflow pass: this is the authoritative planning view. The estimate
 * fields come from the `orders` row itself, which `recomputeOrderEstimate`
 * keeps in step with the planned lines the order owns. Nothing here is
 * re-derived from a product master or an invoice, so a later edit to
 * either can never change what an existing order shows.
 */
export interface OrderPlanningSnapshot {
  orderId: number
  materials: ReturnType<typeof listPlannedMaterials>
  machines: ReturnType<typeof listPlannedMachines>
  workers: ReturnType<typeof listPlannedWorkers>
  expenses: ReturnType<typeof listPlannedOrderExpenses>
  estimatedMaterialMinor: number
  estimatedMachineMinor: number
  estimatedWorkerMinor: number
  estimatedOtherMinor: number
  estimatedOrderExpenseMinor: number
  totalEstimatedCostMinor: number
  sellingPriceMinor: number
  expectedProfitMinor: number
}

export function orderPlanningSnapshot(orderId: number): OrderPlanningSnapshot {
  const order = getDatabase().select().from(orders).where(eq(orders.id, orderId)).get()
  if (!order) throw notFound('الطلب غير موجود')

  const expenseLines = listPlannedOrderExpenses({ orderId })
  const lineExpensesMinor = expenseLines.reduce((sum, line) => sum + line.amountMinor, 0)
  // Preserve historical estimated_other_minor values as part of the
  // expense category. New order expenses are always proper child rows.
  const estimatedOrderExpenseMinor = lineExpensesMinor + order.estimatedOtherMinor
  const totalEstimatedCostMinor =
    order.estimatedMaterialMinor +
    order.estimatedMachineMinor +
    order.estimatedWorkerMinor +
    estimatedOrderExpenseMinor

  return {
    orderId,
    materials: listPlannedMaterials({ orderId }),
    machines: listPlannedMachines({ orderId }),
    workers: listPlannedWorkers({ orderId }),
    expenses: expenseLines,
    estimatedMaterialMinor: order.estimatedMaterialMinor,
    estimatedMachineMinor: order.estimatedMachineMinor,
    estimatedWorkerMinor: order.estimatedWorkerMinor,
    estimatedOtherMinor: order.estimatedOtherMinor,
    estimatedOrderExpenseMinor,
    totalEstimatedCostMinor,
    sellingPriceMinor: order.totalMinor,
    expectedProfitMinor: order.totalMinor - totalEstimatedCostMinor
  }
}

/** Convenience for the UI: the raw-material master with its cost basis. */
export function materialCostBasis(materialId: number) {
  const material = getDatabase().select().from(materials).where(eq(materials.id, materialId)).get()
  if (!material) throw notFound('المادة غير موجودة')
  return {
    id: material.id,
    name: material.name,
    unit: material.unit,
    dimensions: material.dimensions,
    thickness: material.thickness,
    // Reuses the existing market price as the estimating basis; actual
    // cost still comes from FIFO when the material is really consumed.
    currentMarketPriceMicro: material.currentMarketPriceMicro
  }
}

/** Machine/worker pickers reuse the existing masters — never a copy. */
export function machineEstimateBasis(machineId: number) {
  const machine = getDatabase().select().from(machines).where(eq(machines.id, machineId)).get()
  if (!machine) throw notFound('الآلة غير موجودة')
  return {
    id: machine.id,
    name: machine.name,
    costingUnit: machine.costingUnit,
    defaultRateMicro: machine.defaultRateMicro
  }
}

export function workerEstimateBasis(workerId: number) {
  const worker = getDatabase().select().from(workers).where(eq(workers.id, workerId)).get()
  if (!worker) throw notFound('العامل غير موجود')
  return {
    id: worker.id,
    name: worker.name,
    defaultMethod: worker.defaultMethod,
    defaultRateMicro: worker.defaultRateMicro
  }
}
