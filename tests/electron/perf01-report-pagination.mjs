import assert from 'node:assert/strict'
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import Database from '../../node_modules/better-sqlite3/lib/index.js'
import { _electron, expect } from '../../node_modules/@playwright/test/index.mjs'
// Supply only a fictional 10,033-customer fixture; the harness copies it into isolated temporary runtime directories.
const phase = process.argv[2] ?? 'after',
  root = process.cwd(),
  base = process.env.PERF01_EVIDENCE_DIR ?? '/tmp/aura-perf01',
  dir = base + '/' + phase + '-runtime-' + process.pid
assert(['before', 'after'].includes(phase))
assert(
  /^(\/tmp\/|\/private\/tmp\/)/.test(base),
  'Evidence directory must be disposable /tmp storage'
)
const fixture = process.env.PERF01_FIXTURE
assert(
  fixture && /^(\/tmp\/|\/private\/tmp\/)/.test(fixture),
  'PERF01_FIXTURE must reference a disposable /tmp database'
)
expect.configure({ timeout: 60000 })
mkdirSync(dir + '/data', { recursive: true })
mkdirSync(dir + '/session', { recursive: true })
copyFileSync(fixture, dir + '/data/erp.db')
const result = {
  phase,
  dir,
  sourceHash: createHash('sha256')
    .update(readFileSync(dir + '/data/erp.db'))
    .digest('hex'),
  samples: [],
  resources: [],
  ipc: [],
  actions: 0
}
function logicalHash() {
  const db = new Database(dir + '/data/erp.db', { readonly: true })
  try {
    const h = createHash('sha256')
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()) {
      h.update(name)
      for (const row of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).iterate())
        h.update(JSON.stringify(row))
    }
    return h.digest('hex')
  } finally {
    db.close()
  }
}
const save = () =>
  writeFileSync(base + '/' + phase + '-electron.json', JSON.stringify(result, null, 2))
