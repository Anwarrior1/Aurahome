import { and, eq, like, sql } from 'drizzle-orm'
import { keysetBoundary, keysetOrder, keysetPage, type KeysetWindow, type PageRequest } from '../base/pagination'
import { PAGE_SIZE } from '@shared/pagination/cursor-page'
import { getDatabase, getRawConnection } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import {
  workers,
  workerTransactions,
  orderWorkerAssignments
} from '../../db/schema/production.schema'
import { orders, orderLines } from '../../db/schema/sales.schema'
import { hasPermission, requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { AppError, notFound } from '../../utils/errors'
import { applyPercent } from '@shared/money/cost'
import { money } from '@shared/money/money'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, today, type ServiceContext } from '../base/service.types'
import {
  accountBalance,
  adjustCashMovementForRef,
  postCashMovement,
  removeCashMovementForRef
} from '../finance/cash.service'
import { cashAccounts, cashTransactions } from '../../db/schema/finance.schema'
import { assertProductionOpen, assertResourceMutationOpen } from './production.service'
import { assertOrderOperational } from '../sales/orders.service'
import { runOptionalIdempotentFinancialCommand } from '../finance/idempotency.service'
import { requireSafeInteger, requireSafeNonNegativeInteger, requireSafePositiveInteger } from '../../utils/numeric'
import { isManufacturableOrderLine } from '../sales/order-line-manufacturing'

export type CompensationMethod = 'fixed' | 'percent'

/** Account labels needed by the commission owner; no cash balances or history. */
export function listCommissionPaymentAccounts(ctx: ServiceContext): Array<{ id: number; name: string }> {
  requirePermission(ctx.session, P.workers.finance)
  return getDatabase().select({ id: cashAccounts.id, name: cashAccounts.name })
    .from(cashAccounts).orderBy(cashAccounts.id).all()
}
export type CompensationBase =
  'total_after_discount' | 'subtotal_before_discount' | 'manual' | 'line'

export function listWorkers(filter: { search?: string; activeOnly?: boolean } = {}) {
  const clauses = []
  if (filter.search?.trim()) clauses.push(like(workers.name, `%${filter.search.trim()}%`))
  if (filter.activeOnly) clauses.push(eq(workers.active, true))
  const rows = getDatabase()
    .select()
    .from(workers)
    .where(clauses.length ? and(...clauses) : undefined)
    .all()
  if (!rows.length) return []
  // Keep the master query's order; aggregate only its IDs with the same CC04 expressions.
  const balances = new Map(getDatabase().all<{ workerId: number; payableMinor: number; debtMinor: number }>(sql`
    SELECT worker_id AS workerId, ${WORKER_PAYABLE_SQL} AS payableMinor, ${WORKER_DEBT_SQL} AS debtMinor
    FROM worker_transactions
    WHERE worker_id IN (SELECT value FROM json_each(${JSON.stringify(rows.map((worker) => worker.id))}))
    GROUP BY worker_id
  `).map((balance) => [balance.workerId, balance]))
  return rows.map((worker) => ({
    ...worker,
    payableMinor: balances.get(worker.id)?.payableMinor ?? 0,
    debtMinor: balances.get(worker.id)?.debtMinor ?? 0
  }))
}

/** SQL for the two separate worker balances; never netted against each other (CC04). */
export const WORKER_PAYABLE_SQL = sql.raw(`COALESCE(SUM(CASE WHEN kind IN ('earning', 'adjustment') THEN amount_minor
  WHEN kind = 'commission_payment' THEN -amount_minor ELSE 0 END), 0)`)
export const WORKER_DEBT_SQL = sql.raw(`COALESCE(SUM(CASE WHEN kind = 'withdrawal' THEN amount_minor
  WHEN kind = 'repayment' THEN -amount_minor ELSE 0 END), 0)`)

/**
 * CC04: two separate ledgers on worker_transactions.
 * payable = recognised commissions (earning + reversal adjustments) − commission payments: what the factory owes.
 * debt = withdrawals − returns: what the worker owes. They are never offset automatically.
 */
