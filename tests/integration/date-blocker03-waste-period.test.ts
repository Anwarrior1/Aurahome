import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import { buildReport } from '@main/services/reports/reports.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { availableQty, receiveStock, recordWaste } from '@main/services/inventory/inventory.service'
import { formatMoney, money } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { formatQuantity, quantity } from '@shared/quantity/quantity'
import { businessDate } from '@shared/business-date'

// Run unchanged in separate processes: TZ must be set before Node/SQLite starts.
const zone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
const day = (at: Date) => businessDate(at)
const space = (at: Date) => at.toISOString().replace('T', ' ').replace('.000Z', '')
let env: TestEnv
let material: number
let entries: Array<{ id: number; at: string; qty: number; cost: number; reason: string }>
beforeEach(() => {
  env = setupTestDatabase()
  entries = []
  const categoryId = createCategory({ name: 'Historical boards' }, env.ctx)
  material = createMaterial({ sku: 'HIST-WASTE', name: 'Board', categoryId, unit: 'sheet', pricingRule: 'exact', currentMarketPriceMicro: unitCostFromMajor(10) }, env.ctx)
})
afterEach(() => env.cleanup())
function movement(at: string, kind = 'waste', qty = 1000000, cost = 10000) {
  const reason = `event-${entries.length}`
  const id = Number(getRawConnection().prepare('INSERT INTO inventory_movements (material_id, kind, qty_micro, actual_cost_minor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(material, kind, qty, cost, reason, at).lastInsertRowid)
  entries.push({ id, at, qty, cost, reason })
  return id
}
function check(ids: number[], from = '2024-02-29', to = from) {
  const expected = entries.filter(e => ids.includes(e.id)).sort((a, b) => b.id - a.id)
  const report = buildReport({ key: 'waste', from, to })
  expect(report.totals).toEqual({ 'إجمالي خسائر الهالك': formatMoney(money(expected.reduce((sum, e) => sum + e.cost, 0))) })
  expect(report.rows).toEqual(expected.map(e => ({ التاريخ: day(new Date(e.at)), المادة: 'Board', الكمية: formatQuantity(quantity(e.qty), 'sheet'), التكلفة: formatMoney(money(e.cost)), السبب: e.reason })))
}
describe(`waste historical periods (${zone})`, () => {
  it('verifies JavaScript and native SQLite local timezone agree', () => {
    const at = '2024-02-29T23:30:00Z'
    expect(getRawConnection().prepare("SELECT date(?, 'localtime') AS day").get(at)).toEqual({ day: day(new Date(at)) })
    if (zone === 'Africa/Tripoli' || zone === 'Africa/Cairo') expect(day(new Date(at))).toBe('2024-03-01')
    if (zone === 'UTC' || zone === 'America/New_York') expect(day(new Date(at))).toBe('2024-02-29')
  })
  it('late space/canonical equivalents reproduce 50 versus old 60 LYD', () => {
    const inside = Array.from({ length: 5 }, () => movement(new Date(2024, 1, 29, 12).toISOString()))
    const late = [movement('2024-02-29 23:30:00'), movement('2024-02-29T23:30:00.000Z')]
    check(day(new Date('2024-02-29T23:30:00Z')) === '2024-02-29' ? [...inside, ...late] : inside)
  })
  it('early retained space events are not lost at the lexical lower bound', () => {
    check([movement('2024-02-29 08:00:00'), movement('2024-02-29T08:00:00.000Z')])
  })
  it('date-only history retains its literal business date in every offset', () => {
    const id = movement('2024-02-29')
    movement('2024-03-01', 'waste', 2000000, 20000)
    check([id])
  })
  it('canonical UTC crossover belongs to the factory-local calendar', () => {
    const at = '2024-02-28T22:30:00.000Z'
    check([movement(at)], day(new Date(at)))
  })
  it('numeric-offset representations agree with their UTC equivalent', () => {
    const ids = ['2024-02-29T23:30:00+02:00', '2024-02-29T21:30:00Z', '2024-03-01T11:30:00+14:00', '2024-02-29T07:30:00-14:00'].map(at => movement(at))
    check(ids, day(new Date('2024-02-29T21:30:00Z')))
  })
  it('uses inclusive start and exclusive next midnight at seconds and milliseconds', () => {
    const start = new Date(2024, 1, 29).getTime(), next = new Date(2024, 2, 1).getTime()
    const inside: number[] = []
    for (const t of [start - 1000, start, start + 1000, next - 1000, next, next + 1000]) {
      for (const at of [new Date(t).toISOString(), space(new Date(t)), new Date(t).toISOString().replace('.000Z', 'Z')]) {
        const id = movement(at)
        if (t >= start && t < next) inside.push(id)
      }
    }
    for (const t of [start - 1, start + 1, next - 1, next + 1]) {
      const id = movement(new Date(t).toISOString())
      if (t >= start && t < next) inside.push(id)
    }
    check(inside)
    expect(inside).toHaveLength(11)
  })
  it('keeps waste quantities and loss costs verbatim and excludes other movement kinds', () => {
    const at = new Date(2024, 1, 29, 12).toISOString()
    const ids = [movement(at, 'waste', 3000000, 30000), movement(at, 'waste', 2000000, 20000)]
    for (const kind of ['consumption', 'consumption_reversal', 'sale', 'material_return', 'material_return_reversal', 'adjustment_out', 'purchase']) movement(at, kind, 9000000, 90000)
    check(ids)
  })
  it('rejects unsupported shapes as report members and preserves literal guards', () => {
    for (const at of ['2024-02-29nonsense', '2024-02-29Tgarbage', '2024-02-30', '2024-02-29X00:00:00', '', 'now', '2451545.0']) movement(at)
    check([])
    expect(() => movement('CURRENT_TIMESTAMP')).toThrow(/invalid literal timestamp/)
  })
  it('preserves unfiltered valid history, descending identities and whole-state read purity', () => {
    const ids = [movement('2024-02-29'), movement('2024-02-29 23:30:00'), movement('2024-02-29T23:30:00Z')]
    const raw = getRawConnection()
    const snapshot = () => JSON.stringify((raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
    const before = snapshot()
    const first = buildReport({ key: 'waste' })
    expect(first).toEqual(buildReport({ key: 'waste' }))
    expect(first.rows.map(r => r.السبب)).toEqual([...ids].reverse().map(id => entries.find(e => e.id === id)!.reason))
    expect(first.totals).toEqual({ 'إجمالي خسائر الهالك': formatMoney(money(30000)) })
    expect(snapshot()).toBe(before)
  })
  it('respects timezone-database 23/25-hour days using successive local midnights', () => {
    const dates = zone === 'America/New_York' ? [[2026, 3, 8], [2026, 11, 1]] : [[2026, 4, 24], [2026, 10, 29]]
    for (const [y, m, d] of dates) {
      const start = new Date(y!, m! - 1, d!), next = new Date(y!, m! - 1, d! + 1)
      movement(new Date(start.getTime() - 1).toISOString())
      const ids = [movement(start.toISOString()), movement(new Date(next.getTime() - 1).toISOString())]
      movement(next.toISOString())
      check(ids, day(start))
      if (zone === 'America/New_York') expect(next.getTime() - start.getTime()).toBe((m === 3 ? 23 : 25) * 3600000)
      if (zone === 'Africa/Cairo') expect(next.getTime() - start.getTime()).toBe((m === 4 ? 23 : 25) * 3600000)
    }
  })
  it('continues to report a real owner-created FIFO waste without changing its source', () => {
    receiveStock({ materialId: material, qtyMicro: 10000000, unitCost: unitCostFromMajor(100), sourceKind: 'opening', ctx: env.ctx })
    const waste = recordWaste({ materialId: material, qtyMicro: 2000000, reason: 'Broken', ctx: env.ctx })
    expect(availableQty(material)).toBe(8000000)
    const raw = getRawConnection()
    const source = raw.prepare('SELECT * FROM inventory_movements WHERE id=?').get(waste.movementId) as { created_at: string }
    expect(source.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    const report = buildReport({ key: 'waste', from: day(new Date(source.created_at)), to: day(new Date(source.created_at)) })
    expect(report.rows).toEqual([{ التاريخ: day(new Date(source.created_at)), المادة: 'Board', الكمية: formatQuantity(quantity(2000000), 'sheet'), التكلفة: formatMoney(waste.costMinor), السبب: 'Broken' }])
    expect(report.totals).toEqual({ 'إجمالي خسائر الهالك': formatMoney(money(200000)) })
    expect(raw.prepare('SELECT * FROM inventory_movements WHERE id=?').get(waste.movementId)).toEqual(source)
  })
})
