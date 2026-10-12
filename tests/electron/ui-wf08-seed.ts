import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestDatabase } from '../helpers/test-db'
import { uiWf08Fixture } from '../helpers/ui-wf08-savings'
import { closeDatabase, getDatabasePath, getRawConnection } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { reconcileDatabase } from '@main/db/reconciliation'
const target = process.env.UIWF08_DIR
const env = setupTestDatabase()
try {
  if (process.env.UIWF08_HEALTH === '1') {
    const raw = getRawConnection()
    console.log(JSON.stringify({ migrations: raw.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: raw.prepare('SELECT sqlite_version() AS version').get(), integrity: raw.pragma('integrity_check'), foreignKeys: raw.pragma('foreign_key_check'), reconciliation: reconcileDatabase(raw) }, null, 2))
  } else {
    if (!target?.startsWith('/tmp/uiwf08-electron-')) throw new Error('Disposable UIWF08_DIR required')
    const fixture = uiWf08Fixture(env.ctx)
    for (const [username, permissions] of [['uiwf08-editor', ['savings.view', 'savings.manage']], ['uiwf08-viewer', ['savings.view']]] as const) {
      const roleId = createRole({ name: username, permissions: [...permissions] }, env.ctx)
      createUser({ username, fullName: username, password: 'secret123', roleId }, env.ctx)
    }
    const source = getDatabasePath()
    closeDatabase()
    mkdirSync(join(target, 'data'), { recursive: true })
    copyFileSync(source, join(target, 'data/erp.db'))
    writeFileSync(join(target, 'fixture.json'), JSON.stringify(fixture))
  }
} finally { env.cleanup() }
