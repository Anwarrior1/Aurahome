/**
 * Foundation-only failed-login throttle (Step 2 §4). In-memory is
 * sufficient for one shared PC; extend to a persisted counter in
 * Step 4 only if factory usage needs it to survive an app restart.
 */
const failedAttempts = new Map<string, { count: number; lockedUntil?: number }>()

const MAX_ATTEMPTS = 5
const LOCK_MS = 5 * 60 * 1000

export function isLockedOut(username: string): boolean {
  const entry = failedAttempts.get(username)
  return !!entry?.lockedUntil && entry.lockedUntil > Date.now()
}

export function recordFailedAttempt(username: string): void {
  const entry = failedAttempts.get(username) ?? { count: 0 }
  entry.count += 1
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCK_MS
    entry.count = 0
  }
  failedAttempts.set(username, entry)
}

export function clearFailedAttempts(username: string): void {
  failedAttempts.delete(username)
}
