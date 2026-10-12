import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { app, ipcMain } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { destroyAllSessions, getSessionForWebContents } from '@main/auth/session'
import { createRole, createUser } from '@main/services/admin/users.service'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { buildApi } from '../../src/preload/api/build-api'
import type { IpcResult } from '@shared/types/ipc.types'

let env: TestEnv, root: string
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
beforeEach(async () => {
  root = mkdtempSync('/tmp/bdr01-phase1-ipc-')
  vi.spyOn(app, 'getPath').mockReturnValue(root)
  destroyAllSessions(); env = setupTestDatabase(); handlers = new Map()
  const registration = vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter(); registration.mockRestore()
})
afterEach(() => { vi.restoreAllMocks(); destroyAllSessions(); env.cleanup(); rmSync(root, { recursive: true, force: true }) })
const forbiddenChannels = ['recoveryEnrollment:request', 'recovery:authenticate', 'recovery:confirmInstall', 'recovery:restore', 'recovery:installCandidate', 'recovery:provision', 'recovery:resetOwnerKey']
function snapshot() {
  const db = getRawConnection()
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => {
    const name = (row as { name: string }).name
    return [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]
  })
}
function call(channel: string, request: unknown = {}, sender = 98101) {
  return handlers.get(channel)!({ sender: { id: sender } } as IpcMainInvokeEvent, request)
}

describe('BDR-01 Phase 1 cryptography has no registered enrollment or replacement authority', () => {
  it('does not expose enrollment or destructive recovery through actual normal IPC registration', () => {
    const before = snapshot()
    for (const channel of forbiddenChannels) expect(handlers.has(channel)).toBe(false)
    expect([...handlers.keys()].some(channel => channel.startsWith('recovery:'))).toBe(false)
    expect(snapshot()).toEqual(before)
    expect(getSessionForWebContents(98101)).toBeUndefined()
  })
  it('keeps recovery and enrollment absent from the actual fixed preload API', () => {
    const api = buildApi() as unknown as Record<string, unknown>
    expect(api.recovery).toBeUndefined()
    expect(api.recoveryEnrollment).toBeUndefined()
    expect(api.invoke).toBeUndefined()
    expect(Object.keys(api.backup as object).sort()).toEqual(['create', 'pickFile', 'pickSavePath', 'restore', 'validate'])
  })
  it('a real logged-in administrator gains no enrollment or recovery-install channel', async () => {
    expect((await call(IPC_CHANNELS.auth.login, { username: 'owner', password: 'secret123' })).ok).toBe(true)
    expect(getSessionForWebContents(98101)?.user.isAdmin).toBe(true)
    for (const channel of forbiddenChannels) expect(handlers.has(channel)).toBe(false)
    const before = snapshot()
    const result = await call(IPC_CHANNELS.backup.validate, { path: root + '/missing.aurabak' })
    expect(result).toMatchObject({ ok: true, data: { valid: false } })
    expect(snapshot()).toEqual(before)
  })
  it('ordinary employee normal backup restore validation remains forbidden and read-only', async () => {
    const roleId = createRole({ name: 'BDR Phase1 ordinary employee', permissions: [] }, env.ctx)
    createUser({ username: 'phase1-employee', fullName: 'Fictional employee', password: 'secret123', roleId }, env.ctx)
    expect((await call(IPC_CHANNELS.auth.login, { username: 'phase1-employee', password: 'secret123' })).ok).toBe(true)
    const before = snapshot()
    expect(await call(IPC_CHANNELS.backup.validate, { path: root + '/missing.aurabak' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(snapshot()).toEqual(before)
    for (const channel of forbiddenChannels) expect(handlers.has(channel)).toBe(false)
  })
})
