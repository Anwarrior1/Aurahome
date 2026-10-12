import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestDatabase } from '../helpers/test-db'
import { uiWf07Fixture } from '../helpers/ui-wf07-production'
import { closeDatabase, getDatabasePath, getRawConnection } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { reconcileDatabase } from '@main/db/reconciliation'
const target = process.env.UIWF07_DIR
const env = setupTestDatabase()
try {
  if (process.env.UIWF07_HEALTH === '1') {
    const raw = getRawConnection()
    console.log(JSON.stringify({ migrations: raw.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: raw.prepare('SELECT sqlite_version() AS version').get(), integrity: raw.pragma('integrity_check'), foreignKeys: raw.pragma('foreign_key_check'), reconciliation: reconcileDatabase(raw) }, null, 2))
  } else {
    if (!target?.startsWith('/tmp/uiwf07-electron-')) throw new Error('Disposable UIWF07_DIR required')
    const fixture = uiWf07Fixture(env.ctx)
    const permissions = ['worksheets.view', 'orders.view', 'orders.viewActualCost', 'materials.view', 'inventory.consume']
    const roleId = createRole({ name: 'UIWF07 Corrector', permissions }, env.ctx)
    createUser({ username: 'uiwf07-corrector', fullName: 'UIWF07 Corrector', password: 'secret123', roleId }, env.ctx)
    const viewerRole = createRole({ name: 'UIWF07 Viewer', permissions: permissions.filter((permission) => permission !== 'inventory.consume') }, env.ctx)
    createUser({ username: 'uiwf07-viewer', fullName: 'UIWF07 Viewer', password: 'secret123', roleId: viewerRole }, env.ctx)
    const source = getDatabasePath()
    closeDatabase()
    mkdirSync(join(target, 'data'), { recursive: true })
    copyFileSync(source, join(target, 'data/erp.db'))
    writeFileSync(join(target, 'fixture.json'), JSON.stringify({ ...fixture, permissions }))
  }
} finally { env.cleanup() }
