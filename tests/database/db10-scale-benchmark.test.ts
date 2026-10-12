import { describe, expect, it } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import { PAGE_SIZE } from '@shared/pagination/cursor-page'
import { setupTestDatabase } from '../helpers/test-db'
import { seedDb10Fixture } from '../helpers/db10-fixtures'
import { measure, queryPlan, tableCount } from '../helpers/db10-measure'
import { customerStatement, supplierStatement, listCustomers } from '@main/services/parties/parties.service'
import { workerStatement } from '@main/services/production/workers.service'
import { listExpenses } from '@main/services/finance/expenses.service'
import { listReleases, listDeliveries } from '@main/services/production/production.service'
import { listFinishedGoods } from '@main/services/production/finished-goods.service'
import { listAccounts, listTransactions } from '@main/services/finance/cash.service'
import { listOrders } from '@main/services/sales/orders.service'
import { listFinalInvoices } from '@main/services/sales/final-invoices.service'
import { availableProfitMinor, monthlyProfitSummary } from '@main/services/finance/profit.service'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { notificationFeed } from '@main/services/notifications/notifications.service'
import { listMovements } from '@main/services/inventory/inventory.service'
import { listAuditLog } from '@main/services/admin/users.service'

/**
 * DB-10 AFTER evidence on the same deterministic fixtures as the BEFORE
 * reproduction. The normal suite runs a small fixture as a smoke/budget
 * check; DB10_BENCH=1 runs the 10k and 100k qualification.
 */
const scales = process.env.DB10_SCALES ? process.env.DB10_SCALES.split(',').map(Number) : process.env.DB10_BENCH === '1' ? [10_000, 100_000] : [2_000]

