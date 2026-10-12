import { mkdirSync, copyFileSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestDatabase } from '../helpers/test-db'
import { closeDatabase, getDatabasePath, getRawConnection } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { sec01Documents } from '../helpers/sec01-documents'
import { setupAssetFixtures } from '../helpers/sec03-assets'
import { reconcileDatabase } from '@main/db/reconciliation'
const env = setupTestDatabase()
try {
  if (process.env.SEC03_HEALTH === '1') {
    const db = getRawConnection()
    console.log(JSON.stringify({ migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check'), reconciliation: reconcileDatabase(db) }, null, 2))
  } else {
    const target = process.env.SEC03_DIR
    if (!target?.startsWith('/tmp/sec03-electron-')) throw new Error('Disposable SEC03_DIR required')
    const appRoot = join(target, 'app')
    const assets = setupAssetFixtures(appRoot)
    cpSync('drizzle/migrations', join(appRoot, 'drizzle/migrations'), { recursive: true })
    copyFileSync('package.json', join(appRoot, 'package.json'))
    const documents = sec01Documents(env.ctx)
    const roleId = createRole({ name: 'SEC03 restricted', permissions: [] }, env.ctx)
    const userId = createUser({ username: 'restricted', fullName: 'SEC03 fictional user', password: 'secret123', roleId }, env.ctx)
    // Only a fixture row: demonstrate that managed avatar handling remains separate.
    getRawConnection().prepare('UPDATE users SET avatar_file_name=? WHERE id=?').run('../../external.png', userId)
    const source = getDatabasePath()
    closeDatabase()
    mkdirSync(join(target, 'data'), { recursive: true })
    copyFileSync(source, join(target, 'data/erp.db'))
    writeFileSync(join(target, 'external.png'), Buffer.from('SEC03 harmless avatar canary'))
    writeFileSync(join(target, 'fixture.json'), JSON.stringify({ userId, ...documents, appRoot, ...assets }))
  }
} finally { env.cleanup() }
