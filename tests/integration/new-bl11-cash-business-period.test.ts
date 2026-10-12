import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { reconcileDatabase } from '@main/db/reconciliation'
import {
  createAccount,
  listTransactions,
  accountBalance,
  listAccounts,
  adjustAccountBalance
} from '@main/services/finance/cash.service'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { createExpense } from '@main/services/finance/expenses.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { businessDate, businessDayBounds } from '@shared/business-date'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { moneyFromMajor as m } from '@shared/money/money'
let env: TestEnv
let priorTz: string | undefined
const raw = () => getRawConnection()
// Seed legitimate historical representations directly. Projection posting is
// now constrained to its source owner; temporal reader assertions are unchanged.
function seedCash(input: { accountId: number; direction: string; amountMinor: number; kind: string; occurredAt: string }): number {
  return Number(raw().prepare(`INSERT INTO cash_transactions
    (account_id, direction, amount_minor, kind, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(input.accountId, input.direction, input.amountMinor,
    input.kind, input.occurredAt, new Date().toISOString()).lastInsertRowid)
}
function snapshot() {
  const tables = raw()
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as { name: string }[]
  return Object.fromEntries(
    tables.map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
  )
}
function fixture(day = '2026-10-01') {
  const account = createAccount(
    { name: 'Mixed cash', kind: 'cash', openingBalanceMinor: m(100) },
    env.ctx
  )
  const b = businessDayBounds(day)
  const start = new Date(b.from).getTime()
  const end = new Date(b.to).getTime()
  const data: [string, number][] = [
    [businessDate(new Date(start - 1)), 10],
    [day, 20],
    [businessDate(new Date(end + 1)), 40],
    [new Date(start - 1).toISOString(), 1],
    [b.from, 2],
    [new Date(start + 30 * 60000).toISOString(), 4],
    [b.to, 8],
    [new Date(end + 1).toISOString(), 16]
  ]
  const ids = data.map(([occurredAt, amount]) =>
    seedCash({
      accountId: account,
      direction: 'in',
      amountMinor: m(amount),
      kind: 'test_receipt',
      occurredAt
    })!
  )
  return { account, data, ids }
}
function rows(account: number, from?: string, to?: string) {
  return listTransactions({ accountId: account, from, to }, { limit: 100 }).items
}
function verify(day: string) {
  const f = fixture(day)
  const before = snapshot()
  const b = businessDayBounds(day)
  const prev = businessDate(new Date(new Date(b.from).getTime() - 1))
  const next = businessDate(new Date(new Date(b.to).getTime() + 1))
  expect(accountBalance(f.account)).toBe(m(201))
  expect(rows(f.account)).toHaveLength(8)
  expect(
    rows(f.account, day, day)
      .map((r) => r.id)
      .sort((a, b) => a - b)
  ).toEqual([f.ids[1], f.ids[4], f.ids[5], f.ids[6]].sort((a, b) => a - b))
  expect(rows(f.account, prev, prev).reduce((s, r) => s + r.amountMinor, 0)).toBe(m(11))
  expect(rows(f.account, next, next).reduce((s, r) => s + r.amountMinor, 0)).toBe(m(56))
  expect(accountBalance(f.account, day)).toBe(m(145))
  expect(accountBalance(f.account, day + 'T12:00:00.000Z')).toBe(m(145))
  expect(
    dashboardSummary(
      {
        date: day,
        year: Number(day.slice(0, 4)),
        month: Number(day.slice(5, 7)),
        currentDay: false
      },
      env.ctx.session
    ).financialAlerts?.cashBalanceMinor
  ).toBe(m(145))
  expect(listAccounts({ asOf: day }).find((a) => a.id === f.account)).toMatchObject({
    balanceMinor: m(145),
    currentBalanceMinor: m(201),
    transactionCount: 8
  })
  expect(rows(f.account, prev, next)).toHaveLength(8)
  expect(rows(f.account, day, next).reduce((s, r) => s + r.amountMinor, 0)).toBe(m(90))
  expect(
    rows(f.account, day.slice(0, 7) + '-01', day.slice(0, 7) + '-31').map((r) => r.id)
  ).not.toContain(f.ids[0])
  expect(snapshot()).toEqual(before)
  expect(reconcileDatabase(raw()).errorCount).toBe(0)
}
beforeEach(() => {
  priorTz = process.env.TZ
  env = setupTestDatabase()
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  try {
    expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(raw().pragma('foreign_key_check')).toEqual([])
  } finally {
    env.cleanup()
    if (priorTz === undefined) delete process.env.TZ
    else process.env.TZ = priorTz
  }
})
describe('NEW-BL-11 cash business-period mixed temporal representations', () => {
  it.each(['Africa/Tripoli', 'America/New_York'])(
    'mixed day/range/month/as-of and current balance in %s',
    (zone) => {
      process.env.TZ = zone
      vi.setSystemTime(new Date('2026-09-30T22:30:00.000Z'))
      verify('2026-10-01')
    }
  )
  it.each(['Africa/Tripoli', 'America/New_York'])('mixed year boundary in %s', (zone) => {
    process.env.TZ = zone
    vi.setSystemTime(new Date('2026-12-31T22:30:00.000Z'))
    verify('2027-01-01')
  })
  it('date-only row is included only on its business day even in UTC', () => {
    process.env.TZ = 'UTC'
    const id = createAccount({ name: 'Date-only', kind: 'cash' }, env.ctx)
    seedCash({
      accountId: id,
      direction: 'in',
      amountMinor: m(73),
      kind: 'test_receipt',
      occurredAt: '2026-10-01'
    })
    expect(accountBalance(id)).toBe(m(73))
    expect(rows(id)).toHaveLength(1)
    expect(rows(id, '2026-10-01', '2026-10-01')).toHaveLength(1)
    expect(rows(id, '2026-09-30', '2026-09-30')).toEqual([])
    expect(rows(id, '2026-10-02', '2026-10-02')).toEqual([])
  })
  it('preserves explicit instant range boundaries while classifying date-only rows by local day', () => {
    process.env.TZ = 'Africa/Tripoli'
    const f = fixture()
    const b = businessDayBounds('2026-10-01')
    expect(
      rows(f.account, b.from, b.to)
        .map((r) => r.id)
        .sort((a, b) => a - b)
    ).toEqual([f.ids[1], f.ids[4], f.ids[5], f.ids[6]].sort((a, b) => a - b))
  })
  it.each(['Africa/Tripoli', 'America/New_York'])(
    'real expense business date and adjustment UTC instant writers in %s',
    (zone) => {
      process.env.TZ = zone
      const instant =
        zone === 'Africa/Tripoli' ? '2026-09-30T22:30:00.000Z' : '2026-10-02T02:30:00.000Z'
      vi.setSystemTime(new Date(instant))
      const account = createAccount(
        { name: 'Actual writers', kind: 'cash', openingBalanceMinor: m(1000) },
        env.ctx
      )
      createExpense(
        {
          description: 'Local expense',
          amountMinor: m(300),
          spentAt: '2026-10-01',
          cashAccountId: account,
          kind: 'variable'
        },
        env.ctx
      )
      adjustAccountBalance(
        { accountId: account, desiredBalanceMinor: m(750), reason: 'Cash count' },
        env.ctx
      )
      const before = snapshot()
      expect(rows(account, '2026-10-01', '2026-10-01')).toHaveLength(2)
      expect(
        rows(account)
          .map((r) => r.occurredAt)
          .sort()
      ).toEqual(['2026-10-01', instant].sort())
      expect(accountBalance(account, '2026-10-01')).toBe(m(750))
      expect(accountBalance(account, '2026-09-30')).toBe(m(1000))
      expect(snapshot()).toEqual(before)
      expect(reconcileDatabase(raw()).errorCount).toBe(0)
    }
  )
  it('registered cash history/accounts IPC preserves permissions and mixed-period results', async () => {
    process.env.TZ = 'America/New_York'
    vi.setSystemTime(new Date('2026-10-02T02:30:00.000Z'))
    const f = fixture()
    const electron = await import('electron')
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, args: unknown) => Promise<unknown>
    >()
    const spy = vi
      .spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((ch: string, h: never) => handlers.set(ch, h)) as never)
    try {
      const router = await import('@main/ipc/router')
      router.registerIpcRouter()
    } finally {
      spy.mockRestore()
    }
    const role = createRole({ name: 'No cash', permissions: [] }, env.ctx)
    createUser(
      { username: 'no-cash', password: 'secret123', fullName: 'Restricted', roleId: role },
      env.ctx
    )
    login('no-cash', 'secret123', 92)
    const invoke = (ch: string, args: unknown, window = 1) =>
      handlers.get(ch)!({ sender: { id: window } } as IpcMainInvokeEvent, args)
    const before = snapshot()
    for (const [ch, args] of [
      [C.cash.transactions, { accountId: f.account, from: '2026-10-01', to: '2026-10-01' }],
      [C.cash.accounts, { asOf: '2026-10-01' }],
      [C.dashboard.summary, { date: '2026-10-01', year: 2026, month: 10, currentDay: false }]
    ] as const) {
      expect(await invoke(ch, args, 92)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    const journal = (await invoke(C.cash.transactions, {
      accountId: f.account,
      from: '2026-10-01',
      to: '2026-10-01'
    })) as { ok: boolean; data: { items: unknown[] } }
    expect(journal.ok).toBe(true)
    expect(journal.data.items).toHaveLength(4)
    const accounts = (await invoke(C.cash.accounts, { asOf: '2026-10-01' })) as {
      ok: boolean
      data: { id: number; balanceMinor: number }[]
    }
    expect(accounts.ok).toBe(true)
    expect(accounts.data.find((a) => a.id === f.account)?.balanceMinor).toBe(m(145))
    const dashboard = (await invoke(C.dashboard.summary, {
      date: '2026-10-01',
      year: 2026,
      month: 10,
      currentDay: false
    })) as { ok: boolean; data: { financialAlerts: { cashBalanceMinor: number } } }
    expect(dashboard.ok).toBe(true)
    expect(dashboard.data.financialAlerts.cashBalanceMinor).toBe(m(145))
    expect(snapshot()).toEqual(before)
  })
})
