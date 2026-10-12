import { hasPermission, requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { idListText, keysetBoundary, keysetOrder, keysetPage, type KeysetWindow, type PageRequest } from '../base/pagination'
import { getDatabase } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import { materials } from '../../db/schema/catalog.schema'
import { inventoryMovements, fifoLayers, materialRemainders } from '../../db/schema/inventory.schema'
import { inventoryRepository } from '../../repositories/inventory/inventory.repository'
import { AppError, forbidden, insufficientStock, notFound } from '../../utils/errors'
import { money, type Money } from '@shared/money/money'
import { costOf, unitCostMicro, type UnitCostMicro } from '@shared/money/cost'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { dayStart, nowIso, type ServiceContext } from '../base/service.types'
import { clearLowStockStateIfResolved } from '../notifications/notification-state.service'
import { requireSafeNonNegativeInteger, requireSafePositiveInteger } from '../../utils/numeric'

export interface ConsumptionResult {
  movementId: number
  /** BR-12 #1 — the quantity physically taken out of stock. */
  physicalQtyMicro: number
  /** BR-12 #2 — actual FIFO cost of exactly that quantity. */
  actualCostMinor: Money
  /** BR-12 #3 — the independent commercial quantity/value charged. */
  commercialQtyMicro: number
  commercialValueMinor: Money
  pricingRuleUsed: string
  allocations: Array<{ layerId: number; qtyMicro: number; unitCostMicro: number; costMinor: number }>
}

function ceilToUnit(qtyMicro: number, unitSizeMicro: number): number {
  if (unitSizeMicro <= 0) return qtyMicro
  requireSafeNonNegativeInteger(qtyMicro, 'الكمية التجارية')
  requireSafePositiveInteger(unitSizeMicro, 'حجم الوحدة التجارية')
  const size = BigInt(unitSizeMicro)
  const rounded = ((BigInt(qtyMicro) + size - 1n) / size) * size
  const result = Number(rounded)
  if (!Number.isSafeInteger(result) || BigInt(result) !== rounded) {
    throw new AppError('VALIDATION_ERROR', 'الكمية التجارية تتجاوز النطاق الآمن')
  }
  return result
}

/**
 * BR-11/BR-32: the commercial quantity charged to the customer is
 * computed independently of what was physically consumed. This is the
 * only place that mapping happens.
 */
export function commercialQuantityFor(
  material: { pricingRule: string; commercialUnitSizeMicro: number | null; unit: string },
  physicalQtyMicro: number,
  manualQtyMicro?: number
): { qtyMicro: number; ruleUsed: string } {
  requireSafeNonNegativeInteger(physicalQtyMicro, 'الكمية الفعلية')
  if (manualQtyMicro !== undefined) requireSafeNonNegativeInteger(manualQtyMicro, 'الكمية التجارية')
  switch (material.pricingRule) {
    case 'exact':
      return { qtyMicro: physicalQtyMicro, ruleUsed: 'exact' }
    case 'full_unit': {
      const size = material.commercialUnitSizeMicro ?? 0
      if (size <= 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          'هذه المادة مسعّرة بالوحدة الكاملة ولكن لم يتم تحديد حجم الوحدة التجارية'
        )
      }
      return { qtyMicro: ceilToUnit(physicalQtyMicro, size), ruleUsed: 'full_unit' }
    }
    case 'round_up': {
      // Rounds up to a whole commercial unit when one is configured,
      // otherwise to a whole unit of the material's own base unit.
      const size = material.commercialUnitSizeMicro ?? 1_000_000
      return { qtyMicro: ceilToUnit(physicalQtyMicro, size), ruleUsed: 'round_up' }
    }
    case 'manual': {
      if (manualQtyMicro === undefined) {
        throw new AppError('VALIDATION_ERROR', 'يجب إدخال الكمية التجارية يدوياً لهذه المادة')
      }
      return { qtyMicro: manualQtyMicro, ruleUsed: 'manual' }
    }
    default:
      return { qtyMicro: physicalQtyMicro, ruleUsed: 'exact' }
  }
}

export function getMaterialOrThrow(materialId: number) {
  const material = getDatabase().select().from(materials).where(eq(materials.id, materialId)).get()
  if (!material) throw notFound('المادة غير موجودة')
  return material
}

export function availableQty(materialId: number): number {
  return inventoryRepository.availableQtyMicro(materialId)
}

