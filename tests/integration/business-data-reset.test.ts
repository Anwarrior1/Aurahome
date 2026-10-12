import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { closeDatabase, getRawConnection, setDatabasePath } from '@main/db/connection'
import { login } from '@main/auth/auth.service'
import { needsSetup } from '@main/services/admin/bootstrap.service'
import { customerBalances, supplierBalances, createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { stockLevels } from '@main/services/inventory/valuation.service'
import { listAccounts, createAccount } from '@main/services/finance/cash.service'
import { createExpense } from '@main/services/finance/expenses.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder } from '@main/services/sales/orders.service'
import { issueWorkSheet, completeProduction } from '@main/services/production/production.service'
import { productsFromOrder, resumeOriginalOrder } from '@main/services/sales/uncollected-products.service'

let env: TestEnv
let databasePath: string

beforeEach(() => {
  env = setupTestDatabase()
  databasePath = resolve(env.dir, readdirSync(env.dir).find((name) => name.endsWith('.db'))!)
})
afterEach(() => env.cleanup())

/**
 * A small, ordinary slice of real business data — one of everything the
 * reset is supposed to clear: a customer with an open order and a
 * receivable, a supplier with a purchase (stock and a FIFO layer), a
 * cash account with movements, and an expense.
 *
 * This replaces the demo seeder, which used to stand in as a data
 * generator here; the reset's contract has nothing to do with the demo.
 */
function seedBusinessData(): void {
  const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
  const materialId = createMaterial(
    { sku: 'RESET-M1', name: 'مادة', categoryId, unit: 'لوح', currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact' } as never,
    env.ctx
  )
  const accountId = createAccount(
    { name: 'صندوق التشغيل', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) },
    env.ctx
  )
  const supplierId = createSupplier({ name: 'مورد التشغيل' }, env.ctx)
  createPurchase({
    supplierId,
    cashAccountId: accountId,
    paidNowMinor: moneyFromMajor(300),
    lines: [{ materialId, qtyMicro: quantityFromDisplay(10), unitCostMicro: unitCostFromMajor(100) }]
  }, env.ctx)
  createExpense(
    { kind: 'variable', amountMinor: moneyFromMajor(50), description: 'مصروف تشغيلي', cashAccountId: accountId },
    env.ctx
  )
  const customerId = createCustomer({ name: 'عميل التشغيل' }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(2000) }]
  }, env.ctx)
  approveFinalInvoice(invoice.id, env.ctx)
}

/** A database created by an older build may still carry the retired demo manifest row. */
function seedLegacyDemoManifestRow(): void {
  getRawConnection()
    .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('demo.batch', ?, ?)")
    .run(JSON.stringify({ batchId: 'legacy', records: [] }), new Date().toISOString())
}

function runReset(nodeEnv = 'development', confirmed = true, extraArgs: string[] = []) {
  closeDatabase()
  setDatabasePath(undefined)
  return spawnSync(
    process.execPath,
    [
      resolve('scripts/reset-business-data.mjs'),
      '--database',
      databasePath,
      '--report', resolve(env.dir, 'reset-result.json'),
      ...(confirmed ? ['--confirm', 'RESET-DEVELOPMENT-BUSINESS-DATA'] : []),
      ...extraArgs
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: nodeEnv, AURA_DEV_BUSINESS_RESET: '1' }
    }
  )
}

