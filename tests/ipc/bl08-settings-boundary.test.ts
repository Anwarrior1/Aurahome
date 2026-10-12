import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import type { IpcResult } from '@shared/types/ipc.types'
import { login } from '@main/auth/auth.service'
import { getRawConnection } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { DEFAULT_TERMS, SETTING_KEYS, getSetting } from '@main/services/settings.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

/**
 * BL-08 — the Settings IPC is a CLOSED, typed boundary.
 *
 * `settings:set` may write only the keys a user is meant to edit, each
 * inside the domain its consumers already rely on. It may not invent a
 * key, and it may not reach a key another module owns
 * (`savings.rate_bp`, which belongs to the Savings module).
 */
let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 90_000

beforeEach(async () => {
  windowId += 10
  env = setupTestDatabase()
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi
    .spyOn(electron.ipcMain, 'handle')
    .mockImplementation(((channel: string, handler: never) => handlers.set(channel, handler)) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})
afterEach(() => env.cleanup())

function invoke(channel: string, id: number, payload: unknown = {}): Promise<IpcResult<unknown>> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler({ sender: { id } } as IpcMainInvokeEvent, payload)
}

function signIn(label: string, permissions: string[], id: number): void {
  const roleId = createRole({ name: `bl08-${label}-${id}`, permissions }, env.ctx)
  const username = `bl08-${label}-${id}`
  createUser({ username, password: 'secret789', fullName: 'مستخدم BL-08', roleId }, env.ctx)
  login(username, 'secret789', id)
}

/** Every stored settings row — a rejected write must leave this identical. */
function settingsRows(): unknown[] {
  return getRawConnection().prepare('SELECT * FROM app_settings ORDER BY key').all()
}

async function set(key: string, value: unknown, id: number): Promise<IpcResult<unknown>> {
  return invoke(IPC_CHANNELS.settings.set, id, { key, value })
}

/** Asserts the write was refused AND changed nothing at all. */
async function expectRejected(key: string, value: unknown, id: number): Promise<void> {
  const before = settingsRows()
  const result = (await set(key, value, id)) as { ok: boolean; error?: { code: string } }
  expect(result.ok).toBe(false)
  expect(result.error?.code).toBe('VALIDATION_ERROR')
  expect(settingsRows()).toEqual(before)
}

