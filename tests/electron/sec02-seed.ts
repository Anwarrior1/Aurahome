import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestDatabase } from '../helpers/test-db'
import { closeDatabase, getDatabasePath, getRawConnection } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { sec01Documents } from '../helpers/sec01-documents'
import { reconcileDatabase } from '@main/db/reconciliation'
const env = setupTestDatabase()
try {
  if (process.env.SEC02_HEALTH === '1') {
    const db = getRawConnection()
    console.log(JSON.stringify({ migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check'), reconciliation: reconcileDatabase(db) }, null, 2))
  } else {
    const target = process.env.SEC02_DIR
    if (!target?.startsWith('/tmp/sec02-electron-')) throw new Error('Disposable SEC02_DIR required')
    const documents = sec01Documents(env.ctx)
    const roleId = createRole({ name: 'SEC02 restricted', permissions: [] }, env.ctx)
    const userId = createUser({ username: 'restricted', fullName: 'SEC02 fictional user', password: 'secret123', roleId }, env.ctx)
    // Fixture-only legacy/restored metadata; normal profile changes use real IPC owners.
    getRawConnection().prepare('UPDATE users SET avatar_file_name=? WHERE id=?').run('../../external.png', userId)
    const source = getDatabasePath()
    closeDatabase()
    mkdirSync(join(target, 'data'), { recursive: true })
    copyFileSync(source, join(target, 'data/erp.db'))
    writeFileSync(join(target, 'fixture.json'), JSON.stringify({ userId, ownerId: env.ctx.session.user.id, ...documents }))
  }
} finally { env.cleanup() }
