import { getRawConnection } from './connection'

/**
 * The only sanctioned way to run a multi-step write (Step 2 §6).
 * better-sqlite3's transaction() is synchronous, so nothing can
 * interleave between the steps — a material consumption, a payment,
 * or an order confirmation lands completely or not at all. `fn` must
 * contain ONLY synchronous repository calls; never await inside it.
 */
export function withTransaction<T>(fn: () => T): T {
  const runner = getRawConnection().transaction(fn)
  return runner()
}

/** Reserve SQLite's writer before checking an irreversible lifecycle boundary. */
export function withImmediateTransaction<T>(fn: () => T): T {
  return getRawConnection().transaction(fn).immediate()
}
