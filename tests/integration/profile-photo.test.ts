import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { getAvatarsRoot } from '@main/files/paths'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { setMyPhoto, removeMyPhoto, getMyPhoto, readImageForCrop } from '@main/services/profile/profile.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

/**
 * Profile photo: the managed file lives under getAvatarsRoot()
 * (<userData>/files/avatars/<userId>.<ext>) and every operation acts
 * only on the CALLING session's own user id — there is no id
 * parameter anywhere in setMyPhoto/removeMyPhoto/getMyPhoto a
 * manipulated request could redirect to someone else's photo.
 *
 * Two-stage flow: readImageForCrop(path) validates+reads the
 * ORIGINAL picked file and returns a preview data: URI, writing
 * nothing. setMyPhoto(dataUrl, ctx) takes the FINAL cropped image
 * (still a data: URI, still re-validated the same way) and is the
 * only function that actually persists anything.
 */
let env: TestEnv
let sourceDir: string
let seq = 0
beforeEach(() => {
  env = setupTestDatabase()
  sourceDir = mkdtempSync(join(tmpdir(), 'aura-profile-src-'))
  seq = 0
})
afterEach(() => {
  env.cleanup()
  rmSync(sourceDir, { recursive: true, force: true })
  rmSync(getAvatarsRoot(), { recursive: true, force: true })
})

function unique(prefix: string): string { return `${prefix}-${++seq}` }

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xaa, 0xbb, 0xcc, 0xdd])
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xaa, 0xbb, 0xcc, 0xdd])
const WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0xaa, 0xbb, 0xcc, 0xdd
])
const NOT_AN_IMAGE_BYTES = Buffer.from('هذا ملف نصي عادي، ليس صورة على الإطلاق', 'utf8')

function writeSourceFile(name: string, bytes: Buffer): string {
  const path = join(sourceDir, name)
  writeFileSync(path, bytes)
  return path
}

/** Simulates the renderer's canvas output — a data: URI, exactly the
 *  shape setMyPhoto actually receives from the crop dialog. */
function toDataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}
function jpegDataUrl(bytes: Buffer): string { return toDataUrl('image/jpeg', bytes) }
function pngDataUrl(bytes: Buffer): string { return toDataUrl('image/png', bytes) }

function secondUserSession(permissions: string[] = []) {
  const roleId = createRole({ name: unique('role'), permissions }, env.ctx)
  const username = unique('user')
  createUser({ username, password: 'secret789', fullName: 'مستخدم آخر', roleId }, env.ctx)
  return login(username, 'secret789', 2).session
}

describe('1 — no photo means no photo, cleanly', () => {
  it('a brand-new user has no photo', () => {
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
  })
})

