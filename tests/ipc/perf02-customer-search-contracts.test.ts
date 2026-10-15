import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { getRawConnection } from '@main/db/connection'
import { createCustomer, archiveCustomer } from '@main/services/parties/parties.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { destroySessionForWebContents } from '@main/auth/session'
import {
  acquireRestoreExclusivity,
  captureRestoreGeneration
} from '@main/restore/restore-lifecycle'
import { reconcileDatabase } from '@main/db/reconciliation'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<any>>
const event = (id: number) => ({ sender: { id } }) as IpcMainInvokeEvent
const owner = event(79201),
  denied = event(79202),
  reader = event(79203),
  anonymous = event(79204),
  stale = event(79205)
const call = (payload: unknown, who = owner) => handlers.get(C.customers.list)!(who, payload)
function snapshot() {
  const db = getRawConnection()
  return JSON.stringify(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string
      }[]
    ).map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
  )
}
beforeAll(async () => {
  env = setupTestDatabase()
  for (let i = 0; i < 105; i++)
    createCustomer(
      { name: `Alpha ${String(i).padStart(3, '0')}`, phone: `555${String(i).padStart(3, '0')}` },
      env.ctx
    )
  createCustomer({ name: 'عميل عربي', phone: '777' }, env.ctx)
  const archived = createCustomer({ name: 'Alpha archived' }, env.ctx)
  archiveCustomer(archived, env.ctx)
  for (const [name, permissions, who] of [
    ['perf02-reader', ['customers.view'], reader],
    ['perf02-denied', ['dashboard.view'], denied]
  ] as const) {
    const role = createRole({ name, permissions: [...permissions] }, env.ctx)
    createUser({ username: name, fullName: name, password: 'secret123', roleId: role }, env.ctx)
    login(name, 'secret123', who.sender.id)
  }
  login('owner', 'secret123', owner.sender.id)
  login('owner', 'secret123', stale.sender.id)
  destroySessionForWebContents(stale.sender.id)
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi
    .spyOn(electron.ipcMain, 'handle')
    .mockImplementation(((channel: string, handler: never) =>
      handlers.set(channel, handler)) as never)
  ;(await import('@main/ipc/router')).registerIpcRouter()
  spy.mockRestore()
})
afterAll(() => env.cleanup())
describe('PERF-02 unchanged registered search and financial contracts', () => {
  it('RED-12 denies anonymous, stale and forbidden principals before disclosing customer data', async () => {
    const before = snapshot()
    for (const [who, code] of [
      [anonymous, 'UNAUTHENTICATED'],
      [stale, 'UNAUTHENTICATED'],
      [denied, 'FORBIDDEN']
    ] as const)
      expect(await call({ search: 'Alpha' }, who)).toMatchObject({ ok: false, error: { code } })
    expect(snapshot()).toBe(before)
  })
  it('preserves substring, phone, ASCII case, trim and SQL wildcard semantics', async () => {
    const before = snapshot()
    for (const term of [
      'pha 00',
      '55500',
      'alpha 00',
      ' Alpha 00 ',
      'Alpha 00',
      'عميل',
      'Alpha 0_',
      '%',
      '',
      '   ',
      'no-match'
    ]) {
      const result = await call({ search: term, state: 'active' })
      expect(result.ok).toBe(true)
      const normalized = term.trim(),
        p = `%${normalized}%`
      const expected = getRawConnection()
        .prepare(
          "SELECT id, name FROM customers WHERE active=1 AND (?='' OR name LIKE ? OR phone LIKE ?) ORDER BY name ASC,id ASC"
        )
        .all(normalized, p, p) as { id: number; name: string }[]
      expect(result.data.items.map((r: any) => ({ id: r.id, name: r.name }))).toEqual(
        expected.slice(0, 50)
      )
      expect(result.data.summary.totalCount).toBe(expected.length)
    }
    expect(snapshot()).toBe(before)
  })
  it('preserves exact sorted cursor coverage, summary and restricted-reader data', async () => {
    const before = snapshot(),
      ids: number[] = []
    let cursor: string | undefined
    do {
      const result = await call(
        { search: 'Alpha', state: 'active', ...(cursor ? { cursor } : {}) },
        reader
      )
      expect(result.ok).toBe(true)
      expect(result.data.summary.totalCount).toBe(105)
      expect(result.data.items.length).toBeLessThanOrEqual(50)
      ids.push(...result.data.items.map((r: any) => r.id))
      for (const r of result.data.items)
        expect([r.orderCount, r.totalMinor, r.paidMinor, r.remainingMinor]).toEqual([0, 0, 0, 0])
      cursor = result.data.nextCursor ?? undefined
    } while (cursor)
    expect(ids).toEqual(
      (
        getRawConnection()
          .prepare(
            "SELECT id FROM customers WHERE active=1 AND name LIKE '%Alpha%' ORDER BY name,id"
          )
          .all() as { id: number }[]
      ).map((r) => r.id)
    )
    expect(new Set(ids).size).toBe(105)
    expect(snapshot()).toBe(before)
  })
  it('preserves archived filtering and rejects a cursor from a different search', async () => {
    const before = snapshot()
    const first = await call({ search: 'Alpha' })
    const archived = await call({ search: 'Alpha', state: 'archived' })
    expect(archived.data.items.map((r: any) => r.name)).toEqual(['Alpha archived'])
    expect(archived.data.summary.totalCount).toBe(1)
    expect(await call({ search: 'different', cursor: first.data.nextCursor })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
    expect(snapshot()).toBe(before)
  })
  it('preserves bounded request validation and restore-lifecycle admission', async () => {
    const before = snapshot()
    expect(await call({ search: 'x'.repeat(10000) })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
    const release = await acquireRestoreExclusivity(captureRestoreGeneration())
    try {
      expect(await call({ search: 'Alpha' })).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT' }
      })
    } finally {
      release()
    }
    expect(snapshot()).toBe(before)
  })
  it('keeps migrations, SQLite health, all 73 reconciliations and every table read-only', () => {
    const db = getRawConnection(),
      before = snapshot()
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.prepare('SELECT COUNT(*) n FROM __drizzle_migrations').get()).toEqual({ n: 54 })
    expect(reconcileDatabase(db)).toMatchObject({
      checksRun: 73,
      errorCount: 0,
      warningCount: 0,
      findings: []
    })
    expect(snapshot()).toBe(before)
  })
})
