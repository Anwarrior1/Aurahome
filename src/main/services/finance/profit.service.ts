import { z } from 'zod'
import { desc, eq, and, sql, type SQL } from 'drizzle-orm'
import { keysetBoundary, keysetOrder, keysetPage, type KeysetWindow, type PageRequest } from '../base/pagination'
import { getDatabase } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import {
  profitWithdrawals,
  savingsAllocations,
  savingsTransactions
} from '../../db/schema/finance.schema'
import { AppError, notFound } from '../../utils/errors'
import { applyPercent } from '@shared/money/cost'
import { money } from '@shared/money/money'
import { businessDate, businessMonthBounds } from '@shared/business-date'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, today, type ServiceContext } from '../base/service.types'
import { postCashMovement, adjustCashMovementForRef, removeCashMovementForRef } from './cash.service'
import { scheduledRecurringOccurrences } from './expenses.service'
import { resaleCostsForOrders, retainedMarginEvents } from '../sales/uncollected-products.service'
import { getSavingsRateBp } from '../settings.service'
export { setSavingsRateBp } from '../settings.service'
import { PERMISSION_KEYS } from '@shared/permissions/permission-keys'
import { requirePermission } from '../../permissions/permission-guard'
import { runOptionalIdempotentFinancialCommand } from './idempotency.service'
import { integerIdSchema, positiveMoneyMinorSchema } from '@shared/schemas/common.schema'
import { requireSafePositiveInteger } from '../../utils/numeric'

export interface MonthlyProfitSummary {
  year: number
  month: number
  revenueMinor: number
  materialCostMinor: number
  machineCostMinor: number
  workerCostMinor: number
  deliveryCostMinor: number
  orderLinkedExpensesMinor: number
  directOrderCostsMinor: number
  grossOrderProfitMinor: number
  generalExpensesMinor: number
  /** Gross payroll cost recognised for this exact payroll PERIOD
   *  (employee_transactions.period_year/period_month) — never by the
   *  calendar day a salary happened to be paid, which can land in a
   *  different month than the period it is for. */
  payrollExpenseMinor: number
  wasteLossMinor: number
  netProfitMinor: number
  savingsRateBp: number
  savingsProposedMinor: number
  savingsAllocatedMinor: number
  profitWithdrawalsMinor: number
  remainingProfitMinor: number
  completedOrderCount: number
  allocationConfirmed: boolean
}

function monthRange(year: number, month: number) {
  return businessMonthBounds(year, month)
}

function scalar(query: ReturnType<typeof sql>): number {
  const row = getDatabase().get<{ total: number | null }>(query)
  return row?.total ?? 0
}

interface ProfitComponents {
  completedOrderCount: number
  revenueMinor: number
  materialCostMinor: number
  machineCostMinor: number
  workerCostMinor: number
  deliveryCostMinor: number
  orderLinkedExpensesMinor: number
  generalExpensesMinor: number
  payrollExpenseMinor: number
  wasteLossMinor: number
}

