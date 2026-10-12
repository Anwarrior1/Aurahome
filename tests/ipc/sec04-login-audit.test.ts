import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IpcMainInvokeEvent } from 'electron'
import { app, ipcMain } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { login, tryResumeSession } from '@main/auth/auth.service'
import { destroyAllSessions, getSessionForWebContents } from '@main/auth/session'
import { createRole, createUser, updateRole, updateUser } from '@main/services/admin/users.service'
import { readRememberTokenFromDisk, saveRememberTokenToDisk } from '@main/auth/remember-file'
import * as rememberFile from '@main/auth/remember-file'
import * as audit from '@main/audit/audit-log.service'
import { getConfigRoot } from '@main/files/paths'
import { join } from 'node:path'

let env: TestEnv, root: string
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let sender = 81000
beforeEach(async () => {
  destroyAllSessions()
  root = mkdtempSync('/tmp/sec04-unit-')
  vi.spyOn(app, 'getPath').mockReturnValue(root)
  env = setupTestDatabase()
  sender++
  handlers = new Map()
  const registration = vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter(); registration.mockRestore()
})
afterEach(() => { vi.restoreAllMocks(); destroyAllSessions(); env.cleanup(); rmSync(root, { recursive: true, force: true }) })
function call(channel: string, request: unknown = {}, id = sender) { return handlers.get(channel)!({ sender: { id } } as IpcMainInvokeEvent, request) }
function attempt(rememberMe = false, username = 'owner', password = 'secret123', id = sender) { return call(C.auth.login, { username, password, rememberMe }, id) }
function block(action: 'auth.login' | 'auth.resume') {
  getRawConnection().exec(`CREATE TEMP TRIGGER sec04_fault BEFORE INSERT ON audit_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'SEC04 disposable audit fault'); END`)
}
function recover() { getRawConnection().exec('DROP TRIGGER sec04_fault') }
function snapshot() {
  const db = getRawConnection()
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => {
    const name = (row as { name: string }).name
    return [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]
  })
}
function events(action: string) { return getRawConnection().prepare('SELECT * FROM audit_log WHERE action=? ORDER BY id').all(action) }
async function noAuthority(id = sender) {
  for (const [channel, req] of [[C.cash.accounts, {}], [C.documents.preview, { kind: 'final_invoice', id: 1 }]] as const) {
    expect(await call(channel, req, id)).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED', message: expect.any(String) } })
  }
  expect(getSessionForWebContents(id)).toBeUndefined()
}
function actor(permissions: string[] = []) {
  const roleId = createRole({ name: `SEC04 role ${sender}`, permissions }, env.ctx)
  const userId = createUser({ username: `sec04-${sender}`, fullName: 'SEC04 fictional user', password: 'secret123', roleId }, env.ctx)
  return { userId, roleId, username: `sec04-${sender}` }
}

