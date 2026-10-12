// After npm run build: node tests/electron/sec04-login-audit.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { _electron, expect } from '@playwright/test'
import Database from 'better-sqlite3'
const root = process.cwd(), dir = mkdtempSync('/tmp/sec04-electron-')
let app
const evidence = { status: 'INCOMPLETE', checks: [] }
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
try {
  execFileSync('npx', ['vite-node', '--config', 'vitest.config.ts', 'tests/electron/sec04-seed.ts'], { env: { ...process.env, SEC04_DIR: dir }, stdio: 'pipe' })
  const fixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')), dbPath = join(dir, 'data/erp.db')
  const database = (fn) => { const db = new Database(dbPath); try { return fn(db) } finally { db.close() } }
  const snapshot = () => database((db) => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()])))
  const audits = (action) => database((db) => db.prepare('SELECT * FROM audit_log WHERE action=? ORDER BY id').all(action))
  const tokenRows = () => database((db) => db.prepare('SELECT * FROM remember_tokens ORDER BY id').all())
  const fault = (action) => database((db) => {
    assert.ok(['auth.login', 'auth.resume'].includes(action))
    db.exec("DROP TRIGGER IF EXISTS sec04_fault")
    db.exec(`CREATE TRIGGER sec04_fault BEFORE INSERT ON audit_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'SEC04 disposable audit fault'); END`)
  })
  const recover = () => database((db) => db.exec('DROP TRIGGER sec04_fault'))
  const entry = join(dir, 'entry.cjs')
  // Observe only result/actor; never log password payloads or replace auth/session owners.
  writeFileSync(entry, `const {app,ipcMain}=require('electron');global.sec04Calls=[];const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,async(event,request)=>{const result=await fn(event,request);global.sec04Calls.push({channel,sender:event.sender.id,ok:result.ok,code:result.error?.code,actor:result.data?.session?.user?.id});return result});app.setPath('userData',process.env.SEC04_DIR);app.setPath('sessionData',process.env.SEC04_DIR);app.getAppPath=()=>process.env.SEC04_ROOT;import(require('node:url').pathToFileURL(process.env.SEC04_ROOT+'/out/main/index.js').href);`)
  app = await _electron.launch({ args: [entry], env: { ...process.env, SEC04_ROOT: root, SEC04_DIR: dir }, timeout: 60000 })
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); page.setDefaultTimeout(15000)
  const call = (group, method, args = {}, target = page) => target.evaluate(({ group, method, args }) => window.erp[group][method](args), { group, method, args })
  const login = (username = 'owner', rememberMe = false, target = page, password = 'secret123') => call('auth', 'login', { username, password, rememberMe }, target)
  async function denied(target = page) {
    for (const [group, method, args] of [['cash', 'accounts', {}], ['documents', 'preview', { kind: 'final_invoice', id: fixture.documents.final_invoice }]]) {
      const result = await call(group, method, args, target)
      assert.deepEqual(result, { ok: false, error: { code: 'UNAUTHENTICATED', message: 'يجب تسجيل الدخول' } })
    }
  }
  const environment = await app.evaluate(({ app, BrowserWindow, safeStorage }) => ({ version: process.versions.electron, platform: process.platform, packaged: app.isPackaged, userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), url: BrowserWindow.getAllWindows()[0].webContents.getURL(), preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(), encryptionAvailable: safeStorage.isEncryptionAvailable() }))
  evidence.environment = environment
  assert.equal(environment.userData, dir); assert.equal(environment.sessionData, dir)
  const beforeFailure = digest(snapshot()), beforeLoginAudits = audits('auth.login').length
  // Actual UI submission with fictional valid credentials; observe real response.
  await page.locator('input:not([type=password]):not([type=checkbox])').fill('owner')
  await page.locator('input[type=password]').fill('secret123')
  await page.getByRole('button', { name: 'دخول', exact: true }).click()
  await expect(page.getByText('حدث خطأ غير متوقع', { exact: true })).toBeVisible()
  const failedCall = await app.evaluate(() => global.sec04Calls.filter((c) => c.channel === 'auth:login').at(-1))
  assert.equal(failedCall.ok, false); assert.equal(failedCall.code, 'INTERNAL_ERROR')
  await denied(); assert.equal(digest(snapshot()), beforeFailure)
  evidence.checks.push({ operation: 'real UI required-login-audit failure', error: failedCall.code, cashDenied: true, documentDenied: true, sqliteAuditUnchanged: true })
  assert.deepEqual(await call('auth', 'tryResume'), { ok: true, data: null })
  assert.equal(tokenRows().length, 0); assert.equal(existsSync(join(dir, 'config/remember-token.enc')), false)
  const failedRemember = await login('owner', true)
  assert.equal(failedRemember.ok, false); assert.equal(failedRemember.error.code, 'INTERNAL_ERROR'); await denied()
  assert.equal(digest(snapshot()), beforeFailure); assert.equal(tokenRows().length, 0)
  assert.equal(existsSync(join(dir, 'config/remember-token.enc')), false)
  evidence.checks.push({ operation: 'audit failure with remember-me', noTokenRow: true, noEncryptedFile: true, noSession: true })
  // A second real window uses the unchanged compiled preload and default session.
  const nextWindow = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, { url, preload }) => {
    const win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } })
    void win.loadURL(url)
  }, { url: environment.url, preload: join(root, 'out/preload/index.cjs') })
  const other = await nextWindow; await other.waitForLoadState('domcontentloaded')
  await expect(other.locator('input[type=password]')).toHaveCount(1)
  await denied(other)
  evidence.checks.push({ operation: 'cross-WebContents failure isolation', otherWindowDenied: true })
  recover()
  // Real UI recovers and applies its session state normally.
  await page.getByRole('button', { name: 'دخول', exact: true }).click()
  await expect(page.locator('input[type=password]')).toHaveCount(0)
  assert.equal(audits('auth.login').length, beforeLoginAudits + 1)
  assert.equal((await call('cash', 'accounts')).ok, true)
  assert.equal((await call('documents', 'preview', { kind: 'final_invoice', id: fixture.documents.final_invoice })).ok, true)
  await denied(other)
  evidence.checks.push({ operation: 'UI recovery', loginAuditExactlyOnce: true, correctCashDocumentAuthority: true, otherWindowStillDenied: true })
  // Required audit failure cannot replace a previously legitimate session.
  fault('auth.login'); const beforeSwitch = digest(snapshot())
  const failedSwitch = await login('viewer')
  assert.equal(failedSwitch.ok, false); assert.equal(failedSwitch.error.code, 'INTERNAL_ERROR')
  assert.equal((await call('cash', 'accounts')).ok, true)
  assert.equal((await call('documents', 'preview', { kind: 'final_invoice', id: fixture.documents.final_invoice })).ok, true)
  assert.equal((await call('admin', 'users')).ok, true)
  assert.equal(digest(snapshot()), beforeSwitch)
  evidence.checks.push({ operation: 'failed account switch', oldOwnerAuthorityPreserved: true, attemptedIdentityNotPublished: true, sqliteAuditUnchanged: true })
  recover()
  assert.equal((await call('auth', 'logout')).ok, true); await denied()
  evidence.checks.push({ operation: 'logout after failed switch', sessionRemoved: true })
  // Native OS encryption is NOT mocked; disclose inability if unavailable.
  assert.equal(environment.encryptionAvailable, true, 'Real OS safeStorage required for remember runtime gate')
  const remembered = await login('owner', true)
  assert.equal(remembered.ok, true); assert.equal(tokenRows().length, 1)
  assert.equal(existsSync(join(dir, 'config/remember-token.enc')), true)
  const rawNotExposed = await app.evaluate(({ safeStorage }, { encrypted, response }) => {
    const raw = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    return !JSON.stringify(response).includes(raw)
  }, { encrypted: readFileSync(join(dir, 'config/remember-token.enc')).toString('base64'), response: remembered })
  assert.equal(rawNotExposed, true)
  evidence.checks.push({ operation: 'native remember-me password login', nativeEncryptionAvailable: true, oneHashedToken: true, rawNotReturned: true })
  fault('auth.resume'); const beforeResume = digest(snapshot()), encryptedBefore = readFileSync(join(dir, 'config/remember-token.enc'))
  const resumeFailure = await call('auth', 'tryResume', {}, other)
  assert.equal(resumeFailure.ok, false); assert.equal(resumeFailure.error.code, 'INTERNAL_ERROR'); await denied(other)
  assert.equal(digest(snapshot()), beforeResume); assert.deepEqual(readFileSync(join(dir, 'config/remember-token.enc')), encryptedBefore)
  assert.equal((await call('cash', 'accounts')).ok, true)
  evidence.checks.push({ operation: 'required resume-audit failure', noOtherSession: true, tokenSlidingRolledBack: true, encryptedFileUnchanged: true, existingOwnerUnaffected: true })
  recover(); const nResume = audits('auth.resume').length
  const resumed = await call('auth', 'tryResume', {}, other)
  assert.equal(resumed.ok, true); assert.equal(resumed.data.session.user.username, 'owner')
  assert.equal(audits('auth.resume').length, nResume + 1)
  assert.equal((await call('cash', 'accounts', {}, other)).ok, true)
  const resumeAudit = audits('auth.resume').at(-1)
  assert.equal(resumeAudit.entity_id, resumed.data.session.sessionId); assert.equal(resumeAudit.user_id, resumed.data.session.user.id)
  evidence.checks.push({ operation: 'native token resume recovery', requiredResumeAuditExactlyOnce: true, matchingActorSession: true })
  // Actual registered role/user owners still revoke all affected live sessions.
  assert.equal((await login('viewer', true, other)).ok, true)
  assert.equal((await call('documents', 'preview', { kind: 'final_invoice', id: fixture.documents.final_invoice }, other)).ok, true)
  assert.equal((await call('admin', 'updateRole', { id: fixture.roleId, permissions: [] })).ok, true)
  await denied(other)
  const restrictedResume = await call('auth', 'tryResume', {}, other)
  assert.equal(restrictedResume.ok, true); assert.deepEqual(restrictedResume.data.session.permissions, [])
  for (const [group, method, args] of [['cash', 'accounts', {}], ['documents', 'preview', { kind: 'final_invoice', id: fixture.documents.final_invoice }]]) {
    const result = await call(group, method, args, other); assert.equal(result.ok, false); assert.equal(result.error.code, 'FORBIDDEN')
  }
  evidence.checks.push({ operation: 'role permission revocation', oldSessionInvalidated: true, freshResumeUsesCurrentPermissions: true, cashDocumentForbidden: true })
  assert.equal((await call('admin', 'updateUser', { id: fixture.userId, active: false })).ok, true)
  await denied(other); assert.deepEqual(await call('auth', 'tryResume', {}, other), { ok: true, data: null })
  assert.equal(tokenRows().filter((r) => r.user_id === fixture.userId).length, 0)
  evidence.checks.push({ operation: 'user deactivation', sessionAndTokensRevoked: true })
  assert.equal((await call('auth', 'logout')).ok, true); await denied()
  assert.deepEqual(await call('auth', 'tryResume'), { ok: true, data: null })
  evidence.checks.push({ operation: 'final logout', noRememberedOwnerReturn: true })
  evidence.calls = await app.evaluate(() => global.sec04Calls)
  evidence.health = database((db) => ({ migrations: db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get(), sqlite: db.prepare('SELECT sqlite_version() AS version').get(), integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check') }))
  assert.deepEqual(evidence.health.integrity, [{ integrity_check: 'ok' }]); assert.deepEqual(evidence.health.foreignKeys, [])
  evidence.status = 'PASS'
} catch (error) {
  if (app) evidence.calls = await app.evaluate(() => global.sec04Calls).catch(() => [])
  evidence.error = { message: error.message, stack: error.stack }; throw error
} finally {
  writeFileSync('/tmp/sec04-electron.json', JSON.stringify(evidence, null, 2))
  if (app) await app.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length, calls: evidence.calls?.length, health: evidence.health, error: evidence.error }, null, 2))
}
