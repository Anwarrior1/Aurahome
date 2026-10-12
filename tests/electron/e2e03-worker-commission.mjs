// Requires npm run build. All business calls use the compiled preload/router/owners.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { release } from 'node:os'
import { _electron, expect } from '@playwright/test'
import Database from 'better-sqlite3'

const root = process.cwd()
const dir = mkdtempSync('/tmp/e2e-electron-e2e03-')
const evidence = { environment: { platform: process.platform, arch: process.arch, os: release(), compiled: true, packaged: false }, actions: [], registered: [], calls: [], fixtureDir: dir }
let app, page
const save = () => writeFileSync('/tmp/e2e03-runtime.json', JSON.stringify(evidence, null, 2))
const database = (fn) => { const db = new Database(join(dir, 'data/erp.db'), { readonly: true }); try { return fn(db) } finally { db.close() } }
const rows = (table) => database(db => db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all())
const snapshot = () => database(db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
const sideEffects = () => Object.fromEntries(['inventory_movements', 'fifo_layers', 'fifo_allocations', 'work_sheets', 'orders', 'final_invoices', 'customer_payments', 'customer_payment_refunds'].map(t => [t, rows(t)]))
async function act(label, fn) { await fn(); evidence.actions.push(label); save() }
async function ipc(group, method, payload) { const result = await page.evaluate(({ group, method, payload }) => window.erp[group][method](payload), { group, method, payload }); evidence.calls.push({ group, method, payload, result }); save(); return result }
async function login(username) {
  await act('login username', () => page.locator('input:not([type=password]):not([type=checkbox])').fill(username))
  await act('fictional login password', () => page.locator('input[type=password]').fill('secret123'))
  await act('login submit', () => page.getByRole('button', { name: 'دخول', exact: true }).click())
  await expect(page.getByRole('row').filter({ hasText: 'عامل E2E03' })).toBeVisible()
}
const seed = (inspect = false) => execFileSync('npx', ['vite-node', '--config', 'vitest.config.ts', 'tests/electron/e2e03-seed.ts'], { cwd: root, env: { ...process.env, E2E03_DIR: dir, E2E03_INSPECT: inspect ? '1' : '' }, stdio: 'pipe' })
try {
  seed()
  const fixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  evidence.fixture = fixture
  assert.equal(fixture.payable.payableMinor, 10000)
  assert.equal(fixture.cashMinor, 50000)
  assert.deepEqual(fixture.beforeReconciliation.findings, [])
  const entry = join(dir, 'entry.cjs')
  writeFileSync(entry, `const {app,ipcMain}=require('electron');app.setPath('userData',${JSON.stringify(dir)});app.setPath('sessionData',${JSON.stringify(join(dir, 'session'))});app.getAppPath=()=>${JSON.stringify(root)};global.e2e03Calls=[];const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,async(event,payload)=>{const result=await fn(event,payload);global.e2e03Calls.push({channel,sender:event.sender.id,ok:result?.ok,code:result?.error?.code,...(channel==='workers:payCommission'?{payload,result}:{})});return result});import(require('node:url').pathToFileURL(${JSON.stringify(root + '/out/main/index.js')}).href);`)
  const launch = async () => {
    app = await _electron.launch({ args: [entry], env: { ...process.env, ELECTRON_RENDERER_URL: '' }, timeout: 60000 })
    page = await app.firstWindow(); page.setDefaultTimeout(20000)
    evidence.environment.electron = await app.evaluate(() => process.versions.electron)
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dir)
  }
  await launch()
  await login('e2e03-viewer')
  const beforeDenied = snapshot()
  const request = { workerId: fixture.workerId, cashAccountId: fixture.accountId, amountMinor: 10000, requestKey: 'e2e03-runtime-denied' }
  const denied = await ipc('workers', 'payCommission', request)
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'FORBIDDEN')
  assert.deepEqual(snapshot(), beforeDenied)
  await ipc('auth', 'logout')
  await page.reload()
  await login('e2e03-payer')
  const beforeInvalid = snapshot()
  const invalid = await ipc('workers', 'payCommission', { ...request, amountMinor: 0, requestKey: 'e2e03-runtime-invalid' })
  assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'VALIDATION_ERROR')
  assert.deepEqual(snapshot(), beforeInvalid)
  const unchanged = sideEffects()
  const row = page.getByRole('row').filter({ hasText: 'عامل E2E03' })
  await expect(row).toContainText('10,00')
  await act('open Workers commission payment', () => row.getByRole('button', { name: 'دفعة', exact: true }).click())
  const modal = page.getByRole('dialog')
  await act('enter 10 LYD payment', () => modal.locator('input[type=number]').fill('10'))
  await act('select E2E03 cash account', () => modal.locator('select').selectOption(String(fixture.accountId)))
  await act('confirm commission payment', () => modal.getByRole('button', { name: 'تأكيد الدفعة', exact: true }).click())
  await expect(page.locator('body')).toContainText('تم تسجيل دفعة المستحقات')
  await modal.waitFor({ state: 'hidden' })
  const list = await ipc('workers', 'list', {})
  assert.equal(list.data.find(w => w.id === fixture.workerId).payableMinor, 0)
  await page.screenshot({ path: '/tmp/e2e03-workers-paid.png' })
  const source = rows('worker_transactions').filter(r => r.kind === 'commission_payment')
  assert.equal(source.length, 1)
  assert.equal(source[0].amount_minor, 10000); assert.equal(source[0].cash_account_id, fixture.accountId)
  const cash = rows('cash_transactions').filter(r => r.ref_table === 'worker_transactions' && r.ref_id === source[0].id)
  assert.equal(cash.length, 1)
  assert.equal(cash[0].direction, 'out'); assert.equal(cash[0].amount_minor, 10000); assert.equal(cash[0].account_id, fixture.accountId); assert.equal(cash[0].kind, 'worker_commission_payment')
  const audit = rows('audit_log').filter(r => r.action === 'workers.commission.payment')
  assert.equal(audit.length, 1); assert.equal(audit[0].entity_id, String(source[0].id))
  const cashAfter = database(db => db.prepare("SELECT a.opening_balance_minor + COALESCE((SELECT SUM(CASE direction WHEN 'in' THEN amount_minor ELSE -amount_minor END) FROM cash_transactions WHERE account_id=a.id),0) AS balance FROM cash_accounts a WHERE a.id=?").get(fixture.accountId).balance)
  assert.equal(cashAfter, 40000)
  assert.deepEqual(sideEffects(), unchanged)
  evidence.payment = { source, cash, audit, payableBefore: 10000, payableAfter: 0, cashBefore: 50000, cashAfter, noInventoryOrOrderChanges: true }
  evidence.registered.push(...await app.evaluate(() => global.e2e03Calls))
  await app.close(); app = undefined
  seed(true)
  evidence.populatedHealth = JSON.parse(readFileSync(join(dir, 'inspection.json'), 'utf8'))
  assert.equal(evidence.populatedHealth.readOnly, true); assert.deepEqual(evidence.populatedHealth.reconciliation.findings, [])
  await launch(); await login('e2e03-payer')
  const restarted = await ipc('workers', 'list', {})
  assert.equal(restarted.data.find(w => w.id === fixture.workerId).payableMinor, 0)
  assert.deepEqual(rows('worker_transactions').filter(r => r.kind === 'commission_payment'), source)
  assert.deepEqual(rows('cash_transactions').filter(r => r.ref_table === 'worker_transactions' && r.ref_id === source[0].id), cash)
  assert.deepEqual(rows('audit_log').filter(r => r.action === 'workers.commission.payment'), audit)
  evidence.restart = true
  evidence.registered.push(...await app.evaluate(() => global.e2e03Calls))
  await app.close(); app = undefined
  seed(true)
  evidence.restartHealth = JSON.parse(readFileSync(join(dir, 'inspection.json'), 'utf8'))
  assert.deepEqual(evidence.restartHealth.integrity, [{ integrity_check: 'ok' }]); assert.deepEqual(evidence.restartHealth.foreignKeys, []); assert.deepEqual(evidence.restartHealth.reconciliation.findings, [])
  evidence.status = 'PASS'
  console.log(JSON.stringify({ status: evidence.status, uiActions: evidence.actions.length, registeredCalls: evidence.registered.length, payment: evidence.payment, restart: evidence.restart, health: evidence.restartHealth }, null, 2))
} catch (err) { evidence.status = 'FAIL'; evidence.error = err.stack; throw err }
finally { if (app) await app.close(); save(); rmSync(dir, { recursive: true, force: true }); evidence.disposableStateCleaned = true; save() }
