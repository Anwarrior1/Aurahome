import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { businessDate } from '@shared/business-date'
import { getRawConnection } from '@main/db/connection'
import { reconcileDatabase } from '@main/db/reconciliation'
import * as cash from '@main/services/finance/cash.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

// Execute the actual CashPage handlers and field bindings. Only the React
// state/view shell is replaced; IPC guards, session, owners and SQLite are real.
const source = readFileSync('src/renderer/pages/cash/CashPage.tsx', 'utf8')
const ast = ts.createSourceFile('CashPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function sourceNode(predicate: (node: ts.Node) => boolean): string {
  let found: ts.Node | undefined
  function visit(node: ts.Node) {
    if (predicate(node)) found = node
    else ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!found) throw Error('CashPage source binding not found')
  return found.getText(ast)
}
function handler(name: string) {
  return sourceNode((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
}
function field(name: string) {
  const text = sourceNode((node) => ts.isJsxAttribute(node) && node.name.getText(ast) === 'onChange'
    && !!node.initializer && node.initializer.getText(ast).includes(`setTransfer({ ...transfer!, ${name}:`))
  return text.slice(text.indexOf('{') + 1, -1)
}
function js(text: string) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}
let env: TestEnv
let previousTz: string | undefined
let handlers: Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<IpcResult<unknown>>>
const raw = () => getRawConnection()
function snapshot() {
  const tables = raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name: string}[]
  return Object.fromEntries(tables.map(({name}) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
async function invoke(channel: string, payload: unknown) {
  const h = handlers.get(channel)
  if (!h) throw Error(`Missing registered channel: ${channel}`)
  const result = await h({sender: {id: 1}} as IpcMainInvokeEvent, payload)
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}
function fixture(at: string) {
  const from = cash.createAccount({name: 'Source', kind: 'cash', openingBalanceMinor: 1000000}, env.ctx)
  const to = cash.createAccount({name: 'Destination', kind: 'cash'}, env.ctx)
  cash.transfer({fromAccountId: from, toAccountId: to, amountMinor: 300000, occurredAt: at}, env.ctx)
  const group = cash.listTransactions({accountId: to}).items[0]!.transferGroup!
  return {from, to, group}
}
async function editor(group: string) {
  const sent: Array<Record<string, unknown>> = []
  let error: string | undefined
  class ApiError extends Error {}
  const context = createContext({
    transfer: undefined,
    setTransfer: (value: unknown) => {context.transfer = value},
    setError: (value: string | undefined) => {error = value},
    businessDate, ApiError,
    toast: {show: () => undefined},
    accounts: {reload: async () => undefined}, transactions: {reload: async () => undefined},
    call: async (domain: string, method: string, payload: Record<string, unknown>) => {
      if (method === 'updateTransfer') sent.push(payload)
      try {return await invoke(C.cash[method as keyof typeof C.cash], payload)}
      catch(e) {throw new ApiError((e as Error).message)}
    }
  })
  runInContext(js(handler('openTransferEdit') + '\n' + handler('doTransfer')
    + `\nconst dateChange = ${field('occurredAt')}; const notesChange = ${field('notes')}; const amountChange = ${field('amount')}; const accountChange = ${field('to')};`), context)
  await runInContext(`openTransferEdit({transferGroup:${JSON.stringify(group)}})`, context)
  return {
    date: () => context.transfer.occurredAt as string,
    change: (fieldName: string, value: string) => runInContext(`${fieldName}Change({target:{value:${JSON.stringify(value)}}})`, context),
    save: async () => {await runInContext('doTransfer()', context); return error}, sent
  }
}
function balances(from: number, to: number, day?: string) {
  return [cash.accountBalance(from, day), cash.accountBalance(to, day)]
}
function pair(group: string) {
  return raw().prepare('SELECT * FROM cash_transactions WHERE transfer_group=? ORDER BY direction').all(group) as Array<{id: number; occurred_at: string; amount_minor: number}>
}
beforeEach(async () => {
  previousTz = process.env.TZ
  env = setupTestDatabase()
  const electron = await import('electron')
  handlers = new Map()
  vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => handlers.set(channel, handler)) as never)
  const {registerIpcRouter} = await import('@main/ipc/router')
  registerIpcRouter()
})
afterEach(() => {
  try {
    expect(raw().pragma('integrity_check')).toEqual([{integrity_check: 'ok'}])
    expect(raw().pragma('foreign_key_check')).toEqual([])
  } finally {
    env.cleanup(); vi.restoreAllMocks()
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})
const cases = [
  ['America/New_York', '2026-10-02T03:59:59Z'],
  ['America/New_York', '2026-10-02T03:59:59.000Z'],
  ['Africa/Tripoli', '2026-10-01T21:59:59Z'],
  ['Africa/Tripoli', '2026-10-01T21:59:59.000Z'],
  ['Africa/Tripoli', '2026-09-30T22:30:00Z'],
  ['America/New_York', '2026-10-01'],
  ['America/New_York', '2026-10-02T05:59:59+02:00']
]
describe('UI-WF-01 actual transfer editor → registered IPC → migrated SQLite', () => {
  it.each(cases)('preserves untouched date and exact storage in %s for %s', async (zone, at) => {
    process.env.TZ = zone
    const {from, to, group} = fixture(at)
    cash.transfer({fromAccountId: from, toAccountId: to, amountMinor: 50000, occurredAt: zone === 'Africa/Tripoli' ? '2026-10-01T21:59:59.000Z' : '2026-10-02T03:59:59.000Z'}, env.ctx)
    expect(balances(from, to, '2026-10-01')).toEqual([650000, 350000])
    const original = pair(group)
    const edit = await editor(group)
    expect(edit.date()).toBe('2026-10-01')
    edit.change('notes', 'notes only')
    expect(await edit.save()).toBeUndefined()
    expect(edit.sent[0]?.occurredAt).toBeUndefined()
    expect(pair(group).map(r => r.occurred_at)).toEqual([at, at])
    expect(pair(group).map(r => r.id)).toEqual(original.map(r => r.id))
    expect(pair(group).map(r => r.amount_minor)).toEqual([300000, 300000])
    expect(balances(from, to)).toEqual([650000, 350000])
    expect(balances(from, to, '2026-10-01')).toEqual([650000, 350000])
    const state = snapshot()
    expect(cash.listTransactions({accountId: to, from:'2026-10-01', to:'2026-10-01'}).items).toHaveLength(2)
    expect(cash.listAccounts({asOf:'2026-10-01'}).filter(a => [from,to].includes(a.id)).map(a => a.balanceMinor)).toEqual([650000,350000])
    expect(snapshot()).toEqual(state)
    expect(reconcileDatabase(raw()).findings).toEqual([])
  })
  it.each(['America/New_York', 'Africa/Tripoli'])('applies explicit date and conserves cash in %s', async zone => {
    process.env.TZ=zone
    const at=zone==='America/New_York'?'2026-10-02T03:59:59Z':'2026-10-01T21:59:59Z'
    const {from,to,group}=fixture(at);const edit=await editor(group)
    edit.change('date','2026-10-03');expect(await edit.save()).toBeUndefined()
    expect(edit.sent[0]?.occurredAt).toBe('2026-10-03')
    expect(pair(group).map(r=>r.occurred_at)).toEqual(['2026-10-03','2026-10-03'])
    expect(balances(from,to,'2026-10-01')).toEqual([1000000,0])
    expect(balances(from,to,'2026-10-03')).toEqual([700000,300000])
    expect(balances(from,to)).toEqual([700000,300000])
  })
  it('amount and destination edits preserve the instant and grouped row identity', async () => {
    process.env.TZ='America/New_York'
    const at='2026-10-02T03:59:59Z';const {from,to,group}=fixture(at)
    const other=cash.createAccount({name:'Other',kind:'cash'},env.ctx)
    const ids=pair(group).map(r=>r.id);const edit=await editor(group)
    edit.change('amount','400');edit.change('account',String(other));expect(await edit.save()).toBeUndefined()
    expect(pair(group).map(r=>r.occurred_at)).toEqual([at,at]);expect(pair(group).map(r=>r.id)).toEqual(ids)
    expect(pair(group).map(r=>r.amount_minor)).toEqual([400000,400000])
    expect([cash.accountBalance(from,'2026-10-01'),cash.accountBalance(to),cash.accountBalance(other,'2026-10-01')]).toEqual([600000,0,400000])
  })
  it('audit failure rolls both legs back; retry applies one correction and audit', async () => {
    process.env.TZ='America/New_York'
    const at='2026-10-02T03:59:59Z';const {group}=fixture(at);const edit=await editor(group)
    edit.change('notes','retry notes');edit.change('amount','400')
    const before=snapshot()
    raw().exec("CREATE TRIGGER uiwf01_fail BEFORE INSERT ON audit_log WHEN NEW.action='cash.transfer.update' BEGIN SELECT RAISE(ABORT,'forced UIWF01 audit failure'); END")
    try {expect(await edit.save()).toBeDefined();expect(snapshot()).toEqual(before)}
    finally {raw().exec('DROP TRIGGER uiwf01_fail')}
    expect(await edit.save()).toBeUndefined()
    expect(pair(group).map(r=>r.amount_minor)).toEqual([400000,400000])
    expect(pair(group).map(r=>r.occurred_at)).toEqual([at,at])
    expect(raw().prepare("SELECT count(*) AS n FROM audit_log WHERE action='cash.transfer.update'").get()).toEqual({n:1})
  })
  it('invalid account edit is side-effect free and leaves the original instant intact', async () => {
    process.env.TZ='America/New_York';const at='2026-10-02T03:59:59Z';const {from,group}=fixture(at)
    const edit=await editor(group);edit.change('account',String(from));const before=snapshot()
    expect(await edit.save()).toBeDefined();expect(snapshot()).toEqual(before)
    expect(pair(group).map(r=>r.occurred_at)).toEqual([at,at])
  })
  it('changing the date then restoring its displayed original preserves the instant', async () => {
    process.env.TZ='America/New_York';const at='2026-10-02T03:59:59Z';const {group}=fixture(at)
    const edit=await editor(group);edit.change('date','2026-10-03');edit.change('date','2026-10-01')
    expect(await edit.save()).toBeUndefined();expect(edit.sent[0]?.occurredAt).toBeUndefined()
    expect(pair(group).map(r=>r.occurred_at)).toEqual([at,at])
  })
})
