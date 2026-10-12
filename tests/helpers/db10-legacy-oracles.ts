/**
 * Pre-DB-10 read implementations, preserved ONLY for tests.
 *
 * They are the BEFORE benchmark and the exact-equivalence oracle for the
 * set-based production replacements. They intentionally keep the original
 * per-row/per-order query structure.
 */
import { and, desc, eq, like, or, sql, getTableColumns } from 'drizzle-orm'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { releases, deliveries, workSheets } from '@main/db/schema/production.schema'
import { orders, quotations } from '@main/db/schema/sales.schema'
import { customers, suppliers, purchases, supplierPayments } from '@main/db/schema/parties.schema'
import { products } from '@main/db/schema/products.schema'
import { cashAccounts, expenses, expenseCategories, profitWithdrawals, savingsAllocations, savingsTransactions } from '@main/db/schema/finance.schema'
import { workerTransactions, workers } from '@main/db/schema/production.schema'
import { employees, employeeTransactions } from '@main/db/schema/hr.schema'
import { stateToken } from '@main/utils/state-token'
import { notFound } from '@main/utils/errors'
import { releaseWorkersFor, deliveryWorkersFor } from '@main/services/production/production.service'
import { finishedGoodsValuation, orderFulfilledFromStock } from '@main/services/production/finished-goods.service'
import { accountBalance, transactionCount } from '@main/services/finance/cash.service'
import { orderPaymentPosition } from '@main/services/sales/final-invoices.service'
import { fullDeletePreview } from '@main/services/sales/orders.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { scheduledRecurringOccurrences } from '@main/services/finance/expenses.service'
import { getSavingsRateBp } from '@main/services/settings.service'
import { applyPercent } from '@shared/money/cost'
import { money } from '@shared/money/money'
import { hasPermission } from '@main/permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import type { AuthSession } from '@shared/types/user.types'
import {
  completionKindForPermit,
  isExitPermitKind,
  legacyUnlinkedCompletionKindForPermit
} from '@shared/production/exit-permit'
import { employeeBalance, salaryHistory } from '@main/services/hr/employees.service'
import { workerBalances } from '@main/services/production/workers.service'

function legacyReleaseReversalToken(id: number): string {
  const db = getDatabase()
  return stateToken({ permit: db.select().from(releases).where(eq(releases.id, id)).get(),
    deliveries: db.all(sql`SELECT id, status FROM deliveries WHERE release_id = ${id} ORDER BY id`) })
}

export function legacyListReleases(filter: { orderId?: number; kind?: string; search?: string; includeReversed?: boolean } = {}) {
  const clauses = []
  if (!filter.includeReversed) clauses.push(eq(releases.status, 'active'))
  if (filter.orderId) clauses.push(eq(releases.orderId, filter.orderId))
  if (filter.kind) clauses.push(eq(releases.kind, filter.kind))
  if (filter.search?.trim()) {
    clauses.push(sql`${releases.documentNumber} LIKE ${'%' + filter.search.trim() + '%'}`)
  }
  const rows = getDatabase()
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
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(releases.id))
    .all()
  return rows.map((row) => {
    const completionKind = isExitPermitKind(row.kind) ? completionKindForPermit(row.kind) : null
    const legacyCompletionKind = isExitPermitKind(row.kind) ? legacyUnlinkedCompletionKindForPermit(row.kind) : null
    const completionRecorded = completionKind
      ? Boolean(getDatabase().get<{ found: number }>(sql`
          SELECT 1 AS found
          FROM deliveries
          WHERE status = 'recorded'
            AND (
              release_id = ${row.id}
              OR (
                release_id IS NULL
                AND order_id = ${row.orderId}
                AND (kind = ${completionKind} OR kind = ${legacyCompletionKind})
              )
            )
          LIMIT 1
        `)?.found)
      : false
    return {
      ...row,
      reversalToken: legacyReleaseReversalToken(row.id),
      workers: releaseWorkersFor(row.id),
      completionKind,
      completionRecorded
    }
  })
}

export function legacyListDeliveries(filter: { from?: string; to?: string; kind?: string; orderId?: number } = {}) {
  const clauses = [eq(deliveries.status, 'recorded')]
  if (filter.kind) clauses.push(eq(deliveries.kind, filter.kind))
  if (filter.orderId) clauses.push(eq(deliveries.orderId, filter.orderId))
  if (filter.from) clauses.push(sql`${deliveries.recordedAt} >= ${filter.from}`)
  if (filter.to) clauses.push(sql`${deliveries.recordedAt} <= ${filter.to}`)
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
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(deliveries.id))
    .all()
  return rows.map((row) => ({ ...row, workers: deliveryWorkersFor(row.id).map((w) => w.name) }))
}

