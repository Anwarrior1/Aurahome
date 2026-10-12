import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { traceQueries } from '../helpers/query-counter'
import { getRawConnection } from '@main/db/connection'
import { buildReport } from '@main/services/reports/reports.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createAccount } from '@main/services/finance/cash.service'
import { createExpense, updateExpense } from '@main/services/finance/expenses.service'
import { formatMoney, money } from '@shared/money/money'
import { formatQuantity, quantity } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { dayStart, dayEnd } from '@main/services/base/service.types'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  env.cleanup()
})

const raw = () => getRawConnection()
const m = (minor: number) => formatMoney(money(minor))
const q = (micro: number, unit?: string) => formatQuantity(quantity(micro), unit)

/** Timestamps straddling every day/month/year/leap boundary, plus historical shapes DB-03 left unchanged. */
const STAMPS = [
  '2023-12-31T23:59:59.999Z', '2024-01-01T00:00:00.000Z', '2024-01-31T23:59:59.999Z', '2024-02-01T00:00:00.000Z',
  '2024-02-28T23:59:59.999Z', '2024-02-29T00:00:00.000Z', '2024-02-29T12:30:00.000Z', '2024-02-29T23:59:59.999Z',
  '2024-03-01T00:00:00.000Z', '2024-02-29 08:00:00', '2024-02-29', '', 'CURRENT_TIMESTAMP'
]
const PERIODS: Array<{ from?: string; to?: string }> = [
  {}, { from: '2024-02-29', to: '2024-02-29' }, { from: '2024-02-01', to: '2024-02-29' }, { from: '2023-12-31', to: '2024-01-01' },
  { from: '2024-03-01', to: '2024-03-31' }, { from: '2024-02-28', to: '2024-02-28' }, { from: '2024-03-01', to: '2024-02-01' },
  { from: '2024-01-01' }, { to: '2023-12-31' }
]

