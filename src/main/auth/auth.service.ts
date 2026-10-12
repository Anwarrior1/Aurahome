import type { LoginResponse } from '@shared/ipc-contracts/auth.contract'
import type { AuthSession, SessionUser } from '@shared/types/user.types'
import { AppError } from '../utils/errors'
import { withTransaction } from '../db/transactions'
import { verifyPassword } from './password'
import {
  createSession,
  bindSessionToWebContents,
  destroySessionForWebContents,
  getSessionForWebContents,
  newSessionId
} from './session'
import { isLockedOut, recordFailedAttempt, clearFailedAttempts } from './lockout'
import { findUserByUsername, findUserById, type UserRecord } from '../repositories/users/users.repository'
import { getPermissionsForRole } from '../permissions/permission.service'
import { recordAuditEvent } from '../audit/audit-log.service'
import { issueRememberToken, consumeRememberToken, revokeRememberTokensForUser } from './remember-token'
import { saveRememberTokenToDisk, readRememberTokenFromDisk, clearRememberTokenFromDisk } from './remember-file'

/** True only for a genuinely live account — same guard shape used by
 *  login() and the "remember me" resume path alike (a tombstoned row
 *  always fails this together, see users.schema.ts). */
function isLiveUser(user: UserRecord | undefined): user is UserRecord & {
  roleId: number; roleName: string; isAdmin: boolean
} {
  return Boolean(user && user.active && user.roleId !== null && user.roleName !== null && user.isAdmin !== null)
}

function buildSession(user: UserRecord & { roleId: number; roleName: string; isAdmin: boolean }): AuthSession {
  const sessionUser: SessionUser = {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    roleId: user.roleId,
    roleName: user.roleName,
    isAdmin: user.isAdmin
  }
  return {
    sessionId: newSessionId(),
    user: sessionUser,
    permissions: getPermissionsForRole(user.roleId),
    issuedAt: new Date().toISOString()
  }
}

export function login(
  username: string,
  password: string,
  webContentsId: number,
  rememberMe = false
): LoginResponse {
  if (isLockedOut(username)) {
    throw new AppError('FORBIDDEN', 'الحساب موقوف مؤقتاً بسبب محاولات دخول متكررة فاشلة')
  }

  const user = findUserByUsername(username)
  if (!isLiveUser(user) || !verifyPassword(password, user.passwordHash)) {
    recordFailedAttempt(username)
    throw new AppError('UNAUTHENTICATED', 'اسم المستخدم أو كلمة المرور غير صحيحة')
  }
  clearFailedAttempts(username)

  const session = buildSession(user)
  // No new authority until required audit and remembered-login persistence succeed.
  withTransaction(() => {
    recordAuditEvent({
      userId: user.id,
      action: 'auth.login',
      entity: 'session',
      entityId: session.sessionId
    })

    // "تذكرني": a fresh random token is issued and its hash stored, but
    // the raw value only ever leaves this function to be written
    // straight into the OS-encrypted local file — it is never part of
    // LoginResponse and never reaches the renderer (see remember-file.ts).
    if (rememberMe) {
      saveRememberTokenToDisk(issueRememberToken(user.id))
    } else {
      // An explicit password login on this machine always wins over
      // whatever may have been remembered here before.
      clearRememberTokenFromDisk()
    }
  })
  createSession(session)
  bindSessionToWebContents(webContentsId, session.sessionId)

  return { session, theme: user.theme === 'dark' ? 'dark' : 'light' }
}

/**
 * Called once, early, before the login screen would otherwise show.
 * Reads the encrypted local "remember me" file (if any), verifies it
 * against the database, and — only if the account is still live —
 * opens a real session for the calling window exactly as a password
 * login would. Anything that fails to check out (no file, expired,
 * unknown, or the account no longer live) simply returns `undefined`;
 * this is a normal, expected outcome, never an error.
 */
export function tryResumeSession(webContentsId: number): LoginResponse | undefined {
  const rawToken = readRememberTokenFromDisk()
  if (!rawToken) return undefined

  // Token sliding and its required audit commit together, before publication.
  const result = withTransaction<LoginResponse | undefined>(() => {
    const consumed = consumeRememberToken(rawToken)
    if (!consumed) {
      clearRememberTokenFromDisk()
      return undefined
    }

    const user = findUserById(consumed.userId)
    if (!isLiveUser(user)) {
      // The account was deactivated/changed/removed since this token was
      // issued — never resume, and stop remembering it on this machine.
      clearRememberTokenFromDisk()
      revokeRememberTokensForUser(consumed.userId)
      return undefined
    }

    const session = buildSession(user)
    recordAuditEvent({
      userId: user.id,
      action: 'auth.resume',
      entity: 'session',
      entityId: session.sessionId
    })

    return { session, theme: user.theme === 'dark' ? 'dark' : 'light' }
  })
  if (result) {
    createSession(result.session)
    bindSessionToWebContents(webContentsId, result.session.sessionId)
  }
  return result
}

export function logout(webContentsId: number): void {
  const session = getSessionForWebContents(webContentsId)
  destroySessionForWebContents(webContentsId)
  // Logging out ends this machine's remembered login too — never a
  // silent auto-return to a session the user just explicitly closed.
  if (session) revokeRememberTokensForUser(session.user.id)
  clearRememberTokenFromDisk()
}