export function legacyListFinishedGoods(filter: { productId?: number } = {}) {
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
  return rows.map((product) => ({ ...product, ...finishedGoodsValuation(product.id) }))
}

export function legacyListAccounts(filter: { asOf?: string } = {}) {
  const rows = getDatabase().select().from(cashAccounts).all()
  return rows.map((account) => ({
    ...account,
    balanceMinor: accountBalance(account.id, filter.asOf),
    currentBalanceMinor: accountBalance(account.id),
    transactionCount: transactionCount(account.id)
  }))
}

function manufacturingOrderEverIssued(orderId: number): boolean {
  return Boolean(getDatabase().get<{ found: number }>(sql`
    SELECT 1 AS found FROM work_sheets WHERE order_id = ${orderId} LIMIT 1
  `)?.found)
}

function manufacturingOrderCompleted(orderId: number): boolean {
  return Boolean(getDatabase().get<{ found: number }>(sql`
    SELECT 1 AS found FROM work_sheets
    WHERE order_id = ${orderId} AND status = 'completed' AND reversed_at IS NULL LIMIT 1
  `)?.found)
}

function manufacturingOrderInProduction(orderId: number): boolean {
  return Boolean(getDatabase().get<{ found: number }>(sql`
    SELECT 1 AS found FROM work_sheets
    WHERE order_id = ${orderId} AND status = 'in_production' AND started_at IS NOT NULL
    LIMIT 1
  `)?.found)
}

function activeManufacturingOrderExists(orderId: number): boolean {
  return Boolean(getDatabase().get(sql`SELECT 1 FROM work_sheets WHERE order_id = ${orderId} AND status != 'reversed' LIMIT 1`))
}

function refundLifecycleBlocked(orderId: number): boolean {
  return Boolean(getDatabase().get<{ blocked: number }>(sql`SELECT (
    EXISTS (SELECT 1 FROM work_sheets w WHERE w.order_id = ${orderId} AND (
      w.status != 'reversed' OR w.started_at IS NOT NULL OR w.completed_at IS NOT NULL
      OR w.status IN ('in_production', 'completed')))
    OR EXISTS (SELECT 1 FROM releases WHERE order_id = ${orderId} AND status = 'active')
    OR EXISTS (SELECT 1 FROM deliveries WHERE order_id = ${orderId} AND status = 'recorded')
    OR EXISTS (SELECT 1 FROM finished_goods_movements m WHERE m.order_id = ${orderId}
      AND m.kind = 'sale_out' AND NOT EXISTS (
        SELECT 1 FROM finished_goods_movements r WHERE r.reversal_of_movement_id = m.id))
  ) AS blocked`)?.blocked)
}

/** Risk 04: every current line resells an Uncollected Product and nothing was ever issued. */
function resaleOnlyOrder(orderId: number): boolean {
  const lines = getDatabase().get<{ total: number; resold: number }>(sql`
    SELECT COUNT(*) AS total, COUNT(uncollected_product_id) AS resold FROM order_lines WHERE order_id = ${orderId} AND superseded_at IS NULL
  `)!
  return lines.total > 0 && lines.total === lines.resold && !manufacturingOrderEverIssued(orderId)
}

function orderHasRecordedFulfilment(orderId: number): boolean {
  return Boolean(getDatabase().get<{ found: number }>(sql`
    SELECT 1 AS found FROM deliveries WHERE order_id = ${orderId} AND status = 'recorded' LIMIT 1
  `)?.found)
}

