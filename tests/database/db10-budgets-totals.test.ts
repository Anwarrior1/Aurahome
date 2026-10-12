import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { seedDb10Fixture, type Db10Fixture } from '../helpers/db10-fixtures'
import { traceQueries } from '../helpers/query-counter'
import { legacyAvailableProfitMinor } from '../helpers/db10-legacy-oracles'
import { listDeliveries, listOperationalWorkSheets, listReleases } from '@main/services/production/production.service'
import { listFinishedGoods } from '@main/services/production/finished-goods.service'
import { createAccount, listAccounts } from '@main/services/finance/cash.service'
import { listOrders } from '@main/services/sales/orders.service'
import { listFinalInvoices, orderPaymentPosition } from '@main/services/sales/final-invoices.service'
import { listUncollectedProducts } from '@main/services/sales/uncollected-products.service'
import { customerBalances, customerStatement, listCustomers, supplierBalances, supplierStatement } from '@main/services/parties/parties.service'
import { listMovements } from '@main/services/inventory/inventory.service'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { cumulativeNetProfitMinor, listWithdrawals, monthlyProfitSummary } from '@main/services/finance/profit.service'
import { expenseSummary, listExpenses } from '@main/services/finance/expenses.service'
import { notificationFeed, NOTIFICATION_FEED_LIMIT } from '@main/services/notifications/notifications.service'
import { workerStatement, workerBalances } from '@main/services/production/workers.service'
import { employeeBalance, employeeStatement } from '@main/services/hr/employees.service'

let env: TestEnv
let fixture: Db10Fixture

beforeAll(() => {
  env = setupTestDatabase()
  fixture = seedDb10Fixture(1_500)
  // Uncollected products for cancelled orders, so capabilities have real source orders.
  const raw = getRawConnection()
  const cancelled = raw.prepare("SELECT id, document_number AS number FROM orders WHERE status = 'cancelled' ORDER BY id LIMIT 120").all() as Array<{ id: number; number: string }>
  const line = raw.prepare("INSERT INTO order_lines (order_id, line_kind, description, quantity_micro, unit_price_minor, line_total_minor) VALUES (?, 'custom', 'قطعة', 1000000, 1000, 1000)")
  const product = raw.prepare("INSERT INTO uncollected_products (source_order_id, source_order_number, source_order_line_id, name, quantity_micro, cost_basis_method, transferred_at) VALUES (?, ?, ?, 'منتج', 1000000, 'order_total', '2026-01-01T00:00:00.000Z')")
  for (const order of cancelled) product.run(order.id, order.number, Number(line.run(order.id).lastInsertRowid))
}, 120_000)
afterAll(() => env.cleanup())

function count<T>(fn: () => T): number {
  return traceQueries(fn).count
}