describe('SEC-04 registered IPC password authentication commit', () => {
  it('successful password login publishes the audited trusted actor', async () => {
    const before = events('auth.login').length
    const result = await attempt()
    expect(result.ok).toBe(true)
    const session = getSessionForWebContents(sender)!
    expect(session.user.username).toBe('owner')
    expect(events('auth.login')).toHaveLength(before + 1)
    expect(events('auth.login').at(-1)).toMatchObject({ entity_id: session.sessionId, user_id: session.user.id })
    expect((await call(C.cash.accounts)).ok).toBe(true)
    expect(readRememberTokenFromDisk()).toBeUndefined()
  })
  it.each([false, true])('audit-failed password login remember=%s has no session, audit, token or SQLite changes', async (remember) => {
    block('auth.login'); const before = snapshot()
    const result = await attempt(remember)
    expect(result).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'حدث خطأ غير متوقع' } })
    expect(snapshot()).toEqual(before)
    expect(readRememberTokenFromDisk()).toBeUndefined()
    await noAuthority()
    await noAuthority(sender + 1000)
    expect(await call(C.auth.tryResume, {}, sender + 1000)).toEqual({ ok: true, data: null })
  })
  it('audit executes before the candidate session is visible even to a reentrant observer', async () => {
    const original = audit.recordAuditEvent
    let observed = false
    vi.spyOn(audit, 'recordAuditEvent').mockImplementation((event) => {
      if (event.action === 'auth.login') { observed = true; expect(getSessionForWebContents(sender)).toBeUndefined() }
      original(event)
    })
    expect((await attempt()).ok).toBe(true); expect(observed).toBe(true)
  })
  it('recovers after the trigger is removed with exactly one successful login audit', async () => {
    block('auth.login'); const n = events('auth.login').length
    expect((await attempt()).ok).toBe(false); await noAuthority(); recover()
    expect((await attempt()).ok).toBe(true); expect(events('auth.login')).toHaveLength(n + 1)
  })
  it.each([false, true])('audit failure preserves a pre-existing encrypted token file remember=%s', async (remember) => {
    login('owner', 'secret123', sender + 1, true)
    const file = join(getConfigRoot(), 'remember-token.enc'), bytes = readFileSync(file)
    block('auth.login'); const before = snapshot()
    expect((await attempt(remember)).ok).toBe(false)
    expect(snapshot()).toEqual(before); expect(readFileSync(file)).toEqual(bytes); await noAuthority()
  })
  it.each(['wrong password', 'unknown user', 'disabled user'])('%s never authenticates and leaves SQLite unchanged', async (kind) => {
    const user = actor()
    if (kind === 'disabled user') updateUser(user.userId, { active: false }, env.ctx)
    const before = snapshot()
    const result = await attempt(false, kind === 'unknown user' ? 'missing-sec04' : user.username, kind === 'wrong password' ? 'incorrect' : 'secret123')
    expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } }); expect(snapshot()).toEqual(before); await noAuthority()
  })
  it('caller identity/role/session claims cannot override invalid credentials or sender binding', async () => {
    const result = await call(C.auth.login, { username: 'missing-sec04', password: 'incorrect', userId: 1, isAdmin: true, session: env.ctx.session, webContentsId: 1 })
    expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } }); await noAuthority()
  })
  it('malformed login payload cannot establish authority', async () => {
    expect(await call(C.auth.login, { username: 'owner', password: 123 })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } }); await noAuthority()
  })
  it('a remembered file write failure rolls back the new token and audit before publication', async () => {
    vi.spyOn(rememberFile, 'saveRememberTokenToDisk').mockImplementation(() => { throw new Error('SEC04 disposable file-write fault') })
    const before = snapshot()
    expect((await attempt(true)).ok).toBe(false); expect(snapshot()).toEqual(before); await noAuthority()
  })
  it('failure clearing remember state does not publish the session or commit the login audit', async () => {
    vi.spyOn(rememberFile, 'clearRememberTokenFromDisk').mockImplementation(() => { throw new Error('SEC04 disposable clear fault') })
    const before = snapshot()
    expect((await attempt()).ok).toBe(false); expect(snapshot()).toEqual(before); await noAuthority()
  })
})