export function workerBalances(workerId: number): { payableMinor: number; debtMinor: number } {
  const row = getDatabase().get<{ payableMinor: number; debtMinor: number }>(sql`
    SELECT ${WORKER_PAYABLE_SQL} AS payableMinor, ${WORKER_DEBT_SQL} AS debtMinor
    FROM worker_transactions WHERE worker_id = ${workerId}
  `)
  return { payableMinor: row?.payableMinor ?? 0, debtMinor: row?.debtMinor ?? 0 }
}

export function createWorker(
  input: {
    name: string
    phone?: string
    defaultMethod?: CompensationMethod
    defaultCostingUnit?: string
    defaultRateMicro?: number
    notes?: string
  },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.workers.manage)
  return withTransaction(() => {
    if (input.defaultRateMicro !== undefined)
      requireSafeNonNegativeInteger(input.defaultRateMicro, 'معدل العامل')
    const id = Number(
      getDatabase()
        .insert(workers)
        .values({
          name: input.name,
          phone: input.phone ?? null,
          defaultMethod: input.defaultMethod ?? 'fixed',
          defaultCostingUnit: input.defaultCostingUnit ?? null,
          defaultRateMicro: input.defaultRateMicro ?? null,
          notes: input.notes ?? null,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'workers.create',
      entity: 'workers',
      entityId: String(id),
      details: { name: input.name }
    })
    return id
  })
}

export function updateWorker(
  id: number,
  input: Record<string, unknown>,
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.workers.manage)
  return withTransaction(() => {
    if (input.defaultRateMicro !== undefined && input.defaultRateMicro !== null)
      requireSafeNonNegativeInteger(input.defaultRateMicro as number, 'معدل العامل')
    if (!getDatabase().select().from(workers).where(eq(workers.id, id)).get()) {
      throw notFound('العامل غير موجود')
    }
    getDatabase()
      .update(workers)
      .set(input as never)
      .where(eq(workers.id, id))
      .run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'workers.update',
      entity: 'workers',
      entityId: String(id),
      details: input
    })
  })
}

/**
 * Corrected Item 8: deleting a Worker only removes them from the active
 * "العمال" list and from future selection — it must never reverse
 * earnings, payments, commissions, cash movements, or touch historical
 * labour cost/profit (those are always recomputed live from
 * order_worker_assignments/worker_transactions — see workerBalance and
 * the production costing functions, which sum those rows directly).
 *
 * A worker with zero history anywhere is truly gone (physical delete).
 * One with any assignment or financial-transaction history is archived
 * (`active=false`, the worker's own existing lifecycle field — nothing
 * else about the row changes) so every historical screen keeps
 * resolving their name/reference exactly as before, and every figure
 * that depends on their past rows stays byte-for-byte the same.
 */
export function deleteWorker(
  id: number,
  ctx: ServiceContext
): { deleted: boolean; archived: boolean } {
  requirePermission(ctx.session, P.workers.manage)
  return withTransaction(() => {
    const worker = getDatabase().select().from(workers).where(eq(workers.id, id)).get()
    if (!worker) throw notFound('العامل غير موجود')

    const assignmentCount =
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM order_worker_assignments WHERE worker_id = ${id}`
      )?.c ?? 0
    const transactionCount =
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM worker_transactions WHERE worker_id = ${id}`
      )?.c ?? 0

    if (assignmentCount === 0 && transactionCount === 0) {
      getDatabase().delete(workers).where(eq(workers.id, id)).run()
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'workers.delete',
        entity: 'workers',
        entityId: String(id),
        details: { name: worker.name }
      })
      return { deleted: true, archived: false }
    }

    getDatabase().update(workers).set({ active: false }).where(eq(workers.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'workers.archive',
      entity: 'workers',
      entityId: String(id),
      details: { name: worker.name, assignmentCount, transactionCount }
    })
    return { deleted: false, archived: true }
  })
}

/**
 * BR-86/BR-107: compensation is decided per worker, per order.
 * A percentage carries the user-chosen calculation base — one of the
 * four confirmed options. Different workers on the same order may use
 * different methods and values.
 */
