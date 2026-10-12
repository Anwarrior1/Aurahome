import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import { orderProfitabilityReport } from '@main/services/costing/costing.service'
import { buildReport } from '@main/services/reports/reports.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { seedDb10Fixture } from '../helpers/db10-fixtures'
import { traceQueries } from '../helpers/query-counter'
import { measure, queryPlan } from '../helpers/db10-measure'
import { legacyOrderProfitabilityReport } from '../helpers/db10-legacy-oracles'

/**
 * DB-10 §33 blocker: order_costs / order_profitability reports and
 * orders.profitability computed every order with orderCostBreakdown
 * (≈8–9 statements per order). The set-based report must equal that
 * per-order oracle exactly — values, ordering, completeness and errors —
 * with a statement count that does not depend on how many orders match.
 */
type Filter = { from?: string; to?: string; completedOnly?: boolean }

function outcome<T>(fn: () => T): { value?: T; error?: string } {
  try {
    return { value: fn() }
  } catch (error) {
    return { error: error instanceof Error ? `${(error as { code?: string }).code ?? ''} ${error.message}` : String(error) }
  }
}

const FILTERS: Filter[] = [
  { completedOnly: true },
  { completedOnly: false },
  {},
  { from: '2024-01-01', completedOnly: false },
  { to: '2022-06-30T23:59:59.999Z', completedOnly: true },
  { from: '2026-07-01', to: '2026-07-31T23:59:59.999Z', completedOnly: true },
  { from: '2026-07-01', to: '2026-07-31T23:59:59.999Z', completedOnly: false },
  { from: '2999-01-01', completedOnly: false }
]

function expectEquivalent(label: string): void {
  for (const filter of FILTERS) {
    expect(outcome(() => orderProfitabilityReport(filter)), `${label} ${JSON.stringify(filter)}`).toEqual(outcome(() => legacyOrderProfitabilityReport(filter)))
  }
}