export function legacyOrderActionEligibility(order: { id: number; status: string; archivedAt: string | null }) {
  const payment = !order.archivedAt && order.status === 'confirmed' ? orderPaymentPosition(order.id) : null
  const manufacturingEverIssued = manufacturingOrderEverIssued(order.id)
  const financiallyUnpaid = payment?.paidMinor === 0
  const canEnterDeleteWorkflow =
    payment !== null && financiallyUnpaid && !manufacturingEverIssued && fullDeletePreview(order.id).blockers.length === 0
  return {
    canDeleteCancel: canEnterDeleteWorkflow,
    canCancel:
      payment !== null &&
      payment.paidMinor >= 0 &&
      (manufacturingOrderCompleted(order.id) || manufacturingOrderInProduction(order.id) ||
        (!activeManufacturingOrderExists(order.id) && (orderFulfilledFromStock(order.id) ||
          (resaleOnlyOrder(order.id) && payment.paidMinor === 0)))) &&
      !orderHasRecordedFulfilment(order.id),
    canArchive: !order.archivedAt && (order.status === 'completed' || order.status === 'cancelled'),
    canRefundPayment: payment !== null && payment.paidMinor > 0 && !refundLifecycleBlocked(order.id),
    refundableMinor: Math.max(payment?.paidMinor ?? 0, 0)
  }
}

