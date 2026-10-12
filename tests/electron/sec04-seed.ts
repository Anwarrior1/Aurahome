import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestDatabase } from '../helpers/test-db'
import { closeDatabase, getDatabasePath, getRawConnection } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { sec01Documents } from '../helpers/sec01-documents'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { reconcileDatabase } from '@main/db/reconciliation'
const env = setupTestDatabase()
try {
  const db = getRawConnection()
  if (process.env.SEC04_HEALTH === '1') {
    console.log(JSON.stringify({ migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check'), reconciliation: reconcileDatabase(db) }, null, 2))
  } else {
    const dir = process.env.SEC04_DIR
    if (!dir?.startsWith('/tmp/sec04-electron-')) throw new Error('Disposable SEC04_DIR required')
    const documents = sec01Documents(env.ctx)
    const roleId = createRole({ name: 'SEC04 document/cash viewer', permissions: [P.cash.view, P.finalInvoices.view] }, env.ctx)
    const userId = createUser({ username: 'viewer', password: 'secret123', fullName: 'SEC04 fictional viewer', roleId }, env.ctx)
    db.exec("CREATE TRIGGER sec04_fault BEFORE INSERT ON audit_log WHEN NEW.action='auth.login' BEGIN SELECT RAISE(ABORT,'SEC04 disposable login audit fault'); END")
    const source = getDatabasePath(); closeDatabase()
    mkdirSync(join(dir, 'data'), { recursive: true }); copyFileSync(source, join(dir, 'data/erp.db'))
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ roleId, userId, ...documents }))
  }
} finally { env.cleanup() }
