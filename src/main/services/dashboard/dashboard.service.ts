import { sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import type { AuthSession } from '@shared/types/user.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { hasPermission } from '../../permissions/permission-guard'
import { listAccounts } from '../finance/cash.service'
import { scheduledRecurringOccurrences } from '../finance/expenses.service'
import { monthlyProfitSummary } from '../finance/profit.service'
import { dayStart, dayEnd } from '../base/service.types'

/**
 * The dashboard has one purpose-built response so widget permissions
 * are enforced before serialization. Missing permissions mean missing
 * properties — the renderer never downloads a hidden financial KPI.
 *
 * Every card is an authoritative aggregate over the complete history; only
 * the recent-orders widget is a bounded row read.
 */
export function dashboardSummary(
  input: { date: string; year: number; month: number; currentDay: boolean },
  session: AuthSession
) {
  const db = getDatabase()
  const canOrders = hasPermission(session, P.dashboard.viewOrders)
  const canSales = hasPermission(session, P.dashboard.viewSales)
  const canCosts = hasPermission(session, P.dashboard.viewCosts)
  const canProfits = hasPermission(session, P.dashboard.viewProfits)
  const canFinancialAlerts = hasPermission(session, P.dashboard.viewFinancialAlerts)

  const result: Record<string, unknown> = {}
  // One aggregate pass over the order history serves every order/sales card.
  const counts = canOrders || canSales
    ? db.get<{ openCount: number; dayCount: number; receivablesMinor: number }>(sql`
        SELECT
          COALESCE(SUM(CASE WHEN o.status = 'confirmed' THEN 1 ELSE 0 END), 0) AS openCount,
          COALESCE(SUM(CASE WHEN o.created_at >= ${dayStart(input.date)} AND o.created_at <= ${dayEnd(input.date)} THEN 1 ELSE 0 END), 0) AS dayCount,
          COALESCE(SUM(CASE WHEN o.status IN ('confirmed', 'completed') THEN o.remaining_minor ELSE 0 END), 0) AS receivablesMinor
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
      `)
    : undefined
  if (canOrders) {
    const recent = db.all<{
      id: number
      documentNumber: string
      customerName: string
      totalMinor: number
      paidMinor: number
      remainingMinor: number
      paymentStatus: string
      status: string
      createdAt: string
    }>(sql`
      SELECT o.id, o.document_number AS documentNumber, c.name AS customerName,
             o.total_minor AS totalMinor, o.paid_minor AS paidMinor,
             o.remaining_minor AS remainingMinor, o.payment_status AS paymentStatus,
             o.status, o.created_at AS createdAt
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      ORDER BY o.id DESC
      LIMIT 10
    `)
    result.orders = {
      openCount: counts?.openCount ?? 0,
      dayCount: counts?.dayCount ?? 0,
      recent: recent.map((row) => ({
        id: row.id,
        documentNumber: row.documentNumber,
        customerName: row.customerName,
        paymentStatus: row.paymentStatus,
        status: row.status,
        createdAt: row.createdAt,
        ...(canSales ? {
          totalMinor: row.totalMinor,
          paidMinor: row.paidMinor,
          remainingMinor: row.remainingMinor
        } : {})
      }))
    }
  }
  if (canSales) {
    result.sales = {
      customerReceivablesMinor: counts?.receivablesMinor ?? 0
    }
  }
  if (canFinancialAlerts) {
    result.financialAlerts = {
      cashBalanceMinor: listAccounts({ asOf: input.currentDay ? undefined : input.date })
        .reduce((sum, account) => sum + account.balanceMinor, 0)
    }
  }
  if (canCosts) {
    // DB-15: a scheduled fixed expense falling on this day counts even when
    // it has not been posted yet — derived, never written by opening the
    // dashboard.
    const scheduledToday = scheduledRecurringOccurrences(input.date, input.date)
      .filter((occurrence) => occurrence.periodStart === input.date)
      .reduce((sum, occurrence) => sum + occurrence.amountMinor, 0)
    result.costs = {
      dayExpensesMinor: (db.get<{ total: number }>(sql`
        SELECT COALESCE(SUM(amount_minor), 0) AS total FROM expenses
        WHERE spent_at >= ${input.date} AND spent_at <= ${input.date}
          AND reversed_at IS NULL
      `)?.total ?? 0) + scheduledToday
    }
  }
  if (canProfits) {
    const summary = monthlyProfitSummary(input.year, input.month)
    result.profits = {
      netProfitMinor: summary.netProfitMinor,
      completedOrderCount: summary.completedOrderCount,
      // Same field exposed by profit.monthly; require source-screen access too.
      ...(hasPermission(session, P.profit.view)
        ? { remainingProfitMinor: summary.remainingProfitMinor }
        : {})
    }
    if (hasPermission(session, P.savings.view)) {
      // savingsOverview's allocated figure is this same month's proposal.
      result.savings = {
        allocatedMinor: summary.savingsProposedMinor,
        savingsRateBp: summary.savingsRateBp
      }
    }
  }
  return result
}
