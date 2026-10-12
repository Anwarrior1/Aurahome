import { eq, sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import {
  materialReturnAllocations,
  materialReturnEvents,
  materialReturns
} from '../../db/schema/production.schema'
import { inventoryRepository } from '../../repositories/inventory/inventory.repository'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { costOf, unitCostMicro } from '@shared/money/cost'
import { AppError, notFound } from '../../utils/errors'
import { clearLowStockStateIfResolved } from '../notifications/notification-state.service'
import { nowIso, type ServiceContext } from '../base/service.types'

const MICRO = 1_000_000

type ReturnRow = typeof materialReturns.$inferSelect

interface IssueAllocationCandidate {
  fifoAllocationId: number
  issueLineId: number
  qtyMicro: number
  costMinor: number
  unitCostMicro: number
  returnedQtyMicro: number
  returnedCostMinor: number
}

interface ReturnLayerCandidate {
  returnLayerId: number
  fifoAllocationId: number
  issueLineId: number
  unitCostMicro: number
  activeQtyMicro: number
  activeCostMinor: number
  remainingQtyMicro: number
}

interface CostChunk {
  fifoAllocationId: number
  issueLineId: number
  returnLayerId?: number
  qtyMicro: number
  unitCostMicro: number
  costMinor: number
}

function assertQuantity(qtyMicro: number): void {
  if (!Number.isSafeInteger(qtyMicro) || qtyMicro <= 0) {
    throw new AppError('VALIDATION_ERROR', 'الكمية المراد إرجاعها يجب أن تكون أكبر من صفر')
  }
}

function returnOrThrow(id: number): ReturnRow {
  const row = getDatabase().select().from(materialReturns).where(eq(materialReturns.id, id)).get()
  if (!row) throw notFound('مرتجع المادة غير موجود')
  return row
}

function assertActive(row: ReturnRow): void {
  if (row.status !== 'active') throw new AppError('CONFLICT', 'مرتجع المادة ملغى بالفعل')
}

function existingRequest(requestKey: string, kind: string): ReturnRow | undefined {
  const event = getDatabase()
    .select({ returnId: materialReturnEvents.returnId, kind: materialReturnEvents.kind })
    .from(materialReturnEvents)
    .where(eq(materialReturnEvents.requestKey, requestKey))
    .get()
  if (!event) return undefined
  if (event.kind !== kind) {
    throw new AppError('CONFLICT', 'مفتاح الطلب مستخدم لعملية أخرى')
  }
  return returnOrThrow(event.returnId)
}

function assertOrderAcceptsReturns(orderId: number): void {
  const order = getDatabase().get<{ status: string }>(
    sql`SELECT status FROM orders WHERE id = ${orderId}`
  )
  if (!order) throw notFound('الطلب غير موجود')
  if (getDatabase().get(sql`
    SELECT 1 FROM work_sheets WHERE order_id = ${orderId} AND status = 'completed' LIMIT 1
  `)) throw new AppError('CONFLICT', 'لا يمكن تعديل مرتجع مواد بعد إكمال التصنيع')
  if (order.status === 'cancelled' && !getDatabase().get(sql`
    SELECT 1 FROM work_sheets WHERE order_id = ${orderId}
      AND status = 'in_production' AND started_at IS NOT NULL LIMIT 1
  `)) {
    throw new AppError('CONFLICT', 'لا يمكن تسجيل مرتجع مواد لطلب ملغى')
  }
}

function issueCandidates(orderId: number, materialId: number): IssueAllocationCandidate[] {
  return getDatabase().all<IssueAllocationCandidate>(sql`
    SELECT
      fa.id AS fifoAllocationId,
      oml.id AS issueLineId,
      fa.qty_micro AS qtyMicro,
      fa.cost_minor AS costMinor,
      fa.unit_cost_micro AS unitCostMicro,
      COALESCE((
        SELECT SUM(mra.qty_micro)
        FROM material_return_allocations mra
        JOIN material_returns mr ON mr.id = mra.return_id
        WHERE mra.fifo_allocation_id = fa.id AND mr.status = 'active'
      ), 0) AS returnedQtyMicro,
      COALESCE((
        SELECT SUM(mra.cost_minor)
        FROM material_return_allocations mra
        JOIN material_returns mr ON mr.id = mra.return_id
        WHERE mra.fifo_allocation_id = fa.id AND mr.status = 'active'
      ), 0) AS returnedCostMinor
    FROM order_material_lines oml
    JOIN inventory_movements im ON im.id = oml.movement_id AND im.kind = 'consumption'
    JOIN fifo_allocations fa ON fa.movement_id = im.id
    WHERE oml.order_id = ${orderId}
      AND oml.material_id = ${materialId}
      AND oml.status = 'active'
    ORDER BY oml.id DESC, fa.id DESC
  `)
}

function positiveChunks(orderId: number, materialId: number, qtyMicro: number): CostChunk[] {
  let remaining = qtyMicro
  const chunks: CostChunk[] = []
  for (const source of issueCandidates(orderId, materialId)) {
    if (remaining <= 0) break
    const available = source.qtyMicro - source.returnedQtyMicro
    if (available <= 0) continue
    const take = Math.min(remaining, available)
    // Taking the whole remainder also takes the exact remaining rounded
    // allocation cost; partial quantities use the allocation's frozen rate.
    const costMinor = take === available
      ? source.costMinor - source.returnedCostMinor
      : costOf(take, unitCostMicro(source.unitCostMicro))
    chunks.push({
      fifoAllocationId: source.fifoAllocationId,
      issueLineId: source.issueLineId,
      qtyMicro: take,
      unitCostMicro: source.unitCostMicro,
      costMinor
    })
    remaining -= take
  }
  if (remaining > 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'الكمية المراد إرجاعها أكبر من الكمية المتاحة للإرجاع لهذا الطلب'
    )
  }
  return chunks
}

