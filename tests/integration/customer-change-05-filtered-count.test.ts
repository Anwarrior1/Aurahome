import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import {
  createCustomer,
  deleteCustomer,
  listCustomers,
  updateCustomer
} from '@main/services/parties/parties.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'

let env: TestEnv

beforeEach(() => {
  env = setupTestDatabase()
})

afterEach(() => env.cleanup())

function insertCustomers(names: string[], active = true): void {
  const insert = getRawConnection().prepare('INSERT INTO customers (name, active) VALUES (?, ?)')
  const seed = getRawConnection().transaction(() => {
    for (const name of names) insert.run(name, active ? 1 : 0)
  })
  seed()
}

function integrity(): void {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
}

describe('Customer Change 05 — authoritative filtered customer total', () => {
  it('returns the complete filtered total before pagination and keeps it stable across pages', () => {
    insertCustomers([
      ...Array.from({ length: 53 }, (_, index) => `مرشح ${String(index).padStart(3, '0')}`),
      ...Array.from({ length: 7 }, (_, index) => `محمد ${String(index).padStart(3, '0')}`),
      ...Array.from({ length: 60 }, (_, index) => `عميل ${String(index).padStart(3, '0')}`)
    ])

    const first = listCustomers({}, { limit: 20 })
    expect(first.items).toHaveLength(20)
    expect(first.summary).toEqual({ totalCount: 120 })

    const search = listCustomers({ search: 'محمد' }, { limit: 5 })
    expect(search.items).toHaveLength(5)
    expect(search.summary).toEqual({ totalCount: 7 })

    const summaries: number[] = []
    const ids: number[] = []
    let cursor: string | undefined
    do {
      const page = listCustomers({ search: 'مرشح' }, { limit: 20, cursor })
      summaries.push(page.summary.totalCount)
      ids.push(...page.items.map((row) => row.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(summaries).toEqual([53, 53, 53])
    expect(new Set(ids).size).toBe(53)

    expect(listCustomers({ search: 'لا توجد نتيجة' }, { limit: 20 })).toMatchObject({
      items: [],
      summary: { totalCount: 0 }
    })
    expect(listCustomers({ search: '' }, { limit: 20 }).summary.totalCount).toBe(120)
    integrity()
  })

  it('applies lifecycle filters and search identically to rows and total', () => {
    insertCustomers(['محمد نشط', 'عميل نشط'])
    insertCustomers(['محمد مؤرشف', 'عميل مؤرشف'], false)

    const active = listCustomers({ state: 'active', search: 'محمد' }, { limit: 1 })
    expect(active.items.map((row) => row.name)).toEqual(['محمد نشط'])
    expect(active.summary).toEqual({ totalCount: 1 })

    const archived = listCustomers({ state: 'archived', search: 'محمد' }, { limit: 1 })
    expect(archived.items.map((row) => row.name)).toEqual(['محمد مؤرشف'])
    expect(archived.summary).toEqual({ totalCount: 1 })
    expect(listCustomers({ state: 'archived' }, { limit: 1 }).summary.totalCount).toBe(2)
    integrity()
  })

  it('refreshes correctly after matching and non-matching create, edit and delete operations', () => {
    insertCustomers(['هدف أول'])
    expect(listCustomers({ search: 'هدف' }).summary.totalCount).toBe(1)

    const matching = createCustomer({ name: 'هدف ثان' }, env.ctx)
    expect(listCustomers({ search: 'هدف' }).summary.totalCount).toBe(2)

    const other = createCustomer({ name: 'بعيد' }, env.ctx)
    expect(listCustomers({ search: 'هدف' }).summary.totalCount).toBe(2)

    updateCustomer(other, { name: 'هدف ثالث' }, env.ctx)
    expect(listCustomers({ search: 'هدف' }).summary.totalCount).toBe(3)
    updateCustomer(other, { name: 'بعيد مجدداً' }, env.ctx)
    expect(listCustomers({ search: 'هدف' }).summary.totalCount).toBe(2)

    deleteCustomer(other, env.ctx, 'بعيد مجدداً')
    expect(listCustomers({ search: 'هدف' }).summary.totalCount).toBe(2)
    deleteCustomer(matching, env.ctx, 'هدف ثان')
    expect(listCustomers({ search: 'هدف' }).summary.totalCount).toBe(1)
    integrity()
  })

  it('returns the authoritative total through the existing permission-guarded IPC path', async () => {
    insertCustomers(Array.from({ length: 7 }, (_, index) => `محمد ${index}`))
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, payload: unknown) => Promise<IpcResult<unknown>>
    >()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => {
      handlers.set(channel, handler)
    }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()

    const roleId = createRole({ name: 'Customer count viewer', permissions: [P.customers.view] }, env.ctx)
    createUser({ username: 'count-viewer', password: 'secret123', fullName: 'Count Viewer', roleId }, env.ctx)
    login('count-viewer', 'secret123', 9505)
    const result = await handlers.get(IPC_CHANNELS.customers.list)!(
      { sender: { id: 9505 } } as IpcMainInvokeEvent,
      { search: 'محمد', limit: 5 }
    )
    expect(result).toMatchObject({
      ok: true,
      data: { items: expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining('محمد') })]), summary: { totalCount: 7 } }
    })
    if (result.ok) expect((result.data as { items: unknown[] }).items).toHaveLength(5)
    integrity()
  })
})
