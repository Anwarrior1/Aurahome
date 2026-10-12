import { and, eq, sql } from 'drizzle-orm'
import { getDatabase, getRawConnection } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import { releases } from '../../db/schema/production.schema'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { requirePermission } from '../../permissions/permission-guard'
import { AppError, notFound } from '../../utils/errors'
import { stateToken } from '../../utils/state-token'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { nowIso, type ServiceContext } from '../base/service.types'
import { buildRelease } from '../documents/documents.service'
import { assertOrderOperational } from '../sales/orders.service'

function releaseReversalToken(id: number): string {
  const db = getDatabase()
  return stateToken({ permit: db.select().from(releases).where(eq(releases.id, id)).get(),
    deliveries: db.all(sql`SELECT id, status FROM deliveries WHERE release_id = ${id} ORDER BY id`) })
}

/** Independent permit reversal retains its own permission and current-state token. */
export function reverseRelease(input: { id: number; expectedToken: string }, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.releases.reverse)
  withTransaction(() => {
    if (!input.expectedToken) throw new AppError('VALIDATION_ERROR', 'رمز حالة إذن الخروج مطلوب')
    reverseReleaseInternal(input.id, ctx, input.expectedToken)
  })
}

/** Called only after cancelOrder has changed the parent inside its transaction. */
export function reverseCancelledOrderReleases(orderId: number, ctx: ServiceContext): number[] {
  requirePermission(ctx.session, P.orders.cancel)
  if (!getRawConnection().inTransaction || assertOrderOperational(orderId).status !== 'cancelled')
    throw new AppError('CONFLICT', 'عكس أذونات الخروج التلقائي يتطلب معاملة إلغاء الطلب')
  const active = getDatabase().select({ id: releases.id }).from(releases)
    .where(and(eq(releases.orderId, orderId), eq(releases.status, 'active'))).all()
  for (const permit of active) reverseReleaseInternal(permit.id, ctx)
  return active.map((permit) => permit.id)
}

function reverseReleaseInternal(id: number, ctx: ServiceContext, expectedToken?: string): void {
  const db = getDatabase()
  const permit = db.select().from(releases).where(eq(releases.id, id)).get()
  if (!permit) throw notFound('إذن الخروج غير موجود')
  const order = assertOrderOperational(permit.orderId)
  if (permit.status !== 'active') throw new AppError('CONFLICT', 'تم التراجع عن إذن الخروج بالفعل')
  if (db.get(sql`SELECT id FROM deliveries WHERE order_id = ${permit.orderId} AND status = 'recorded' LIMIT 1`)) throw new AppError('CONFLICT', 'لا يمكن التراجع عن إذن الخروج قبل التراجع عن عملية التسليم والتركيب المرتبطة من وحدتها')
  if (order.completedAt || order.status === 'completed') throw new AppError('CONFLICT', 'تراجع عن إكمال الطلب أولاً من صفحة الطلب')
  if (expectedToken !== undefined && releaseReversalToken(id) !== expectedToken) throw new AppError('CONFLICT', 'تغير إذن الخروج منذ عرضه. حدّث القائمة ثم حاول مجدداً')
  const documentSnapshot = JSON.stringify(buildRelease(id))
  const reversedAt = nowIso()
  const changed = db.update(releases).set({ status: 'reversed', reversedAt, reversedBy: ctx.session.user.id, documentSnapshot })
    .where(and(eq(releases.id, id), eq(releases.status, 'active'))).run().changes
  if (changed !== 1) throw new AppError('CONFLICT', 'تم التراجع عن إذن الخروج بالفعل')
  recordAuditEvent({ userId: ctx.session.user.id, action: 'releases.reverse', entity: 'releases', entityId: String(id), details: { orderId: permit.orderId, documentNumber: permit.documentNumber, beforeStatus: 'active', afterStatus: 'reversed', reversedAt } })
}
