import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  getSnapshot, subscribe, requestOpen, requestClose, resetDropdownCoordinatorForTests
} from '@renderer/components/materials/dropdownCoordinator'

/**
 * FIX — SINGLE-OPEN POPOVER BEHAVIOR
 *
 * The coordinator's actual logic (module-level singleton store + a
 * subscriber set) is plain JS with no DOM dependency, so — unlike the
 * React components built on top of it — it gets real, executable
 * assertions here rather than source-text pinning.
 */
beforeEach(() => {
  resetDropdownCoordinatorForTests()
})

describe('dropdownCoordinator — only one id can be "open" at a time', () => {
  it('starts with nothing open', () => {
    expect(getSnapshot()).toBeNull()
  })

  it('opening an id makes it the current snapshot', () => {
    requestOpen('material')
    expect(getSnapshot()).toBe('material')
  })

  it('opening a second id replaces the first — the two can never both read as open', () => {
    requestOpen('material')
    requestOpen('finish')
    expect(getSnapshot()).toBe('finish')
    expect(getSnapshot()).not.toBe('material')
  })

  it('opening a third id after that replaces the second the same way (نوع المادة → كود اللون/التشطيب → الإكسسوارات)', () => {
    requestOpen('material')
    requestOpen('finish')
    requestOpen('accessory')
    expect(getSnapshot()).toBe('accessory')
  })
})

describe('dropdownCoordinator — close semantics', () => {
  it('closing the currently-open id clears the store', () => {
    requestOpen('material')
    requestClose('material')
    expect(getSnapshot()).toBeNull()
  })

  it('a stale close from an id that already lost the "open" race does not clobber the new owner', () => {
    requestOpen('material')
    requestOpen('finish') // "material" is no longer the open one
    requestClose('material') // material's own unmount/close-path fires late
    expect(getSnapshot()).toBe('finish') // finish must still be open
  })
})

describe('dropdownCoordinator — subscribers are notified so every instance can react', () => {
  it('every subscriber fires when the open id changes', () => {
    let calls = 0
    const unsubscribe = subscribe(() => { calls += 1 })
    requestOpen('material')
    requestOpen('finish')
    requestClose('finish')
    expect(calls).toBe(3)
    unsubscribe()
    requestOpen('material')
    expect(calls).toBe(3) // no longer subscribed — no further calls
  })

  it('opening the already-open id again is a no-op (no redundant notification)', () => {
    let calls = 0
    subscribe(() => { calls += 1 })
    requestOpen('material')
    requestOpen('material')
    expect(calls).toBe(1)
  })
})

describe('the store is genuinely module-level, not per-component React state (item 3)', () => {
  it('useSingleOpenDropdown holds no local open/close state of its own — it only reads/writes the shared store', () => {
    const source = readFileSync('src/renderer/components/materials/dropdownCoordinator.ts', 'utf8')
    // openId/listeners are declared at module scope (before the hook
    // function), which is what makes every mounted instance share one
    // truth instead of each tracking its own boolean.
    const hookStart = source.indexOf('export function useSingleOpenDropdown')
    expect(source.indexOf('let openId')).toBeGreaterThanOrEqual(0)
    expect(source.indexOf('let openId')).toBeLessThan(hookStart)
    expect(source.indexOf('const listeners')).toBeLessThan(hookStart)
    // The hook itself never calls useState for the open/closed flag.
    const hookBody = source.slice(hookStart)
    expect(hookBody).not.toContain('useState')
  })

  it('releases the store on unmount so a stale id can never linger past the component that opened it', () => {
    const source = readFileSync('src/renderer/components/materials/dropdownCoordinator.ts', 'utf8')
    expect(source).toMatch(/useEffect\(\(\) => \(\) => requestClose\(id\), \[id\]\)/)
  })
})