const EMPTY_COMPONENTS: ProfitComponents = {
  completedOrderCount: 0,
  revenueMinor: 0,
  materialCostMinor: 0,
  machineCostMinor: 0,
  workerCostMinor: 0,
  deliveryCostMinor: 0,
  orderLinkedExpensesMinor: 0,
  generalExpensesMinor: 0,
  payrollExpenseMinor: 0,
  wasteLossMinor: 0
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

/**
 * The completed-orders-basis profit components for many months in a fixed
 * number of grouped statements. Each month keeps the exact per-month string
 * boundaries used by the single-month definition, and each order's actual cost
 * follows orderCostBreakdown (active issue lines net of active returns, the
 * finished-goods issue cost, unreversed machine/worker costs, recorded
 * completion costs and every order-linked expense).
 */
function profitComponentsByMonth(periods: Array<{ year: number; month: number }>): Map<string, ProfitComponents> {
  const result = new Map<string, ProfitComponents>()
  if (!periods.length) return result
  const monthRows = periods.map(({ year, month }) => {
    const { from, to, fromDate, toDate } = monthRange(year, month)
    return sql`SELECT ${monthKey(year, month)} AS key, ${year} AS y, ${month} AS m, ${from} AS from_ts, ${to} AS to_ts,
      ${fromDate} AS from_date, ${toDate} AS to_date`
  })
  const months = sql`months AS (${sql.join(monthRows, sql` UNION ALL `)})`
  // `+o.status` keeps the planner on orders_completed_idx: status alone is not selective.
  const completed = sql`completed AS MATERIALIZED (
    SELECT months.key, o.id, o.total_minor FROM months
    JOIN orders o ON +o.status = 'completed' AND o.completed_at >= months.from_ts AND o.completed_at <= months.to_ts
  )`
  const db = getDatabase()
  const ensure = (key: string) => {
    const existing = result.get(key)
    if (existing) return existing
    const created = { ...EMPTY_COMPONENTS }
    result.set(key, created)
    return created
  }

  // Finished-goods issue cost per order, validated exactly like finishedGoodsCostForOrder.
  for (const row of db.all<{ key: string; invalid: number; netCost: number }>(sql`
    WITH ${months}, ${completed}
    SELECT c.key,
      SUM(CASE WHEN typeof(m.total_cost_minor) != 'integer' OR m.total_cost_minor < 0 OR m.total_cost_minor > 9007199254740991 THEN 1 ELSE 0 END) AS invalid,
      SUM(CASE WHEN m.kind = 'sale_out' THEN m.total_cost_minor ELSE -m.total_cost_minor END) AS netCost
    FROM completed c
    JOIN finished_goods_movements m ON m.order_id = c.id AND m.kind IN ('sale_out', 'sale_reversal')
    GROUP BY c.key, c.id
  `)) {
    if (row.invalid > 0) throw new AppError('VALIDATION_ERROR', 'تكلفة حركة الطلب يجب أن يكون عدداً صحيحاً آمناً')
    if (row.netCost < 0) throw new AppError('CONFLICT', 'تكلفة صرف الطلب أصبحت سالبة')
    if (!Number.isSafeInteger(row.netCost)) throw new AppError('CONFLICT', 'تكلفة البضاعة الجاهزة للطلب تجاوز النطاق الحسابي الآمن')
    ensure(row.key).materialCostMinor += row.netCost
  }

  for (const row of db.all<{
    key: string; completedOrderCount: number; revenueMinor: number; materialLinesMinor: number; machineCostMinor: number
    workerCostMinor: number; deliveryCostMinor: number; orderLinkedExpensesMinor: number
  }>(sql`
    WITH ${months}, ${completed}, retained_margin AS MATERIALIZED (${retainedMarginEvents}),
    revenue AS (SELECT key, COUNT(*) AS n, SUM(total_minor) AS total FROM completed GROUP BY key),
    retained_by_month AS (
      SELECT months.key, SUM(r.profit_minor) AS total FROM months
      JOIN retained_margin r ON r.occurred_at >= months.from_ts AND r.occurred_at <= months.to_ts
      GROUP BY months.key
    ),
    material AS (
      SELECT c.key, SUM(l.actual_cost_minor - COALESCE((
          SELECT SUM(mra.cost_minor) FROM material_return_allocations mra
          JOIN material_returns mr ON mr.id = mra.return_id
          WHERE mra.issue_line_id = l.id AND mr.status = 'active'
        ), 0)) AS total
      FROM completed c
      JOIN order_material_lines l ON l.order_id = c.id AND l.status = 'active'
      JOIN materials mat ON mat.id = l.material_id
      GROUP BY c.key
    ),
    machine AS (
      SELECT c.key, SUM(u.final_amount_minor) AS total FROM completed c
      JOIN order_machine_usage u ON u.order_id = c.id AND u.reversed_at IS NULL
      JOIN machines mach ON mach.id = u.machine_id
      GROUP BY c.key
    ),
    worker AS (
      SELECT c.key, SUM(a.amount_minor) AS total FROM completed c
      JOIN order_worker_assignments a ON a.order_id = c.id AND a.reversed_at IS NULL
      GROUP BY c.key
    ),
    delivery AS (
      SELECT c.key, SUM(d.actual_cost_minor) AS total FROM completed c
      JOIN deliveries d ON d.order_id = c.id AND d.status = 'recorded'
      GROUP BY c.key
    ),
    linked AS (
      SELECT c.key, SUM(e.amount_minor) AS total FROM completed c
      JOIN expenses e ON e.order_id = c.id
      GROUP BY c.key
    )
    SELECT months.key,
      COALESCE(revenue.n, 0) AS completedOrderCount,
      COALESCE(revenue.total, 0) + COALESCE(retained_by_month.total, 0) AS revenueMinor,
      COALESCE(material.total, 0) AS materialLinesMinor,
      COALESCE(machine.total, 0) AS machineCostMinor,
      COALESCE(worker.total, 0) AS workerCostMinor,
      COALESCE(delivery.total, 0) AS deliveryCostMinor,
      COALESCE(linked.total, 0) AS orderLinkedExpensesMinor
    FROM months
    LEFT JOIN revenue ON revenue.key = months.key
    LEFT JOIN retained_by_month ON retained_by_month.key = months.key
    LEFT JOIN material ON material.key = months.key
    LEFT JOIN machine ON machine.key = months.key
    LEFT JOIN worker ON worker.key = months.key
    LEFT JOIN delivery ON delivery.key = months.key
    LEFT JOIN linked ON linked.key = months.key
  `)) {
    const target = ensure(row.key)
    target.completedOrderCount = row.completedOrderCount
    target.revenueMinor = row.revenueMinor
    target.materialCostMinor += row.materialLinesMinor
    target.machineCostMinor = row.machineCostMinor
    target.workerCostMinor = row.workerCostMinor
    target.deliveryCostMinor = row.deliveryCostMinor
    target.orderLinkedExpensesMinor += row.orderLinkedExpensesMinor
  }

  // BL-03: resold Uncollected Products charge their factory-borne cost and
  // preparation cost to the completed order that sold them.
  const resale = resaleCostsForOrders(sql`WITH ${months}, ${completed} SELECT id FROM completed`)
  if (resale.size) {
    for (const row of db.all<{ key: string; id: number }>(sql`WITH ${months}, ${completed} SELECT key, id FROM completed`)) {
      const cost = resale.get(row.id)
      if (!cost) continue
      ensure(row.key).materialCostMinor += cost.factoryBorneMinor
      ensure(row.key).orderLinkedExpensesMinor += cost.preparationMinor
    }
  }

  // General expenses: not order-linked, not payroll, not reversed, by spend date
  // (unary + keeps each month on expenses_date_idx). Payroll: the authoritative
  // payroll PERIOD figure net of unreversed deductions. Waste: a general
  // operational loss when it occurs.
  for (const row of db.all<{ key: string; generalExpensesMinor: number; payrollExpenseMinor: number; wasteLossMinor: number }>(sql`
    WITH ${months},
    general AS (
      SELECT months.key, SUM(e.amount_minor) AS total FROM months
      JOIN expenses e ON e.spent_at >= months.from_date AND e.spent_at <= months.to_date
      WHERE +e.order_id IS NULL AND +e.uncollected_product_id IS NULL AND +e.source != 'salary' AND +e.reversed_at IS NULL
      GROUP BY months.key
    ),
    payroll AS (
      SELECT t.period_year AS y, t.period_month AS m, SUM(
        CASE
          WHEN t.paid_amount_minor IS NOT NULL THEN t.paid_amount_minor
          ELSE MAX(t.amount_minor - COALESCE((
            SELECT SUM(child.amount_minor) FROM employee_transactions child
            WHERE child.parent_transaction_id = t.id
              AND child.kind = 'deduction' AND child.reversed_at IS NULL
          ), 0), 0)
        END
      ) AS total
      FROM employee_transactions t
      WHERE t.kind = 'salary_payment' AND t.reversed_at IS NULL
      GROUP BY t.period_year, t.period_month
    ),
    waste AS (
      SELECT months.key, SUM(mv.actual_cost_minor) AS total FROM months
      JOIN inventory_movements mv ON mv.kind = 'waste' AND mv.created_at >= months.from_ts AND mv.created_at <= months.to_ts
      GROUP BY months.key
    )
    SELECT months.key,
      COALESCE(general.total, 0) AS generalExpensesMinor,
      COALESCE(payroll.total, 0) AS payrollExpenseMinor,
      COALESCE(waste.total, 0) AS wasteLossMinor
    FROM months
    LEFT JOIN general ON general.key = months.key
    LEFT JOIN payroll ON payroll.y = months.y AND payroll.m = months.m
    LEFT JOIN waste ON waste.key = months.key
  `)) {
    const target = ensure(row.key)
    target.generalExpensesMinor = row.generalExpensesMinor
    target.payrollExpenseMinor = row.payrollExpenseMinor
    target.wasteLossMinor = row.wasteLossMinor
  }

  // DB-15: a month whose scheduled fixed expenses have not been posted yet
  // still costs exactly what the schedule says. Derived here — reading a
  // period must never write its expenses, and every caller of this function
  // (per-month and cumulative alike) therefore agrees on the same figure.
  const sorted = [...periods].sort((a, b) => a.year - b.year || a.month - b.month)
  const firstPeriod = sorted[0]!
  const lastPeriod = sorted[sorted.length - 1]!
  for (const occurrence of scheduledRecurringOccurrences(
    monthRange(firstPeriod.year, firstPeriod.month).fromDate,
    monthRange(lastPeriod.year, lastPeriod.month).toDate
  )) {
    const target = result.get(occurrence.periodStart.slice(0, 7))
    if (target) target.generalExpensesMinor += occurrence.amountMinor
  }
  return result
}

/**
 * Cumulative profit needs one total, not one row per historical month. Keep
 * the monthly path unchanged and aggregate the same components over one
 * continuous range so the Main process does not build and join a growing
 * UNION branch list.
 */
function profitComponentsForRange(from: string, to: string): ProfitComponents {
  const db = getDatabase()
  const fromDate = businessDate(new Date(from))
  const toDate = businessDate(new Date(to))
  const start = new Date(from)
  const end = new Date(to)
  const fromPeriod = start.getFullYear() * 12 + start.getMonth() + 1
  const toPeriod = end.getFullYear() * 12 + end.getMonth() + 1

  const totals = db.get<{
    completedOrderCount: number
    revenueMinor: number
    retainedMarginMinor: number
    materialLinesMinor: number
    machineCostMinor: number
    workerCostMinor: number
    deliveryCostMinor: number
    orderLinkedExpensesMinor: number
  }>(sql`
    WITH completed AS MATERIALIZED (
      SELECT id, total_minor FROM orders
      WHERE +status = 'completed' AND completed_at >= ${from} AND completed_at <= ${to}
    ), retained_margin AS MATERIALIZED (${retainedMarginEvents})
    SELECT
      (SELECT COUNT(*) FROM completed) AS completedOrderCount,
      (SELECT COALESCE(SUM(total_minor), 0) FROM completed) AS revenueMinor,
      (SELECT COALESCE(SUM(profit_minor), 0) FROM retained_margin
        WHERE occurred_at >= ${from} AND occurred_at <= ${to}) AS retainedMarginMinor,
      (SELECT COALESCE(SUM(l.actual_cost_minor - COALESCE((
        SELECT SUM(mra.cost_minor) FROM material_return_allocations mra
        JOIN material_returns mr ON mr.id = mra.return_id
        WHERE mra.issue_line_id = l.id AND mr.status = 'active'
      ), 0)), 0) FROM completed c
        JOIN order_material_lines l ON l.order_id = c.id AND l.status = 'active'
        JOIN materials mat ON mat.id = l.material_id) AS materialLinesMinor,
      (SELECT COALESCE(SUM(u.final_amount_minor), 0) FROM completed c
        JOIN order_machine_usage u ON u.order_id = c.id AND u.reversed_at IS NULL
        JOIN machines mach ON mach.id = u.machine_id) AS machineCostMinor,
      (SELECT COALESCE(SUM(a.amount_minor), 0) FROM completed c
        JOIN order_worker_assignments a ON a.order_id = c.id AND a.reversed_at IS NULL) AS workerCostMinor,
      (SELECT COALESCE(SUM(d.actual_cost_minor), 0) FROM completed c
        JOIN deliveries d ON d.order_id = c.id AND d.status = 'recorded') AS deliveryCostMinor,
      (SELECT COALESCE(SUM(e.amount_minor), 0) FROM completed c
        JOIN expenses e ON e.order_id = c.id) AS orderLinkedExpensesMinor
  `) ?? {
    completedOrderCount: 0,
    revenueMinor: 0,
    retainedMarginMinor: 0,
    materialLinesMinor: 0,
    machineCostMinor: 0,
    workerCostMinor: 0,
    deliveryCostMinor: 0,
    orderLinkedExpensesMinor: 0
  }

  let finishedGoodsMinor = 0
  for (const row of db.all<{ invalid: number; netCost: number }>(sql`
    WITH completed AS MATERIALIZED (
      SELECT id FROM orders
      WHERE +status = 'completed' AND completed_at >= ${from} AND completed_at <= ${to}
    )
    SELECT c.id,
      SUM(CASE WHEN typeof(m.total_cost_minor) != 'integer' OR m.total_cost_minor < 0 OR m.total_cost_minor > 9007199254740991 THEN 1 ELSE 0 END) AS invalid,
      SUM(CASE WHEN m.kind = 'sale_out' THEN m.total_cost_minor ELSE -m.total_cost_minor END) AS netCost
    FROM completed c
    JOIN finished_goods_movements m ON m.order_id = c.id AND m.kind IN ('sale_out', 'sale_reversal')
    GROUP BY c.id
  `)) {
    if (row.invalid > 0) throw new AppError('VALIDATION_ERROR', 'تكلفة حركة الطلب يجب أن يكون عدداً صحيحاً آمناً')
    if (row.netCost < 0) throw new AppError('CONFLICT', 'تكلفة صرف الطلب أصبحت سالبة')
    if (!Number.isSafeInteger(row.netCost)) throw new AppError('CONFLICT', 'تكلفة البضاعة الجاهزة للطلب تجاوز النطاق الحسابي الآمن')
    finishedGoodsMinor += row.netCost
  }

  const overhead = db.get<{
    generalExpensesMinor: number
    payrollExpenseMinor: number
    wasteLossMinor: number
  }>(sql`
    SELECT
      (SELECT COALESCE(SUM(amount_minor), 0) FROM expenses
        WHERE spent_at >= ${fromDate} AND spent_at <= ${toDate}
          AND +order_id IS NULL AND +uncollected_product_id IS NULL AND +source != 'salary' AND +reversed_at IS NULL) AS generalExpensesMinor,
      (SELECT COALESCE(SUM(CASE
          WHEN t.paid_amount_minor IS NOT NULL THEN t.paid_amount_minor
          ELSE MAX(t.amount_minor - COALESCE((
            SELECT SUM(child.amount_minor) FROM employee_transactions child
            WHERE child.parent_transaction_id = t.id
              AND child.kind = 'deduction' AND child.reversed_at IS NULL
          ), 0), 0)
        END), 0)
        FROM employee_transactions t
        WHERE t.kind = 'salary_payment' AND t.reversed_at IS NULL
          AND (t.period_year * 12 + t.period_month) BETWEEN ${fromPeriod} AND ${toPeriod}) AS payrollExpenseMinor,
      (SELECT COALESCE(SUM(actual_cost_minor), 0) FROM inventory_movements
        WHERE kind = 'waste' AND created_at >= ${from} AND created_at <= ${to}) AS wasteLossMinor
  `) ?? { generalExpensesMinor: 0, payrollExpenseMinor: 0, wasteLossMinor: 0 }

  let resaleFactoryMinor = 0
  let resalePreparationMinor = 0
  for (const cost of resaleCostsForOrders(sql`
    SELECT id FROM orders WHERE +status = 'completed' AND completed_at >= ${from} AND completed_at <= ${to}
  `).values()) {
    resaleFactoryMinor += cost.factoryBorneMinor
    resalePreparationMinor += cost.preparationMinor
  }

  return {
    completedOrderCount: totals.completedOrderCount,
    revenueMinor: totals.revenueMinor + totals.retainedMarginMinor,
    materialCostMinor: totals.materialLinesMinor + finishedGoodsMinor + resaleFactoryMinor,
    machineCostMinor: totals.machineCostMinor,
    workerCostMinor: totals.workerCostMinor,
    deliveryCostMinor: totals.deliveryCostMinor,
    orderLinkedExpensesMinor: totals.orderLinkedExpensesMinor + resalePreparationMinor,
    generalExpensesMinor: overhead.generalExpensesMinor + scheduledRecurringOccurrences(fromDate, toDate)
      .reduce((sum, occurrence) => sum + occurrence.amountMinor, 0),
    payrollExpenseMinor: overhead.payrollExpenseMinor,
    wasteLossMinor: overhead.wasteLossMinor
  }
}

function netProfitOf(components: ProfitComponents): number {
  const directOrderCostsMinor =
    components.materialCostMinor +
    components.machineCostMinor +
    components.workerCostMinor +
    components.deliveryCostMinor +
    components.orderLinkedExpensesMinor
  return (
    components.revenueMinor -
    directOrderCostsMinor -
    components.generalExpensesMinor -
    components.payrollExpenseMinor -
    components.wasteLossMinor
  )
}

/**
 * BR-105/BR-106: completed-orders basis. Revenue is the selling price
 * of orders COMPLETED in the month, and each such order's full actual
 * cost is recognised in that same month. General operating expenses
 * and waste losses are recognised when they occur.
 *
 * BR-101: operating expenses, the savings allocation and owner profit
 * withdrawals are reported as three separate figures and are never
 * mixed into one another.
 */
export function monthlyProfitSummary(year: number, month: number): MonthlyProfitSummary {
  const { fromDate, toDate } = monthRange(year, month)
  // Item 8/9/10: whichever fixed expenses apply to this month are part of
  // generalExpensesMinor below — posted rows plus, for a month not posted
  // yet, the schedule's own figure (DB-15). This is the ONLY place that
  // number comes from, so there is no separate calculation to keep in sync.

  const components = profitComponentsByMonth([{ year, month }]).get(monthKey(year, month)) ?? EMPTY_COMPONENTS
  const directOrderCostsMinor =
    components.materialCostMinor +
    components.machineCostMinor +
    components.workerCostMinor +
    components.deliveryCostMinor +
    components.orderLinkedExpensesMinor
  const grossOrderProfitMinor = components.revenueMinor - directOrderCostsMinor
  const netProfitMinor = netProfitOf(components)

  const savingsRateBp = getSavingsRateBp()
  // BR-111: a loss or zero-profit month proposes nothing.
  const savingsProposedMinor =
    netProfitMinor > 0 ? applyPercent(money(netProfitMinor), savingsRateBp) : 0

  const allocation = getDatabase()
    .select()
    .from(savingsAllocations)
    .where(and(eq(savingsAllocations.periodYear, year), eq(savingsAllocations.periodMonth, month)))
    .get()

  const profitWithdrawalsMinor = scalar(sql`
    SELECT COALESCE(SUM(amount_minor), 0) AS total FROM profit_withdrawals
    WHERE withdrawn_at >= ${fromDate} AND withdrawn_at <= ${toDate}
  `)

  const savingsAllocatedMinor = allocation?.amountMinor ?? 0

  return {
    year,
    month,
    revenueMinor: components.revenueMinor,
    materialCostMinor: components.materialCostMinor,
    machineCostMinor: components.machineCostMinor,
    workerCostMinor: components.workerCostMinor,
    deliveryCostMinor: components.deliveryCostMinor,
    orderLinkedExpensesMinor: components.orderLinkedExpensesMinor,
    directOrderCostsMinor,
    grossOrderProfitMinor,
    generalExpensesMinor: components.generalExpensesMinor,
    payrollExpenseMinor: components.payrollExpenseMinor,
    wasteLossMinor: components.wasteLossMinor,
    netProfitMinor,
    savingsRateBp,
    savingsProposedMinor,
    savingsAllocatedMinor,
    profitWithdrawalsMinor,
    remainingProfitMinor: netProfitMinor - savingsAllocatedMinor - profitWithdrawalsMinor,
    completedOrderCount: components.completedOrderCount,
    allocationConfirmed: Boolean(allocation)
  }
}

export interface SavingsOverview {
  year: number
  month: number
  /** Straight from monthlyProfitSummary — the one net-profit figure. */
  netProfitMinor: number
  savingsRateBp: number
  /** netProfitMinor × savingsRateBp, computed here, never typed in. */
  allocatedMinor: number
  confirmedMinor: number
  allocationConfirmed: boolean
  fundBalanceMinor: number
}

/**
 * The whole of the الادخار screen: net profit for the selected period,
 * the configured rate, and the amount those two produce.
 *
 * It deliberately holds NO profit formula of its own — it reads
 * monthlyProfitSummary, the same authoritative source the Profit screen
 * and the Dashboard use, so the three can never disagree. The
 * multiplication is applyPercent over integer minor units (BigInt), so
 * no floating-point money arithmetic is involved anywhere.
 */
export function savingsOverview(year: number, month: number): SavingsOverview {
  const summary = monthlyProfitSummary(year, month)
  return {
    year,
    month,
    netProfitMinor: summary.netProfitMinor,
    savingsRateBp: summary.savingsRateBp,
    allocatedMinor: summary.savingsProposedMinor,
    confirmedMinor: summary.savingsAllocatedMinor,
    allocationConfirmed: summary.allocationConfirmed,
    fundBalanceMinor: savingsBalanceMinor()
  }
}

/** Cumulative net profit across all months up to and including now. */
export function cumulativeNetProfitMinor(now: Date = new Date()): number {
  const { to, toDate } = monthRange(now.getFullYear(), now.getMonth() + 1)
  const toPeriod = now.getFullYear() * 12 + now.getMonth() + 1
  const first = getDatabase().get<{ d: string | null; hasRevenue: number }>(sql`
    WITH first_completed AS MATERIALIZED (
      SELECT MIN(completed_at) AS d FROM orders
      WHERE +status = 'completed' AND completed_at IS NOT NULL AND completed_at <= ${to}
    ), retained_margin AS MATERIALIZED (${retainedMarginEvents}), recurring_first AS (
      SELECT r.id, r.end_date,
        CASE WHEN r.start_date > MIN(a.effective_from) THEN r.start_date ELSE MIN(a.effective_from) END AS first_period
      FROM recurring_expenses r
      JOIN recurring_expense_amounts a ON a.recurring_expense_id = r.id
      WHERE r.active = 1
      GROUP BY r.id
    ), financial_events(d) AS (
      VALUES
        ((SELECT d FROM first_completed)),
        ((SELECT MIN(occurred_at) FROM retained_margin WHERE profit_minor > 0 AND occurred_at <= ${to})),
        ((SELECT MIN(spent_at) FROM expenses
          WHERE spent_at <= ${toDate}
            AND +order_id IS NULL AND +uncollected_product_id IS NULL
            AND +source != 'salary' AND +reversed_at IS NULL)),
        ((SELECT MIN(printf('%04d-%02d-01', period_year, period_month)) FROM employee_transactions
          WHERE kind = 'salary_payment' AND reversed_at IS NULL
            AND period_year IS NOT NULL AND period_month IS NOT NULL
            AND (period_year * 12 + period_month) <= ${toPeriod})),
        ((SELECT MIN(created_at) FROM inventory_movements
          WHERE kind = 'waste' AND created_at <= ${to})),
        ((SELECT MIN(first_period)
          FROM recurring_first
          WHERE first_period <= ${toDate}
            AND (end_date IS NULL OR first_period <= end_date)))
    )
    SELECT MIN(d) AS d,
      (EXISTS(SELECT 1 FROM first_completed WHERE d IS NOT NULL)
        OR EXISTS(SELECT 1 FROM retained_margin WHERE profit_minor > 0 AND occurred_at <= ${to})) AS hasRevenue
    FROM financial_events
  `)
  if (!first?.hasRevenue || !first.d) return 0
  const firstDate = first.d.length === 10 ? first.d : businessDate(new Date(first.d))
  const [firstYear, firstMonth] = firstDate.split('-').map(Number) as [number, number]
  const from = monthRange(firstYear, firstMonth).from
  return netProfitOf(profitComponentsForRange(from, to))
}

export function savingsBalanceMinor(): number {
  const row = getDatabase().get<{ allocated: number; used: number }>(sql`
    SELECT
      COALESCE(SUM(CASE WHEN kind = 'allocation' THEN amount_minor ELSE 0 END), 0) AS allocated,
      COALESCE(SUM(CASE WHEN kind = 'usage' THEN amount_minor ELSE 0 END), 0) AS used
    FROM savings_transactions
  `)
  return (row?.allocated ?? 0) - (row?.used ?? 0)
}

export function totalWithdrawnMinor(): number {
  return scalar(sql`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM profit_withdrawals`)
}

export function totalAllocatedMinor(): number {
  return scalar(
    sql`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM savings_transactions WHERE kind = 'allocation'`
  )
}

/**
 * BR-113: profit available to withdraw = cumulative net profit
 * − Savings & Investment allocations − prior withdrawals.
 */
export function availableProfitMinor(): number {
  return cumulativeNetProfitMinor() - totalAllocatedMinor() - totalWithdrawnMinor()
}

/**
 * BR-98/BR-110/BR-111: the system proposes the allocation from the
 * month's final net profit and the OWNER CONFIRMS it before anything
 * is added to the fund. The rate used is stored on the allocation, so
 * a later rate change never rewrites history.
 */
export function confirmSavingsAllocation(
  input: { year: number; month: number; requestKey?: string },
  ctx: ServiceContext
): { amountMinor: number; rateBp: number } {
  requirePermission(ctx.session, PERMISSION_KEYS.savings.manage)
  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'profit.confirmSavingsAllocation',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        const summary = monthlyProfitSummary(input.year, input.month)
        if (summary.allocationConfirmed) {
          throw new AppError('CONFLICT', 'تم اعتماد مخصص هذا الشهر بالفعل')
        }
        if (summary.netProfitMinor <= 0) {
          throw new AppError('CONFLICT', 'لا يوجد مخصص ادخار لهذا الشهر لأن صافي الربح صفر أو سالب')
        }
        const allocationId = Number(
          getDatabase()
            .insert(savingsAllocations)
            .values({
              periodYear: input.year,
              periodMonth: input.month,
              netProfitMinor: summary.netProfitMinor,
              rateBp: summary.savingsRateBp,
              amountMinor: summary.savingsProposedMinor,
              confirmedAt: nowIso(),
              confirmedBy: ctx.session.user.id,
              createdAt: nowIso()
            })
            .run().lastInsertRowid
        )
        getDatabase()
          .insert(savingsTransactions)
          .values({
            kind: 'allocation',
            amountMinor: summary.savingsProposedMinor,
            allocationId,
            notes: `مخصص ${input.month}/${input.year}`,
            occurredAt: nowIso(),
            createdBy: ctx.session.user.id,
            createdAt: nowIso()
          })
          .run()

        recordAuditEvent({
          userId: ctx.session.user.id,
          action: 'savings.allocate',
          entity: 'savings_allocations',
          entityId: String(allocationId),
          details: {
            year: input.year,
            month: input.month,
            rateBp: summary.savingsRateBp,
            amountMinor: summary.savingsProposedMinor
          }
        })
        return { amountMinor: summary.savingsProposedMinor, rateBp: summary.savingsRateBp }
      })
  })
}

