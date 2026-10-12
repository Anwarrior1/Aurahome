import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createRole, createUser, deleteUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { getSession } from '@main/auth/session'
import { issueRememberToken, consumeRememberToken } from '@main/auth/remember-token'
import { clearFailedAttempts, isLockedOut } from '@main/auth/lockout'
import { createCustomer } from '@main/services/parties/parties.service'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 60400
beforeEach(async () => {
  env = setupTestDatabase()
  for (const name of ['hadi', 'Hadi', 'cc03-admin']) clearFailedAttempts(name)
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})
afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})

const raw = () => getRawConnection()
function tables() {
  return (raw().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
}
const hadiRows = () => raw().prepare("SELECT id, username, active, role_id, deleted_at FROM users WHERE username = 'hadi' ORDER BY id").all() as Array<{ id: number; username: string; active: number; role_id: number | null; deleted_at: string | null }>
const liveHadi = () => hadiRows().filter((row) => row.deleted_at === null)

let roleSeq = 0
function role(permissions: string[]) {
  roleSeq += 1
  return createRole({ name: `CC03 role ${roleSeq}`, permissions }, env.ctx)
}
/** A user with real history (login audit + a business action), so deletion tombstones instead of hard-deleting. */
function hadiWithHistory(password: string, roleId: number) {
  const id = createUser({ username: 'hadi', password, fullName: 'هادي', roleId }, env.ctx)
  const response = login('hadi', password, ++windowId)
  const customerId = createCustomer({ name: `عميل هادي ${id}` }, { session: response.session })
  return { id, session: response.session, customerId }
}
async function ipcAsAdmin() {
  const roleId = role([P.users.manage, P.users.view])
  createUser({ username: 'cc03-admin', password: 'secret123', fullName: 'CC03 admin', roleId }, env.ctx)
  const event = { sender: { id: ++windowId } } as IpcMainInvokeEvent
  login('cc03-admin', 'secret123', windowId)
  return (channel: string, request: unknown) => handlers.get(channel)!(event, request)
}

describe('CC03 — reuse a deleted username as a new identity', () => {
  it('A/K/L: an active "hadi" blocks a second active "hadi" (service, IPC and database) with zero residue', async () => {
    const roleId = role([P.customers.view])
    createUser({ username: 'hadi', password: 'secret123', fullName: 'هادي', roleId }, env.ctx)
    let before = tables()
    expect(() => createUser({ username: 'hadi', password: 'other123', fullName: 'نسخة', roleId }, env.ctx)).toThrow(/اسم المستخدم مستخدم بالفعل/)
    expect(tables()).toEqual(before)

    const call = await ipcAsAdmin()
    before = tables()
    expect(await call(C.admin.createUser, { username: 'hadi', password: 'other123', fullName: 'نسخة', roleId }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(tables()).toEqual(before)

    before = tables()
    expect(() => raw().prepare("INSERT INTO users (username, password_hash, full_name, role_id, active, theme, created_at) VALUES ('hadi', 'x', 'raw', ?, 1, 'light', '2026-09-17T00:00:00.000Z')").run(roleId))
      .toThrow(/UNIQUE constraint failed: users.username/)
    expect(tables()).toEqual(before)
    expect(liveHadi()).toHaveLength(1)
  })

  it('B/C/D/E: tombstoned "hadi" frees the username; the new "hadi" is a new id and history stays on the old id', () => {
    const oldRole = role([P.customers.view, P.customers.manage])
    const old = hadiWithHistory('old-secret', oldRole)
    const oldAudit = raw().prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id').all(old.id)
    const oldCustomer = raw().prepare('SELECT * FROM customers WHERE id = ?').get(old.customerId)
    expect(oldAudit.length).toBeGreaterThan(0)

    expect(deleteUser(old.id, env.ctx)).toEqual({ mode: 'tombstoned' })
    const tombstone = raw().prepare('SELECT * FROM users WHERE id = ?').get(old.id)
    const newRole = role([P.customers.view, P.customers.manage])
    const newId = createUser({ username: 'hadi', password: 'new-secret', fullName: 'هادي الجديد', roleId: newRole }, env.ctx)

    expect(newId).not.toBe(old.id)
    expect(hadiRows().map((row) => row.id)).toEqual([old.id, newId])
    expect(liveHadi().map((row) => row.id)).toEqual([newId])
    expect(raw().prepare('SELECT * FROM users WHERE id = ?').get(old.id)).toEqual(tombstone)
    expect(raw().prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id').all(old.id)).toEqual(oldAudit)
    expect(raw().prepare('SELECT * FROM customers WHERE id = ?').get(old.customerId)).toEqual(oldCustomer)

    const fresh = login('hadi', 'new-secret', ++windowId)
    expect(fresh.session.user.id).toBe(newId)
    const newCustomer = createCustomer({ name: 'عميل هادي الجديد' }, { session: fresh.session })
    expect(raw().prepare("SELECT user_id FROM audit_log WHERE action = 'auth.login' ORDER BY id DESC LIMIT 1").get()).toEqual({ user_id: newId })
    expect(raw().prepare("SELECT user_id FROM audit_log WHERE entity = 'customers' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(String(newCustomer))).toEqual({ user_id: newId })
    expect(raw().prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id').all(old.id)).toEqual(oldAudit)
  })

  it('B: a hard-deleted (history-free) "hadi" also frees the username', () => {
    const roleId = role([P.customers.view])
    const oldId = createUser({ username: 'hadi', password: 'secret123', fullName: 'هادي', roleId }, env.ctx)
    expect(deleteUser(oldId, env.ctx)).toEqual({ mode: 'deleted' })
    const newId = createUser({ username: 'hadi', password: 'secret456', fullName: 'هادي', roleId }, env.ctx)
    expect(liveHadi().map((row) => row.id)).toEqual([newId])
  })

  it('F: the deleted identity\'s credentials never authenticate, before or after reuse', () => {
    const old = hadiWithHistory('old-secret', role([P.customers.view, P.customers.manage]))
    deleteUser(old.id, env.ctx)
    expect(() => login('hadi', 'old-secret', ++windowId)).toThrow(/اسم المستخدم أو كلمة المرور غير صحيحة/)
    clearFailedAttempts('hadi')
    createUser({ username: 'hadi', password: 'new-secret', fullName: 'هادي', roleId: role([P.customers.view]) }, env.ctx)
    expect(() => login('hadi', 'old-secret', ++windowId)).toThrow(/اسم المستخدم أو كلمة المرور غير صحيحة/)
    clearFailedAttempts('hadi')
    expect(login('hadi', 'new-secret', ++windowId).session.user.id).not.toBe(old.id)
  })

  it('G: old sessions, remember-me tokens and lockout state never transfer to the new identity', () => {
    const old = hadiWithHistory('old-secret', role([P.customers.view, P.customers.manage]))
    const rememberToken = issueRememberToken(old.id)
    for (let attempt = 0; attempt < 5; attempt++) expect(() => login('hadi', 'wrong-pass', ++windowId)).toThrow()
    expect(isLockedOut('hadi')).toBe(true)

    deleteUser(old.id, env.ctx)
    expect(getSession(old.session.sessionId)).toBeUndefined()
    expect(isLockedOut('hadi')).toBe(false)

    const newId = createUser({ username: 'hadi', password: 'new-secret', fullName: 'هادي', roleId: role([P.customers.view]) }, env.ctx)
    expect(consumeRememberToken(rememberToken)).toBeUndefined()
    expect(getSession(old.session.sessionId)).toBeUndefined()
    const fresh = login('hadi', 'new-secret', ++windowId)
    expect(fresh.session.sessionId).not.toBe(old.session.sessionId)
    expect(fresh.session.user.id).toBe(newId)
  })

  it('H: the new "hadi" gets only the role selected at creation, never the old role or permissions', () => {
    const powerful = role([P.users.manage, P.roles.manage, P.customers.manage])
    const old = hadiWithHistory('old-secret', powerful)
    deleteUser(old.id, env.ctx)
    const rolesBefore = raw().prepare('SELECT * FROM roles ORDER BY id').all()
    const limited = role([P.customers.view])
    const newId = createUser({ username: 'hadi', password: 'new-secret', fullName: 'هادي', roleId: limited }, env.ctx)

    expect(raw().prepare('SELECT role_id FROM users WHERE id = ?').get(newId)).toEqual({ role_id: limited })
    expect(raw().prepare('SELECT role_id FROM users WHERE id = ?').get(old.id)).toEqual({ role_id: null })
    const session = login('hadi', 'new-secret', ++windowId).session
    expect(session.user.isAdmin).toBe(false)
    expect(session.permissions).toContain(P.customers.view)
    for (const inherited of [P.users.manage, P.roles.manage, P.customers.manage]) expect(session.permissions).not.toContain(inherited)
    expect(raw().prepare('SELECT * FROM roles WHERE id != ? ORDER BY id').all(limited)).toEqual(rolesBefore)
  })

  it('I/M: repeated delete → recreate cycles keep exactly one active "hadi" and every old identity intact', () => {
    const ids: number[] = []
    for (let cycle = 0; cycle < 4; cycle++) {
      const user = hadiWithHistory(`secret-${cycle}`, role([P.customers.view, P.customers.manage]))
      ids.push(user.id)
      expect(liveHadi().map((row) => row.id)).toEqual([user.id])
      deleteUser(user.id, env.ctx)
      expect(liveHadi()).toHaveLength(0)
    }
    const finalId = createUser({ username: 'hadi', password: 'final-secret', fullName: 'هادي', roleId: role([P.customers.view]) }, env.ctx)
    expect(new Set([...ids, finalId]).size).toBe(5)
    expect(hadiRows().map((row) => row.id)).toEqual([...ids, finalId])
    expect(liveHadi().map((row) => row.id)).toEqual([finalId])
    for (const id of ids) expect(raw().prepare('SELECT COUNT(*) AS c FROM audit_log WHERE user_id = ?').get(id)).toMatchObject({ c: expect.any(Number) })
    expect(raw().prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'users.delete'").get()).toEqual({ c: 4 })
  })

  it('J: case variants follow the unchanged exact-match rule', () => {
    const roleId = role([P.customers.view])
    const lower = createUser({ username: 'hadi', password: 'secret123', fullName: 'هادي', roleId }, env.ctx)
    const upper = createUser({ username: 'Hadi', password: 'secret123', fullName: 'Hadi', roleId }, env.ctx)
    expect(upper).not.toBe(lower)
    expect(() => createUser({ username: 'Hadi', password: 'secret123', fullName: 'Hadi', roleId }, env.ctx)).toThrow(/مستخدم بالفعل/)
    expect(login('Hadi', 'secret123', ++windowId).session.user.id).toBe(upper)
  })

  it('K: the IPC create path reuses a deleted username and still returns a fresh id', async () => {
    const old = hadiWithHistory('old-secret', role([P.customers.view, P.customers.manage]))
    deleteUser(old.id, env.ctx)
    const call = await ipcAsAdmin()
    const result = await call(C.admin.createUser, { username: 'hadi', password: 'new-secret', fullName: 'هادي', roleId: role([P.customers.view]) }) as IpcResult<{ id: number }>
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.data.id).not.toBe(old.id)
  })
})
