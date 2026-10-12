import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import type { IpcResult } from '@shared/types/ipc.types'
import { getRawConnection } from '@main/db/connection'
import { login } from '@main/auth/auth.service'
import { getSessionForWebContents } from '@main/auth/session'
import { performInitialSetup } from '@main/services/admin/bootstrap.service'
import { createRole, createUser, deleteUser, setTheme, updateRole, updateUser } from '@main/services/admin/users.service'
import type { ServiceContext } from '@main/services/base/service.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

let env: TestEnv
let windowId = 57100

beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  try {
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  } finally {
    env.cleanup()
  }
})

function actor(permissions: string[] = []) {
  const id = ++windowId
  const roleId = createRole({ name: `role-${id}`, permissions }, env.ctx)
  const username = `user-${id}`
  const userId = createUser({ username, password: 'secret123', fullName: 'Limited user', roleId }, env.ctx)
  const ctx: ServiceContext = { session: login(username, 'secret123', id).session }
  return { userId, roleId, username, windowId: id, ctx }
}

function adminRoleId(): number {
  return (getRawConnection().prepare('SELECT id FROM roles WHERE is_admin = 1').get() as { id: number }).id
}

function snapshot() {
  const db = getRawConnection()
  return {
    users: db.prepare('SELECT * FROM users ORDER BY id').all(),
    roles: db.prepare('SELECT * FROM roles ORDER BY id').all(),
    permissions: db.prepare('SELECT * FROM role_permissions ORDER BY role_id, permission_key').all(),
    audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    remember: db.prepare('SELECT * FROM remember_tokens ORDER BY id').all()
  }
}

function rejectsWithoutWrites(action: () => void) {
  const before = snapshot()
  expect(action).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(snapshot()).toEqual(before)
}

async function route(channel: string, request: unknown, senderId: number) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle')
    .mockImplementation(((name: string, handler: never) => { handlers.set(name, handler) }) as never)
  try {
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
  } finally {
    spy.mockRestore()
  }
  return handlers.get(channel)!({ sender: { id: senderId } } as IpcMainInvokeEvent, request)
}