describe('DB-10 query-count budgets: statements do not grow with returned rows', () => {
  const budgets: Array<{ name: string; small: () => unknown; large: () => unknown; budget: number; exact?: false }> = [
    { name: 'exit permits page', small: () => listReleases({ includeReversed: true }, { limit: 2 }), large: () => listReleases({ includeReversed: true }, { limit: 100 }), budget: 5 },
    { name: 'deliveries page', small: () => listDeliveries({}, { limit: 2 }), large: () => listDeliveries({}, { limit: 100 }), budget: 2 },
    { name: 'orders page with eligibility', small: () => listOrders({}, { limit: 2 }), large: () => listOrders({}, { limit: 100 }), budget: 3, exact: false },
    { name: 'unpaid confirmed orders (delete candidates)', small: () => listOrders({ status: 'confirmed', paymentStatus: 'unpaid' }, { limit: 2 }), large: () => listOrders({ status: 'confirmed', paymentStatus: 'unpaid' }, { limit: 100 }), budget: 3 },
    { name: 'approved invoices page', small: () => listFinalInvoices({}, env.ctx.session, { limit: 2 }), large: () => listFinalInvoices({}, env.ctx.session, { limit: 100 }), budget: 3 },
    { name: 'uncollected products page', small: () => listUncollectedProducts({}, env.ctx.session, { limit: 2 }), large: () => listUncollectedProducts({}, env.ctx.session, { limit: 100 }), budget: 12 },
    { name: 'customers page with balances', small: () => listCustomers({}, { limit: 2 }), large: () => listCustomers({}, { limit: 100 }), budget: 3 },
    { name: 'inventory movements with running balance', small: () => listMovements({}, { limit: 2 }), large: () => listMovements({}, { limit: 100 }), budget: 2 },
    { name: 'customer statement', small: () => customerStatement(fixture.bigCustomerId, env.ctx, { orders: { limit: 1 }, payments: { limit: 1 }, preliminaryInvoices: { limit: 1 }, approvedInvoices: { limit: 1 } }), large: () => customerStatement(fixture.bigCustomerId, env.ctx, { orders: { limit: 100 }, payments: { limit: 100 }, preliminaryInvoices: { limit: 100 }, approvedInvoices: { limit: 100 } }), budget: 6 },
    { name: 'finished goods (one product vs all)', small: () => listFinishedGoods({ productId: fixture.productIds[0] }), large: () => listFinishedGoods({}), budget: 3 },
    { name: 'monthly profit (empty vs busy month)', small: () => monthlyProfitSummary(2019, 1), large: () => monthlyProfitSummary(2026, 7), budget: 8 },
    { name: 'cumulative profit (68 vs 116 months)', small: () => cumulativeNetProfitMinor(new Date('2026-09-15T00:00:00.000Z')), large: () => cumulativeNetProfitMinor(new Date('2030-09-15T00:00:00.000Z')), budget: 7 }
  ]

  it.each(budgets)('$name', ({ small, large, budget, exact }) => {
    const smallCount = count(small)
    const largeCount = count(large)
    // The blocker statement runs only when a page contains delete candidates.
    if (exact !== false) expect(largeCount).toBe(smallCount)
    expect(smallCount).toBeLessThanOrEqual(budget)
    expect(largeCount).toBeLessThanOrEqual(budget)
  })

  it('cash accounts are two statements however many accounts exist', () => {
    const before = count(() => listAccounts({ asOf: '2025-01-01' }))
    for (let index = 0; index < 25; index += 1) createAccount({ name: `حساب إضافي ${index}`, kind: 'bank' }, env.ctx)
    expect(count(() => listAccounts({ asOf: '2025-01-01' }))).toBe(before)
    expect(before).toBe(2)
  })

  it('dashboard and alert feed use a fixed number of statements and a bounded alert payload', () => {
    const input = { date: '2026-08-10', year: 2026, month: 8, currentDay: false }
    expect(count(() => dashboardSummary(input, env.ctx.session))).toBeLessThanOrEqual(16)
    const feed = notificationFeed(env.ctx.session)
    expect(feed.items.length).toBeLessThanOrEqual(NOTIFICATION_FEED_LIMIT)
    expect(feed.totalCount).toBeGreaterThan(NOTIFICATION_FEED_LIMIT)
    expect(feed.unreadCount).toBe(feed.totalCount)
  })
})

