import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { getRawConnection } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { buildReport } from '@main/services/reports/reports.service'
import { formatMoney, money } from '@shared/money/money'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { seedDb10Fixture, type Db10Fixture } from '../helpers/db10-fixtures'

const captured = vi.hoisted(() => ({ html: [] as string[] }))
vi.mock('@main/services/documents/print.service', async (original) => ({
  ...(await original<typeof import('@main/services/documents/print.service')>()),
  exportPdf: vi.fn(async (html: string) => { captured.html.push(html); return { path: 'report.pdf' } }),
  printHtml: vi.fn(async (html: string) => { captured.html.push(html) })
}))

let env: TestEnv
let fixture: Db10Fixture
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 91_000
let owner: IpcMainInvokeEvent

beforeAll(async () => {
  env = setupTestDatabase()
  fixture = seedDb10Fixture(1_200)
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
  login('owner', 'secret123', ++windowId)
  owner = { sender: { id: windowId } } as IpcMainInvokeEvent
}, 120_000)
afterAll(() => env.cleanup())

function user(permissions: string[]): IpcMainInvokeEvent {
  windowId += 1
  const roleId = createRole({ name: `db10-${windowId}`, permissions }, env.ctx)
  createUser({ username: `db10-${windowId}`, password: 'secret123', fullName: `DB10 ${windowId}`, roleId }, env.ctx)
  login(`db10-${windowId}`, 'secret123', windowId)
  return { sender: { id: windowId } } as IpcMainInvokeEvent
}

function call(channel: string, request: unknown, event = owner) {
  return handlers.get(channel)!(event, request)
}

type Page = { items: Array<Record<string, unknown>>; nextCursor: string | null; hasMore: boolean; summary?: Record<string, number> }

const PAGED: Array<{ channel: string; request: Record<string, unknown>; permission: string }> = [
  { channel: C.orders.list, request: {}, permission: P.orders.view },
  { channel: C.quotations.list, request: {}, permission: P.quotations.view },
  { channel: C.purchases.list, request: {}, permission: P.purchases.view },
  { channel: C.expenses.list, request: {}, permission: P.expenses.view },
  { channel: C.production.listReleases, request: {}, permission: P.releases.view },
  { channel: C.production.listDeliveries, request: {}, permission: P.deliveries.view },
  { channel: C.production.listWorkSheets, request: {}, permission: P.worksheets.view },
  { channel: C.production.listOperationalWorkSheets, request: {}, permission: P.worksheets.view },
  { channel: C.production.finishedGoodsMovements, request: {}, permission: P.products.view },
  { channel: C.finalInvoices.list, request: {}, permission: P.finalInvoices.view },
  { channel: C.uncollectedProducts.list, request: {}, permission: P.uncollectedProducts.view },
  { channel: C.customers.list, request: {}, permission: P.customers.view },
  { channel: C.customers.balances, request: {}, permission: P.customers.view },
  { channel: C.cash.transactions, request: {}, permission: P.cash.view },
  { channel: C.inventory.movements, request: {}, permission: P.inventory.view },
  { channel: C.inventory.remainders, request: {}, permission: P.inventory.view },
  { channel: C.employees.listDeductions, request: {}, permission: P.employees.finance },
  { channel: C.employees.listAdvances, request: {}, permission: P.employees.finance },
  { channel: C.employees.listSalaryPayments, request: {}, permission: P.employees.finance },
  { channel: C.profit.withdrawals, request: {}, permission: P.withdrawals.view },
  { channel: C.admin.audit, request: {}, permission: P.audit.view },
  { channel: C.workers.statement, request: { id: 1 }, permission: P.workers.finance },
  { channel: C.employees.statement, request: { id: 1 }, permission: P.employees.finance }
]

