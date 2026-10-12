import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { setupTestDatabase } from '../helpers/test-db'
import { seedDb10Fixture } from '../helpers/db10-fixtures'
import { payloadBytes, traceQueries } from '../helpers/query-counter'
import { queryPlan, tableCount } from '../helpers/db10-measure'
import {
  availableProfitMinor,
  cumulativeNetProfitMinor,
  listWithdrawals,
  monthlyProfitSummary
} from '@main/services/finance/profit.service'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { listAccounts } from '@main/services/finance/cash.service'
import { listFinalInvoices } from '@main/services/sales/final-invoices.service'
import { listReleases } from '@main/services/production/production.service'
import {
  customerBalances,
  customerBalancesPage,
  supplierBalances
} from '@main/services/parties/parties.service'
import { orderProfitabilityReport } from '@main/services/costing/costing.service'
import { buildReport, type ReportKey } from '@main/services/reports/reports.service'

const scales = process.env.DB16_SCALES
  ? process.env.DB16_SCALES.split(',').map(Number)
  : [2_000]

const COMPLETE_REPORTS: ReportKey[] = [
  'sales',
  'orders',
  'customer_balances',
  'supplier_balances',
  'purchases',
  'inventory',
  'inventory_valuation',
  'material_consumption',
  'waste',
  'expenses',
  'order_costs',
  'order_profitability',
  'monthly_profit',
  'cancelled_orders',
  'worker_balances',
  'payroll'
]

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
}

