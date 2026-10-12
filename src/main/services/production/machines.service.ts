import { and, eq, like, sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import { machines, orderMachineUsage } from '../../db/schema/production.schema'
import { orders } from '../../db/schema/sales.schema'
import { AppError, notFound } from '../../utils/errors'
import { costOf, unitCostMicro } from '@shared/money/cost'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, type ServiceContext } from '../base/service.types'
import { assertProductionOpen, assertResourceMutationOpen } from './production.service'
import { assertOrderOperational } from '../sales/orders.service'
import { requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { requireSafeNonNegativeInteger, requireSafePositiveInteger } from '../../utils/numeric'

/** BR-36/BR-89: each machine carries its own user-defined costing unit. */
export function listMachines(filter: { search?: string; activeOnly?: boolean } = {}) {
  const clauses = []
  if (filter.search?.trim()) clauses.push(like(machines.name, `%${filter.search.trim()}%`))
  if (filter.activeOnly) clauses.push(eq(machines.active, true))
  return getDatabase()
    .select()
    .from(machines)
    .where(clauses.length ? and(...clauses) : undefined)
    .all()
}

export function createMachine(
  input: { name: string; costingUnit: string; defaultRateMicro: number; notes?: string },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.machines.manage)
  return withTransaction(() => {
    requireSafeNonNegativeInteger(input.defaultRateMicro, 'تكلفة الآلة')
    if (!input.costingUnit?.trim()) {
      throw new AppError('VALIDATION_ERROR', 'وحدة التكلفة مطلوبة')
    }
    const id = Number(
      getDatabase()
        .insert(machines)
        .values({
          name: input.name,
          costingUnit: input.costingUnit,
          defaultRateMicro: input.defaultRateMicro,
          notes: input.notes ?? null,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'machines.create',
      entity: 'machines',
      entityId: String(id),
      details: input
    })
    return id
  })
}

export function updateMachine(id: number, input: Record<string, unknown>, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.machines.manage)
  return withTransaction(() => {
    if (input.defaultRateMicro !== undefined) {
      requireSafeNonNegativeInteger(input.defaultRateMicro as number, 'تكلفة الآلة')
    }
    if (!getDatabase().select().from(machines).where(eq(machines.id, id)).get()) {
      throw notFound('الآلة غير موجودة')
    }
    getDatabase().update(machines).set(input as never).where(eq(machines.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'machines.update',
      entity: 'machines',
      entityId: String(id),
      details: input
    })
  })
}

/** Item 8: a machine is ordinary master data; blocked once real usage
 *  exists on an order (that usage feeds BR-19/BR-20 actual cost). */