export function computeCompensation(
  order: { id?: number; totalMinor: number; subtotalMinor: number },
  input: {
    method: CompensationMethod
    amountMinor?: number
    percentBp?: number
    baseKind?: CompensationBase
    baseAmountMinor?: number
    orderLineId?: number
  }
): number {
  if (input.method === 'fixed') {
    if (input.amountMinor === undefined) {
      throw new AppError('VALIDATION_ERROR', 'يجب إدخال مبلغ ثابت صحيح')
    }
    requireSafeNonNegativeInteger(input.amountMinor, 'المبلغ الثابت')
    return input.amountMinor
  }

  if (input.percentBp === undefined) {
    throw new AppError('VALIDATION_ERROR', 'يجب إدخال نسبة صحيحة')
  }
  requireSafeInteger(input.percentBp, 'النسبة', { min: 0, max: 10_000 })

  let base: number
  switch (input.baseKind) {
    case 'subtotal_before_discount':
      base = order.subtotalMinor
      break
    case 'manual':
      if (input.baseAmountMinor === undefined) {
        throw new AppError('VALIDATION_ERROR', 'يجب إدخال المبلغ الأساس لاحتساب النسبة')
      }
      requireSafeNonNegativeInteger(input.baseAmountMinor, 'المبلغ الأساس')
      base = input.baseAmountMinor
      break
    case 'line': {
      if (!input.orderLineId) {
        throw new AppError('VALIDATION_ERROR', 'يجب اختيار البند لاحتساب النسبة')
      }
      const line = getDatabase()
        .select()
        .from(orderLines)
        .where(eq(orderLines.id, input.orderLineId))
        .get()
      if (!line || (order.id !== undefined && line.orderId !== order.id) || !isManufacturableOrderLine(line))
        throw notFound('بند الطلب الحالي غير موجود')
      base = line.lineTotalMinor
      break
    }
    case 'total_after_discount':
    default:
      base = order.totalMinor
  }
  return applyPercent(money(base), input.percentBp)
}

/**
 * BR-86 + item 14: assign a worker with their own agreed compensation.
 *
 * The assignment can name the customer order (unchanged behaviour) or
 * the production order it belongs to. When a production order is given
 * its own customer order is resolved from it, so labour posted during
 * production still lands on the order's actual cost exactly as before.
 * A stock production order has no customer order — those assignments
 * must use a fixed amount, since every percentage base reads the order.
 */
export function assignWorkerToOrder(
  input: {
    orderId?: number
    workSheetId?: number
    workerId: number
    method: CompensationMethod
    amountMinor?: number
    percentBp?: number
    baseKind?: CompensationBase
    baseAmountMinor?: number
    orderLineId?: number
    notes?: string
  },
  ctx: ServiceContext
): { id: number; amountMinor: number } {
  requirePermission(ctx.session, P.worksheets.issue)
  return withTransaction(() => {
    assertResourceMutationOpen(input)
    const sheet = input.workSheetId ? assertProductionOpen(input.workSheetId) : undefined
    const orderId = input.orderId ?? sheet?.orderId ?? null
    if (!orderId && !sheet) {
      throw new AppError('VALIDATION_ERROR', 'يجب تحديد الطلب أو أمر التصنيع')
    }
    if (input.orderId && sheet?.orderId && sheet.orderId !== input.orderId) {
      throw new AppError('VALIDATION_ERROR', 'أمر التصنيع لا يخص هذا الطلب')
    }

    const order = orderId
      ? getDatabase().select().from(orders).where(eq(orders.id, orderId)).get()
      : undefined
    if (orderId && !order) throw notFound('الطلب غير موجود')
    if (orderId) assertOrderOperational(orderId)
    const targetWorker = getDatabase()
      .select()
      .from(workers)
      .where(eq(workers.id, input.workerId))
      .get()
    if (!targetWorker) throw notFound('العامل غير موجود')
    // The active flag is the sole "removed" signal for a worker (see
    // deleteWorker) — a worker taken off the active list must never be
    // reachable through a fresh assignment, only through their history.
    if (!targetWorker.active) {
      throw new AppError('CONFLICT', 'لا يمكن تعيين عامل تم حذفه من القائمة الحالية')
    }
    if (order?.completedAt) {
      throw new AppError('CONFLICT', 'لا يمكن تعديل العمالة بعد إكمال الطلب')
    }
    if (!order && input.method === 'percent') {
      throw new AppError(
        'VALIDATION_ERROR',
        'لا يمكن احتساب نسبة مئوية لعامل على أمر تصنيع مخزون — استخدم مبلغاً ثابتاً'
      )
    }

    const amountMinor = order ? computeCompensation(order, input) : (input.amountMinor ?? 0)
    requireSafePositiveInteger(amountMinor, 'قيمة مستحقات العامل')
    const id = Number(
      getDatabase()
        .insert(orderWorkerAssignments)
        .values({
          orderId,
          workSheetId: sheet?.id ?? null,
          workerId: input.workerId,
          method: input.method,
          percentBp: input.percentBp ?? null,
          baseKind: input.baseKind ?? null,
          baseAmountMinor: input.baseAmountMinor ?? null,
          orderLineId: input.orderLineId ?? null,
          amountMinor,
          earned: false,
          notes: input.notes ?? null
        })
        .run().lastInsertRowid
    )
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.worker.assign',
      entity: 'order_worker_assignments',
      entityId: String(id),
      details: { ...input, amountMinor }
    })
    return { id, amountMinor }
  })
}