function measureDb16<T>(
  scenario: string,
  fn: () => T,
  rowsOf: (value: T) => number,
  options: { runs: number; sourceRows?: number }
): T {
  fn()
  const heapBefore = process.memoryUsage().heapUsed
  const rssBefore = process.memoryUsage().rss
  const traceStart = performance.now()
  const traced = traceQueries(fn)
  const tracedMs = performance.now() - traceStart
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore
  const rssDeltaBytes = process.memoryUsage().rss - rssBefore

  const serializationStart = performance.now()
  JSON.stringify(traced.result)
  const serializationMs = performance.now() - serializationStart

  const durations: number[] = []
  for (let run = 0; run < options.runs; run += 1) {
    const start = performance.now()
    fn()
    durations.push(performance.now() - start)
  }
  durations.sort((a, b) => a - b)

  const rankedStatements = traced.statements
    .map((statement, index) => ({
      ms: Number((traced.statementDurationsMs[index] ?? 0).toFixed(3)),
      sql: statement.slice(0, 300)
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3)

  console.log(`DB16_MEASURE ${JSON.stringify({
    scenario,
    sourceRows: options.sourceRows,
    rowsReturned: rowsOf(traced.result),
    statements: traced.count,
    medianMs: Number(percentile(durations, 0.5).toFixed(2)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
    runs: options.runs,
    payloadBytes: payloadBytes(traced.result),
    heapDeltaBytes,
    rssDeltaBytes,
    tracedMs: Number(tracedMs.toFixed(3)),
    sqlMs: Number(traced.sqlDurationMs.toFixed(3)),
    jsMs: Number(Math.max(0, tracedMs - traced.sqlDurationMs).toFixed(3)),
    serializationMs: Number(serializationMs.toFixed(3))
  })}`)
  console.log(`DB16_BREAKDOWN ${JSON.stringify({ scenario, dominantStatements: rankedStatements })}`)
  return traced.result
}

function ledgerCounts(): Record<string, number> {
  return Object.fromEntries([
    'expenses',
    'cash_transactions',
    'recurring_expense_amounts',
    'audit_log'
  ].map((table) => [table, tableCount(table)]))
}

function reportRequest(key: ReportKey) {
  return key === 'monthly_profit'
    ? { key, year: 2026, month: 7 }
    : { key, from: '1900-01-01', to: '2999-12-31' }
}

describe('DB-16 heavy Main-process read qualification', () => {
  for (const scale of scales) it(`${scale} orders`, () => {
    const env = setupTestDatabase()
    try {
      seedDb10Fixture(scale)
      const runs = scale >= 100_000 ? 3 : 5
      const reportRuns = scale >= 100_000 ? 3 : 3
      const orders = tableCount('orders')
      const cashRows = tableCount('cash_transactions')
      const invoices = tableCount('final_invoices')
      const releases = tableCount('releases')
      const beforeReads = ledgerCounts()

      const month = measureDb16(
        `monthly profit @${scale}`,
        () => monthlyProfitSummary(2026, 7),
        () => 1,
        { runs, sourceRows: orders }
      )
      const cumulative = measureDb16(
        `cumulative profit @${scale}`,
        () => cumulativeNetProfitMinor(new Date('2026-09-16T00:00:00.000Z')),
        () => 1,
        { runs, sourceRows: orders }
      )
      const available = measureDb16(
        `available profit @${scale}`,
        () => availableProfitMinor(),
        () => 1,
        { runs, sourceRows: orders }
      )
      const withdrawals = measureDb16(
        `withdrawals page with company summary @${scale}`,
        () => listWithdrawals({}, { limit: 50 }),
        (value) => value.items.length,
        { runs, sourceRows: tableCount('profit_withdrawals') }
      )
      measureDb16(
        `dashboard owner @${scale}`,
        () => dashboardSummary(
          { date: '2026-08-10', year: 2026, month: 8, currentDay: false },
          env.ctx.session
        ),
        (value) => Object.keys(value).length,
        { runs, sourceRows: orders }
      )
      measureDb16(
        `cash accounts @${scale}`,
        () => listAccounts({}),
        (value) => value.length,
        { runs, sourceRows: cashRows }
      )
      measureDb16(
        `approved invoices first page and summary @${scale}`,
        () => listFinalInvoices({}, env.ctx.session, { limit: 25 }),
        (value) => value.items.length,
        { runs, sourceRows: invoices }
      )
      measureDb16(
        `awaiting-completion permits @${scale}`,
        () => listReleases({ awaitingCompletion: true }, { limit: 100 }),
        (value) => value.items.length,
        { runs, sourceRows: releases }
      )
      measureDb16(
        `customer balances page @${scale}`,
        () => customerBalancesPage({}, { limit: 50 }),
        (value) => value.items.length,
        { runs, sourceRows: orders }
      )
      measureDb16(
        `customer balances complete report source @${scale}`,
        () => customerBalances(),
        (value) => value.length,
        { runs: reportRuns, sourceRows: orders }
      )
      measureDb16(
        `supplier balances complete report source @${scale}`,
        () => supplierBalances(),
        (value) => value.length,
        { runs: reportRuns, sourceRows: tableCount('purchases') }
      )
      measureDb16(
        `order profitability complete service @${scale}`,
        () => orderProfitabilityReport({ completedOnly: true }),
        (value) => value.length,
        { runs: reportRuns, sourceRows: orders }
      )
      measureDb16(
        `order profitability one month @${scale}`,
        () => orderProfitabilityReport({
          completedOnly: true,
          from: '2026-07-01',
          to: '2026-07-31'
        }),
        (value) => value.length,
        { runs, sourceRows: orders }
      )

      for (const key of COMPLETE_REPORTS) {
        measureDb16(
          `complete report ${key} @${scale}`,
          () => buildReport(reportRequest(key)),
          (value) => value.rows.length,
          { runs: reportRuns, sourceRows: orders }
        )
      }

      expect(month.netProfitMinor).toBe(month.grossOrderProfitMinor - month.generalExpensesMinor - month.payrollExpenseMinor - month.wasteLossMinor)
      expect(cumulative).toBe(cumulativeNetProfitMinor(new Date('2026-09-16T00:00:00.000Z')))
      expect(available).toBe(availableProfitMinor())
      expect(withdrawals.summary.availableMinor).toBe(available)
      expect(ledgerCounts()).toEqual(beforeReads)

      console.log(`DB16_PLAN ${JSON.stringify({
        completedOrders: queryPlan("SELECT id FROM orders WHERE +status = 'completed' AND completed_at >= ? AND completed_at <= ?", '2026-07-01', '2026-07-31'),
        cashBalances: queryPlan('SELECT account_id, SUM(amount_minor) FROM cash_transactions GROUP BY account_id'),
        invoiceSummary: queryPlan(`SELECT COUNT(*), SUM(CASE WHEN f.status != 'cancelled' THEN f.total_minor ELSE 0 END)
          FROM final_invoices f LEFT JOIN orders o ON o.id = f.order_id JOIN customers c ON c.id = f.customer_id
          WHERE f.order_id IS NULL OR o.archived_at IS NULL`),
        awaitingCompletion: queryPlan(`SELECT r.id FROM releases r JOIN orders o ON o.id = r.order_id
          WHERE r.status = 'active' AND o.archived_at IS NULL AND o.status NOT IN ('cancelled', 'awaiting_approval')
          AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.status = 'recorded' AND
            (d.release_id = r.id OR (d.release_id IS NULL AND d.order_id = r.order_id)))
          ORDER BY r.id DESC LIMIT 101`),
        customerBalances: queryPlan(`SELECT c.id, SUM(o.remaining_minor) FROM customers c
          LEFT JOIN orders o ON o.customer_id = c.id AND o.status != 'cancelled' GROUP BY c.id`)
      })}`)
    } finally {
      env.cleanup()
    }
  }, 1_800_000)
})
