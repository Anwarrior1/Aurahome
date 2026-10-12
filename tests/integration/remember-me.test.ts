import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { rememberTokens } from '@main/db/schema/users.schema'
import { login, logout, tryResumeSession } from '@main/auth/auth.service'
import { issueRememberToken } from '@main/auth/remember-token'
import { createRole, createUser, updateUser, deleteUser } from '@main/services/admin/users.service'
import {
  saveRememberTokenToDisk,
  readRememberTokenFromDisk,
  clearRememberTokenFromDisk
} from '@main/auth/remember-file'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

/**
 * "تذكرني" — Remember Me. A checked login issues a random 256-bit
 * token; only its SHA-256 hash is stored (remember_tokens.token_hash);
 * the raw value is written straight to an OS-encrypted local file
 * (safeStorage — mocked to a reversible stand-in in tests, see
 * tests/mocks/electron.ts) and never appears anywhere in the
 * database. tryResumeSession() is the exact mechanism a fresh window
 * uses to silently resume it, exactly like a real login otherwise.
 */
let env: TestEnv
let seq = 0
beforeEach(() => { env = setupTestDatabase(); seq = 0 })
afterEach(() => { clearRememberTokenFromDisk(); env.cleanup() })

function unique(prefix: string): string { return `${prefix}-${++seq}` }

describe('1 — an unchecked login leaves nothing to resume', () => {
  it('logging in without rememberMe creates no token and nothing to resume on a fresh window', () => {
    login('owner', 'secret123', 2) // rememberMe omitted → false
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM remember_tokens').get()).toEqual({ c: 0 })
    expect(readRememberTokenFromDisk()).toBeUndefined()
    expect(tryResumeSession(3)).toBeUndefined()
  })
})

describe('2 — a checked login can be silently resumed on a new window', () => {
  it('tryResumeSession opens a real session for a different webContentsId, exactly like a password login', () => {
    const result = login('owner', 'secret123', 2, true)
    expect(readRememberTokenFromDisk()).toBeTruthy()

    const resumed = tryResumeSession(99)
    expect(resumed).toBeDefined()
    expect(resumed!.session.user.username).toBe('owner')
    expect(resumed!.session.sessionId).not.toBe(result.session.sessionId) // its own real session
    expect(resumed!.theme).toBe(result.theme)
  })

  it('resuming twice keeps working (sliding expiry, not one-time-use)', () => {
    login('owner', 'secret123', 2, true)
    expect(tryResumeSession(10)).toBeDefined()
    expect(tryResumeSession(11)).toBeDefined()
  })
})