function returnLayerCandidates(returnId: number): ReturnLayerCandidate[] {
  return getDatabase().all<ReturnLayerCandidate>(sql`
    SELECT
      mra.return_layer_id AS returnLayerId,
      mra.fifo_allocation_id AS fifoAllocationId,
      mra.issue_line_id AS issueLineId,
      mra.unit_cost_micro AS unitCostMicro,
      SUM(mra.qty_micro) AS activeQtyMicro,
      SUM(mra.cost_minor) AS activeCostMinor,
      fl.qty_remaining_micro AS remainingQtyMicro
    FROM material_return_allocations mra
    JOIN fifo_layers fl ON fl.id = mra.return_layer_id
    WHERE mra.return_id = ${returnId}
    GROUP BY mra.return_layer_id, mra.fifo_allocation_id, mra.issue_line_id, mra.unit_cost_micro
    HAVING SUM(mra.qty_micro) > 0
    ORDER BY mra.return_layer_id DESC
  `)
}

function negativeChunks(row: ReturnRow, qtyMicro: number): CostChunk[] {
  const material = getDatabase().get<{ name: string; unit: string }>(sql`
    SELECT name, unit FROM materials WHERE id = ${row.materialId}
  `)
  const candidates = returnLayerCandidates(row.id)
  const reversible = candidates.reduce(
    (sum, item) => sum + Math.min(item.activeQtyMicro, item.remainingQtyMicro),
    0
  )
  if (reversible < qtyMicro) {
    throw new AppError(
      'INSUFFICIENT_STOCK',
      `لا يمكن عكس المرتجع لأن الكمية المرتجعة من "${material?.name ?? 'المادة'}" لم تعد متاحة بالكامل في المخزون. المتاح للعكس: ${reversible / MICRO} ${material?.unit ?? ''}`
    )
  }

  let remaining = qtyMicro
  const chunks: CostChunk[] = []
  for (const source of candidates) {
    if (remaining <= 0) break
    const available = Math.min(source.activeQtyMicro, source.remainingQtyMicro)
    if (available <= 0) continue
    const take = Math.min(remaining, available)
    const costMinor = take === source.activeQtyMicro
      ? source.activeCostMinor
      : costOf(take, unitCostMicro(source.unitCostMicro))
    chunks.push({
      fifoAllocationId: source.fifoAllocationId,
      issueLineId: source.issueLineId,
      returnLayerId: source.returnLayerId,
      qtyMicro: take,
      unitCostMicro: source.unitCostMicro,
      costMinor
    })
    remaining -= take
  }
  return chunks
}