function getAllocationById(id: number) {
  const allocation = getDatabase()
    .select()
    .from(savingsAllocations)
    .where(eq(savingsAllocations.id, id))
    .get()
  if (!allocation) throw notFound('المخصص غير موجود')
  return allocation
}

/**
 * Corrects an approved allocation's rate — the only field this
 * changes. The period and the net profit it was confirmed against are
 * frozen facts about that month (never editable here, so an edit can
 * never drift onto a different month's history), and the amount is
 * always RE-DERIVED from netProfitMinor × the new rate — the exact
 * same formula confirmSavingsAllocation used — so a percentage can
 * never disagree with the stored amount.
 *
 * An allocation has no cash/ledger effect of its own (BR-98: it is a
 * post-profit bookkeeping entry, never a cash movement), so the only
 * other row this must keep in lock-step is its paired
 * savings_transactions row, which savingsBalanceMinor() sums live.
 */
export function updateSavingsAllocation(
  id: number,
  input: { rateBp: number },
  ctx: ServiceContext
): { amountMinor: number } {
  requirePermission(ctx.session, PERMISSION_KEYS.savings.manage)
  if (!Number.isSafeInteger(input.rateBp) || input.rateBp < 0 || input.rateBp > 10000) {
    throw new AppError('VALIDATION_ERROR', 'نسبة الادخار يجب أن تكون بين 0% و100%')
  }
  const existing = getAllocationById(id)
  const newAmountMinor =
    existing.netProfitMinor > 0 ? applyPercent(money(existing.netProfitMinor), input.rateBp) : 0

  // Item 6/8: the fund's balance is always derived live from
  // savings_transactions — shrinking this allocation below money
  // already drawn out via recordSavingsUsage would drive that
  // derived balance negative, corrupting the fund's history.
  const diff = newAmountMinor - existing.amountMinor
  if (diff < 0 && savingsBalanceMinor() + diff < 0) {
    throw new AppError(
      'CONFLICT',
      'لا يمكن تخفيض هذا المخصص لأن جزءاً من رصيد صندوق الادخار تم استخدامه بالفعل'
    )
  }

  return withTransaction(() => {
    getDatabase()
      .update(savingsAllocations)
      .set({ rateBp: input.rateBp, amountMinor: newAmountMinor })
      .where(eq(savingsAllocations.id, id))
      .run()
    getDatabase()
      .update(savingsTransactions)
      .set({ amountMinor: newAmountMinor })
      .where(
        and(eq(savingsTransactions.allocationId, id), eq(savingsTransactions.kind, 'allocation'))
      )
      .run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'savings.allocation.update',
      entity: 'savings_allocations',
      entityId: String(id),
      details: {
        description: `Savings allocation correction (${existing.periodMonth}/${existing.periodYear})`,
        before: { rateBp: existing.rateBp, amountMinor: existing.amountMinor },
        after: { rateBp: input.rateBp, amountMinor: newAmountMinor }
      }
    })
    return { amountMinor: newAmountMinor }
  })
}

