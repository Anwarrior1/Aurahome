import { eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { getDatabase } from '../../db/connection'
import { users } from '../../db/schema/users.schema'
import { deleteAvatarFile, readAvatarFile, writeAvatarFile } from '../../files/avatar-storage'
import { AppError, notFound } from '../../utils/errors'
import { recordAuditEvent } from '../../audit/audit-log.service'
import type { ServiceContext } from '../base/service.types'

/**
 * Profile photo — strictly self-service. Every function here reads
 * and writes ONLY `ctx.session.user.id`, taken from the authenticated
 * session, never from a client-supplied id — there is no parameter a
 * manipulated request could substitute to reach another user's photo
 * (item "PER-USER OWNERSHIP").
 *
 * Storage: the managed file lives at
 * <userData>/files/avatars/<userId>.<ext> (files/paths.ts's own
 * getAvatarsRoot()) — never the user's original external path, never
 * a blob in the renderer or localStorage. `users.avatar_file_name`
 * stores only that managed filename. The renderer receives the image
 * as a `data:` URI over IPC (already allow-listed by the CSP's own
 * `img-src ... data:`), fetched fresh each time — nothing about the
 * photo is cached to disk or persistent storage on the renderer side.
 *
 * Two-stage flow (crop editor): the renderer never saves the file the
 * user picked as-is. `readImageForCrop` reads+validates the ORIGINAL
 * picked file and hands back a data: URI purely for the crop dialog's
 * preview (nothing is written to disk or the DB at this point). Once
 * the user confirms a crop, the renderer draws the final square onto
 * a canvas itself and sends THAT (still just a data: URI, still
 * untrusted renderer output) to `setMyPhoto`, which re-validates it
 * exactly the same way before writing anything.
 */

const MAX_BYTES = 2 * 1024 * 1024 // 2 MB — a profile photo, not a document scan.

const MIME_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

/**
 * The real type check — sniffs the file's own magic bytes rather than
 * trusting its extension or anything the OS file picker reported, so
 * a renamed/disguised file can never slip through as an image.
 */
function sniffImageExtension(bytes: Buffer): 'jpg' | 'png' | 'webp' | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) return 'webp'
  return undefined
}

/** Shared validation for any image byte payload, whichever of the two
 *  stages it came from — size cap first (cheap), then the real magic-
 *  byte sniff (never the claimed extension/mime). */
function validateImageBytes(bytes: Buffer): { ext: 'jpg' | 'png' | 'webp'; mime: string } {
  if (bytes.length === 0) throw new AppError('VALIDATION_ERROR', 'الملف فارغ')
  if (bytes.length > MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'حجم الصورة يتجاوز الحد المسموح به (2 ميغابايت)')
  }
  const ext = sniffImageExtension(bytes)
  if (!ext) throw new AppError('VALIDATION_ERROR', 'نوع الملف غير مدعوم — يُسمح فقط بصور JPG أو PNG أو WebP')
  return { ext, mime: MIME_BY_EXT[ext]! }
}

const DATA_URL_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/]+=*)$/

function decodeDataUrl(dataUrl: string): Buffer {
  const match = DATA_URL_RE.exec(dataUrl)
  if (!match) throw new AppError('VALIDATION_ERROR', 'صورة غير صالحة')
  try {
    return Buffer.from(match[1]!, 'base64')
  } catch {
    throw new AppError('VALIDATION_ERROR', 'صورة غير صالحة')
  }
}

/**
 * Reads the file the user just picked via the native OS dialog (a
 * path only ever obtained from files/dialogs.ts's pickProfileImage —
 * never a renderer-typed path), validates its real type/size, and
 * hands it back as a data: URI purely so the crop dialog has
 * something to display. Nothing is written to disk or the DB here —
 * this is preview-only; ownership doesn't even apply yet since no
 * user record is touched.
 */
export function readImageForCrop(sourcePath: string): { dataUrl: string } {
  let bytes: Buffer
  try {
    bytes = readFileSync(sourcePath)
  } catch {
    throw new AppError('VALIDATION_ERROR', 'تعذر قراءة الملف المحدد')
  }
  const { mime } = validateImageBytes(bytes)
  return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
}

/**
 * Saves the FINAL cropped/normalized image (a data: URI produced by
 * the renderer's own canvas from the user's confirmed crop — see
 * ProfilePhotoCropDialog.tsx). Still treated as fully untrusted input:
 * decoded, size-capped and magic-byte-sniffed exactly like the
 * original file was, before anything touches disk or the DB. Replaces
 * any previous managed photo for THIS user only, and records the new
 * one.
 */
export function setMyPhoto(dataUrl: string, ctx: ServiceContext): void {
  const bytes = decodeDataUrl(dataUrl)
  const { ext } = validateImageBytes(bytes)

  const userId = ctx.session.user.id
  const existing = getDatabase().select({ avatarFileName: users.avatarFileName }).from(users).where(eq(users.id, userId)).get()
  if (!existing) throw notFound('المستخدم غير موجود')

  // Deterministic per-user filename — always derived from the
  // authenticated session's own numeric id, never from anything in
  // the request, so this write path can never be steered elsewhere.
  const fileName = `${userId}.${ext}`

  // Publish safely before cleanup; restored references never become paths.
  writeAvatarFile(fileName, userId, bytes)
  if (existing.avatarFileName !== fileName) deleteAvatarFile(existing.avatarFileName, userId)

  getDatabase().update(users).set({ avatarFileName: fileName }).where(eq(users.id, userId)).run()
  recordAuditEvent({
    userId,
    action: 'profile.photo.set',
    entity: 'users',
    entityId: String(userId)
  })
}

export function removeMyPhoto(ctx: ServiceContext): void {
  const userId = ctx.session.user.id
  const existing = getDatabase().select({ avatarFileName: users.avatarFileName }).from(users).where(eq(users.id, userId)).get()
  if (!existing) throw notFound('المستخدم غير موجود')
  if (!existing.avatarFileName) return // nothing to remove — a harmless no-op, not an error

  deleteAvatarFile(existing.avatarFileName, userId)
  getDatabase().update(users).set({ avatarFileName: null }).where(eq(users.id, userId)).run()
  recordAuditEvent({
    userId,
    action: 'profile.photo.remove',
    entity: 'users',
    entityId: String(userId)
  })
}

/** The current user's own photo as a data: URI — `null` when they
 *  have none, never an error (the default avatar is the renderer's
 *  own concern to render in that case). */
export function getMyPhoto(ctx: ServiceContext): { dataUrl: string | null } {
  const userId = ctx.session.user.id
  const existing = getDatabase().select({ avatarFileName: users.avatarFileName }).from(users).where(eq(users.id, userId)).get()
  if (!existing?.avatarFileName) return { dataUrl: null }

  const bytes = readAvatarFile(existing.avatarFileName, userId, MAX_BYTES)
  if (!bytes) return { dataUrl: null } // missing/unsafe references are read-only fallbacks

  const ext = existing.avatarFileName.split('.').pop() ?? ''
  const mime = MIME_BY_EXT[ext]!
  return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
}
