import { safeStorage } from 'electron'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigRoot } from '../files/paths'
import { logger } from '../utils/logger'

/**
 * "تذكرني" — Remember Me persistence, local-file half. The raw token
 * (see remember-token.ts) is never written to disk in the clear and
 * never touches localStorage/the renderer at all: it is encrypted
 * with Electron's `safeStorage`, which defers to the OS's own secret
 * store (macOS Keychain, Windows DPAPI, libsecret on Linux), and only
 * that ciphertext is written under the app's own config directory —
 * the same tree every other non-secret local setting already lives
 * in, never inside the installed application directory.
 *
 * Every read/delete below is a single guarded filesystem call rather
 * than an existsSync() check followed by a separate operation — that
 * two-step shape is a real TOCTOU race (the file can vanish between
 * the check and the use) and not just a theoretical one.
 */
function tokenFilePath(): string {
  return join(getConfigRoot(), 'remember-token.enc')
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

export function saveRememberTokenToDisk(rawToken: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // No OS secret store available on this machine — "remember me"
    // simply does not persist here rather than falling back to an
    // unencrypted file. Login itself is completely unaffected.
    logger.warn('safeStorage unavailable — "remember me" will not persist on this machine')
    return
  }
  // Normally already created by ensureDataDirectories() at app boot —
  // guarded here too so this module never depends on that ordering.
  mkdirSync(getConfigRoot(), { recursive: true })
  writeFileSync(tokenFilePath(), safeStorage.encryptString(rawToken))
}

export function readRememberTokenFromDisk(): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  let encrypted: Buffer
  try {
    encrypted = readFileSync(tokenFilePath())
  } catch (error) {
    if (!isMissingFileError(error)) logger.warn('Failed to read the stored "remember me" token', error)
    return undefined
  }
  try {
    return safeStorage.decryptString(encrypted)
  } catch (error) {
    logger.warn('Failed to decrypt the stored "remember me" token — discarding it', error)
    clearRememberTokenFromDisk()
    return undefined
  }
}

export function clearRememberTokenFromDisk(): void {
  try {
    unlinkSync(tokenFilePath())
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }
}