function traverse<T>(fetch: (cursor?: string) => { items: T[]; nextCursor: string | null }): { pages: number; rows: number } {
  let cursor: string | undefined
  let pages = 0
  let rows = 0
  do {
    const page = fetch(cursor)
    pages += 1
    rows += page.items.length
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return { pages, rows }
}

describe('DB-10 after-remediation scale qualification', () => {
  for (const scale of scales) it(`${scale} orders`, () => {
    const env = setupTestDatabase()
    try {
      seedDb10Fixture(scale)
      const orders = tableCount('orders')
      const heavyRuns = scale >= 100_000 ? 3 : 5

      const statement = measure(`customerStatement first sections @${scale}`, () => customerStatement(1, env.ctx),
        (value) => value.orders.items.length + value.payments.items.length + value.preliminaryInvoices.items.length + value.approvedInvoices.items.length,
        { dbRows: orders })
      expect(statement.rowsReturned).toBeLessThanOrEqual(4 * PAGE_SIZE.statement)
      const deep = measure(`customerStatement payments deep traversal @${scale}`, () => traverse((cursor) =>
        customerStatement(1, env.ctx, { sections: ['payments'], payments: { limit: 25, cursor } }).payments), (value) => value.rows,
      { dbRows: tableCount('customer_payments'), runs: 1 })
      expect(deep.result.pages).toBeGreaterThan(1)
      measure(`supplierStatement first sections @${scale}`, () => supplierStatement(1), (value) => value.purchases.items.length + value.payments.items.length, { dbRows: tableCount('purchases') })
      measure(`workerStatement first page @${scale}`, () => workerStatement(1), (value) => value.transactions.items.length, { dbRows: tableCount('worker_transactions') })
      measure(`expenses unfiltered first page @${scale}`, () => listExpenses({}), (value) => value.items.length, { dbRows: tableCount('expenses') })
      measure(`listReleases active first page @${scale}`, () => listReleases({}, { limit: PAGE_SIZE.max }), (value) => value.items.length, { dbRows: tableCount('releases'), runs: heavyRuns })
      measure(`listReleases awaitingCompletion @${scale}`, () => listReleases({ awaitingCompletion: true }, { limit: PAGE_SIZE.max }), (value) => value.items.length, { dbRows: tableCount('releases'), runs: heavyRuns })
      measure(`listDeliveries first page @${scale}`, () => listDeliveries({}, { limit: PAGE_SIZE.max }), (value) => value.items.length, { dbRows: tableCount('deliveries') })
      measure(`listFinishedGoods @${scale}`, () => listFinishedGoods({}), (value) => value.length, { dbRows: tableCount('finished_goods_movements') })
      measure(`listAccounts @${scale}`, () => listAccounts({}), (value) => value.length, { dbRows: tableCount('cash_transactions') })
      measure(`listOrders first page @${scale}`, () => listOrders({}, { limit: 50 }), (value) => value.items.length, { dbRows: orders })
      // Walk to the deepest page with cursors, then time only the deepest request.
      let deepest: string | undefined
      let cursor: string | undefined
      do {
        const page = listOrders({}, { limit: 100, cursor })
        deepest = cursor
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      measure(`listOrders deepest page (keyset) @${scale}`, () => listOrders({}, { limit: 100, cursor: deepest }), (value) => value.items.length, { dbRows: orders })
      measure(`listOrders confirmed candidates page @${scale}`, () => listOrders({ status: 'confirmed' }, { limit: 100 }), (value) => value.items.length, { dbRows: orders })
      measure(`listFinalInvoices first page @${scale}`, () => listFinalInvoices({}, env.ctx.session), (value) => value.items.length, { dbRows: tableCount('final_invoices') })
      measure(`listCustomers first page @${scale}`, () => listCustomers({}), (value) => value.items.length, { dbRows: tableCount('customers') })
      measure(`cash transactions first page @${scale}`, () => listTransactions({}), (value) => value.items.length, { dbRows: tableCount('cash_transactions') })
      measure(`inventory movements first page @${scale}`, () => listMovements({}), (value) => value.items.length, { dbRows: tableCount('inventory_movements') })
      measure(`audit log first page @${scale}`, () => listAuditLog({}), (value) => value.items.length, { dbRows: tableCount('audit_log') })
      measure(`monthlyProfitSummary last full month @${scale}`, () => monthlyProfitSummary(2026, 7), (value) => value.completedOrderCount, { dbRows: orders, runs: heavyRuns })
      measure(`availableProfitMinor (cumulative) @${scale}`, () => availableProfitMinor(), () => 1, { dbRows: orders, runs: heavyRuns })
      measure(`dashboardSummary owner @${scale}`, () => dashboardSummary({ date: '2026-08-10', year: 2026, month: 8, currentDay: false }, env.ctx.session), () => 10, { dbRows: orders, runs: heavyRuns })
      measure(`notification feed (IPC) @${scale}`, () => notificationFeed(env.ctx.session), (value) => value.items.length, { dbRows: orders, runs: heavyRuns })

      const raw = getRawConnection()
      const releaseIds = (raw.prepare('SELECT id FROM releases ORDER BY id DESC LIMIT 100').all() as Array<{ id: number }>).map((row) => row.id)
      const inList = releaseIds.join(',')
      console.log(`DB10_PLAN releaseCompletion ${JSON.stringify(queryPlan(`SELECT r.id FROM releases r WHERE r.id IN (${inList}) AND EXISTS (SELECT 1 FROM deliveries d WHERE d.status = 'recorded' AND (d.release_id = r.id OR (d.release_id IS NULL AND d.order_id = r.order_id AND (d.kind = 'handover' OR d.kind = 'delivery'))))`))}`)
      console.log(`DB10_PLAN releaseDeliveries ${JSON.stringify(queryPlan(`SELECT release_id, id, status FROM deliveries WHERE release_id IN (${inList}) ORDER BY release_id, id`))}`)
      console.log(`DB10_PLAN ordersKeyset ${JSON.stringify(queryPlan('SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.archived_at IS NULL AND o.id < ? ORDER BY o.id DESC LIMIT 101', 500))}`)
      console.log(`DB10_PLAN expensesDayKeyset ${JSON.stringify(queryPlan("SELECT e.id FROM expenses e WHERE e.spent_at >= '2026-08-10' AND e.spent_at <= '2026-08-10' AND e.id < ? ORDER BY e.id DESC LIMIT 51", 1e9))}`)
      console.log(`DB10_PLAN customersKeyset ${JSON.stringify(queryPlan("SELECT id FROM customers WHERE active = 1 AND (name, id) > (?, ?) ORDER BY name ASC, id ASC LIMIT 51", 'عميل 000100', 100))}`)
      console.log(`DB10_PLAN movementsNewer ${JSON.stringify(queryPlan('SELECT SUM(qty_micro) FROM inventory_movements mv WHERE mv.material_id = ? AND mv.id > ?', 1, 10))}`)
      console.log(`DB10_PLAN accountsGrouped ${JSON.stringify(queryPlan("SELECT account_id, COUNT(*) FROM cash_transactions GROUP BY account_id"))}`)
    } finally {
      env.cleanup()
    }
  }, 1_800_000)
})
