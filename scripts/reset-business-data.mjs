import Database from 'better-sqlite3'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RESET_CONFIRMATION = 'RESET-DEVELOPMENT-BUSINESS-DATA'

const CLEARED_TABLES = [
  // Request receipts are business-state children: retaining them while their
  // economic rows are deliberately cleared would replay stale/nonexistent results.
  'financial_command_requests',
  'notification_dismissals',
  'notification_reads',
  'uncollected_product_colors',
  'uncollected_product_accessories',
  'uncollected_product_materials',
  'uncollected_products',
  'delivery_workers',
  'release_workers',
  'work_sheet_workers',
  'order_worker_assignments',
  'order_machine_usage',
  'planned_order_expenses',
  'planned_workers',
  'planned_machines',
  'planned_materials',
  'material_return_allocations',
  'material_return_events',
  'material_returns',
  'order_material_lines',
  'fifo_allocations',
  'inventory_movements',
  'material_remainders',
  'finished_goods_valuation_cutovers',
  'finished_goods_movements',
  'final_invoice_line_accessories',
  'final_invoice_line_colors',
  'final_invoice_line_materials',
  'order_line_accessories',
  'order_line_colors',
  'order_line_materials',
  'quotation_line_accessories',
  'quotation_line_colors',
  'quotation_line_materials',
  'product_commission_lines',
  'product_machine_lines',
  'product_bom_lines',
  'final_invoice_terms',
  'invoice_approval_history',
  'employee_salary_history',
  'recurring_expense_amounts',
  'savings_transactions',
  'deliveries',
  'releases',
  'customer_payment_refund_allocations',
  'customer_payment_refunds',
  'customer_payments',
  'supplier_payments',
  'expenses',
  'profit_withdrawals',
  'worker_transactions',
  'employee_transactions',
  'cash_transactions',
  'recurring_expenses',
  'savings_allocations',
  'purchase_lines',
  'purchases',
  'fifo_layers',
  'final_invoice_lines',
  'order_lines',
  'quotation_lines',
  'work_sheets',
  'final_invoices',
  'orders',
  'quotations',
  'products',
  'machines',
  'workers',
  'employees',
  'suppliers',
  'customers',
  'materials',
  'color_finish_catalog',
  'material_categories'
]

const REQUIRED_TABLES = [
  '__drizzle_migrations',
  'app_settings',
  'audit_log',
  'cash_accounts',
  'expense_categories',
  'role_permissions',
  'roles',
  'users',
  'remember_tokens',
  'document_sequences'
]

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function tableCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