export function legacyListOrders(filter: {
  archived?: boolean; includeArchived?: boolean; limit?: number; offset?: number; search?: string
  customerId?: number; status?: string; paymentStatus?: string; from?: string; to?: string
}) {
  const clauses = []
  if (!filter.includeArchived)
    clauses.push(filter.archived ? sql`${orders.archivedAt} IS NOT NULL` : sql`${orders.archivedAt} IS NULL`)
  if (filter.customerId) clauses.push(eq(orders.customerId, filter.customerId))
  if (filter.status) clauses.push(eq(orders.status, filter.status))
  if (filter.paymentStatus) clauses.push(eq(orders.paymentStatus, filter.paymentStatus))
  if (filter.from) clauses.push(sql`${orders.createdAt} >= ${filter.from}`)
  if (filter.to) clauses.push(sql`${orders.createdAt} <= ${filter.to}`)
  if (filter.search?.trim()) {
    const p = `%${filter.search.trim()}%`
    clauses.push(or(like(orders.documentNumber, p), like(customers.name, p)))
  }
  return getDatabase()
    .select({
      id: orders.id,
      documentNumber: orders.documentNumber,
      customerId: orders.customerId,
      customerName: customers.name,
      status: orders.status,
      archivedAt: orders.archivedAt,
      totalMinor: orders.totalMinor,
      depositRequiredMinor: orders.depositRequiredMinor,
      paidMinor: orders.paidMinor,
      remainingMinor: orders.remainingMinor,
      paymentStatus: orders.paymentStatus,
      requiresInstallation: orders.requiresInstallation,
      requiresDelivery: orders.requiresDelivery,
      completedAt: orders.completedAt,
      createdAt: orders.createdAt
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(orders.id))
    .limit(Math.max(1, Math.min(100, Math.trunc(filter.limit ?? 100))))
    .offset(Math.max(0, Math.trunc(filter.offset ?? 0)))
    .all()
    .map((order) => ({ ...order, ...legacyOrderActionEligibility(order) }))
}

function monthRange(year: number, month: number): { from: string; to: string } {
  const from = new Date(Date.UTC(year, month - 1, 1)).toISOString()
  const to = new Date(Date.UTC(year, month, 1) - 1).toISOString()
  return { from, to }
}

function scalar(query: ReturnType<typeof sql>): number {
  const row = getDatabase().get<{ total: number | null }>(query)
  return row?.total ?? 0
}

/** Independent BL-22 membership oracle; retains the per-order cost loop. */
export function legacyOrderProfitabilityReport(filter: { from?: string; to?: string; completedOnly?: boolean }) {
  const rows = getDatabase().all<{ id: number; effectiveAt: string }>(sql`
    SELECT id, COALESCE(completed_at, created_at) AS effectiveAt FROM orders
    WHERE status != 'cancelled'
      ${filter.completedOnly ? sql`AND completed_at IS NOT NULL` : sql``}
    ORDER BY id DESC
  `)
  const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  // Explicit UTC for retained SQLite timestamps: JS would otherwise parse space
  // forms in the host timezone. No production SQL/predicate is used here.
  const epoch = (value: string) => Date.parse(/[Zz]$|[+-]\d{2}:\d{2}$/.test(value)
    ? value : `${value.replace(' ', 'T')}Z`)
  const localDay = (value: string) => {
    if (isDate(value)) return value
    const date = new Date(epoch(value))
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const bound = (value: string, nextDay: boolean) => {
    if (!isDate(value)) return epoch(value)
    const [year, month, day] = value.split('-').map(Number)
    return new Date(year!, month! - 1, day! + Number(nextDay)).getTime()
  }
  return rows.filter(({ effectiveAt }) => {
    if (!filter.from && !filter.to) return true
    if (isDate(effectiveAt)) {
      return (!filter.from || effectiveAt >= localDay(filter.from)) && (!filter.to || effectiveAt <= localDay(filter.to))
    }
    if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(effectiveAt)) return false
    const at = epoch(effectiveAt)
    return Number.isFinite(at) && (!filter.from || at >= bound(filter.from, false)) &&
      (!filter.to || (isDate(filter.to) ? at < bound(filter.to, true) : at <= bound(filter.to, false)))
  }).map((row) => orderCostBreakdown(row.id))
}

export function legacyMonthlyProfitSummary(year: number, month: number) {
  const { from, to } = monthRange(year, month)
  const completed = getDatabase().all<{ id: number }>(sql`
    SELECT id FROM orders
    WHERE status = 'completed' AND completed_at >= ${from} AND completed_at <= ${to}
  `)
  let revenueMinor = 0
  let materialCostMinor = 0
  let machineCostMinor = 0
  let workerCostMinor = 0
  let deliveryCostMinor = 0
  let orderLinkedExpensesMinor = 0
  for (const row of completed) {
    const breakdown = orderCostBreakdown(row.id)
    revenueMinor += breakdown.sellingPriceMinor
    materialCostMinor += breakdown.materialCostMinor
    machineCostMinor += breakdown.machineCostMinor
    workerCostMinor += breakdown.workerCostMinor
    deliveryCostMinor += breakdown.deliveryCostMinor
    orderLinkedExpensesMinor += breakdown.linkedExpensesMinor
  }
  const directOrderCostsMinor = materialCostMinor + machineCostMinor + workerCostMinor + deliveryCostMinor + orderLinkedExpensesMinor
  const grossOrderProfitMinor = revenueMinor - directOrderCostsMinor
  const fromDate = from.slice(0, 10)
  const toDate = to.slice(0, 10)
  // DB-15: posted rows plus the months the schedule implies but nobody has
  // posted yet — the same two parts the service adds up.
  const generalExpensesMinor = scalar(sql`
    SELECT COALESCE(SUM(amount_minor), 0) AS total FROM expenses
    WHERE order_id IS NULL AND source != 'salary' AND reversed_at IS NULL
      AND spent_at >= ${fromDate} AND spent_at <= ${toDate}
  `) + scheduledRecurringOccurrences(fromDate, toDate)
    .filter((occurrence) => occurrence.periodStart >= fromDate && occurrence.periodStart <= toDate)
    .reduce((sum, occurrence) => sum + occurrence.amountMinor, 0)
  const payrollExpenseMinor = scalar(sql`
    SELECT COALESCE(SUM(
      CASE
        WHEN t.paid_amount_minor IS NOT NULL THEN t.paid_amount_minor
        ELSE MAX(t.amount_minor - COALESCE((
          SELECT SUM(child.amount_minor) FROM employee_transactions child
          WHERE child.parent_transaction_id = t.id
            AND child.kind = 'deduction' AND child.reversed_at IS NULL
        ), 0), 0)
      END
    ), 0) AS total FROM employee_transactions t
    WHERE t.kind = 'salary_payment' AND t.period_year = ${year} AND t.period_month = ${month}
      AND t.reversed_at IS NULL
  `)
  const wasteLossMinor = scalar(sql`
    SELECT COALESCE(SUM(actual_cost_minor), 0) AS total FROM inventory_movements
    WHERE kind = 'waste' AND created_at >= ${from} AND created_at <= ${to}
  `)
  const netProfitMinor = grossOrderProfitMinor - generalExpensesMinor - payrollExpenseMinor - wasteLossMinor
  const savingsRateBp = getSavingsRateBp()
  const savingsProposedMinor = netProfitMinor > 0 ? applyPercent(money(netProfitMinor), savingsRateBp) : 0
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
    year, month, revenueMinor, materialCostMinor, machineCostMinor, workerCostMinor, deliveryCostMinor,
    orderLinkedExpensesMinor, directOrderCostsMinor, grossOrderProfitMinor, generalExpensesMinor,
    payrollExpenseMinor, wasteLossMinor, netProfitMinor, savingsRateBp, savingsProposedMinor,
    savingsAllocatedMinor, profitWithdrawalsMinor,
    remainingProfitMinor: netProfitMinor - savingsAllocatedMinor - profitWithdrawalsMinor,
    completedOrderCount: completed.length,
    allocationConfirmed: Boolean(allocation)
  }
}