/**
 * Removes an approved allocation and its paired savings_transactions
 * row together — there is no cash/ledger row to reverse (BR-98), so
 * this alone is the complete, correct un-approval: the fund's derived
 * balance and the period's `allocationConfirmed` flag both update
 * immediately, since neither is ever a stored figure.
 */
export function deleteSavingsAllocation(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, PERMISSION_KEYS.savings.manage)
  const existing = getAllocationById(id)
  if (savingsBalanceMinor() - existing.amountMinor < 0) {
    throw new AppError(
      'CONFLICT',
      'لا يمكن حذف هذا المخصص لأن جزءاً من رصيد صندوق الادخار تم استخدامه بالفعل'
    )
  }

  withTransaction(() => {
    getDatabase()
      .delete(savingsTransactions)
      .where(
        and(eq(savingsTransactions.allocationId, id), eq(savingsTransactions.kind, 'allocation'))
      )
      .run()
    getDatabase().delete(savingsAllocations).where(eq(savingsAllocations.id, id)).run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'savings.allocation.delete',
      entity: 'savings_allocations',
      entityId: String(id),
      details: {
        description: `Savings allocation deletion (${existing.periodMonth}/${existing.periodYear})`,
        periodYear: existing.periodYear,
        periodMonth: existing.periodMonth,
        rateBp: existing.rateBp,
        amountMinor: existing.amountMinor
      }
    })
  })
}

