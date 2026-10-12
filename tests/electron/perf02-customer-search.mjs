import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, copyFileSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
const root=process.cwd(), require=createRequire(join(root,'package.json'));
const {_electron,expect}=require('@playwright/test');
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const phase=process.argv[2]??'after';
assert(['before','after'].includes(phase),'phase must be before or after');
assert(process.env.PERF02_FIXTURE,'set PERF02_FIXTURE to the preserved fictional L-scale database');
const fixture=realpathSync(process.env.PERF02_FIXTURE);
assert.equal(sha(fixture),'b019cb1282f74ab9349be20263693933ba0ab18879663780a9c76a63f62df915','only the immutable audit fixture is permitted');
const base=resolve(process.env.PERF02_EVIDENCE_DIR??'/tmp/aura-perf02');
mkdirSync(base,{recursive:true});
const fromProject=relative(realpathSync(root),realpathSync(base));
assert(fromProject==='..'||fromProject.startsWith('..'+sep)||isAbsolute(fromProject),'evidence must remain outside the project');
const dir=mkdtempSync(join(base,phase+'-runtime-')); mkdirSync(join(dir,'data'));mkdirSync(join(dir,'session'));copyFileSync(fixture,join(dir,'data/erp.db'));
const evidence={phase,dir,fixture,fixtureSha:sha(fixture),initialRuntimeSha:sha(join(dir,'data/erp.db')),trials:[],slow:[],checks:{},errors:[],network:[]};
const save=()=>writeFileSync(join(base,phase+'-electron.json'),JSON.stringify(evidence,null,2));
const stats=a=>{const v=[...a].sort((a,b)=>a-b);return {n:a.length,p50:v[Math.ceil(v.length*.5)-1],p95:v[Math.ceil(v.length*.95)-1],max:v.at(-1),raw:a}};
const entry=join(dir,'entry.cjs');
writeFileSync(entry,`const {app,ipcMain}=require('electron'),fs=require('node:fs'),crypto=require('node:crypto');app.setPath('userData',${JSON.stringify(dir)});app.setPath('sessionData',${JSON.stringify(join(dir,'session'))});app.getAppPath=()=>${JSON.stringify(root)};global.calls=[];global.callSeq=0;global.sql=[];global.currentChannel=null;global.channels=[];const D=require(${JSON.stringify(join(root,'node_modules/better-sqlite3/lib/index.js'))});const prepare=D.prototype.prepare;D.prototype.prepare=function(sql){const stmt=prepare.call(this,sql);for(const method of ['all','get']){const f=stmt[method].bind(stmt);stmt[method]=(...p)=>{const t=performance.now();try{return f(...p)}finally{if(global.currentChannel==='customers:list')global.sql.push({sql,ms:performance.now()-t})}}}return stmt};global.logical=()=>{const db=new D(${JSON.stringify(join(dir,'data/erp.db'))},{readonly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>{const h=crypto.createHash('sha256');for(const row of db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').iterate())h.update(JSON.stringify(row));return [name,h.digest('hex')]}))}finally{db.close()}};const h=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,fn)=>{global.channels.push(channel);return h(channel,async(e,p)=>{const seq=++global.callSeq,t=performance.now(),epoch=performance.timeOrigin+t;global.currentChannel=channel;try{const r=await fn(e,p);global.calls.push({seq,channel,payload:p,start:t,epoch,ms:performance.now()-t,ok:r.ok,code:r.error?.code,count:r.data?.summary?.totalCount,ids:r.data?.items?.map(x=>x.id),names:r.data?.items?.map(x=>x.name)});return r}finally{global.currentChannel=null}})};import(require('node:url').pathToFileURL(${JSON.stringify(join(root,'out/main/index.js'))}).href);`);
let app,page;
const calls=async seq=>app.evaluate((_,seq)=>global.calls.filter(c=>c.seq>seq&&c.channel==='customers:list'),seq);
const seq=()=>app.evaluate(()=>global.callSeq);
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
async function ready(){await expect(page.locator('main .state').filter({hasText:'جارٍ التحميل'})).toHaveCount(0);await settle()}
async function login(user='owner') {await page.locator('.auth-card input:not([type=password]):not([type=checkbox])').fill(user);await page.locator('.auth-card input[type=password]').fill('secret123');await page.getByRole('button',{name:'دخول',exact:true}).click();await expect(page.locator('.sidebar__brand')).toBeVisible();await ready()}
async function nav(path){const a=page.locator(`a[href="#${path}"]`);if(!await a.count())await page.getByRole('button',{name:'المبيعات',exact:true}).click();await page.locator(`a[href="#${path}"]`).click();await expect(page).toHaveURL(new RegExp('#'+path+'$'));await ready()}
async function fixed(payload){return page.evaluate(async p=>{const t=performance.now(),r=await window.erp.customers.list(p);return {r,ms:performance.now()-t}},payload)}
async function dom(){return page.locator('main tbody tr').evaluateAll(rows=>rows.map(r=>({name:r.cells[0].firstChild.textContent,phone:r.cells[1].textContent,values:[...r.cells].slice(3,6).map(c=>c.textContent)})))}
try {
 app=await _electron.launch({args:[entry],env:{...process.env,ELECTRON_RENDERER_URL:''},timeout:90000});page=await app.firstWindow();page.setDefaultTimeout(60000);await page.context().setOffline(true);page.on('pageerror',e=>evidence.errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))evidence.network.push(r.url())});await login();await nav('/customers');
 evidence.environment=await app.evaluate(({BrowserWindow,app})=>({versions:process.versions,preferences:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),metrics:app.getAppMetrics()}));evidence.channels=await app.evaluate(()=>global.channels);assert(!evidence.channels.some(c=>/^recovery:/.test(c)));evidence.ownerInitial=await fixed({});assert(evidence.ownerInitial.r.ok);assert.equal(evidence.ownerInitial.r.data.summary.totalCount,100033);assert.equal((await dom()).length,50);
 // Set up a fictional denied principal via real existing privileged APIs, outside read-only boundary.
 evidence.setup=await page.evaluate(async()=>{const role=await window.erp.admin.createRole({name:'PERF02 no customer access',permissions:['dashboard.view']});if(!role.ok)return role;return window.erp.admin.createUser({username:'perf02-denied',fullName:'PERF02 fictional denied',password:'secret123',roleId:role.data.id})});assert(evidence.setup.ok);
 evidence.logicalBefore=await app.evaluate(()=>global.logical());
 await page.evaluate(()=>{window.perfInputs=[];window.perfLongTasks=[];document.querySelector('input[placeholder="الاسم أو رقم الهاتف"]').addEventListener('input',e=>window.perfInputs.push({value:e.target.value,at:performance.now(),epoch:performance.timeOrigin+performance.now()}));new PerformanceObserver(l=>window.perfLongTasks.push(...l.getEntries().map(x=>({at:x.startTime,ms:x.duration})))).observe({type:'longtask'})});
 const search=page.getByPlaceholder('الاسم أو رقم الهاتف');
 async function trial(index){await search.fill('');await expect(page.locator('main tbody tr')).toHaveCount(50);await ready();const before=await seq();await page.evaluate(()=>{window.perfTrialStart=performance.now();window.perfInputs=[]});const t=performance.now();await search.pressSequentially('NO-MATCH-PERF');assert.equal(await search.inputValue(),'NO-MATCH-PERF');await expect(page.locator('main .state')).toContainText('لا يوجد عملاء');await settle();const controllerMs=performance.now()-t;const observation=await page.evaluate(()=>({end:performance.now(),epoch:performance.timeOrigin+performance.now(),start:window.perfTrialStart,inputs:window.perfInputs}));const requests=await calls(before);assert.equal(requests.at(-1).payload.search,'NO-MATCH-PERF');assert.equal(requests.at(-1).count,0);const final=requests.at(-1),first=observation.inputs[0],last=observation.inputs.at(-1);return {index,requests,requestCount:requests.length,handlerMs:requests.reduce((s,c)=>s+c.ms,0),inputToVisibleMs:observation.epoch-first.epoch,requestToVisibleMs:observation.epoch-final.epoch,debounceWaitMs:final.epoch-last.epoch,controllerMs,inputEvents:observation.inputs,inputBurstMs:last.epoch-first.epoch,inputCorrect:true,resultCorrect:true}}
 await trial('warm-up');for(let i=0;i<20;i++){evidence.trials.push(await trial(i));save()}
 evidence.stats={requests:[...new Set(evidence.trials.map(x=>x.requestCount))],handler:stats(evidence.trials.map(x=>x.handlerMs)),input:stats(evidence.trials.map(x=>x.inputToVisibleMs)),request:stats(evidence.trials.map(x=>x.requestToVisibleMs)),wait:stats(evidence.trials.map(x=>x.debounceWaitMs)),burst:stats(evidence.trials.map(x=>x.inputBurstMs))};
 evidence.resources=await app.evaluate(({app})=>app.getAppMetrics());evidence.longTasks=await page.evaluate(()=>window.perfLongTasks);save();
 if(phase==='after'){
  evidence.inFlight=[];
  for(let attempt=0;attempt<5;attempt++){
   await search.fill('');await expect(page.locator('main tbody tr')).toHaveCount(50);await ready();const b=await seq();
   const race=await page.evaluate(()=>new Promise(resolve=>{
    const el=document.querySelector('input[placeholder="الاسم أو رقم الهاتف"]'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    const result={frames:[],changed:null};let frames=0;
    const apply=value=>{set.call(el,value);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}))};
    apply('0');setTimeout(()=>{apply('NO-MATCH-PERF');result.changed=performance.timeOrigin+performance.now()},160);
    const observe=()=>{const rows=[...document.querySelectorAll('main tbody tr')].map(r=>r.cells[0].textContent),loading=[...document.querySelectorAll('main .state')].some(e=>e.textContent.includes('جارٍ التحميل'));
     result.frames.push({epoch:performance.timeOrigin+performance.now(),input:el.value,rows,loading});
     if(result.changed&&!loading&&document.querySelector('main .state')?.textContent.includes('لا يوجد عملاء'))return resolve(result);
     if(++frames>=120)return resolve({...result,timeout:true});requestAnimationFrame(observe)};requestAnimationFrame(observe);
   }));
   const requests=await calls(b);const old=requests.find(c=>c.payload?.search==='0');race.requests=requests;race.proven=!!old&&old.epoch<race.changed&&old.epoch+old.ms>race.changed;evidence.inFlight.push(race);save();assert(!race.timeout);assert(race.frames.filter(f=>f.epoch>=race.changed).every(f=>f.rows.length===0));if(race.proven)break;
  }
 }
 if(phase==='after')assert(evidence.inFlight.some(r=>r.proven),'must observe an actual request in flight across the input change');
 if(phase==='after'&&process.env.PERF02_CANDIDATES==='1'){
  evidence.candidates=[];
  // Exploration only: override the sole customer 150-ms timer, never IPC,
  // services or responses. Restore the native timer before preservation tests.
  await page.evaluate(()=>{window.perfNativeTimer=window.setTimeout});
  for(const interval of [150,200,250,300]){
   await page.evaluate(interval=>{window.setTimeout=(fn,delay,...args)=>window.perfNativeTimer(fn,delay===150?interval:delay,...args)},interval);
   const samples=[];for(let i=0;i<5;i++)samples.push(await trial('candidate-'+interval+'-'+i));assert(samples.every(t=>t.requestCount===1));evidence.candidates.push({interval,input:stats(samples.map(t=>t.inputToVisibleMs)),wait:stats(samples.map(t=>t.debounceWaitMs)),handler:stats(samples.map(t=>t.handlerMs)),samples});save();
  }
  await page.evaluate(()=>{window.setTimeout=window.perfNativeTimer});
 }
 await search.fill('0009');await ready();const expected=await fixed({search:'0009',state:'active'});assert(expected.r.ok);assert.deepEqual((await dom()).map(x=>x.name),expected.r.data.items.map(x=>x.name));evidence.checks.substring={total:expected.r.data.summary.totalCount,ids:expected.r.data.items.map(x=>x.id),rows:await dom()};
 if(expected.r.data.nextCursor){await page.getByRole('button',{name:'التالي',exact:true}).click();await ready();const next=await fixed({search:'0009',state:'active',cursor:expected.r.data.nextCursor});assert.deepEqual((await dom()).map(x=>x.name),next.r.data.items.map(x=>x.name));evidence.checks.pagination={first:expected.r.data.items.map(x=>x.id),next:next.r.data.items.map(x=>x.id),lastPayload:(await calls(0)).at(-2)?.payload};await page.getByRole('button',{name:'السابق',exact:true}).click();await ready();assert.deepEqual((await dom()).map(x=>x.name),expected.r.data.items.map(x=>x.name))}
 await search.fill('');await ready();assert.deepEqual((await dom()).map(x=>x.name),evidence.ownerInitial.r.data.items.map(x=>x.name));evidence.checks.clear=true;
 if(phase==='after'){
  await page.getByRole('button',{name:'التالي',exact:true}).click();await ready();await search.fill('   ');await ready();assert.deepEqual((await dom()).map(x=>x.name),evidence.ownerInitial.r.data.items.map(x=>x.name));await page.getByRole('button',{name:'التالي',exact:true}).click();await ready();await search.fill('');await ready();assert.deepEqual((await dom()).map(x=>x.name),evidence.ownerInitial.r.data.items.map(x=>x.name));evidence.checks.whitespaceClearPagination=true;
 }

 // Slow typing pauses until each actual settled request and visible response, not arbitrary timer waits.
 for(const term of ['N','NO','NO-']){const b=await seq();await search.fill(term);await expect.poll(async()=> (await calls(b)).some(c=>c.payload?.search===term)).toBe(true);await ready();assert(await search.evaluate(el=>document.activeElement===el),'settled query must preserve input focus');evidence.slow.push({term,calls:await calls(b),focused:true})}
 // Native DOM composition events are simulated; this is not hardware IME certification.
 await search.fill('');await ready();const cb=await seq();await search.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,'عم');el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'عم',isComposing:true}));});
 await page.evaluate(()=>new Promise(r=>setTimeout(r,350)));evidence.checks.compositionIntermediateCalls=await calls(cb);
 await search.evaluate(el=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,'عميل');el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'يل',isComposing:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'عميل'}))});await ready();assert.equal(await search.inputValue(),'عميل');const arabic=await fixed({search:'عميل',state:'active'});assert.deepEqual((await dom()).map(x=>x.name),arabic.r.data.items.map(x=>x.name));evidence.checks.arabic={total:arabic.r.data.summary.totalCount,rows:await dom()};
 await search.fill('');await ready();const nb=await seq();await search.fill('pending-navigation');await nav('/');await page.evaluate(()=>new Promise(r=>setTimeout(r,350)));evidence.checks.afterNavigationCalls=await calls(nb);await nav('/customers');assert.deepEqual((await dom()).map(x=>x.name),evidence.ownerInitial.r.data.items.map(x=>x.name));evidence.checks.navigation=true;
 await page.getByRole('button',{name:'سجل العميل',exact:true}).first().click();await expect(page.getByRole('dialog')).toBeVisible();evidence.checks.selectedHistoryTitle=await page.getByRole('dialog').textContent();await page.getByRole('dialog').getByRole('button',{name:'إغلاق',exact:true}).click();
 evidence.logicalAfter=await app.evaluate(()=>global.logical());assert.deepEqual(evidence.logicalAfter,evidence.logicalBefore);evidence.checks.readOnly=true;
 await page.screenshot({path:join(base,phase+'-customers.png')});
 await page.getByRole('button',{name:'تسجيل الخروج',exact:true}).click();evidence.checks.anonymous=await fixed({search:'0009'});assert.equal(evidence.checks.anonymous.r.error.code,'UNAUTHENTICATED');await login('perf02-denied');evidence.checks.unauthorized=await fixed({search:'0009'});assert.equal(evidence.checks.unauthorized.r.error.code,'FORBIDDEN');await page.getByRole('button',{name:'تسجيل الخروج',exact:true}).click();await login('perf-reader');evidence.checks.employee=await fixed({search:'0009'});assert(evidence.checks.employee.r.ok);assert.deepEqual(evidence.checks.employee.r.data,expected.r.data);evidence.calls=await app.evaluate(()=>global.calls);evidence.sql=await app.evaluate(()=>global.sql);evidence.finalFixtureSha=sha(fixture);assert.equal(evidence.finalFixtureSha,evidence.fixtureSha);assert.deepEqual(evidence.errors,[]);
 if(phase==='after'){assert(evidence.trials.every(t=>t.requestCount===1));assert.deepEqual(evidence.checks.compositionIntermediateCalls,[]);assert.equal(evidence.checks.afterNavigationCalls.filter(c=>c.payload?.search==='pending-navigation').length,0)}else assert(evidence.trials.every(t=>t.requestCount===13));
 evidence.status='PASS';save();console.log(JSON.stringify(evidence.stats));
 // Same strict requirement in RED and GREEN: original must fail here.
 assert(evidence.trials.every(t=>t.requestCount===1),'controlled burst must issue exactly one customer search request');
}catch(e){evidence.status='FAIL';evidence.error=e.stack;save();throw e}finally{if(app)await app.close()}