/**
 * BR-22: a purchase (or an opening/adjustment receipt) creates a new
 * FIFO layer at its own actual cost, which is preserved forever
 * (BR-7/BR-8) regardless of any later market-price change.
 */
export function receiveStock(input: {
  materialId: number
  qtyMicro: number
  unitCost: UnitCostMicro
  sourceKind: 'purchase' | 'adjustment' | 'opening'
  sourceRefId?: number
  batchCode?: string | null
  receivedAt?: string
  reason?: string
  ctx?: ServiceContext
}): { layerId: number; movementId: number } {
  if (!input.ctx) throw forbidden()
  requirePermission(input.ctx.session, input.sourceKind === 'purchase' ? P.purchases.manage : P.inventory.adjust)
  return withTransaction(() => {
    requireSafePositiveInteger(input.qtyMicro, 'الكمية')
    requireSafeNonNegativeInteger(input.unitCost, 'تكلفة الوحدة')
    const receivedAt = input.receivedAt ?? nowIso()
    const seq = inventoryRepository.nextSeq(input.materialId)

    const layerId = inventoryRepository.insertLayer({
      materialId: input.materialId,
      sourceKind: input.sourceKind,
      sourceRefId: input.sourceRefId ?? null,
      batchCode: input.batchCode ?? null,
      qtyMicro: input.qtyMicro,
      unitCostMicro: input.unitCost,
      receivedAt,
      seq
    })

    const movementKind =
      input.sourceKind === 'purchase' ? 'purchase' : input.sourceKind === 'opening' ? 'opening' : 'adjustment_in'
    const movementId = inventoryRepository.insertMovement({
      materialId: input.materialId,
      kind: movementKind,
      qtyMicro: input.qtyMicro,
      actualCostMinor: costOf(input.qtyMicro, input.unitCost),
      sourceKind: input.sourceKind,
      sourceRefId: input.sourceRefId ?? null,
      reason: input.reason ?? null,
      createdBy: input.ctx?.session.user.id ?? null,
      createdAt: receivedAt
    })

    clearLowStockStateIfResolved(input.materialId)

    return { layerId, movementId }
  })
}

/**
 * Item 15 — "رصيد افتتاحي": material that physically exists in the
 * factory before AURA home started tracking it.
 *
 * This is NOT a directly-editable stock field (item 14) — it is a real,
 * auditable receipt that reuses receiveStock() exactly like a purchase
 * does, so it creates a genuine FIFO layer at its own cost basis and an
 * `opening` inventory movement, never a fabricated supplier invoice
 * (item 15) and never a bypass of the FIFO/movement architecture.
 */
export function recordOpeningStock(
  input: {
    materialId: number
    qtyMicro: number
    unitCostMicro: number
    openingDate?: string
    batchCode?: string | null
    notes?: string
  },
  ctx: ServiceContext
): { layerId: number; movementId: number } {
  requirePermission(ctx.session, P.inventory.adjust)
  return withTransaction(() => {
    requireSafePositiveInteger(input.qtyMicro, 'الكمية')
    requireSafeNonNegativeInteger(input.unitCostMicro, 'تكلفة الوحدة')
    const material = getMaterialOrThrow(input.materialId)

    const result = receiveStock({
      materialId: input.materialId,
      qtyMicro: input.qtyMicro,
      unitCost: unitCostMicro(input.unitCostMicro),
      sourceKind: 'opening',
      batchCode: input.batchCode ?? null,
      receivedAt: input.openingDate ? dayStart(input.openingDate) : nowIso(),
      reason: input.notes ?? 'رصيد افتتاحي',
      ctx
    })

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'inventory.openingStock',
      entity: 'inventory_movements',
      entityId: String(result.movementId),
      details: {
        materialId: input.materialId,
        materialName: material.name,
        qtyMicro: input.qtyMicro,
        unitCostMicro: input.unitCostMicro,
        openingDate: input.openingDate ?? null,
        batchCode: input.batchCode ?? null
      }
    })
    return result
  })
}

/** The same completed-state boundary used by production resource guards.
 * Resolve reversal ownership from persisted issue links, including stock MOs
 * whose movements have no customer order ID.
 */
