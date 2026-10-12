// Run after npm run build: node tests/electron/ui-wf05-commission-payment.mjs
// Uses a real restricted login and the production renderer/preload/IPC bundle.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { _electron, expect } from '@playwright/test'
import Database from 'better-sqlite3'

const root = process.cwd()
const dir = mkdtempSync('/tmp/uiwf05-electron-')
let app
try {
  execFileSync('npx', ['vite-node', '--config', 'vitest.config.ts', 'tests/electron/ui-wf05-seed.ts'], {
    cwd: root, env: { ...process.env, UIWF05_DIR: dir }, stdio: 'pipe'
  })
  const fixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  const wrapper = join(dir, 'entry.cjs')
  // Resource lookup only; business services and authorization are the unmodified production bundle.
  writeFileSync(wrapper, `const {app}=require('electron');app.setPath('userData',process.env.UIWF05_DIR);app.setPath('sessionData',process.env.UIWF05_DIR);app.getAppPath=()=>process.env.UIWF05_ROOT;import(require('node:url').pathToFileURL(process.env.UIWF05_ROOT+'/out/main/index.js').href);`)
  app = await _electron.launch({ args: [wrapper], env: { ...process.env, UIWF05_DIR: dir, UIWF05_ROOT: root }, timeout: 60000 })
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dir)
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  console.log('Electron production bundle ready')
  await page.locator('input:not([type=password]):not([type=checkbox])').fill('uiwf05-payer')
  await page.locator('input[type=password]').fill('secret123')
  await page.getByRole('button', { name: 'دخول', exact: true }).click()
  const row = page.getByRole('row').filter({ hasText: 'عامل UI-WF-05' })
  await expect(row).toContainText('50,00')
  await row.getByRole('button', { name: 'دفعة', exact: true }).click()
  const choices = await page.evaluate(() => window.erp.workers.commissionAccounts())
  assert.equal(choices.ok, true)
  for (const choice of choices.data) assert.deepEqual(Object.keys(choice).sort(), ['id', 'name'])
  await expect(page.locator('select')).toContainText('خزينة اختيار آمن')
  await expect(page.locator('select')).not.toContainText('100')
  await expect(page.locator('select')).not.toContainText('SECRET CASH NOTE')
  await page.locator('input[type=number]').fill('10')
  await page.locator('select').selectOption(String(fixture.accountId))
  await page.getByRole('button', { name: 'تأكيد الدفعة', exact: true }).click()
  await expect(page.locator('body')).toContainText('تم تسجيل دفعة المستحقات')
  await expect(row).toContainText('40,00')
  for (const method of ['accounts', 'transactions']) {
    const result = await page.evaluate((method) => window.erp.cash[method]({}), method)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'FORBIDDEN')
  }
  const adjustment = await page.evaluate((accountId) => window.erp.cash.adjustBalance({ accountId, desiredBalanceMinor: 100000, reason: 'UI05 negative control', requestKey: 'ui05-denied-adjustment' }), fixture.accountId)
  assert.equal(adjustment.ok, false)
  assert.equal(adjustment.error.code, 'FORBIDDEN')
  await page.evaluate(() => { window.location.hash = '/cash' })
  await expect(page).not.toHaveURL(/#\/cash$/)
  await expect(page.locator('body')).not.toContainText('تعديل الرصيد')
  const refreshed = await page.evaluate(() => window.erp.workers.list({}))
  assert.equal(refreshed.data.find((worker) => worker.id === fixture.workerId).payableMinor, 40000)
  await page.reload()
  await page.locator('input:not([type=password]):not([type=checkbox])').fill('uiwf05-payer')
  await page.locator('input[type=password]').fill('secret123')
  await page.getByRole('button', { name: 'دخول', exact: true }).click()
  await expect(page.getByRole('row').filter({ hasText: 'عامل UI-WF-05' })).toContainText('40,00')
  await app.close()
  app = undefined
  const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
  try {
    const sources = db.prepare("SELECT id, worker_id, amount_minor, cash_account_id FROM worker_transactions WHERE kind='commission_payment'").all()
    assert.equal(sources.length, 1)
    assert.deepEqual(sources[0], { id: sources[0].id, worker_id: fixture.workerId, amount_minor: 10000, cash_account_id: fixture.accountId })
    const cash = db.prepare("SELECT direction, amount_minor, account_id, ref_table, ref_id FROM cash_transactions WHERE kind='worker_commission_payment'").all()
    assert.deepEqual(cash, [{ direction: 'out', amount_minor: 10000, account_id: fixture.accountId, ref_table: 'worker_transactions', ref_id: sources[0].id }])
    const audit = db.prepare("SELECT entity,entity_id FROM audit_log WHERE action='workers.commission.payment'").all()
    assert.deepEqual(audit, [{ entity: 'worker_transactions', entity_id: String(sources[0].id) }])
    console.log(JSON.stringify({ status: 'PASS', permissions: fixture.permissions, selector: choices.data, payableBefore: 50000, payableAfter: 40000, sources, cash, audit, broadCash: 'FORBIDDEN', adjustment: 'FORBIDDEN', cashRoute: 'DENIED', reload: 'PASS' }, null, 2))
  } finally { db.close() }
} finally {
  if (app) await app.close()
  rmSync(dir, { recursive: true, force: true })
}
