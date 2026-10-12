import { and, eq, sql, type SQL } from 'drizzle-orm'
import { keysetBoundary, keysetOrder, keysetPage, type KeysetWindow, type PageRequest } from '../base/pagination'
import { getDatabase, getRawConnection } from '../../db/connection'
import {
  finishedGoodsMovements,
  finishedGoodsValuationCutovers
} from '../../db/schema/production.schema'
import { products } from '../../db/schema/products.schema'
import { AppError, notFound } from '../../utils/errors'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, type ServiceContext } from '../base/service.types'
import { withTransaction } from '../../db/transactions'
import { requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { productionActualCostMinor } from './production.service'
import { financialCommandPayloadHash } from '../finance/idempotency.service'

const QUANTITY_SCALE = 1_000_000n
const IN_KINDS = new Set(['production_in', 'adjustment_in', 'sale_reversal'])
const OUT_KINDS = new Set(['sale_out', 'adjustment_out'])

interface LedgerMovement {
  id: number
  productId: number
  kind: string
  qtyMicro: number
  unitCostMinor: number
  totalCostMinor: number
  workSheetId: number | null
  orderId: number | null
  reversalOfMovementId: number | null
}

interface ValuationStateBigInt {
  qtyMicro: bigint
  valueMinor: bigint
}

export interface FinishedGoodsValuation {
  productId: number
  onHandMicro: number
  onHandValueMinor: number
  unitCostMinor: number
  status: 'ready' | 'blocked'
  classification: 'unaffected' | 'provably_affected' | 'potentially_affected'
  movementIdThrough: number
}

function safeInteger(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AppError('VALIDATION_ERROR', `${label} يجب أن يكون عدداً صحيحاً آمناً`)
  }
  return value
}

function safeNumber(value: bigint, label: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || BigInt(result) !== value) {
    throw new AppError('CONFLICT', `${label} تجاوز النطاق الحسابي الآمن`)
  }
  return result
}

/** Round non-negative rational money once, half upward, at the posting boundary. */
function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new AppError('CONFLICT', 'حالة تقييم المخزون الجاهز غير صالحة')
  }
  return (numerator + denominator / 2n) / denominator
}

function proportionalIssueCost(state: ValuationStateBigInt, qtyMicro: bigint): bigint {
  if (qtyMicro <= 0n || qtyMicro > state.qtyMicro || state.valueMinor < 0n) {
    throw new AppError('CONFLICT', 'كمية أو قيمة المخزون الجاهز غير قابلة للتسوية')
  }
  // Consuming the final quantity consumes the exact final carrying value. This
  // prevents a rounding residue from leaking into the next stock cycle.
  if (qtyMicro === state.qtyMicro) return state.valueMinor
  return roundedDivide(state.valueMinor * qtyMicro, state.qtyMicro)
}

function unitCostFromTotal(totalCostMinor: bigint, qtyMicro: bigint): number {
  return safeNumber(
    roundedDivide(totalCostMinor * QUANTITY_SCALE, qtyMicro),
    'تكلفة الوحدة'
  )
}

function movementRows(productId: number, afterId = -1): LedgerMovement[] {
  return getRawConnection()
    .prepare(
      `SELECT id, product_id AS productId, kind, qty_micro AS qtyMicro,
              unit_cost_minor AS unitCostMinor, total_cost_minor AS totalCostMinor,
              work_sheet_id AS workSheetId, order_id AS orderId,
              reversal_of_movement_id AS reversalOfMovementId
         FROM finished_goods_movements
        WHERE product_id = ? AND id > ?
        ORDER BY id`
    )
    .all(productId, afterId) as LedgerMovement[]
}

function validateMovement(row: LedgerMovement): void {
  safeInteger(row.id, 'رقم حركة المخزون', 1)
  safeInteger(row.qtyMicro, 'كمية حركة المخزون', 1)
  safeInteger(row.totalCostMinor, 'قيمة حركة المخزون')
  safeInteger(row.unitCostMinor, 'تكلفة وحدة حركة المخزون')
}