export function updateAssignment(
  id: number,
  input: {
    method?: CompensationMethod
    amountMinor?: number
    percentBp?: number
    baseKind?: CompensationBase
    baseAmountMinor?: number
    orderLineId?: number
    notes?: string
  },
  ctx: ServiceContext
): { amountMinor: number } {
  requirePermission(ctx.session, P.worksheets.issue)
  return withTransaction(() => {
    const existing = getDatabase()
      .select()
      .from(orderWorkerAssignments)
      .where(eq(orderWorkerAssignments.id, id))
      .get()
    if (!existing) throw notFound('تعيين العامل غير موجود')
    if (existing.reversedAt) throw new AppError('CONFLICT', 'تم التراجع عن هذا التعيين بالفعل')
    if (existing.earned) {
      throw new AppError('CONFLICT', 'لا يمكن تعديل مستحقات تم احتسابها بعد إكمال الطلب')
    }
    assertResourceMutationOpen(existing)
    // A stock-production assignment has no customer order behind it, so
    // percentage bases that read the order are not available there.
    const order = existing.orderId
      ? getDatabase().select().from(orders).where(eq(orders.id, existing.orderId)).get()
      : undefined
    if (existing.orderId && !order) throw notFound('الطلب غير موجود')
    if (!order && (input.method ?? existing.method) === 'percent') {
      throw new AppError(
        'VALIDATION_ERROR',
        'لا يمكن احتساب نسبة مئوية لعامل على أمر تصنيع مخزون — استخدم مبلغاً ثابتاً'
      )
    }

    const merged = {
      method: (input.method ?? existing.method) as CompensationMethod,
      amountMinor: input.amountMinor ?? existing.amountMinor,
      percentBp: input.percentBp ?? existing.percentBp ?? undefined,
      baseKind: (input.baseKind ?? existing.baseKind ?? undefined) as CompensationBase | undefined,
      baseAmountMinor: input.baseAmountMinor ?? existing.baseAmountMinor ?? undefined,
      orderLineId: input.orderLineId ?? existing.orderLineId ?? undefined
    }
    const amountMinor = order ? computeCompensation(order, merged) : merged.amountMinor

    getDatabase()
      .update(orderWorkerAssignments)
      .set({
        method: merged.method,
        percentBp: merged.percentBp ?? null,
        baseKind: merged.baseKind ?? null,
        baseAmountMinor: merged.baseAmountMinor ?? null,
        orderLineId: merged.orderLineId ?? null,
        amountMinor,
        notes: input.notes ?? existing.notes
      })
      .where(eq(orderWorkerAssignments.id, id))
      .run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.worker.update',
      entity: 'order_worker_assignments',
      entityId: String(id),
      details: { ...input, amountMinor }
    })
    return { amountMinor }
  })
}

export function removeAssignment(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.worksheets.issue)
  return withTransaction(() => {
    const existing = getDatabase()
      .select()
      .from(orderWorkerAssignments)
      .where(eq(orderWorkerAssignments.id, id))
      .get()
    if (!existing) throw notFound('تعيين العامل غير موجود')
    if (existing.reversedAt) throw new AppError('CONFLICT', 'لا يمكن حذف سجل تاريخي تم التراجع عنه')
    if (existing.earned) throw new AppError('CONFLICT', 'لا يمكن حذف مستحقات محتسبة')
    assertResourceMutationOpen(existing)
    getDatabase().delete(orderWorkerAssignments).where(eq(orderWorkerAssignments.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.worker.remove',
      entity: 'order_worker_assignments',
      entityId: String(id)
    })
  })
}