function insertEvent(input: {
  row: ReturnRow
  kind: 'create' | 'edit' | 'reverse'
  afterQtyMicro: number
  deltaQtyMicro: number
  costEffectMinor: number
  requestKey: string
  expectedVersion: number
  notesAfter: string | null
  userId: number
  createdAt: string
}): number {
  return Number(
    getDatabase()
      .insert(materialReturnEvents)
      .values({
        returnId: input.row.id,
        kind: input.kind,
        beforeQtyMicro: input.row.quantityMicro,
        afterQtyMicro: input.afterQtyMicro,
        deltaQtyMicro: input.deltaQtyMicro,
        costEffectMinor: input.costEffectMinor,
        movementId: null,
        requestKey: input.requestKey,
        expectedVersion: input.expectedVersion,
        notesBefore: input.row.notes,
        notesAfter: input.notesAfter,
        createdBy: input.userId,
        createdAt: input.createdAt
      })
      .run().lastInsertRowid
  )
}

function postPositiveDelta(input: {
  row: ReturnRow
  kind: 'create' | 'edit'
  qtyMicro: number
  afterQtyMicro: number
  requestKey: string
  expectedVersion: number
  notesAfter: string | null
  userId: number
  createdAt: string
}): { eventId: number; movementId: number; costMinor: number } {
  const chunks = positiveChunks(input.row.orderId, input.row.materialId, input.qtyMicro)
  const costMinor = chunks.reduce((sum, chunk) => sum + chunk.costMinor, 0)
  const eventId = insertEvent({
    ...input,
    deltaQtyMicro: input.qtyMicro,
    costEffectMinor: costMinor
  })
  const movementId = inventoryRepository.insertMovement({
    materialId: input.row.materialId,
    kind: 'material_return',
    qtyMicro: input.qtyMicro,
    orderId: input.row.orderId,
    actualCostMinor: -costMinor,
    sourceKind: 'material_return_event',
    sourceRefId: eventId,
    reason: input.notesAfter,
    createdBy: input.userId,
    createdAt: input.createdAt
  })
  getDatabase()
    .update(materialReturnEvents)
    .set({ movementId })
    .where(eq(materialReturnEvents.id, eventId))
    .run()

  for (const chunk of chunks) {
    const returnLayerId = inventoryRepository.insertLayer({
      materialId: input.row.materialId,
      sourceKind: 'material_return_event',
      sourceRefId: eventId,
      qtyMicro: chunk.qtyMicro,
      unitCostMicro: chunk.unitCostMicro,
      receivedAt: input.createdAt,
      seq: inventoryRepository.nextSeq(input.row.materialId)
    })
    getDatabase().insert(materialReturnAllocations).values({
      eventId,
      returnId: input.row.id,
      issueLineId: chunk.issueLineId,
      fifoAllocationId: chunk.fifoAllocationId,
      returnLayerId,
      qtyMicro: chunk.qtyMicro,
      unitCostMicro: chunk.unitCostMicro,
      costMinor: chunk.costMinor,
      createdAt: input.createdAt
    }).run()
  }
  clearLowStockStateIfResolved(input.row.materialId)
  return { eventId, movementId, costMinor }
}

