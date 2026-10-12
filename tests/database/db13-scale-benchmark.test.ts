import { describe, expect, it } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import { setupTestDatabase } from '../helpers/test-db'
import { seedDb10Fixture } from '../helpers/db10-fixtures'
import { measure, queryPlan } from '../helpers/db10-measure'
import { buildReport } from '@main/services/reports/reports.service'
import { updateExpense } from '@main/services/finance/expenses.service'
import { salaryPaymentReversalPreview } from '@main/services/hr/employees.service'

/**
 * DB-13 BEFORE/AFTER evidence on the DB-10 deterministic history, reproducible
 * on one database: the pre-DB-13 report predicate is run verbatim beside the
 * current service, and mirror lookups are timed with and without the 0046 index.
 * DB13_BENCH=1 runs the 10k and 100k qualification; the default is a 2k smoke.
 */
const scales = process.env.DB13_BENCH === '1' ? [10_000, 100_000] : [2_000]
const LEGACY_CONSUMPTION = `
  SELECT mat.name, mat.unit,
         SUM(CASE WHEN mv.kind = 'consumption_reversal' THEN -mv.qty_micro ELSE mv.qty_micro END) AS qtyMicro,
         SUM(mv.actual_cost_minor) AS costMinor
  FROM inventory_movements mv JOIN materials mat ON mat.id = mv.material_id
  WHERE mv.kind IN ('consumption', 'consumption_reversal', 'sale') AND date(mv.created_at) BETWEEN ? AND ?
  GROUP BY mat.id ORDER BY costMinor DESC`

describe('DB-13 sargability and index qualification', () => {
  for (const scale of scales) it(`${scale} orders`, () => {
    const env = setupTestDatabase()
    try {
      seedDb10Fixture(scale)
      const raw = getRawConnection()
      const period = { from: '2023-06-01', to: '2023-06-30' }

      const legacy = measure(`legacy date() material consumption month @${scale}`,
        () => raw.prepare(LEGACY_CONSUMPTION).all(period.from, period.to), (rows) => rows.length)
      const current = measure(`sargable material consumption month @${scale}`,
        () => buildReport({ key: 'material_consumption', ...period }), (report) => report.rows.length)
      expect(current.rowsReturned).toBe(legacy.rowsReturned)
      // Join order varies with table size; the legacy form can never seek the created_at range.
      expect(queryPlan(LEGACY_CONSUMPTION, period.from, period.to).join(' ')).not.toMatch(/created_at>/)

      const expenseId = (raw.prepare("SELECT MAX(id) AS id FROM expenses WHERE source = 'manual'").get() as { id: number }).id
      const salaryId = (raw.prepare("SELECT MAX(id) AS id FROM employee_transactions WHERE kind = 'salary_payment'").get() as { id: number }).id
      let n = 0
      const corrections = (label: string) => [
        measure(`expense correction ${label} @${scale}`, () => updateExpense(expenseId, { description: `db13 ${n++}` }, env.ctx), () => 1),
        measure(`salary reversal preview ${label} @${scale}`, () => salaryPaymentReversalPreview(salaryId), () => 1)
      ]
      const indexed = corrections('with cash_transactions_ref_idx')
      expect(queryPlan("SELECT id FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = ?", expenseId).join(' '))
        .toMatch(/cash_transactions_ref_idx/)
      raw.exec('DROP INDEX cash_transactions_ref_idx')
      const scanned = corrections('without index')
      expect(queryPlan("SELECT id FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = ?", expenseId).join(' '))
        .toMatch(/SCAN cash_transactions/)
      indexed.forEach((m, i) => expect(m.queries).toBe(scanned[i]!.queries))
    } finally {
      env.cleanup()
    }
  }, 1_800_000)
})