describe('2 — valid JPG/PNG/WebP crop-preview reads and final saves all work', () => {
  it('readImageForCrop accepts a JPEG and returns it as a data: URI, without writing anything', () => {
    const { dataUrl } = readImageForCrop(writeSourceFile('a.jpg', JPEG_BYTES))
    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null }) // preview-only — nothing saved yet
  })

  it('readImageForCrop accepts a PNG and a WebP too', () => {
    expect(readImageForCrop(writeSourceFile('a.png', PNG_BYTES)).dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(readImageForCrop(writeSourceFile('a.webp', WEBP_BYTES)).dataUrl).toMatch(/^data:image\/webp;base64,/)
  })

  it('setMyPhoto saves the final cropped data: URI and it round-trips through getMyPhoto', () => {
    setMyPhoto(jpegDataUrl(JPEG_BYTES), env.ctx)
    expect(getMyPhoto(env.ctx).dataUrl).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('the real bytes are sniffed at BOTH stages — a .jpg-named source file with the wrong content is refused by readImageForCrop', () => {
    const path = writeSourceFile('disguised.jpg', NOT_AN_IMAGE_BYTES)
    expect(() => readImageForCrop(path)).toThrowError(/نوع الملف غير مدعوم/)
  })

  it('setMyPhoto refuses a data: URI whose payload is not a real image, even though the wrapper looks valid', () => {
    const fakeDataUrl = `data:image/jpeg;base64,${NOT_AN_IMAGE_BYTES.toString('base64')}`
    expect(() => setMyPhoto(fakeDataUrl, env.ctx)).toThrowError(/نوع الملف غير مدعوم/)
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
  })
})

describe('3 — invalid input is rejected cleanly, nothing is saved', () => {
  it('readImageForCrop: a non-image source file is refused', () => {
    const path = writeSourceFile('not-image.txt', NOT_AN_IMAGE_BYTES)
    expect(() => readImageForCrop(path)).toThrowError(/نوع الملف غير مدعوم/)
  })

  it('readImageForCrop: a missing/unreadable path is refused cleanly, not an unhandled crash', () => {
    expect(() => readImageForCrop(join(sourceDir, 'does-not-exist.jpg'))).toThrowError(/تعذر قراءة الملف/)
  })

  it('setMyPhoto: a malformed (non data:image) payload is refused cleanly', () => {
    expect(() => setMyPhoto('not-a-data-url', env.ctx)).toThrowError(/صورة غير صالحة/)
    expect(() => setMyPhoto('data:text/plain;base64,aGVsbG8=', env.ctx)).toThrowError(/صورة غير صالحة/)
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
  })
})

describe('4 — oversized payloads are rejected', () => {
  it('readImageForCrop refuses a source file larger than the configured limit (2 MB)', () => {
    const big = Buffer.concat([JPEG_BYTES, Buffer.alloc(2 * 1024 * 1024)])
    const path = writeSourceFile('big.jpg', big)
    expect(() => readImageForCrop(path)).toThrowError(/حجم الصورة يتجاوز الحد المسموح به/)
  })

  it('setMyPhoto refuses a final cropped image larger than the configured limit (2 MB)', () => {
    const big = Buffer.concat([JPEG_BYTES, Buffer.alloc(2 * 1024 * 1024)])
    expect(() => setMyPhoto(jpegDataUrl(big), env.ctx)).toThrowError(/حجم الصورة يتجاوز الحد المسموح به/)
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
  })
})

describe('5 — different users have fully independent photos', () => {
  it('user A\'s photo is invisible to user B and vice versa', () => {
    setMyPhoto(jpegDataUrl(JPEG_BYTES), env.ctx)
    const other = secondUserSession()
    expect(getMyPhoto({ session: other }).dataUrl).toBeNull()

    setMyPhoto(pngDataUrl(PNG_BYTES), { session: other })
    expect(getMyPhoto({ session: other }).dataUrl).toMatch(/^data:image\/png/)
    // The original owner's own photo is unaffected by the other user's upload.
    expect(getMyPhoto(env.ctx).dataUrl).toMatch(/^data:image\/jpeg/)
  })

  it('there is no id parameter to manipulate — every call only ever touches the caller\'s own session user', () => {
    const other = secondUserSession()
    setMyPhoto(jpegDataUrl(JPEG_BYTES), env.ctx)
    // removeMyPhoto/setMyPhoto take no user id at all; calling them
    // with the OTHER session can only ever affect that other session's
    // own user, never the first one's.
    removeMyPhoto({ session: other })
    expect(getMyPhoto(env.ctx).dataUrl).toMatch(/^data:image\/jpeg/) // untouched
  })
})

describe('6 — replacing a photo cleans up the previous managed file', () => {
  it('the old file is gone from disk after a replacement, the new one is the only one present', () => {
    setMyPhoto(jpegDataUrl(JPEG_BYTES), env.ctx)
    const avatarsBefore = readdirSync(getAvatarsRoot())
    expect(avatarsBefore).toHaveLength(1)
    const oldFileName = avatarsBefore[0]

    // Replace with a DIFFERENT format — the extension changes too.
    setMyPhoto(pngDataUrl(PNG_BYTES), env.ctx)

    expect(existsSync(join(getAvatarsRoot(), oldFileName))).toBe(false)
    const avatarsAfter = readdirSync(getAvatarsRoot())
    expect(avatarsAfter).toHaveLength(1)
    expect(getMyPhoto(env.ctx).dataUrl).toMatch(/^data:image\/png/)
  })
})

describe('7 — removing a photo restores the fallback state and cleans up the file', () => {
  it('removeMyPhoto clears the reference and deletes the managed file', () => {
    setMyPhoto(jpegDataUrl(JPEG_BYTES), env.ctx)
    expect(readdirSync(getAvatarsRoot())).toHaveLength(1)

    removeMyPhoto(env.ctx)

    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
    expect(readdirSync(getAvatarsRoot())).toHaveLength(0)
  })

  it('removing when there is no photo is a harmless no-op', () => {
    expect(() => removeMyPhoto(env.ctx)).not.toThrow()
    expect(getMyPhoto(env.ctx)).toEqual({ dataUrl: null })
  })

  it('never deletes an unrelated user\'s managed file', () => {
    const other = secondUserSession()
    setMyPhoto(jpegDataUrl(JPEG_BYTES), env.ctx)
    setMyPhoto(pngDataUrl(PNG_BYTES), { session: other })
    expect(readdirSync(getAvatarsRoot())).toHaveLength(2)

    removeMyPhoto(env.ctx)

    expect(readdirSync(getAvatarsRoot())).toHaveLength(1)
    expect(getMyPhoto({ session: other }).dataUrl).toMatch(/^data:image\/png/)
  })
})

describe('8 — the photo survives independently of any particular session (restart / logout-login)', () => {
  it('a fresh login for the same user still resolves the same stored photo', () => {
    setMyPhoto(jpegDataUrl(JPEG_BYTES), env.ctx)
    const before = getMyPhoto(env.ctx).dataUrl

    // Simulate "logout, then log back in" — a brand new session/auth
    // for the SAME underlying user, nothing about the photo re-sent.
    const resumed = login('owner', 'secret123', 5)
    expect(getMyPhoto({ session: resumed.session }).dataUrl).toBe(before)
  })
})

describe('9 — RBAC/permissions are untouched by this feature', () => {
  it('a low-privilege user can still manage only their own photo with no special permission required', () => {
    const other = secondUserSession([P.reports.view])
    expect(() => setMyPhoto(jpegDataUrl(JPEG_BYTES), { session: other })).not.toThrow()
  })
})

describe('10 — database integrity', () => {
  it('leaves foreign_key_check clean and integrity_check ok after a full photo lifecycle', () => {
    setMyPhoto(jpegDataUrl(JPEG_BYTES), env.ctx)
    setMyPhoto(pngDataUrl(PNG_BYTES), env.ctx)
    removeMyPhoto(env.ctx)

    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})