describe('3 — no raw password, and no raw token, is ever stored server-side', () => {
  it('remember_tokens only ever holds a hash — never the password, never the raw token itself', () => {
    login('owner', 'secret123', 2, true)
    const rawTokenOnDisk = readRememberTokenFromDisk()
    expect(rawTokenOnDisk).toBeTruthy()

    const row = getDatabase().select().from(rememberTokens).get()
    expect(row).toBeDefined()
    // A hash, not the raw token or the password, in a fixed-length hex format (SHA-256 = 64 hex chars).
    expect(row!.tokenHash).not.toBe(rawTokenOnDisk)
    expect(row!.tokenHash).not.toContain('secret123')
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('round-trips correctly through the encrypted local file', () => {
    saveRememberTokenToDisk('plain-example-token')
    expect(readRememberTokenFromDisk()).toBe('plain-example-token')
  })
})

describe('4 — logout revokes the remembered login too', () => {
  it('after logout, the same file/token can no longer resume anything', () => {
    login('owner', 'secret123', 2, true)
    expect(tryResumeSession(20)).toBeDefined()

    logout(20)

    expect(readRememberTokenFromDisk()).toBeUndefined()
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM remember_tokens').get()).toEqual({ c: 0 })
    expect(tryResumeSession(21)).toBeUndefined()
  })

  it('logout still fully invalidates the live session itself (unrelated to remember-me)', () => {
    const { session } = login('owner', 'secret123', 2, true)
    logout(2)
    // The destroyed session id must not resolve to anything usable —
    // proven indirectly: a brand-new resume attempt on that same
    // webContentsId gets nothing (no live session, no remembered one).
    expect(tryResumeSession(2)).toBeUndefined()
    expect(session.sessionId).toBeTruthy()
  })
})

describe('5 — a password change revokes every remembered login for that user', () => {
  it('updateUser with a new password kills the remember-token the same way it kills live sessions', () => {
    const roleId = createRole({ name: unique('role'), permissions: [P.reports.view] }, env.ctx)
    const username = unique('hadi')
    const userId = createUser({ username, password: 'firstpass1', fullName: 'هادي', roleId }, env.ctx)
    login(username, 'firstpass1', 30, true)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM remember_tokens WHERE user_id = ?').get(userId)).toEqual({ c: 1 })

    updateUser(userId, { password: 'secondpass2' }, env.ctx)

    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM remember_tokens WHERE user_id = ?').get(userId)).toEqual({ c: 0 })
    expect(tryResumeSession(31)).toBeUndefined()
  })
})

describe('6 — deactivating a user revokes its remembered login', () => {
  it('updateUser({ active:false }) also clears remember_tokens for that user', () => {
    const roleId = createRole({ name: unique('role'), permissions: [P.reports.view] }, env.ctx)
    const username = unique('user')
    const userId = createUser({ username, password: 'firstpass1', fullName: 'مستخدم', roleId }, env.ctx)
    login(username, 'firstpass1', 40, true)

    updateUser(userId, { active: false }, env.ctx)

    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM remember_tokens WHERE user_id = ?').get(userId)).toEqual({ c: 0 })
  })
})

describe('7 — deleting a user revokes its remembered login (hard-delete and tombstone alike)', () => {
  it('a hard-deleted user\'s token is gone and can never resume', () => {
    const roleId = createRole({ name: unique('role'), permissions: [P.reports.view] }, env.ctx)
    const username = unique('user')
    const userId = createUser({ username, password: 'firstpass1', fullName: 'مستخدم', roleId }, env.ctx)
    // Issue the token directly rather than via login() — an actual
    // login records an audit_log row that would itself force the
    // tombstone branch below, defeating this specific "true hard
    // delete" scenario. deleteUser revokes remember-tokens itself
    // before even deciding hard-delete vs tombstone, precisely so a
    // remember-me token alone is never mistaken for real history.
    saveRememberTokenToDisk(issueRememberToken(userId))

    const result = deleteUser(userId, env.ctx)

    expect(result.mode).toBe('deleted')
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM remember_tokens WHERE user_id = ?').get(userId)).toEqual({ c: 0 })
    expect(tryResumeSession(51)).toBeUndefined()
  })

  it('a tombstoned (historically-referenced) user\'s token is explicitly revoked too', () => {
    const roleId = createRole({ name: unique('role'), permissions: [P.reports.view] }, env.ctx)
    const username = unique('user')
    const userId = createUser({ username, password: 'firstpass1', fullName: 'مستخدم', roleId }, env.ctx)
    // login() itself records a real audit_log row attributed to this
    // user (action: 'auth.login') — a genuine historical reference —
    // so deleteUser takes the tombstone branch instead of hard-delete,
    // exactly as tests/integration/user-role-independence.test.ts
    // established for this same scenario.
    login(username, 'firstpass1', 60, true)

    const result = deleteUser(userId, env.ctx)

    expect(result.mode).toBe('tombstoned')
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM remember_tokens WHERE user_id = ?').get(userId)).toEqual({ c: 0 })
    expect(tryResumeSession(61)).toBeUndefined()
  })
})

describe('8 — an expired token is refused and cleaned up', () => {
  it('a token past its expiry can never resume a session again', () => {
    login('owner', 'secret123', 70, true)
    const row = getDatabase().select().from(rememberTokens).get()!
    getDatabase().update(rememberTokens).set({ expiresAt: '2000-01-01T00:00:00.000Z' }).where(eq(rememberTokens.id, row.id)).run()

    expect(tryResumeSession(71)).toBeUndefined()
    // Cleaned up on the failed attempt — not left behind as a stale row.
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM remember_tokens WHERE id = ?').get(row.id)).toEqual({ c: 0 })
  })
})

describe('9 — a tampered/unknown token on disk fails safely, never crashes', () => {
  it('a token that does not match any stored hash resumes nothing', () => {
    saveRememberTokenToDisk('this-token-was-never-issued-by-login')
    expect(tryResumeSession(80)).toBeUndefined()
  })
})

describe('10 — database integrity', () => {
  it('leaves foreign_key_check clean and integrity_check ok after a full remember-me lifecycle', () => {
    const roleId = createRole({ name: unique('role'), permissions: [P.reports.view] }, env.ctx)
    const username = unique('user')
    const userId = createUser({ username, password: 'firstpass1', fullName: 'مستخدم', roleId }, env.ctx)
    login(username, 'firstpass1', 90, true)
    tryResumeSession(91)
    deleteUser(userId, env.ctx)

    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})
