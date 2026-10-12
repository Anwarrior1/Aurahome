import { describe, expect, it } from 'vitest'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { setupTestDatabase } from '../helpers/test-db'
import { getConfigRoot } from '@main/files/paths'
interface Observation { phase: string; pid?: number; dir?: string; userData?: string; database?: string; configExists?: boolean; tokenPresent?: boolean; resumed?: boolean; count?: number }
function nextMessage(child: ChildProcess): Promise<Observation> {
  return new Promise((resolve, reject) => {
    const message = (value: Observation) => { child.off('exit', exited); resolve(value) }
    const exited = (code: number | null) => { child.off('message', message); reject(new Error(`Fixture worker exited before observation: ${code}`)) }
    child.once('message', message); child.once('exit', exited); child.once('error', reject)
  })
}
describe('RRA03 fictional database owns its complete mocked application filesystem', () => {
  it('initializes startup directories inside its own root and restores the prior mock path on cleanup', () => {
    const previous = app.getPath('userData'), env = setupTestDatabase()
    try {
      expect(app.getPath('userData')).toBe(join(env.dir, 'userData'))
      expect(existsSync(getConfigRoot())).toBe(true)
    } finally { env.cleanup() }
    expect(app.getPath('userData')).toBe(previous); expect(existsSync(env.dir)).toBe(false)
  })
  it('a second process fixture login cannot erase the first process expired-token cleanup input', async () => {
    const children: ChildProcess[] = []
    const exits: Array<Promise<number | null>> = []
    const launch = (role: string) => {
      const child = spawn(process.execPath, [join(process.cwd(), 'node_modules/vite-node/vite-node.mjs'), '--config', join(process.cwd(), 'vitest.config.ts'), join(process.cwd(), 'tests/helpers/rra03-fixture-worker.ts'), role], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']})
      children.push(child); exits.push(new Promise(resolve => child.once('exit', code => resolve(code)))); return child
    }
    try {
      const owner = launch('owner'), a = await nextMessage(owner)
      const interferer = launch('interferer'), b = await nextMessage(interferer)
      expect(a.database).not.toBe(b.database); expect(a.userData).not.toBe(b.userData)
      expect(a.userData).toBe(join(a.dir!, 'userData')); expect(b.userData).toBe(join(b.dir!, 'userData'))
      expect(a.configExists).toBe(true); expect(b.configExists).toBe(true)
      const result = nextMessage(owner); owner.send('resume')
      expect(await result).toEqual({phase: 'result', tokenPresent: true, resumed: false, count: 0})
      expect(await Promise.all(exits)).toEqual([0, 0])
    } finally {
      await Promise.all(children.map(child => new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
        child.once('exit', () => resolve()); if (child.connected) child.disconnect(); child.kill()
      })))
    }
  }, 30000)
})
