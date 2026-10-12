import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, copyFileSync, cpSync, readFileSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
const root = process.cwd(), require = createRequire(join(root, 'package.json'))
const { _electron, expect } = require('@playwright/test')
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex')
const phase = process.argv[2] ?? 'after'
assert(['before', 'after'].includes(phase))
assert(process.env.PERF03_FIXTURE, 'PERF03_FIXTURE must name the immutable fictional audit fixture')
const fixture = realpathSync(process.env.PERF03_FIXTURE)
const fixtureSha = 'b019cb1282f74ab9349be20263693933ba0ab18879663780a9c76a63f62df915'
assert.equal(sha(fixture), fixtureSha, 'real/unknown data is forbidden')
const base = resolve(process.env.PERF03_EVIDENCE_DIR ?? '/tmp/aura-perf03')
mkdirSync(base, { recursive: true })
const rel = relative(realpathSync(root), realpathSync(base))
assert(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel), 'evidence must be external')
const dir = mkdtempSync(join(base, phase + '-runtime-'))
mkdirSync(join(dir, 'data')); mkdirSync(join(dir, 'session'))
copyFileSync(fixture, join(dir, 'data/erp.db'))
const buildDir = resolve(process.env.PERF03_BUILD_DIR ?? join(root, 'out'))
cpSync(buildDir, join(dir, 'out'), { recursive: true })
symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir')
const compiled = join(dir, 'out/main/index.js'), original = readFileSync(compiled, 'utf8')
const signature = 'function listWorkers(filter = {}) {'
assert.equal(original.split(signature).length, 2, 'instrument exactly one compiled owner')
// Observes the compiled owner; its body and every authoritative dependency remain exact.
const prefix = `function listWorkers(...args) { const t=performance.now();try{return perf03CompiledListWorkers(...args)}finally{global.services.push({seq:global.callSeq,ms:performance.now()-t})}}\nfunction perf03CompiledListWorkers(filter = {}) {`
let observed = original.replace(signature, prefix)
assert.equal(observed.replace(prefix, signature), original)
// Observer-only main-process oracle: original pre-edit list algorithm and unchanged single-worker projection.
const oracleCode = `\nglobal.originalWorkers=(filter={})=>{const clauses=[];if(filter.search?.trim())clauses.push(like(workers.name,\`%\${filter.search.trim()}%\`));if(filter.activeOnly)clauses.push(eq(workers.active,true));return getDatabase().select().from(workers).where(clauses.length?and(...clauses):void 0).all().map(w=>({...w,...workerBalances(w.id)}))};\n`
observed += oracleCode
writeFileSync(compiled, observed)
const evidence = { phase, dir, fixture, fixtureSha, buildDir, compiledSha: sha(join(buildDir, 'main/index.js')), observedSha: sha(compiled), initialRuntimeSha: sha(join(dir, 'data/erp.db')), trials: [], ipcTrials: [], checks: {}, errors: [], network: [] }
const save = () => writeFileSync(join(base, phase + '-electron.json'), JSON.stringify(evidence, null, 2))
const stats = a => { const v = [...a].sort((a,b) => a-b); return { n: a.length, p50: v[Math.ceil(v.length*.5)-1], p95: v[Math.ceil(v.length*.95)-1], max: v.at(-1), raw: a } }
const entry = join(dir, 'entry.cjs')
writeFileSync(entry, `const {app,ipcMain}=require('electron'),crypto=require('node:crypto');app.setPath('userData',${JSON.stringify(dir)});app.setPath('sessionData',${JSON.stringify(join(dir,'session'))});app.getAppPath=()=>${JSON.stringify(root)};global.calls=[];global.services=[];global.callSeq=0;global.sql=[];global.currentChannel=null;global.channels=[];
const D=require(${JSON.stringify(join(root,'node_modules/better-sqlite3/lib/index.js'))});const prepare=D.prototype.prepare;D.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);for(const method of ['all','get','run','iterate']){const f=stmt[method].bind(stmt);stmt[method]=(...p)=>{const t=performance.now();try{return f(...p)}finally{if(global.currentChannel==='workers:list')global.sql.push({seq:global.callSeq,sql,args:p,method,ms:performance.now()-t,inTransaction:this.inTransaction})}}}return stmt};
global.logical=()=>{const db=new D(${JSON.stringify(join(dir,'data/erp.db'))},{readonly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>{const h=crypto.createHash('sha256');for(const row of db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').iterate())h.update(JSON.stringify(row));return [name,h.digest('hex')]}))}finally{db.close()}};
global.integerOracle=()=>{const db=new D(${JSON.stringify(join(dir,'data/erp.db'))},{readonly:true});try{const out={};for(const r of db.prepare('SELECT worker_id,kind,amount_minor FROM worker_transactions').iterate()){if(!out[r.worker_id])out[r.worker_id]={payable:0n,debt:0n};const v=out[r.worker_id],a=BigInt(r.amount_minor);switch(r.kind){case 'earning':case 'adjustment':v.payable+=a;break;case 'commission_payment':v.payable-=a;break;case 'withdrawal':v.debt+=a;break;case 'repayment':v.debt-=a;break}}return Object.fromEntries(Object.entries(out).map(([id,v])=>[id,{payableMinor:Number(v.payable),debtMinor:Number(v.debt)}]))}finally{db.close()}};
const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>{global.channels.push(channel);return handle(channel,async(e,p)=>{const seq=++global.callSeq,t=performance.now(),epoch=performance.timeOrigin+t;global.currentChannel=channel;try{const r=await fn(e,p);global.calls.push({seq,channel,payload:p,epoch,ms:performance.now()-t,ok:r.ok,code:r.error?.code,ids:channel==='workers:list'&&r.ok?r.data.map(w=>w.id):undefined});return r}finally{global.currentChannel=null}})};import(require('node:url').pathToFileURL(${JSON.stringify(compiled)}).href);`)
let app, page
const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
async function ready() { await expect(page.locator('main .state').filter({hasText:'جارٍ التحميل'})).toHaveCount(0); await settle() }
async function login(user='owner') { await page.locator('.auth-card input:not([type=password]):not([type=checkbox])').fill(user); await page.locator('.auth-card input[type=password]').fill('secret123'); await page.getByRole('button',{name:'دخول',exact:true}).click(); await expect(page.locator('.sidebar__brand')).toBeVisible(); await ready() }
async function nav(path) { if (!await page.locator(`a[href="#${path}"]`).count()) await page.getByRole('button',{name:'الإنتاج',exact:true}).click(); await page.locator(`a[href="#${path}"]`).click(); await expect(page).toHaveURL(new RegExp('#'+path+'$')); await ready() }
const fixed = payload => page.evaluate(async p => { const t=performance.now(), r=await window.erp.workers.list(p); return {r,ms:performance.now()-t} },payload)
const dom = () => page.locator('main tbody tr').evaluateAll(rows => rows.map(r => ({name:r.cells[0].textContent,phone:r.cells[1].textContent,payable:r.cells[2].querySelector('span').textContent,debt:r.cells[3].textContent})))
const expectedDom = rows => rows.map(w => ({name:w.name,phone:w.phone??'—',payable:new Intl.NumberFormat('ar-LY-u-nu-latn',{minimumFractionDigits:2,maximumFractionDigits:2}).format(w.payableMinor/1000)+' د.ل',debt:new Intl.NumberFormat('ar-LY-u-nu-latn',{minimumFractionDigits:2,maximumFractionDigits:2}).format(w.debtMinor/1000)+' د.ل'}))
try {
 app=await _electron.launch({args:[entry],env:{...process.env,ELECTRON_RENDERER_URL:''},timeout:90000})
 page=await app.firstWindow(); page.setDefaultTimeout(60000); await page.context().setOffline(true)
 page.on('pageerror',e=>evidence.errors.push(e.message)); page.on('request',r=>{if(/^https?:/.test(r.url()))evidence.network.push(r.url())})
 await login()
 evidence.environment=await app.evaluate(({BrowserWindow,app})=>({versions:process.versions,preferences:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),metrics:app.getAppMetrics()}))
 const p=evidence.environment.preferences;assert(p.contextIsolation&&p.sandbox&&p.webSecurity&&!p.nodeIntegration)
 evidence.channels=await app.evaluate(()=>global.channels)
 // Real existing owner APIs establish two fictional principals before the read-only boundary.
 for(const [user,permissions] of [['perf03-denied',['dashboard.view']],['perf03-reader',['workers.view']]]) {
  const result=await page.evaluate(async ({user,permissions})=>{const role=await window.erp.admin.createRole({name:user,permissions});if(!role.ok)return role;return window.erp.admin.createUser({username:user,fullName:'PERF03 fictional',password:'secret123',roleId:role.data.id})},{user,permissions});assert(result.ok)
 }
 evidence.logicalBefore=await app.evaluate(()=>global.logical())
 evidence.original=await app.evaluate(()=>global.originalWorkers({activeOnly:true}))
 const integer=await app.evaluate(()=>global.integerOracle())
 for(const w of evidence.original)assert.deepEqual({payableMinor:w.payableMinor,debtMinor:w.debtMinor},integer[w.id]??{payableMinor:0,debtMinor:0})
 assert.equal(evidence.original.length,1000)
 await nav('/workers');await expect(page.locator('main tbody tr')).toHaveCount(1000);await ready()
 assert.deepEqual(await dom(),expectedDom(evidence.original))
 await page.evaluate(()=>{window.perfLongTasks=[];window.perfClicks=[];new PerformanceObserver(l=>window.perfLongTasks.push(...l.getEntries().map(e=>({at:e.startTime,ms:e.duration})))).observe({type:'longtask'});document.addEventListener('click',e=>{if(e.target.closest('a[href="#/workers"]'))window.perfClicks.push(performance.timeOrigin+performance.now())},true)})
 async function uiTrial(index) {
  await nav('/');const seq=await app.evaluate(()=>global.callSeq)
  await nav('/workers');await expect(page.locator('main tbody tr')).toHaveCount(1000);await ready()
  const observation=await page.evaluate(()=>({epoch:performance.timeOrigin+performance.now(),start:window.perfClicks.at(-1)}))
  const request=await app.evaluate((_,seq)=>global.calls.filter(c=>c.seq>seq&&c.channel==='workers:list'),seq);assert.equal(request.length,1)
  const call=request[0],trace=await app.evaluate((_,seq)=>({sql:global.sql.filter(s=>s.seq===seq),services:global.services.filter(s=>s.seq===seq)}),call.seq)
  assert.equal(trace.services.length,1);assert(trace.sql.every(s=>!s.inTransaction))
  assert.deepEqual(await dom(),expectedDom(evidence.original))
  return {index,visibleMs:observation.epoch-observation.start,handlerMs:call.ms,serviceMs:trace.services[0].ms,sqlCount:trace.sql.length,sqlMs:trace.sql.reduce((s,q)=>s+q.ms,0),call,sql:trace.sql}
 }
 evidence.warmup=await uiTrial('warmup')
 for(let i=0;i<20;i++){evidence.trials.push(await uiTrial(i));save()}
 evidence.resources=await app.evaluate(({app})=>app.getAppMetrics())
 evidence.longTasks=await page.evaluate(()=>window.perfLongTasks)
 for(let i=-1;i<20;i++) {
  const seq=await app.evaluate(()=>global.callSeq), r=await fixed({activeOnly:true});assert(r.r.ok);assert.deepEqual(r.r.data,evidence.original)
  const trace=await app.evaluate((_,seq)=>({calls:global.calls.filter(c=>c.seq>seq&&c.channel==='workers:list'),sql:global.sql.filter(s=>s.seq>seq),services:global.services.filter(s=>s.seq>seq)}),seq)
  assert.equal(trace.calls.length,1);assert.equal(trace.services.length,1)
  if(i>=0)evidence.ipcTrials.push({ipcMs:r.ms,handlerMs:trace.calls[0].ms,serviceMs:trace.services[0].ms,sqlCount:trace.sql.length,sqlMs:trace.sql.reduce((s,q)=>s+q.ms,0)})
 }
 for(const filter of [{},{activeOnly:true},{activeOnly:false},{search:' Worker 99 ',activeOnly:true},{search:'%'},{search:'NO-MATCH-PERF03',activeOnly:true}]) {
  const old=await app.evaluate((_,f)=>global.originalWorkers(f),filter),actual=await fixed(filter);assert(actual.r.ok);assert.deepEqual(actual.r.data,old)
  for(const w of old)assert.deepEqual({payableMinor:w.payableMinor,debtMinor:w.debtMinor},integer[w.id]??{payableMinor:0,debtMinor:0})
 }
 const search=page.locator('main input').first()
 await search.fill('Worker 99');const filtered=await fixed({search:'Worker 99',activeOnly:true});await expect(page.locator('main tbody tr')).toHaveCount(filtered.r.data.length);await ready();assert.deepEqual(await dom(),expectedDom(filtered.r.data))
 await search.fill('NO-MATCH-PERF03');await expect(page.locator('main .state')).toContainText('لا يوجد عمال');await ready();assert.equal((await dom()).length,0)
 await search.fill('');await expect(page.locator('main tbody tr')).toHaveCount(1000);await ready()
 const first=evidence.original[0];const statement=await page.evaluate(async id=>window.erp.workers.statement({id}),first.id);assert(statement.ok);assert.equal(statement.data.payableMinor,first.payableMinor);assert.equal(statement.data.debtMinor,first.debtMinor)
 await page.getByRole('button',{name:'سجل المسحوبات والمرتجعات',exact:true}).first().click();await expect(page.getByRole('dialog')).toBeVisible();await ready();evidence.checks.historyTitle=await page.getByRole('dialog').textContent();assert(evidence.checks.historyTitle.includes(first.name));await page.getByRole('dialog').getByRole('button',{name:'إغلاق',exact:true}).last().click()
 evidence.visible=await dom();assert.deepEqual(evidence.visible,expectedDom(evidence.original))
 evidence.logicalAfter=await app.evaluate(()=>global.logical());assert.deepEqual(evidence.logicalAfter,evidence.logicalBefore)
 await page.screenshot({path:join(base,phase+'-workers.png')})
 await page.getByRole('button',{name:'تسجيل الخروج',exact:true}).click();const anonymous=await fixed({});assert.equal(anonymous.r.error.code,'UNAUTHENTICATED')
 await login('perf03-denied');const denied=await fixed({});assert.equal(denied.r.error.code,'FORBIDDEN')
 await page.getByRole('button',{name:'تسجيل الخروج',exact:true}).click();await login('perf03-reader');const reader=await fixed({activeOnly:true});assert(reader.r.ok);assert.deepEqual(reader.r.data,evidence.original)
 const historyDenied=await page.evaluate(async id=>window.erp.workers.statement({id}),first.id);assert.equal(historyDenied.error.code,'FORBIDDEN')
 evidence.checks={...evidence.checks,originalAndOracle:true,completeDto:true,visible:true,filters:true,empty:true,history:true,readOnly:true,anonymous,denied,reader:true,historyDenied}
 evidence.stats={service:stats(evidence.ipcTrials.map(t=>t.serviceMs)),ipc:stats(evidence.ipcTrials.map(t=>t.ipcMs)),handler:stats(evidence.ipcTrials.map(t=>t.handlerMs)),visible:stats(evidence.trials.map(t=>t.visibleMs)),sql:stats(evidence.ipcTrials.map(t=>t.sqlMs)),sqlCounts:[...new Set(evidence.trials.map(t=>t.sqlCount))]}
 evidence.finalFixtureSha=sha(fixture);assert.equal(evidence.finalFixtureSha,fixtureSha);assert.deepEqual(evidence.errors,[]);assert.deepEqual(evidence.network,[])
 evidence.calls=await app.evaluate(()=>global.calls);evidence.status='PASS';save();console.log(JSON.stringify(evidence.stats))
 // The same hard assertion fails on the original compiled application.
 assert(evidence.trials.every(t=>t.sqlCount<=2),'compiled worker list must execute at most two SQL statements')
} catch(e) {evidence.status='FAIL';evidence.error=e.stack;save();throw e} finally {if(app)await app.close()}
