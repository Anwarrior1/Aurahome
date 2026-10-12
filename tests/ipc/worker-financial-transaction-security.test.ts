import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createWorker, recordWorkerTransaction, workerBalances, workerStatement } from '@main/services/production/workers.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor } from '@shared/money/money'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 12500
let event: IpcMainInvokeEvent

beforeEach(async () => {
  windowId += 1
  event = { sender: { id: windowId } } as IpcMainInvokeEvent
  env = setupTestDatabase()
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle')
    .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})

afterEach(() => env.cleanup())

function signIn(permissions: string[]): void {
  const roleId = createRole({ name: `دور عامل-${Math.random()}`, permissions }, env.ctx)
  const username = `worker-finance-${Math.floor(Math.random() * 1e9)}`
  createUser({ username, password: 'secret123', fullName: 'مستخدم عمال', roleId }, env.ctx)
  login(username, 'secret123', windowId)
}

describe('Worker Financial Transaction IPC security', () => {
  it('rejects direct creation of a settlement/adjustment', async () => {
    const workerId = createWorker({ name: 'عامل منع التسوية' }, env.ctx)
    signIn([P.workers.finance])
    const result = await handlers.get(IPC_CHANNELS.workers.transaction)!(event, {
      workerId, kind: 'adjustment', amountMinor: moneyFromMajor(100)
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(workerStatement(workerId).transactions.items).toEqual([])
  })

  it('rejects unauthorized direct edit and delete without financial side effects', async () => {
    const workerId = createWorker({ name: 'عامل صلاحيات الحركة' }, env.ctx)
    const id = recordWorkerTransaction({ workerId, kind: 'withdrawal', amountMinor: moneyFromMajor(200) }, env.ctx)
    const row = workerStatement(workerId).transactions.items.find((item) => item.id === id)!
    const expected = {
      workerId: row.workerId, kind: row.kind, amountMinor: row.amountMinor,
      orderId: row.orderId, reversalOfTransactionId: row.reversalOfTransactionId,
      cashAccountId: row.cashAccountId, notes: row.notes, createdAt: row.createdAt
    }
    signIn([P.workers.view])

    const edit = await handlers.get(IPC_CHANNELS.workers.updateTransaction)!(event, {
      id, expected, amountMinor: moneyFromMajor(150)
    })
    const remove = await handlers.get(IPC_CHANNELS.workers.deleteTransaction)!(event, { id, expected })

    expect(edit.ok).toBe(false)
    if (!edit.ok) expect(edit.error.code).toBe('FORBIDDEN')
    expect(remove.ok).toBe(false)
    if (!remove.ok) expect(remove.error.code).toBe('FORBIDDEN')
    expect(workerBalances(workerId)).toEqual({ payableMinor: 0, debtMinor: moneyFromMajor(200) })
    expect(workerStatement(workerId).transactions.items).toHaveLength(1)
  })
})