export async function resetBusinessData(databasePath, options = {}) {
  assertDevelopmentMode()
  const absolutePath = resolve(databasePath)
  if (!existsSync(absolutePath)) throw new Error(`Database does not exist: ${absolutePath}`)

  const db = new Database(absolutePath, { fileMustExist: true, readonly: options.dryRun === true })
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  try {
    if (db.pragma('foreign_keys', { simple: true }) !== 1)
      throw new Error('Foreign-key enforcement is not enabled')
    const existingTables = new Set(
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name)
    )
    for (const table of [...REQUIRED_TABLES, ...CLEARED_TABLES]) {
      if (!existingTables.has(table)) throw new Error(`Expected ERP table is missing: ${table}`)
    }
    const unknown = [...existingTables].filter(table => !REQUIRED_TABLES.includes(table) && !CLEARED_TABLES.includes(table))
    if (unknown.length) throw new Error(`Reset refused: unclassified tables require review: ${unknown.join(', ')}`)
    if (!db.prepare(`SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.active = 1 AND r.is_admin = 1 LIMIT 1`).get())
      throw new Error('Reset refused: no active administrator login exists')
    assertIntegrity(db)

    const counts = () => Object.fromEntries([...existingTables].sort().map(table => [table, tableCount(db, table)]))
    if (options.dryRun) return { databasePath: absolutePath, dryRun: true,
      clearedTables: [...CLEARED_TABLES], preservedTables: [...REQUIRED_TABLES], before: counts(),
      openingBalancesToClear: db.prepare('SELECT id, opening_balance_minor FROM cash_accounts WHERE opening_balance_minor <> 0').all() }

    const dataDirectory = dirname(absolutePath)
    const backupDir = options.backupDirectory ?? (
      basename(dataDirectory) === 'data'
        ? join(dataDirectory, '..', 'backups', 'pre-reset')
        : join(dataDirectory, 'pre-reset-backups')
    )
    mkdirSync(backupDir, { recursive: true })
    const backupPath = join(backupDir, `${basename(absolutePath, '.db')}-pre-reset-${timestamp()}.sqlite`)
    await db.backup(backupPath)
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true })
    try { assertIntegrity(backup) } finally { backup.close() }

    return db.transaction(() => {
      const before = counts()
      const protectedTables = REQUIRED_TABLES.filter(table => !['audit_log', 'app_settings', 'cash_accounts'].includes(table))
      const protectedRows = Object.fromEntries(protectedTables.map(table => [table,
        JSON.stringify(db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all())]))
      const schemaBefore = JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all())
      // Every setting is preserved except the retired demo manifest row, which this reset deletes.
      const settingsBefore = JSON.stringify(db.prepare("SELECT * FROM app_settings WHERE key <> 'demo.batch' ORDER BY key").all())
      const accountsBefore = JSON.stringify(db.prepare('SELECT id,name,kind,active,notes,created_at FROM cash_accounts ORDER BY id').all())
      const openingBalancesBefore = db.prepare('SELECT id,opening_balance_minor FROM cash_accounts ORDER BY id').all()

      // Only nullable links between records being removed are broken. FK enforcement stays ON.
      db.prepare('UPDATE orders SET final_invoice_id = NULL').run()
      db.prepare('UPDATE final_invoices SET order_id = NULL').run()
      db.prepare('UPDATE order_lines SET uncollected_product_id = NULL').run()
      db.prepare('UPDATE final_invoice_lines SET uncollected_product_id = NULL').run()
      db.prepare('UPDATE color_finish_catalog SET related_material_id = NULL').run()
      db.prepare('UPDATE materials SET color_id = NULL').run()
      db.prepare('UPDATE material_categories SET parent_id = NULL').run()
      for (const table of CLEARED_TABLES) {
        try { db.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run() }
        catch (error) { throw new Error(`Failed while clearing ${table}: ${error instanceof Error ? error.message : String(error)}`) }
      }
      // Opening money is canonical business data, not a dashboard summary. Keep every account definition.
      db.prepare('UPDATE cash_accounts SET opening_balance_minor = 0 WHERE opening_balance_minor <> 0').run()
      // Legacy cleanup: the demo feature is gone, but a database created
      // by an older build may still carry its manifest row. Removing it
      // here — and its audit residue below — is what makes a reset
      // produce a genuinely clean customer database. Nothing reads this
      // key any more; it is excluded from the protected-settings
      // comparison above and below for exactly that reason.
      db.prepare("DELETE FROM app_settings WHERE key = 'demo.batch'").run()
      const placeholders = CLEARED_TABLES.map(() => '?').join(', ')
      const deletedAuditRows = db.prepare(`DELETE FROM audit_log WHERE entity IN (${placeholders})
        OR (entity = 'app_settings' AND entity_id = 'demo.batch')`).run(...CLEARED_TABLES).changes
      const afterClear = counts()
      const removedRows = Object.keys(before).reduce((sum, table) => sum + before[table] - afterClear[table], 0)
      db.prepare(`INSERT INTO audit_log (action,entity,entity_id,details,created_at)
        VALUES ('reset.businessData','database',?,?,?)`).run(absolutePath,
        JSON.stringify({ mode: process.env.NODE_ENV ?? 'development', backupPath, removedRows,
          deletedAuditRows, clearedTables: CLEARED_TABLES,
          openingBalancesCleared: openingBalancesBefore.filter(row => row.opening_balance_minor !== 0).length }), new Date().toISOString())

      for (const table of CLEARED_TABLES) {
        if (tableCount(db, table) !== 0) throw new Error(`Reset left records in ${table}`)
      }
      for (const table of protectedTables) {
        if (JSON.stringify(db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all()) !== protectedRows[table])
          throw new Error(`Protected records changed: ${table}`)
      }
      if (JSON.stringify(db.prepare("SELECT * FROM app_settings WHERE key <> 'demo.batch' ORDER BY key").all()) !== settingsBefore
        || JSON.stringify(db.prepare('SELECT id,name,kind,active,notes,created_at FROM cash_accounts ORDER BY id').all()) !== accountsBefore
        || JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()) !== schemaBefore)
        throw new Error('Protected configuration or database schema changed')
      assertIntegrity(db)
      return { databasePath: absolutePath, backupPath, clearedTables: [...CLEARED_TABLES],
        preservedTables: [...REQUIRED_TABLES], removedRows, deletedAuditRows, before, after: counts(),
        openingBalancesBefore, openingBalancesAfter: db.prepare('SELECT id,opening_balance_minor FROM cash_accounts ORDER BY id').all(),
        foreignKeyCheck: db.pragma('foreign_key_check'), integrityCheck: db.pragma('integrity_check', { simple: true }) }
    }).immediate()
  } finally { db.close() }
}

