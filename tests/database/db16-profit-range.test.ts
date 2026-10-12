import { describe, expect, it } from 'vitest'
import { cumulativeNetProfitMinor } from '@main/services/finance/profit.service'
import { setupTestDatabase } from '../helpers/test-db'
import { seedDb10Fixture } from '../helpers/db10-fixtures'
import { traceQueries } from '../helpers/query-counter'
import { legacyCumulativeNetProfitMinor } from '../helpers/db10-legacy-oracles'

describe('DB-16 cumulative profit range aggregation', () => {
  it('matches the monthly oracle without expanding one SQL branch per historical month', () => {
    const env = setupTestDatabase()
    try {
      seedDb10Fixture(2_000)
      const now = new Date('2026-09-16T00:00:00.000Z')
      const traced = traceQueries(() => cumulativeNetProfitMinor(now))

      expect(traced.result).toBe(legacyCumulativeNetProfitMinor(now))
      // +1 fixed statement for BL-03 resale cost of goods; still independent of history length.
      expect(traced.count).toBeLessThanOrEqual(6)
      expect(traced.statements.join('\n')).not.toContain('UNION ALL')
    } finally {
      env.cleanup()
    }
  })
})
