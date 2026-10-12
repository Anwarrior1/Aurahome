import { useEffect, useId, useSyncExternalStore } from 'react'

/**
 * A tiny module-level store (not React state) tracking which ONE
 * searchable dropdown — across نوع المادة / كود اللون/التشطيب /
 * الإكسسوارات, in either invoice form, in any item row — is
 * currently open. Deliberately global rather than scoped per row or
 * per page: the requirement is that no two of these panels can ever
 * be visible together, anywhere, and a single shared store is the
 * simplest thing that can guarantee that without new prop plumbing
 * through the invoice pages or a Context provider wrapping every row.
 *
 * Plain module state + a subscriber set, exposed to components via
 * `useSyncExternalStore` (built into React — no new dependency).
 */
let openId: string | null = null
const listeners = new Set<() => void>()

// The store's own logic, exported directly (not just through the React
// hook below) so it can be exercised with real assertions in a plain
// unit test — no DOM/React renderer needed, since this is plain module
// state plus a subscriber set.
export function getSnapshot(): string | null {
  return openId
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function requestOpen(id: string): void {
  if (openId !== id) {
    openId = id
    emit()
  }
}

export function requestClose(id: string): void {
  // Only clears the store if THIS id is the one currently open — a
  // stale close from an instance that already lost the "one open"
  // race (because another one opened after it) must not clobber the
  // new owner.
  if (openId === id) {
    openId = null
    emit()
  }
}

/** Test-only: clears the singleton between test cases. Never called
 *  from application code — the app never needs to "forget" which
 *  dropdown is open outside of a component unmounting. */
export function resetDropdownCoordinatorForTests(): void {
  openId = null
  listeners.clear()
}

/**
 * Coordinated open/close for one dropdown instance. `isOpen` reflects
 * whether THIS instance is the single globally-open one; opening any
 * instance (via `open()`/`toggle()`) implicitly closes whichever
 * other instance held it, because every subscribed instance re-renders
 * off the same store and only the new id matches.
 */
export function useSingleOpenDropdown(): { isOpen: boolean; open: () => void; close: () => void; toggle: () => void } {
  const id = useId()
  const currentOpenId = useSyncExternalStore(subscribe, getSnapshot)
  const isOpen = currentOpenId === id

  // Release the store if this instance unmounts while it holds it
  // (e.g. the invoice Modal closes and unmounts every field) so a
  // future, unrelated instance can never inherit a stale "open" id.
  useEffect(() => () => requestClose(id), [id])

  return {
    isOpen,
    open: () => requestOpen(id),
    close: () => requestClose(id),
    toggle: () => (isOpen ? requestClose(id) : requestOpen(id))
  }
}
