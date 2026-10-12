import { randomBytes, createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDatabase } from '../db/connection'
import { rememberTokens } from '../db/schema/users.schema'

/**
 * "تذكرني" — Remember Me persistence, database half. The raw token
 * never reaches this module's return value on issue except once, to
 * be written straight to the OS-encrypted local file (see
 * remember-file.ts) — only its SHA-256 hash is ever persisted, and a
 * resume attempt re-hashes what it read back and looks that up here.
 * A random 256-bit token has effectively unguessable entropy, so a
 * fast cryptographic hash is the right tool (unlike a low-entropy
 * user password, which needs the slow scrypt in password.ts).
 */
const TOKEN_BYTES = 32
const TTL_DAYS = 30

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

/** Issues a brand-new token for this user and returns the RAW value —
 *  the only time it ever exists outside the encrypted local file. */
export function issueRememberToken(userId: number): string {
  const rawToken = randomBytes(TOKEN_BYTES).toString('hex')
  getDatabase()
    .insert(rememberTokens)
    .values({ userId, tokenHash: hashToken(rawToken), expiresAt: addDays(TTL_DAYS) })
    .run()
  return rawToken
}

/**
 * Verifies a raw token read back off disk. A valid, unexpired token
 * slides its expiry forward another full window (so an actively-used
 * "remember me" never hits a hard cliff) and is stamped with when it
 * was used; an unknown or expired one is refused and, if expired,
 * cleaned up on the spot.
 */
export function consumeRememberToken(rawToken: string): { userId: number } | undefined {
  const tokenHash = hashToken(rawToken)
  const row = getDatabase().select().from(rememberTokens).where(eq(rememberTokens.tokenHash, tokenHash)).get()
  if (!row) return undefined

  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    getDatabase().delete(rememberTokens).where(eq(rememberTokens.id, row.id)).run()
    return undefined
  }

  getDatabase()
    .update(rememberTokens)
    .set({ expiresAt: addDays(TTL_DAYS), lastUsedAt: new Date().toISOString() })
    .where(eq(rememberTokens.id, row.id))
    .run()
  return { userId: row.userId }
}

/**
 * Revokes every remembered login for a user — called everywhere a
 * live session is already force-revoked (password change, role
 * change, deactivation, deletion — see users.service.ts) and on
 * logout, so "remember me" can never outlive the access it grants.
 */
export function revokeRememberTokensForUser(userId: number): void {
  getDatabase().delete(rememberTokens).where(eq(rememberTokens.userId, userId)).run()
}