function assertIntegrity(db) {
  const violations = db.pragma('foreign_key_check')
  if (violations.length) throw new Error(`Foreign-key violations: ${JSON.stringify(violations)}`)
  const integrity = db.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') throw new Error(`Database integrity check failed: ${integrity}`)
}

function assertDevelopmentMode() {
  if (process.env.AURA_DEV_BUSINESS_RESET !== '1'
    || (process.env.NODE_ENV !== undefined && !['development', 'test'].includes(process.env.NODE_ENV))
    || process.argv.some(arg => arg.includes('app.asar')))
    throw new Error('REFUSED: business reset is available only through the explicit development/test command')
}

function argumentValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main() {
  assertDevelopmentMode()
  const databasePath = argumentValue(process.argv.slice(2), '--database')
  const confirmation = argumentValue(process.argv.slice(2), '--confirm')
  if (!databasePath || !isAbsolute(databasePath)) {
    throw new Error('REFUSED: --database must be an explicit absolute path')
  }
  if (confirmation !== RESET_CONFIRMATION) {
    throw new Error(`REFUSED: pass --confirm ${RESET_CONFIRMATION}`)
  }
  if (process.argv.some((arg) => arg.includes('app.asar'))) {
    throw new Error('REFUSED: reset cannot run from a packaged application')
  }

  console.log(`Development business-data reset: ${databasePath}`)
  console.log(`Close the ERP before resetting. Will clear ${CLEARED_TABLES.length} business tables; security/configuration and numbering remain.`)
  const result = await resetBusinessData(databasePath, {
    dryRun: process.argv.includes('--dry-run'),
    backupDirectory: argumentValue(process.argv.slice(2), '--backup-directory')
  })
  const reportPath = argumentValue(process.argv.slice(2), '--report')
  if (reportPath) writeFileSync(reportPath, JSON.stringify(result, null, 2) + '\n')
  if (result.dryRun) {
    console.log('Dry run: no business data changed.')
    for (const table of CLEARED_TABLES) {
      if (result.before[table]) console.log(`${table}: ${result.before[table]} row(s) to clear`)
    }
    console.log(`Account opening balances to clear: ${result.openingBalancesToClear.length}`)
  } else {
    console.log(`Reset complete: ${result.removedRows} rows removed; ${CLEARED_TABLES.length} business tables empty.`)
    for (const table of Object.keys(result.before)) {
      if (result.before[table] !== result.after[table]) console.log(`${table}: ${result.before[table]} -> ${result.after[table]}`)
    }
    console.log(`Account opening balances cleared: ${result.openingBalancesBefore.filter(row => row.opening_balance_minor !== 0).length}`)
    console.log(`Backup: ${result.backupPath}`)
    console.log(`foreign_key_check: ${result.foreignKeyCheck.length === 0 ? 'clean' : 'FAILED'}; integrity_check: ${result.integrityCheck}`)
  }
  if (reportPath) console.log(`Detailed counts: ${resolve(reportPath)}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
