import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { setupTestDatabase } from '../helpers/test-db'
import { getRawConnection, getDatabasePath, closeDatabase } from '@main/db/connection'
import { reconcileDatabase } from '@main/db/reconciliation'
import { createWorker, workerBalances } from '@main/services/production/workers.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { savePlannedWorkers } from '@main/services/planning/planning.service'
import { issueWorkSheet, completeProduction, issueRelease, recordDelivery } from '@main/services/production/production.service'
import { createRole, createUser } from '@main/services/admin/users.service'

const dir = process.env.E2E03_DIR
if (!dir?.startsWith('/tmp/e2e-electron-e2e03-')) throw new Error('Disposable E2E03_DIR required')
if (process.env.E2E03_INSPECT === '1') {
  const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
  try {
    const snapshot = () => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
    const before = JSON.stringify(snapshot())
    const report = reconcileDatabase(db)
    const result = { readOnly: before === JSON.stringify(snapshot()), migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check'), reconciliation: report }
    writeFileSync(join(dir, 'inspection.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } finally { db.close() }
} else {
  const env = setupTestDatabase()
  try {
    const db = getRawConnection()
    const fresh = { migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check'), reconciliation: reconcileDatabase(db) }
    const workerId = createWorker({ name: 'عامل E2E03' }, env.ctx)
    const accountId = createAccount({ name: 'خزينة E2E03', kind: 'cash', openingBalanceMinor: 50000 }, env.ctx)
    const customerId = createCustomer({ name: 'E2E03 fictional customer' }, env.ctx)
    const invoice = createFinalInvoice({ customerId, depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'E2E03 job', quantityMicro: 1000000, unitPriceMinor: 90000 }] }, env.ctx)
    const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
    savePlannedWorkers({ orderId }, [{ workerId, workerName: 'عامل E2E03', estimatedCostMinor: 10000 }], env.ctx)
    const sheet = issueWorkSheet({ orderId }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    const release = issueRelease({ orderId, kind: 'delivery' }, env.ctx)
    recordDelivery({ orderId, releaseId: release.id, kind: 'handover' }, env.ctx)
    const roleId = createRole({ name: 'E2E03 restricted payer', permissions: ['workers.view', 'workers.finance'] }, env.ctx)
    createUser({ username: 'e2e03-payer', fullName: 'E2E03 payer', password: 'secret123', roleId }, env.ctx)
    const noFinanceRole = createRole({ name: 'E2E03 read only', permissions: ['workers.view'] }, env.ctx)
    createUser({ username: 'e2e03-viewer', fullName: 'E2E03 viewer', password: 'secret123', roleId: noFinanceRole }, env.ctx)
    const fixture = { workerId, accountId, orderId, sheetId: sheet.id, payable: workerBalances(workerId), cashMinor: accountBalance(accountId), fresh, beforeReconciliation: reconcileDatabase(db) }
    const source = getDatabasePath()
    closeDatabase()
    mkdirSync(join(dir, 'data'), { recursive: true })
    copyFileSync(source, join(dir, 'data/erp.db'))
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify(fixture, null, 2))
  } finally { env.cleanup() }
}