export function deleteMachine(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.machines.manage)
  return withTransaction(() => {
    if (!getDatabase().select().from(machines).where(eq(machines.id, id)).get()) {
      throw notFound('الآلة غير موجودة')
    }
    const usageCount = getDatabase()
      .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM order_machine_usage WHERE machine_id = ${id}`)?.c ?? 0
    if (usageCount > 0) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن حذف هذه الآلة لوجود استخدام مسجّل عليها ضمن تكاليف الطلبات. يمكنك تعطيلها بدلاً من ذلك'
      )
    }
    getDatabase().delete(machines).where(eq(machines.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'machines.delete',
      entity: 'machines',
      entityId: String(id)
    })
  })
}

/**
 * BR-90: cost is calculated automatically as usage × rate, but the
 * calculated amount stays editable per order — and the FINAL edited
 * amount is what feeds the order's actual cost.
 */
/**
 * BR-90 + item 15: machine usage recorded during production.
 *
 * Usage may name the customer order (unchanged) or the production order
 * it happened on; giving the production order resolves the customer
 * order from it, so the cost still reaches the order's actual cost and
 * traceability in both directions is preserved. Stock production orders
 * carry usage with no customer order at all.
 */
export function addMachineUsage(
  input: {
    orderId?: number
    workSheetId?: number
    machineId: number
    usageQtyMicro: number
    rateMicro?: number
    finalAmountMinor?: number
    notes?: string
  },
  ctx: ServiceContext
): { id: number; calculatedMinor: number; finalAmountMinor: number } {
  requirePermission(ctx.session, P.worksheets.issue)
  return withTransaction(() => {
    assertResourceMutationOpen(input)
    const sheet = input.workSheetId ? assertProductionOpen(input.workSheetId) : undefined
    const orderId = input.orderId ?? sheet?.orderId ?? null
    if (orderId) assertOrderOperational(orderId)
    if (!orderId && !sheet) {
      throw new AppError('VALIDATION_ERROR', 'يجب تحديد الطلب أو أمر التصنيع')
    }
    if (input.orderId && sheet?.orderId && sheet.orderId !== input.orderId) {
      throw new AppError('VALIDATION_ERROR', 'أمر التصنيع لا يخص هذا الطلب')
    }
    if (orderId && !getDatabase().select().from(orders).where(eq(orders.id, orderId)).get()) {
      throw notFound('الطلب غير موجود')
    }
    const machine = getDatabase().select().from(machines).where(eq(machines.id, input.machineId)).get()
    if (!machine) throw notFound('الآلة غير موجودة')
    requireSafePositiveInteger(input.usageQtyMicro, 'كمية الاستخدام')

    const rateMicro = input.rateMicro ?? machine.defaultRateMicro
    requireSafeNonNegativeInteger(rateMicro, 'تكلفة الآلة')
    const calculatedMinor = costOf(input.usageQtyMicro, unitCostMicro(rateMicro))
    const finalAmountMinor = input.finalAmountMinor ?? calculatedMinor
    requireSafeNonNegativeInteger(finalAmountMinor, 'التكلفة النهائية')

    const id = Number(
      getDatabase()
        .insert(orderMachineUsage)
        .values({
          orderId,
          workSheetId: sheet?.id ?? null,
          machineId: input.machineId,
          usageQtyMicro: input.usageQtyMicro,
          rateMicro,
          calculatedMinor,
          finalAmountMinor,
          notes: input.notes ?? null,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.machine.add',
      entity: 'order_machine_usage',
      entityId: String(id),
      details: { ...input, calculatedMinor, finalAmountMinor }
    })
    return { id, calculatedMinor, finalAmountMinor }
  })
}

export function updateMachineUsage(
  id: number,
  input: { usageQtyMicro?: number; rateMicro?: number; finalAmountMinor?: number; notes?: string },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.worksheets.issue)
  if (input.usageQtyMicro !== undefined) requireSafePositiveInteger(input.usageQtyMicro, 'كمية الاستخدام')
  if (input.rateMicro !== undefined) requireSafeNonNegativeInteger(input.rateMicro, 'تكلفة الآلة')
  if (input.finalAmountMinor !== undefined) requireSafeNonNegativeInteger(input.finalAmountMinor, 'التكلفة النهائية')
  withTransaction(() => {
    const existing = getDatabase()
      .select()
      .from(orderMachineUsage)
      .where(eq(orderMachineUsage.id, id))
      .get()
    if (!existing) throw notFound('سجل استخدام الآلة غير موجود')
    if (existing.reversedAt) throw new AppError('CONFLICT', 'تم التراجع عن استخدام الآلة بالفعل')
    assertResourceMutationOpen(existing)

    const usageQtyMicro = input.usageQtyMicro ?? existing.usageQtyMicro
    const rateMicro = input.rateMicro ?? existing.rateMicro
    const calculatedMinor = costOf(usageQtyMicro, unitCostMicro(rateMicro))
    const finalAmountMinor = input.finalAmountMinor ?? (
      input.usageQtyMicro !== undefined || input.rateMicro !== undefined
        ? calculatedMinor
        : existing.finalAmountMinor
    )

    getDatabase()
      .update(orderMachineUsage)
      .set({
        usageQtyMicro,
        rateMicro,
        calculatedMinor,
        finalAmountMinor,
        notes: input.notes ?? existing.notes
      })
      .where(eq(orderMachineUsage.id, id))
      .run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.machine.update',
      entity: 'order_machine_usage',
      entityId: String(id),
      details: input
    })
  })
}

export function removeMachineUsage(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.worksheets.issue)
  return withTransaction(() => {
    const row = getDatabase().select().from(orderMachineUsage).where(eq(orderMachineUsage.id, id)).get()
    if (!row) throw notFound('سجل استخدام الآلة غير موجود')
    if (row?.reversedAt) throw new AppError('CONFLICT', 'لا يمكن حذف سجل تاريخي تم التراجع عنه')
    assertResourceMutationOpen(row)
    getDatabase().delete(orderMachineUsage).where(eq(orderMachineUsage.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'orders.machine.remove',
      entity: 'order_machine_usage',
      entityId: String(id)
    })
  })
}

export function machineUsageForOrder(orderId: number) {
  return getDatabase()
    .select({
      id: orderMachineUsage.id,
      machineId: orderMachineUsage.machineId,
      machineName: machines.name,
      costingUnit: machines.costingUnit,
      usageQtyMicro: orderMachineUsage.usageQtyMicro,
      rateMicro: orderMachineUsage.rateMicro,
      calculatedMinor: orderMachineUsage.calculatedMinor,
      finalAmountMinor: orderMachineUsage.finalAmountMinor,
      notes: orderMachineUsage.notes
    })
    .from(orderMachineUsage)
    .innerJoin(machines, eq(orderMachineUsage.machineId, machines.id))
    .where(and(eq(orderMachineUsage.orderId, orderId), sql`${orderMachineUsage.reversedAt} IS NULL`))
    .all()
}

/** The same shape, keyed by production order (item 15). */
/** The same shape, keyed by production order (item 15). */
export function machineUsageForWorkSheet(workSheetId: number) {
  return getDatabase()
    .select({
      id: orderMachineUsage.id,
      machineId: orderMachineUsage.machineId,
      machineName: machines.name,
      costingUnit: machines.costingUnit,
      usageQtyMicro: orderMachineUsage.usageQtyMicro,
      rateMicro: orderMachineUsage.rateMicro,
      calculatedMinor: orderMachineUsage.calculatedMinor,
      finalAmountMinor: orderMachineUsage.finalAmountMinor,
      notes: orderMachineUsage.notes
    })
    .from(orderMachineUsage)
    .innerJoin(machines, eq(orderMachineUsage.machineId, machines.id))
    .where(and(eq(orderMachineUsage.workSheetId, workSheetId), sql`${orderMachineUsage.reversedAt} IS NULL`))
    .all()
}
