import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { _electron, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
const root = process.cwd()
const dir = mkdtempSync('/tmp/uiwf08-electron-')
const pre = process.env.UIWF08_PRE === '1'
let app
const previousCalls = []
try {
  execFileSync('npx', ['vite-node', '--config', 'vitest.config.ts', 'tests/electron/ui-wf08-seed.ts'], { env: { ...process.env, UIWF08_DIR: dir }, stdio: 'pipe' })
  const fixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  assert.equal(fixture.netProfitMinor, 5000000)
  const wrapper = join(dir, 'entry.cjs')
  writeFileSync(wrapper, `const {app,ipcMain}=require('electron');global.uiwf08Calls=[];const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,async(event,...args)=>{const result=await fn(event,...args);if(channel==='profit:savingsOverview')await new Promise(resolve=>setTimeout(resolve,500));if(channel==='profit:setSavingsRate'||channel==='profit:savingsOverview')global.uiwf08Calls.push({channel,input:args[0],result});return result});app.setPath('userData',process.env.UIWF08_DIR);app.setPath('sessionData',process.env.UIWF08_DIR);app.getAppPath=()=>process.env.UIWF08_ROOT;import(require('node:url').pathToFileURL(process.env.UIWF08_ROOT+'/out/main/index.js').href);`)
  const launch = () => _electron.launch({ args: [wrapper], env: { ...process.env, UIWF08_DIR: dir, UIWF08_ROOT: root }, timeout: 60000 })
  app = await launch()
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dir)
  let page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const snapshot = () => {
    const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
    try { return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()])) } finally { db.close() }
  }
  const financial = (state) => Object.fromEntries(Object.entries(state).filter(([name]) => !['app_settings', 'audit_log', 'sqlite_sequence'].includes(name)))
  const digest = (state) => createHash('sha256').update(JSON.stringify(state)).digest('hex')
  const persisted = () => JSON.parse(snapshot().app_settings.find((row) => row.key === 'savings.rate_bp').value)
  const audits = () => snapshot().audit_log.filter((row) => row.action === 'settings.update' && row.entity_id === 'savings.rate_bp').length
  const rateCalls = () => app.evaluate(() => global.uiwf08Calls.filter((row) => row.channel === 'profit:setSavingsRate'))
  const editButton = () => page.getByRole('button', { name: 'تعديل نسبة الادخار', exact: true })
  const dialog = () => page.getByRole('dialog')
  const select = () => dialog().getByRole('combobox')
  async function login(username) {
    await page.locator('input:not([type=password]):not([type=checkbox])').fill(username)
    await page.locator('input[type=password]').fill('secret123')
    await page.getByRole('button', { name: 'دخول', exact: true }).click()
  }
  async function open() {
    await page.evaluate(() => { window.location.hash = '/savings' })
    await expect(editButton()).toBeVisible()
    if (!pre) await expect(editButton()).toBeDisabled()
    await expect(editButton()).toBeEnabled()
    // The original button has no hydration gate, so wait for the real read too.
    await expect(page.locator('body')).toContainText('100%')
  }
  async function control() {
    return select().evaluate((el) => ({ domValue: el.value, controlledValue: el[Object.keys(el).find((key) => key.startsWith('__reactProps$'))]?.value, label: el.selectedOptions[0]?.textContent.trim(), matchingOptions: Array.from(el.options).filter((option) => option.value === el.value).length }))
  }
  const proofs = []
  async function save(expected) {
    const shown = await control()
    assert.equal(shown.domValue, String(expected))
    assert.equal(shown.controlledValue, String(expected))
    assert.equal(shown.matchingOptions, 1)
    const before = snapshot(), count = (await rateCalls()).length, auditCount = audits()
    await dialog().getByRole('button', { name: 'حفظ', exact: true }).click()
    await expect(dialog()).toHaveCount(0)
    await expect(editButton()).toBeEnabled()
    const calls = await rateCalls()
    assert.equal(calls.length, count + 1)
    assert.deepEqual(calls[count].input, { rateBp: expected })
    assert.equal(calls[count].result.data.savingsRateBp, expected)
    assert.equal(persisted(), expected)
    assert.equal(audits(), auditCount + 1)
    assert.deepEqual(financial(snapshot()), financial(before))
    proofs.push({ shown, submitted: calls[count].input.rateBp, persisted: persisted(), auditDelta: audits() - auditCount, financialTablesUnchanged: true })
  }
  await login('uiwf08-editor')
  const beforeOpen = snapshot()
  await open()
  await editButton().click()
  const original = await control()
  assert.deepEqual(snapshot(), beforeOpen)
  if (pre) {
    assert.equal(persisted(), 10000)
    assert.deepEqual(original, { domValue: '0', controlledValue: '10000', label: '0%', matchingOptions: 1 })
    const n = (await rateCalls()).length, a = audits()
    await dialog().getByRole('button', { name: 'حفظ', exact: true }).click()
    await expect(dialog()).toHaveCount(0)
    const calls = await rateCalls()
    assert.equal(calls.length, n + 1)
    assert.equal(calls[n].input.rateBp, 10000)
    assert.equal(persisted(), 10000)
    assert.equal(audits(), a + 1)
    assert.deepEqual(financial(snapshot()), financial(beforeOpen))
    console.log(JSON.stringify({ status: 'REPRODUCED', persistedBp: persisted(), overview: (await app.evaluate(() => global.uiwf08Calls.filter((row) => row.channel === 'profit:savingsOverview')))[0], control: original, unchangedSave: calls[n], auditDelta: 1, inspectionReadOnly: true, financialTablesUnchanged: true, financialSnapshotBefore: digest(financial(beforeOpen)), financialSnapshotAfter: digest(financial(snapshot())), snapshotTables: Object.keys(beforeOpen).length }, null, 2))
  } else {
    assert.equal(original.label, '100%')
    await save(10000)
    previousCalls.push(...await rateCalls())
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    await login('uiwf08-editor'); await open(); await editButton().click()
    assert.equal((await control()).label, '100%')
    assert.equal(persisted(), 10000)
    await dialog().getByRole('button', { name: 'إلغاء', exact: true }).click()
    for (const [rate, label] of [[0, '0%'], [10000, '100%'], [2500, '25%'], [4000, '40%']]) {
      await editButton().click()
      const before = snapshot()
      await select().selectOption(String(rate))
      assert.equal((await control()).label, label)
      assert.deepEqual(snapshot(), before)
      await save(rate)
      await editButton().click()
      assert.equal((await control()).domValue, String(rate))
      assert.equal((await control()).label, label)
      await dialog().getByRole('button', { name: 'إلغاء', exact: true }).click()
    }
    const beforeCancel = snapshot()
    await editButton().click(); await select().selectOption('0')
    await dialog().getByRole('button', { name: 'إلغاء', exact: true }).click()
    assert.deepEqual(snapshot(), beforeCancel)
    // Legitimate non-preset stored values must be represented exactly too.
    for (const [rate, label] of [[3333, '33,33%'], [1, '0,01%'], [9999, '99,99%']]) {
      const result = await page.evaluate((rateBp) => window.erp.profit.setSavingsRate({ rateBp }), rate)
      assert.equal(result.ok, true)
      await page.reload(); await login('uiwf08-editor')
      await page.evaluate(() => { window.location.hash = '/savings' })
      await expect(editButton()).toBeEnabled()
      await editButton().click()
      assert.equal((await control()).label, label)
      await save(rate)
      if (rate === 3333) {
        await editButton().click()
        const refresh = await page.evaluate(async () => {
          const result = await window.erp.profit.setSavingsRate({ rateBp: 4000 })
          window.dispatchEvent(new Event('profit-withdrawals-changed'))
          return result
        })
        assert.equal(refresh.ok, true)
        await expect(page.locator('body')).toContainText('40%')
        assert.equal((await control()).domValue, '3333')
        assert.equal((await control()).label, '33,33%')
        assert.equal(persisted(), 4000)
        await save(3333)
      }
    }
    await page.reload(); await login('uiwf08-viewer')
    await page.evaluate(() => { window.location.hash = '/savings' })
    await expect(page.locator('body')).toContainText('سجل المخصصات المعتمدة')
    await expect(editButton()).toHaveCount(0)
    const beforeDenied = snapshot()
    const denied = await page.evaluate(() => window.erp.profit.setSavingsRate({ rateBp: 0 }))
    assert.equal(denied.error.code, 'FORBIDDEN')
    assert.deepEqual(snapshot(), beforeDenied)
    await page.reload(); await login('uiwf08-editor')
    const invalid = []
    for (const rate of [null, '', -1, 10001, 1.5]) {
      const before = snapshot()
      const result = await page.evaluate((rateBp) => window.erp.profit.setSavingsRate({ rateBp }), rate)
      assert.equal(result.error.code, 'VALIDATION_ERROR')
      assert.deepEqual(snapshot(), before)
      invalid.push({ value: rate, error: result.error.code })
    }
    const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
    try {
      assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]); assert.deepEqual(db.pragma('foreign_key_check'), [])
      assert.deepEqual(financial(snapshot()), financial(beforeOpen))
      console.log(JSON.stringify({ status: 'PASS', initial: original, asyncHydration: 'editor disabled until real delayed overview read resolves', refreshKeptDraft: true, fullProcessRestartReadBack: true, proofs, unsavedCancelReadOnly: true, unauthorized: denied, invalid, financialTablesUnchanged: true, financialSnapshotBefore: digest(financial(beforeOpen)), financialSnapshotAfter: digest(financial(snapshot())), snapshotTables: Object.keys(beforeOpen).length, calls: [...previousCalls, ...await rateCalls()], integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check') }, null, 2))
    } finally { db.close() }
  }
} finally { if (app) await app.close(); rmSync(dir, { recursive: true, force: true }) }
