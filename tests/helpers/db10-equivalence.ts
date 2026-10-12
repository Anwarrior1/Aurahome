import { expect } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import { orderActionEligibilities, openOrderAlertRows } from '@main/services/sales/orders.service'
import { listFinishedGoods } from '@main/services/production/finished-goods.service'
import { listAccounts } from '@main/services/finance/cash.service'
import { cumulativeNetProfitMinor, monthlyProfitSummary } from '@main/services/finance/profit.service'
import { listDeliveries, listReleases } from '@main/services/production/production.service'
import { orderProfitabilityReport } from '@main/services/costing/costing.service'
import {
  legacyOrderProfitabilityReport,
  legacyCumulativeNetProfitMinor,
  legacyIncompleteOrderKeys,
  legacyListAccounts,
  legacyListDeliveries,
  legacyListFinishedGoods,
  legacyListReleases,
  legacyMonthlyProfitSummary,
  legacyOrderActionEligibility
} from './db10-legacy-oracles'

function outcome<T>(fn: () => T): { value?: T; error?: string } {
  try {
    return { value: fn() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function allPages<T>(fetch: (cursor?: string) => { items: T[]; nextCursor: string | null }): T[] {
  const rows: T[] = []
  let cursor: string | undefined
  do {
    const page = fetch(cursor)
    rows.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return rows
}

/**
 * DB-10 exact-equivalence gate: every set-based read that replaced a per-row
 * or repeated calculation must equal the preserved pre-DB-10 implementation
 * on the current database state — values, shapes, ordering and errors.
 */
export function assertDb10Equivalence(options: { now?: Date } = {}): void {
  const raw = getRawConnection()
  if (!raw.open) return
  const now = options.now ?? new Date('2026-09-15T12:00:00.000Z')

  const orders = raw.prepare('SELECT id, status, archived_at AS archivedAt FROM orders ORDER BY id').all() as Array<{ id: number; status: string; archivedAt: string | null }>
  if (orders.length) {
    const batched = orderActionEligibilities(orders)
    for (const order of orders) expect({ id: order.id, ...batched.get(order.id) }).toEqual({ id: order.id, ...legacyOrderActionEligibility(order) })
  }

  expect(outcome(() => listFinishedGoods({}))).toEqual(outcome(() => legacyListFinishedGoods({})))
  expect(listAccounts({})).toEqual(legacyListAccounts({}))
  expect(listAccounts({ asOf: '2026-01-15' })).toEqual(legacyListAccounts({ asOf: '2026-01-15' }))

  const months = raw.prepare(`SELECT DISTINCT CAST(substr(completed_at, 1, 4) AS INTEGER) AS year, CAST(substr(completed_at, 6, 2) AS INTEGER) AS month
    FROM orders WHERE status = 'completed' AND completed_at IS NOT NULL`).all() as Array<{ year: number; month: number }>
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }
  for (const { year, month } of [...months, current, { year: 2019, month: 2 }]) {
    expect(outcome(() => monthlyProfitSummary(year, month))).toEqual(outcome(() => legacyMonthlyProfitSummary(year, month)))
  }
  expect(outcome(() => cumulativeNetProfitMinor(now))).toEqual(outcome(() => legacyCumulativeNetProfitMinor(now)))

  // order_costs / order_profitability reports and orders.profitability.
  const bounds = raw.prepare('SELECT MIN(COALESCE(completed_at, created_at)) AS low, MAX(COALESCE(completed_at, created_at)) AS high FROM orders').get() as { low: string | null; high: string | null }
  const middle = (raw.prepare('SELECT COALESCE(completed_at, created_at) AS at FROM orders ORDER BY at LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM orders)').get() as { at: string } | undefined)?.at
  for (const filter of [
    { completedOnly: true }, { completedOnly: false }, {},
    ...(middle ? [{ from: middle, completedOnly: false }, { to: middle, completedOnly: true }, { from: bounds.low!, to: bounds.high!, completedOnly: false }] : []),
    { from: '2999-01-01', completedOnly: false }
  ]) {
    expect(outcome(() => orderProfitabilityReport(filter)), JSON.stringify(filter)).toEqual(outcome(() => legacyOrderProfitabilityReport(filter)))
  }

  expect(allPages((cursor) => listReleases({ includeReversed: true }, { limit: 100, cursor }))).toEqual(legacyListReleases({ includeReversed: true }))
  expect(allPages((cursor) => listReleases({}, { limit: 100, cursor }))).toEqual(legacyListReleases({}))
  expect(allPages((cursor) => listDeliveries({}, { limit: 100, cursor }))).toEqual(legacyListDeliveries({}))

  expect(openOrderAlertRows().map((order) => `incomplete_order:${order.id}`)).toEqual(legacyIncompleteOrderKeys())
}