/** BR-99: money later taken out of the fund, recorded separately. */
export function recordSavingsUsage(
  input: {
    amountMinor: number
    cashAccountId?: number
    notes?: string
    occurredAt?: string
    requestKey?: string
  },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, PERMISSION_KEYS.savings.manage)
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')
  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'profit.recordSavingsUsage',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        if (input.amountMinor > savingsBalanceMinor()) {
          throw new AppError('CONFLICT', 'المبلغ أكبر من رصيد صندوق الادخار')
        }
        const id = Number(
          getDatabase()
            .insert(savingsTransactions)
            .values({
              kind: 'usage',
              amountMinor: input.amountMinor,
              cashAccountId: input.cashAccountId ?? null,
              notes: input.notes ?? null,
              occurredAt: input.occurredAt ?? nowIso(),
              createdBy: ctx.session.user.id,
              createdAt: nowIso()
            })
            .run().lastInsertRowid
        )
        postCashMovement({
          accountId: input.cashAccountId,
          direction: 'in',
          amountMinor: input.amountMinor,
          kind: 'savings_usage',
          refTable: 'savings_transactions',
          refId: id,
          occurredAt: input.occurredAt ?? today(),
          ctx
        })
        recordAuditEvent({
          userId: ctx.session.user.id,
          action: 'savings.usage',
          entity: 'savings_transactions',
          entityId: String(id),
          details: input
        })
        return id
      })
  })
}

