// After npm run build: node tests/electron/sec02-avatar-containment.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, mkdirSync, symlinkSync, unlinkSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { _electron, expect } from '@playwright/test'
import Database from 'better-sqlite3'
const root = process.cwd(), dir = mkdtempSync('/tmp/sec02-electron-')
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const data = (bytes = PNG) => `data:image/png;base64,${bytes.toString('base64')}`
const canary = join(dir, 'external.png'), CANARY = Buffer.from('SEC02 harmless external canary')
let app
const evidence = { checks: [], status: 'INCOMPLETE' }
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
try {
  execFileSync('npx', ['vite-node', '--config', 'vitest.config.ts', 'tests/electron/sec02-seed.ts'], { env: { ...process.env, SEC02_DIR: dir }, stdio: 'pipe' })
  const fixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  writeFileSync(canary, CANARY)
  const entry = join(dir, 'entry.cjs')
  writeFileSync(entry, `const {app,ipcMain}=require('electron');global.sec02Calls=[];const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,async(event,...args)=>{const result=await fn(event,...args);global.sec02Calls.push({channel,ok:result.ok,error:result.error?.code});return result});app.setPath('userData',process.env.SEC02_DIR);app.setPath('sessionData',process.env.SEC02_DIR);app.getAppPath=()=>process.env.SEC02_ROOT;import(require('node:url').pathToFileURL(process.env.SEC02_ROOT+'/out/main/index.js').href);`)
  app = await _electron.launch({ args: [entry], env: { ...process.env, SEC02_DIR: dir, SEC02_ROOT: root }, timeout: 60000 })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.setDefaultTimeout(15000)
  const call = (group, method, args) => page.evaluate(({ group, method, args }) => window.erp[group][method](args), { group, method, args })
  const query = (fn) => { const db = new Database(join(dir, 'data/erp.db')); try { return fn(db) } finally { db.close() } }
  const snapshot = () => query((db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()])))
  const businessState = () => Object.fromEntries(Object.entries(snapshot()).filter(([name]) => !['users', 'audit_log', 'sqlite_sequence', 'remember_tokens'].includes(name)))
  const initialBusiness = hash(businessState())
  const ref = () => query((db) => db.prepare('SELECT avatar_file_name AS name FROM users WHERE id=?').get(fixture.userId).name)
  const audits = () => query((db) => db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'profile.photo.%'").get().n)
  const metadata = (name) => query((db) => db.prepare('UPDATE users SET avatar_file_name=? WHERE id=?').run(name, fixture.userId))
  const intact = () => assert.deepEqual(readFileSync(canary), CANARY)
  const avatars = join(dir, 'files/avatars')
  async function login(username) {
    const result = await call('auth', 'login', { username, password: 'secret123', rememberMe: false })
    assert.equal(result.ok, true)
    return result.data.session
  }
  async function safeRead(label) {
    const before = hash(snapshot())
    assert.deepEqual(await call('profile', 'getMyPhoto'), { ok: true, data: { dataUrl: null } })
    assert.equal(hash(snapshot()), before)
    intact()
    evidence.checks.push({ label, noExternalRead: true, sqliteAuditUnchanged: true })
  }
  async function denied(group, method, args, code) {
    const before = hash(snapshot())
    const result = await call(group, method, args)
    assert.equal(result.ok, false); assert.equal(result.error.code, code)
    assert.equal(hash(snapshot()), before); intact()
    evidence.checks.push({ group, method, code, sqliteAuditUnchanged: true })
  }
  async function upload(bytes = PNG) {
    const before = audits()
    assert.equal((await call('profile', 'setPhoto', { dataUrl: data(bytes), userId: fixture.ownerId, isAdmin: true })).ok, true)
    const ext = bytes === JPG ? 'jpg' : 'png'
    assert.equal(ref(), `${fixture.userId}.${ext}`)
    assert.deepEqual(readFileSync(join(avatars, ref())), bytes)
    assert.equal(audits(), before + 1)
    assert.equal(query((db) => db.prepare('SELECT avatar_file_name AS name FROM users WHERE id=?').get(fixture.ownerId).name), null)
    intact()
    evidence.checks.push({ operation: 'upload', ext, ownIdentityOnly: true, auditDelta: 1 })
  }
  async function remove() {
    const before = audits(), name = ref()
    assert.equal((await call('profile', 'removePhoto', { userId: fixture.ownerId })).ok, true)
    assert.equal(ref(), null); assert.equal(audits(), before + (name ? 1 : 0)); intact()
    evidence.checks.push({ operation: 'remove', unsafeOrSafeReference: name, externalUnchanged: true, auditDelta: name ? 1 : 0 })
  }
  evidence.environment = await app.evaluate(({ app, BrowserWindow }) => ({ isPackaged: app.isPackaged, version: process.versions.electron, userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), url: BrowserWindow.getAllWindows()[0].webContents.getURL(), preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences() }))
  assert.equal(evidence.environment.userData, dir)
  assert.equal(evidence.environment.sessionData, dir)
  for (const method of ['getMyPhoto', 'setPhoto', 'removePhoto']) await denied('profile', method, { dataUrl: data() }, 'UNAUTHENTICATED')
  await page.locator('input:not([type=password]):not([type=checkbox])').fill('restricted')
  await page.locator('input[type=password]').fill('secret123')
  await page.getByRole('button', { name: 'دخول', exact: true }).click()
  await expect(page.locator('input[type=password]')).toHaveCount(0)
  assert.equal(ref(), '../../external.png')
  await denied('finalInvoices', 'get', { id: fixture.documents.final_invoice }, 'FORBIDDEN')
  await denied('orders', 'get', { id: fixture.orderId }, 'FORBIDDEN')
  await denied('documents', 'preview', { kind: 'final_invoice', id: fixture.documents.final_invoice }, 'FORBIDDEN')
  await safeRead('pre-existing unsafe SQLite reference')
  await denied('backup', 'restore', { backupFilePath: join(dir, 'missing.aurabak') }, 'FORBIDDEN')
  await denied('backup', 'validate', { path: join(dir, 'missing.aurabak') }, 'FORBIDDEN')
  await remove()
  await upload()
  assert.deepEqual(await call('profile', 'getMyPhoto'), { ok: true, data: { dataUrl: data() } })
  await upload(JPG)
  assert.deepEqual(readdirSync(avatars), [`${fixture.userId}.jpg`])
  assert.deepEqual(await call('profile', 'getMyPhoto'), { ok: true, data: { dataUrl: `data:image/jpeg;base64,${JPG.toString('base64')}` } })
  await upload(JPG); await remove(); await remove()
  assert.deepEqual(readdirSync(avatars), [])
  metadata('../../external.png')
  await login('owner')
  assert.equal((await call('documents', 'preview', { kind: 'final_invoice', id: fixture.documents.final_invoice })).ok, true)
  evidence.checks.push({ operation: 'SEC-01 preservation', restrictedDocumentDenied: true, ownerDocumentAllowed: true })
  const archive = await call('backup', 'create', { destinationFilePath: join(dir, 'unsafe-reference.aurabak') })
  assert.equal(archive.ok, true)
  assert.equal((await call('backup', 'validate', { path: archive.data.path })).data.valid, true)
  assert.equal((await call('backup', 'restore', { backupFilePath: archive.data.path })).ok, true)
  await denied('profile', 'getMyPhoto', undefined, 'UNAUTHENTICATED')
  await login('restricted'); assert.equal(ref(), '../../external.png')
  await safeRead('unsafe metadata after real authorized backup restore')
  await upload()
  assert.deepEqual(await call('profile', 'getMyPhoto'), { ok: true, data: { dataUrl: data() } })
  await login('owner')
  const valid = await call('backup', 'create', { destinationFilePath: join(dir, 'valid-reference.aurabak') })
  assert.equal(valid.ok, true)
  assert.equal((await call('backup', 'validate', { path: valid.data.path })).data.valid, true)
  assert.equal((await call('backup', 'restore', { backupFilePath: valid.data.path })).ok, true)
  await login('restricted')
  assert.deepEqual(await call('profile', 'getMyPhoto'), { ok: true, data: { dataUrl: data() } })
  evidence.checks.push({ operation: 'valid and unsafe backups', actualCreateValidateRestore: true, safeReadAfterRestore: true, existingImagePreserved: true })
  // Only owned disposable fixtures are manipulated. These are post-fix controls.
  unlinkSync(join(avatars, `${fixture.userId}.png`))
  symlinkSync(canary, join(avatars, `${fixture.userId}.png`))
  await safeRead('symlinked target')
  await denied('profile', 'setPhoto', { dataUrl: data() }, 'VALIDATION_ERROR')
  await remove(); unlinkSync(join(avatars, `${fixture.userId}.png`))
  for (const component of ['avatars', 'files']) {
    const original = component === 'avatars' ? avatars : join(dir, 'files')
    const moved = join(dir, `saved-${component}`), outside = join(dir, `outside-${component}`)
    renameSync(original, moved); mkdirSync(outside)
    if (component === 'files') mkdirSync(join(outside, 'avatars'))
    const target = component === 'files' ? join(outside, 'avatars') : outside
    writeFileSync(join(target, `${fixture.userId}.png`), CANARY)
    symlinkSync(outside, original, 'dir'); metadata(`${fixture.userId}.png`)
    await safeRead(`symlinked ${component}`)
    await denied('profile', 'setPhoto', { dataUrl: data(JPG) }, 'VALIDATION_ERROR')
    await remove()
    assert.deepEqual(readFileSync(join(target, `${fixture.userId}.png`)), CANARY)
    assert.deepEqual(readdirSync(target), [`${fixture.userId}.png`])
    unlinkSync(original); renameSync(moved, original)
  }
  await upload(); await remove()
  const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
  evidence.health = { migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check') }
  db.close()
  assert.deepEqual(evidence.health.integrity, [{ integrity_check: 'ok' }]); assert.deepEqual(evidence.health.foreignKeys, [])
  assert.equal(hash(businessState()), initialBusiness)
  evidence.businessTablesUnchanged = true
  evidence.calls = await app.evaluate(() => global.sec02Calls)
  intact()
  evidence.status = 'PASS'
} catch (error) { evidence.error = { message: error.message, stack: error.stack }; throw error }
finally {
  writeFileSync(process.env.SEC02_EVIDENCE || '/tmp/sec02-electron.json', JSON.stringify(evidence, null, 2))
  if (app) await app.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, health: evidence.health, error: evidence.error }, null, 2))
}
