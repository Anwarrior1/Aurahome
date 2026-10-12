// After npm run build: node tests/electron/sec03-asset-protocol.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync, mkdirSync, symlinkSync, unlinkSync, rmdirSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { _electron, expect } from '@playwright/test'
import Database from 'better-sqlite3'
const root = process.cwd(), dir = mkdtempSync('/tmp/sec03-electron-')
let app
const evidence = { checks: [], status: 'INCOMPLETE' }
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const imageUrl = 'app://assets/brand/logo-full.jpeg', qrUrl = 'app://assets/references/qr.jpeg'
const fontUrls = ['app://assets/fonts/fonts.css', 'app://assets/fonts/Cairo-Regular.ttf', 'app://assets/fonts/Cairo-SemiBold.ttf']
try {
  execFileSync('npx', ['vite-node', '--config', 'vitest.config.ts', 'tests/electron/sec03-seed.ts'], { env: { ...process.env, SEC03_DIR: dir }, stdio: 'pipe' })
  const fixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  const jpeg = readFileSync(join(fixture.assets, 'brand/logo-full.jpeg'))
  const png = readFileSync(fixture.canary), avatarCanary = readFileSync(join(dir, 'external.png'))
  const intact = () => { assert.deepEqual(readFileSync(fixture.canary), png); assert.deepEqual(readFileSync(join(dir, 'external.png')), avatarCanary) }
  const snapshot = () => {
    const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
    try { return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()])) } finally { db.close() }
  }
  const entry = join(dir, 'entry.cjs')
  // Observe real protocol responses and real print-window layout; do not replace handlers.
  writeFileSync(entry, `const {app,protocol}=require('electron');global.sec03Protocol=[];global.sec03Schemes=[];global.sec03Prints=[];global.sec03Console=[];const schemes=protocol.registerSchemesAsPrivileged.bind(protocol);protocol.registerSchemesAsPrivileged=(s)=>{global.sec03Schemes.push(s);return schemes(s)};const handle=protocol.handle.bind(protocol);protocol.handle=(scheme,fn)=>handle(scheme,async(request)=>{const response=await fn(request);global.sec03Protocol.push({scheme,url:request.url,status:response.status,mime:response.headers.get('content-type')});return response});app.on('browser-window-created',(_event,win)=>{win.webContents.on('console-message',(_event,_level,message)=>global.sec03Console.push(message));win.webContents.on('did-finish-load',()=>{if(win.webContents.getURL().startsWith('data:text/html'))void win.webContents.executeJavaScript('(async()=>{await document.fonts.ready;return {fontFaces:Array.from(document.fonts).map(f=>({family:f.family,status:f.status})),fontsLoaded:document.fonts.check(\"14px Cairo\"),images:Array.from(document.images).map(i=>({src:i.src,width:i.naturalWidth,height:i.naturalHeight}))}})()').then(layout=>global.sec03Prints.push(layout)).catch(error=>global.sec03Prints.push({error:String(error)}))})});app.setPath('userData',process.env.SEC03_DIR);app.setPath('sessionData',process.env.SEC03_DIR);app.getAppPath=()=>process.env.SEC03_APP;import(require('node:url').pathToFileURL(process.env.SEC03_ROOT+'/out/main/index.js').href);`)
  app = await _electron.launch({ args: [entry], env: { ...process.env, SEC03_DIR: dir, SEC03_APP: fixture.appRoot, SEC03_ROOT: root }, timeout: 60000 })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded'); page.setDefaultTimeout(15000)
  const call = (group, method, args) => page.evaluate(({ group, method, args }) => window.erp[group][method](args), { group, method, args })
  const mainFetch = (url) => app.evaluate(async ({ net }, url) => {
    try { const response = await net.fetch(url); return { status: response.status, mime: response.headers.get('content-type'), nosniff: response.headers.get('x-content-type-options'), cache: response.headers.get('cache-control'), bytes: Buffer.from(await response.arrayBuffer()).toString('base64') } }
    catch (error) { return { rejected: true, error: String(error) } }
  }, url)
  const imageLoad = (url) => page.evaluate((url) => new Promise((resolve) => {
    const image = document.createElement('img'); image.alt = 'SEC03 fictional protocol fixture'
    const timer = setTimeout(() => { image.remove(); resolve({ loaded: false, timeout: true }) }, 5000)
    image.onload = () => { clearTimeout(timer); const result = { loaded: true, width: image.naturalWidth, height: image.naturalHeight }; image.remove(); resolve(result) }
    image.onerror = () => { clearTimeout(timer); image.remove(); resolve({ loaded: false }) }
    document.body.appendChild(image); image.src = url
  }), url)
  async function denied(url, renderer = false) {
    const before = hash(snapshot()), result = await mainFetch(url)
    assert.ok(result.rejected || result.status === 404, JSON.stringify({ url, result }))
    if (result.bytes) assert.equal(Buffer.from(result.bytes, 'base64').toString(), 'Not found')
    if (renderer) {
      // Mutable fixture bytes at a previously decoded URL require a fresh request.
      // Clear only this disposable session; never alter the real handler or policy.
      await app.evaluate(async ({ BrowserWindow }) => { await BrowserWindow.getAllWindows()[0].webContents.session.clearCache() })
      await page.reload(); await page.waitForLoadState('domcontentloaded')
      const callsBefore = await app.evaluate(() => global.sec03Protocol.length)
      assert.equal((await imageLoad(url)).loaded, false)
      const fresh = await app.evaluate((n) => global.sec03Protocol.slice(n), callsBefore)
      assert.ok(fresh.some((call) => call.status === 404), JSON.stringify(fresh))
    }
    assert.equal(hash(snapshot()), before); intact()
    evidence.checks.push({ url, denial: result, rendererImageDenied: renderer, sqliteAuditUnchanged: true, externalUnchanged: true })
  }
  evidence.environment = await app.evaluate(({ app, BrowserWindow }) => ({ version: process.versions.electron, isPackaged: app.isPackaged, platform: process.platform, userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), appPath: app.getAppPath(), url: BrowserWindow.getAllWindows()[0].webContents.getURL(), preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences() }))
  assert.equal(evidence.environment.userData, dir); assert.equal(evidence.environment.sessionData, dir); assert.equal(evidence.environment.appPath, fixture.appRoot)
  // Protocol resources are public bundled assets, deliberately available before ERP login.
  const beforePublic = hash(snapshot())
  for (const url of [imageUrl, qrUrl]) {
    const result = await mainFetch(url)
    assert.equal(result.status, 200); assert.equal(result.mime, 'image/jpeg'); assert.equal(result.nosniff, 'nosniff'); assert.equal(result.cache, 'no-store')
    assert.deepEqual(Buffer.from(result.bytes, 'base64'), jpeg)
    assert.deepEqual(await imageLoad(url), { loaded: true, width: 2, height: 2 })
    evidence.checks.push({ url, publicBundledImage: true, rendererLoaded: true, dimensions: [2, 2] })
  }
  for (const url of fontUrls) {
    const result = await mainFetch(url)
    assert.equal(result.status, 200)
    assert.equal(result.mime, url.endsWith('.css') ? 'text/css; charset=utf-8' : 'font/ttf')
    evidence.checks.push({ url, existingFontResource: true, mime: result.mime })
  }
  assert.equal(hash(snapshot()), beforePublic)
  const originalAuditUrl = 'app://assets/..%2F..%2F..%2F..%2F..%2F..%2F..%2F..%2Ftmp%2Fsecurity-electron-vB8iJL%2Fprotocol-canary.png'
  const existingCanaryUrl = 'app://assets/' + '..%2F'.repeat(12) + fixture.canary.replace(/^\//, '').replaceAll('/', '%2F')
  await denied(originalAuditUrl, true); await denied(existingCanaryUrl, true)
  for (const url of [
    'app://assets/../../external.png', 'app://assets/..%5C..%5Cexternal.png',
    'app://assets/%2e%2e%2fexternal.png', 'app://assets/%252e%252e%252fexternal.png',
    'app://assets/C:%5Cexternal.png', 'app://assets//server/share/external.png',
    'app://assets/brand%2Flogo-full.jpeg', 'app://other/brand/logo-full.jpeg',
    'app://assets-extra/brand/logo-full.jpeg', 'app://user:password@assets/brand/logo-full.jpeg',
    imageUrl + '?path=../../external.png',
    'app://assets/', 'app://assets/%00.jpeg', 'app://assets/%GG.jpeg',
    'app://assets/ｂrand/logo-full.jpeg', 'app://assets/page.html', 'app://assets/fonts/other.css'
  ]) await denied(url)
  // Electron may canonicalize URL components before dispatch; record rather than assume.
  // Record observed normalization: it may select only a fixed already-approved asset.
  evidence.normalization = []
  for (const url of ['app://assets:123/brand/logo-full.jpeg', imageUrl + '#fragment', 'app://assets/brand/../brand/logo-full.jpeg', 'APP://ASSETS/brand/logo-full.jpeg']) {
    const result = await mainFetch(url)
    assert.ok(result.rejected || result.status === 404 || (result.status === 200 && Buffer.from(result.bytes, 'base64').equals(jpeg)))
    evidence.normalization.push({ url, status: result.status, rejected: result.rejected || false })
    intact()
  }
  const logo = join(fixture.assets, 'brand/logo-full.jpeg')
  for (const bytes of [Buffer.from('<svg onload="fictional()"/>'), Buffer.from('SQLite format 3\0'), Buffer.from([0xff, 0xd8, 0xff])]) {
    writeFileSync(logo, bytes); await denied(imageUrl, true)
  }
  writeFileSync(logo, jpeg)
  unlinkSync(logo); symlinkSync(fixture.canary, logo)
  await denied(imageUrl, true); unlinkSync(logo); writeFileSync(logo, jpeg)
  for (const component of ['brand', 'assets', 'resources', 'references']) {
    const path = component === 'brand' ? join(fixture.assets, 'brand') : component === 'assets' ? fixture.assets : component === 'resources' ? join(fixture.appRoot, 'resources') : fixture.references
    const moved = join(fixture.appRoot, `saved-${component}`), outside = join(fixture.appRoot, `outside-${component}`)
    renameSync(path, moved); mkdirSync(outside)
    symlinkSync(outside, path, 'dir')
    await denied(component === 'references' ? qrUrl : imageUrl, true)
    unlinkSync(path); renameSync(moved, path)
  }
  unlinkSync(logo); mkdirSync(logo); await denied(imageUrl, true); rmdirSync(logo); writeFileSync(logo, jpeg)
  unlinkSync(logo); await denied(imageUrl, true); writeFileSync(logo, jpeg)
  // Real authentication and unchanged SEC-01/02 owners in the compiled application.
  await page.locator('input:not([type=password]):not([type=checkbox])').fill('restricted')
  await page.locator('input[type=password]').fill('secret123')
  await page.getByRole('button', { name: 'دخول', exact: true }).click()
  await expect(page.locator('input[type=password]')).toHaveCount(0)
  const beforeRestricted = hash(snapshot())
  assert.deepEqual(await call('profile', 'getMyPhoto'), { ok: true, data: { dataUrl: null } })
  for (const [group, method, args] of [['documents', 'preview', { kind: 'final_invoice', id: fixture.documents.final_invoice }], ['finalInvoices', 'get', { id: fixture.documents.final_invoice }], ['backup', 'restore', { backupFilePath: join(dir, 'missing.aurabak') }]]) {
    const result = await call(group, method, args); assert.equal(result.ok, false); assert.equal(result.error.code, 'FORBIDDEN')
  }
  assert.equal(hash(snapshot()), beforeRestricted); intact()
  assert.equal((await call('profile', 'setPhoto', { dataUrl: 'data:image/png;base64,' + png.toString('base64') })).ok, true)
  assert.deepEqual(await call('profile', 'getMyPhoto'), { ok: true, data: { dataUrl: 'data:image/png;base64,' + png.toString('base64') } })
  assert.equal((await call('profile', 'removePhoto')).ok, true); intact()
  evidence.checks.push({ operation: 'SEC-01/02 preservation', restrictedDocumentDenied: true, backupDenied: true, unsafeAvatarInert: true, ownAvatarDataUriWorks: true })
  assert.equal((await call('auth', 'login', { username: 'owner', password: 'secret123', rememberMe: false })).ok, true)
  // Verify unchanged real bundled branding/QR too, without modifying originals.
  copyFileSync(join(root, 'resources/assets/brand/logo-full.jpeg'), logo)
  copyFileSync(join(root, 'references/qr.jpeg'), join(fixture.references, 'qr.jpeg'))
  for (const url of [imageUrl, qrUrl]) {
    const result = await mainFetch(url); assert.equal(result.status, 200)
    const loaded = await imageLoad(url); assert.equal(loaded.loaded, true); assert.ok(loaded.width > 0 && loaded.height > 0)
    evidence.checks.push({ url, actualBundledResourceLoaded: true, dimensions: [loaded.width, loaded.height] })
  }
  const beforeExport = hash(snapshot())
  const preview = await call('documents', 'preview', { kind: 'final_invoice', id: fixture.documents.final_invoice })
  assert.equal(preview.ok, true)
  const pdf = await call('documents', 'exportPdf', { kind: 'final_invoice', id: fixture.documents.final_invoice })
  assert.equal(pdf.ok, true); assert.equal(readFileSync(pdf.data.path).subarray(0, 5).toString(), '%PDF-')
  assert.equal(hash(snapshot()), beforeExport)
  evidence.documentExport = { success: true, bytes: readFileSync(pdf.data.path).length, sqliteAuditUnchanged: true }
  evidence.console = await app.evaluate(() => global.sec03Console)
  evidence.printLayouts = await app.evaluate(() => global.sec03Prints)
  assert.ok(evidence.printLayouts.some((layout) => layout.images.filter((image) => image.src.startsWith('app://')).length === 2 && layout.images.filter((image) => image.src.startsWith('app://')).every((image) => image.width > 0 && image.height > 0)))
  // corsEnabled:false is unchanged. Opaque data: print documents already fail
  // Cairo CORS before handler dispatch; do not disguise or remediate that here.
  evidence.printFontLimitation = { preExistingCorsRestriction: true, loaded: evidence.printLayouts.some((layout) => layout.fontsLoaded), stylesheetServed: true, fontBytesServed: true }
  evidence.normalRendererFonts = await page.evaluate(async () => { await document.fonts.load('14px Cairo'); return document.fonts.check('14px Cairo') })
  assert.equal(evidence.normalRendererFonts, true)
  evidence.protocolCalls = await app.evaluate(() => global.sec03Protocol)
  evidence.schemeRegistrations = await app.evaluate(() => global.sec03Schemes)
  assert.equal(evidence.schemeRegistrations.length, 1)
  assert.deepEqual(evidence.schemeRegistrations[0], [{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }])
  for (const url of [imageUrl, qrUrl, ...fontUrls]) assert.ok(evidence.protocolCalls.some((call) => call.url === url && call.status === 200))
  const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
  evidence.health = { migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check') }; db.close()
  assert.deepEqual(evidence.health.integrity, [{ integrity_check: 'ok' }]); assert.deepEqual(evidence.health.foreignKeys, []); intact()
  evidence.status = 'PASS'
} catch (error) {
  if (app) evidence.protocolCalls = await app.evaluate(() => global.sec03Protocol).catch(() => [])
  evidence.error = { message: error.message, stack: error.stack }; throw error
}
finally {
  writeFileSync(process.env.SEC03_EVIDENCE || '/tmp/sec03-electron.json', JSON.stringify(evidence, null, 2))
  if (app) await app.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, health: evidence.health, normalization: evidence.normalization, printLayouts: evidence.printLayouts, error: evidence.error }, null, 2))
}
