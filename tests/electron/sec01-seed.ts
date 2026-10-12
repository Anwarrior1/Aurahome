import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestDatabase } from '../helpers/test-db'
import { sec01Documents } from '../helpers/sec01-documents'
import { closeDatabase, getDatabasePath, getRawConnection } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { reconcileDatabase } from '@main/db/reconciliation'
const env = setupTestDatabase()
try {
  if (process.env.SEC01_HEALTH === '1') {
    const db = getRawConnection()
    console.log(JSON.stringify({ migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check'), reconciliation: reconcileDatabase(db) }, null, 2))
  } else {
    const target = process.env.SEC01_DIR
    if (!target?.startsWith('/tmp/sec01-electron-')) throw new Error('Disposable SEC01_DIR required')
    const fixture = sec01Documents(env.ctx)
    const roles = {
      restricted: [], unrelated: ['inventory.view'], quotation: ['quotations.view'], invoice: ['finalInvoices.view'],
      production: ['worksheets.view'], release: ['releases.view'], viewer: ['quotations.view', 'finalInvoices.view', 'worksheets.view', 'releases.view'],
      revoked: ['finalInvoices.view'], disabled: ['finalInvoices.view'], reassigned: ['finalInvoices.view']
    }
    const actors: Record<string, { roleId: number; userId: number }> = {}
    for (const [username, permissions] of Object.entries(roles)) {
      const roleId = createRole({ name: `SEC01 ${username}`, permissions }, env.ctx)
      const userId = createUser({ username, fullName: `SEC01 ${username}`, password: 'secret123', roleId }, env.ctx)
      actors[username] = { roleId, userId }
    }
    const source = getDatabasePath()
    closeDatabase()
    mkdirSync(join(target, 'data'), { recursive: true })
    copyFileSync(source, join(target, 'data/erp.db'))
    writeFileSync(join(target, 'fixture.json'), JSON.stringify({ ...fixture, actors }))
  }
} finally { env.cleanup() }
