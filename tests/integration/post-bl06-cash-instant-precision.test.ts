import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { reconcileDatabase } from '@main/db/reconciliation'
import * as cash from '@main/services/finance/cash.service'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { businessDate, businessDayBounds } from '@shared/business-date'
import { moneyFromMajor as m } from '@shared/money/money'
import { IPC_CHANNELS as C } from '@shared/constants/channels'

let env: TestEnv
let previousTz: string | undefined
const raw = () => getRawConnection()
const zones = ['Africa/Tripoli', 'America/New_York', 'Asia/Kathmandu']
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
function accounts(opening = 1000) {
  const source = cash.createAccount(
    { name: 'Source', kind: 'cash', openingBalanceMinor: m(opening) },
    env.ctx
  )
  const destination = cash.createAccount({ name: 'Destination', kind: 'cash' }, env.ctx)
  return { source, destination }
}
function transfer(source: number, destination: number, amount: number, occurredAt: string) {
  cash.transfer(
    { fromAccountId: source, toAccountId: destination, amountMinor: m(amount), occurredAt },
    env.ctx
  )
  return cash.listTransactions({ accountId: destination }).items[0]!.id
}
function rows(accountId: number, from?: string, to?: string) {
  return cash.listTransactions({ accountId, from, to }, { limit: 100 }).items
}
function ids(accountId: number, from?: string, to?: string) {
  return rows(accountId, from, to)
    .map((row) => row.id)
    .sort((a, b) => a - b)
}
function dashboard(day: string) {
  return dashboardSummary(
    { date: day, year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)), currentDay: false },
    env.ctx.session
  ).financialAlerts?.cashBalanceMinor
}
function seconds(iso: string) {
  return iso.replace('.000Z', 'Z')
}
function offset(iso: string) {
  return new Date(new Date(iso).getTime() + 345 * 60000).toISOString().replace('Z', '+05:45')
}
beforeEach(() => {
  previousTz = process.env.TZ
  env = setupTestDatabase()
})
afterEach(() => {
  try {
    expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(raw().pragma('foreign_key_check')).toEqual([])
  } finally {
    env.cleanup()
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

describe('POST-BL-06 cash instant precision', () => {
  it('fresh migrated fixture reconciles without any timestamp repair', () => {
    expect(reconcileDatabase(raw()).findings).toEqual([])
  })
  it.each(zones)(
    'primary 300 seconds / 50 milliseconds fixture, all readers and pure Dashboard in %s',
    (zone) => {
      process.env.TZ = zone
      const { source, destination } = accounts()
      const day = '2026-10-01'
      const b = businessDayBounds(day)
      const at = new Date(new Date(b.to).getTime() - 999).toISOString()
      const sec = seconds(at)
      expect(new Date(sec).getTime()).toBe(new Date(at).getTime())
      expect(businessDate(new Date(sec))).toBe(day)
      const first = transfer(source, destination, 300, sec)
      const second = transfer(source, destination, 50, at)
      const before = snapshot()
      expect(ids(destination, day, day)).toEqual([first, second])
      expect(rows(destination, day, day).map((row) => row.amountMinor)).toEqual([m(50), m(300)])
      expect([cash.accountBalance(source), cash.accountBalance(destination)]).toEqual([
        m(650),
        m(350)
      ])
      expect([cash.accountBalance(source, day), cash.accountBalance(destination, day)]).toEqual([
        m(650),
        m(350)
      ])
      const list = cash.listAccounts({ asOf: day })
      expect(list.find((a) => a.id === source)).toMatchObject({
        balanceMinor: m(650),
        currentBalanceMinor: m(650),
        transactionCount: 2
      })
      expect(list.find((a) => a.id === destination)).toMatchObject({
        balanceMinor: m(350),
        currentBalanceMinor: m(350),
        transactionCount: 2
      })
      expect(ids(destination, '2026-09-30', '2026-09-30')).toEqual([])
      expect(ids(destination, '2026-10-02', '2026-10-02')).toEqual([])
      expect(dashboard(day)).toBe(m(1000))
      expect(snapshot()).toEqual(before)
      // A standalone inflow makes the Dashboard total sensitive to omission;
      // paired transfer omissions alone would cancel in the aggregate.
      cash.adjustAccountBalance(
        {
          accountId: destination,
          desiredBalanceMinor: m(375),
          reason: 'Historical dashboard control',
          occurredAt: sec
        },
        env.ctx
      )
      const afterWrite = snapshot()
      expect(dashboard(day)).toBe(m(1025))
      expect(cash.accountBalance(destination, day)).toBe(m(375))
      expect(snapshot()).toEqual(afterWrite)
      expect(reconcileDatabase(raw()).findings).toEqual([])
    }
  )

  const days = zones.flatMap((zone) =>
    ['2026-10-01', '2027-01-01'].map((day) => ({ zone, day, hours: 24 }))
  )
  days.push(
    { zone: 'America/New_York', day: '2026-03-08', hours: 23 },
    { zone: 'America/New_York', day: '2026-11-01', hours: 25 }
  )
  it.each(days)(
    'mixed boundary matrix, range, month/year and DST $day in $zone ($hours hours)',
    ({ zone, day, hours }) => {
      process.env.TZ = zone
      const { source, destination } = accounts(10000)
      const b = businessDayBounds(day)
      const start = new Date(b.from).getTime()
      const next = new Date(b.to).getTime() + 1
      expect((next - start) / 3600000).toBe(hours)
      const priorDay = businessDate(new Date(start - 1))
      const nextDay = businessDate(new Date(next))
      const finalSecond = new Date(next - 1000).toISOString()
      const data = [
        new Date(start - 1).toISOString(),
        priorDay,
        seconds(b.from),
        b.from,
        seconds(new Date(start + 1000).toISOString()),
        new Date(start + (next - start) / 2).toISOString(),
        seconds(finalSecond),
        finalSecond,
        b.to,
        seconds(new Date(next).toISOString()),
        new Date(next).toISOString(),
        day,
        nextDay
      ]
      const inserted = data.map((at, index) => transfer(source, destination, 2 ** index, at))
      const before = snapshot()
      const dayIds = [2, 3, 4, 5, 6, 7, 8, 11].map((i) => inserted[i]!).sort((a, b) => a - b)
      expect(ids(destination, day, day)).toEqual(dayIds)
      expect(ids(destination, priorDay, priorDay)).toEqual([inserted[0], inserted[1]])
      expect(ids(destination, nextDay, nextDay)).toEqual([inserted[9], inserted[10], inserted[12]])
      expect(rows(destination, day, day).reduce((sum, row) => sum + row.amountMinor, 0)).toBe(
        m(2556)
      )
      expect(cash.accountBalance(destination, day)).toBe(m(2559))
      expect(cash.accountBalance(source, day)).toBe(m(7441))
      expect(cash.accountBalance(destination)).toBe(m(8191))
      expect(cash.accountBalance(source)).toBe(m(1809))
      expect(cash.listAccounts({ asOf: day }).find((a) => a.id === destination)).toMatchObject({
        balanceMinor: m(2559),
        currentBalanceMinor: m(8191)
      })
      expect(ids(destination, priorDay, nextDay)).toEqual(inserted)
      expect(ids(destination, b.from, b.to)).toEqual(dayIds)
      if (day.endsWith('-01')) {
        const monthEnd = businessDate(new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0))
        expect(ids(destination, day, monthEnd)).toEqual(inserted.slice(2))
      }
      expect(snapshot()).toEqual(before)
      expect(reconcileDatabase(raw()).findings).toEqual([])
    }
  )

  it.each(zones)(
    'fractional precision, explicit instant inclusivity and timezone-offset equivalence in %s',
    (zone) => {
      process.env.TZ = zone
      const { source, destination } = accounts(1000)
      const b = businessDayBounds('2026-10-01')
      const next = new Date(b.to).getTime() + 1
      const startForms = [
        seconds(b.from),
        b.from,
        b.from.replace('.000Z', '.0Z'),
        b.from.replace('.000Z', '.00Z'),
        offset(b.from)
      ]
      const end = new Date(next - 1000).toISOString()
      const endForms = [seconds(end), end, end.replace('.000Z', '.0000Z'), offset(end)]
      const startIds = startForms.map((at) => transfer(source, destination, 1, at))
      const endIds = endForms.map((at) => transfer(source, destination, 2, at))
      const fractions = ['.1Z', '.12Z', '.123Z', '.1234Z', '.9999Z', '.999999999Z']
      const fractionalIds = fractions.map((fraction) =>
        transfer(source, destination, 3, end.replace('.000Z', fraction))
      )
      const future = transfer(source, destination, 4, seconds(new Date(next).toISOString()))
      const before = snapshot()
      expect(ids(destination, '2026-10-01', '2026-10-01')).toEqual([
        ...startIds,
        ...endIds,
        ...fractionalIds
      ])
      // Explicit instant upper bounds remain inclusive, unlike date-only upper bounds.
      for (const at of startForms) expect(ids(destination, at, at)).toEqual(startIds)
      for (const at of endForms) expect(ids(destination, at, at)).toEqual(endIds)
      expect(ids(destination, end, end.replace('.000Z', '.123Z'))).toEqual([
        ...endIds,
        ...fractionalIds.slice(0, 4)
      ])
      expect(
        ids(destination, new Date(next).toISOString(), seconds(new Date(next).toISOString()))
      ).toEqual([future])
      expect(cash.accountBalance(destination, '2026-10-01')).toBe(m(31))
      expect(snapshot()).toEqual(before)
      expect(reconcileDatabase(raw()).findings).toEqual([])
    }
  )

  it.each(['Africa/Tripoli', 'America/New_York'])(
    'real registered transfer/history/account IPC preserves accepted precision and authorization in %s',
    async (zone) => {
      process.env.TZ = zone
      const { source, destination } = accounts()
      const role = createRole({ name: 'Restricted POST06', permissions: [] }, env.ctx)
      createUser(
        {
          username: 'post06-restricted',
          fullName: 'Restricted',
          password: 'secret123',
          roleId: role
        },
        env.ctx
      )
      login('post06-restricted', 'secret123', 76001)
      const handlers = new Map<
        string,
        (event: IpcMainInvokeEvent, input: unknown) => Promise<IpcResult<unknown>>
      >()
      const electron = await import('electron')
      const spy = vi
        .spyOn(electron.ipcMain, 'handle')
        .mockImplementation(((channel: string, handler: never) =>
          handlers.set(channel, handler)) as never)
      try {
        (await import('@main/ipc/router')).registerIpcRouter()
      } finally {
        spy.mockRestore()
      }
      const invoke = (channel: string, input: unknown, id = 1) =>
        handlers.get(channel)!({ sender: { id } } as IpcMainInvokeEvent, input)
      const at = new Date(
        new Date(businessDayBounds('2026-10-01').to).getTime() - 999
      ).toISOString()
      const input = {
        fromAccountId: source,
        toAccountId: destination,
        amountMinor: m(300),
        occurredAt: seconds(at),
        requestKey: 'post06-seconds-transfer'
      }
      const before = snapshot()
      for (const [channel, payload] of [
        [C.cash.transfer, input],
        [C.cash.accounts, { asOf: '2026-10-01' }],
        [C.cash.transactions, { accountId: destination, from: '2026-10-01', to: '2026-10-01' }]
      ] as const) {
        expect(await invoke(channel, payload, 76001)).toMatchObject({
          ok: false,
          error: { code: 'FORBIDDEN' }
        })
        expect(snapshot()).toEqual(before)
      }
      for (const occurredAt of [null, 123, true, {}]) {
        expect(await invoke(C.cash.transfer, { ...input, occurredAt })).toMatchObject({
          ok: false,
          error: { code: 'VALIDATION_ERROR' }
        })
        expect(snapshot()).toEqual(before)
      }
      expect(await invoke(C.cash.transfer, input)).toMatchObject({ ok: true })
      expect(
        await invoke(C.cash.transfer, {
          ...input,
          amountMinor: m(50),
          occurredAt: at,
          requestKey: 'post06-milliseconds-transfer'
        })
      ).toMatchObject({ ok: true })
      const afterWrite = snapshot()
      const journal = await invoke(C.cash.transactions, {
        accountId: destination,
        from: '2026-10-01',
        to: '2026-10-01'
      })
      expect(journal).toMatchObject({
        ok: true,
        data: { items: [{ amountMinor: m(50) }, { amountMinor: m(300) }] }
      })
      const list = await invoke(C.cash.accounts, { asOf: '2026-10-01' })
      expect(list).toMatchObject({
        ok: true,
        data: expect.arrayContaining([
          expect.objectContaining({ id: source, balanceMinor: m(650) }),
          expect.objectContaining({ id: destination, balanceMinor: m(350) })
        ])
      })
      expect(snapshot()).toEqual(afterWrite)
      expect(reconcileDatabase(raw()).findings).toEqual([])
    }
  )

  it('unparseable stored instant is excluded by historical reads; existing string input contract is not broadened or narrowed', () => {
    const { source, destination } = accounts()
    // The existing service/IPC accepts arbitrary strings, not a date syntax
    // validator. This read-only fix must not invent a new write contract.
    for (const [index, value] of ['not-an-instant', 'now', '2451545.0'].entries()) {
      transfer(source, destination, 10, value)
      expect(cash.accountBalance(destination)).toBe(m((index + 1) * 10))
      const before = snapshot()
      const day = businessDate()
      expect(rows(destination, day, day)).toEqual([])
      expect(cash.accountBalance(destination, '9999-12-31')).toBe(0)
      expect(snapshot()).toEqual(before)
    }
  })

  it('records index plans and numeric temporal filtering cost on a disposable 10000-row ledger', () => {
    process.env.TZ = 'Africa/Tripoli'
    const { destination } = accounts()
    const insert = raw().prepare(
      "INSERT INTO cash_transactions(account_id,direction,amount_minor,kind,occurred_at,created_at) VALUES (?,'in',1,'manual',?,?)"
    )
    raw().transaction(() => {
      for (let i = 0; i < 10000; i++)
        insert.run(
          destination,
          i % 2 ? '2026-10-01T21:59:59Z' : '2026-10-01T21:59:59.000Z',
          new Date().toISOString()
        )
    })()
    const b = businessDayBounds('2026-10-01')
    const queries = {
      lexical:
        'SELECT SUM(amount_minor) AS total FROM cash_transactions WHERE account_id=? AND occurred_at>=? AND occurred_at<=?',
      temporal:
        'SELECT SUM(amount_minor) AS total FROM cash_transactions WHERE account_id=? AND julianday(occurred_at)>=julianday(?) AND julianday(occurred_at)<julianday(?)'
    }
    const results: Record<string, unknown> = {}
    for (const [kind, query] of Object.entries(queries)) {
      const params = [
        destination,
        b.from,
        kind === 'temporal' ? new Date(new Date(b.to).getTime() + 1).toISOString() : b.to
      ]
      const statement = raw().prepare(query)
      const plan = raw()
        .prepare('EXPLAIN QUERY PLAN ' + query)
        .all(...params)
      const start = performance.now()
      for (let i = 0; i < 20; i++) statement.get(...params)
      results[kind] = {
        plan,
        meanMs: (performance.now() - start) / 20,
        result: statement.get(...params)
      }
    }
    expect(
      raw()
        .prepare(queries.temporal)
        .get(destination, b.from, new Date(new Date(b.to).getTime() + 1).toISOString())
    ).toEqual({ total: 10000 })
    console.log('POST06_QUERY_PLAN', JSON.stringify(results))
    expect(reconcileDatabase(raw()).findings).toEqual([])
  })
})