/**
 * Legacy path (BR-108): assignments still unearned when the ORDER completes (e.g. manufacturing
 * completed before CC04) earn here, unlinked, exactly as before. Called within order completion.
 */
export function recordWorkerEarnings(
  orderId: number,
  completedAt: string,
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.deliveries.register)
  const db = getDatabase()
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get()
  if (!getRawConnection().inTransaction || order?.status !== 'completed' || order.completedAt !== completedAt ||
    !db.get(sql`SELECT id FROM deliveries WHERE order_id = ${orderId} AND status = 'recorded' AND recorded_at = ${completedAt} LIMIT 1`))
    throw new AppError('CONFLICT', 'استحقاق إكمال الطلب يتطلب معاملة الإكمال والتسليم المسجل')
  const assignments = db
    .select()
    .from(orderWorkerAssignments)
    .where(
      and(
        eq(orderWorkerAssignments.orderId, orderId),
        eq(orderWorkerAssignments.earned, false),
        sql`${orderWorkerAssignments.reversedAt} IS NULL`
      )
    )
    .all()

  for (const assignment of assignments) {
    if (assignment.amountMinor <= 0) continue
    db.insert(workerTransactions)
      .values({
        workerId: assignment.workerId,
        kind: 'earning',
        amountMinor: assignment.amountMinor,
        orderId,
        notes: 'استحقاق عند إكمال الطلب',
        createdBy: ctx.session.user.id,
        createdAt: completedAt
      })
      .run()
    db.update(orderWorkerAssignments)
      .set({ earned: true, earnedAt: completedAt })
      .where(eq(orderWorkerAssignments.id, assignment.id))
      .run()
  }
}

export function reverseWorkerEarnings(orderId: number, ctx: ServiceContext): void {
  if (!hasPermission(ctx.session, P.deliveries.deleteOrReverse)) requirePermission(ctx.session, P.orders.complete)
  const db = getDatabase()
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get()
  if (!getRawConnection().inTransaction || order?.status !== 'completed' || !order.completedAt ||
    db.get(sql`SELECT id FROM deliveries WHERE order_id = ${orderId} AND status = 'recorded' LIMIT 1`))
    throw new AppError('CONFLICT', 'عكس استحقاق الإكمال يتطلب معاملة تراجع إكمال الطلب')
  withTransaction(() => {
    // The canonical earning event owns order_id. No matching by date/text/amount.
    const earnings = db.all<{ id: number; workerId: number; amountMinor: number }>(sql`
      SELECT t.id, t.worker_id AS workerId, t.amount_minor AS amountMinor
      FROM worker_transactions t WHERE t.order_id = ${orderId} AND t.kind = 'earning' AND t.assignment_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM worker_transactions r WHERE r.reversal_of_transaction_id = t.id)
    `)
    // Manufacturing-completion earnings (CC04, linked by assignment_id) belong to completed
    // manufacturing, which Package 01 makes irreversible; order-completion reversal never touches them.
    const earnedAssignments = db
      .select()
      .from(orderWorkerAssignments)
      .where(
        and(
          eq(orderWorkerAssignments.orderId, orderId),
          eq(orderWorkerAssignments.earned, true),
          sql`${orderWorkerAssignments.reversedAt} IS NULL`,
          sql`NOT EXISTS(SELECT 1 FROM worker_transactions l WHERE l.assignment_id = ${orderWorkerAssignments.id})`
        )
      )
      .all()
    const byWorker = new Map<number, number>()
    for (const a of earnedAssignments)
      byWorker.set(a.workerId, (byWorker.get(a.workerId) ?? 0) + a.amountMinor)
    for (const e of earnings)
      byWorker.set(e.workerId, (byWorker.get(e.workerId) ?? 0) - e.amountMinor)
    if ([...byWorker.values()].some((v) => v !== 0))
      throw new AppError(
        'CONFLICT',
        'تعذر عكس مستحقات الإكمال: سجل استحقاقات الطلب لا يطابق تعييناته. يلزم فحص البيانات التاريخية'
      )
    for (const e of earnings)
      db.insert(workerTransactions)
        .values({
          workerId: e.workerId,
          orderId,
          kind: 'adjustment',
          amountMinor: -e.amountMinor,
          reversalOfTransactionId: e.id,
          notes: 'عكس استحقاق إكمال الطلب',
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run()
    for (const a of earnedAssignments)
      db.update(orderWorkerAssignments)
        .set({ earned: false, earnedAt: null })
        .where(eq(orderWorkerAssignments.id, a.id))
        .run()
    if (earnings.length)
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'orders.worker.earnings.reverse',
        entity: 'orders',
        entityId: String(orderId),
        details: { transactionIds: earnings.map((e) => e.id) }
      })
  })
}