function assertManufacturingConsumptionMutable(link: { orderId?: number | null; workSheetId?: number; movementId?: number }): void {
  if (getDatabase().get(sql`SELECT ws.id FROM work_sheets ws
    WHERE (ws.status = 'completed' OR ws.completed_at IS NOT NULL)
      AND (ws.order_id = ${link.orderId ?? null} OR ws.id = ${link.workSheetId ?? null}
        OR EXISTS (SELECT 1 FROM order_material_lines l
          WHERE l.movement_id = ${link.movementId ?? null}
            AND (l.work_sheet_id = ws.id OR l.order_id = ws.order_id))) LIMIT 1`))
    throw new AppError('CONFLICT', 'لا يمكن تعديل صرف أمر تصنيع مكتمل لأن تكلفة الإنتاج أصبحت تاريخية')
}

/**
 * BR-5/BR-6/BR-10/BR-12. Deducts ONLY the quantity physically
 * consumed, taking cost from the oldest layers first, and records the
 * commercial quantity/value separately. Never deducts a full unit
 * merely because a full unit was charged.
 *
 * Runs inside a single transaction: either the stock, the cost
 * allocations and the movement all land, or none do.
 */
export function consumeMaterial(input: {
  materialId: number
  physicalQtyMicro: number
  orderId?: number
  workSheetId?: number
  manualCommercialQtyMicro?: number
  overrideCommercialValueMinor?: number
  kind?: 'consumption' | 'sale'
  reason?: string
  ctx?: ServiceContext
}): ConsumptionResult {
  if (!input.ctx) throw forbidden()
  requirePermission(input.ctx.session, P.inventory.consume)
  requireSafePositiveInteger(input.physicalQtyMicro, 'الكمية')
  if (input.manualCommercialQtyMicro !== undefined) {
    requireSafePositiveInteger(input.manualCommercialQtyMicro, 'الكمية التجارية')
  }
  if (input.overrideCommercialValueMinor !== undefined) {
    requireSafeNonNegativeInteger(input.overrideCommercialValueMinor, 'القيمة التجارية')
  }

  return withTransaction(() => {
    assertManufacturingConsumptionMutable(input)
    const material = getMaterialOrThrow(input.materialId)

    // BR-5: never allow stock to go negative.
    const available = inventoryRepository.availableQtyMicro(input.materialId)
    if (available < input.physicalQtyMicro) {
      throw insufficientStock(
        `الكمية المتوفرة من "${material.name}" غير كافية. المتوفر: ${available / 1_000_000} ${material.unit}`
      )
    }

    const movementId = inventoryRepository.insertMovement({
      materialId: input.materialId,
      kind: input.kind ?? 'consumption',
      qtyMicro: input.physicalQtyMicro,
      orderId: input.orderId ?? null,
      reason: input.reason ?? null,
      createdBy: input.ctx?.session.user.id ?? null,
      createdAt: nowIso()
    })

    // BR-6: consume oldest layers first; actual cost is the SUM of the
    // allocations actually taken — never an average.
    let remaining = input.physicalQtyMicro
    let actualCost = 0
    const allocations: ConsumptionResult['allocations'] = []

    for (const layer of inventoryRepository.layersForConsumption(input.materialId)) {
      if (remaining <= 0) break
      const take = Math.min(remaining, layer.qtyRemainingMicro)
      if (take <= 0) continue

      if (!inventoryRepository.decrementLayer(layer.id, take)) {
        throw new AppError('CONFLICT', 'تعذر خصم الكمية من المخزون. الرجاء المحاولة مرة أخرى')
      }
      const lineCost = costOf(take, unitCostMicro(layer.unitCostMicro))
      inventoryRepository.insertAllocation({
        movementId,
        layerId: layer.id,
        qtyMicro: take,
        unitCostMicro: layer.unitCostMicro,
        costMinor: lineCost
      })
      allocations.push({
        layerId: layer.id,
        qtyMicro: take,
        unitCostMicro: layer.unitCostMicro,
        costMinor: lineCost
      })
      actualCost += lineCost
      remaining -= take
    }

    if (remaining > 0) {
      // Defensive: the availability guard above should make this unreachable.
      throw insufficientStock('الكمية المتوفرة في المخزون غير كافية')
    }

    inventoryRepository.setMovementCost(movementId, actualCost)

    // BR-11: commercial pricing is computed independently of the above.
    const commercial = commercialQuantityFor(
      material,
      input.physicalQtyMicro,
      input.manualCommercialQtyMicro
    )
    const commercialValue =
      input.overrideCommercialValueMinor ??
      costOf(commercial.qtyMicro, unitCostMicro(material.currentMarketPriceMicro))

    return {
      movementId,
      physicalQtyMicro: input.physicalQtyMicro,
      actualCostMinor: money(actualCost),
      commercialQtyMicro: commercial.qtyMicro,
      commercialValueMinor: money(commercialValue),
      pricingRuleUsed: commercial.ruleUsed,
      allocations
    }
  })
}