export function legacyCumulativeNetProfitMinor(now = new Date()): number {
  const db = getDatabase()
  const { to } = monthRange(now.getUTCFullYear(), now.getUTCMonth() + 1)
  const toDate = to.slice(0, 10)
  const toPeriod = now.getUTCFullYear() * 12 + now.getUTCMonth() + 1
  const firstOrder = db.get<{ d: string | null }>(sql`
    SELECT MIN(completed_at) AS d FROM orders
    WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at <= ${to}
  `)
  if (!firstOrder?.d) return 0

  const candidates = [
    firstOrder.d,
    db.get<{ d: string | null }>(sql`
      SELECT MIN(spent_at) AS d FROM expenses
      WHERE spent_at <= ${toDate}
        AND order_id IS NULL AND uncollected_product_id IS NULL
        AND source != 'salary' AND reversed_at IS NULL
    `)?.d,
    db.get<{ d: string | null }>(sql`
      SELECT MIN(printf('%04d-%02d-01', period_year, period_month)) AS d
      FROM employee_transactions
      WHERE kind = 'salary_payment' AND reversed_at IS NULL
        AND period_year IS NOT NULL AND period_month IS NOT NULL
        AND (period_year * 12 + period_month) <= ${toPeriod}
    `)?.d,
    db.get<{ d: string | null }>(sql`
      SELECT MIN(created_at) AS d FROM inventory_movements
      WHERE kind = 'waste' AND created_at <= ${to}
    `)?.d,
    db.get<{ d: string | null }>(sql`
      SELECT MIN(first_period) AS d FROM (
        SELECT r.end_date,
          CASE WHEN r.start_date > MIN(a.effective_from) THEN r.start_date ELSE MIN(a.effective_from) END AS first_period
        FROM recurring_expenses r
        JOIN recurring_expense_amounts a ON a.recurring_expense_id = r.id
        WHERE r.active = 1
        GROUP BY r.id
      )
      WHERE first_period <= ${toDate} AND (end_date IS NULL OR first_period <= end_date)
    `)?.d
  ].filter((date): date is string => Boolean(date))

  const start = new Date(candidates.sort()[0]!)
  let total = 0
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  while (cursor <= now) {
    total += legacyMonthlyProfitSummary(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1).netProfitMinor
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return total
}

export function legacyAvailableProfitMinor(now = new Date()): number {
  const allocated = scalar(sql`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM savings_transactions WHERE kind = 'allocation'`)
  const withdrawn = scalar(sql`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM profit_withdrawals`)
  return legacyCumulativeNetProfitMinor(now) - allocated - withdrawn
}

function legacyListExpenses(filter: { from?: string; to?: string }) {
  const clauses = []
  if (filter.from) clauses.push(sql`${expenses.spentAt} >= ${filter.from}`)
  if (filter.to) clauses.push(sql`${expenses.spentAt} <= ${filter.to}`)
  return getDatabase()
    .select({ id: expenses.id, amountMinor: expenses.amountMinor, categoryName: expenseCategories.name })
    .from(expenses)
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(expenses.id))
    .all()
}