export type ManualWorkerTransactionKind = 'withdrawal' | 'repayment'

export interface WorkerTransactionSnapshot {
  workerId: number
  kind: string
  amountMinor: number
  orderId: number | null
  reversalOfTransactionId: number | null
  cashAccountId: number | null
  notes: string | null
  createdAt: string
}

function isManualWorkerTransaction(row: {
  kind: string
  orderId: number | null
  reversalOfTransactionId: number | null
}): boolean {
  return (
    (row.kind === 'withdrawal' || row.kind === 'repayment') &&
    row.orderId === null &&
    row.reversalOfTransactionId === null
  )
}

function checkedManualWorkerTransaction(id: number, expected: WorkerTransactionSnapshot) {
  const existing = getDatabase()
    .select()
    .from(workerTransactions)
    .where(eq(workerTransactions.id, id))
    .get()
  if (!existing) throw notFound('حركة العامل غير موجودة أو تم حذفها')
  if (!isManualWorkerTransaction(existing)) {
    throw new AppError('CONFLICT', 'هذه ليست حركة مالية يدوية قابلة للتعديل أو الحذف')
  }
  for (const key of Object.keys(expected) as Array<keyof WorkerTransactionSnapshot>) {
    if (existing[key] !== expected[key]) {
      throw new AppError('CONFLICT', 'تم تغيير حركة العامل. حدّث كشف الحساب وافتح العملية مجدداً')
    }
  }
  return existing
}

function linkedWorkerCashRows(transactionId: number) {
  return getDatabase()
    .select()
    .from(cashTransactions)
    .where(
      and(
        eq(cashTransactions.refTable, 'worker_transactions'),
        eq(cashTransactions.refId, transactionId)
      )
    )
    .all()
}

function assertWorkerCashLink(
  transaction: { id: number; kind: string; amountMinor: number; cashAccountId: number | null },
  rows: ReturnType<typeof linkedWorkerCashRows>
): void {
  const expectedDirection = transaction.kind === 'withdrawal' ? 'out' : 'in'
  const expectedKind = transaction.kind === 'withdrawal' ? 'worker_withdrawal' : 'worker_repayment'
  const row = rows[0]
  const valid =
    transaction.cashAccountId === null
      ? rows.length === 0
      : rows.length === 1 &&
        row !== undefined &&
        row.accountId === transaction.cashAccountId &&
        row.direction === expectedDirection &&
        row.kind === expectedKind &&
        row.amountMinor === transaction.amountMinor
  if (!valid) {
    throw new AppError('CONFLICT', 'لا يمكن تصحيح الحركة لأن رابط حركتها النقدية غير مكتمل أو مكرر')
  }
}

const debtEffect = (kind: string, amountMinor: number): number => (kind === 'withdrawal' ? amountMinor : -amountMinor)

/** A return may never push worker debt below zero (no invented worker credit); legacy negatives may not worsen. */
function assertDebtNotNegative(workerId: number, deltaMinor: number): void {
  const before = workerBalances(workerId).debtMinor
  const after = before + deltaMinor
  if (after < 0 && after < before) {
    throw new AppError('CONFLICT', 'لا يمكن أن يتجاوز إرجاع العامل رصيد مسحوباته المستحقة عليه')
  }
}

