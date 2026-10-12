import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { NAV, canAccessNavItem } from '@renderer/routes/nav'
import { ensureDataDirectories } from '@main/files/paths'
import { getRawConnection } from '@main/db/connection'
import { reconcileDatabase } from '@main/db/reconciliation'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { getSessionForWebContents } from '@main/auth/session'
import { setSetting, getSetting, SETTING_KEYS } from '@main/services/settings.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

// Only the React session/provider shell is substituted. Session permissions
// come from real role/user authentication; every backend call uses registered
// handlers and migrated SQLite. Disposable Electron covers actual hash/nav/UI.
const display = vi.hoisted(() => ({ can: (_permission: string) => false }))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: display.can, logout: async () => undefined }) }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: () => undefined }) }))
import { BackupPage } from '@renderer/pages/backup/BackupPage'

const router = readFileSync('src/renderer/routes/router.tsx', 'utf8')
const ast = ts.createSourceFile('router.tsx', router, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function sourceFunction(name: string) {
  let found: ts.FunctionDeclaration | undefined
  function visit(n: ts.Node) { if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n; else ts.forEachChild(n, visit) }
  visit(ast); if (!found) throw Error(`Missing real router function ${name}`); return found.getText(ast)
}
let permissionText: string | undefined
function routePermission(n: ts.Node) {
  if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(ast) === 'Route' && n.getText(ast).includes('path="/backup"')) {
    const element = n.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText(ast) === 'element') as ts.JsxAttribute
    const expression = (element.initializer as ts.JsxExpression).expression as ts.CallExpression
    permissionText = expression.arguments[0]!.getText(ast)
  } else ts.forEachChild(n, routePermission)
}
routePermission(ast)
function route(can: (permission: string) => boolean) {
  const ctx = createContext({ React, NAV, P, canAccessNavItem, useSession: () => ({ can }), Navigate: ({ to }: { to: string }) => React.createElement('span', { 'data-redirect': to }) })
  runInContext(ts.transpileModule(sourceFunction('firstAuthorizedPath') + '\n' + sourceFunction('ProtectedPage'), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, ctx)
  ctx.permission = runInContext(permissionText!, ctx)
  return {
    markup: renderToStaticMarkup(runInContext('ProtectedPage({permission,children:"BACKUP PAGE"})', ctx)),
    start: runInContext('firstAuthorizedPath(useSession().can)', ctx) as string | undefined
  }
}
const profiles = [
  { name: 'restore', permissions: [P.backup.restore], create: false, restore: true },
  { name: 'create', permissions: [P.backup.create], create: true, restore: false },
  { name: 'both', permissions: [P.backup.create, P.backup.restore], create: true, restore: true },
  { name: 'neither', permissions: [], create: false, restore: false }
]
let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<IpcResult<unknown>>>
const raw = () => getRawConnection()
function snapshot() {
  const tables = raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  return Object.fromEntries(tables.map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
async function invoke(method: keyof typeof C.backup, sender: number, payload?: unknown) {
  return handlers.get(C.backup[method])!({ sender: { id: sender } } as IpcMainInvokeEvent, payload)
}
function actor(profile: typeof profiles[number]) {
  const role = createRole({ name: profile.name, permissions: profile.permissions }, env.ctx)
  createUser({ username: profile.name, password: 'secret123', fullName: profile.name, roleId: role }, env.ctx)
  const session = login(profile.name, 'secret123', 20).session
  const can = (permission: string) => session.user.isAdmin || session.permissions.includes(permission)
  return { session, can }
}
beforeEach(async () => {
  env = setupTestDatabase(); handlers = new Map()
  const electron = await import('electron')
  // Every temp/config/backup path stays inside this fixture, never shared user data.
  vi.spyOn(electron.app, 'getPath').mockImplementation(name => join(env.dir, name))
  ensureDataDirectories()
  vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => handlers.set(channel, handler)) as never)
  const { registerIpcRouter } = await import('@main/ipc/router'); registerIpcRouter()
})
afterEach(() => {
  try {
    expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); expect(raw().pragma('foreign_key_check')).toEqual([])
    expect(reconcileDatabase(raw()).findings).toEqual([])
  } finally { env.cleanup(); vi.restoreAllMocks() }
})
describe('UI-WF-04 real capabilities → actual route/page → registered backup owners', () => {
  it.each(profiles)('$name route, navigation, fallback and actual BackupPage controls agree', profile => {
    const { can } = actor(profile); display.can = can
    const allowed = profile.create || profile.restore
    expect(canAccessNavItem(NAV.flatMap(g => g.items).find(i => i.path === '/backup')!, can)).toBe(allowed)
    const guarded = route(can)
    expect(guarded.markup.includes('BACKUP PAGE')).toBe(allowed)
    if (allowed) expect(guarded.start).toBe('/backup')
    else { expect(guarded.start).toBeUndefined(); expect(guarded.markup).toContain('لا توجد أقسام متاحة') }
    const page = renderToStaticMarkup(React.createElement(BackupPage))
    expect(page.includes('إنشاء نسخة احتياطية الآن')).toBe(profile.create)
    expect(page.includes('استعادة من ملف…')).toBe(profile.restore)
  })
  it.each(profiles)('$name direct registered create/validate/restore preserves independent authorization', async profile => {
    actor(profile); const before = snapshot(); const target = join(env.dir, 'actor.aurabak')
    const validate = await invoke('validate', 20, { path: join(env.dir, 'missing.aurabak') })
    if (profile.restore) expect(validate).toMatchObject({ ok: true, data: { valid: false } })
    else expect(validate).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(snapshot()).toEqual(before)
    const restore = await invoke('restore', 20, { backupFilePath: join(env.dir, 'missing.aurabak') })
    expect(restore).toMatchObject({ ok: false, error: { code: profile.restore ? 'CONFLICT' : 'FORBIDDEN' } })
    expect(snapshot()).toEqual(before)
    const create = await invoke('create', 20, { destinationFilePath: target })
    if (profile.create) {
      expect(create.ok).toBe(true); expect(existsSync(target)).toBe(true)
      expect(raw().prepare("SELECT count(*) AS n FROM audit_log WHERE action='backup.create'").get()).toEqual({ n: 1 })
    } else { expect(create).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } }); expect(existsSync(target)).toBe(false); expect(snapshot()).toEqual(before) }
  })
  it.each(profiles)('$name fresh authentication retains capabilities without renderer permission grants', profile => {
    actor(profile); const fresh = login(profile.name, 'secret123', 21).session
    const can = (permission: string) => fresh.permissions.includes(permission)
    expect(fresh.user.isAdmin).toBe(false); expect(fresh.permissions).toEqual(expect.arrayContaining(profile.permissions))
    expect(can(P.backup.create)).toBe(profile.create); expect(can(P.backup.restore)).toBe(profile.restore)
    expect(route(can).markup.includes('BACKUP PAGE')).toBe(profile.create || profile.restore)
  })
  it('every unrelated single-permission nav entry retains its exact previous truth table', () => {
    for (const item of NAV.flatMap(g => g.items).filter(i => i.path !== '/backup')) {
      expect(Array.isArray(item.permission)).toBe(false)
      for (const grants of [[], item.permission ? [item.permission] : [], ['unrelated']]) {
        const can = (permission: string) => grants.includes(permission)
        expect(canAccessNavItem(item, can)).toBe(!item.permission || can(item.permission as string))
      }
    }
  })
  it('existing Users OR route remains OR; missing nav permission stays public and an empty union denies', () => {
    expect(router).toContain('protect([P.users.view, P.roles.view], <UsersPage />)')
    for (const permission of [P.users.view, P.roles.view]) {
      const can = (p: string) => p === permission
      const ctx = createContext({ React, NAV, P, canAccessNavItem, useSession: () => ({ can }), Navigate: () => null })
      runInContext(ts.transpileModule(sourceFunction('firstAuthorizedPath') + '\n' + sourceFunction('ProtectedPage'), { compilerOptions: { jsx: ts.JsxEmit.React } }).outputText, ctx)
      expect(renderToStaticMarkup(runInContext('ProtectedPage({permission:[P.users.view,P.roles.view],children:"USERS"})', ctx))).toBe('USERS')
    }
    expect(canAccessNavItem({ path: '/x', label: 'x', icon: 'x' }, () => false)).toBe(true)
    expect(canAccessNavItem({ path: '/x', label: 'x', icon: 'x', permission: [] }, () => true)).toBe(false)
  })
  it('restore-only completes a real disposable registered restore, revokes sessions and retains safety/audit behavior', async () => {
    const { session } = actor(profiles[0]!)
    setSetting(SETTING_KEYS.companyName, 'Snapshot company', env.ctx)
    const target = join(env.dir, 'safe-full-restore.aurabak')
    expect((await invoke('create', 1, { destinationFilePath: target })).ok).toBe(true)
    setSetting(SETTING_KEYS.companyName, 'Changed after snapshot', env.ctx)
    expect((await invoke('validate', 20, { path: target }))).toMatchObject({ ok: true, data: { valid: true } })
    const result = await invoke('restore', 20, { backupFilePath: target })
    if (!result.ok) throw Error(JSON.stringify(result))
    expect(result.ok).toBe(true)
    expect(existsSync((result.data as { safetyCopyPath: string }).safetyCopyPath)).toBe(true)
    expect(getSetting(SETTING_KEYS.companyName)).toBe('Snapshot company')
    expect(getSessionForWebContents(20)).toBeUndefined()
    const audit = raw().prepare("SELECT user_id, details FROM audit_log WHERE action='backup.restore' ORDER BY id DESC LIMIT 1").get() as { user_id: number | null; details: string }
    expect(audit.user_id).toBeNull(); expect(JSON.parse(audit.details).initiatedByPreviousEpoch).toMatchObject({ id: session.user.id, username: 'restore' })
  })
})
