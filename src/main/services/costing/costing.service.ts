import { eq, sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { getOrderOrThrow } from '../sales/orders.service'
import { materialLinesForOrder } from '../production/production.service'
import { machineUsageForOrder } from '../production/machines.service'
import { finishedGoodsCostForOrder, finishedGoodsCostsForOrders } from '../production/finished-goods.service'
import { orderWorkerAssignments, workers } from '../../db/schema/production.schema'
import { orderLines } from '../../db/schema/sales.schema'
import { materials } from '../../db/schema/catalog.schema'
import { costOf, multiplyDivideRounded, unitCostMicro } from '@shared/money/cost'
import { isManufacturableOrderLine, isStandardStockLine } from '../sales/order-line-manufacturing'
import { NO_RESALE_COST, resaleCostsForOrders, retainedMarginEvents } from '../sales/uncollected-products.service'
import { dayStart, dayEnd } from '../base/service.types'
import { businessDate } from '@shared/business-date'

export interface OrderCostBreakdown {
  orderId: number
  documentNumber: string
  /** BR-19: the five actual-cost components. */
  materialCostMinor: number
  machineCostMinor: number
  workerCostMinor: number
  deliveryCostMinor: number
  linkedExpensesMinor: number
  totalActualCostMinor: number
  /** BR-20: selling price is what the user decided, after discount. */
  sellingPriceMinor: number
  actualProfitMinor: number
  /**
   * BR-40: the reference basis shown while pricing — the COMMERCIAL
   * material value (what the customer is charged for materials under
   * each material's pricing rule), never the actual FIFO cost.
   */
  commercialMaterialValueMinor: number
  costBasisMinor: number
  isComplete: boolean
}

function scalar(query: ReturnType<typeof sql>): number {
  const row = getDatabase().get<{ total: number | null }>(query)
  return row?.total ?? 0
}

/**
 * BR-19/BR-20: assembles TOTAL ACTUAL ORDER COST and compares it with
 * the selling price to derive ACTUAL ORDER PROFIT.
 *
 * The commercial material amount charged to the customer and the
 * actual physical material cost are reported as two separate figures
 * and are never mixed (BR-12/BR-20).
 */
export function orderCostBreakdown(orderId: number): OrderCostBreakdown {
  const order = getOrderOrThrow(orderId)

  const materialLines = materialLinesForOrder(orderId)
  // Item 19: an order fulfilled out of finished-goods stock did not
  // consume raw material itself — its cost of goods is the production
  // cost carried by the finished goods issued to it. Both paths land in
  // the same actual-material figure, so profit is right either way.
  // BL-03: a resold Uncollected Product is cost of goods too — only the part of
  // its manufacture the original customer's retained money did not cover.
  const resale = resaleCostsForOrders(sql`SELECT ${orderId}`).get(orderId) ?? NO_RESALE_COST
  const materialCostMinor =
    materialLines.reduce((sum, line) => sum + line.netCostMinor, 0) +
    finishedGoodsCostForOrder(orderId) +
    resale.factoryBorneMinor
  const commercialMaterialValueMinor = materialLines.reduce(
    (sum, line) => sum + line.commercialValueMinor,
    0
  )

  const machineCostMinor = machineUsageForOrder(orderId).reduce(
    (sum, usage) => sum + usage.finalAmountMinor,
    0
  )

  const workerCostMinor = scalar(
    sql`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM order_worker_assignments WHERE order_id = ${orderId} AND reversed_at IS NULL`
  )

  const deliveryCostMinor = scalar(
    sql`SELECT COALESCE(SUM(actual_cost_minor), 0) AS total
        FROM deliveries
        WHERE order_id = ${orderId} AND status = 'recorded'`
  )

  const linkedExpensesMinor = scalar(
    sql`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM expenses WHERE order_id = ${orderId}`
  ) + resale.preparationMinor

  const totalActualCostMinor =
    materialCostMinor + machineCostMinor + workerCostMinor + deliveryCostMinor + linkedExpensesMinor

  const sellingPriceMinor = order.totalMinor
  // Contract price remains visible, but a cancelled source has no completed
  // sale: its realized margin comes only from retained money at transfer.
  const actualProfitMinor = order.status === 'cancelled'
    ? (getDatabase().get<{ profitMinor: number }>(sql`
        SELECT profit_minor AS profitMinor FROM (${retainedMarginEvents}) WHERE order_id = ${orderId}
      `)?.profitMinor ?? 0)
    : sellingPriceMinor - totalActualCostMinor

  return {
    orderId,
    documentNumber: order.documentNumber,
    materialCostMinor,
    machineCostMinor,
    workerCostMinor,
    deliveryCostMinor,
    linkedExpensesMinor,
    totalActualCostMinor,
    sellingPriceMinor,
    actualProfitMinor,
    commercialMaterialValueMinor,
    costBasisMinor:
      commercialMaterialValueMinor +
      machineCostMinor +
      workerCostMinor +
      deliveryCostMinor +
      linkedExpensesMinor,
    isComplete: Boolean(order.completedAt)
  }
}

/**
 * Item 16/17 — the ESTIMATE, kept structurally separate from the actual
 * cost above so the two can never be confused for one another.
 *
 * The estimate is what was entered while pricing (carried from the
 * quotation onto the order at conversion). Material estimate falls back
 * to the BOM of any standard product line valued at its current market
 * price when no figure was entered, so a standard product always has a
 * usable expected cost without anyone re-typing its BOM.
 */
export interface OrderCostEstimate {
  orderId: number
  estimatedMaterialMinor: number
  estimatedWorkerMinor: number
  estimatedMachineMinor: number
  estimatedOtherMinor: number
  estimatedOrderExpenseMinor: number
  estimatedTotalMinor: number
  sellingPriceMinor: number
  expectedProfitMinor: number
  /** Estimate vs. what actually happened — the whole point of item 17. */
  actualTotalMinor: number
  actualProfitMinor: number
  varianceMinor: number
}

export function orderCostEstimate(orderId: number): OrderCostEstimate {
  const order = getOrderOrThrow(orderId)
  const actual = orderCostBreakdown(orderId)

  const estimatedMaterialMinor = order.estimatedMaterialMinor || bomEstimateForOrder(orderId)
  const estimatedOrderExpenseMinor =
    scalar(sql`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM planned_order_expenses WHERE order_id = ${orderId}`) +
    order.estimatedOtherMinor
  const estimatedTotalMinor =
    estimatedMaterialMinor +
    order.estimatedWorkerMinor +
    order.estimatedMachineMinor +
    estimatedOrderExpenseMinor

  return {
    orderId,
    estimatedMaterialMinor,
    estimatedWorkerMinor: order.estimatedWorkerMinor,
    estimatedMachineMinor: order.estimatedMachineMinor,
    estimatedOtherMinor: order.estimatedOtherMinor,
    estimatedOrderExpenseMinor,
    estimatedTotalMinor,
    sellingPriceMinor: order.totalMinor,
    expectedProfitMinor: order.totalMinor - estimatedTotalMinor,
    actualTotalMinor: actual.totalActualCostMinor,
    actualProfitMinor: actual.actualProfitMinor,
    // Positive = production cost more than expected.
    varianceMinor: actual.totalActualCostMinor - estimatedTotalMinor
  }
}

/**
 * Falls back to the frozen BOM snapshot on each order line, valued at
 * each material's CURRENT market price. This is an estimate, so market
 * price is the right basis — actual cost always comes from FIFO.
 */
function bomEstimateForOrder(orderId: number): number {
  const lines = getDatabase().select().from(orderLines).where(eq(orderLines.orderId, orderId)).all()
    // Estimate only: a standard line still has an expected BOM cost.
    .filter((line) => isManufacturableOrderLine(line) || isStandardStockLine(line))
  let total = 0
  for (const line of lines) {
    if (!line.bomSnapshot) continue
    const bom = JSON.parse(line.bomSnapshot) as {
      lines: Array<{ materialId: number; qtyMicro: number }>
    }
    for (const bomLine of bom.lines ?? []) {
      const material = getDatabase()
        .select()
        .from(materials)
        .where(eq(materials.id, bomLine.materialId))
        .get()
      if (!material) continue
      // qty × unit price, scaled per BOM quantity of the order line.
      const perUnit = costOf(bomLine.qtyMicro, unitCostMicro(material.currentMarketPriceMicro))
      total += multiplyDivideRounded(perUnit, line.quantityMicro, 1_000_000)
    }
  }
  return total
}

export function orderCostDetail(orderId: number) {
  return {
    summary: orderCostBreakdown(orderId),
    estimate: orderCostEstimate(orderId),
    materials: materialLinesForOrder(orderId),
    machines: machineUsageForOrder(orderId),
    workers: getDatabase()
      .select({
        id: orderWorkerAssignments.id,
        workerId: orderWorkerAssignments.workerId,
        workerName: workers.name,
        method: orderWorkerAssignments.method,
        percentBp: orderWorkerAssignments.percentBp,
        baseKind: orderWorkerAssignments.baseKind,
        baseAmountMinor: orderWorkerAssignments.baseAmountMinor,
        amountMinor: orderWorkerAssignments.amountMinor,
        earned: orderWorkerAssignments.earned,
        earnedAt: orderWorkerAssignments.earnedAt,
        notes: orderWorkerAssignments.notes
      })
      .from(orderWorkerAssignments)
      .innerJoin(workers, eq(orderWorkerAssignments.workerId, workers.id))
      .where(sql`${orderWorkerAssignments.orderId} = ${orderId} AND ${orderWorkerAssignments.reversedAt} IS NULL`)
      .all()
  }
}

function profitabilityPeriodPredicate(filter: { from?: string; to?: string }) {
  const effective = sql`COALESCE(completed_at, created_at)`
  const dateOnly = sql`${effective} GLOB '????-??-??'`
  // SQLite's retained space/zone-less timestamp forms represent UTC instants.
  // A historical date-only value has calendar precision: never invent its time.
  const instant = sql`CASE WHEN ${effective} GLOB '????-??-??[T ]*' THEN julianday(${effective}) END`
  const calendarBound = (value: string) => value.length === 10 ? value : businessDate(new Date(
    /[Zz]$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
  ))
  const from = filter.from?.length === 10 ? dayStart(filter.from) : filter.from
  const toIsDate = filter.to?.length === 10
  const to = toIsDate ? new Date(new Date(dayEnd(filter.to!)).getTime() + 1).toISOString() : filter.to
  return sql`(
    (${dateOnly}
      ${filter.from ? sql`AND ${effective} >= ${calendarBound(filter.from)}` : sql``}
      ${filter.to ? sql`AND ${effective} <= ${calendarBound(filter.to)}` : sql``})
    OR (NOT (${dateOnly})
      ${from ? sql`AND ${instant} >= julianday(${from})` : sql``}
      ${to ? (toIsDate ? sql`AND ${instant} < julianday(${to})` : sql`AND ${instant} <= julianday(${to})`) : sql``})
  )`
}

/**
 * BR-25: profitability across many orders, for the reports module.
 *
 * DB-10: the complete requested set is computed with two statements however
 * many orders it contains: every order's cost components as indexed per-order
 * aggregates, and the selected orders' finished-goods issue movements. Each
 * row equals orderCostBreakdown for that order, which stays the single-order
 * authority (same joins, filters and integer arithmetic).
 */
export function orderProfitabilityReport(filter: { from?: string; to?: string; completedOnly?: boolean }): OrderCostBreakdown[] {
  const where = sql`
    WHERE status != 'cancelled'
      ${filter.completedOnly ? sql`AND completed_at IS NOT NULL` : sql``}
      ${filter.from || filter.to ? sql`AND ${profitabilityPeriodPredicate(filter)}` : sql``}`
  const rows = getDatabase().all<{
    orderId: number
    documentNumber: string
    sellingPriceMinor: number
    completedAt: string | null
    materialLinesMinor: number
    commercialMaterialValueMinor: number
    machineCostMinor: number
    workerCostMinor: number
    deliveryCostMinor: number
    linkedExpensesMinor: number
  }>(sql`
    SELECT o.id AS orderId, o.document_number AS documentNumber, o.total_minor AS sellingPriceMinor,
      o.completed_at AS completedAt,
      COALESCE((
        SELECT SUM(l.actual_cost_minor - COALESCE((
          SELECT SUM(mra.cost_minor) FROM material_return_allocations mra
          JOIN material_returns mr ON mr.id = mra.return_id
          WHERE mra.issue_line_id = l.id AND mr.status = 'active'
        ), 0))
        FROM order_material_lines l JOIN materials mat ON mat.id = l.material_id
        WHERE l.order_id = o.id AND l.status = 'active'
      ), 0) AS materialLinesMinor,
      COALESCE((
        SELECT SUM(l.commercial_value_minor)
        FROM order_material_lines l JOIN materials mat ON mat.id = l.material_id
        WHERE l.order_id = o.id AND l.status = 'active'
      ), 0) AS commercialMaterialValueMinor,
      COALESCE((
        SELECT SUM(u.final_amount_minor)
        FROM order_machine_usage u JOIN machines mach ON mach.id = u.machine_id
        WHERE u.order_id = o.id AND u.reversed_at IS NULL
      ), 0) AS machineCostMinor,
      COALESCE((
        SELECT SUM(a.amount_minor) FROM order_worker_assignments a
        WHERE a.order_id = o.id AND a.reversed_at IS NULL
      ), 0) AS workerCostMinor,
      COALESCE((
        SELECT SUM(d.actual_cost_minor) FROM deliveries d
        WHERE d.order_id = o.id AND d.status = 'recorded'
      ), 0) AS deliveryCostMinor,
      COALESCE((SELECT SUM(e.amount_minor) FROM expenses e WHERE e.order_id = o.id), 0) AS linkedExpensesMinor
    FROM orders o
    ${where}
    ORDER BY o.id DESC
  `)
  const finishedGoodsCost = finishedGoodsCostsForOrders(sql`SELECT id FROM orders ${where}`)
  const resaleCost = resaleCostsForOrders(sql`SELECT id FROM orders ${where}`)

  return rows.map((row) => {
    const resale = resaleCost.get(row.orderId) ?? NO_RESALE_COST
    const materialCostMinor = row.materialLinesMinor + finishedGoodsCost(row.orderId) + resale.factoryBorneMinor
    const linkedExpensesMinor = row.linkedExpensesMinor + resale.preparationMinor
    const totalActualCostMinor =
      materialCostMinor + row.machineCostMinor + row.workerCostMinor + row.deliveryCostMinor + linkedExpensesMinor
    return {
      orderId: row.orderId,
      documentNumber: row.documentNumber,
      materialCostMinor,
      machineCostMinor: row.machineCostMinor,
      workerCostMinor: row.workerCostMinor,
      deliveryCostMinor: row.deliveryCostMinor,
      linkedExpensesMinor,
      totalActualCostMinor,
      sellingPriceMinor: row.sellingPriceMinor,
      actualProfitMinor: row.sellingPriceMinor - totalActualCostMinor,
      commercialMaterialValueMinor: row.commercialMaterialValueMinor,
      costBasisMinor:
        row.commercialMaterialValueMinor +
        row.machineCostMinor +
        row.workerCostMinor +
        row.deliveryCostMinor +
        linkedExpensesMinor,
      isComplete: Boolean(row.completedAt)
    }
  })
}
