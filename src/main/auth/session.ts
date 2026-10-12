import { randomUUID } from 'node:crypto'
import type { AuthSession } from '@shared/types/user.types'

/**
 * Sessions live only in main-process memory (Step 2 §4) — never
 * persisted, never sent to the renderer as anything but the public
 * AuthSession shape.
 *
 * A session is bound to the webContents that logged in, and every
 * guarded IPC call resolves the caller's session from
 * `event.sender.id`. The renderer therefore never sends a session id
 * and cannot forge one — it has no way to act as another session.
 */
const sessions = new Map<string, AuthSession>()
const byWebContents = new Map<number, string>()

export function createSession(session: AuthSession): void {
  sessions.set(session.sessionId, session)
}

export function getSession(sessionId: string): AuthSession | undefined {
  return sessions.get(sessionId)
}

export function bindSessionToWebContents(webContentsId: number, sessionId: string): void {
  byWebContents.set(webContentsId, sessionId)
}

export function getSessionForWebContents(webContentsId: number): AuthSession | undefined {
  const sessionId = byWebContents.get(webContentsId)
  return sessionId ? sessions.get(sessionId) : undefined
}

export function destroySessionForWebContents(webContentsId: number): void {
  const sessionId = byWebContents.get(webContentsId)
  if (sessionId) sessions.delete(sessionId)
  byWebContents.delete(webContentsId)
}

/** A database restore changes the authoritative user/role epoch for every window. */
export function destroyAllSessions(): void {
  sessions.clear()
  byWebContents.clear()
}

/** Invalidates every window/session owned by one user. */
export function destroySessionsForUser(userId: number): void {
  const revoked = new Set<string>()
  for (const [sessionId, session] of sessions) {
    if (session.user.id === userId) {
      sessions.delete(sessionId)
      revoked.add(sessionId)
    }
  }
  for (const [webContentsId, sessionId] of byWebContents) {
    if (revoked.has(sessionId)) byWebContents.delete(webContentsId)
  }
}

/** Role/permission edits take effect immediately for every active window. */
export function destroySessionsForRole(roleId: number): void {
  const userIds = new Set<number>()
  for (const session of sessions.values()) {
    if (session.user.roleId === roleId) userIds.add(session.user.id)
  }
  for (const userId of userIds) destroySessionsForUser(userId)
}

export function refreshSessionPermissions(sessionId: string, permissions: string[]): void {
  const session = sessions.get(sessionId)
  if (session) sessions.set(sessionId, { ...session, permissions })
}

export function newSessionId(): string {
  return randomUUID()
}