function seed(): void {
  const categoryId = createCategory({ name: 'Boards' }, env.ctx)
  const materials = ['MDF', 'Oak'].map((name) =>
    createMaterial({ sku: name, name, categoryId, unit: 'sheet', pricingRule: 'exact', currentMarketPriceMicro: c(1) }, env.ctx))
  const trigger = raw().prepare("SELECT sql FROM sqlite_master WHERE name = 'db03_reject_inventory_movements_created_at_insert'").get() as { sql: string }
  raw().exec('DROP TRIGGER db03_reject_inventory_movements_created_at_insert') // historical rows predate DB-03
  const insert = raw().prepare('INSERT INTO inventory_movements (material_id, kind, qty_micro, actual_cost_minor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  let n = 1
  for (const createdAt of STAMPS)
    for (const kind of ['consumption', 'consumption_reversal', 'sale', 'waste', 'purchase'])
      for (const materialId of materials) {
        insert.run(materialId, kind, 1_000 * n, 10 * n, `r${n}`, createdAt)
        n += 1
      }
  raw().exec(trigger.sql)
}

/** Local-day oracle; production keeps DB-13's indexed timestamp ranges. */
function legacy(key: 'material_consumption' | 'waste', from: string, to: string) {
  if (key === 'material_consumption') {
    const rows = raw().prepare(`
      SELECT mat.name, mat.unit,
             SUM(CASE WHEN mv.kind = 'consumption_reversal' THEN -mv.qty_micro ELSE mv.qty_micro END) AS qtyMicro,
             SUM(mv.actual_cost_minor) AS costMinor
      FROM inventory_movements mv JOIN materials mat ON mat.id = mv.material_id
      WHERE mv.kind IN ('consumption', 'consumption_reversal', 'sale')
        AND CASE WHEN mv.created_at GLOB '????-??-??' THEN mv.created_at
                 ELSE date(mv.created_at, 'localtime') END BETWEEN ? AND ?
      GROUP BY mat.id ORDER BY costMinor DESC`).all(from, to) as Array<{ name: string; unit: string; qtyMicro: number; costMinor: number }>
    return {
      rows: rows.map((row) => ({ المادة: row.name, 'الكمية المستهلكة فعلياً': q(row.qtyMicro, row.unit), 'التكلفة الفعلية': m(row.costMinor) })),
      totals: { 'إجمالي تكلفة الاستهلاك': m(rows.reduce((sum, row) => sum + row.costMinor, 0)) }
    }
  }
  const rows = raw().prepare(`
    SELECT mat.name, mat.unit, mv.qty_micro AS qtyMicro, mv.actual_cost_minor AS costMinor, mv.reason, mv.created_at AS createdAt
    FROM inventory_movements mv JOIN materials mat ON mat.id = mv.material_id
    WHERE mv.kind = 'waste'
      AND CASE WHEN mv.created_at GLOB '????-??-??' THEN mv.created_at
               ELSE date(mv.created_at, 'localtime') END BETWEEN ? AND ?
    ORDER BY mv.id DESC`).all(from, to) as Array<{ name: string; unit: string; qtyMicro: number; costMinor: number; reason: string | null; createdAt: string }>
  return {
    rows: rows.map((row) => ({ التاريخ: new Date(row.createdAt).toLocaleDateString('en-CA'), المادة: row.name, الكمية: q(row.qtyMicro, row.unit), التكلفة: m(row.costMinor), السبب: row.reason ?? '' })),
    totals: { 'إجمالي خسائر الهالك': m(rows.reduce((sum, row) => sum + row.costMinor, 0)) }
  }
}

describe('DB-13 sargable inventory report periods', () => {
  it.each(['material_consumption', 'waste'] as const)('%s returns exactly the legacy rows, order and totals across every boundary', (key) => {
    seed()
    let nonEmpty = 0
    for (const period of PERIODS) {
      const report = buildReport({ key, ...period })
      const expected = legacy(key, period.from ?? '1900-01-01', period.to ?? '2999-12-31')
      expect({ period, rows: report.rows, totals: report.totals }).toEqual({ period, ...expected })
      if (expected.rows.length) nonEmpty += 1
    }
    expect(nonEmpty).toBeGreaterThanOrEqual(6)
    // The leap day includes midnight, its final millisecond, and legacy space/date-only rows — never the literal or empty value.
    expect(buildReport({ key: 'waste', from: '2024-02-29', to: '2024-02-29' }).rows).toHaveLength(2 * 5)
  })

  it('seeks the existing (kind, created_at) index instead of reading every movement of the kind', () => {
    seed()
    for (const key of ['material_consumption', 'waste'] as const) {
      const { statements } = traceQueries(() => buildReport({ key, from: '2024-02-01', to: '2024-02-29' }))
      expect(statements).toHaveLength(1)
      const plan = (raw().prepare(`EXPLAIN QUERY PLAN ${statements[0]}`).all(dayStart('2024-02-01'), dayEnd('2024-02-29')) as Array<{ detail: string }>)
        .map((row) => row.detail).join(' | ')
      expect(plan).toMatch(/inventory_movements_kind_date_idx \(kind=\? AND created_at>\? AND created_at<\?\)/)
    }
  })

  it.each([
    { from: '2024-02-29T00:00:00.000Z' }, { to: '2024-2-29' }, { from: 'CURRENT_TIMESTAMP' }, { to: '' }
  ])('rejects a period that is not a calendar date without reading: %o', (period) => {
    expect(() => buildReport({ key: 'sales', ...period })).toThrow(/YYYY-MM-DD/)
  })
})

describe('DB-13 cash mirror lookup index', () => {
  it('source corrections locate their mirror through cash_transactions_ref_idx', () => {
    const accountId = createAccount({ name: 'Cash', kind: 'cash', openingBalanceMinor: 100_000 }, env.ctx)
    const id = createExpense({ amountMinor: 500, cashAccountId: accountId, description: 'fuel' }, env.ctx)
    const { statements } = traceQueries(() => updateExpense(id, { amountMinor: 700 }, env.ctx))
    // Ownership-safe corrections now validate and update the existing mirror
    // rather than delete/repost it. Keep the same indexed reference lookup gate.
    const lookup = statements.find((sql) => /select .* from "cash_transactions".*"ref_table" = \?/i.test(sql))!
    expect(lookup).toBeDefined()
    const plan = (raw().prepare(`EXPLAIN QUERY PLAN ${lookup}`).all('expenses', id) as Array<{ detail: string }>).map((row) => row.detail).join(' | ')
    expect(plan).toMatch(/SEARCH cash_transactions USING (COVERING )?INDEX cash_transactions_ref_idx \(ref_table=\? AND ref_id=\?\)/)
    expect(raw().prepare("SELECT amount_minor AS a FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = ?").all(id)).toEqual([{ a: 700 }])
  })
})