describe('DB-10 set-based order cost / profitability report', () => {
  let env: TestEnv

  beforeAll(() => {
    env = setupTestDatabase()
    seedDb10Fixture(1_200)
  }, 120_000)
  afterAll(() => env.cleanup())

  it('equals the per-order orderCostBreakdown oracle for every filter and keeps the complete requested set', () => {
    expectEquivalent('fixture')
    const raw = getRawConnection()
    const nonCancelled = (raw.prepare("SELECT COUNT(*) AS c FROM orders WHERE status != 'cancelled'").get() as { c: number }).c
    const completed = (raw.prepare("SELECT COUNT(*) AS c FROM orders WHERE status != 'cancelled' AND completed_at IS NOT NULL").get() as { c: number }).c
    expect(orderProfitabilityReport({ completedOnly: false })).toHaveLength(nonCancelled)
    expect(orderProfitabilityReport({ completedOnly: true })).toHaveLength(completed)
    expect(completed).toBeGreaterThan(100)
    const rows = orderProfitabilityReport({ completedOnly: false })
    expect(rows.map((row) => row.orderId)).toEqual([...rows.map((row) => row.orderId)].sort((a, b) => b - a))
    for (const row of rows) {
      for (const value of Object.values(row)) if (typeof value === 'number') expect(Number.isSafeInteger(value)).toBe(true)
    }
    // Every cost component is exercised by the fixture.
    const totals = rows.reduce((sum, row) => ({
      material: sum.material + row.materialCostMinor, machine: sum.machine + row.machineCostMinor, worker: sum.worker + row.workerCostMinor,
      delivery: sum.delivery + row.deliveryCostMinor, linked: sum.linked + row.linkedExpensesMinor, commercial: sum.commercial + row.commercialMaterialValueMinor
    }), { material: 0, machine: 0, worker: 0, delivery: 0, linked: 0, commercial: 0 })
    for (const value of Object.values(totals)) expect(value).toBeGreaterThan(0)
    expect(rows.some((row) => !row.isComplete)).toBe(true)
  })

  it('uses three statements (costs, finished goods, BL-03 resale) however many orders the requested set contains', () => {
    const counts = FILTERS.map((filter) => ({ filter, rows: orderProfitabilityReport(filter).length, queries: traceQueries(() => orderProfitabilityReport(filter)).count }))
    for (const entry of counts) expect(entry.queries, JSON.stringify(entry)).toBe(3)
    expect(Math.max(...counts.map((entry) => entry.rows))).toBeGreaterThan(500)
    expect(Math.min(...counts.map((entry) => entry.rows))).toBe(0)
    // Report builders add no per-row statements.
    expect(traceQueries(() => buildReport({ key: 'order_costs' })).count).toBe(3)
    expect(traceQueries(() => buildReport({ key: 'order_profitability', from: '2026-07-01', to: '2026-07-31' })).count).toBe(3)
    // The oracle grows with the number of orders.
    expect(traceQueries(() => legacyOrderProfitabilityReport({ completedOnly: true })).count).toBeGreaterThan(counts[0]!.rows * 8)
  })

  it('stays exact after reversals, cancellations, voided returns, sale reversals and removed costs', () => {
    const raw = getRawConnection()
    const completed = (raw.prepare("SELECT id FROM orders WHERE status = 'completed' ORDER BY id DESC LIMIT 60").all() as Array<{ id: number }>).map((row) => row.id)
    const at = '2026-08-01T00:00:00.000Z'
    const ids = (offset: number) => completed.filter((_, index) => index % 6 === offset).join(',')
    raw.transaction(() => {
      raw.exec(`UPDATE order_machine_usage SET reversed_at = '${at}' WHERE order_id IN (${ids(0)})`)
      raw.exec(`UPDATE order_worker_assignments SET reversed_at = '${at}' WHERE order_id IN (${ids(1)})`)
      raw.exec(`UPDATE deliveries SET status = 'cancelled' WHERE order_id IN (${ids(2)})`)
      raw.exec(`UPDATE order_material_lines SET status = 'reversed', reversed_at = '${at}' WHERE order_id IN (${ids(3)})`)
      raw.exec(`UPDATE expenses SET reversed_at = '${at}' WHERE order_id IN (${ids(4)})`)
      raw.exec(`DELETE FROM order_machine_usage WHERE order_id IN (${ids(5)})`)
      raw.exec(`DELETE FROM order_worker_assignments WHERE order_id IN (${ids(5)})`)
      // A second worker on one order, and a completed order moved to cancelled.
      const worker = raw.prepare('SELECT worker_id AS workerId, work_sheet_id AS sheetId FROM order_worker_assignments WHERE order_id = ? LIMIT 1').get(completed[10]) as { workerId: number; sheetId: number }
      raw.prepare("INSERT INTO order_worker_assignments (order_id, work_sheet_id, worker_id, method, amount_minor, earned, earned_at) VALUES (?, ?, ?, 'fixed', 777, 1, ?)").run(completed[10], worker.sheetId, worker.workerId, at)
      raw.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(at, completed[11])
    })()
    expectEquivalent('mutated')

    // A voided and an active material return on one issue line.
    const line = raw.prepare(`SELECT l.id, l.order_id AS orderId, l.material_id AS materialId, l.actual_cost_minor AS cost
      FROM order_material_lines l WHERE l.status = 'active' AND l.order_id = ? LIMIT 1`).get(completed[12]) as { id: number; orderId: number; materialId: number; cost: number } | undefined
    if (line) {
      const columns = raw.prepare("SELECT name, \"notnull\" AS required, dflt_value AS fallback FROM pragma_table_info('material_returns')").all() as Array<{ name: string; required: number; fallback: unknown }>
      const allocationColumns = raw.prepare("SELECT name, \"notnull\" AS required, dflt_value AS fallback FROM pragma_table_info('material_return_allocations')").all() as Array<{ name: string; required: number; fallback: unknown }>
      const insertReturn = (status: string, cost: number): number => {
        const values: Record<string, unknown> = { order_id: line.orderId, material_id: line.materialId, returned_qty_micro: 1_000, returned_cost_minor: cost, status, reason: 'DB10', created_by: 1, created_at: at, updated_at: at, returned_at: at }
        const names = columns.filter((column) => column.name in values || (column.required && column.fallback === null && column.name !== 'id')).map((column) => column.name)
        return Number(raw.prepare(`INSERT INTO material_returns (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((name) => values[name] ?? 1)).lastInsertRowid)
      }
      const insertAllocation = (returnId: number, cost: number) => {
        const values: Record<string, unknown> = { return_id: returnId, issue_line_id: line.id, qty_micro: 1_000, cost_minor: cost, created_at: at }
        const names = allocationColumns.filter((column) => column.name in values || (column.required && column.fallback === null && column.name !== 'id')).map((column) => column.name)
        raw.pragma('foreign_keys = OFF')
        try {
          raw.prepare(`INSERT INTO material_return_allocations (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((name) => values[name] ?? 1))
        } finally {
          raw.pragma('foreign_keys = ON')
        }
      }
      raw.pragma('foreign_keys = OFF')
      let active: number, voided: number
      try {
        active = insertReturn('active', 125)
        voided = insertReturn('voided', 50)
      } finally {
        raw.pragma('foreign_keys = ON')
      }
      insertAllocation(active, 125)
      insertAllocation(voided, 50)
      const row = orderProfitabilityReport({ completedOnly: false }).find((entry) => entry.orderId === line.orderId)
      const oracle = legacyOrderProfitabilityReport({ completedOnly: false }).find((entry) => entry.orderId === line.orderId)
      expect(row).toEqual(oracle)
      expectEquivalent('material returns')
    }

    // Finished-goods sale reversal (net zero), then a reversal larger than the issue (error path).
    const sale = raw.prepare("SELECT product_id AS productId, order_id AS orderId, total_cost_minor AS cost FROM finished_goods_movements WHERE kind = 'sale_out' AND order_id IS NOT NULL ORDER BY id DESC LIMIT 2").all() as Array<{ productId: number; orderId: number; cost: number }>
    const reversal = raw.prepare("INSERT INTO finished_goods_movements (product_id, kind, qty_micro, unit_cost_minor, total_cost_minor, order_id, created_by, created_at) VALUES (?, 'sale_reversal', 1000000, ?, ?, ?, 1, ?)")
    reversal.run(sale[0]!.productId, sale[0]!.cost, sale[0]!.cost, sale[0]!.orderId, at)
    expectEquivalent('sale reversal')
    reversal.run(sale[1]!.productId, sale[1]!.cost + 1, sale[1]!.cost + 1, sale[1]!.orderId, at)
    const failing = outcome(() => orderProfitabilityReport({ completedOnly: true }))
    expect(failing.error).toContain('CONFLICT')
    expectEquivalent('negative finished-goods cost')
  })
})

/**
 * Scale evidence. The normal suite runs the equivalence/budget checks above;
 * DB10_BENCH=1 (or DB10_COSTING_SCALES) measures BEFORE vs AFTER at 10k/100k
 * and requires exact equality of the complete result at each scale.
 */
const scales = process.env.DB10_COSTING_SCALES ? process.env.DB10_COSTING_SCALES.split(',').map(Number) : process.env.DB10_BENCH === '1' ? [10_000, 100_000] : []

describe.runIf(scales.length > 0)('DB-10 order costing scale qualification', () => {
  for (const scale of scales) it(`${scale} orders`, () => {
    const env = setupTestDatabase()
    try {
      seedDb10Fixture(scale)
      const heavy = scale >= 100_000
      const month: Filter = { from: '2026-07-01', to: '2026-07-31T23:59:59.999Z' }
      for (const [label, filter] of [
        ['order_costs whole history', { completedOnly: false }],
        ['order_profitability whole history', { completedOnly: true }],
        ['order_costs one month', { ...month, completedOnly: false }],
        ['order_profitability one month', { ...month, completedOnly: true }]
      ] as Array<[string, Filter]>) {
        const after = measure(`AFTER ${label} @${scale}`, () => orderProfitabilityReport(filter), (value) => value.length, { runs: heavy ? 3 : 5 })
        const before = measure(`BEFORE ${label} @${scale}`, () => legacyOrderProfitabilityReport(filter), (value) => value.length, { runs: 1 })
        expect(after.result).toEqual(before.result)
        expect(after.queries).toBe(2)
        expect(before.queries).toBeGreaterThan(after.rowsReturned * 8)
      }
      measure(`AFTER reports.build order_costs whole history @${scale}`, () => buildReport({ key: 'order_costs' }), (value) => value.rows.length, { runs: heavy ? 3 : 5 })
      console.log(`DB10_PLAN orderCosting ${JSON.stringify(queryPlan(`SELECT o.id,
        (SELECT SUM(l.actual_cost_minor - COALESCE((SELECT SUM(mra.cost_minor) FROM material_return_allocations mra JOIN material_returns mr ON mr.id = mra.return_id WHERE mra.issue_line_id = l.id AND mr.status = 'active'), 0)) FROM order_material_lines l JOIN materials mat ON mat.id = l.material_id WHERE l.order_id = o.id AND l.status = 'active'),
        (SELECT SUM(u.final_amount_minor) FROM order_machine_usage u JOIN machines mach ON mach.id = u.machine_id WHERE u.order_id = o.id AND u.reversed_at IS NULL),
        (SELECT SUM(a.amount_minor) FROM order_worker_assignments a WHERE a.order_id = o.id AND a.reversed_at IS NULL),
        (SELECT SUM(d.actual_cost_minor) FROM deliveries d WHERE d.order_id = o.id AND d.status = 'recorded'),
        (SELECT SUM(e.amount_minor) FROM expenses e WHERE e.order_id = o.id)
        FROM orders o WHERE status != 'cancelled' ORDER BY o.id DESC`))}`)
      console.log(`DB10_PLAN orderCostingFinishedGoods ${JSON.stringify(queryPlan("SELECT order_id, kind, total_cost_minor FROM finished_goods_movements WHERE order_id IN (SELECT id FROM orders WHERE status != 'cancelled') AND kind IN ('sale_out', 'sale_reversal')"))}`)
    } finally {
      env.cleanup()
    }
  }, 1_800_000)
})
