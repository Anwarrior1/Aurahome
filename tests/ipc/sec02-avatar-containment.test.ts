import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { getAvatarsRoot, getFilesRoot, ensureDataDirectories } from '@main/files/paths'
import { isManagedAvatarName } from '@main/files/avatar-storage'
import { setMyPhoto, removeMyPhoto, getMyPhoto } from '@main/services/profile/profile.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { createBackup, validateBackup } from '@main/backup/backup.service'
import { restoreFromBackup } from '@main/restore/restore.service'

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }))

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
const CANARY = Buffer.from('SEC02 harmless external canary')
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const data = (bytes = PNG) => `data:image/png;base64,${bytes.toString('base64')}`
let env: TestEnv, userData: string, canary: string, userId: number
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 84000
let event: IpcMainInvokeEvent
beforeEach(async () => {
  env = setupTestDatabase()
  userData = join(env.dir, 'profile-data')
  fs.mkdirSync(userData)
  fs.mkdirSync(join(userData, 'config'))
  vi.spyOn(app, 'getPath').mockImplementation(() => userData)
  userId = env.ctx.session.user.id
  canary = join(userData, 'external.png')
  fs.writeFileSync(canary, CANARY)
  event = { sender: { id: ++windowId } } as IpcMainInvokeEvent
  handlers = new Map()
  const capture = vi.spyOn(ipcMain, 'handle').mockImplementation(((channel: string, fn: never) => handlers.set(channel, fn)) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  capture.mockRestore()
})
afterEach(() => { vi.restoreAllMocks(); env.cleanup() })
function metadata(name: string | null, id = userId) { getRawConnection().prepare('UPDATE users SET avatar_file_name=? WHERE id=?').run(name, id) }
function reference(id = userId) { return (getRawConnection().prepare('SELECT avatar_file_name AS name FROM users WHERE id=?').get(id) as { name: string | null }).name }
function snapshot() {
  const db = getRawConnection()
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => {
    const name = (row as { name: string }).name
    return [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]
  })
}
function auditCount() { return (getRawConnection().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'profile.photo.%'").get() as { n: number }).n }
function unchangedCanary() { expect(fs.readFileSync(canary)).toEqual(CANARY) }
function call(channel: string, request?: unknown) { return handlers.get(channel)!(event, request) }

describe('SEC-02 persisted avatar reference containment', () => {
  it.each([
    '../external.png', '../../external.png', 'nested/../../../external.png', '/absolute.png',
    '..\\external.png', '..\\..\\external.png', 'C:\\external.png', 'C:/external.png',
    '\\\\server\\share\\external.png', '//server/share/external.png', '..\\../external.png',
    '..%2f..%2fexternal.png', '..%5c..%5cexternal.png', '%252e%252e%252fexternal.png',
    '', '.', '..', 'external.png', '1.jpeg', '1.PNG', '01.png', '2.png', '1.png/..', '1.png\0', '１.png'
  ])('ignores %j on read and skips unsafe cleanup on explicit remove/replacement', (name) => {
    metadata(name)
    const before = snapshot()
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
    expect(snapshot()).toEqual(before)
    removeMyPhoto(env.ctx)
    unchangedCanary()
    expect(auditCount()).toBe(name ? 1 : 0)
    metadata(name)
    const audits = auditCount()
    setMyPhoto(data(), env.ctx)
    expect(reference()).toBe(`${userId}.png`)
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: data() })
    expect(auditCount()).toBe(audits + 1)
    unchangedCanary()
  })
  it('blocks the original exact canary reference with no read mutation', () => {
    metadata('../../external.png')
    const before = snapshot()
    expect(getMyPhoto(env.ctx).dataUrl).toBeNull()
    expect(snapshot()).toEqual(before)
    unchangedCanary()
  })
  it('rejects an actual absolute canary path without examining that external file', () => {
    metadata(canary)
    expect(getMyPhoto(env.ctx).dataUrl).toBeNull()
    removeMyPhoto(env.ctx)
    unchangedCanary()
  })
  it('accepts only the three legitimate current/historical generated names for the real user', () => {
    for (const ext of ['jpg', 'png', 'webp']) expect(isManagedAvatarName(`${userId}.${ext}`, userId)).toBe(true)
    expect(isManagedAvatarName(`${userId + 1}.png`, userId)).toBe(false)
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(isManagedAvatarName(`${id}.png`, id)).toBe(false)
  })
  it('round-trips generated bytes, replaces same/different extensions, and removes exactly once', () => {
    setMyPhoto(data(), env.ctx)
    setMyPhoto(data(JPG), env.ctx)
    expect(fs.readdirSync(getAvatarsRoot())).toEqual([`${userId}.jpg`])
    expect(getMyPhoto(env.ctx).dataUrl).toBe(`data:image/jpeg;base64,${JPG.toString('base64')}`)
    setMyPhoto(data(JPG), env.ctx)
    const unlink = vi.spyOn(fs, 'unlinkSync')
    removeMyPhoto(env.ctx)
    removeMyPhoto(env.ctx)
    expect(unlink).toHaveBeenCalledOnce()
    expect(fs.readdirSync(getAvatarsRoot())).toEqual([])
    expect(auditCount()).toBe(4)
    unchangedCanary()
  })
  it('keeps a missing legitimate reference as a read-only null fallback', () => {
    metadata(`${userId}.png`)
    const before = snapshot()
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
    expect(snapshot()).toEqual(before)
  })
  it('uses freshly persisted metadata after the crop editor could have been opened', () => {
    setMyPhoto(data(), env.ctx)
    metadata('../../external.png')
    setMyPhoto(data(JPG), env.ctx)
    expect(reference()).toBe(`${userId}.jpg`)
    unchangedCanary()
  })
  it('cleans exclusive staging on failed write, preserving the old file, metadata and audit', () => {
    setMyPhoto(data(), env.ctx)
    const before = snapshot()
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('bounded write failure') })
    expect(() => setMyPhoto(data(JPG), env.ctx)).toThrow('bounded write failure')
    expect(snapshot()).toEqual(before)
    expect(fs.readdirSync(getAvatarsRoot())).toEqual([`${userId}.png`])
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: data() })
  })
})

