// Run after npm run build. E2E02_MODE=red records the original compiled failure.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { release } from 'node:os'
import { _electron, expect } from '@playwright/test'
import Database from 'better-sqlite3'
const root = process.cwd(), mode = process.env.E2E02_MODE === 'red' ? 'red' : 'green'
const dir = mkdtempSync('/tmp/e2e-electron-e2e02-')
const evidence = { mode, environment: { platform: process.platform, arch: process.arch, os: release(), compiled: true, packaged: false }, actions: [], registered: [], images: [], failedRequests: [], console: [], network: [] }
let app, page
const save = () => writeFileSync(`/tmp/e2e02-${mode}-runtime.json`, JSON.stringify(evidence, null, 2))
const snapshot = () => { const db = new Database(join(dir, 'data/erp.db'), { readonly: true }); try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]) } finally { db.close() } }
const seed = inspect => execFileSync('npx', ['vite-node', '--config', 'vitest.config.ts', 'tests/electron/e2e02-seed.ts'], { cwd: root, env: { ...process.env, E2E02_DIR: dir, E2E02_INSPECT: inspect ? '1' : '' }, stdio: 'pipe' })
async function act(label, fn) { await fn(); evidence.actions.push(label); save() }
async function image(label, selector) {
  const img = page.locator(selector); await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate(i => i.complete)).toBe(true)
  const before = snapshot()
  const value = await img.evaluate(i => ({ src: i.getAttribute('src'), url: i.currentSrc || i.src, complete: i.complete, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight }))
  value.label = label
  await img.evaluate(i => new Promise(resolve => { i.onload = () => resolve('load'); i.onerror = () => resolve('error'); const src = i.src; i.removeAttribute('src'); i.src = src })).then(event => { value.event = event })
  assert.deepEqual(snapshot(), before)
  value.readOnly = true; evidence.images.push(value)
  await page.screenshot({ path: `/tmp/e2e02-${mode}-${label}.png` })
  if (mode === 'red') { assert.equal(value.url, 'file:///brand/logo-full.jpeg'); assert.equal(value.naturalWidth, 0); assert.equal(value.event, 'error') }
  else { assert.equal(value.url, pathToFileURL(join(root, 'out/renderer/brand/logo-full.jpeg')).href); assert.equal(value.naturalWidth, 1206); assert.equal(value.naturalHeight, 1161); assert.equal(value.event, 'load') }
  save()
}
async function login() {
  await act('username input', () => page.locator('input:not([type=password]):not([type=checkbox])').fill('owner'))
  await act('fictional password input', () => page.locator('input[type=password]').fill('secret123'))
  await act('login submit', () => page.getByRole('button', { name: 'دخول', exact: true }).click())
  await expect(page.locator('.sidebar__brand img')).toBeVisible()
}
try {
  seed(false); seed(true); evidence.freshHealth = JSON.parse(readFileSync(join(dir, 'inspection.json'), 'utf8'))
  const initial = snapshot()
  const entry = join(dir, 'entry.cjs')
  writeFileSync(entry, `const{app,ipcMain}=require('electron');app.setPath('userData',${JSON.stringify(dir)});app.setPath('sessionData',${JSON.stringify(join(dir, 'session'))});app.getAppPath=()=>${JSON.stringify(root)};global.e2e02Calls=[];const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,async(event,payload)=>{const result=await fn(event,payload);global.e2e02Calls.push({channel,sender:event.sender.id,ok:result?.ok,code:result?.error?.code});return result});import(require('node:url').pathToFileURL(${JSON.stringify(root + '/out/main/index.js')}).href);`)
  const launch = async () => {
    app = await _electron.launch({ args: [entry], env: { ...process.env, ELECTRON_RENDERER_URL: '' }, timeout: 60000 })
    page = await app.firstWindow(); page.setDefaultTimeout(20000)
    page.on('request', request => { if (/^https?:/.test(request.url())) evidence.network.push(request.url()) })
    page.on('requestfailed', request => evidence.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }))
    page.on('console', msg => { if (msg.type() === 'error') evidence.console.push(msg.text()) })
    await page.context().setOffline(true)
    evidence.environment.electron = await app.evaluate(() => process.versions.electron)
    evidence.preferences = await app.evaluate(({ BrowserWindow }) => { const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(); return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity } })
    assert.deepEqual(evidence.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true })
  }
  await launch(); await image('login', '.auth-logo'); await login(); await image('sidebar', '.sidebar__brand img')
  if (mode === 'green') {
    await act('expand Sales navigation', () => page.getByRole('button', { name: 'المبيعات', exact: true }).click())
    await act('navigate to customers', () => page.locator('.sidebar a[href="#/customers"]').click())
    await expect(page).toHaveURL(/#\/customers/)
    await act('authenticated reload', () => page.reload()); await image('authenticated-reload-login', '.auth-logo'); await login(); await image('sidebar-reload', '.sidebar__brand img')
    await act('logout', () => page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click())
    await image('logout-login', '.auth-logo')
    await act('login reload', () => page.reload()); await image('login-reload', '.auth-logo')
  }
  evidence.registered.push(...await app.evaluate(() => global.e2e02Calls)); await app.close(); app = undefined
  if (mode === 'green') { await launch(); await image('restart-login', '.auth-logo'); await login(); await image('restart-sidebar', '.sidebar__brand img'); evidence.registered.push(...await app.evaluate(() => global.e2e02Calls)); await app.close(); app = undefined }
  seed(true); evidence.finalHealth = JSON.parse(readFileSync(join(dir, 'inspection.json'), 'utf8'))
  assert.deepEqual(evidence.finalHealth.integrity, [{ integrity_check: 'ok' }]); assert.deepEqual(evidence.finalHealth.foreignKeys, []); assert.deepEqual(evidence.finalHealth.reconciliation.findings, [])
  const final = snapshot(); const business = rows => rows.filter(([name]) => !['audit_log', 'users', 'remember_tokens', 'sqlite_sequence'].includes(name))
  assert.deepEqual(business(final), business(initial)); evidence.noBusinessMutation = true
  evidence.auditActions = final.find(([name]) => name === 'audit_log')[1].map(row => row.action)
  assert.deepEqual(evidence.network, []); evidence.offline = true
  if (mode === 'green') assert.equal(evidence.failedRequests.filter(r => /logo-full/.test(r.url)).length, 0)
  evidence.status = 'PASS'; console.log(JSON.stringify(evidence, null, 2))
} catch (error) { evidence.status = 'FAIL'; evidence.error = error.stack; throw error }
finally { if (app) await app.close(); rmSync(dir, { recursive: true, force: true }); evidence.disposableStateCleaned = true; save() }