/**
 * Reverses one posted consumption without rewriting its historical FIFO
 * allocations. The original movement/allocation rows stay intact; stock is
 * restored to those exact layers (and therefore to the exact historical lot),
 * and a linked positive reversal movement is appended to the ledger.
 */
export function reverseConsumptionMovement(input: {
  movementId: number
  sourceRefId: number
  reason: string
  ctx: ServiceContext
}): { reversalMovementId: number; materialId: number; qtyMicro: number; actualCostMinor: number } {
  // Worksheet reversal is the existing owner of production material corrections.
  if (!hasPermission(input.ctx.session, P.worksheets.reverse)) {
    requirePermission(input.ctx.session, P.inventory.consume)
  }
  if (!input.reason.trim()) throw new AppError('VALIDATION_ERROR', 'سبب عكس الحركة مطلوب')

  return withTransaction(() => {
    const db = getDatabase()
    const movement = db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.id, input.movementId))
      .get()
    if (!movement) throw notFound('حركة الصرف غير موجودة')
    if (movement.kind !== 'consumption') {
      throw new AppError('CONFLICT', 'لا يمكن عكس هذه الحركة من مسار صرف مواد الإنتاج')
    }
    assertManufacturingConsumptionMutable({ orderId: movement.orderId, movementId: movement.id })
    if (
      movement.orderId &&
      db.get(sql`SELECT id FROM uncollected_products WHERE source_order_id = ${movement.orderId} LIMIT 1`)
    ) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن استعادة مواد تصنيع منتج له سجل في المنتجات غير المستلمة'
      )
    }
    const alreadyReversed = db
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.reversalOfMovementId, movement.id))
      .get()
    if (alreadyReversed) throw new AppError('CONFLICT', 'تم عكس حركة الصرف بالفعل')

    const allocations = inventoryRepository.allocationsForMovement(movement.id)
    if (!allocations.length) {
      throw new AppError('CONFLICT', 'لا يمكن عكس الحركة لأن تفاصيل توزيع التكلفة غير مكتملة')
    }
    const allocatedQty = allocations.reduce((sum, allocation) => sum + allocation.qtyMicro, 0)
    if (allocatedQty !== movement.qtyMicro) {
      throw new AppError('CONFLICT', 'لا يمكن عكس الحركة لأن توزيع التكلفة لا يطابق الكمية المصروفة')
    }

    if (allocations.reduce((sum, a) => sum + a.costMinor, 0) !== movement.actualCostMinor) throw new AppError('CONFLICT', 'لا يمكن عكس الحركة لأن توزيع التكلفة لا يطابق تكلفتها التاريخية')
    for (const allocation of allocations) {
      const layer = db.select().from(fifoLayers).where(eq(fifoLayers.id, allocation.layerId)).get()
      if (!layer || layer.materialId !== movement.materialId || allocation.qtyMicro <= 0 || allocation.unitCostMicro !== layer.unitCostMicro) throw new AppError('CONFLICT', 'تفاصيل طبقة التكلفة المرتبطة بالصرف غير موثوقة؛ لم يتم تغيير أي بيانات')
    }

    for (const allocation of allocations) {
      if (!inventoryRepository.restoreLayer(allocation.layerId, allocation.qtyMicro)) {
        throw new AppError(
          'CONFLICT',
          'تعذر استعادة طبقة التكلفة الأصلية بأمان. لم يتم تغيير أي بيانات'
        )
      }
    }

    const reversalMovementId = inventoryRepository.insertMovement({
      materialId: movement.materialId,
      kind: 'consumption_reversal',
      qtyMicro: movement.qtyMicro,
      orderId: movement.orderId,
      actualCostMinor: -movement.actualCostMinor,
      sourceKind: 'material_consumption',
      sourceRefId: input.sourceRefId,
      reversalOfMovementId: movement.id,
      reason: input.reason,
      createdBy: input.ctx.session.user.id,
      createdAt: nowIso()
    })

    clearLowStockStateIfResolved(movement.materialId)

    return {
      reversalMovementId,
      materialId: movement.materialId,
      qtyMicro: movement.qtyMicro,
      actualCostMinor: movement.actualCostMinor
    }
  })
}

/**
 * BR-14/BR-49: waste is material that actually became unusable. It
 * leaves stock at its FIFO cost and becomes a GENERAL operational
 * loss — it is never charged to a customer order.
 */