function applyPostedMovement(state: ValuationStateBigInt, row: LedgerMovement): void {
  validateMovement(row)
  const qty = BigInt(row.qtyMicro)
  const value = BigInt(row.totalCostMinor)
  if (IN_KINDS.has(row.kind)) {
    state.qtyMicro += qty
    state.valueMinor += value
  } else if (OUT_KINDS.has(row.kind)) {
    if (qty > state.qtyMicro || value > state.valueMinor) {
      throw new AppError('CONFLICT', `الحركة ${row.id} تتجاوز كمية أو قيمة المخزون المتاحة`)
    }
    state.qtyMicro -= qty
    state.valueMinor -= value
  } else {
    throw new AppError('CONFLICT', `نوع حركة المخزون الجاهز غير معروف: ${row.kind}`)
  }
  safeNumber(state.qtyMicro, 'كمية المخزون الجاهز')
  safeNumber(state.valueMinor, 'قيمة المخزون الجاهز')
  if (state.qtyMicro === 0n && state.valueMinor !== 0n) {
    throw new AppError('CONFLICT', 'المخزون الصفري يحمل قيمة غير صفرية')
  }
}

function replayHistorical(rows: LedgerMovement[]): {
  status: 'ready' | 'blocked'
  classification: 'unaffected' | 'provably_affected' | 'potentially_affected'
  qtyMicro: number
  valueMinor: number
  affectedMovementCount: number
  historicalCogsDeltaMinor: number
  evidence: Record<string, unknown>
} {
  const state: ValuationStateBigInt = { qtyMicro: 0n, valueMinor: 0n }
  let affectedMovementCount = 0
  let historicalCogsDelta = 0n
  let adjustmentCount = 0
  const affectedMovementIds: number[] = []

  try {
    for (const row of rows) {
      validateMovement(row)
      const qty = BigInt(row.qtyMicro)
      const recordedValue = BigInt(row.totalCostMinor)
      if (row.kind === 'production_in' || row.kind === 'adjustment_in') {
        if (row.kind === 'adjustment_in') adjustmentCount += 1
        state.qtyMicro += qty
        state.valueMinor += recordedValue
      } else if (row.kind === 'sale_out' || row.kind === 'adjustment_out') {
        if (row.kind === 'adjustment_out') adjustmentCount += 1
        const expectedValue = proportionalIssueCost(state, qty)
        if (recordedValue !== expectedValue) {
          affectedMovementCount += 1
          historicalCogsDelta += recordedValue - expectedValue
          if (affectedMovementIds.length < 100) affectedMovementIds.push(row.id)
        }
        state.qtyMicro -= qty
        state.valueMinor -= expectedValue
      } else if (row.kind === 'sale_reversal') {
        state.qtyMicro += qty
        state.valueMinor += recordedValue
      } else {
        throw new Error(`unknown movement kind ${row.kind}`)
      }
      safeNumber(state.qtyMicro, 'كمية المخزون الجاهز')
      safeNumber(state.valueMinor, 'قيمة المخزون الجاهز')
      if (state.qtyMicro === 0n) state.valueMinor = 0n
    }
    const classification =
      affectedMovementCount > 0
        ? 'provably_affected'
        : adjustmentCount > 0
          ? 'potentially_affected'
          : 'unaffected'
    return {
      status: 'ready',
      classification,
      qtyMicro: safeNumber(state.qtyMicro, 'كمية القطع عند التحويل'),
      valueMinor: safeNumber(state.valueMinor, 'قيمة القطع عند التحويل'),
      affectedMovementCount,
      historicalCogsDeltaMinor: safeNumber(historicalCogsDelta, 'فرق التكلفة التاريخية'),
      evidence: {
        policy: 'prospective_moving_weighted_average_v1',
        movementCount: rows.length,
        adjustmentCount,
        affectedMovementIds,
        historicalRowsRewritten: false,
        historicalCostsInferred: false
      }
    }
  } catch (error) {
    return {
      status: 'blocked',
      classification: 'potentially_affected',
      qtyMicro: 0,
      valueMinor: 0,
      affectedMovementCount,
      historicalCogsDeltaMinor: 0,
      evidence: {
        policy: 'prospective_moving_weighted_average_v1',
        movementCount: rows.length,
        adjustmentCount,
        historicalRowsRewritten: false,
        historicalCostsInferred: false,
        blockedReason: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

function createCutoverInternal(productId: number): typeof finishedGoodsValuationCutovers.$inferSelect {
  const existing = getDatabase()
    .select()
    .from(finishedGoodsValuationCutovers)
    .where(eq(finishedGoodsValuationCutovers.productId, productId))
    .get()
  if (existing) return existing
  if (!getDatabase().select({ id: products.id }).from(products).where(eq(products.id, productId)).get()) {
    throw notFound('المنتج غير موجود')
  }

  const rows = movementRows(productId)
  const result = replayHistorical(rows)
  const movementIdThrough = rows.at(-1)?.id ?? 0
  const createdAt = nowIso()
  getDatabase()
    .insert(finishedGoodsValuationCutovers)
    .values({
      productId,
      movementIdThrough,
      openingQtyMicro: result.qtyMicro,
      openingValueMinor: result.valueMinor,
      status: result.status,
      classification: result.classification,
      affectedMovementCount: result.affectedMovementCount,
      historicalCogsDeltaMinor: result.historicalCogsDeltaMinor,
      evidence: JSON.stringify(result.evidence),
      createdAt
    })
    .run()
  recordAuditEvent({
    action: 'finishedGoods.valuationCutover',
    entity: 'finished_goods_valuation_cutovers',
    entityId: String(productId),
    details: {
      productId,
      movementIdThrough,
      status: result.status,
      classification: result.classification,
      openingQtyMicro: result.qtyMicro,
      openingValueMinor: result.valueMinor,
      affectedMovementCount: result.affectedMovementCount,
      historicalCogsDeltaMinor: result.historicalCogsDeltaMinor,
      ...result.evidence
    }
  })
  return getDatabase()
    .select()
    .from(finishedGoodsValuationCutovers)
    .where(eq(finishedGoodsValuationCutovers.productId, productId))
    .get()!
}

/** Establishes an auditable prospective boundary for every historical product. */
export function initializeFinishedGoodsValuationCutovers(): {
  initialized: number
  blocked: number
} {
  return withTransaction(() => {
    const ids = getRawConnection()
      .prepare(
        `SELECT DISTINCT m.product_id AS productId
           FROM finished_goods_movements m
           LEFT JOIN finished_goods_valuation_cutovers c ON c.product_id = m.product_id
          WHERE c.product_id IS NULL
          ORDER BY m.product_id`
      )
      .all() as Array<{ productId: number }>
    let blocked = 0
    for (const { productId } of ids) {
      if (createCutoverInternal(productId).status === 'blocked') blocked += 1
    }
    return { initialized: ids.length, blocked }
  })
}

function currentStateInternal(productId: number): {
  cutover: typeof finishedGoodsValuationCutovers.$inferSelect
  state: ValuationStateBigInt
} {
  const cutover = createCutoverInternal(productId)
  if (cutover.status !== 'ready') {
    throw new AppError(
      'CONFLICT',
      'تعذر إثبات قيمة مخزون هذا المنتج تاريخياً؛ يلزم فحص محاسبي قبل أي حركة جديدة'
    )
  }
  const state = {
    qtyMicro: BigInt(safeInteger(cutover.openingQtyMicro, 'كمية بداية التقييم')),
    valueMinor: BigInt(safeInteger(cutover.openingValueMinor, 'قيمة بداية التقييم'))
  }
  for (const row of movementRows(productId, cutover.movementIdThrough)) {
    applyPostedMovement(state, row)
  }
  return { cutover, state }
}

export function finishedGoodsValuation(productId: number): FinishedGoodsValuation {
  const execute = () => {
    const { cutover, state } = currentStateInternal(productId)
    const qtyMicro = safeNumber(state.qtyMicro, 'كمية المخزون الجاهز')
    const valueMinor = safeNumber(state.valueMinor, 'قيمة المخزون الجاهز')
    return {
      productId,
      onHandMicro: qtyMicro,
      onHandValueMinor: valueMinor,
      unitCostMinor: qtyMicro === 0 ? 0 : unitCostFromTotal(state.valueMinor, state.qtyMicro),
      status: cutover.status as 'ready',
      classification: cutover.classification as FinishedGoodsValuation['classification'],
      movementIdThrough: cutover.movementIdThrough
    }
  }
  return getRawConnection().inTransaction ? execute() : withTransaction(execute)
}

export function onHandMicro(productId: number): number {
  return finishedGoodsValuation(productId).onHandMicro
}

export function onHandValueMinor(productId: number): number {
  return finishedGoodsValuation(productId).onHandValueMinor
}

/** Moving weighted-average cost of only the value currently on hand. */
export function onHandUnitCostMinor(productId: number): number {
  return finishedGoodsValuation(productId).unitCostMinor
}

/**
 * Page-bounded equivalent of calling finishedGoodsValuation for each product
 * in order. Existing cutovers and their post-cutover movements are read with
 * two queries; a product still lacking its one-time cutover takes the exact
 * single-product path so its creation, audit event and rollback are unchanged.
 */
function finishedGoodsValuationsInOrder(productIds: number[]): Map<number, FinishedGoodsValuation> {
  const valuations = new Map<number, FinishedGoodsValuation>()
  if (!productIds.length) return valuations
  const raw = getRawConnection()
  const placeholders = productIds.map(() => '?').join(', ')
  const cutovers = new Map(
    (raw.prepare(`SELECT * FROM finished_goods_valuation_cutovers WHERE product_id IN (${placeholders})`)
      .all(...productIds) as Array<Record<string, unknown>>)
      .map((row) => [row.product_id as number, row])
  )
  const movements = new Map<number, LedgerMovement[]>()
  for (const row of raw.prepare(
    `SELECT m.id, m.product_id AS productId, m.kind, m.qty_micro AS qtyMicro,
            m.unit_cost_minor AS unitCostMinor, m.total_cost_minor AS totalCostMinor,
            m.work_sheet_id AS workSheetId, m.order_id AS orderId,
            m.reversal_of_movement_id AS reversalOfMovementId
       FROM finished_goods_movements m
       JOIN finished_goods_valuation_cutovers c ON c.product_id = m.product_id
      WHERE m.product_id IN (${placeholders}) AND m.id > c.movement_id_through
      ORDER BY m.product_id, m.id`
  ).all(...productIds) as LedgerMovement[]) {
    const list = movements.get(row.productId) ?? []
    list.push(row)
    movements.set(row.productId, list)
  }
  for (const productId of productIds) {
    const cutover = cutovers.get(productId)
    if (!cutover) {
      valuations.set(productId, finishedGoodsValuation(productId))
      continue
    }
    if (cutover.status !== 'ready') {
      throw new AppError('CONFLICT', 'تعذر إثبات قيمة مخزون هذا المنتج تاريخياً؛ يلزم فحص محاسبي قبل أي حركة جديدة')
    }
    const state = {
      qtyMicro: BigInt(safeInteger(cutover.opening_qty_micro as number, 'كمية بداية التقييم')),
      valueMinor: BigInt(safeInteger(cutover.opening_value_minor as number, 'قيمة بداية التقييم'))
    }
    for (const row of movements.get(productId) ?? []) applyPostedMovement(state, row)
    const qtyMicro = safeNumber(state.qtyMicro, 'كمية المخزون الجاهز')
    const valueMinor = safeNumber(state.valueMinor, 'قيمة المخزون الجاهز')
    valuations.set(productId, {
      productId,
      onHandMicro: qtyMicro,
      onHandValueMinor: valueMinor,
      unitCostMinor: qtyMicro === 0 ? 0 : unitCostFromTotal(state.valueMinor, state.qtyMicro),
      status: cutover.status as 'ready',
      classification: cutover.classification as FinishedGoodsValuation['classification'],
      movementIdThrough: cutover.movement_id_through as number
    })
  }
  return valuations
}

/** Product master with authoritative valuation; query count is independent of product count. */
export function listFinishedGoods(filter: { productId?: number } = {}) {
  const rows = getDatabase()
    .select({
      id: products.id,
      code: products.code,
      name: products.name,
      defaultPriceMinor: products.defaultPriceMinor,
      active: products.active
    })
    .from(products)
    .where(filter.productId ? eq(products.id, filter.productId) : undefined)
    .all()
  const valuations = finishedGoodsValuationsInOrder(rows.map((product) => product.id))
  return rows.map((product) => ({ ...product, ...valuations.get(product.id)! }))
}

export function listFinishedGoodsMovements(
  filter: { productId?: number; orderId?: number } = {},
  request: PageRequest = {}
) {
  const normalized = { productId: filter.productId, orderId: filter.orderId }
  const clauses: SQL[] = []
  if (normalized.productId) clauses.push(eq(finishedGoodsMovements.productId, normalized.productId))
  if (normalized.orderId) clauses.push(eq(finishedGoodsMovements.orderId, normalized.orderId))
  return keysetPage({
    scope: 'production.finishedGoodsMovements',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => getDatabase()
      .select({
        id: finishedGoodsMovements.id,
        productId: finishedGoodsMovements.productId,
        productName: products.name,
        kind: finishedGoodsMovements.kind,
        qtyMicro: finishedGoodsMovements.qtyMicro,
        unitCostMinor: finishedGoodsMovements.unitCostMinor,
        totalCostMinor: finishedGoodsMovements.totalCostMinor,
        workSheetId: finishedGoodsMovements.workSheetId,
        orderId: finishedGoodsMovements.orderId,
        reversalOfMovementId: finishedGoodsMovements.reversalOfMovementId,
        notes: finishedGoodsMovements.notes,
        createdAt: finishedGoodsMovements.createdAt
      })
      .from(finishedGoodsMovements)
      .innerJoin(products, eq(finishedGoodsMovements.productId, products.id))
      .where(and(...clauses, keysetBoundary([sql`${finishedGoodsMovements.id}`], window)))
      .orderBy(keysetOrder([sql`${finishedGoodsMovements.id}`], window))
      .limit(window.take)
      .all(),
    summary: () => undefined
  })
}

/** Receipt primitive owned by the atomic Standard BOM-production command. */
export function postFinishedGoodsProduction(
  input: { productId: number; workSheetId?: number | null; qtyMicro: number; totalCostMinor: number },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.products.manage)
  requirePermission(ctx.session, P.inventory.consume)
  const owner = getRawConnection().prepare(`SELECT id FROM work_sheets
    WHERE id = ? AND product_id = ? AND order_id IS NULL AND status = 'completed'
      AND started_at IS NOT NULL AND completed_at IS NOT NULL AND quantity_micro = ?
      AND NOT EXISTS (SELECT 1 FROM finished_goods_movements WHERE work_sheet_id = work_sheets.id)`)
    .get(input.workSheetId ?? null, input.productId, input.qtyMicro)
  // The stock-production request is pending only within its owning transaction.
  const pending = getRawConnection().prepare(`SELECT id FROM financial_command_requests
    WHERE command_scope = 'products.issueStockFromBom' AND result_json = 'null' AND created_by = ? AND payload_hash = ?`)
    .get(ctx.session.user.id, financialCommandPayloadHash({ productId: input.productId, quantityMicro: input.qtyMicro }))
  if (!getRawConnection().inTransaction || !owner || !pending ||
      input.totalCostMinor !== productionActualCostMinor(input.workSheetId!))
    throw new AppError('CONFLICT', 'إضافة الإنتاج تتطلب معاملة صرف من المخزون المعتمدة')
  safeInteger(input.qtyMicro, 'كمية الإنتاج', 1)
  safeInteger(input.totalCostMinor, 'تكلفة الإنتاج')
  return withTransaction(() => {
    const { state } = currentStateInternal(input.productId)
    safeNumber(state.qtyMicro + BigInt(input.qtyMicro), 'كمية المخزون بعد الإنتاج')
    safeNumber(state.valueMinor + BigInt(input.totalCostMinor), 'قيمة المخزون بعد الإنتاج')
    const unitCostMinor = unitCostFromTotal(BigInt(input.totalCostMinor), BigInt(input.qtyMicro))
    const id = Number(
      getDatabase()
        .insert(finishedGoodsMovements)
        .values({
          productId: input.productId,
          kind: 'production_in',
          qtyMicro: input.qtyMicro,
          unitCostMinor,
          totalCostMinor: input.totalCostMinor,
          workSheetId: input.workSheetId ?? null,
          orderId: null,
          reversalOfMovementId: null,
          notes: 'إنتاج مخزون من أمر تصنيع',
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'finishedGoods.production',
      entity: 'finished_goods_movements',
      entityId: String(id),
      details: input
    })
    return id
  })
}

/** Sale primitive owned by Exit Permit issuance, never a standalone fulfillment action. */
export function issueFromStock(
  input: { productId: number; orderId: number; qtyMicro: number; notes?: string },
  ctx: ServiceContext
): { id: number; totalCostMinor: number } {
  requirePermission(ctx.session, P.releases.issue)
  if (!getRawConnection().inTransaction || !getRawConnection().prepare(`
    SELECT r.id FROM releases r JOIN orders o ON o.id = r.order_id
    WHERE r.order_id = ? AND r.status = 'active' AND o.status = 'confirmed'
      AND o.completed_at IS NULL
      AND EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.product_id = ?
        AND l.superseded_at IS NULL AND l.line_kind = 'standard' AND l.uncollected_product_id IS NULL)
      AND (SELECT COALESCE(SUM(l.quantity_micro), 0) FROM order_lines l
        WHERE l.order_id = o.id AND l.product_id = ? AND l.superseded_at IS NULL AND l.line_kind = 'standard' AND l.uncollected_product_id IS NULL) >= ? +
        (SELECT COALESCE(SUM(m.qty_micro), 0) FROM finished_goods_movements m
         WHERE m.order_id = o.id AND m.product_id = ? AND m.kind = 'sale_out'
           AND NOT EXISTS (SELECT 1 FROM finished_goods_movements x WHERE x.reversal_of_movement_id = m.id))`)
    .get(input.orderId, input.productId, input.productId, input.qtyMicro, input.productId))
    throw new AppError('CONFLICT', 'صرف المخزون الجاهز يتطلب معاملة إصدار إذن خروج')
  safeInteger(input.qtyMicro, 'الكمية', 1)
  return withTransaction(() => {
    if (!getDatabase().select().from(products).where(eq(products.id, input.productId)).get()) {
      throw notFound('المنتج غير موجود')
    }
    const { state } = currentStateInternal(input.productId)
    if (state.qtyMicro < BigInt(input.qtyMicro)) {
      throw new AppError(
        'CONFLICT',
        `المخزون الجاهز غير كافٍ. المتوفر: ${safeNumber(state.qtyMicro, 'كمية المخزون') / 1_000_000}`
      )
    }
    const totalCost = proportionalIssueCost(state, BigInt(input.qtyMicro))
    const totalCostMinor = safeNumber(totalCost, 'تكلفة الصرف')
    const unitCostMinor = unitCostFromTotal(totalCost, BigInt(input.qtyMicro))
    const id = Number(
      getDatabase()
        .insert(finishedGoodsMovements)
        .values({
          productId: input.productId,
          kind: 'sale_out',
          qtyMicro: input.qtyMicro,
          unitCostMinor,
          totalCostMinor,
          workSheetId: null,
          orderId: input.orderId,
          reversalOfMovementId: null,
          notes: input.notes ?? 'صرف من المخزون الجاهز لطلب عميل',
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'finishedGoods.issue',
      entity: 'finished_goods_movements',
      entityId: String(id),
      details: { ...input, totalCostMinor }
    })
    return { id, totalCostMinor }
  })
}

/** Privileged count/opening corrections, not production or customer sales. Positive
 * adjustments require explicit value; negative adjustments use current WAC. */
export function adjustFinishedGoods(
  input:
    | { productId: number; direction: 'in'; qtyMicro: number; totalCostMinor: number; notes: string }
    | { productId: number; direction: 'out'; qtyMicro: number; notes: string },
  ctx: ServiceContext
): { id: number; totalCostMinor: number } {
  requirePermission(ctx.session, P.inventory.adjust)
  safeInteger(input.qtyMicro, 'كمية التسوية', 1)
  if (!input.notes.trim()) throw new AppError('VALIDATION_ERROR', 'سبب التسوية مطلوب')
  if (input.direction === 'in') safeInteger(input.totalCostMinor, 'قيمة التسوية')
  return withTransaction(() => {
    const { state } = currentStateInternal(input.productId)
    const qty = BigInt(input.qtyMicro)
    const total =
      input.direction === 'in'
        ? BigInt(input.totalCostMinor)
        : proportionalIssueCost(state, qty)
    if (input.direction === 'in') {
      safeNumber(state.qtyMicro + qty, 'كمية المخزون بعد التسوية')
      safeNumber(state.valueMinor + total, 'قيمة المخزون بعد التسوية')
    }
    const totalCostMinor = safeNumber(total, 'قيمة التسوية')
    const id = Number(
      getDatabase()
        .insert(finishedGoodsMovements)
        .values({
          productId: input.productId,
          kind: input.direction === 'in' ? 'adjustment_in' : 'adjustment_out',
          qtyMicro: input.qtyMicro,
          unitCostMinor: unitCostFromTotal(total, qty),
          totalCostMinor,
          workSheetId: null,
          orderId: null,
          reversalOfMovementId: null,
          notes: input.notes,
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'finishedGoods.adjust',
      entity: 'finished_goods_movements',
      entityId: String(id),
      details: { ...input, totalCostMinor }
    })
    return { id, totalCostMinor }
  })
}

function reverseIssueInternal(movementId: number, reason: string, ctx: ServiceContext): number {
  const source = getRawConnection()
    .prepare(
      `SELECT id, product_id AS productId, kind, qty_micro AS qtyMicro,
              unit_cost_minor AS unitCostMinor, total_cost_minor AS totalCostMinor,
              work_sheet_id AS workSheetId, order_id AS orderId,
              reversal_of_movement_id AS reversalOfMovementId
         FROM finished_goods_movements WHERE id = ?`
    )
    .get(movementId) as LedgerMovement | undefined
  if (!source || source.kind !== 'sale_out') throw new AppError('CONFLICT', 'حركة البيع غير موجودة')
  if (getRawConnection().prepare('SELECT id FROM finished_goods_movements WHERE reversal_of_movement_id = ?').get(movementId)) {
    throw new AppError('CONFLICT', 'تم عكس حركة البيع بالفعل')
  }
  const parent = getRawConnection().prepare(`SELECT status FROM orders WHERE id = ?`).get(source.orderId) as { status: string } | undefined
  if (!getRawConnection().inTransaction || parent?.status !== 'cancelled')
    throw new AppError('CONFLICT', 'عكس المخزون الجاهز يتطلب معاملة إلغاء الطلب')
  requirePermission(ctx.session, P.orders.cancel)
  const { cutover, state } = currentStateInternal(source.productId)
  if (source.id <= cutover.movementIdThrough && cutover.classification !== 'unaffected') {
    throw new AppError(
      'CONFLICT',
      'لا يمكن عكس تكلفة بيع تاريخية متأثرة قبل مراجعتها محاسبياً'
    )
  }
  safeNumber(state.qtyMicro + BigInt(source.qtyMicro), 'كمية المخزون بعد العكس')
  safeNumber(state.valueMinor + BigInt(source.totalCostMinor), 'قيمة المخزون بعد العكس')
  const id = Number(
    getDatabase()
      .insert(finishedGoodsMovements)
      .values({
        productId: source.productId,
        kind: 'sale_reversal',
        qtyMicro: source.qtyMicro,
        unitCostMinor: source.unitCostMinor,
        totalCostMinor: source.totalCostMinor,
        workSheetId: null,
        orderId: source.orderId,
        reversalOfMovementId: source.id,
        notes: `عكس صرف مخزون جاهز: ${reason}`,
        createdBy: ctx.session.user.id,
        createdAt: nowIso()
      })
      .run().lastInsertRowid
  )
  recordAuditEvent({
    userId: ctx.session.user.id,
    action: 'finishedGoods.issue.reverse',
    entity: 'finished_goods_movements',
    entityId: String(id),
    details: { sourceMovementId: source.id, orderId: source.orderId, reason }
  })
  return id
}

export function reverseFinishedGoodsIssue(
  input: { movementId: number; reason: string },
  ctx: ServiceContext
): number {
  if (!input.reason.trim()) throw new AppError('VALIDATION_ERROR', 'سبب العكس مطلوب')
  // Check before opening a transaction: only the cancellation owner may restore stock.
  if (!getRawConnection().inTransaction) throw new AppError('CONFLICT', 'عكس المخزون الجاهز يتطلب معاملة إلغاء الطلب')
  return reverseIssueInternal(input.movementId, input.reason, ctx)
}

export function reverseFinishedGoodsIssuesForOrder(
  orderId: number,
  reason: string,
  ctx: ServiceContext
): number[] {
  if (!getRawConnection().inTransaction) throw new AppError('CONFLICT', 'عكس المخزون الجاهز يتطلب معاملة إلغاء الطلب')
  return withTransaction(() => {
    const rows = getRawConnection()
      .prepare(
        `SELECT m.id
           FROM finished_goods_movements m
          WHERE m.order_id = ? AND m.kind = 'sale_out'
            AND NOT EXISTS (
              SELECT 1 FROM finished_goods_movements r WHERE r.reversal_of_movement_id = m.id
            )
          ORDER BY m.id DESC`
      )
      .all(orderId) as Array<{ id: number }>
    return rows.map((row) => reverseIssueInternal(row.id, reason, ctx))
  })
}

/** Posted issue cost snapshots are immutable; reversals subtract explicitly. */
export function finishedGoodsCostForOrder(orderId: number): number {
  const rows = getRawConnection()
    .prepare(
      `SELECT kind, total_cost_minor AS totalCostMinor
         FROM finished_goods_movements
        WHERE order_id = ? AND kind IN ('sale_out', 'sale_reversal')`
    )
    .all(orderId) as Array<{ kind: string; totalCostMinor: number }>
  let total = 0n
  for (const row of rows) {
    safeInteger(row.totalCostMinor, 'تكلفة حركة الطلب')
    total += row.kind === 'sale_out' ? BigInt(row.totalCostMinor) : -BigInt(row.totalCostMinor)
  }
  if (total < 0n) throw new AppError('CONFLICT', 'تكلفة صرف الطلب أصبحت سالبة')
  return safeNumber(total, 'تكلفة البضاعة الجاهزة للطلب')
}

/**
 * DB-10: finishedGoodsCostForOrder for every order in `orderIds` (a subquery
 * yielding order ids) with one statement. The returned lookup applies the
 * same per-row validation and BigInt accumulation when it is called, so a
 * caller iterating orders in its own order raises the same first error.
 */
export function finishedGoodsCostsForOrders(orderIds: SQL): (orderId: number) => number {
  const byOrder = new Map<number, Array<{ kind: string; totalCostMinor: number }>>()
  for (const row of getDatabase().all<{ orderId: number; kind: string; totalCostMinor: number }>(sql`
    SELECT order_id AS orderId, kind, total_cost_minor AS totalCostMinor
      FROM finished_goods_movements
     WHERE order_id IN (${orderIds}) AND kind IN ('sale_out', 'sale_reversal')
  `)) {
    const rows = byOrder.get(row.orderId)
    if (rows) rows.push(row)
    else byOrder.set(row.orderId, [row])
  }
  return (orderId) => {
    let total = 0n
    for (const row of byOrder.get(orderId) ?? []) {
      safeInteger(row.totalCostMinor, 'تكلفة حركة الطلب')
      total += row.kind === 'sale_out' ? BigInt(row.totalCostMinor) : -BigInt(row.totalCostMinor)
    }
    if (total < 0n) throw new AppError('CONFLICT', 'تكلفة صرف الطلب أصبحت سالبة')
    return safeNumber(total, 'تكلفة البضاعة الجاهزة للطلب')
  }
}

/** True when this order still has an unreversed finished-goods issue. */
export function orderFulfilledFromStock(orderId: number): boolean {
  const row = getRawConnection()
    .prepare(
      `SELECT COUNT(*) AS c
         FROM finished_goods_movements m
        WHERE m.order_id = ? AND m.kind = 'sale_out'
          AND NOT EXISTS (
            SELECT 1 FROM finished_goods_movements r WHERE r.reversal_of_movement_id = m.id
          )`
    )
    .get(orderId) as { c: number }
  return row.c > 0
}