/** CC04 "دفعة": pays recognised commission payable from a tracked cash/bank account. */
export function payWorkerCommission(
  input: { workerId: number; amountMinor: number; cashAccountId: number; notes?: string; occurredAt?: string; requestKey?: string },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.workers.finance)
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new AppError('VALIDATION_ERROR', 'مبلغ الدفعة يجب أن يكون أكبر من صفر')
  }
  if (!Number.isSafeInteger(input.cashAccountId) || input.cashAccountId <= 0) {
    throw new AppError('VALIDATION_ERROR', 'اختر الخزينة أو الحساب المصرفي للدفعة')
  }
  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'workers.commissionPayment',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        const db = getDatabase()
        if (!db.select().from(workers).where(eq(workers.id, input.workerId)).get()) throw notFound('العامل غير موجود')
        if (!db.select().from(cashAccounts).where(eq(cashAccounts.id, input.cashAccountId)).get()) {
          throw notFound('الحساب النقدي غير موجود')
        }
        if (input.amountMinor > workerBalances(input.workerId).payableMinor) {
          throw new AppError('CONFLICT', 'مبلغ الدفعة أكبر من مستحقات العامل الحالية')
        }
        // OD-04: a tracked account never goes negative.
        if (accountBalance(input.cashAccountId) < input.amountMinor) {
          throw new AppError('CONFLICT', 'رصيد الحساب النقدي لا يكفي لتنفيذ الدفعة')
        }
        const id = Number(
          db.insert(workerTransactions)
            .values({
              workerId: input.workerId,
              kind: 'commission_payment',
              amountMinor: input.amountMinor,
              cashAccountId: input.cashAccountId,
              notes: input.notes ?? null,
              createdBy: ctx.session.user.id,
              createdAt: input.occurredAt ?? nowIso()
            })
            .run().lastInsertRowid
        )
        postCashMovement({
          accountId: input.cashAccountId,
          direction: 'out',
          amountMinor: input.amountMinor,
          kind: 'worker_commission_payment',
          refTable: 'worker_transactions',
          refId: id,
          occurredAt: input.occurredAt ?? today(),
          ctx
        })
        recordAuditEvent({
          userId: ctx.session.user.id,
          action: 'workers.commission.payment',
          entity: 'worker_transactions',
          entityId: String(id),
          details: input
        })
        return id
      })
  })
}

/** BR-85: new manual transactions are withdrawals and repayments only. */
export function recordWorkerTransaction(
  input: {
    workerId: number
    kind: ManualWorkerTransactionKind
    amountMinor: number
    cashAccountId?: number
    notes?: string
    occurredAt?: string
    requestKey?: string
  },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.workers.finance)
  if (input.kind !== 'withdrawal' && input.kind !== 'repayment') {
    throw new AppError('VALIDATION_ERROR', 'نوع حركة العامل غير مسموح')
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new AppError('VALIDATION_ERROR', 'المبلغ يجب أن يكون أكبر من صفر')
  }
  if (!getDatabase().select().from(workers).where(eq(workers.id, input.workerId)).get()) {
    throw notFound('العامل غير موجود')
  }

  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'workers.transaction',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        assertDebtNotNegative(input.workerId, debtEffect(input.kind, input.amountMinor))
        const id = Number(
          getDatabase()
            .insert(workerTransactions)
            .values({
              workerId: input.workerId,
              kind: input.kind,
              amountMinor: input.amountMinor,
              cashAccountId: input.cashAccountId ?? null,
              notes: input.notes ?? null,
              createdBy: ctx.session.user.id,
              createdAt: input.occurredAt ?? nowIso()
            })
            .run().lastInsertRowid
        )

        if (input.kind === 'withdrawal') {
          postCashMovement({
            accountId: input.cashAccountId,
            direction: 'out',
            amountMinor: input.amountMinor,
            kind: 'worker_withdrawal',
            refTable: 'worker_transactions',
            refId: id,
            occurredAt: input.occurredAt ?? today(),
            ctx
          })
        } else if (input.kind === 'repayment') {
          postCashMovement({
            accountId: input.cashAccountId,
            direction: 'in',
            amountMinor: input.amountMinor,
            kind: 'worker_repayment',
            refTable: 'worker_transactions',
            refId: id,
            occurredAt: input.occurredAt ?? today(),
            ctx
          })
        }

        recordAuditEvent({
          userId: ctx.session.user.id,
          action: `workers.${input.kind}`,
          entity: 'worker_transactions',
          entityId: String(id),
          details: input
        })
        return id
      })
  })
}