describe('DB-10 page-independent authoritative totals', () => {
  function everyPage<T, S>(fetch: (request: { limit?: number; cursor?: string }) => { items: T[]; nextCursor: string | null; summary: S }, limit: number): S[] {
    const summaries: S[] = []
    let cursor: string | undefined
    do {
      const page = fetch({ limit, cursor })
      summaries.push(page.summary)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return summaries
  }

  it.each([
    {},
    { from: '2024-03-01', to: '2024-03-31' },
    { from: '2022-01-01', to: '2025-12-31', linkedOnly: true },
    { search: 'عام' },
    { kind: 'fixed' as const }
  ])('expense totals are identical for every page size and cursor, and equal the SQL oracle (%o)', (filter) => {
    const raw = getRawConnection()
    const clauses: string[] = ['1 = 1']
    const params: unknown[] = []
    if ('from' in filter && filter.from) { clauses.push('spent_at >= ?'); params.push(filter.from) }
    if ('to' in filter && filter.to) { clauses.push('spent_at <= ?'); params.push(filter.to) }
    if ('linkedOnly' in filter && filter.linkedOnly) clauses.push('order_id IS NOT NULL')
    if ('search' in filter && filter.search) { clauses.push('description LIKE ?'); params.push(`%${filter.search}%`) }
    if ('kind' in filter && filter.kind) { clauses.push('kind = ?'); params.push(filter.kind) }
    const oracle = raw.prepare(`SELECT COUNT(*) AS totalCount,
      COALESCE(SUM(CASE WHEN order_id IS NOT NULL AND reversed_at IS NULL THEN amount_minor END), 0) AS linkedMinor,
      COALESCE(SUM(CASE WHEN kind = 'fixed' AND source != 'salary' AND reversed_at IS NULL THEN amount_minor END), 0) AS fixedNonSalaryMinor,
      COALESCE(SUM(CASE WHEN kind = 'variable' AND reversed_at IS NULL THEN amount_minor END), 0) AS variableMinor
      FROM expenses WHERE ${clauses.join(' AND ')}`).get(...params)
    expect(expenseSummary(filter)).toEqual(oracle)
    for (const limit of [10, 25, 50, 100]) {
      for (const summary of everyPage((request) => listExpenses(filter, request), limit)) expect(summary).toEqual(oracle)
    }
    const summary = expenseSummary(filter)
    for (const value of Object.values(summary)) expect(Number.isSafeInteger(value)).toBe(true)
  })

  it('approved-invoice summaries are page-independent and equal the live per-invoice ledger position', () => {
    for (const archived of [false, true]) {
      const invoices = getRawConnection().prepare(`SELECT f.id, f.order_id AS orderId, f.status, f.total_minor AS totalMinor
        FROM final_invoices f LEFT JOIN orders o ON o.id = f.order_id JOIN customers c ON c.id = f.customer_id
        WHERE ${archived ? 'f.order_id IS NOT NULL AND o.archived_at IS NOT NULL' : '(f.order_id IS NULL OR o.archived_at IS NULL)'}`).all() as Array<{ id: number; orderId: number | null; status: string; totalMinor: number }>
      const oracle = {
        totalCount: invoices.length,
        totalApprovedMinor: invoices.filter((row) => row.status !== 'cancelled').reduce((sum, row) => sum + row.totalMinor, 0),
        totalOutstandingMinor: invoices.reduce((sum, row) => row.status === 'cancelled' ? sum
          : !row.orderId ? sum + row.totalMinor
            : row.status === 'draft' ? sum + row.totalMinor - orderPaymentPosition(row.orderId).paidMinor
              : sum + orderPaymentPosition(row.orderId).remainingMinor, 0)
      }
      for (const limit of [10, 25, 50, 100]) {
        for (const summary of everyPage((request) => listFinalInvoices({ archived }, env.ctx.session, request), limit)) expect(summary).toEqual(oracle)
      }
    }
  })

  it('withdrawal figures, operational counts and statement balances never depend on the page', () => {
    const available = legacyAvailableProfitMinor()
    const withdrawn = (getRawConnection().prepare('SELECT COALESCE(SUM(amount_minor), 0) AS t FROM profit_withdrawals').get() as { t: number }).t
    for (const limit of [1, 7, 100]) {
      for (const summary of everyPage((request) => listWithdrawals({}, request), limit)) {
        expect(summary).toEqual({ availableMinor: available, totalWithdrawnMinor: withdrawn })
      }
      const worksheetTotal = (getRawConnection().prepare("SELECT COUNT(*) AS c FROM work_sheets WHERE status != 'reversed'").get() as { c: number }).c
      for (const summary of everyPage((request) => listOperationalWorkSheets({}, request), Math.max(limit, 25))) expect(summary).toEqual({ totalCount: worksheetTotal })
      const uncollectedTotal = (getRawConnection().prepare('SELECT COUNT(*) AS c FROM uncollected_products').get() as { c: number }).c
      for (const summary of everyPage((request) => listUncollectedProducts({}, env.ctx.session, request), Math.max(limit, 25))) expect(summary).toEqual({ totalCount: uncollectedTotal })
    }
    const customer = customerStatement(fixture.bigCustomerId, env.ctx, { payments: { limit: 1 } })
    expect(customer.balance).toEqual(customerBalances(undefined, fixture.bigCustomerId)[0])
    const supplierRow = supplierBalances().find((row) => row.supplierId === fixture.bigSupplierId)!
    expect(supplierStatement(fixture.bigSupplierId, { payments: { limit: 1 } }).balance).toEqual({
      purchasedMinor: supplierRow.purchasedMinor, paidMinor: supplierRow.paidMinor, remainingMinor: supplierRow.remainingMinor
    })
    expect(workerStatement(fixture.bigWorkerId, { limit: 1 })).toMatchObject(workerBalances(fixture.bigWorkerId))
    expect(employeeStatement(fixture.bigEmployeeId, { limit: 1 }).balanceMinor).toBe(employeeBalance(fixture.bigEmployeeId))
    for (const row of listCustomers({}, { limit: 100 }).items) {
      const { customerId: _id, name: _name, phone: _phone, ...balance } = customerBalances(undefined, row.id)[0]!
      void _id; void _name; void _phone
      expect({ orderCount: row.orderCount, totalMinor: row.totalMinor, paidMinor: row.paidMinor, remainingMinor: row.remainingMinor }).toEqual(balance)
    }
  })
})
