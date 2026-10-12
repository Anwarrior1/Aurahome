import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import { setupTestDatabase } from '../helpers/test-db'
import { seedDb10Fixture } from '../helpers/db10-fixtures'

const scale = Number(process.env.DB16_INDEX_SCALE ?? 2_000)
const OLD_INDEX = `CREATE INDEX cash_transactions_account_idx
  ON cash_transactions(account_id, occurred_at)`
const NEW_INDEX = `CREATE INDEX cash_transactions_account_idx
  ON cash_transactions(account_id, occurred_at, direction, amount_minor)`

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
}

function indexBytes(): number {
  return Number(
    getRawConnection()
      .prepare("SELECT COALESCE(SUM(pgsize), 0) FROM dbstat WHERE name = 'cash_transactions_account_idx'")
      .pluck()
      .get()
  )
}

function writeMedianMs(accountId: number, batchSize = 2_000): number {
  const raw = getRawConnection()
  const insert = raw.prepare(`INSERT INTO cash_transactions
    (account_id, direction, amount_minor, kind, occurred_at, created_at)
    VALUES (?, ?, ?, 'db16_write_probe', ?, ?)`)
  const durations: number[] = []
  for (let run = 0; run < 5; run += 1) {
    raw.exec('SAVEPOINT db16_write_probe')
    const start = performance.now()
    for (let row = 0; row < batchSize; row += 1) {
      const at = `2099-12-${String((row % 28) + 1).padStart(2, '0')}`
      insert.run(accountId, row % 2 ? 'in' : 'out', row + 1, at, `${at}T00:00:00.000Z`)
    }
    durations.push(performance.now() - start)
    raw.exec('ROLLBACK TO db16_write_probe; RELEASE db16_write_probe')
  }
  return median(durations)
}

function replaceIndex(statement: string): void {
  const raw = getRawConnection()
  raw.exec(`DROP INDEX cash_transactions_account_idx; ${statement}`)
}

describe('DB-16 cash covering-index cost evidence', () => {
  it(`measures storage and write cost at ${scale} orders and restores the production index`, () => {
    const env = setupTestDatabase()
    try {
      const fixture = seedDb10Fixture(scale)

      replaceIndex(OLD_INDEX)
      const oldBytes = indexBytes()
      writeMedianMs(fixture.accountIds[0]!, 200)
      const oldWriteMedianMs = writeMedianMs(fixture.accountIds[0]!)

      replaceIndex(NEW_INDEX)
      const newBytes = indexBytes()
      writeMedianMs(fixture.accountIds[0]!, 200)
      const newWriteMedianMs = writeMedianMs(fixture.accountIds[0]!)
      const plan = (getRawConnection()
        .prepare('EXPLAIN QUERY PLAN SELECT account_id, SUM(amount_minor) FROM cash_transactions GROUP BY account_id')
        .all() as Array<{ detail: string }>).map((row) => row.detail).join(' ')

      expect(oldBytes).toBeGreaterThan(0)
      expect(newBytes).toBeGreaterThanOrEqual(oldBytes)
      expect(plan).toMatch(/USING COVERING INDEX cash_transactions_account_idx/)
      console.log(`DB16_INDEX_IMPACT ${JSON.stringify({
        scale,
        cashRows: Number(getRawConnection().prepare('SELECT COUNT(*) FROM cash_transactions').pluck().get()),
        oldBytes,
        newBytes,
        extraBytes: newBytes - oldBytes,
        storageRatio: Number((newBytes / oldBytes).toFixed(3)),
        writeBatchRows: 2_000,
        oldWriteMedianMs: Number(oldWriteMedianMs.toFixed(2)),
        newWriteMedianMs: Number(newWriteMedianMs.toFixed(2)),
        writeRatio: Number((newWriteMedianMs / oldWriteMedianMs).toFixed(3))
      })}`)
    } finally {
      env.cleanup()
    }
  }, 1_800_000)
})