export function savingsHistory(request: PageRequest = {}) {
  return {
    // One allocation per confirmed month: bounded by the calendar, not by activity.
    allocations: getDatabase()
      .select()
      .from(savingsAllocations)
      .orderBy(desc(savingsAllocations.periodYear), desc(savingsAllocations.periodMonth))
      .all(),
    transactions: keysetPage({
      scope: 'profit.savingsHistory.transactions',
      filters: {},
      request,
      keyTypes: ['int'],
      order: 'desc',
      keyOf: (row) => [row.id],
      fetch: (window: KeysetWindow) => getDatabase()
        .select()
        .from(savingsTransactions)
        .where(keysetBoundary([sql`${savingsTransactions.id}`], window))
        .orderBy(keysetOrder([sql`${savingsTransactions.id}`], window))
        .limit(window.take)
        .all(),
      summary: () => undefined
    }),
    balanceMinor: savingsBalanceMinor()
  }
}

/**
 * BR-96/BR-113: an owner draw from calculated net profit. It is never
 * an operating expense, and a withdrawal larger than the remaining
 * available profit is BLOCKED.
 */
export function recordProfitWithdrawal(
  input: {
    amountMinor: number
    person?: string
    notes?: string
    cashAccountId?: number
    withdrawnAt?: string
    requestKey?: string
  },
  ctx: ServiceContext
): { id: number; availableAfterMinor: number } {
  requirePermission(ctx.session, PERMISSION_KEYS.withdrawals.manage)
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')

  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'profit.recordWithdrawal',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        const available = availableProfitMinor()
        if (input.amountMinor > available) {
          throw new AppError(
            'CONFLICT',
            'المبلغ يتجاوز الأرباح المتاحة للسحب. لا يمكن سحب أكثر من الربح المتبقي'
          )
        }
        const id = Number(
          getDatabase()
            .insert(profitWithdrawals)
            .values({
              amountMinor: input.amountMinor,
              withdrawnAt: input.withdrawnAt ?? today(),
              person: input.person ?? ctx.session.user.fullName,
              notes: input.notes ?? null,
              cashAccountId: input.cashAccountId ?? null,
              createdBy: ctx.session.user.id,
              createdAt: nowIso()
            })
            .run().lastInsertRowid
        )
        postCashMovement({
          accountId: input.cashAccountId,
          direction: 'out',
          amountMinor: input.amountMinor,
          kind: 'profit_withdrawal',
          refTable: 'profit_withdrawals',
          refId: id,
          occurredAt: input.withdrawnAt ?? today(),
          ctx
        })
        recordAuditEvent({
          userId: ctx.session.user.id,
          action: 'withdrawals.create',
          entity: 'profit_withdrawals',
          entityId: String(id),
          details: input
        })
        return { id, availableAfterMinor: available - input.amountMinor }
      })
  })
}

