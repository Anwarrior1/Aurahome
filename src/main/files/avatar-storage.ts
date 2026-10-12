import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, unlinkSync, writeFileSync, type Stats
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAvatarsRoot, getFilesRoot } from './paths'
import { AppError } from '../utils/errors'

/** Only the existing server-generated basename for THIS user is a reference. */
export function isManagedAvatarName(name: unknown, userId: number): name is string {
  return Number.isSafeInteger(userId) && userId > 0 && typeof name === 'string' &&
    ['jpg', 'png', 'webp'].some((ext) => name === `${userId}.${ext}`)
}

function storageRoot(create = false): string | undefined {
  try {
    const userData = dirname(getFilesRoot())
    if (create) mkdirSync(userData, { recursive: true })
    // userData is the trusted platform anchor (e.g. /tmp may itself be an alias).
    let root = realpathSync(userData)
    for (const directory of [getFilesRoot(), getAvatarsRoot()]) {
      const next = join(root, basename(directory))
      if (create) {
        try { mkdirSync(next) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      const stat = lstatSync(next)
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(next) !== next) return undefined
      root = next
    }
    return root
  } catch { return undefined }
}

function regularFile(path: string): Stats | undefined {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 ? stat : undefined
  } catch { return undefined }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

export function readAvatarFile(name: unknown, userId: number, maxBytes: number): Buffer | undefined {
  if (!isManagedAvatarName(name, userId)) return undefined
  const root = storageRoot()
  if (!root) return undefined
  const path = join(root, name)
  const before = regularFile(path)
  if (!before) return undefined
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened) ||
      opened.size > maxBytes || storageRoot() !== root || realpathSync(path) !== path) return undefined
    // Read the validated descriptor, not a path that could now name another target.
    return readFileSync(fd)
  } catch { return undefined }
  finally { if (fd !== undefined) closeSync(fd) }
}

export function deleteAvatarFile(name: unknown, userId: number): void {
  if (!isManagedAvatarName(name, userId)) return
  const root = storageRoot()
  if (!root) return
  const path = join(root, name)
  const before = regularFile(path)
  if (!before) return
  // A final-component symlink is never followed by unlink. Recheck parents and
  // identity immediately before it; arbitrary concurrent OS directory mutation
  // still requires OS ACLs (Node does not expose directory-relative unlinkat).
  if (storageRoot() !== root) return
  const current = regularFile(path)
  if (!current || !sameFile(before, current)) return
  unlinkSync(path)
}

export function writeAvatarFile(name: string, userId: number, bytes: Buffer): void {
  const unsafe = () => new AppError('VALIDATION_ERROR', 'تعذر حفظ الصورة في مجلد الصور المُدار')
  if (!isManagedAvatarName(name, userId)) throw unsafe()
  const root = storageRoot(true)
  if (!root) throw unsafe()
  const path = join(root, name)
  function checkDestination(): void {
    if (storageRoot() !== root) throw unsafe()
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unsafe()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  checkDestination()
  const temporary = join(root, `.${userId}.${randomUUID()}.avatar-tmp`)
  let fd: number | undefined
  let created = false
  try {
    // Exclusive creation cannot overwrite/follow a pre-existing temporary leaf.
    fd = openSync(temporary, 'wx', 0o600)
    created = true
    writeFileSync(fd, bytes)
    closeSync(fd)
    fd = undefined
    checkDestination()
    renameSync(temporary, path)
    created = false
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (created && storageRoot() === root) unlinkSync(temporary)
  }
}
