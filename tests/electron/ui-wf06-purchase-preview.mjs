import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { _electron, expect } from '@playwright/test'
import Database from 'better-sqlite3'
const root = process.cwd()
const dir = mkdtempSync('/tmp/uiwf06-electron-')
let app
try {
  execFileSync('npx', ['vite-node', '--config', 'vitest.config.ts', 'tests/electron/ui-wf06-seed.ts'], { env: { ...process.env, UIWF06_DIR: dir }, stdio: 'pipe' })
  const fixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  const wrapper = join(dir, 'entry.cjs')
  writeFileSync(wrapper, `const {app,ipcMain}=require('electron');global.uiwf06Requests=[];const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,(event,...args)=>{if(channel==='purchases:create')global.uiwf06Requests.push(args[0]);return fn(event,...args)});app.setPath('userData',process.env.UIWF06_DIR);app.setPath('sessionData',process.env.UIWF06_DIR);app.getAppPath=()=>process.env.UIWF06_ROOT;import(require('node:url').pathToFileURL(process.env.UIWF06_ROOT+'/out/main/index.js').href);`)
  app = await _electron.launch({ args: [wrapper], env: { ...process.env, UIWF06_DIR: dir, UIWF06_ROOT: root }, timeout: 60000 })
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dir)
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.locator('input:not([type=password]):not([type=checkbox])').fill('owner')
  await page.locator('input[type=password]').fill('secret123')
  await page.getByRole('button', { name: 'دخول', exact: true }).click()
  await page.evaluate(() => { window.location.hash = '/purchases' })
  await page.getByRole('button', { name: '+ فاتورة شراء', exact: true }).click()
  await page.locator('.modal select').first().selectOption(String(fixture.supplierId))
  await page.locator('.modal .subform-row .customer-select__trigger').first().click()
  await page.getByRole('option').filter({ hasText: 'UIWF06 material' }).click()
  const snapshot = () => {
    const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
    try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()]) } finally { db.close() }
  }
  const beforePreview = snapshot()
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, 'format')
    window.__uiwf06Formatted = []
    Object.defineProperty(Intl.NumberFormat.prototype, 'format', { ...descriptor, get() {
      const original = descriptor.get.call(this)
      return (value) => { window.__uiwf06Formatted.push(value); return original(value) }
    } })
  })
  const numbers = page.locator('.modal input[type=number]')
  await numbers.nth(0).fill('0.145')
  await numbers.nth(1).fill('0.100000')
  const preview = await page.locator('.modal input[disabled]').first().inputValue()
  assert.match(preview, /0[,.]02/)
  const formatted = await page.evaluate(() => window.__uiwf06Formatted)
  assert.ok(formatted.includes(0.015), 'Actual renderer formatted exact 15 minor')
  assert.deepEqual(snapshot(), beforePreview, 'Typing preview changes no SQLite table')
  const before = await page.evaluate(() => window.erp.purchases.list({}))
  assert.equal(before.ok, true)
  const requests = []
  await page.getByRole('button', { name: 'حفظ الفاتورة', exact: true }).click()
  await expect(page.locator('body')).toContainText('تم تسجيل فاتورة الشراء')
  requests.push(...await app.evaluate(() => global.uiwf06Requests))
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].lines[0], { materialId: fixture.materialId, qtyMicro: 145000, unitCostMicro: 100000, batchCode: null })
  const detail = await page.evaluate(() => window.erp.purchases.get({ id: 1 }))
  assert.equal(detail.ok, true)
  assert.equal(detail.data.purchase.totalMinor, 15)
  assert.equal(detail.data.lines[0].lineTotalMinor, 15)
  await app.close(); app = undefined
  const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM purchases').get().n, 1)
    assert.deepEqual(db.prepare('SELECT qty_micro,actual_cost_minor,source_ref_id FROM inventory_movements').all(), [{ qty_micro: 145000, actual_cost_minor: 15, source_ref_id: 1 }])
    assert.deepEqual(db.prepare('SELECT qty_received_micro,qty_remaining_micro,unit_cost_micro,source_ref_id FROM fifo_layers').all(), [{ qty_received_micro: 145000, qty_remaining_micro: 145000, unit_cost_micro: 100000, source_ref_id: 1 }])
    assert.equal(db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='purchases.create'").get().n, 1)
    console.log(JSON.stringify({ status: 'PASS', previewDisplay: preview, previewMinor: 15, formattedMajor: formatted, previewReadOnly: true, committedMinor: 15, requests, detail: detail.data, inventory: 'PASS', fifo: 'PASS', duplicateMutation: false, integrity: db.pragma('integrity_check'), fk: db.pragma('foreign_key_check') }, null, 2))
  } finally { db.close() }
} finally { if (app) await app.close(); rmSync(dir, { recursive: true, force: true }) }