describe('BL-08 — Settings is a closed, typed boundary', () => {
  let manager: number

  beforeEach(() => {
    manager = windowId + 1
    signIn('manager', [P.settings.manage, P.settings.view], manager)
  })

  it('rejects an unknown arbitrary key and stores nothing', async () => {
    await expectRejected('totally.unknown.key', { anything: 1 }, manager)
    await expectRejected('', 'x', manager)
    await expectRejected('savings.rate_bp.evil', 1, manager)
    expect(
      getRawConnection().prepare("SELECT COUNT(*) AS c FROM app_settings WHERE key = 'totally.unknown.key'").get()
    ).toEqual({ c: 0 })
  })

  it('refuses savings.rate_bp through generic Settings, leaving the rate untouched', async () => {
    await expectRejected(SETTING_KEYS.savingsRateBp, 50_000, manager)
    await expectRejected(SETTING_KEYS.savingsRateBp, 2_000, manager)
    expect(getSetting<number>(SETTING_KEYS.savingsRateBp)).toBe(1000)
  })

  it('keeps the savings rate on its own typed route under savings.manage', async () => {
    const savings = windowId + 3
    const outsider = windowId + 4
    signIn('savings', [P.savings.manage], savings)
    signIn('outsider', [P.settings.manage], outsider)

    const denied = (await invoke(IPC_CHANNELS.profit.setSavingsRate, outsider, { rateBp: 2_000 })) as {
      ok: boolean
      error?: { code: string }
    }
    expect(denied.ok).toBe(false)
    expect(denied.error?.code).toBe('FORBIDDEN')

    expect((await invoke(IPC_CHANNELS.profit.setSavingsRate, savings, { rateBp: 2_000 })).ok).toBe(true)
    expect(getSetting<number>(SETTING_KEYS.savingsRateBp)).toBe(2_000)
    expect((await invoke(IPC_CHANNELS.profit.setSavingsRate, savings, { rateBp: 0 })).ok).toBe(true)
    expect((await invoke(IPC_CHANNELS.profit.setSavingsRate, savings, { rateBp: 10_000 })).ok).toBe(true)

    for (const rateBp of [10_001, 50_000, -1, 1.5]) {
      const result = (await invoke(IPC_CHANNELS.profit.setSavingsRate, savings, { rateBp })) as {
        ok: boolean
        error?: { code: string }
      }
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('VALIDATION_ERROR')
    }
    expect(getSetting<number>(SETTING_KEYS.savingsRateBp)).toBe(10_000)
  })

  it('accepts every allow-listed key at its real current values', async () => {
    expect((await set(SETTING_KEYS.depositPercentBp, 4_500, manager)).ok).toBe(true)
    expect((await set(SETTING_KEYS.quotationValidityHours, 72, manager)).ok).toBe(true)
    expect((await set(SETTING_KEYS.termsAndConditions, ['بند أول', 'بند ثانٍ'], manager)).ok).toBe(true)
    expect((await set(SETTING_KEYS.companyName, 'AURA home', manager)).ok).toBe(true)
    expect((await set(SETTING_KEYS.companyPhone, '0910000000', manager)).ok).toBe(true)
    expect((await set(SETTING_KEYS.companyAddress, 'طرابلس', manager)).ok).toBe(true)

    const all = (await invoke(IPC_CHANNELS.settings.getAll, manager)) as { data: Record<string, unknown> }
    // The read surface is exactly the known settings — an unknown key
    // was never storable, so none can ever appear here.
    expect(Object.keys(all.data).sort()).toEqual(Object.values(SETTING_KEYS).sort())
    expect(all.data[SETTING_KEYS.depositPercentBp]).toBe(4_500)
    expect(all.data[SETTING_KEYS.quotationValidityHours]).toBe(72)
    expect(all.data[SETTING_KEYS.termsAndConditions]).toEqual(['بند أول', 'بند ثانٍ'])
    expect(all.data[SETTING_KEYS.companyName]).toBe('AURA home')
    expect(all.data[SETTING_KEYS.companyPhone]).toBe('0910000000')
    expect(all.data[SETTING_KEYS.companyAddress]).toBe('طرابلس')

    // Boundary values of the existing basis-point domain, and the
    // empty-but-valid company fields the UI ships with.
    expect((await set(SETTING_KEYS.depositPercentBp, 0, manager)).ok).toBe(true)
    expect((await set(SETTING_KEYS.depositPercentBp, 10_000, manager)).ok).toBe(true)
    expect((await set(SETTING_KEYS.companyPhone, '', manager)).ok).toBe(true)
    expect((await set(SETTING_KEYS.companyAddress, '', manager)).ok).toBe(true)
    expect((await set(SETTING_KEYS.termsAndConditions, [], manager)).ok).toBe(true)
  })

  it('rejects an out-of-domain or wrongly-typed orders.deposit_percent_bp', async () => {
    for (const bad of [10_001, -1, -99_999, 60.5, '6000', null, {}, [6000], true]) {
      await expectRejected(SETTING_KEYS.depositPercentBp, bad, manager)
    }
    expect(getSetting<number>(SETTING_KEYS.depositPercentBp)).toBe(6000)
  })

  it('rejects a non-numeric or non-positive quotations.validity_hours', async () => {
    for (const bad of ['abc', '48', 0, -48, 1.5, Number.NaN, null, [], { hours: 48 }]) {
      await expectRejected(SETTING_KEYS.quotationValidityHours, bad, manager)
    }
    expect(getSetting<number>(SETTING_KEYS.quotationValidityHours)).toBe(48)
  })

  it('rejects a documents.terms value that is not an array of strings', async () => {
    for (const bad of [{ not: 'an array' }, 'بند واحد', 42, null, ['نص', 5], [['nested']], [null]]) {
      await expectRejected(SETTING_KEYS.termsAndConditions, bad, manager)
    }
    expect(getSetting<string[]>(SETTING_KEYS.termsAndConditions)).toEqual(DEFAULT_TERMS)
  })

  it('rejects malformed company settings and keeps the company name non-empty', async () => {
    for (const bad of ['', 42, null, { name: 'x' }, ['AURA']]) {
      await expectRejected(SETTING_KEYS.companyName, bad, manager)
    }
    for (const bad of [42, null, {}]) {
      await expectRejected(SETTING_KEYS.companyPhone, bad, manager)
      await expectRejected(SETTING_KEYS.companyAddress, bad, manager)
    }
    expect(getSetting<string>(SETTING_KEYS.companyName)).toBe('AURA home')
  })

  it('still refuses the retired automatic-backup keys with their own message', async () => {
    const result = (await set('backup.auto_daily', true, manager)) as { ok: boolean; error?: { message: string } }
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/لم تعد مدعومة/)
  })

  it('keeps authentication and authorization unchanged for the allow-listed keys', async () => {
    const anonymous = windowId + 5
    const viewer = windowId + 6
    const nobody = windowId + 7
    signIn('viewer', [P.settings.view], viewer)
    signIn('nobody', [P.customers.view], nobody)
    const before = settingsRows()

    expect(await invoke(IPC_CHANNELS.settings.getAll, anonymous)).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED' }
    })
    expect(await set(SETTING_KEYS.companyName, 'شركة', anonymous)).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED' }
    })
    expect(await invoke(IPC_CHANNELS.settings.getAll, nobody)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' }
    })
    expect(await set(SETTING_KEYS.companyName, 'شركة', viewer)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' }
    })
    expect(settingsRows()).toEqual(before)
    // …and the read route still works for a viewer.
    expect((await invoke(IPC_CHANNELS.settings.getAll, viewer)).ok).toBe(true)
  })
})
