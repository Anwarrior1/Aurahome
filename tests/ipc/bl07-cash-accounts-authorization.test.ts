import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import type { IpcResult } from '@shared/types/ipc.types'
import { login } from '@main/auth/auth.service'
import { getRawConnection } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { adjustAccountBalance, createAccount } from '@main/services/finance/cash.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 70_000
let accountId: number

beforeEach(async () => {
  windowId += 1
  env = setupTestDatabase()
  accountId = createAccount(
    { name: 'حساب اختبار BL-07', kind: 'bank', openingBalanceMinor: 100_000 },
    env.ctx
  )
  adjustAccountBalance(
    { accountId, desiredBalanceMinor: 150_000, reason: 'تهيئة اختبار BL-07' },
    env.ctx
  )

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

function cashState() {
  const db = getRawConnection()
  return {
    accounts: db.prepare('SELECT * FROM cash_accounts ORDER BY id').all(),
    transactions: db.prepare('SELECT * FROM cash_transactions ORDER BY id').all()
  }
}

async function invokeAccounts(): Promise<IpcResult<unknown>> {
  const handler = handlers.get(IPC_CHANNELS.cash.accounts)
  if (!handler) throw new Error(`no handler registered for ${IPC_CHANNELS.cash.accounts}`)
  return handler({ sender: { id: windowId } } as IpcMainInvokeEvent, {})
}

function signInWith(permissions: string[]): void {
  const roleId = createRole({ name: `BL-07-${windowId}`, permissions }, env.ctx)
  const username = `bl07-${windowId}`
  createUser({ username, password: 'secret789', fullName: 'مستخدم BL-07', roleId }, env.ctx)
  login(username, 'secret789', windowId)
}

describe('BL-07 cash:accounts IPC authorization', () => {
  it('rejects an anonymous caller without mutating Cash data', async () => {
    const before = cashState()

    const result = await invokeAccounts()

    expect(result).toEqual({
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'يجب تسجيل الدخول' }
    })
    expect(cashState()).toEqual(before)
  })

  it('rejects an authenticated caller without cash.view without mutating Cash data', async () => {
    signInWith([P.customers.view])
    const before = cashState()

    const result = await invokeAccounts()

    expect(result).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'لا تملك صلاحية القيام بهذا الإجراء' }
    })
    expect(cashState()).toEqual(before)
  })

  it('returns the expected account data to a caller with cash.view', async () => {
    signInWith([P.cash.view])

    const result = await invokeAccounts()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`cash:accounts failed: ${result.error.code}`)
    expect(result.data).toContainEqual(expect.objectContaining({
      id: accountId,
      name: 'حساب اختبار BL-07',
      kind: 'bank',
      openingBalanceMinor: 100_000,
      balanceMinor: 150_000,
      currentBalanceMinor: 150_000,
      transactionCount: 1
    }))
  })
})
