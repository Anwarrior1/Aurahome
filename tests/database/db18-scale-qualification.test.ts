import { existsSync, statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { openVerifiedDatabase } from '@main/app/database-startup'
import {
  closeDatabase,
  getDatabasePath,
  getRawConnection
} from '@main/db/connection'
import { listAccounts } from '@main/services/finance/cash.service'
import { createExpense } from '@main/services/finance/expenses.service'
import {
  cumulativeNetProfitMinor,
  monthlyProfitSummary
} from '@main/services/finance/profit.service'
import { recordOpeningStock } from '@main/services/inventory/inventory.service'
import { customerBalancesPage } from '@main/services/parties/parties.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { orderProfitabilityReport } from '@main/services/costing/costing.service'
import { setupTestDatabase } from '../helpers/test-db'
import { seedDb10Fixture } from '../helpers/db10-fixtures'

const scales = process.env.DB18_SCALES
  ? process.env.DB18_SCALES.split(',').map(Number)
  : [1_000]

function median(values: number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
}

function warmMedian(run: () => unknown, runs: number): number {
  run()
  const values: number[] = []
  for (let attempt = 0; attempt < runs; attempt += 1) {
    const start = performance.now()
    run()
    values.push(performance.now() - start)
  }
  return median(values)
}

function rollbackMedian(run: () => unknown, runs: number): number {
  const raw = getRawConnection()
  const values: number[] = []
  for (let attempt = 0; attempt < runs; attempt += 1) {
    raw.exec('SAVEPOINT db18_scale_probe')
    const start = performance.now()
    run()
    values.push(performance.now() - start)
    raw.exec('ROLLBACK TO db18_scale_probe; RELEASE db18_scale_probe')
  }
  return median(values)
}

function bytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

describe('DB-18 measured SQLite operational envelope', () => {
  for (const scale of scales) it(`${scale} orders`, () => {
    const env = setupTestDatabase()
    try {
      const fixture = seedDb10Fixture(scale)
      const databasePath = getDatabasePath()
      const walPath = `${databasePath}-wal`
      const rawBeforeStartup = getRawConnection()
      const walAllocatedBytes = bytes(walPath)
      const checkpointStart = performance.now()
      const checkpoint = rawBeforeStartup.pragma('wal_checkpoint(TRUNCATE)') as Array<{
        busy: number
        log: number
        checkpointed: number
      }>
      const checkpointMs = performance.now() - checkpointStart
      const walAfterCheckpointBytes = bytes(walPath)
      const databaseBytes = bytes(databasePath)

      closeDatabase()
      const startupStart = performance.now()
      openVerifiedDatabase()
      const startupMs = performance.now() - startupStart

      const raw = getRawConnection()
      const paymentOrder = raw.prepare(`SELECT id FROM orders
        WHERE status != 'cancelled' AND remaining_minor > 0 ORDER BY id LIMIT 1`).pluck().get() as number
      const runs = scale >= 100_000 ? 3 : 5
      const interactiveReadMs = warmMedian(() => customerBalancesPage({}, { limit: 50 }), runs)
      const cashReadMs = warmMedian(() => listAccounts({}), runs)
      const monthlyAggregateMs = warmMedian(() => monthlyProfitSummary(2026, 7), runs)
      const residualProfitMs = warmMedian(
        () => cumulativeNetProfitMinor(new Date('2026-09-16T00:00:00.000Z')),
        runs
      )
      const boundedProfitabilityMs = warmMedian(() => orderProfitabilityReport({
        completedOnly: true,
        from: '2026-07-01',
        to: '2026-07-31'
      }), runs)

      const financialWriteMs = rollbackMedian(() => createExpense({
        amountMinor: 1_000,
        cashAccountId: fixture.accountIds[0],
        description: 'DB-18 financial write',
        spentAt: '2026-09-16',
        requestKey: 'db18-expense-write'
      }, env.ctx), runs)

      const inventoryWriteMs = rollbackMedian(() => {
        recordOpeningStock({
          materialId: fixture.materialIds[0]!,
          qtyMicro: 1_000_000,
          unitCostMicro: 1_000_000,
          openingDate: '2026-09-16',
          notes: 'DB-18 inventory write'
        }, env.ctx)
      }, runs)

      const paymentWriteMs = rollbackMedian(() => recordPayment({
        orderId: paymentOrder,
        amountMinor: 1,
        cashAccountId: fixture.accountIds[0],
        paidAt: '2026-09-16',
        requestKey: 'db18-payment-write'
      }, env.ctx), runs)

      expect(checkpoint[0]?.busy).toBe(0)
      expect(walAfterCheckpointBytes).toBe(0)
      expect(customerBalancesPage({}, { limit: 50 }).items.length).toBeLessThanOrEqual(50)
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])
      console.log(`DB18_SCALE ${JSON.stringify({
        scale,
        runs,
        databaseBytes,
        walAllocatedBytes,
        walAfterCheckpointBytes,
        checkpointMs: Number(checkpointMs.toFixed(2)),
        startupMs: Number(startupMs.toFixed(2)),
        interactiveReadMs: Number(interactiveReadMs.toFixed(2)),
        cashReadMs: Number(cashReadMs.toFixed(2)),
        monthlyAggregateMs: Number(monthlyAggregateMs.toFixed(2)),
        residualProfitMs: Number(residualProfitMs.toFixed(2)),
        boundedProfitabilityMs: Number(boundedProfitabilityMs.toFixed(2)),
        financialWriteMs: Number(financialWriteMs.toFixed(2)),
        inventoryWriteMs: Number(inventoryWriteMs.toFixed(2)),
        paymentWriteMs: Number(paymentWriteMs.toFixed(2))
      })}`)
    } finally {
      env.cleanup()
    }
  }, 3_600_000)
})
