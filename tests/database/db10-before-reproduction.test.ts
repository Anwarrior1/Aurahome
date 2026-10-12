import { describe, it, expect } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import { setupTestDatabase } from '../helpers/test-db'
import { seedDb10Fixture } from '../helpers/db10-fixtures'
import { measure, queryPlan, tableCount } from '../helpers/db10-measure'
import {
  legacyAvailableProfitMinor,
  legacyCustomerStatement,
  legacyDashboardSummary,
  legacyIncompleteOrderKeys,
  legacyListAccounts,
  legacyListDeliveries,
  legacyListExpensesFull,
  legacyListFinishedGoods,
  legacyListOrders,
  legacyListReleases,
  legacyMonthlyProfitSummary,
  legacySupplierStatement,
  legacyWorkerStatement
} from '../helpers/db10-legacy-oracles'

/**
 * DB-10 BEFORE evidence. Every scenario calls the preserved pre-remediation
 * implementation, so this remains a faithful reproduction after the
 * production read paths are replaced.
 */
const scales = process.env.DB10_BENCH === '1' ? [10_000, 100_000] : [2_000]

describe('DB-10 before-remediation reproduction', () => {
  for (const scale of scales) it(`${scale} orders`, () => {
    const env = setupTestDatabase()
    try {
      const seedStart = Date.now()
      const fixture = seedDb10Fixture(scale)
      console.log(`DB10_FIXTURE ${JSON.stringify({ scale, seedMs: Date.now() - seedStart, orders: tableCount('orders'),
        payments: tableCount('customer_payments'), releases: tableCount('releases'), deliveries: tableCount('deliveries'),
        expenses: tableCount('expenses'), cash: tableCount('cash_transactions'), audit: tableCount('audit_log'),
        finishedGoods: tableCount('finished_goods_movements'), workerTx: tableCount('worker_transactions') })}`)
      const heavyRuns = scale >= 100_000 ? 1 : 3

      const statement = measure(`customerStatement big customer @${scale}`, () => legacyCustomerStatement(fixture.bigCustomerId),
        (value) => value.orders.length + value.payments.length + value.preliminaryInvoices.length + value.approvedInvoices.length,
        { dbRows: tableCount('orders') })
      expect(statement.rowsReturned).toBeGreaterThan(0)
      measure(`supplierStatement big supplier @${scale}`, () => legacySupplierStatement(fixture.bigSupplierId),
        (value) => value.purchases.length + value.payments.length, { dbRows: tableCount('purchases') })
      measure(`workerStatement big worker @${scale}`, () => legacyWorkerStatement(fixture.bigWorkerId),
        (value) => value.transactions.length, { dbRows: tableCount('worker_transactions') })
      measure(`expenses unfiltered history @${scale}`, () => legacyListExpensesFull({}), (value) => value.length,
        { dbRows: tableCount('expenses') })
      measure(`listReleases active @${scale}`, () => legacyListReleases({}), (value) => value.length,
        { dbRows: tableCount('releases'), runs: heavyRuns })
      measure(`listDeliveries recorded @${scale}`, () => legacyListDeliveries({}), (value) => value.length,
        { dbRows: tableCount('deliveries'), runs: heavyRuns })
      measure(`listFinishedGoods @${scale}`, () => legacyListFinishedGoods({}), (value) => value.length,
        { dbRows: tableCount('finished_goods_movements') })
      measure(`listAccounts @${scale}`, () => legacyListAccounts({}), (value) => value.length,
        { dbRows: tableCount('cash_transactions') })
      measure(`listOrders first page @${scale}`, () => legacyListOrders({ limit: 50 }), (value) => value.length,
        { dbRows: tableCount('orders') })
      const activeOrders = (Object.values(queryCount('SELECT COUNT(*) AS c FROM orders WHERE archived_at IS NULL'))[0]) as number
      measure(`listOrders deepest page offset=${activeOrders - 100} @${scale}`,
        () => legacyListOrders({ limit: 100, offset: activeOrders - 100 }), (value) => value.length, { dbRows: activeOrders })
      measure(`monthlyProfitSummary last full month @${scale}`,
        () => legacyMonthlyProfitSummary(2026, 7), (value) => value.completedOrderCount, { dbRows: tableCount('orders'), runs: heavyRuns })
      measure(`availableProfitMinor (cumulative) @${scale}`,
        () => legacyAvailableProfitMinor(new Date('2026-09-15T00:00:00.000Z')), () => 1, { dbRows: tableCount('orders'), runs: 1 })
      measure(`dashboardSummary owner @${scale}`,
        () => legacyDashboardSummary({ date: '2026-08-10', year: 2026, month: 8, currentDay: false }, env.ctx.session),
        () => 10, { dbRows: tableCount('orders'), runs: heavyRuns })
      if (scale <= 10_000) measure(`incomplete-order notifications walk @${scale}`, () => legacyIncompleteOrderKeys(),
        (value) => value.length, { dbRows: tableCount('orders'), runs: 1 })

      console.log(`DB10_PLAN deepOrders ${JSON.stringify(queryPlan(
        'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.archived_at IS NULL ORDER BY o.id DESC LIMIT 100 OFFSET ?', activeOrders - 100))}`)
      console.log(`DB10_PLAN customerPayments ${JSON.stringify(queryPlan(
        "SELECT id, paid_at FROM customer_payments WHERE customer_id = ? UNION ALL SELECT id, refunded_at FROM customer_payment_refunds WHERE customer_id = ? ORDER BY 2 DESC, 1 DESC", 1, 1))}`)
      console.log(`DB10_PLAN expensesHistory ${JSON.stringify(queryPlan(
        'SELECT e.id FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id ORDER BY e.id DESC'))}`)
    } finally {
      env.cleanup()
    }
  }, 1_800_000)
})

function queryCount(sqlText: string): Record<string, unknown> {
  return getRawConnection().prepare(sqlText).get() as Record<string, unknown>
}