describe('SEC-02 symlink, hardlink and special-file safety', () => {
  it('never follows or deletes a target symlink and refuses overwrite through it', () => {
    fs.mkdirSync(getAvatarsRoot(), { recursive: true })
    const target = join(getAvatarsRoot(), `${userId}.png`)
    fs.symlinkSync(canary, target)
    metadata(`${userId}.png`)
    const before = snapshot()
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
    expect(() => setMyPhoto(data(), env.ctx)).toThrowError(/مجلد الصور/)
    expect(snapshot()).toEqual(before)
    removeMyPhoto(env.ctx)
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true)
    unchangedCanary()
  })
  for (const directory of ['avatars', 'files'] as const) {
    it(`rejects a symlinked ${directory} directory before read/write/delete`, () => {
      const outside = join(userData, 'outside')
      fs.mkdirSync(outside)
      const destination = directory === 'files' ? join(outside, 'avatars') : outside
      fs.mkdirSync(destination, { recursive: true })
      const external = join(destination, `${userId}.png`)
      fs.writeFileSync(external, PNG)
      fs.mkdirSync(directory === 'files' ? userData : getFilesRoot(), { recursive: true })
      fs.symlinkSync(outside, directory === 'files' ? getFilesRoot() : getAvatarsRoot(), 'dir')
      metadata(`${userId}.png`)
      const before = snapshot()
      expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
      expect(() => setMyPhoto(data(JPG), env.ctx)).toThrowError(/مجلد الصور/)
      expect(snapshot()).toEqual(before)
      removeMyPhoto(env.ctx)
      expect(fs.readFileSync(external)).toEqual(PNG)
      expect(fs.readdirSync(destination)).toEqual([`${userId}.png`])
      unchangedCanary()
    })
  }
  it('startup does not recursively create avatar directories through a files symlink', () => {
    const outside = join(userData, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, getFilesRoot(), 'dir')
    ensureDataDirectories()
    expect(fs.readdirSync(outside)).toEqual([])
  })
  it('does not read/write/unlink an external hardlink alias', () => {
    fs.mkdirSync(getAvatarsRoot(), { recursive: true })
    const target = join(getAvatarsRoot(), `${userId}.png`)
    fs.linkSync(canary, target)
    metadata(`${userId}.png`)
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
    expect(() => setMyPhoto(data(), env.ctx)).toThrowError(/مجلد الصور/)
    removeMyPhoto(env.ctx)
    expect(fs.existsSync(target)).toBe(true)
    unchangedCanary()
  })
  it('rejects a directory posing as a managed image', () => {
    fs.mkdirSync(join(getAvatarsRoot(), `${userId}.png`), { recursive: true })
    metadata(`${userId}.png`)
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
    expect(() => setMyPhoto(data(), env.ctx)).toThrowError(/مجلد الصور/)
    removeMyPhoto(env.ctx)
    expect(fs.lstatSync(join(getAvatarsRoot(), `${userId}.png`)).isDirectory()).toBe(true)
  })
  it('pins the read descriptor when the path is replaced after it is opened', () => {
    setMyPhoto(data(), env.ctx)
    const target = join(getAvatarsRoot(), `${userId}.png`)
    const displaced = join(getAvatarsRoot(), 'displaced.png')
    const realRead = fs.readFileSync
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(((fd: number) => {
      expect(typeof fd).toBe('number')
      fs.renameSync(target, displaced)
      fs.symlinkSync(canary, target)
      return realRead(fd)
    }) as never)
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: data() })
    expect(read).toHaveBeenCalledOnce()
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
    unchangedCanary()
  })
})