describe('DB-10 IPC page bounds cannot be bypassed', () => {
  it.each(PAGED)('$channel rejects unbounded, malformed and oversized requests', async ({ channel, request }) => {
    const ok = await call(channel, { ...request, limit: 1 })
    expect(ok.ok).toBe(true)
    for (const invalid of [
      { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: 1_000_000 }, { limit: Number.MAX_SAFE_INTEGER + 1 }, { limit: '10' },
      { cursor: '' }, { cursor: 'x'.repeat(513) }, { cursor: 'not base64!' }, { cursor: Buffer.from('[1,"n","fp",1]').toString('base64url') }
    ]) {
      const result = await call(channel, { ...request, ...invalid })
      expect(result.ok, `${channel} ${JSON.stringify(invalid).slice(0, 60)}`).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_ERROR')
    }
  })

  it.each(PAGED)('$channel with no limit returns at most the server maximum', async ({ channel, request }) => {
    const result = await call(channel, request)
    expect(result.ok).toBe(true)
    const data = result.ok ? result.data as Page & { transactions?: Page } : undefined
    const page = data?.transactions ?? data!
    expect(page.items.length).toBeLessThanOrEqual(100)
  })

  it.each(PAGED)('$channel refuses unauthenticated and unauthorised callers', async ({ channel, request, permission }) => {
    const anonymous = await call(channel, request, { sender: { id: 999_999 } } as IpcMainInvokeEvent)
    expect(anonymous).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
    const other = user(permission === P.audit.view ? [P.orders.view] : [P.audit.view])
    const forbidden = await call(channel, request, other)
    expect(forbidden).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('rejects oversized search/filter payloads and statement section abuse', async () => {
    for (const [channel, request] of [
      [C.orders.list, { search: 'x'.repeat(201) }],
      [C.expenses.list, { from: 'x'.repeat(40) }],
      [C.admin.audit, { action: 'x'.repeat(201) }],
      [C.customers.statement, { id: fixture.bigCustomerId, sections: ['orders', 'payments', 'orders', 'payments', 'orders'] }],
      [C.customers.statement, { id: fixture.bigCustomerId, orders: { limit: 101 } }]
    ] as const) {
      const result = await call(channel, request)
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    }
  })

  it('a cursor from one filter set cannot page another, and a stale cursor after reopening fails closed', async () => {
    const first = await call(C.expenses.list, { search: 'مصروف', limit: 5 }) as { ok: true; data: Page }
    const replay = await call(C.expenses.list, { search: 'عام', limit: 5, cursor: first.data.nextCursor })
    expect(replay).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    const next = await call(C.expenses.list, { search: 'مصروف', limit: 5, cursor: first.data.nextCursor }) as { ok: true; data: Page }
    expect(next.data.items).toHaveLength(5)
  })

  it('an unexpected database failure is normalized, never leaked', async () => {
    const raw = getRawConnection()
    raw.exec('ALTER TABLE expense_categories RENAME TO expense_categories_db10_hidden')
    try {
      const result = await call(C.expenses.list, {})
      expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } })
    } finally {
      raw.exec('ALTER TABLE expense_categories_db10_hidden RENAME TO expense_categories')
    }
  })
})

