import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

/**
 * Guards the main↔renderer contract: every channel the preload bridge
 * exposes must have a handler registered in main, and no handler may
 * exist for a channel that is not in the declared map. A mismatch
 * would mean the renderer can call something that silently fails, or
 * that an undeclared privileged operation exists.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

describe('IPC router coverage', () => {
  it('registers a handler for every declared channel, and nothing more', async () => {
    const registered = new Set<string>()
    const electron = await import('electron')
    const spy = vi
      .spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel: string) => { registered.add(channel) }) as never)

    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()

    const declared = Object.values(IPC_CHANNELS).flatMap((group) => Object.values(group))

    expect([...declared].sort()).toEqual([...registered].sort())
    expect(declared.length).toBeGreaterThan(90)
  })
})