writeFileSync(
  dir + '/entry.cjs',
  `const{app,ipcMain,BrowserWindow}=require('electron');global.outputs=[];global.loads=[];global.printerLeaves=[];global.outputTimeouts=[];const load=BrowserWindow.prototype.loadURL;BrowserWindow.prototype.loadURL=function(url,...args){if(url.startsWith('data:text/html;')){const html=url.includes(';base64,')?Buffer.from(url.split(',')[1],'base64').toString('utf8'):decodeURIComponent(url.slice(url.indexOf(',')+1));global.outputs.push(html);const record={at:Date.now(),windowId:this.id,htmlBytes:Buffer.byteLength(html),htmlHash:require('node:crypto').createHash('sha256').update(html).digest('hex'),urlLength:url.length};global.loads.push(record);return load.call(this,url,...args).then(r=>{record.ok=true;record.leafInstalledAt=Date.now();this.webContents.print=(options,callback)=>{global.printerLeaves.push({at:Date.now(),windowId:this.id,loaded:!this.webContents.isLoading(),htmlHash:record.htmlHash});callback(true)};return r},e=>{record.ok=false;record.error=e.message.slice(0,250);throw e})}return load.call(this,url,...args)};app.setPath('userData',${JSON.stringify(dir)});app.setPath('sessionData',${JSON.stringify(dir + '/session')});app.getAppPath=()=>${JSON.stringify(root)};global.calls=[];const h=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>h(channel,async(e,p)=>{const t=performance.now();const output=channel==='documents:printReport'||channel==='documents:exportReportPdf';let timer;const limit=new Promise((_,reject)=>{if(output)timer=setTimeout(()=>{global.outputTimeouts.push({channel,at:Date.now()});for(const w of BrowserWindow.getAllWindows())if(!w.isVisible())w.destroy();reject(new Error('TIMEOUT'))},120000)});let r;try{r=await (output?Promise.race([fn(e,p),limit]):fn(e,p))}finally{clearTimeout(timer)};global.calls.push({channel,payload:p,ms:performance.now()-t,ok:r.ok,code:r.error?.code,path:channel==='documents:exportReportPdf'?r.data?.path:undefined});return r});import(require('node:url').pathToFileURL(${JSON.stringify(root + '/out/main/index.js')}).href);`
)
let app, page
async function settle(page) {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  )
}
function stats(a) {
  const s = [...a].sort((a, b) => a - b)
  return {
    n: s.length,
    p50: s[Math.ceil(s.length * 0.5) - 1],
    p95: s[Math.ceil(s.length * 0.95) - 1],
    max: s.at(-1),
    raw: a
  }
}
try {
  app = await _electron.launch({
    args: [dir + '/entry.cjs'],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    timeout: 90000
  })
  page = await app.firstWindow()
  app
    .process()
    .stderr.on('data', (b) => writeFileSync(base + '/' + phase + '-child.log', b, { flag: 'a' }))
  await page.context().setOffline(true)
  page.setDefaultTimeout(60000)
  await expect(page.locator('.auth-card')).toBeVisible()
  await page.locator('.auth-card input:not([type=password]):not([type=checkbox])').fill('owner')
  await page.locator('.auth-card input[type=password]').fill('secret123')
  await page.getByRole('button', { name: 'دخول', exact: true }).click()
  result.actions += 3
  await expect(page.locator('.sidebar__brand')).toBeVisible()
  await page.evaluate(() => {
    window.perfTasks = []
    new PerformanceObserver((l) =>
      window.perfTasks.push(...l.getEntries().map((e) => e.duration))
    ).observe({ type: 'longtask', buffered: true })
  })
  async function resource(label) {
    const p = await app.evaluate(({ app }) => app.getAppMetrics())
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const m = await cdp.send('Performance.getMetrics')
    await cdp.detach()
    result.resources.push({
      label,
      processes: p,
      heap: m.metrics.filter((x) => /JSHeap/.test(x.name)),
      nodes: await page.evaluate(() => document.getElementsByTagName('*').length)
    })
    save()
  }
  await resource('login')
  const created = await page.evaluate(() =>
    window.erp.customers.create({ name: 'PERF UI created' })
  )
  assert(created.ok)
  result.logicalBefore = logicalHash()
  const logical = await page.evaluate(() => window.erp.reports.build({ key: 'customer_balances' }))
  assert(logical.ok)
  const cols = logical.data.columns
  result.report = logical.data
  assert.equal(logical.data.rows.length, 10034)
  result.dtoBytes = Buffer.byteLength(JSON.stringify(logical.data))
  result.contentHash = createHash('sha256').update(JSON.stringify(logical.data)).digest('hex')
  save()
  for (let i = 0; i < 10; i++) {
    const r = await page.evaluate(async () => {
      const t = performance.now(),
        r = await window.erp.reports.build({ key: 'customer_balances' })
      return { ok: r.ok, ms: performance.now() - t }
    })
    assert(r.ok)
    result.ipc.push(r.ms)
  }
  result.ipcStats = stats(result.ipc)
  await page.getByRole('button', { name: 'التقارير والنظام', exact: true }).click()
  await page.locator('a[href="#/reports"]').click()
  result.actions += 2
  const sel = page.locator('main select').first()
  for (let i = -1; i < 20; i++) {
    await sel.selectOption('sales')
    await expect(page.locator('main h2')).toHaveText('تقرير المبيعات')
    await expect(page.locator('main .state').filter({ hasText: 'جارٍ التحميل' })).toHaveCount(0)
    await settle(page)
    const t = performance.now()
    await sel.selectOption('customer_balances')
    await expect(page.locator('main h2')).toHaveText('أرصدة ومديونية العملاء')
    await expect(page.locator('main tbody tr')).toHaveCount(phase === 'before' ? 10034 : 50)
    await settle(page)
    result.actions += 2
    if (i >= 0)
      result.samples.push({
        ms: performance.now() - t,
        rows: await page.locator('main tbody tr').count(),
        nodes: await page.evaluate(() => document.getElementsByTagName('*').length)
      })
    if (i === 0 || i === 2) await resource(i === 0 ? 'first report' : 'three switches')
    save()
  }
  result.visibleStats = stats(result.samples.map((x) => x.ms))
  await page.screenshot({ path: base + '/' + phase + '-report.png' })
  if (phase === 'after') {
    const nav = page.getByRole('navigation', { name: 'صفحات التقرير' })
    const seen = []
    const next = nav.getByRole('button', { name: 'التالي', exact: true })
    for (let p = 0; p < 201; p++) {
      if (p === 100) {
        result.middle = []
        for (let i = 0; i < 5; i++) {
          const t = performance.now()
          await nav.getByRole('button', { name: 'السابق', exact: true }).click()
          await next.click()
          await settle(page)
          result.middle.push(performance.now() - t)
          result.actions += 2
        }
        result.middleStats = stats(result.middle)
      }
      const rows = await page
        .locator('main tbody tr')
        .evaluateAll((es) =>
          es.map((e) => Array.from(e.querySelectorAll('td')).map((c) => c.textContent))
        )
      assert.deepEqual(
        rows,
        logical.data.rows.slice(p * 50, p * 50 + 50).map((r) => cols.map((c) => r[c] ?? ''))
      )
      seen.push(...rows)
      if (p < 200) {
        await next.click()
        result.actions++
      } else await expect(next).toBeDisabled()
    }
    assert.equal(seen.length, 10034)
    result.allPages = { pages: 201, rows: seen.length, exact: true }
    await expect(nav.getByRole('button', { name: 'الأخيرة', exact: true })).toBeDisabled()
    await nav.getByRole('button', { name: 'السابق', exact: true }).click()
    await expect(page.locator('main tbody tr')).toHaveCount(50)
    await nav.getByRole('button', { name: 'الأولى', exact: true }).click()
    await expect(nav.getByRole('button', { name: 'السابق', exact: true })).toBeDisabled()
    await nav.getByRole('button', { name: 'الأخيرة', exact: true }).click()
    await expect(page.locator('main tbody tr')).toHaveCount(34)
    await sel.selectOption('sales')
    await expect(page.locator('main h2')).toHaveText('تقرير المبيعات')
    await sel.selectOption('customer_balances')
    await expect(page.locator('main tbody tr')).toHaveCount(50)
    await expect(nav).toContainText('صفحة 1 من 201')
    result.navigation = 'PASS'
    result.actions += 5
    result.pageNavigation = []
    for (let i = 0; i < 20; i++) {
      const t = performance.now()
      await nav.getByRole('button', { name: 'الأخيرة', exact: true }).click()
      await nav.getByRole('button', { name: 'الأولى', exact: true }).click()
      result.actions += 2
      await settle(page)
      result.pageNavigation.push(performance.now() - t)
    }
    result.pageNavigationStats = stats(result.pageNavigation)
    await resource('bounded repeated navigation')
  }
  await page.locator('a[href="#/"]').click()
  await settle(page)
  await resource('left reports')
  if (phase === 'after') {
    if ((await page.locator('a[href="#/reports"]').count()) === 0)
      await page.getByRole('button', { name: 'التقارير والنظام', exact: true }).click()
    await page.locator('a[href="#/reports"]').click()
    await page.locator('main select').first().selectOption('customer_balances')
    await expect(page.locator('main tbody tr')).toHaveCount(50)
    await page
      .getByRole('navigation', { name: 'صفحات التقرير' })
      .getByRole('button', { name: 'الأخيرة', exact: true })
      .click()
    await expect(page.locator('main tbody tr')).toHaveCount(34)
    result.delivery = []
    for (const name of ['طباعة', 'تصدير PDF']) {
      const count = await app.evaluate(() => global.calls.length)
      await page.getByRole('button', { name, exact: true }).click()
      await expect
        .poll(
          () =>
            app.evaluate(
              (_, c) => global.calls.slice(c).some((x) => x.channel.startsWith('documents:')),
              count
            ),
          { timeout: 120000 }
        )
        .toBe(true)
      result.delivery.push(await app.evaluate(() => global.calls.at(-1)))
      result.actions++
    }
    const htmls = await app.evaluate(() => global.outputs)
    assert.equal(htmls.length, 2)
    for (const html of htmls) {
      const cells = await page.evaluate((html) => {
        const d = new DOMParser().parseFromString(html, 'text/html')
        return Array.from(d.querySelector('tbody').querySelectorAll('tr')).map((r) =>
          Array.from(r.querySelectorAll('td')).map((c) => c.textContent)
        )
      }, html)
      assert.deepEqual(
        cells,
        logical.data.rows.map((r) => cols.map((c) => r[c] ?? ''))
      )
      const body = html.split('<tbody>')[1].split('</tbody>')[0]
      assert.equal((body.match(/<tr>/g) || []).length, 10034)
      for (const name of [logical.data.rows[0][cols[0]], logical.data.rows.at(-1)[cols[0]]])
        assert(body.includes(name))
    }
    result.output = {
      htmlRows: htmls.map(
        (h) => (h.split('<tbody>')[1].split('</tbody>')[0].match(/<tr>/g) || []).length
      ),
      nativePrinter: 'leaf callback substituted; physical printer NOT TESTED',
      pdf: 'real Electron printToPDF'
    }
    result.pdfPaths = await app.evaluate(() =>
      global.calls.filter((x) => x.channel === 'documents:exportReportPdf')
    )
    for (const output of result.pdfPaths.filter((o) => o.ok)) {
      const bytes = readFileSync(output.path)
      assert(bytes.subarray(0, 4).toString() === '%PDF')
      assert(bytes.subarray(-1024).includes(Buffer.from('%%EOF')))
    }
    await page.locator('main select').first().selectOption('monthly_profit')
    await expect(page.locator('main .state').filter({ hasText: 'جارٍ التحميل' })).toHaveCount(0)
    await settle(page)
    const start = await app.evaluate(() => global.calls.length)
    await page.getByRole('button', { name: 'تصدير PDF', exact: true }).click()
    await expect
      .poll(
        () =>
          app.evaluate(
            (_, c) => global.calls.slice(c).some((x) => x.channel === 'documents:exportReportPdf'),
            start
          ),
        { timeout: 120000 }
      )
      .toBe(true)
    result.smallPdf = await app.evaluate(() => global.calls.at(-1))
    assert(result.smallPdf.ok)
    assert(readFileSync(result.smallPdf.path).subarray(0, 4).toString() === '%PDF')
    result.actions += 2
  }
  result.outputEvidence = await app.evaluate(({ BrowserWindow }) => ({
    loads: global.loads,
    printerLeaves: global.printerLeaves,
    timeouts: global.outputTimeouts,
    windows: BrowserWindow.getAllWindows().map((w) => ({ id: w.id, visible: w.isVisible() }))
  }))
  if (phase === 'after') {
    assert.equal(result.outputEvidence.timeouts.length, 0)
    assert.equal(result.outputEvidence.printerLeaves.length, 1)
    assert(result.outputEvidence.printerLeaves[0].loaded)
    assert.equal(result.outputEvidence.windows.length, 1)
  }
  result.logicalAfter = logicalHash()
  assert.equal(result.logicalAfter, result.logicalBefore)
  result.readOnly = 'PASS'
  if (phase === 'after') {
    await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click()
    await expect(page.locator('.auth-card')).toBeVisible()
    result.anonymous = await page.evaluate(() =>
      window.erp.reports.build({ key: 'customer_balances' })
    )
    assert.equal(result.anonymous.error.code, 'UNAUTHENTICATED')
    result.anonymousOutput = await page.evaluate(async () => [
      await window.erp.documents.printReport({ key: 'customer_balances' }),
      await window.erp.documents.exportReportPdf({ key: 'customer_balances' })
    ])
    assert(result.anonymousOutput.every((r) => !r.ok && r.error.code === 'UNAUTHENTICATED'))
    await page
      .locator('.auth-card input:not([type=password]):not([type=checkbox])')
      .fill('perf-reader')
    await page.locator('.auth-card input[type=password]').fill('secret123')
    await page.getByRole('button', { name: 'دخول', exact: true }).click()
    await expect(page.locator('.sidebar__brand')).toBeVisible()
    result.restricted = await page.evaluate(() =>
      window.erp.reports.build({ key: 'customer_balances' })
    )
    assert.equal(result.restricted.error.code, 'FORBIDDEN')
    result.restrictedOutput = await page.evaluate(async () => [
      await window.erp.documents.printReport({ key: 'customer_balances' }),
      await window.erp.documents.exportReportPdf({ key: 'customer_balances' })
    ])
    assert(result.restrictedOutput.every((r) => !r.ok && r.error.code === 'FORBIDDEN'))
    await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click()
    await expect(page.locator('.auth-card')).toBeVisible()
    await page.locator('.auth-card input:not([type=password]):not([type=checkbox])').fill('owner')
    await page.locator('.auth-card input[type=password]').fill('secret123')
    await page.getByRole('button', { name: 'دخول', exact: true }).click()
    await expect(page.locator('.sidebar__brand')).toBeVisible()
    result.actions += 9
  }
  const repeat = await page.evaluate(() => window.erp.reports.build({ key: 'customer_balances' }))
  assert.deepEqual(repeat.data, logical.data)
  result.parity = 'PASS'
  result.longTasks = await page.evaluate(() => window.perfTasks)
  result.calls = await app.evaluate(() => global.calls)
  result.preferences = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return {
      contextIsolation: p.contextIsolation,
      sandbox: p.sandbox,
      nodeIntegration: p.nodeIntegration,
      webSecurity: p.webSecurity
    }
  })
  result.electron = await app.evaluate(() => process.versions.electron)
  result.status =
    phase === 'before' ? 'RED' : result.delivery.every((r) => r.ok) ? 'PASS' : 'PARTIAL'
  save()
  if (phase === 'after')
    assert(
      result.delivery.every((r) => r.ok),
      'Full M-report native output delivery gate failed; viewer assertions passed'
    )
  if (phase === 'before')
    assert.equal(result.samples[0].rows, 50, 'PERF-01 bound requires at most 50 mounted rows')
} catch (e) {
  result.error = e.stack
  if (app) {
    result.calls = await app.evaluate(() => global.calls).catch(() => [])
    if (page) await page.screenshot({ path: base + '/' + phase + '-failure.png' }).catch(() => {})
  }
  save()
  throw e
} finally {
  if (app) await app.close()
}