function postNegativeDelta(input: {
  row: ReturnRow
  kind: 'edit' | 'reverse'
  qtyMicro: number
  afterQtyMicro: number
  requestKey: string
  expectedVersion: number
  notesAfter: string | null
  userId: number
  createdAt: string
}): { eventId: number; movementId: number; costMinor: number } {
  const chunks = negativeChunks(input.row, input.qtyMicro)
  const costMinor = chunks.reduce((sum, chunk) => sum + chunk.costMinor, 0)
  const eventId = insertEvent({
    ...input,
    deltaQtyMicro: -input.qtyMicro,
    costEffectMinor: -costMinor
  })
  const movementId = inventoryRepository.insertMovement({
    materialId: input.row.materialId,
    kind: 'material_return_reversal',
    qtyMicro: input.qtyMicro,
    orderId: input.row.orderId,
    actualCostMinor: costMinor,
    sourceKind: 'material_return_event',
    sourceRefId: eventId,
    reason: input.kind === 'reverse' ? 'عكس مرتجع مادة خام' : 'تخفيض كمية مرتجع مادة خام',
    createdBy: input.userId,
    createdAt: input.createdAt
  })
  getDatabase()
    .update(materialReturnEvents)
    .set({ movementId })
    .where(eq(materialReturnEvents.id, eventId))
    .run()

  for (const chunk of chunks) {
    if (!inventoryRepository.decrementLayer(chunk.returnLayerId!, chunk.qtyMicro)) {
      throw new AppError('CONFLICT', 'تعذر عكس مخزون المرتجع بأمان. لم يتم تغيير أي بيانات')
    }
    inventoryRepository.insertAllocation({
      movementId,
      layerId: chunk.returnLayerId!,
      qtyMicro: chunk.qtyMicro,
      unitCostMicro: chunk.unitCostMicro,
      costMinor: chunk.costMinor
    })
    getDatabase().insert(materialReturnAllocations).values({
      eventId,
      returnId: input.row.id,
      issueLineId: chunk.issueLineId,
      fifoAllocationId: chunk.fifoAllocationId,
      returnLayerId: chunk.returnLayerId!,
      qtyMicro: -chunk.qtyMicro,
      unitCostMicro: chunk.unitCostMicro,
      costMinor: -chunk.costMinor,
      createdAt: input.createdAt
    }).run()
  }
  return { eventId, movementId, costMinor }
}

export interface MaterialReturnView {
  id: number
  orderId: number
  materialId: number
  materialName: string
  unit: string
  quantityMicro: number
  returnedCostMinor: number
  notes: string | null
  status: string
  version: number
  createdBy: number | null
  username: string | null
  createdAt: string
  updatedAt: string | null
}

export interface MaterialConsumptionSummary {
  materialId: number
  materialName: string
  unit: string
  issuedQtyMicro: number
  issuedCostMinor: number
  returnedQtyMicro: number
  returnedCostMinor: number
  returnableQtyMicro: number
  netConsumedQtyMicro: number
  netCostMinor: number
}

export function materialConsumptionSummaryForOrder(orderId: number): MaterialConsumptionSummary[] {
  return getDatabase().all<MaterialConsumptionSummary>(sql`
    SELECT
      oml.material_id AS materialId,
      m.name AS materialName,
      m.unit AS unit,
      SUM(oml.physical_qty_micro) AS issuedQtyMicro,
      SUM(oml.actual_cost_minor) AS issuedCostMinor,
      COALESCE((
        SELECT SUM(mr.quantity_micro)
        FROM material_returns mr
        WHERE mr.order_id = ${orderId}
          AND mr.material_id = oml.material_id
          AND mr.status = 'active'
      ), 0) AS returnedQtyMicro,
      COALESCE((
        SELECT SUM(mr.returned_cost_minor)
        FROM material_returns mr
        WHERE mr.order_id = ${orderId}
          AND mr.material_id = oml.material_id
          AND mr.status = 'active'
      ), 0) AS returnedCostMinor,
      SUM(oml.physical_qty_micro) - COALESCE((
        SELECT SUM(mr.quantity_micro)
        FROM material_returns mr
        WHERE mr.order_id = ${orderId}
          AND mr.material_id = oml.material_id
          AND mr.status = 'active'
      ), 0) AS returnableQtyMicro,
      SUM(oml.physical_qty_micro) - COALESCE((
        SELECT SUM(mr.quantity_micro)
        FROM material_returns mr
        WHERE mr.order_id = ${orderId}
          AND mr.material_id = oml.material_id
          AND mr.status = 'active'
      ), 0) AS netConsumedQtyMicro,
      SUM(oml.actual_cost_minor) - COALESCE((
        SELECT SUM(mr.returned_cost_minor)
        FROM material_returns mr
        WHERE mr.order_id = ${orderId}
          AND mr.material_id = oml.material_id
          AND mr.status = 'active'
      ), 0) AS netCostMinor
    FROM order_material_lines oml
    JOIN materials m ON m.id = oml.material_id
    WHERE oml.order_id = ${orderId} AND oml.status = 'active'
    GROUP BY oml.material_id, m.name, m.unit
    ORDER BY MIN(oml.id)
  `)
}