export function legacyDashboardSummary(
  input: { date: string; year: number; month: number; currentDay: boolean },
  session: AuthSession
) {
  const db = getDatabase()
  const canOrders = hasPermission(session, P.dashboard.viewOrders)
  const canSales = hasPermission(session, P.dashboard.viewSales)
  const canCosts = hasPermission(session, P.dashboard.viewCosts)
  const canProfits = hasPermission(session, P.dashboard.viewProfits)
  const canFinancialAlerts = hasPermission(session, P.dashboard.viewFinancialAlerts)
  const orderRows = canOrders || canSales
    ? db.all<{
        id: number; documentNumber: string; customerName: string; totalMinor: number; paidMinor: number
        remainingMinor: number; paymentStatus: string; status: string; createdAt: string
      }>(sql`
        SELECT o.id, o.document_number AS documentNumber, c.name AS customerName,
               o.total_minor AS totalMinor, o.paid_minor AS paidMinor,
               o.remaining_minor AS remainingMinor, o.payment_status AS paymentStatus,
               o.status, o.created_at AS createdAt
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        ORDER BY o.id DESC
      `)
    : []
  const result: Record<string, unknown> = {}
  if (canOrders) {
    result.orders = {
      openCount: orderRows.filter((row) => row.status === 'confirmed').length,
      dayCount: orderRows.filter((row) => row.createdAt.slice(0, 10) === input.date).length,
      recent: orderRows.slice(0, 10).map((row) => ({
        id: row.id, documentNumber: row.documentNumber, customerName: row.customerName,
        paymentStatus: row.paymentStatus, status: row.status, createdAt: row.createdAt,
        ...(canSales ? { totalMinor: row.totalMinor, paidMinor: row.paidMinor, remainingMinor: row.remainingMinor } : {})
      }))
    }
  }
  if (canSales) {
    result.sales = {
      customerReceivablesMinor: orderRows.reduce((sum, row) =>
        sum + (row.status === 'confirmed' || row.status === 'completed' ? row.remainingMinor : 0), 0)
    }
  }
  if (canFinancialAlerts) {
    result.financialAlerts = {
      cashBalanceMinor: legacyListAccounts({ asOf: input.currentDay ? undefined : input.date })
        .reduce((sum, account) => sum + account.balanceMinor, 0)
    }
  }
  if (canCosts) {
    result.costs = {
      dayExpensesMinor: legacyListExpenses({ from: input.date, to: input.date }).reduce((sum, expense) => sum + expense.amountMinor, 0)
        + scheduledRecurringOccurrences(input.date, input.date)
          .filter((occurrence) => occurrence.periodStart === input.date)
          .reduce((sum, occurrence) => sum + occurrence.amountMinor, 0)
    }
  }
  if (canProfits) {
    const summary = legacyMonthlyProfitSummary(input.year, input.month)
    result.profits = {
      netProfitMinor: summary.netProfitMinor,
      completedOrderCount: summary.completedOrderCount,
      ...(hasPermission(session, P.profit.view) ? { remainingProfitMinor: summary.remainingProfitMinor } : {})
    }
    if (hasPermission(session, P.savings.view)) {
      // Former savingsOverview recomputed the whole month and the fund balance.
      const savings = legacyMonthlyProfitSummary(input.year, input.month)
      getDatabase().get(sql`SELECT COALESCE(SUM(CASE WHEN kind = 'allocation' THEN amount_minor ELSE 0 END), 0) AS allocated,
        COALESCE(SUM(CASE WHEN kind = 'usage' THEN amount_minor ELSE 0 END), 0) AS used FROM savings_transactions`)
      result.savings = { allocatedMinor: savings.savingsProposedMinor, savingsRateBp: savings.savingsRateBp }
    }
  }
  return result
}

/** Incomplete-order alert keys as produced by the former offset walk. */
export function legacyIncompleteOrderKeys(): string[] {
  const activeOrders: ReturnType<typeof legacyListOrders> = []
  for (let offset = 0; ; offset += 100) {
    const page = legacyListOrders({ status: 'confirmed', limit: 100, offset })
    activeOrders.push(...page)
    if (page.length < 100) break
  }
  return activeOrders.map((order) => `incomplete_order:${order.id}`)
}

export function legacyCustomerStatement(customerId: number) {
  const customer = getDatabase().select().from(customers).where(eq(customers.id, customerId)).get()
  if (!customer) throw notFound('العميل غير موجود')
  const customerOrders = getDatabase().select().from(orders).where(eq(orders.customerId, customerId)).orderBy(desc(orders.id)).all()
  const payments = getDatabase().all(sql`
    SELECT 'payment-' || id AS rowKey, id, 'payment' AS entryType, order_id AS orderId,
           customer_id AS customerId, approved_invoice_id AS approvedInvoiceId,
           amount_minor AS amountMinor, cash_account_id AS cashAccountId, paid_at AS paidAt,
           notes, created_by AS createdBy, created_at AS createdAt
    FROM customer_payments WHERE customer_id = ${customerId}
    UNION ALL
    SELECT 'refund-' || id AS rowKey, id, 'refund' AS entryType, order_id AS orderId,
           customer_id AS customerId, NULL AS approvedInvoiceId,
           -amount_minor AS amountMinor, cash_account_id AS cashAccountId, refunded_at AS paidAt,
           reason AS notes, created_by AS createdBy, created_at AS createdAt
    FROM customer_payment_refunds WHERE customer_id = ${customerId}
    ORDER BY paidAt DESC, id DESC
  `)
  const preliminaryInvoices = getRawConnection().prepare('SELECT id, document_number AS documentNumber, status, total_minor AS totalMinor FROM quotations WHERE customer_id = ? ORDER BY id DESC').all(customerId)
  const approvedInvoices = getRawConnection().prepare('SELECT id, document_number AS documentNumber, status, total_minor AS totalMinor FROM final_invoices WHERE customer_id = ? ORDER BY id DESC').all(customerId)
  return { customer, orders: customerOrders, payments, preliminaryInvoices, approvedInvoices }
}