export function recordWaste(input: {
  materialId: number
  qtyMicro: number
  reason: string
  ctx?: ServiceContext
}): { movementId: number; costMinor: Money } {
  if (!input.ctx) throw forbidden()
  requirePermission(input.ctx.session, P.inventory.waste)
  return withTransaction(() => {
    const result = consumeMaterialInternal(input.materialId, input.qtyMicro, 'waste', input.reason, input.ctx)
    recordAuditEvent({
      userId: input.ctx?.session.user.id,
      action: 'inventory.waste',
      entity: 'inventory_movements',
      entityId: String(result.movementId),
      details: { materialId: input.materialId, qtyMicro: input.qtyMicro, reason: input.reason }
    })
    return result
  })
}

/** BR-51: manual adjustment with a required reason. */
export function adjustStock(input: {
  materialId: number
  qtyMicro: number
  direction: 'in' | 'out'
  reason: string
  unitCost?: UnitCostMicro
  ctx?: ServiceContext
}): { movementId: number } {
  if (!input.ctx) throw forbidden()
  requirePermission(input.ctx.session, P.inventory.adjust)
  return withTransaction(() => {
    if (!input.reason?.trim()) {
      throw new AppError('VALIDATION_ERROR', 'سبب التسوية مطلوب')
    }
    if (input.unitCost !== undefined) requireSafeNonNegativeInteger(input.unitCost, 'تكلفة الوحدة')
    if (input.direction === 'in') {
      const material = getMaterialOrThrow(input.materialId)
      // An increase must carry a cost basis so FIFO stays meaningful.
      const cost = input.unitCost ?? unitCostMicro(material.currentMarketPriceMicro)
      const res = receiveStock({
        materialId: input.materialId,
        qtyMicro: input.qtyMicro,
        unitCost: cost,
        sourceKind: 'adjustment',
        reason: input.reason,
        ctx: input.ctx
      })
      recordAuditEvent({
        userId: input.ctx?.session.user.id,
        action: 'inventory.adjust_in',
        entity: 'inventory_movements',
        entityId: String(res.movementId),
        details: { materialId: input.materialId, qtyMicro: input.qtyMicro, reason: input.reason }
      })
      return { movementId: res.movementId }
    }

    const res = consumeMaterialInternal(
      input.materialId,
      input.qtyMicro,
      'adjustment_out',
      input.reason,
      input.ctx
    )
    recordAuditEvent({
      userId: input.ctx?.session.user.id,
      action: 'inventory.adjust_out',
      entity: 'inventory_movements',
      entityId: String(res.movementId),
      details: { materialId: input.materialId, qtyMicro: input.qtyMicro, reason: input.reason }
    })
    return { movementId: res.movementId }
  })
}

/** Shared FIFO outflow used by waste and outward adjustments. */
function consumeMaterialInternal(
  materialId: number,
  qtyMicro: number,
  kind: 'waste' | 'adjustment_out',
  reason: string,
  ctx?: ServiceContext
): { movementId: number; costMinor: Money } {
  requireSafePositiveInteger(qtyMicro, 'الكمية')

  return withTransaction(() => {
    const material = getMaterialOrThrow(materialId)
    const available = inventoryRepository.availableQtyMicro(materialId)
    if (available < qtyMicro) {
      throw insufficientStock(
        `الكمية المتوفرة من "${material.name}" غير كافية. المتوفر: ${available / 1_000_000} ${material.unit}`
      )
    }

    const movementId = inventoryRepository.insertMovement({
      materialId,
      kind,
      qtyMicro,
      reason,
      createdBy: ctx?.session.user.id ?? null,
      createdAt: nowIso()
    })

    let remaining = qtyMicro
    let cost = 0
    for (const layer of inventoryRepository.layersForConsumption(materialId)) {
      if (remaining <= 0) break
      const take = Math.min(remaining, layer.qtyRemainingMicro)
      if (take <= 0) continue
      if (!inventoryRepository.decrementLayer(layer.id, take)) {
        throw new AppError('CONFLICT', 'تعذر خصم الكمية من المخزون')
      }
      const lineCost = costOf(take, unitCostMicro(layer.unitCostMicro))
      inventoryRepository.insertAllocation({
        movementId,
        layerId: layer.id,
        qtyMicro: take,
        unitCostMicro: layer.unitCostMicro,
        costMinor: lineCost
      })
      cost += lineCost
      remaining -= take
    }
    inventoryRepository.setMovementCost(movementId, cost)
    return { movementId, costMinor: money(cost) }
  })
}