describe('SEC-04 existing sessions and isolation', () => {
  it.each(['bad password', 'same-user audit', 'different-user audit', 'disabled account'])('preserves the old session on %s failure', async (kind) => {
    const user = actor([P.cash.view]); login('owner', 'secret123', sender)
    const old = getSessionForWebContents(sender)
    if (kind.includes('audit')) block('auth.login')
    if (kind === 'disabled account') updateUser(user.userId, { active: false }, env.ctx)
    const before = snapshot()
    const result = await attempt(false, kind === 'same-user audit' ? 'owner' : user.username, kind === 'bad password' ? 'incorrect' : 'secret123')
    expect(result.ok).toBe(false); expect(getSessionForWebContents(sender)).toBe(old); expect(snapshot()).toEqual(before)
    expect((await call(C.cash.accounts)).ok).toBe(true)
    expect((await call(C.auth.logout)).ok).toBe(true); await noAuthority()
  })
  it('successful account switch publishes only the new sender identity and its real permissions', async () => {
    const user = actor(); login('owner', 'secret123', sender)
    expect((await attempt(false, user.username)).ok).toBe(true)
    expect(getSessionForWebContents(sender)?.user.id).toBe(user.userId)
    expect(await call(C.cash.accounts)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await call(C.documents.preview, { kind: 'final_invoice', id: 1 })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
  it('same-user repeat and queued duplicate login each audit once and bind only the latest completed result', async () => {
    const n = events('auth.login').length
    const results = await Promise.all([attempt(), attempt(), attempt()])
    expect(results.every((r) => r.ok)).toBe(true); expect(events('auth.login')).toHaveLength(n + 3)
    expect(getSessionForWebContents(sender)?.sessionId).toBe((results[2] as { ok: true; data: { session: { sessionId: string } } }).data.session.sessionId)
  })
  it('queued audit failures grant no authority, even when queued with protected calls', async () => {
    block('auth.login'); const before = snapshot()
    const results = await Promise.all([attempt(true), call(C.cash.accounts), attempt(), call(C.documents.preview, { kind: 'final_invoice', id: 1 })])
    expect(results.map((r) => r.ok ? 'success' : r.error.code)).toEqual(['INTERNAL_ERROR', 'UNAUTHENTICATED', 'INTERNAL_ERROR', 'UNAUTHENTICATED'])
    expect(snapshot()).toEqual(before); await noAuthority()
  })
  it('another WebContents cannot reuse either a failed or successful sender session', async () => {
    block('auth.login'); await attempt(); await noAuthority(sender + 1); recover(); await attempt()
    await noAuthority(sender + 1)
    expect(await call(C.cash.accounts, { session: getSessionForWebContents(sender), webContentsId: sender }, sender + 1)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
  })
  it.each(['logout', 'deactivate', 'password', 'role permissions', 'role assignment'])('%s still revokes live authority and remembered tokens under the existing contract', async (kind) => {
    const user = actor([P.cash.view, P.finalInvoices.view]); await attempt(true, user.username)
    expect((await call(C.cash.accounts)).ok).toBe(true)
    if (kind === 'logout') await call(C.auth.logout)
    else if (kind === 'deactivate') updateUser(user.userId, { active: false }, env.ctx)
    else if (kind === 'password') updateUser(user.userId, { password: 'different123' }, env.ctx)
    else if (kind === 'role permissions') updateRole(user.roleId, { permissions: [] }, env.ctx)
    else { const next = createRole({ name: `SEC04 next ${sender}`, permissions: [] }, env.ctx); updateUser(user.userId, { roleId: next }, env.ctx) }
    await noAuthority()
    // Role-permission edits revoke sessions, but the established token contract
    // re-resolves the role on a fresh resume; it does not revoke that token row.
    if (kind === 'role permissions') {
      const result = await call(C.auth.tryResume)
      expect(result.ok).toBe(true)
      expect(await call(C.cash.accounts)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    } else expect(await call(C.auth.tryResume)).toEqual({ ok: true, data: null })
  })
})

describe('SEC-04 remembered login commit', () => {
  it('password remember-me creates one hashed token, resumes with required audit and never sends raw token', async () => {
    const n = events('auth.resume').length
    const result = await attempt(true); expect(result.ok).toBe(true)
    const raw = readRememberTokenFromDisk()!
    expect(JSON.stringify(result)).not.toContain(raw)
    const resumed = await call(C.auth.tryResume, {}, sender + 1); expect(resumed.ok).toBe(true)
    expect(events('auth.resume')).toHaveLength(n + 1)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS n FROM remember_tokens').get()).toEqual({ n: 1 })
    expect((await call(C.cash.accounts, {}, sender + 1)).ok).toBe(true)
  })
  it('audit-failed resume rolls back sliding token use, preserves the file, and cannot authenticate', async () => {
    login('owner', 'secret123', sender + 1, true)
    const file = join(getConfigRoot(), 'remember-token.enc'), bytes = readFileSync(file)
    block('auth.resume'); const before = snapshot()
    expect(await call(C.auth.tryResume)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } })
    expect(snapshot()).toEqual(before); expect(readFileSync(file)).toEqual(bytes); await noAuthority()
    recover(); expect((await call(C.auth.tryResume)).ok).toBe(true)
  })
  it('resume audit observes no published candidate session', () => {
    login('owner', 'secret123', sender + 1, true)
    const original = audit.recordAuditEvent; let checked = false
    vi.spyOn(audit, 'recordAuditEvent').mockImplementation((event) => { if (event.action === 'auth.resume') { checked = true; expect(getSessionForWebContents(sender)).toBeUndefined() }
      original(event) })
    expect(tryResumeSession(sender)).toBeDefined(); expect(checked).toBe(true)
  })
  it('audit-failed resume preserves the old sender session while refusing the new account', async () => {
    const user = actor(); login(user.username, 'secret123', sender + 1, true)
    const old = login('owner', 'secret123', sender, true).session
    // Restore the legitimately issued other account token without changing DB policy.
    login(user.username, 'secret123', sender + 1, true)
    block('auth.resume'); const before = snapshot()
    expect((await call(C.auth.tryResume)).ok).toBe(false); expect(getSessionForWebContents(sender)).toBe(old); expect(snapshot()).toEqual(before)
  })
  it.each(['missing', 'unknown', 'expired', 'disabled'])('%s remembered credential keeps the established non-error no-resume behavior', async (kind) => {
    const user = actor()
    if (kind !== 'missing') login(user.username, 'secret123', sender + 1, true)
    if (kind === 'unknown') saveRememberTokenToDisk('SEC04 nonexistent token')
    if (kind === 'expired') getRawConnection().prepare("UPDATE remember_tokens SET expires_at='2000-01-01T00:00:00.000Z'").run()
    if (kind === 'disabled') updateUser(user.userId, { active: false }, env.ctx)
    expect(await call(C.auth.tryResume)).toEqual({ ok: true, data: null }); await noAuthority()
  })
  it('complete login/resume/logout lifecycle keeps integrity and foreign keys clean', async () => {
    await attempt(true); await call(C.auth.tryResume, {}, sender + 1); await call(C.auth.logout, {}, sender + 1)
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})