export function updateWorkerTransaction(
  input: {
    id: number
    expected: WorkerTransactionSnapshot
    amountMinor: number
    cashAccountId?: number | null
    notes?: string | null
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.workers.finance)
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new AppError('VALIDATION_ERROR', 'المبلغ يجب أن يكون أكبر من صفر')
  }

  withTransaction(() => {
    const existing = checkedManualWorkerTransaction(input.id, input.expected)
    const cashRows = linkedWorkerCashRows(input.id)
    assertWorkerCashLink(existing, cashRows)
    assertDebtNotNegative(existing.workerId, debtEffect(existing.kind, input.amountMinor) - debtEffect(existing.kind, existing.amountMinor))
    const nextAccountId =
      input.cashAccountId === undefined ? existing.cashAccountId : input.cashAccountId
    if (
      nextAccountId !== null &&
      !getDatabase().select().from(cashAccounts).where(eq(cashAccounts.id, nextAccountId)).get()
    ) {
      throw notFound('الحساب النقدي غير موجود')
    }
    const nextNotes = input.notes === undefined ? existing.notes : input.notes

    getDatabase()
      .update(workerTransactions)
      .set({
        amountMinor: input.amountMinor,
        cashAccountId: nextAccountId,
        notes: nextNotes
      })
      .where(eq(workerTransactions.id, input.id))
      .run()

    if (cashRows.length === 1 && nextAccountId !== null) {
      adjustCashMovementForRef('worker_transactions', input.id, {
        amountMinor: input.amountMinor,
        accountId: nextAccountId
      })
    } else if (cashRows.length === 1) {
      removeCashMovementForRef('worker_transactions', input.id)
    } else if (nextAccountId !== null) {
      postCashMovement({
        accountId: nextAccountId,
        direction: existing.kind === 'withdrawal' ? 'out' : 'in',
        amountMinor: input.amountMinor,
        kind: existing.kind === 'withdrawal' ? 'worker_withdrawal' : 'worker_repayment',
        refTable: 'worker_transactions',
        refId: input.id,
        occurredAt: existing.createdAt,
        ctx
      })
    }

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: `workers.${existing.kind}.update`,
      entity: 'worker_transactions',
      entityId: String(input.id),
      details: {
        before: existing,
        after: {
          ...existing,
          amountMinor: input.amountMinor,
          cashAccountId: nextAccountId,
          notes: nextNotes
        },
        amountDeltaMinor: input.amountMinor - existing.amountMinor
      }
    })
  })
}

export function deleteWorkerTransaction(
  input: { id: number; expected: WorkerTransactionSnapshot },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.workers.finance)
  withTransaction(() => {
    const existing = checkedManualWorkerTransaction(input.id, input.expected)
    const cashRows = linkedWorkerCashRows(input.id)
    assertWorkerCashLink(existing, cashRows)
    assertDebtNotNegative(existing.workerId, -debtEffect(existing.kind, existing.amountMinor))
    const deleted = getDatabase()
      .delete(workerTransactions)
      .where(eq(workerTransactions.id, input.id))
      .run().changes
    if (deleted !== 1) throw new AppError('CONFLICT', 'تم حذف حركة العامل بالفعل')
    removeCashMovementForRef('worker_transactions', input.id)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: `workers.${existing.kind}.delete`,
      entity: 'worker_transactions',
      entityId: String(input.id),
      details: { before: existing, reversedByUserId: ctx.session.user.id }
    })
  })
}

export function workerStatement(workerId: number, request: PageRequest = {}) {
  const worker = getDatabase().select().from(workers).where(eq(workers.id, workerId)).get()
  if (!worker) throw notFound('العامل غير موجود')
  return {
    worker,
    ...workerBalances(workerId),
    // "سجل المسحوبات والمرتجعات": the worker-debt ledger only; commission rows never appear here.
    transactions: keysetPage({
      scope: 'workers.statement.transactions',
      filters: { workerId },
      request,
      defaultLimit: PAGE_SIZE.statement,
      keyTypes: ['int'],
      order: 'desc',
      keyOf: (row) => [row.id],
      fetch: (window: KeysetWindow) => getDatabase()
        .select()
        .from(workerTransactions)
        .where(and(eq(workerTransactions.workerId, workerId), sql`${workerTransactions.kind} IN ('withdrawal', 'repayment')`, keysetBoundary([sql`${workerTransactions.id}`], window)))
        .orderBy(keysetOrder([sql`${workerTransactions.id}`], window))
        .limit(window.take)
        .all()
        .map((row) => ({ ...row, manual: isManualWorkerTransaction(row) })),
      summary: () => undefined
    })
  }
}
