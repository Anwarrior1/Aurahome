import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { getRawConnection } from '@main/db/connection'
import { reconcileDatabase, RECONCILIATION_CHECK_COUNT } from '@main/db/reconciliation'
import { setupTestDatabase } from '../helpers/test-db'
import { seedDb10Fixture } from '../helpers/db10-fixtures'
import { measure, tableCount } from '../helpers/db10-measure'
import { traceQueries } from '../helpers/query-counter'

/**
 * DB-12 reconciliation cost on the DB-10 deterministic history. The synthetic
 * fixture is not posted through services, so it intentionally carries many
 * findings: that exercises the bounded streaming path, not correctness.
 * DB12_BENCH=1 runs the 10k and 100k qualification.
 */
const scales = process.env.DB12_BENCH === '1' ? [10_000, 100_000] : [2_000]

describe('DB-12 reconciliation scale', () => {
  for (const scale of scales) it(`${scale} orders`, () => {
    const env = setupTestDatabase()
    try {
      seedDb10Fixture(scale)
      const raw = getRawConnection()
      const rows = ['orders', 'cash_transactions', 'inventory_movements', 'fifo_allocations', 'finished_goods_movements', 'employee_transactions', 'audit_log']
        .map((table) => [table, tableCount(table)])
      console.log(`DB12_ROWS @${scale} ${JSON.stringify(Object.fromEntries(rows))}`)
      const changes = raw.prepare('SELECT total_changes() AS c').get()
      const result = measure(`reconcileDatabase @${scale}`, () => reconcileDatabase(raw), (r) => r.findings.length,
        { dbRows: tableCount('orders'), runs: scale >= 100_000 ? 2 : 3 })
      expect(result.queries).toBe(RECONCILIATION_CHECK_COUNT)
      expect(result.payloadBytes).toBeLessThan(RECONCILIATION_CHECK_COUNT * 1_200)
      expect(raw.prepare('SELECT total_changes() AS c').get()).toEqual(changes)

      // Per-check cost, slowest first, to justify (or not) any index.
      const statements = traceQueries(() => reconcileDatabase(raw, { sampleLimit: 0 })).statements
      const timings = statements.map((sql) => {
        const started = performance.now()
        for (const _ of raw.prepare(sql).iterate()) void _
        return { ms: Number((performance.now() - started).toFixed(1)), sql: sql.slice(0, 90) }
      }).sort((a, b) => b.ms - a.ms)
      console.log(`DB12_SLOWEST @${scale} ${JSON.stringify(timings.slice(0, 8))}`)
    } finally {
      env.cleanup()
    }
  }, 900_000)
})
