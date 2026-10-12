import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import { buildReport } from '@main/services/reports/reports.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { formatMoney, money } from '@shared/money/money'
import { formatQuantity, quantity } from '@shared/quantity/quantity'

// Run this unchanged file in subprocesses with TZ set before Node starts.
const zone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
const day = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
const space = (at: Date) => at.toISOString().replace('T', ' ').replace('.000Z', '')
let env: TestEnv
let material: number
beforeEach(() => {
  env = setupTestDatabase()
  const categoryId = createCategory({ name: 'Historical boards' }, env.ctx)
  material = createMaterial({ sku: 'HIST', name: 'Board', categoryId, unit: 'sheet', pricingRule: 'exact', currentMarketPriceMicro: 1000000 }, env.ctx)
})
afterEach(() => env.cleanup())
function movement(at: string, kind = 'consumption', qty = 1000000, cost = 10000) {
  getRawConnection().prepare('INSERT INTO inventory_movements (material_id, kind, qty_micro, actual_cost_minor, created_at) VALUES (?, ?, ?, ?, ?)').run(material, kind, qty, cost, at)
}
function check(qty: number, cost: number, from = '2024-02-29', to = from) {
  const result = buildReport({ key: 'material_consumption', from, to })
  expect(result.totals).toEqual({ 'إجمالي تكلفة الاستهلاك': formatMoney(money(cost)) })
  expect(result.rows).toEqual(qty === 0 && cost === 0 ? [] : [{ المادة: 'Board', 'الكمية المستهلكة فعلياً': formatQuantity(quantity(qty), 'sheet'), 'التكلفة الفعلية': formatMoney(money(cost)) }])
}
describe(`material-consumption historical periods (${zone})`, () => {
  it('verifies JS and native SQLite local timezone agree with the subprocess environment', () => {
    const at = '2024-02-29T23:30:00Z'
    expect(getRawConnection().prepare("SELECT date(?, 'localtime') AS day").get(at)).toEqual({ day: day(new Date(at)) })
    if (zone === 'Africa/Tripoli' || zone === 'Africa/Cairo') expect(day(new Date(at))).toBe('2024-03-01')
    if (zone === 'UTC' || zone === 'America/New_York') expect(day(new Date(at))).toBe('2024-02-29')
  })
  it('space/canonical late equivalents have the same membership; exposes 50 versus 60 LYD', () => {
    const noon = new Date(2024, 1, 29, 12).toISOString()
    for (let i = 0; i < 5; i++) movement(noon)
    movement('2024-02-29 23:30:00')
    movement('2024-02-29T23:30:00.000Z')
    const lateBelongs = day(new Date('2024-02-29T23:30:00Z')) === '2024-02-29'
    check(lateBelongs ? 7000000 : 5000000, lateBelongs ? 70000 : 50000)
  })
  it('early space and canonical events belong equally', () => {
    movement('2024-02-29 08:00:00')
    movement('2024-02-29T08:00:00.000Z')
    check(2000000, 20000)
  })
  it('retained date-only values remain business dates, including negative offsets', () => {
    movement('2024-02-29')
    movement('2024-03-01', 'consumption', 2000000, 20000)
    check(1000000, 10000)
  })
  it('canonical UTC crossover follows the local calendar', () => {
    const at = '2024-02-28T22:30:00.000Z'
    movement(at)
    check(1000000, 10000, day(new Date(at)))
  })
  it('offset instants agree with UTC equivalents, including maximum SQLite offsets', () => {
    for (const at of ['2024-02-29T23:30:00+02:00', '2024-02-29T21:30:00Z', '2024-03-01T11:30:00+14:00', '2024-02-29T07:30:00-14:00']) movement(at)
    check(4000000, 40000, day(new Date('2024-02-29T21:30:00Z')))
  })
  it('includes exact start and final millisecond, excludes adjacent instants in every serialization', () => {
    const start = new Date(2024, 1, 29).getTime(), next = new Date(2024, 2, 1).getTime()
    for (const t of [start - 1000, start, start + 1000, next - 1000, next, next + 1000]) {
      for (const at of [new Date(t).toISOString(), space(new Date(t)), new Date(t).toISOString().replace('.000Z', 'Z')]) movement(at)
    }
    movement(new Date(start - 1).toISOString())
    movement(new Date(start + 1).toISOString())
    movement(new Date(next - 1).toISOString())
    movement(new Date(next + 1).toISOString())
    check(11000000, 110000)
  })
  it('preserves every contributing kind, quantity signs and actual-cost signs', () => {
    const at = new Date(2024, 1, 29, 12).toISOString()
    movement(at, 'consumption', 10000000, 100000)
    movement(at, 'consumption_reversal', 2000000, -20000)
    movement(at, 'sale', 3000000, 30000)
    movement(at, 'material_return', 1000000, -10000)
    movement(at, 'material_return_reversal', 1000000, 10000)
    movement(at, 'waste', 7000000, 70000)
    movement(at, 'purchase', 8000000, 80000)
    check(11000000, 110000)
  })
  it('malformed retained shapes never become period members', () => {
    for (const at of ['2024-02-29nonsense', '2024-02-29Tgarbage', '2024-02-30', '2024-02-29X00:00:00', '', 'now', '2451545.0']) movement(at)
    check(0, 0)
    expect(() => movement('CURRENT_TIMESTAMP')).toThrow(/invalid literal timestamp/)
  })
  it('keeps full valid history and repeated reads pure', () => {
    movement('2024-02-29')
    movement('2024-02-29 23:30:00')
    movement('2024-02-29T23:30:00Z')
    const raw = getRawConnection()
    const snapshot = () => JSON.stringify((raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
    const before = snapshot()
    const first = buildReport({ key: 'material_consumption' })
    expect(first).toEqual(buildReport({ key: 'material_consumption' }))
    expect(first.totals).toEqual({ 'إجمالي تكلفة الاستهلاك': formatMoney(money(30000)) })
    expect(snapshot()).toBe(before)
  })
  it('handles timezone-database DST days using successive local midnights', () => {
    const dates = zone === 'America/New_York' ? [[2026, 3, 8], [2026, 11, 1]] : [[2026, 4, 24], [2026, 10, 29]]
    for (const [y, m, d] of dates) {
      const start = new Date(y!, m! - 1, d!), next = new Date(y!, m! - 1, d! + 1)
      movement(new Date(start.getTime() - 1).toISOString())
      movement(start.toISOString())
      movement(new Date(next.getTime() - 1).toISOString())
      movement(next.toISOString())
      check(2000000, 20000, day(start))
      if (zone === 'America/New_York') expect(next.getTime() - start.getTime()).toBe((m === 3 ? 23 : 25) * 3600000)
      if (zone === 'Africa/Cairo') expect(next.getTime() - start.getTime()).toBe((m === 4 ? 23 : 25) * 3600000)
    }
  })
})
