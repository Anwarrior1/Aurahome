import { describe, expect, it } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import { setupTestDatabase } from './test-db'
import { traceQueries } from './query-counter'

describe('query timing trace', () => {
  it('records execution time for every real SQLite statement', () => {
    const env = setupTestDatabase()
    try {
      const traced = traceQueries(() => getRawConnection().prepare('SELECT 1 AS value').get())
      expect(traced.count).toBe(1)
      expect(traced.statementDurationsMs).toHaveLength(1)
      expect(traced.sqlDurationMs).toBeGreaterThanOrEqual(0)
      expect(traced.sqlDurationMs).toBe(traced.statementDurationsMs[0])
    } finally {
      env.cleanup()
    }
  })
})