export function listMaterialReturns(orderId: number): MaterialReturnView[] {
  return getDatabase().all<MaterialReturnView>(sql`
    SELECT
      mr.id AS id,
      mr.order_id AS orderId,
      mr.material_id AS materialId,
      m.name AS materialName,
      m.unit AS unit,
      mr.quantity_micro AS quantityMicro,
      mr.returned_cost_minor AS returnedCostMinor,
      mr.notes AS notes,
      mr.status AS status,
      mr.version AS version,
      mr.created_by AS createdBy,
      u.username AS username,
      mr.created_at AS createdAt,
      mr.updated_at AS updatedAt
    FROM material_returns mr
    JOIN materials m ON m.id = mr.material_id
    LEFT JOIN users u ON u.id = mr.created_by
    WHERE mr.order_id = ${orderId} AND mr.status = 'active'
    ORDER BY mr.id DESC
  `)
}

export function getMaterialReturnsOverview(orderId: number) {
  const order = getDatabase().get<{ id: number }>(sql`SELECT id FROM orders WHERE id = ${orderId}`)
  if (!order) throw notFound('الطلب غير موجود')
  return {
    materials: materialConsumptionSummaryForOrder(orderId),
    returns: listMaterialReturns(orderId)
  }
}

export function activeReturnCostForOrder(orderId: number): number {
  return getDatabase().get<{ total: number }>(sql`
    SELECT COALESCE(SUM(returned_cost_minor), 0) AS total
    FROM material_returns WHERE order_id = ${orderId} AND status = 'active'
  `)?.total ?? 0
}

export function returnTotalsForIssueLine(issueLineId: number): { qtyMicro: number; costMinor: number } {
  return getDatabase().get<{ qtyMicro: number; costMinor: number }>(sql`
    SELECT
      COALESCE(SUM(mra.qty_micro), 0) AS qtyMicro,
      COALESCE(SUM(mra.cost_minor), 0) AS costMinor
    FROM material_return_allocations mra
    JOIN material_returns mr ON mr.id = mra.return_id
    WHERE mra.issue_line_id = ${issueLineId} AND mr.status = 'active'
  `) ?? { qtyMicro: 0, costMinor: 0 }
}

export function activeReturnCostForWorkSheet(workSheetId: number): number {
  return getDatabase().get<{ total: number }>(sql`
    SELECT COALESCE(SUM(mra.cost_minor), 0) AS total
    FROM material_return_allocations mra
    JOIN material_returns mr ON mr.id = mra.return_id
    JOIN order_material_lines oml ON oml.id = mra.issue_line_id
    WHERE oml.work_sheet_id = ${workSheetId} AND mr.status = 'active'
  `)?.total ?? 0
}

export function hasActiveReturnsForIssueLine(issueLineId: number): boolean {
  return (getDatabase().get<{ c: number }>(sql`
    SELECT COUNT(*) AS c
    FROM material_return_allocations mra
    JOIN material_returns mr ON mr.id = mra.return_id
    WHERE mra.issue_line_id = ${issueLineId} AND mr.status = 'active'
    GROUP BY mra.return_id
    HAVING SUM(mra.qty_micro) > 0
    LIMIT 1
  `)?.c ?? 0) > 0
}

