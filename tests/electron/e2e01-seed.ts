import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { setupTestDatabase } from '../helpers/test-db'
import { getRawConnection, getDatabasePath, closeDatabase } from '@main/db/connection'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { reconcileDatabase } from '@main/db/reconciliation'
const dir = process.env.E2E01_DIR
if (!dir?.startsWith('/tmp/e2e-electron-e2e01-')) throw new Error('Disposable E2E01_DIR required')
app.getPath = () => dir
const env = setupTestDatabase()
try {
  const db = getRawConnection()
  const fresh = { migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check'), reconciliation: reconcileDatabase(db) }
  const categoryId = createCategory({ name: 'E2E01 fictional materials' }, env.ctx)
  const materialId = createMaterial({ sku: 'E2E01-BOARD', name: 'E2E01 fictional board', categoryId, unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: 2000000 }, env.ctx)
  const source = getDatabasePath(); closeDatabase()
  mkdirSync(join(dir, 'data'), { recursive: true }); copyFileSync(source, join(dir, 'data/erp.db'))
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ fresh, categoryId, materialId }, null, 2))
} finally { env.cleanup() }