export function legacySupplierStatement(supplierId: number) {
  const supplier = getDatabase().select().from(suppliers).where(eq(suppliers.id, supplierId)).get()
  if (!supplier) throw notFound('المورد غير موجود')
  return {
    supplier,
    purchases: getDatabase().select().from(purchases).where(eq(purchases.supplierId, supplierId)).orderBy(desc(purchases.id)).all(),
    payments: getDatabase().select().from(supplierPayments).where(eq(supplierPayments.supplierId, supplierId)).orderBy(desc(supplierPayments.id)).all()
  }
}

export function legacyWorkerStatement(workerId: number) {
  const worker = getDatabase().select().from(workers).where(eq(workers.id, workerId)).get()
  if (!worker) throw notFound('العامل غير موجود')
  return {
    worker,
    ...workerBalances(workerId),
    transactions: getDatabase().select().from(workerTransactions).where(eq(workerTransactions.workerId, workerId)).orderBy(desc(workerTransactions.id)).all()
  }
}

export function legacyEmployeeStatement(employeeId: number) {
  const employee = getDatabase().select().from(employees).where(eq(employees.id, employeeId)).get()
  if (!employee) throw notFound('الموظف غير موجود')
  return {
    employee,
    balanceMinor: employeeBalance(employeeId),
    salaryHistory: salaryHistory(employeeId),
    transactions: getDatabase().select().from(employeeTransactions).where(eq(employeeTransactions.employeeId, employeeId)).orderBy(desc(employeeTransactions.id)).all()
  }
}

export function legacyListQuotations() {
  return getDatabase()
    .select({ ...getTableColumns(quotations), customerName: customers.name })
    .from(quotations)
    .innerJoin(customers, eq(quotations.customerId, customers.id))
    .orderBy(desc(quotations.id))
    .all()
}

export function legacyListWithdrawalRows() {
  return getDatabase().select().from(profitWithdrawals).orderBy(desc(profitWithdrawals.id)).all()
}

export function legacySavingsTransactions() {
  return getDatabase().select().from(savingsTransactions).orderBy(desc(savingsTransactions.id)).all()
}

export function legacyWorkSheetsForOrder(orderId: number) {
  return getDatabase().select().from(workSheets).where(eq(workSheets.orderId, orderId)).orderBy(desc(workSheets.id)).all()
}

export function legacyListExpensesFull(filter: {
  search?: string; categoryId?: number; kind?: 'fixed' | 'variable'; orderId?: number; linkedOnly?: boolean; from?: string; to?: string
} = {}) {
  const clauses = []
  if (filter.categoryId) clauses.push(eq(expenses.categoryId, filter.categoryId))
  if (filter.kind) clauses.push(eq(expenses.kind, filter.kind))
  if (filter.orderId) clauses.push(eq(expenses.orderId, filter.orderId))
  if (filter.linkedOnly) clauses.push(sql`${expenses.orderId} IS NOT NULL`)
  if (filter.from) clauses.push(sql`${expenses.spentAt} >= ${filter.from}`)
  if (filter.to) clauses.push(sql`${expenses.spentAt} <= ${filter.to}`)
  if (filter.search?.trim()) clauses.push(like(expenses.description, `%${filter.search.trim()}%`))
  return getDatabase()
    .select({
      id: expenses.id,
      categoryId: expenses.categoryId,
      categoryName: expenseCategories.name,
      kind: expenses.kind,
      amountMinor: expenses.amountMinor,
      orderId: expenses.orderId,
      description: expenses.description,
      spentAt: expenses.spentAt,
      source: expenses.source,
      cashAccountId: expenses.cashAccountId,
      reversedAt: expenses.reversedAt
    })
    .from(expenses)
    .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(expenses.id))
    .all()
}