export function createMaterialReturn(input: {
  orderId: number
  materialId: number
  quantityMicro: number
  notes?: string | null
  requestKey: string
}, ctx: ServiceContext): ReturnRow {
  assertQuantity(input.quantityMicro)
  return withTransaction(() => {
    requirePermission(ctx.session, P.production.returnMaterial)
    const duplicate = existingRequest(input.requestKey, 'create')
    if (duplicate) {
      if (duplicate.orderId !== input.orderId || duplicate.materialId !== input.materialId) {
        throw new AppError('CONFLICT', 'مفتاح الطلب مستخدم لمرتجع آخر')
      }
      return duplicate
    }
    assertOrderAcceptsReturns(input.orderId)
    const summary = materialConsumptionSummaryForOrder(input.orderId)
      .find((row) => row.materialId === input.materialId)
    if (!summary) throw new AppError('VALIDATION_ERROR', 'هذه المادة لم تُصرف فعلياً لهذا الطلب')
    if (input.quantityMicro > summary.returnableQtyMicro) {
      throw new AppError('VALIDATION_ERROR', 'الكمية المراد إرجاعها أكبر من الكمية المتاحة للإرجاع')
    }

    const createdAt = nowIso()
    const id = Number(getDatabase().insert(materialReturns).values({
      orderId: input.orderId,
      materialId: input.materialId,
      quantityMicro: 0,
      returnedCostMinor: 0,
      status: 'active',
      notes: input.notes?.trim() || null,
      version: 0,
      createdBy: ctx.session.user.id,
      createdAt
    }).run().lastInsertRowid)
    const draft = returnOrThrow(id)
    const posted = postPositiveDelta({
      row: draft,
      kind: 'create',
      qtyMicro: input.quantityMicro,
      afterQtyMicro: input.quantityMicro,
      requestKey: input.requestKey,
      expectedVersion: 0,
      notesAfter: input.notes?.trim() || null,
      userId: ctx.session.user.id,
      createdAt
    })
    getDatabase().update(materialReturns).set({
      quantityMicro: input.quantityMicro,
      returnedCostMinor: posted.costMinor,
      version: 1
    }).where(eq(materialReturns.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'production.materialReturn.create',
      entity: 'material_returns',
      entityId: String(id),
      details: {
        orderId: input.orderId,
        materialId: input.materialId,
        quantityMicro: input.quantityMicro,
        costEffectMinor: posted.costMinor,
        movementId: posted.movementId,
        requestKey: input.requestKey
      }
    })
    return returnOrThrow(id)
  })
}

