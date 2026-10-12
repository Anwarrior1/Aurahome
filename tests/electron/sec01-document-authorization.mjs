// Run after npm run build: node tests/electron/sec01-document-authorization.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { _electron, expect } from '@playwright/test'
import Database from 'better-sqlite3'
const root = process.cwd(), dir = mkdtempSync('/tmp/sec01-electron-')
let app
const evidence = { checks: [], outputs: [], status: 'INCOMPLETE' }
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
try {
  execFileSync('npx', ['vite-node', '--config', 'vitest.config.ts', 'tests/electron/sec01-seed.ts'], { env: { ...process.env, SEC01_DIR: dir }, stdio: 'pipe' })
  const fixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  const entry = join(dir, 'entry.cjs')
  // Record outputs and window creation without changing authorization or native printing/PDF.
  // The final-invoice fallback's external PDF viewer is suppressed; its real PDF is verified.
  writeFileSync(entry, `const {app,ipcMain,shell}=require('electron');global.sec01Calls=[];global.sec01Windows=0;global.sec01Opened=[];app.on('browser-window-created',()=>global.sec01Windows++);shell.openPath=async(path)=>{global.sec01Opened.push(path);return ''};const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,async(event,...args)=>{const result=await fn(event,...args);global.sec01Calls.push({channel,ok:result.ok,error:result.error?.code});return result});app.setPath('userData',process.env.SEC01_DIR);app.setPath('sessionData',process.env.SEC01_DIR);app.getAppPath=()=>process.env.SEC01_ROOT;import(require('node:url').pathToFileURL(process.env.SEC01_ROOT+'/out/main/index.js').href);`)
  app = await _electron.launch({ args: [entry], env: { ...process.env, SEC01_DIR: dir, SEC01_ROOT: root }, timeout: 60000 })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.setDefaultTimeout(15000)
  const call = (group, method, args, target = page) => target.evaluate(({ group, method, args }) => window.erp[group][method](args), { group, method, args })
  const snapshot = () => {
    const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
    try { return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()])) } finally { db.close() }
  }
  const files = (path = join(dir, 'documents')) => existsSync(path) ? readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]) : []
  const fileState = () => files().map((path) => [path, hash(readFileSync(path).toString('base64'))])
  async function login(username, target = page) {
    const result = await call('auth', 'login', { username, password: 'secret123', rememberMe: false }, target)
    assert.equal(result.ok, true)
    return result.data.session
  }
  async function denied(group, method, args, code = 'FORBIDDEN') {
    const before = hash(snapshot()), outputBefore = fileState(), windows = await app.evaluate(() => global.sec01Windows)
    const result = await call(group, method, args)
    assert.deepEqual(result, { ok: false, error: { code, message: result.error?.message } })
    assert.equal(typeof result.error.message, 'string')
    assert.equal(hash(snapshot()), before)
    assert.deepEqual(fileState(), outputBefore)
    assert.equal(await app.evaluate(() => global.sec01Windows), windows)
    evidence.checks.push({ group, method, args, code, noPayload: true, sqliteUnchanged: true, noWindowOrFile: true })
  }
  evidence.environment = await app.evaluate(({ app, BrowserWindow }) => ({ isPackaged: app.isPackaged, version: process.versions.electron, userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), url: BrowserWindow.getAllWindows()[0].webContents.getURL(), preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences() }))
  assert.equal(evidence.environment.userData, dir)
  assert.equal(evidence.environment.sessionData, dir)
  for (const method of ['preview', 'print', 'exportPdf']) await denied('documents', method, { kind: 'final_invoice', id: fixture.documents.final_invoice }, 'UNAUTHENTICATED')
  // First restricted login uses the actual rendered login form.
  await page.locator('input:not([type=password]):not([type=checkbox])').fill('restricted')
  await page.locator('input[type=password]').fill('secret123')
  await page.getByRole('button', { name: 'دخول', exact: true }).click()
  await expect(page.locator('input[type=password]')).toHaveCount(0)
  await denied('finalInvoices', 'get', { id: fixture.documents.final_invoice })
  await denied('orders', 'get', { id: fixture.orderId })
  for (const [kind, id] of Object.entries(fixture.documents)) {
    for (const method of ['preview', 'print', 'exportPdf']) await denied('documents', method, { kind, id, isAdmin: true, permissions: ['finalInvoices.view'] })
  }
  assert.notEqual(fixture.documents.delivery_release, fixture.documents.final_invoice)
  for (const id of [999999, -1, 0, fixture.documents.delivery_release]) await denied('documents', 'preview', { kind: 'final_invoice', id })
  for (const args of [{ kind: 'unknown', id: 1 }, { kind: 'final_invoice', id: '1' }, { kind: 'final_invoice', id: 1.5 }]) await denied('documents', 'preview', args, 'VALIDATION_ERROR')
  const roles = { unrelated: [], quotation: ['preliminary_invoice'], invoice: ['final_invoice'], production: ['work_sheet'], release: ['installation_release', 'delivery_release'], viewer: Object.keys(fixture.documents) }
  for (const [username, allowed] of Object.entries(roles)) {
    const session = await login(username)
    const before = hash(snapshot())
    for (const [kind, id] of Object.entries(fixture.documents)) {
      if (!allowed.includes(kind)) { for (const method of ['preview', 'print', 'exportPdf']) await denied('documents', method, { kind, id }); continue }
      const result = await call('documents', 'preview', { kind, id })
      assert.equal(result.ok, true)
      assert.ok(result.data.html.includes('SEC01 fictional customer'))
      if (kind === 'work_sheet') { assert.equal(result.data.html.includes('د.ل'), false); assert.equal(result.data.html.includes('تكلفة'), false) }
      evidence.checks.push({ username, permissions: session.permissions, kind, authorizedPreview: true, customerSafe: kind === 'work_sheet' })
    }
    assert.equal(hash(snapshot()), before)
  }
  const printers = await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getPrintersAsync())
  evidence.printers = printers.map(({ name }) => name)
  const beforeOutputs = hash(snapshot())
  for (const [kind, id] of Object.entries(fixture.documents)) {
    const result = await call('documents', 'exportPdf', { kind, id })
    assert.equal(result.ok, true)
    assert.ok(result.data.path.startsWith(join(dir, 'documents')))
    const bytes = readFileSync(result.data.path)
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
    evidence.outputs.push({ kind, operation: 'exportPdf', bytes: bytes.length, signature: '%PDF-', success: true })
  }
  // Native dialogs are not automated on configured printers. On a printer-free
  // host, exercise the real print entry and final-invoice PDF fallback safely.
  if (printers.length === 0) {
    for (const [kind, id] of Object.entries(fixture.documents)) {
      const result = await call('documents', 'print', { kind, id })
      if (kind === 'final_invoice') {
        assert.equal(result.ok, true)
        assert.equal(result.data.method, 'pdf')
        assert.equal(readFileSync(result.data.path).subarray(0, 5).toString(), '%PDF-')
      } else { assert.equal(result.ok, false); assert.equal(result.error.code, 'INTERNAL_ERROR') }
      evidence.outputs.push({ kind, operation: 'print', result, limitation: kind === 'final_invoice' ? 'Real PDF fallback; external viewer intercepted' : 'No OS printer; native output failure after successful authorization' })
    }
  } else evidence.outputs.push({ operation: 'print', limitation: 'Native print dialog not automated on configured printers' })
  assert.equal(hash(snapshot()), beforeOutputs)
  await app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0]
    global.sec01Admin = new BrowserWindow({ show: false, webPreferences: { preload: process.env.SEC01_ROOT + '/out/preload/index.cjs', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } })
    await global.sec01Admin.loadURL(main.webContents.getURL())
  })
  const adminPage = app.windows().find((candidate) => candidate !== page)
  assert.ok(adminPage)
  await login('owner', adminPage)
  for (const username of ['revoked', 'disabled', 'reassigned']) {
    await login(username)
    assert.equal((await call('documents', 'preview', { kind: 'final_invoice', id: fixture.documents.final_invoice })).ok, true)
    const action = username === 'revoked'
      ? ['updateRole', { id: fixture.actors[username].roleId, permissions: [] }]
      : ['updateUser', { id: fixture.actors[username].userId, ...(username === 'disabled' ? { active: false } : { roleId: fixture.actors.restricted.roleId }) }]
    assert.equal((await call('admin', action[0], action[1], adminPage)).ok, true)
    for (const method of ['preview', 'print', 'exportPdf']) await denied('documents', method, { kind: 'final_invoice', id: fixture.documents.final_invoice }, 'UNAUTHENTICATED')
    if (username !== 'disabled') {
      await login(username)
      for (const method of ['preview', 'print', 'exportPdf']) await denied('documents', method, { kind: 'final_invoice', id: fixture.documents.final_invoice })
    } else assert.equal((await call('auth', 'login', { username, password: 'secret123' })).ok, false)
  }
  const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
  evidence.health = { migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check') }
  db.close()
  assert.deepEqual(evidence.health.integrity, [{ integrity_check: 'ok' }])
  assert.deepEqual(evidence.health.foreignKeys, [])
  evidence.calls = await app.evaluate(() => global.sec01Calls)
  evidence.status = 'PASS'
} catch (error) { evidence.error = { message: error.message, stack: error.stack }; throw error }
finally {
  writeFileSync(process.env.SEC01_EVIDENCE || '/tmp/sec01-electron.json', JSON.stringify(evidence, null, 2))
  if (app) await app.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, outputs: evidence.outputs, health: evidence.health, error: evidence.error }, null, 2))
}
