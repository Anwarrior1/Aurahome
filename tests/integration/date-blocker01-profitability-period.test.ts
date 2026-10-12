import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import { orderCostBreakdown, orderProfitabilityReport } from '@main/services/costing/costing.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { legacyOrderProfitabilityReport } from '../helpers/db10-legacy-oracles'

// These are retained historical rows, not a second order creation/completion command.
describe.each(['Africa/Tripoli', 'Africa/Cairo', 'UTC', 'America/New_York'])('profitability historical membership: %s', (zone) => {
  let env: TestEnv
  let previousZone: string | undefined
  let sequence: number
  beforeEach(() => {
    previousZone = process.env.TZ
    process.env.TZ = zone
    env = setupTestDatabase()
    sequence = 0
    getRawConnection().prepare("INSERT INTO customers (name) VALUES ('Historical customer')").run()
  })
  afterEach(() => {
    env?.cleanup()
    if (previousZone === undefined) delete process.env.TZ
    else process.env.TZ = previousZone
  })

  function order(createdAt: string, completedAt: string | null = createdAt): number {
    return Number(getRawConnection().prepare(`INSERT INTO orders
      (document_number, customer_id, status, total_minor, created_at, completed_at)
      VALUES (?, 1, 'completed', 100000, ?, ?)`).run(`HISTORY-${++sequence}`, createdAt, completedAt).lastInsertRowid)
  }
  function verify(ids: number[], from = '2025-01-01', to = from, completedOnly = false): void {
    const filter = { from, to, completedOnly }
    const result = orderProfitabilityReport(filter)
    expect(result.map((row) => row.orderId)).toEqual([...ids].sort((a, b) => b - a))
    expect(result).toEqual(legacyOrderProfitabilityReport(filter))
    expect(result).toEqual([...ids].sort((a, b) => b - a).map(orderCostBreakdown))
  }
  const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const space = (date: Date) => date.toISOString().replace('T', ' ').replace('.000Z', '')

  it('canonical UTC crossing the calendar boundary follows the factory day, including the independent oracle', () => {
    const at = '2024-12-31T22:30:00.000Z'
    const id = order(at)
    const day = localDate(new Date(at))
    verify([id], day)
    verify([], day === '2025-01-01' ? '2024-12-31' : '2025-01-01')
  })

  it('retained space form and canonical equivalent have identical membership and financial contribution', () => {
    const at = new Date('2025-01-01T23:30:00.000Z')
    const ids = [order(space(at)), order(at.toISOString())]
    const day = localDate(at)
    verify(ids, day)
    verify([], day === '2025-01-02' ? '2025-01-01' : '2025-01-02')
    expect(orderProfitabilityReport({ from: day, to: day }).reduce((sum, row) => sum + row.actualProfitMinor, 0)).toBe(200000)
  })

  it('includes the lower boundary and excludes the next midnight in both retained and canonical forms', () => {
    const start = new Date(2025, 0, 1).getTime()
    const end = new Date(2025, 0, 2).getTime()
    const expected: number[] = []
    for (const epoch of [start - 1000, start, start + 1000, end - 1000, end, end + 1000]) {
      const at = new Date(epoch)
      for (const value of [space(at), at.toISOString(), at.toISOString().replace('.000Z', 'Z')]) {
        const id = order(value)
        if (epoch >= start && epoch < end) expected.push(id)
      }
    }
    expected.push(order(new Date(end - 1).toISOString()))
    verify(expected)
  })

  it('offset instants, seconds and fractional seconds have the same chronology; explicit instant cutoffs stay inclusive', () => {
    const ids = [order('2025-01-01T23:30:00Z'), order('2025-01-01T23:30:00.000Z'),
      order('2025-01-02T01:30:00+02:00'), order('2025-01-01T23:30:00.0Z')]
    verify(ids, localDate(new Date('2025-01-01T23:30:00Z')))
    verify(ids, '2025-01-01T23:30:00Z', '2025-01-01T23:30:00.000Z')
    verify([], '2025-01-01T23:30:00.001Z', '2025-01-01T23:30:00.999Z')
  })

  it('date-only historical values retain calendar membership without a fabricated UTC midnight', () => {
    const id = order('2025-01-01')
    order('2025-01-02')
    verify([id])
    verify([id], '2025-01-01', '2025-01-01', true)
    // Unknown time-of-day remains calendar precision even for an instant request.
    const noon = new Date(2025, 0, 1, 12).toISOString()
    verify([id], noon, noon)
  })

  it('completed_at takes precedence and null completion falls back to created_at', () => {
    const noon = new Date(2025, 0, 1, 12).toISOString()
    const next = new Date(2025, 0, 2, 12).toISOString()
    const completed = order(next, noon)
    const fallback = order(noon, null)
    order(noon, next)
    verify([completed, fallback])
    verify([completed], '2025-01-01', '2025-01-01', true)
  })

  it('preserves arithmetic, descending IDs, repeated read purity and unfiltered historical rows', () => {
    const id = order(new Date(2025, 0, 1, 12).toISOString())
    getRawConnection().prepare(`INSERT INTO expenses (description, kind, amount_minor, spent_at, order_id)
      VALUES ('Historical linked cost', 'variable', 20000, '2025-01-01', ?)`).run(id)
    const raw = getRawConnection()
    const snapshot = () => JSON.stringify((raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
      .map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
    const before = snapshot()
    verify([id])
    verify([id])
    expect(orderProfitabilityReport({})[0]).toMatchObject({ sellingPriceMinor: 100000, totalActualCostMinor: 20000, actualProfitMinor: 80000 })
    expect(snapshot()).toBe(before)
  })

  it('classifies October UTC/local crossover with the active Cairo DST offset', () => {
    const at = '2026-09-30T21:30:00.000Z'
    const ids = [order(at), order(space(new Date(at)))]
    verify(ids, localDate(new Date(at)))
    if (zone === 'Africa/Cairo') expect(localDate(new Date(at))).toBe('2026-10-01')
  })

  it('uses successive local midnights across DST transition days', () => {
    for (const [month, day] of [[3, 8], [11, 1], [4, 24], [10, 30]]) {
      const start = new Date(2026, month! - 1, day!).getTime()
      const end = new Date(2026, month! - 1, day! + 1).getTime()
      const date = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const id = order(new Date(end - 1).toISOString())
      order(new Date(end).toISOString())
      verify([id], date)
      if (zone === 'America/New_York' && month === 3) expect(end - start).toBe(23 * 3600000)
      if (zone === 'America/New_York' && month === 11) expect(end - start).toBe(25 * 3600000)
    }
  })
})
