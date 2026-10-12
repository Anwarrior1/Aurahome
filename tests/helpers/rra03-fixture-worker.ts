import { app } from 'electron'
import { existsSync } from 'node:fs'
import { setupTestDatabase } from './test-db'
import { getRawConnection } from '@main/db/connection'
import { login, tryResumeSession } from '@main/auth/auth.service'
import { readRememberTokenFromDisk } from '@main/auth/remember-file'
import { getConfigRoot } from '@main/files/paths'
const role = process.argv[2]
if (!process.send || !['owner', 'interferer'].includes(role)) throw new Error('Test fixture worker requires IPC and a known role')
const env = setupTestDatabase()
process.once('SIGTERM', () => { env.cleanup(); process.exit(0) })
const ready = () => process.send?.({phase: 'ready', pid: process.pid, role, dir: env.dir, userData: app.getPath('userData'), database: getRawConnection().name, configExists: existsSync(getConfigRoot())})
if (role === 'owner') {
  login('owner', 'secret123', 70, true)
  getRawConnection().exec("UPDATE remember_tokens SET expires_at='2000-01-01T00:00:00.000Z'")
  ready()
  process.once('message', () => {
    try {
      const tokenPresent = Boolean(readRememberTokenFromDisk()), resumed = Boolean(tryResumeSession(71))
      const {count} = getRawConnection().prepare('SELECT COUNT(*) count FROM remember_tokens').get() as {count: number}
      process.send?.({phase: 'result', tokenPresent, resumed, count})
    } finally { env.cleanup(); process.disconnect?.() }
  })
} else { ready(); env.cleanup(); process.disconnect?.() }