describe('development business-data reset', () => {
  it('clears business state atomically and preserves login/security/bootstrap state', () => {
    seedBusinessData()
    seedLegacyDemoManifestRow()
    const raw = getRawConnection()
    const usersBefore = raw.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
    const rolesBefore = raw.prepare('SELECT COUNT(*) AS c FROM roles').get() as { c: number }
    const permissionsBefore = raw.prepare('SELECT COUNT(*) AS c FROM role_permissions').get() as { c: number }
    const accountsBefore = raw.prepare('SELECT id,name,kind,active,notes,created_at FROM cash_accounts ORDER BY id').all()
    const protectedTables = ['users', 'roles', 'role_permissions', 'remember_tokens', 'expense_categories', 'document_sequences', '__drizzle_migrations']
    const protectedRows = Object.fromEntries(protectedTables.map(table => [table, raw.prepare(`SELECT * FROM ${table}`).all()]))
    const settingsBefore = raw.prepare("SELECT * FROM app_settings WHERE key <> 'demo.batch' ORDER BY key").all()
    const schemaBefore = raw.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()
    const migrationsBefore = raw.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get() as { c: number }

    const result = runReset()
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(readFileSync(resolve(env.dir, 'reset-result.json'), 'utf8')) as {
      clearedTables: string[]
      foreignKeyCheck: unknown[]
      integrityCheck: string
      backupPath: string
    }

    setDatabasePath(databasePath)
    const reset = getRawConnection()
    for (const table of report.clearedTables) {
      expect((reset.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c)
        .toBe(0)
    }
    expect(report.foreignKeyCheck).toEqual([])
    expect(report.integrityCheck).toBe('ok')
    expect(report.backupPath).toContain('pre-reset')
    expect((reset.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c)
      .toBe(usersBefore.c)
    expect((reset.prepare('SELECT COUNT(*) AS c FROM roles').get() as { c: number }).c)
      .toBe(rolesBefore.c)
    expect((reset.prepare('SELECT COUNT(*) AS c FROM role_permissions').get() as { c: number }).c)
      .toBe(permissionsBefore.c)
    expect((reset.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get() as { c: number }).c)
      .toBe(migrationsBefore.c)
    expect((reset.prepare("SELECT COUNT(*) AS c FROM app_settings WHERE key = 'demo.batch'").get() as { c: number }).c)
      .toBe(0)
    expect(reset.prepare('SELECT id,name,kind,active,notes,created_at FROM cash_accounts ORDER BY id').all()).toEqual(accountsBefore)
    for (const table of protectedTables) expect(reset.prepare(`SELECT * FROM ${table}`).all()).toEqual(protectedRows[table])
    expect(reset.prepare("SELECT * FROM app_settings WHERE key <> 'demo.batch' ORDER BY key").all()).toEqual(settingsBefore)
    expect(reset.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()).toEqual(schemaBefore)
    expect(existsSync(report.backupPath)).toBe(true)
    expect((reset.prepare('SELECT opening_balance_minor AS amount FROM cash_accounts').get() as { amount: number }).amount)
      .toBe(0)
    expect((reset.prepare('SELECT COUNT(*) AS c FROM expense_categories').get() as { c: number }).c)
      .toBe(5)
    expect(reset.pragma('foreign_key_check')).toEqual([])
    expect(reset.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(needsSetup()).toBe(false)
    expect(login('owner', 'secret123', 2).session.user.username).toBe('owner')
    expect(customerBalances()).toEqual([])
    expect(supplierBalances()).toEqual([])
    expect(stockLevels()).toEqual([])
    expect(listAccounts().every(account => account.balanceMinor === 0 && account.transactionCount === 0)).toBe(true)
    const date = new Date().toISOString().slice(0, 10)
    expect(dashboardSummary({ date, year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), currentDay: true }, env.ctx.session)).toMatchObject({
      orders: { openCount: 0, dayCount: 0, recent: [] }, sales: { customerReceivablesMinor: 0 },
      financialAlerts: { cashBalanceMinor: 0 }, costs: { dayExpensesMinor: 0 },
      profits: { netProfitMinor: 0, completedOrderCount: 0 }, savings: { allocatedMinor: 0 }
    })
  })

  it('is deterministic and safe to run repeatedly', () => {
    seedBusinessData()
    expect(runReset().status).toBe(0)
    expect(runReset().status).toBe(0)
    setDatabasePath(databasePath)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it.each(['available', 'reserved', 'sold', 'resumed'])('clears %s Uncollected Products and their original/resale relationships with FKs enabled', state => {
    const customerId = createCustomer({ name: 'Original' }, env.ctx)
    const invoice = createFinalInvoice({ customerId, depositPercentBp: 0,
      lines: [{ lineKind: 'custom', description: 'Product', quantityMicro: 1000000, unitPriceMinor: 100000 }] }, env.ctx)
    const approval = approveFinalInvoice(invoice.id, env.ctx)
    const sheet = issueWorkSheet({ orderId: approval.orderId }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    cancelOrder({ orderId: approval.orderId, reason: 'Test' }, env.ctx)
    const product = productsFromOrder(approval.orderId)[0]!
    if (state === 'reserved' || state === 'sold') {
      const resale = createFinalInvoice({ customerId: createCustomer({ name: 'Resale' }, env.ctx), depositPercentBp: 0,
        lines: [{ lineKind: 'custom', description: 'Resale', quantityMicro: 1000000, unitPriceMinor: 200000, uncollectedProductId: product.id }] }, env.ctx)
      if (state === 'sold') approveFinalInvoice(resale.id, env.ctx)
    }
    if (state === 'resumed') resumeOriginalOrder({ id: product.id, confirmation: approval.orderNumber,
      requestKey: crypto.randomUUID(), expectedProductIds: [product.id] }, env.ctx)
    const raw = getRawConnection()
    raw.prepare("INSERT INTO uncollected_product_materials (product_id,position,name_snapshot) VALUES (?,0,'Frozen material')").run(product.id)
    raw.prepare("INSERT INTO uncollected_product_colors (product_id,position,code_snapshot) VALUES (?,0,'Frozen color')").run(product.id)
    raw.prepare("INSERT INTO uncollected_product_accessories (product_id,position,name_snapshot) VALUES (?,0,'Frozen accessory')").run(product.id)
    const result = runReset()
    expect(result.status, result.stderr).toBe(0)
    setDatabasePath(databasePath)
    for (const table of ['uncollected_products', 'uncollected_product_materials', 'uncollected_product_colors', 'uncollected_product_accessories', 'orders', 'order_lines', 'final_invoices', 'final_invoice_lines', 'work_sheets'])
      expect(getRawConnection().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
  })

  it('rolls back all deletions, cycle updates and account opening changes on a late failure', () => {
    seedBusinessData()
    const raw = getRawConnection()
    raw.exec("CREATE TRIGGER block_reset BEFORE DELETE ON customers BEGIN SELECT RAISE(ABORT,'forced reset failure'); END")
    const tables = raw.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    const snapshot = () => tables.map(({ name }) => getRawConnection().prepare(`SELECT * FROM "${name}"`).all())
    const before = snapshot()
    const result = runReset()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('forced reset failure')
    setDatabasePath(databasePath)
    expect(snapshot()).toEqual(before)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })

  it('refuses an unclassified new table before changing any data', () => {
    const raw = getRawConnection()
    raw.exec('CREATE TABLE future_business_domain (id INTEGER PRIMARY KEY)')
    const before = raw.prepare('SELECT * FROM users').all()
    const result = runReset()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unclassified tables')
    setDatabasePath(databasePath)
    expect(getRawConnection().prepare('SELECT * FROM users').all()).toEqual(before)
  })

  it('supports a nonmutating dry run and requires an active administrator', () => {
    const raw = getRawConnection()
    const before = raw.prepare('SELECT * FROM audit_log').all()
    const result = runReset('development', true, ['--dry-run'])
    expect(result.status, result.stderr).toBe(0)
    setDatabasePath(databasePath)
    expect(getRawConnection().prepare('SELECT * FROM audit_log').all()).toEqual(before)
    getRawConnection().prepare('UPDATE users SET active = 0').run()
    const denied = runReset()
    expect(denied.status).not.toBe(0)
    expect(denied.stderr).toContain('no active administrator')
  })

  it('the npm entrypoint cannot override production mode', () => {
    closeDatabase()
    const result = spawnSync('npm', ['run', 'reset:business-data', '--', '--database', databasePath,
      '--confirm', 'RESET-DEVELOPMENT-BUSINESS-DATA'], {
      encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' }
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('REFUSED')
  })

  it('refuses production mode and an invocation without explicit confirmation', () => {
    const countBefore = (getRawConnection().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
    const production = runReset('production')
    expect(production.status).not.toBe(0)
    expect(production.stderr).toContain('REFUSED')
    setDatabasePath(databasePath)
    expect((getRawConnection().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c)
      .toBe(countBefore)

    const unconfirmed = runReset('development', false)
    expect(unconfirmed.status).not.toBe(0)
    expect(unconfirmed.stderr).toContain('REFUSED')
  })
})