/** BR-33: record an explicitly supplied reusable offcut. */
export function recordRemainder(input: {
  materialId: number
  sizeMicro: number
  layerId?: number
  note?: string
  ctx?: ServiceContext
}): void {
  if (!input.ctx) throw forbidden()
  requirePermission(input.ctx.session, P.inventory.consume)
  requireSafePositiveInteger(input.sizeMicro, 'حجم الباقي')
  getMaterialOrThrow(input.materialId)
  inventoryRepository.insertRemainder({
    materialId: input.materialId,
    layerId: input.layerId ?? null,
    sizeMicro: input.sizeMicro,
    sourceNote: input.note ?? null,
    createdAt: nowIso()
  })
}

/** Available reusable offcuts, oldest first, as a bounded page. */
export function listRemainders(materialId?: number, request: PageRequest = {}) {
  return keysetPage({
    scope: 'inventory.remainders',
    filters: { materialId },
    request,
    keyTypes: ['int'],
    order: 'asc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => getDatabase()
      .select()
      .from(materialRemainders)
      .where(and(
        eq(materialRemainders.available, true),
        materialId ? eq(materialRemainders.materialId, materialId) : undefined,
        keysetBoundary([sql`${materialRemainders.id}`], window)
      ))
      .orderBy(keysetOrder([sql`${materialRemainders.id}`], window))
      .limit(window.take)
      .all(),
    summary: () => undefined
  })
}

const INCOMING_MOVEMENT_KINDS = ['purchase', 'opening', 'adjustment_in', 'consumption_reversal', 'material_return'] as const

/**
 * Bounded, immutable movement journal (newest first). Without kind/date
 * filters each row carries the material's balance right after it: the live
 * FIFO quantity minus every newer movement for that material, including
 * movements hidden by filters or pagination.
 */
export function listMovements(
  filter: { materialId?: number; orderId?: number; kind?: string; from?: string; to?: string } = {},
  request: PageRequest = {}
) {
  const normalized = { materialId: filter.materialId, orderId: filter.orderId, kind: filter.kind, from: filter.from, to: filter.to }
  const clauses: SQL[] = []
  if (normalized.materialId) clauses.push(eq(inventoryMovements.materialId, normalized.materialId))
  if (normalized.orderId) clauses.push(eq(inventoryMovements.orderId, normalized.orderId))
  if (normalized.kind) clauses.push(eq(inventoryMovements.kind, normalized.kind))
  if (normalized.from) clauses.push(sql`${inventoryMovements.createdAt} >= ${normalized.from}`)
  if (normalized.to) clauses.push(sql`${inventoryMovements.createdAt} <= ${normalized.to}`)
  const canCalculateBalance = !normalized.kind && !normalized.from && !normalized.to
  return keysetPage({
    scope: 'inventory.movements',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => {
      const rows = getDatabase()
        .select()
        .from(inventoryMovements)
        .where(and(...clauses, keysetBoundary([sql`${inventoryMovements.id}`], window)))
        .orderBy(keysetOrder([sql`${inventoryMovements.id}`], window))
        .limit(window.take)
        .all()
      if (!canCalculateBalance || !rows.length) return rows.map((row) => ({ ...row, balanceAfterMicro: null as number | null }))
      const balanceAfter = new Map(
        getDatabase().all<{ movementId: number; balanceAfterMicro: number }>(sql`
          WITH shown(id, material_id) AS (VALUES ${sql.join(rows.map((row) => sql`(${row.id}, ${row.materialId})`), sql`, `)})
          SELECT shown.id AS movementId,
            COALESCE((SELECT SUM(qty_remaining_micro) FROM fifo_layers WHERE material_id = shown.material_id), 0)
            - COALESCE((
              SELECT SUM(CASE WHEN mv.kind IN (${idListText(INCOMING_MOVEMENT_KINDS)}) THEN mv.qty_micro ELSE -mv.qty_micro END)
              FROM inventory_movements mv
              WHERE mv.material_id = shown.material_id AND mv.id > shown.id
            ), 0) AS balanceAfterMicro
          FROM shown
        `).map((row) => [row.movementId, row.balanceAfterMicro])
      )
      return rows.map((row) => ({ ...row, balanceAfterMicro: balanceAfter.get(row.id) ?? null }))
    },
    summary: () => undefined
  })
}
