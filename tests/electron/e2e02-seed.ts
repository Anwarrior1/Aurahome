import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { setupTestDatabase } from '../helpers/test-db'
import { getDatabasePath, closeDatabase } from '@main/db/connection'
import { reconcileDatabase } from '@main/db/reconciliation'
const dir = process.env.E2E02_DIR
if (!dir?.startsWith('/tmp/e2e-electron-e2e02-')) throw new Error('Disposable E2E02_DIR required')
if (process.env.E2E02_INSPECT === '1') {
  const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
  try {
    const report = { migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check'), reconciliation: reconcileDatabase(db) }
    writeFileSync(join(dir, 'inspection.json'), JSON.stringify(report, null, 2))
  } finally { db.close() }
} else {
  const env = setupTestDatabase()
  try { const source = getDatabasePath(); closeDatabase(); mkdirSync(join(dir, 'data'), { recursive: true }); copyFileSync(source, join(dir, 'data/erp.db')) } finally { env.cleanup() }
}
