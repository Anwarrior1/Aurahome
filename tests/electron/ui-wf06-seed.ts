import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestDatabase } from '../helpers/test-db'
import { getDatabasePath, closeDatabase, getRawConnection } from '@main/db/connection'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { reconcileDatabase } from '@main/db/reconciliation'
const target = process.env.UIWF06_DIR
const env = setupTestDatabase()
try {
  if (process.env.UIWF06_HEALTH === '1') {
    const raw = getRawConnection()
    console.log(JSON.stringify({ migrations: raw.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get(), sqlite: raw.prepare('SELECT sqlite_version() AS version').get(), integrity: raw.pragma('integrity_check'), foreignKeys: raw.pragma('foreign_key_check'), reconciliation: reconcileDatabase(raw) }, null, 2))
  } else {
  const categoryId = createCategory({ name: 'UIWF06' }, env.ctx)
  const materialId = createMaterial({ sku: 'UIWF06-M', name: 'UIWF06 material', categoryId, unit: 'unit', currentMarketPriceMicro: 0, pricingRule: 'exact' }, env.ctx)
  const supplierId = createSupplier({ name: 'UIWF06 supplier' }, env.ctx)
  if (!target) {
    const result = createPurchase({ supplierId, lines: [{ materialId, qtyMicro: 145000, unitCostMicro: 100000 }] }, env.ctx)
    const raw = getRawConnection()
    console.log(JSON.stringify({ rawQuantity: '0.145', rawUnitPrice: '0.100000', parsedQuantity: Number('0.145'), parsedUnitPrice: Number('0.100000'), previewMinor: Math.round(Number('0.145') * Number('0.100000') * 1000), quantityMicro: 145000, unitCostMicro: 100000, committed: result, purchase: raw.prepare('SELECT * FROM purchases').all(), lines: raw.prepare('SELECT * FROM purchase_lines').all(), movements: raw.prepare('SELECT * FROM inventory_movements').all(), fifo: raw.prepare('SELECT * FROM fifo_layers').all() }, null, 2))
  } else {
    if (!target.startsWith('/tmp/uiwf06-electron-')) throw new Error('Disposable path required')
    const source = getDatabasePath()
    closeDatabase()
    mkdirSync(join(target, 'data'), { recursive: true })
    copyFileSync(source, join(target, 'data/erp.db'))
    writeFileSync(join(target, 'fixture.json'), JSON.stringify({ materialId, supplierId }))
  }
  }
} finally { env.cleanup() }