describe('NEW-BL-01: authoritative user privilege boundary', () => {
  it('rejects direct self-escalation to Admin without changing the database or session', () => {
    const limited = actor()
    rejectsWithoutWrites(() => updateUser(limited.userId, { roleId: adminRoleId() }, limited.ctx))
    expect(getSessionForWebContents(limited.windowId)).toEqual(limited.ctx.session)
    expect(login(limited.username, 'secret123', ++windowId).session.user.isAdmin).toBe(false)
  })

  it('rejects direct role changes to another user', () => {
    const limited = actor()
    const target = actor()
    rejectsWithoutWrites(() => updateUser(target.userId, { roleId: adminRoleId() }, limited.ctx))
  })

  it('rejects the deletion path that clears another users role and activation', () => {
    const limited = actor()
    const target = actor()
    updateUser(target.userId, { roleId: adminRoleId() }, env.ctx)
    rejectsWithoutWrites(() => deleteUser(target.userId, limited.ctx))
  })

  it.each([{ active: true }, { password: 'hijacked123' }])('rejects unauthorized account access changes: %j', (input) => {
    const limited = actor()
    const target = actor()
    if ('active' in input) updateUser(target.userId, { active: false }, env.ctx)
    rejectsWithoutWrites(() => updateUser(target.userId, input, limited.ctx))
  })

  it('allows a non-admin user manager to assign Admin and preserves session revocation', () => {
    const manager = actor([P.users.manage])
    const target = actor()
    expect(manager.ctx.session.user.isAdmin).toBe(false)
    updateUser(target.userId, { roleId: adminRoleId() }, manager.ctx)
    expect(getSessionForWebContents(target.windowId)).toBeUndefined()
    expect(login(target.username, 'secret123', ++windowId).session.user.isAdmin).toBe(true)
  })

  it('preserves authorized ordinary name edits and limited self-service theme edits', () => {
    const manager = actor([P.users.manage])
    const target = actor()
    updateUser(target.userId, { fullName: 'Updated name' }, manager.ctx)
    setTheme(target.userId, 'dark')
    expect(getRawConnection().prepare('SELECT full_name, role_id, theme FROM users WHERE id = ?').get(target.userId))
      .toEqual({ full_name: 'Updated name', role_id: target.roleId, theme: 'dark' })
  })

  it('does not accept arbitrary isAdmin or permissions fields through user updates', () => {
    const manager = actor([P.users.manage])
    const target = actor()
    const input = { fullName: 'Still limited', isAdmin: true, permissions: [P.users.manage] }
    updateUser(target.userId, input, manager.ctx)
    const session = login(target.username, 'secret123', ++windowId).session
    expect(session.user.isAdmin).toBe(false)
    expect(session.permissions).toEqual([])
  })

  it('preserves the last-administrator guard for authorized management', () => {
    const manager = actor([P.users.manage])
    rejectsLastAdmin(() => updateUser(env.ctx.session.user.id, { roleId: manager.roleId }, manager.ctx))
  })

  it('rejects creating a new Admin login through the alternate service path', () => {
    const limited = actor()
    rejectsWithoutWrites(() => createUser({ username: 'rogue-admin', password: 'secret123', fullName: 'Rogue', roleId: adminRoleId() }, limited.ctx))
  })

  it('rejects direct permission grants to the callers own role or another assigned role', () => {
    const limited = actor()
    const target = actor()
    for (const roleId of [limited.roleId, target.roleId]) {
      rejectsWithoutWrites(() => updateRole(roleId, { permissions: [P.users.manage] }, limited.ctx))
    }
  })

  it('requires users.manage as well as existing roles.manage for effective permission changes', () => {
    const roleManager = actor([P.roles.manage])
    const target = actor()
    rejectsWithoutWrites(() => updateRole(target.roleId, { permissions: [P.users.manage] }, roleManager.ctx))
    const userManager = actor([P.users.manage])
    rejectsWithoutWrites(() => updateRole(target.roleId, { permissions: [P.users.manage] }, userManager.ctx))
  })

  it('allows authorized role permissions and revokes affected sessions', () => {
    const manager = actor([P.users.manage, P.roles.manage])
    const target = actor()
    updateRole(target.roleId, { permissions: [P.reports.view] }, manager.ctx)
    expect(getSessionForWebContents(target.windowId)).toBeUndefined()
    expect(login(target.username, 'secret123', ++windowId).session.permissions).toEqual([P.reports.view])
  })

  it('preserves role-name-only editing with roles.manage', () => {
    const manager = actor([P.roles.manage])
    const target = actor()
    updateRole(target.roleId, { name: 'Renamed role' }, manager.ctx)
    expect(getRawConnection().prepare('SELECT name FROM roles WHERE id = ?').get(target.roleId)).toEqual({ name: 'Renamed role' })
  })

  it('preserves renderer-style role renames that resubmit unchanged permissions', async () => {
    const manager = actor([P.roles.manage])
    const target = actor([P.reports.view, P.materials.view])
    expect(await route(C.admin.updateRole, {
      id: target.roleId, name: 'Renamed through IPC',
      permissions: [P.materials.view, P.reports.view, P.reports.view]
    }, manager.windowId)).toMatchObject({ ok: true })
    expect(getRawConnection().prepare('SELECT name FROM roles WHERE id = ?').get(target.roleId))
      .toEqual({ name: 'Renamed through IPC' })
    expect(login(target.username, 'secret123', ++windowId).session.permissions.sort())
      .toEqual([P.materials.view, P.reports.view].sort())
  })

  it('does not treat removal of a legacy effective grant as an unchanged permission set', () => {
    const manager = actor([P.roles.manage])
    const target = actor()
    getRawConnection().prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)')
      .run(target.roleId, 'quotations.approve')
    rejectsWithoutWrites(() => updateRole(target.roleId, { permissions: ['quotations.approve'] }, manager.ctx))
  })

  it('guards direct role creation and preserves initial-setup refusal on an initialized database', () => {
    const limited = actor()
    rejectsWithoutWrites(() => createRole({ name: 'Forged role', permissions: [P.users.manage] }, limited.ctx))
    const before = snapshot()
    expect(() => performInitialSetup({ username: 'replacement-admin', password: 'secret123', fullName: 'Replacement' }))
      .toThrowError(expect.objectContaining({ code: 'CONFLICT' }))
    expect(snapshot()).toEqual(before)
  })

  it('keeps unauthorized IPC role assignment rejected with no side effects', async () => {
    const limited = actor()
    const before = snapshot()
    expect(await route(C.admin.updateUser, { id: limited.userId, roleId: adminRoleId() }, limited.windowId))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(snapshot()).toEqual(before)
  })

  it('keeps authorized IPC user management working', async () => {
    const manager = actor([P.users.manage])
    const target = actor()
    expect(await route(C.admin.updateUser, { id: target.userId, roleId: adminRoleId() }, manager.windowId))
      .toMatchObject({ ok: true })
    expect(login(target.username, 'secret123', ++windowId).session.user.isAdmin).toBe(true)
  })

  it('does not allow roles.manage-only IPC to bypass the user-privilege service guard', async () => {
    const manager = actor([P.roles.manage])
    const target = actor()
    const before = snapshot()
    expect(await route(C.admin.updateRole, { id: target.roleId, permissions: [P.users.manage] }, manager.windowId))
      .toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(snapshot()).toEqual(before)
  })
})

function rejectsLastAdmin(action: () => void) {
  const before = snapshot()
  expect(action).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))
  expect(snapshot()).toEqual(before)
}