describe('DB-10 pages keep every field-visibility rule of the former lists', () => {
  it('omits delivery cost, movement cost, receivables and uncollected cost on every page item', async () => {
    const limited = user([P.deliveries.view, P.inventory.view, P.finalInvoices.view, P.uncollectedProducts.view])
    const deliveries = await call(C.production.listDeliveries, { limit: 100 }, limited) as { ok: true; data: Page }
    expect(deliveries.data.items.length).toBeGreaterThan(0)
    for (const row of deliveries.data.items) expect(row).not.toHaveProperty('actualCostMinor')
    const movements = await call(C.inventory.movements, { limit: 100 }, limited) as { ok: true; data: Page }
    for (const row of movements.data.items) expect(row).not.toHaveProperty('actualCostMinor')
    const invoices = await call(C.finalInvoices.list, { limit: 100 }, limited) as { ok: true; data: Page }
    expect(invoices.data.summary).toEqual({ totalCount: expect.any(Number) })
    for (const row of invoices.data.items) {
      expect(row).not.toHaveProperty('remainingMinor')
      expect(row).not.toHaveProperty('paidMinor')
    }
    const withCost = await call(C.production.listDeliveries, { limit: 1 }) as { ok: true; data: Page }
    expect(withCost.data.items[0]).toHaveProperty('actualCostMinor')
  })

  it('statement sections a session may not view stay empty on every page', async () => {
    const limited = user([P.customers.view])
    const statement = await call(C.customers.statement, { id: fixture.bigCustomerId }, limited) as { ok: true; data: Record<string, Page> }
    expect(statement.data.orders!.items.length).toBeGreaterThan(0)
    expect(statement.data.preliminaryInvoices).toMatchObject({ items: [], nextCursor: null })
    expect(statement.data.approvedInvoices).toMatchObject({ items: [], nextCursor: null })
    const section = await call(C.customers.statement, { id: fixture.bigCustomerId, sections: ['approvedInvoices'], limit: 5 }, limited) as { ok: true; data: Record<string, Page> }
    expect(section.data.approvedInvoices).toMatchObject({ items: [] })
    expect(await call(C.customers.statement, { id: 999_999 })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('the alert feed is bounded while counts cover every active alert', async () => {
    const result = await call(C.notifications.list, {}) as { ok: true; data: { items: unknown[]; unreadCount: number; totalCount: number } }
    const open = (getRawConnection().prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'confirmed' AND archived_at IS NULL").get() as { c: number }).c
    expect(result.data.items).toHaveLength(100)
    expect(result.data.totalCount).toBeGreaterThanOrEqual(open)
    expect(result.data.unreadCount).toBe(result.data.totalCount)
  })
})

describe('DB-10 reports and prints keep complete requested-dataset semantics', () => {
  function bodyRows(html: string): number {
    return (html.split('<tbody>')[1]!.split('</tbody>')[0]!.match(/<tr>/g) ?? []).length
  }

  it.each([
    { key: 'orders', table: "SELECT COUNT(*) AS c FROM orders WHERE date(created_at) BETWEEN '1900-01-01' AND '2999-12-31'" },
    { key: 'sales', table: "SELECT COUNT(*) AS c FROM orders WHERE status != 'cancelled'" },
    { key: 'expenses', table: 'SELECT COUNT(*) AS c FROM expenses WHERE reversed_at IS NULL' },
    { key: 'purchases', table: 'SELECT COUNT(*) AS c FROM purchases' },
    { key: 'order_profitability', table: "SELECT COUNT(*) AS c FROM orders WHERE status != 'cancelled' AND completed_at IS NOT NULL" }
  ])('$key: the report view, print and PDF contain every row though the UI list shows one page', async ({ key, table }) => {
    const expected = (getRawConnection().prepare(table).get() as { c: number }).c
    expect(expected).toBeGreaterThan(100)
    const listChannel = key === 'expenses' ? C.expenses.list : key === 'purchases' ? C.purchases.list : C.orders.list
    const uiPage = await call(listChannel, key === 'orders' || key === 'sales' || key === 'order_profitability' ? { includeArchived: true } : {}) as { ok: true; data: Page }
    expect(uiPage.data.items.length).toBeLessThanOrEqual(50)

    const view = await call(C.reports.build, { key }) as { ok: true; data: { rows: unknown[]; totals: Record<string, string> } }
    expect(view.data.rows).toHaveLength(expected)
    expect(view.data).toEqual(buildReport({ key } as never))

    captured.html = []
    expect((await call(C.documents.printReport, { key })).ok).toBe(true)
    expect((await call(C.documents.exportReportPdf, { key })).ok).toBe(true)
    expect(captured.html).toHaveLength(2)
    for (const html of captured.html) {
      expect(bodyRows(html)).toBe(expected)
      for (const total of Object.values(view.data.totals)) expect(html).toContain(total)
    }
  })

  it('report totals are exact sums over the complete dataset, not the first page', () => {
    const report = buildReport({ key: 'expenses' })
    const exact = (getRawConnection().prepare('SELECT SUM(amount_minor) AS t FROM expenses WHERE reversed_at IS NULL').get() as { t: number }).t
    const firstPage = (getRawConnection().prepare('SELECT SUM(amount_minor) AS t FROM (SELECT amount_minor FROM expenses WHERE reversed_at IS NULL ORDER BY id DESC LIMIT 50)').get() as { t: number }).t
    expect(exact).not.toBe(firstPage)
    const shown = Object.values(report.totals!)[0]!
    expect(shown).toBe(formatMoney(money(exact)))
  })
})
