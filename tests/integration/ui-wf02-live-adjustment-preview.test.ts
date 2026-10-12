import {readFileSync} from 'node:fs'
import {createContext, runInContext} from 'node:vm'
import ts from 'typescript'
import {randomUUID} from 'node:crypto'
import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest'
import type {IpcMainInvokeEvent} from 'electron'
import type {IpcResult} from '@shared/types/ipc.types'
import {IPC_CHANNELS as C} from '@shared/constants/channels'
import {createRole, createUser} from '@main/services/admin/users.service'
import {login} from '@main/auth/auth.service'
import {getRawConnection} from '@main/db/connection'
import {reconcileDatabase} from '@main/db/reconciliation'
import * as cash from '@main/services/finance/cash.service'
import {setupTestDatabase, type TestEnv} from '../helpers/test-db'

// Execute the actual adjustment initialization, fields, preview and submit,
// with real financialCall retry logic, registered guards/session and SQLite.
// Only the React state/view shell and Electron transport are replaced.
const source=readFileSync('src/renderer/pages/cash/CashPage.tsx','utf8')
const apiSource=readFileSync('src/renderer/lib/api.ts','utf8')
function nodeText(text: string, predicate: (node: ts.Node)=>boolean) {
  const ast=ts.createSourceFile('source.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  let found: ts.Node|undefined
  function visit(node: ts.Node) {if(predicate(node))found=node;else ts.forEachChild(node,visit)}
  visit(ast);if(!found)throw Error('Renderer source binding missing');return found.getText(ast)
}
function fn(text: string,name: string) {
  return nodeText(text,n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).replace(/^export /,'')
}
const open=nodeText(source,n=>ts.isArrowFunction(n)&&n.parameters.length===0&&ts.isBlock(n.body)&&n.getText().includes('setAdjust({')&&n.getText().includes('accountId: row.id'))
const preview=nodeText(source,n=>ts.isCallExpression(n)&&n.expression.getText()==='fmtMoney'&&n.getText().includes('adjust.desired')&&n.getText().includes('adjust.current'))
function field(name: string) {return nodeText(source,n=>ts.isArrowFunction(n)&&n.getText().includes(`setAdjust({ ...adjust!, ${name}:`))}
function js(text: string) {return ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText}
let env: TestEnv, oldTz: string|undefined, sender: number
let handlers: Map<string,(event:IpcMainInvokeEvent,payload:unknown)=>Promise<IpcResult<unknown>>>
const raw=()=>getRawConnection()
function snapshot() {
  const tables=raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]
  return Object.fromEntries(tables.map(({name})=>[name,raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
function fixture(zone='Africa/Tripoli') {
  process.env.TZ=zone
  const from=cash.createAccount({name:'Source',kind:'cash',openingBalanceMinor:1000000},env.ctx)
  const to=cash.createAccount({name:'Destination',kind:'cash'},env.ctx)
  const at=zone==='Africa/Tripoli'?'2026-10-01T21:59:59Z':'2026-10-02T03:59:59Z'
  for(const [amountMinor,occurredAt] of [[300000,at],[50000,at.replace('Z','.000Z')]] as const)
    cash.transfer({fromAccountId:from,toAccountId:to,amountMinor,occurredAt},env.ctx)
  return {from,to}
}
function editor(id: number, asOf?: string) {
  const row=cash.listAccounts({asOf}).find(a=>a.id===id)!
  const storage=new Map<string,string>();const sent:Array<Record<string,unknown>>=[]
  const reloads: {accounts?:ReturnType<typeof cash.listAccounts>;journal?:ReturnType<typeof cash.listTransactions>}={}
  let error: string|undefined, result: unknown
  class ApiError extends Error {}
  const context=createContext({
    row, adjust:undefined, fmtMoney:(minor:number)=>minor,
    setAdjust:(v:unknown)=>{context.adjust=v},setError:(v:string|undefined)=>{error=v},toast:{show:()=>undefined},
    localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},crypto:{randomUUID},ApiError,
    accounts:{reload:async()=>{reloads.accounts=cash.listAccounts({asOf})}},
    transactions:{reload:async()=>{reloads.journal=cash.listTransactions({accountId:id,from:asOf,to:asOf})}},
    call:async(_group:string,_method:string,payload:Record<string,unknown>)=>{
      sent.push(payload);const r=await handlers.get(C.cash.adjustBalance)!({sender:{id:sender}} as IpcMainInvokeEvent,payload)
      if(!r.ok)throw new ApiError(r.error.message);result=r.data;return r.data
    }
  })
  runInContext(js(fn(apiSource,'financialCall')+'\n'+fn(source,'submitAdjust')+`\nconst open=${open};const desired=${field('desired')};const reason=${field('reason')};`),context)
  runInContext('open()',context)
  return {
    basis:()=>context.adjust.current as number,
    desired:()=>context.adjust.desired as string,
    change:(value:string)=>runInContext(`desired({target:{value:${JSON.stringify(value)}}})`,context),
    difference:()=>runInContext(preview,context) as number,
    submit:async()=>{runInContext('reason({target:{value:"Cash count"}})',context);await runInContext('submitAdjust()',context);return error},
    sent,reloads,result:()=>result,closed:()=>context.adjust===undefined
  }
}
function adjustments(id: number) {return raw().prepare("SELECT * FROM cash_transactions WHERE account_id=? AND kind='balance_adjustment' ORDER BY id").all(id) as Array<{direction:string;amount_minor:number;occurred_at:string}>}
beforeEach(async()=>{
  oldTz=process.env.TZ;vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-04T12:00:00Z'))
  env=setupTestDatabase();sender=1;handlers=new Map();const electron=await import('electron')
  vi.spyOn(electron.ipcMain,'handle').mockImplementation(((channel:string,handler:never)=>handlers.set(channel,handler)) as never)
  const {registerIpcRouter}=await import('@main/ipc/router');registerIpcRouter()
})
afterEach(()=>{
  try {expect(raw().pragma('integrity_check')).toEqual([{integrity_check:'ok'}]);expect(raw().pragma('foreign_key_check')).toEqual([])}
  finally {env.cleanup();vi.restoreAllMocks();vi.useRealTimers();if(oldTz===undefined)delete process.env.TZ;else process.env.TZ=oldTz}
})
describe('UI-WF-02 actual adjustment UI → registered owner → migrated SQLite',()=>{
  it.each(['Africa/Tripoli','America/New_York'])('historical 1000 / live 650 uses live basis; unchanged submission has no effect in %s',async zone=>{
    const {from,to}=fixture(zone);const before=snapshot();const row=cash.listAccounts({asOf:'2026-09-30'}).find(a=>a.id===from)!
    expect(row).toMatchObject({balanceMinor:1000000,currentBalanceMinor:650000})
    const edit=editor(from,'2026-09-30');expect(edit.basis()).toBe(650000);expect(edit.desired()).toBe('650');expect(edit.difference()).toBe(0)
    expect(await edit.submit()).toMatch(/مطابق/);expect(edit.closed()).toBe(false);expect(snapshot()).toEqual(before)
    expect(adjustments(from)).toEqual([]);expect(cash.accountBalance(to)).toBe(350000)
  })
  it.each(['Africa/Tripoli','America/New_York'])('intentional +350 preview equals owner effect and keeps history pure in %s',async zone=>{
    const {from}=fixture(zone);const oldRows=raw().prepare('SELECT * FROM cash_transactions ORDER BY id').all()
    const edit=editor(from,'2026-09-30');edit.change('1000');expect(edit.difference()).toBe(350000);expect(await edit.submit()).toBeUndefined()
    expect(edit.result()).toEqual({adjustmentMinor:350000,newBalanceMinor:1000000});expect(edit.closed()).toBe(true)
    expect(adjustments(from)).toEqual([expect.objectContaining({direction:'in',amount_minor:350000,occurred_at:'2026-10-04T12:00:00.000Z'})])
    expect(edit.sent[0]?.occurredAt).toBeUndefined();expect(cash.accountBalance(from)).toBe(1000000)
    expect(edit.reloads.accounts?.find(a=>a.id===from)).toMatchObject({balanceMinor:1000000,currentBalanceMinor:1000000})
    expect(edit.reloads.journal?.items.filter(t=>t.kind==='balance_adjustment')).toEqual([])
    expect(raw().prepare('SELECT * FROM cash_transactions WHERE id<=4 ORDER BY id').all()).toEqual(oldRows)
    const state=snapshot();expect(cash.accountBalance(from,'2026-09-30')).toBe(1000000);expect(snapshot()).toEqual(state)
    expect(reconcileDatabase(raw()).findings).toEqual([])
  })
  it('current-view -350 preview, direction, refresh and retry receipt agree',async()=>{
    const id=cash.createAccount({name:'Current',kind:'cash',openingBalanceMinor:1000000},env.ctx)
    const edit=editor(id);expect(edit.basis()).toBe(1000000);edit.change('650');expect(edit.difference()).toBe(-350000)
    expect(await edit.submit()).toBeUndefined();expect(adjustments(id)).toEqual([expect.objectContaining({direction:'out',amount_minor:350000})])
    expect(edit.reloads.accounts?.find(a=>a.id===id)?.balanceMinor).toBe(650000)
    expect(edit.reloads.journal?.items.filter(t=>t.kind==='balance_adjustment')).toHaveLength(1)
    const state=snapshot();const replay=await handlers.get(C.cash.adjustBalance)!({sender:{id:1}} as IpcMainInvokeEvent,edit.sent[0])
    expect(replay.ok).toBe(true);expect(snapshot()).toEqual(state)
  })
  it('restricted IPC and direct service remain FORBIDDEN without state effects',async()=>{
    const {from}=fixture();const role=createRole({name:'Read only',permissions:['cash.view']},env.ctx)
    createUser({username:'cashreader',password:'secret123',fullName:'Reader',roleId:role},env.ctx)
    const {session}=login('cashreader','secret123',99);sender=99;const before=snapshot()
    expect(()=>cash.adjustAccountBalance({accountId:from,desiredBalanceMinor:1000000,reason:'Count'},{session})).toThrow(/صلاحية|مسموح/)
    const result=await handlers.get(C.cash.adjustBalance)!({sender:{id:99}} as IpcMainInvokeEvent,{accountId:from,desiredBalanceMinor:1000000,reason:'Count',requestKey:randomUUID()})
    expect(result).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});expect(snapshot()).toEqual(before)
  })
  it('required audit failure preserves all state; same UI retry yields one effect',async()=>{
    const {from}=fixture();const edit=editor(from,'2026-09-30');edit.change('1000');const before=snapshot()
    raw().exec("CREATE TRIGGER uiwf02_fail BEFORE INSERT ON audit_log WHEN NEW.action='cash.account.adjustBalance' BEGIN SELECT RAISE(ABORT,'forced UIWF02 audit failure'); END")
    try {expect(await edit.submit()).toBeDefined();expect(edit.closed()).toBe(false);expect(snapshot()).toEqual(before)}
    finally {raw().exec('DROP TRIGGER uiwf02_fail')}
    expect(await edit.submit()).toBeUndefined();expect(edit.sent[0]?.requestKey).toBe(edit.sent[1]?.requestKey)
    expect(adjustments(from)).toHaveLength(1);expect(cash.accountBalance(from)).toBe(1000000)
    expect(raw().prepare("SELECT count(*) AS n FROM audit_log WHERE action='cash.account.adjustBalance'").get()).toEqual({n:1})
  })
  it('historical modal explicitly labels the live/current correction',()=>{
    expect(source).toContain('الرصيد الحالي الفعلي (د.ل)')
    expect(source).toContain('حتى عند عرض تاريخ سابق')
  })
})