describe('SEC-02 real registered IPC and backup/restore preservation', () => {
  function signIn() { return login('owner', 'secret123', windowId) }
  it('unauthenticated image read/write/delete and backup restore are rejected without state changes', async () => {
    const before = snapshot()
    for (const [channel, request] of [[C.profile.getMyPhoto, {}], [C.profile.setPhoto, { dataUrl: data() }], [C.profile.removePhoto, {}], [C.backup.restore, { backupFilePath: join(env.dir, 'missing.aurabak') }]] as const) {
      expect(await call(channel, request)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
    }
    expect(snapshot()).toEqual(before)
    unchangedCanary()
  })
  it('a restricted real actor has only self access; payload user IDs cannot affect another profile', async () => {
    setMyPhoto(data(), env.ctx)
    const roleId = createRole({ name: 'SEC02 restricted', permissions: [] }, env.ctx)
    const second = createUser({ username: 'sec02', fullName: 'SEC02', password: 'secret123', roleId }, env.ctx)
    login('sec02', 'secret123', windowId)
    expect(await call(C.profile.getMyPhoto, { userId })).toMatchObject({ ok: true, data: { dataUrl: null } })
    expect((await call(C.profile.setPhoto, { dataUrl: data(JPG), userId, id: userId, isAdmin: true })).ok).toBe(true)
    expect(reference()).toBe(`${userId}.png`)
    expect(reference(second)).toBe(`${second}.jpg`)
    expect(await call(C.backup.restore, { backupFilePath: join(env.dir, 'missing.aurabak') })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await call(C.backup.validate, { path: join(env.dir, 'missing.aurabak') })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    unchangedCanary()
  })
  it('registered IPC safely ignores already-persisted traversal without read/database/audit effects', async () => {
    signIn()
    metadata('../../external.png')
    const before = snapshot()
    expect(await call(C.profile.getMyPhoto)).toEqual({ ok: true, data: { dataUrl: null } })
    expect(snapshot()).toEqual(before)
    expect((await call(C.profile.removePhoto)).ok).toBe(true)
    unchangedCanary()
  })
  it('legitimate backups retain valid avatar references and restore real owned image behavior', async () => {
    setMyPhoto(data(), env.ctx)
    const archive = await createBackup({ destinationFilePath: join(env.dir, 'valid.aurabak') }, env.ctx)
    expect((await validateBackup(archive.path)).valid).toBe(true)
    await restoreFromBackup({ backupFilePath: archive.path }, env.ctx)
    const { session } = signIn()
    expect(getMyPhoto({ session })).toEqual({ dataUrl: data() })
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
  it('unsafe restored metadata remains inert; no format rewrite or automatic data repair', async () => {
    metadata('../../external.png')
    const archive = await createBackup({ destinationFilePath: join(env.dir, 'unsafe-reference.aurabak') }, env.ctx)
    expect((await validateBackup(archive.path)).valid).toBe(true)
    metadata(null)
    signIn()
    expect((await call(C.backup.restore, { backupFilePath: archive.path })).ok).toBe(true)
    expect(await call(C.profile.getMyPhoto)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
    signIn()
    expect(reference()).toBe('../../external.png')
    const before = snapshot()
    expect(await call(C.profile.getMyPhoto)).toEqual({ ok: true, data: { dataUrl: null } })
    expect(snapshot()).toEqual(before)
    unchangedCanary()
    expect((await call(C.profile.setPhoto, { dataUrl: data() })).ok).toBe(true)
    unchangedCanary()
    expect(reference()).toBe(`${userId}.png`)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})
