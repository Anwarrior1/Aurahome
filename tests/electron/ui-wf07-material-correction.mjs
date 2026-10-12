import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { _electron, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
const root = process.cwd()
const dir = mkdtempSync('/tmp/uiwf07-electron-')
const pre = process.env.UIWF07_PRE === '1'
const frozenError = 'لا يمكن تعديل صرف أمر تصنيع مكتمل لأن تكلفة الإنتاج أصبحت تاريخية'
let app
try {
  execFileSync('npx', ['vite-node', '--config', 'vitest.config.ts', 'tests/electron/ui-wf07-seed.ts'], { env: { ...process.env, UIWF07_DIR: dir }, stdio: 'pipe' })
  const fixture = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'))
  const wrapper = join(dir, 'entry.cjs')
  writeFileSync(wrapper, `const {app,ipcMain}=require('electron');global.uiwf07Calls=[];const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>handle(channel,async(event,...args)=>{const result=await fn(event,...args);if(channel==='production:correctMaterialConsumption')global.uiwf07Calls.push({input:args[0],result});return result});app.setPath('userData',process.env.UIWF07_DIR);app.setPath('sessionData',process.env.UIWF07_DIR);app.getAppPath=()=>process.env.UIWF07_ROOT;import(require('node:url').pathToFileURL(process.env.UIWF07_ROOT+'/out/main/index.js').href);`)
  app = await _electron.launch({ args: [wrapper], env: { ...process.env, UIWF07_DIR: dir, UIWF07_ROOT: root }, timeout: 60000 })
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), dir)
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const snapshot = () => {
    const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
    try { return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()])) } finally { db.close() }
  }
  async function login(username) {
    await page.locator('input:not([type=password]):not([type=checkbox])').fill(username)
    await page.locator('input[type=password]').fill('secret123')
    await page.getByRole('button', { name: 'دخول', exact: true }).click()
  }
  async function open(sheetId) {
    await page.evaluate((id) => { window.location.hash = '/worksheets/' + id }, sheetId)
    await expect(page.locator('body')).toContainText('UIWF07 Board')
  }
  const digest = (state) => createHash('sha256').update(JSON.stringify(state)).digest('hex')
  const history = () => page.locator('.card').filter({ hasText: 'الصرف الفعلي من المخزون' })
  await login('uiwf07-corrector')
  await open(fixture.completed.sheetId)
  const completed = await page.evaluate((id) => window.erp.production.getWorkSheet({ id }), fixture.completed.sheetId)
  assert.equal(completed.ok, true)
  assert.equal(completed.data.sheet.status, 'completed')
  assert.ok(completed.data.sheet.completedAt)
  const before = snapshot()
  const completedButtons = await history().getByRole('button', { name: 'تعديل', exact: true }).count()
  if (pre) {
    assert.equal(completedButtons, 1)
    await history().getByRole('button', { name: 'تعديل', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('تصحيح صرف مادة')
    await page.getByRole('dialog').locator('input').last().fill('UIWF07 pre-fix frozen control')
    await page.getByRole('button', { name: 'حفظ التصحيح', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText(frozenError)
    assert.deepEqual(snapshot(), before)
    const calls = await app.evaluate(() => global.uiwf07Calls)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].result.error.code, 'CONFLICT')
    assert.equal(calls[0].result.error.message, frozenError)
    console.log(JSON.stringify({ status: 'REPRODUCED', permissions: fixture.permissions, completedDTO: completed.data, correctionButtons: completedButtons, calls, everyTableUnchanged: true, snapshotTables: Object.keys(before).length, snapshotBefore: digest(before), snapshotAfter: digest(snapshot()), frozenRows: { worksheets: before.work_sheets, issues: before.order_material_lines, movements: before.inventory_movements, allocations: before.fifo_allocations } }, null, 2))
  } else {
    assert.equal(completedButtons, 0)
    await expect(history()).toContainText('UIWF07 Board')
    await expect(page.getByRole('button', { name: 'طباعة أمر التصنيع', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'PDF', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'فتح الطلب', exact: true })).toBeVisible()
    const direct = await page.evaluate((input) => window.erp.production.correctMaterialConsumption(input), { id: fixture.completed.lineId, materialId: fixture.materialId, physicalQtyMicro: 8000000, reason: 'Completed IPC bypass control' })
    assert.equal(direct.ok, false)
    assert.equal(direct.error.code, 'CONFLICT')
    assert.equal(direct.error.message, frozenError)
    const afterCompleted = snapshot()
    assert.deepEqual(afterCompleted, before)
    await open(fixture.active.sheetId)
    await history().getByRole('button', { name: 'تعديل', exact: true }).click()
    await page.getByRole('dialog').locator('input[type=number]').fill('8')
    await page.getByRole('dialog').locator('input').last().fill('UIWF07 active correction')
    await page.getByRole('button', { name: 'حفظ التصحيح', exact: true }).click()
    await expect(page.locator('body')).toContainText('تم عكس الصرف الأصلي وتسجيل التصحيح')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const active = await page.evaluate((id) => window.erp.production.getWorkSheet({ id }), fixture.active.sheetId)
    assert.equal(active.data.sheet.status, 'in_production')
    assert.equal(active.data.actualCostMinor, 800000)
    assert.equal(active.data.materialLines.filter((line) => line.status === 'active')[0].physicalQtyMicro, 8000000)
    await page.reload(); await login('uiwf07-viewer'); await open(fixture.active.sheetId)
    await expect(history().getByRole('button', { name: 'تعديل', exact: true })).toHaveCount(0)
    const deniedBefore = snapshot()
    const noPermission = await page.evaluate((input) => window.erp.production.correctMaterialConsumption(input), { id: active.data.materialLines.filter((line) => line.status === 'active')[0].id, materialId: fixture.materialId, physicalQtyMicro: 7000000, reason: 'Missing permission control' })
    assert.equal(noPermission.error.code, 'FORBIDDEN')
    assert.deepEqual(snapshot(), deniedBefore)
    // A different legitimate actor completes the worksheet after the editor opens.
    await page.reload(); await login('owner'); await open(fixture.active.sheetId)
    await history().getByRole('button', { name: 'تعديل', exact: true }).click()
    const completion = await page.evaluate((id) => window.erp.production.completeProduction({ id }), fixture.active.sheetId)
    assert.equal(completion.ok, true)
    const frozen = snapshot()
    await page.getByRole('dialog').locator('input').last().fill('UIWF07 stale editor')
    await page.getByRole('button', { name: 'حفظ التصحيح', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(history().getByRole('button', { name: 'تعديل', exact: true })).toHaveCount(0)
    const afterStale = snapshot()
    assert.deepEqual(afterStale, frozen)
    // Completion through this page refreshes the DTO and closes an open editor immediately.
    await open(fixture.ready.sheetId)
    await history().getByRole('button', { name: 'تعديل', exact: true }).click()
    await page.getByRole('button', { name: 'إنهاء التصنيع', exact: true }).evaluate((button) => button.click())
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(history().getByRole('button', { name: 'تعديل', exact: true })).toHaveCount(0)
    const calls = await app.evaluate(() => global.uiwf07Calls)
    assert.equal(calls.length, 4)
    assert.equal(calls[1].result.ok, true)
    assert.equal(calls[3].result.error.message, frozenError)
    const db = new Database(join(dir, 'data/erp.db'), { readonly: true })
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='orders.material.correct'").get().n, 1)
      assert.equal(db.prepare('SELECT SUM(qty_remaining_micro) AS n FROM fifo_layers').get().n, 72000000)
      console.log(JSON.stringify({ status: 'PASS', permissions: fixture.permissions, completedCorrectionButtons: completedButtons, completedHistoryVisible: true, otherActionsVisible: true, completedDTO: completed.data, completedIPC: direct, completedEveryTableUnchanged: true, activeDTO: active.data, missingPermissionIPC: noPermission, calls, snapshotTables: Object.keys(before).length, completedSnapshotBefore: digest(before), completedSnapshotAfter: digest(afterCompleted), staleSnapshotBefore: digest(frozen), staleSnapshotAfter: digest(afterStale), staleEditorClosed: true, staleEveryTableUnchanged: true, ownCompletionClosedEditor: true, correctionAudits: 1, remainingStockMicro: 72000000, integrity: db.pragma('integrity_check'), foreignKeys: db.pragma('foreign_key_check') }, null, 2))
    } finally { db.close() }
  }
} finally { if (app) await app.close(); rmSync(dir, { recursive: true, force: true }) }