export function editMaterialReturn(input: {
  id: number
  quantityMicro: number
  notes?: string | null
  expectedVersion: number
  requestKey: string
}, ctx: ServiceContext): ReturnRow {
  assertQuantity(input.quantityMicro)
  return withTransaction(() => {
    requirePermission(ctx.session, P.production.returnMaterial)
    const duplicate = existingRequest(input.requestKey, 'edit')
    if (duplicate) {
      if (duplicate.id !== input.id) throw new AppError('CONFLICT', 'مفتاح الطلب مستخدم لمرتجع آخر')
      return duplicate
    }
    const row = returnOrThrow(input.id)
    assertActive(row)
    if (row.version !== input.expectedVersion) {
      throw new AppError('CONFLICT', 'تم تعديل المرتجع من جلسة أخرى. حدّث البيانات ثم حاول مجدداً')
    }
    assertOrderAcceptsReturns(row.orderId)

    const notesAfter = input.notes?.trim() || null
    const delta = input.quantityMicro - row.quantityMicro
    const createdAt = nowIso()
    let costEffectMinor = 0
    let movementId: number | null = null
    if (delta > 0) {
      const posted = postPositiveDelta({
        row,
        kind: 'edit',
        qtyMicro: delta,
        afterQtyMicro: input.quantityMicro,
        requestKey: input.requestKey,
        expectedVersion: input.expectedVersion,
        notesAfter,
        userId: ctx.session.user.id,
        createdAt
      })
      costEffectMinor = posted.costMinor
      movementId = posted.movementId
    } else if (delta < 0) {
      const posted = postNegativeDelta({
        row,
        kind: 'edit',
        qtyMicro: -delta,
        afterQtyMicro: input.quantityMicro,
        requestKey: input.requestKey,
        expectedVersion: input.expectedVersion,
        notesAfter,
        userId: ctx.session.user.id,
        createdAt
      })
      costEffectMinor = -posted.costMinor
      movementId = posted.movementId
    } else {
      insertEvent({
        row,
        kind: 'edit',
        afterQtyMicro: input.quantityMicro,
        deltaQtyMicro: 0,
        costEffectMinor: 0,
        requestKey: input.requestKey,
        expectedVersion: input.expectedVersion,
        notesAfter,
        userId: ctx.session.user.id,
        createdAt
      })
    }

    const update = getDatabase().run(sql`
      UPDATE material_returns
      SET quantity_micro = ${input.quantityMicro},
          returned_cost_minor = returned_cost_minor + ${costEffectMinor},
          notes = ${notesAfter},
          version = version + 1,
          updated_by = ${ctx.session.user.id},
          updated_at = ${createdAt}
      WHERE id = ${row.id} AND status = 'active' AND version = ${input.expectedVersion}
    `)
    if (update.changes !== 1) throw new AppError('CONFLICT', 'تعارض في تعديل المرتجع. لم يتم تغيير أي بيانات')
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'production.materialReturn.edit',
      entity: 'material_returns',
      entityId: String(row.id),
      details: {
        orderId: row.orderId,
        materialId: row.materialId,
        beforeQuantityMicro: row.quantityMicro,
        afterQuantityMicro: input.quantityMicro,
        deltaQuantityMicro: delta,
        costEffectMinor,
        movementId,
        requestKey: input.requestKey
      }
    })
    return returnOrThrow(row.id)
  })
}

export function reverseMaterialReturn(input: {
  id: number
  expectedVersion: number
  requestKey: string
}, ctx: ServiceContext): ReturnRow {
  return withTransaction(() => {
    requirePermission(ctx.session, P.production.returnMaterial)
    const duplicate = existingRequest(input.requestKey, 'reverse')
    if (duplicate) {
      if (duplicate.id !== input.id) throw new AppError('CONFLICT', 'مفتاح الطلب مستخدم لمرتجع آخر')
      return duplicate
    }
    const row = returnOrThrow(input.id)
    assertActive(row)
    assertOrderAcceptsReturns(row.orderId)
    if (row.version !== input.expectedVersion) {
      throw new AppError('CONFLICT', 'تم تعديل المرتجع من جلسة أخرى. حدّث البيانات ثم حاول مجدداً')
    }
    const createdAt = nowIso()
    const posted = postNegativeDelta({
      row,
      kind: 'reverse',
      qtyMicro: row.quantityMicro,
      afterQtyMicro: 0,
      requestKey: input.requestKey,
      expectedVersion: input.expectedVersion,
      notesAfter: row.notes,
      userId: ctx.session.user.id,
      createdAt
    })
    const update = getDatabase().run(sql`
      UPDATE material_returns
      SET quantity_micro = 0,
          returned_cost_minor = 0,
          status = 'voided',
          version = version + 1,
          voided_by = ${ctx.session.user.id},
          voided_at = ${createdAt},
          updated_by = ${ctx.session.user.id},
          updated_at = ${createdAt}
      WHERE id = ${row.id} AND status = 'active' AND version = ${input.expectedVersion}
    `)
    if (update.changes !== 1) throw new AppError('CONFLICT', 'تعارض في عكس المرتجع. لم يتم تغيير أي بيانات')
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'production.materialReturn.reverse',
      entity: 'material_returns',
      entityId: String(row.id),
      details: {
        orderId: row.orderId,
        materialId: row.materialId,
        quantityMicro: row.quantityMicro,
        costEffectMinor: -posted.costMinor,
        movementId: posted.movementId,
        requestKey: input.requestKey
      }
    })
    return returnOrThrow(row.id)
  })
}
