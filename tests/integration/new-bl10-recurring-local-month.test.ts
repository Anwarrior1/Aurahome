import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import {
  createRecurringExpense,
  deleteRecurringExpense,
  updateRecurringExpense,
  getRecurringExpense,
  materializeDueRecurringExpenses,
  scheduledRecurringOccurrences,
  expenseSummary
} from '@main/services/finance/expenses.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import {
  monthlyProfitSummary,
  cumulativeNetProfitMinor,
  availableProfitMinor
} from '@main/services/finance/profit.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { today, nowIso } from '@main/services/base/service.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { moneyFromMajor as m } from '@shared/money/money'

let env: TestEnv
let priorTz: string | undefined
const raw = () => getRawConnection()
function clock(zone = 'Africa/Tripoli', instant = '2026-09-30T22:30:00.000Z') {
  process.env.TZ = zone
  vi.setSystemTime(new Date(instant))
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
function posted(startDate: string) {
  const account = createAccount(
    { name: 'Cash', kind: 'cash', openingBalanceMinor: m(5000) },
    env.ctx
  )
  const id = createRecurringExpense(
    { description: 'Factory rent', amountMinor: m(300), startDate, cashAccountId: account },
    env.ctx
  )
  expect(materializeDueRecurringExpenses().created).toBe(1)
  return { id, account }
}
function assertOnlyDeactivation(
  before: ReturnType<typeof snapshot>,
  id: number,
  month: string,
  instant: string
) {
  const after = snapshot()
  expect(after.recurring_expenses).toEqual(
    (before.recurring_expenses as Record<string, unknown>[]).map((row) =>
      row.id === id ? { ...row, active: 0, end_date: month } : row
    )
  )
  const audit = raw()
    .prepare(
      "SELECT * FROM audit_log WHERE action='expenses.recurring.deactivate' ORDER BY id DESC LIMIT 1"
    )
    .get() as { created_at: string; details: string }
  expect(audit.created_at).toBe(instant)
  expect(JSON.parse(audit.details)).toMatchObject({
    endDate: month,
    generatedExpenseCount: 1,
    historicalRowsPreserved: true
  })
  expect(after.audit_log).toEqual([...(before.audit_log as unknown[]), audit])
  for (const table of Object.keys(before))
    if (!['recurring_expenses', 'audit_log'].includes(table))
      expect(after[table], table).toEqual(before[table])
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

describe('NEW-BL-10 recurring deactivation follows the factory-local month', () => {
  it.each([
    ['Africa/Tripoli', '2026-09-30T22:30:00.000Z', '2026-10-01', '2026-10-01'],
    ['Africa/Tripoli', '2026-10-15T10:00:00.000Z', '2026-10-15', '2026-10-01'],
    ['Africa/Tripoli', '2026-12-31T22:30:00.000Z', '2027-01-01', '2027-01-01'],
    ['America/New_York', '2026-10-01T00:30:00.000Z', '2026-09-30', '2026-09-01']
  ])('direct service: %s at %s ends in local %s month', (zone, instant, localDate, month) => {
    clock(zone, instant)
    expect(today()).toBe(localDate)
    expect(nowIso()).toBe(instant)
    const f = posted(month)
    const before = snapshot()
    const cash = accountBalance(f.account)
    expect(deleteRecurringExpense(f.id, env.ctx)).toEqual({ deleted: false, deactivated: true })
    expect(getRecurringExpense(f.id).template).toMatchObject({
      active: false,
      endDate: month,
      startDate: month,
      createdAt: instant
    })
    assertOnlyDeactivation(before, f.id, month, instant)
    expect(accountBalance(f.account)).toBe(cash)
    const ended = snapshot()
    expect(deleteRecurringExpense(f.id, env.ctx)).toEqual({ deleted: false, deactivated: true })
    expect(snapshot()).toEqual(ended)
  })
  it('preserves an earlier explicit end month and explicit month normalization without UTC shifts', () => {
    clock('Africa/Tripoli', '2026-09-15T10:00:00.000Z')
    const f = posted('2026-09-01')
    clock()
    updateRecurringExpense(f.id, { endDate: '2026-09-17' }, env.ctx)
    deleteRecurringExpense(f.id, env.ctx)
    expect(getRecurringExpense(f.id).template.endDate).toBe('2026-09-01')
  })
  it('keeps history/profit/cash and supports reactivation with the existing inclusive end-month rule', () => {
    clock('Africa/Tripoli', '2026-09-15T10:00:00.000Z')
    const f = posted('2026-09-01')
    clock()
    const before = snapshot()
    const cash = accountBalance(f.account)
    deleteRecurringExpense(f.id, env.ctx)
    assertOnlyDeactivation(before, f.id, '2026-10-01', '2026-09-30T22:30:00.000Z')
    expect(scheduledRecurringOccurrences('2026-09-01', '2026-11-30')).toEqual([])
    expect(materializeDueRecurringExpenses()).toEqual({ created: 0 })
    expect(accountBalance(f.account)).toBe(cash)
    expect(monthlyProfitSummary(2026, 9).netProfitMinor).toBe(-m(300))
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(0)
    updateRecurringExpense(f.id, { active: true }, env.ctx)
    expect(
      scheduledRecurringOccurrences('2026-09-01', '2026-11-30').map((row) => row.periodStart)
    ).toEqual(['2026-10-01'])
    expect(materializeDueRecurringExpenses()).toEqual({ created: 1 })
    expect(materializeDueRecurringExpenses()).toEqual({ created: 0 })
    expect(monthlyProfitSummary(2026, 10).netProfitMinor).toBe(-m(300))
    expect(cumulativeNetProfitMinor()).toBe(0)
    expect(availableProfitMinor()).toBe(0)
    expect(accountBalance(f.account)).toBe(m(4400))
    expect(
      raw()
        .prepare(
          "SELECT spent_at, amount_minor FROM expenses WHERE source='recurring' ORDER BY spent_at"
        )
        .all()
    ).toEqual([
      { spent_at: '2026-09-01', amount_minor: m(300) },
      { spent_at: '2026-10-01', amount_minor: m(300) }
    ])
    const readBefore = snapshot()
    expenseSummary({ from: '2026-09-01', to: '2026-11-30' })
    scheduledRecurringOccurrences('2026-09-01', '2026-11-30')
    expect(snapshot()).toEqual(readBefore)
    updateRecurringExpense(f.id, { endDate: null }, env.ctx)
    expect(
      scheduledRecurringOccurrences('2026-11-01', '2026-11-30').map((row) => row.periodStart)
    ).toEqual(['2026-11-01'])
    clock('Africa/Tripoli', '2026-11-15T10:00:00.000Z')
    expect(materializeDueRecurringExpenses()).toEqual({ created: 1 })
    expect(materializeDueRecurringExpenses()).toEqual({ created: 0 })
  })
  it('keeps unused-definition hard deletion and update-based activation/deactivation unchanged', () => {
    clock()
    const id = createRecurringExpense(
      { description: 'Future rent', amountMinor: m(300), startDate: '2026-11-01' },
      env.ctx
    )
    updateRecurringExpense(id, { active: false }, env.ctx)
    expect(getRecurringExpense(id).template).toMatchObject({ active: false, endDate: null })
    updateRecurringExpense(id, { active: true }, env.ctx)
    expect(getRecurringExpense(id).template).toMatchObject({ active: true, endDate: null })
    expect(deleteRecurringExpense(id, env.ctx)).toEqual({ deleted: true, deactivated: false })
  })
  it('preserves direct service permission and deactivation/audit rollback', () => {
    clock()
    const f = posted('2026-10-01')
    const before = snapshot()
    expect(() =>
      deleteRecurringExpense(f.id, {
        session: {
          ...env.ctx.session,
          user: { ...env.ctx.session.user, roleName: 'Restricted', isAdmin: false },
          permissions: []
        }
      })
    ).toThrow()
    expect(snapshot()).toEqual(before)
    raw().exec(
      "CREATE TRIGGER new10_fail BEFORE INSERT ON audit_log WHEN NEW.action='expenses.recurring.deactivate' BEGIN SELECT RAISE(ABORT,'NEW10 audit failure'); END;"
    )
    try {
      expect(() => deleteRecurringExpense(f.id, env.ctx)).toThrow(/NEW10 audit failure/)
      expect(snapshot()).toEqual(before)
    } finally {
      raw().exec('DROP TRIGGER new10_fail')
    }
    deleteRecurringExpense(f.id, env.ctx)
    expect(getRecurringExpense(f.id).template.endDate).toBe('2026-10-01')
  })
  it('registered IPC keeps authorization and uses local month with UTC audit time', async () => {
    clock()
    const f = posted('2026-10-01')
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>
    >()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((
      channel: string,
      handler: never
    ) => {
      handlers.set(channel, handler)
    }) as never)
    try {
      const router = await import('@main/ipc/router')
      router.registerIpcRouter()
    } finally {
      spy.mockRestore()
    }
    const role = createRole({ name: 'Restricted', permissions: [] }, env.ctx)
    createUser(
      { username: 'restricted', password: 'secret123', fullName: 'Restricted', roleId: role },
      env.ctx
    )
    login('restricted', 'secret123', 92)
    const invoke = (id: number) =>
      handlers.get(C.expenses.removeRecurring)!({ sender: { id } } as IpcMainInvokeEvent, {
        id: f.id
      })
    const before = snapshot()
    expect(await invoke(92)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(snapshot()).toEqual(before)
    expect(await invoke(1)).toMatchObject({ ok: true })
    assertOnlyDeactivation(before, f.id, '2026-10-01', '2026-09-30T22:30:00.000Z')
  })
})