// Optimistic snapshot prevents a dialog opened before another correction from
// overwriting it. No new persisted financial total or version column is needed.
const withdrawalSnapshotSchema = z
  .object({
    amountMinor: positiveMoneyMinorSchema,
    person: z.string().nullable(),
    notes: z.string().nullable(),
    withdrawnAt: z.string(),
    cashAccountId: integerIdSchema.nullable(),
    createdAt: z.string()
  })
  .strict()

export const withdrawalDeleteSchema = z
  .object({
    id: integerIdSchema,
    expected: withdrawalSnapshotSchema
  })
  .strict()

export const withdrawalEditSchema = withdrawalDeleteSchema
  .extend({
    amountMinor: positiveMoneyMinorSchema,
    person: z.string().nullable(),
    notes: z.string().nullable()
  })
  .strict()

function checkedWithdrawal(id: number, expected: z.infer<typeof withdrawalSnapshotSchema>) {
  const existing = getDatabase()
    .select()
    .from(profitWithdrawals)
    .where(eq(profitWithdrawals.id, id))
    .get()
  if (!existing) throw notFound('سحب الأرباح غير موجود أو تم حذفه')
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (existing[key] !== expected[key]) {
      throw new AppError('CONFLICT', 'تم تغيير السحب. حدّث القائمة وافتح العملية مجدداً')
    }
  }
  return existing
}

