import { describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getRawConnection, closeDatabase } from '@main/db/connection'
import { createBackup } from '@main/backup/backup.service'
import { readArchive } from '@main/backup/archive'
import { DATABASE_ENTRY } from '@main/backup/manifest'
import { getSessionForWebContents } from '@main/auth/session'
import { createHandler } from '@main/ipc/guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase } from '../helpers/test-db'

describe('DB-08 before-fix isolated reproduction', () => {
  it('actual old close/remove/copy boundaries admit a truncated live DB with no restore metadata', async () => {
    const env = setupTestDatabase()
    try {
      const live = getRawConnection().name
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'b.aurabak'), includeConfig: false }, env.ctx)
      const candidate = readArchive(backup.path).get(DATABASE_ENTRY)!
      const safety = join(env.dir, 'pre-restore', 'erp.db')
      mkdirSync(join(env.dir, 'pre-restore'))
      closeDatabase() // old production boundary
      copyFileSync(live, safety) // old safety copy, no fsync/marker
      for (const suffix of ['-wal', '-shm']) rmSync(`${live}${suffix}`, { force: true })
      writeFileSync(live, candidate.subarray(0, 1024)) // process death during old copyFileSync(staged, live)
      expect(readFileSync(live).length).toBe(1024)
      expect(existsSync(safety)).toBe(true)
      expect(readdirSync(env.dir).some((name) => name.includes('restore') && name.endsWith('.json'))).toBe(false)
      expect(() => getRawConnection().pragma('integrity_check')).toThrow()
    } finally { env.cleanup() }
  })

  it('successful old restore retains a pre-restore privileged main-process session', async () => {
    const env = setupTestDatabase()
    try {
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'b.aurabak'), includeConfig: false }, env.ctx)
      const live = getRawConnection().name
      getRawConnection().prepare("UPDATE users SET active = 0 WHERE username = 'owner'").run()
      const oldSession = getSessionForWebContents(1)
      const candidate = readArchive(backup.path).get(DATABASE_ENTRY)!
      closeDatabase()
      copyFileSync(live, join(env.dir, 'safety.db'))
      for (const suffix of ['-wal', '-shm']) rmSync(`${live}${suffix}`, { force: true })
      writeFileSync(live, candidate)
      expect(getSessionForWebContents(1)).toEqual(oldSession)
      const guarded = createHandler({ permission: P.backup.restore }, () => ({ privileged: true }))
      const result = await guarded({ sender: { id: 1 } } as never, {})
      expect(result).toEqual({ ok: true, data: { privileged: true } })
    } finally { env.cleanup() }
  })
})