export function updateProfitWithdrawal(
  input: z.infer<typeof withdrawalEditSchema>,
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, PERMISSION_KEYS.withdrawals.manage)
  const parsed = withdrawalEditSchema.safeParse(input)
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'بيانات سحب الأرباح غير صحيحة')
  const req = parsed.data
  withTransaction(() => {
    const existing = checkedWithdrawal(req.id, req.expected)
    const next = { amountMinor: req.amountMinor, person: req.person, notes: req.notes }
    if (
      existing.amountMinor === next.amountMinor &&
      existing.person === next.person &&
      existing.notes === next.notes
    )
      return
    // The existing draw already counts in availableProfitMinor. Only its
    // increase consumes additional available profit; corrections downward
    // remain possible even if subsequent expenses have made profit negative.
    if (
      next.amountMinor > existing.amountMinor &&
      next.amountMinor - existing.amountMinor > availableProfitMinor()
    ) {
      throw new AppError('CONFLICT', 'المبلغ يتجاوز الأرباح المتاحة للسحب')
    }
    getDatabase().update(profitWithdrawals).set(next).where(eq(profitWithdrawals.id, req.id)).run()
    if (existing.cashAccountId) adjustCashMovementForRef('profit_withdrawals', req.id, {
      amountMinor: next.amountMinor,
      occurredAt: existing.withdrawnAt
    })
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'withdrawals.update',
      entity: 'profit_withdrawals',
      entityId: String(req.id),
      details: { before: existing, after: { ...existing, ...next } }
    })
  })
}

export function deleteProfitWithdrawal(
  input: z.infer<typeof withdrawalDeleteSchema>,
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, PERMISSION_KEYS.withdrawals.manage)
  const parsed = withdrawalDeleteSchema.safeParse(input)
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'بيانات سحب الأرباح غير صحيحة')
  const req = parsed.data
  withTransaction(() => {
    const existing = checkedWithdrawal(req.id, req.expected)
    getDatabase().delete(profitWithdrawals).where(eq(profitWithdrawals.id, req.id)).run()
    removeCashMovementForRef('profit_withdrawals', req.id)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'withdrawals.delete',
      entity: 'profit_withdrawals',
      entityId: String(req.id),
      details: { before: existing }
    })
  })
}

export function listWithdrawals(filter: { from?: string; to?: string } = {}, request: PageRequest = {}) {
  const normalized = { from: filter.from, to: filter.to }
  const clauses: SQL[] = []
  if (normalized.from) clauses.push(sql`${profitWithdrawals.withdrawnAt} >= ${normalized.from}`)
  if (normalized.to) clauses.push(sql`${profitWithdrawals.withdrawnAt} <= ${normalized.to}`)
  return keysetPage({
    scope: 'profit.withdrawals',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => getDatabase()
      .select()
      .from(profitWithdrawals)
      .where(and(...clauses, keysetBoundary([sql`${profitWithdrawals.id}`], window)))
      .orderBy(keysetOrder([sql`${profitWithdrawals.id}`], window))
      .limit(window.take)
      .all(),
    // Both figures are company-wide, independent of the page and period filter.
    summary: () => ({ availableMinor: availableProfitMinor(), totalWithdrawnMinor: totalWithdrawnMinor() })
  })
}

export function getAllocation(year: number, month: number) {
  const allocation = getDatabase()
    .select()
    .from(savingsAllocations)
    .where(and(eq(savingsAllocations.periodYear, year), eq(savingsAllocations.periodMonth, month)))
    .get()
  if (!allocation) throw notFound('لا يوجد مخصص لهذا الشهر')
  return allocation
}
