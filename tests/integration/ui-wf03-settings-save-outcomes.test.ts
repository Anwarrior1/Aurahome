import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { basisPointsSchema, percentageSchema, safePositiveIntegerSchema } from '@shared/schemas/common.schema'
import { ApiError } from '@renderer/lib/api'
import { getRawConnection } from '@main/db/connection'
import { reconcileDatabase } from '@main/db/reconciliation'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { SETTING_KEYS as K, getAllSettings, setSetting } from '@main/services/settings.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

// Actual renderer functions and actual API envelope, with only the React state
// and Electron transport replaced. Handlers/session/domain/transactions/SQLite
// are real; native UI behavior is also exercised by the disposable Electron run.
const source = readFileSync('src/renderer/pages/settings/SettingsPage.tsx', 'utf8')
const api = readFileSync('src/renderer/lib/api.ts', 'utf8')
function declaration(text: string, name: string) {
  const ast = ts.createSourceFile('source.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: ts.FunctionDeclaration | undefined
  function visit(n: ts.Node) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n
    else ts.forEachChild(n, visit)
  }
  visit(ast)
  if (!found) throw Error(`Missing renderer function ${name}`)
  return found.getText(ast).replace(/^export /, '')
}
let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<IpcResult<unknown>>>
const raw = () => getRawConnection()
function snapshot() {
  const tables = raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  return Object.fromEntries(tables.map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
function audits() { return raw().prepare("SELECT * FROM audit_log WHERE action='settings.update' ORDER BY id").all() }
function failAudit(key?: string) {
  raw().exec(`CREATE TRIGGER uiwf03_fail BEFORE INSERT ON audit_log WHEN NEW.action='settings.update' ${key ? `AND NEW.entity_id='${key}'` : ''} BEGIN SELECT RAISE(ABORT,'forced UIWF03 audit failure'); END`)
}
function editor(sender = 1) {
  const requests: Array<{ method: string; payload: unknown; result: IpcResult<unknown> }> = []
  const successes: string[] = []
  let error: string | undefined
  let busy = false
  let readFailure = false
  const invoke = async (method: 'set' | 'getAll', payload?: unknown) => {
    if (method === 'getAll' && readFailure) throw Error('disposable transport read failure')
    const result = await handlers.get(C.settings[method])!({ sender: { id: sender } } as IpcMainInvokeEvent, payload)
    requests.push({ method, payload, result })
    return result
  }
  const context = createContext({
    KEYS: { depositPercentBp: K.depositPercentBp, quotationValidityHours: K.quotationValidityHours, companyName: K.companyName, companyPhone: K.companyPhone, companyAddress: K.companyAddress },
    basisPointsSchema, percentageSchema, safePositiveIntegerSchema, ApiError,
    draft: {}, savingGeneral: false,
    setError: (value: string | undefined) => { error = value },
    setSavingGeneral: (value: boolean) => { context.savingGeneral = value; busy = value },
    setDraft: (value: unknown) => { context.draft = value },
    toast: { show: (message: string) => successes.push(message) },
    window: { erp: { settings: { set: (p: unknown) => invoke('set', p), getAll: () => invoke('getAll') } } }
  })
  const js = ts.transpileModule([declaration(source, 'generalDraft'), declaration(source, 'saveGeneral'), declaration(api, 'call')].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  runInContext(js, context)
  context.draft = runInContext(`generalDraft(${JSON.stringify(getAllSettings())})`, context)
  return {
    change: (values: Record<string, string>) => { context.draft = { ...context.draft, ...values } },
    save: () => runInContext('saveGeneral()', context) as Promise<void>,
    draft: () => context.draft as Record<string, string>, error: () => error, busy: () => busy,
    failRead: () => { readFailure = true }, requests, successes
  }
}
const requested = { depositPercent: '40', validityHours: '72', companyName: 'Changed company', companyPhone: '0303', companyAddress: 'Changed address' }
beforeEach(async () => {
  env = setupTestDatabase()
  for (const [key, value] of [[K.depositPercentBp, 6000], [K.quotationValidityHours, 48], [K.companyName, 'Original company'], [K.companyPhone, 'Original phone'], [K.companyAddress, 'Original address']] as const) setSetting(key, value, env.ctx)
  handlers = new Map()
  const electron = await import('electron')
  vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => handlers.set(channel, handler)) as never)
  const { registerIpcRouter } = await import('@main/ipc/router'); registerIpcRouter()
})
afterEach(() => {
  try {
    raw().exec('DROP TRIGGER IF EXISTS uiwf03_fail')
    expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(raw().pragma('foreign_key_check')).toEqual([])
    expect(reconcileDatabase(raw()).findings).toEqual([])
  } finally { env.cleanup(); vi.restoreAllMocks() }
})
describe('UI-WF-03 actual Save all → registered settings owners → migrated SQLite', () => {
  it('invalid hours 0 prevents the original 60→40 partial save; correction retries once', async () => {
    const ui = editor(); ui.change({ ...requested, validityHours: '0' }); const before = snapshot()
    await ui.save()
    expect(ui.error()).toMatch(/صلاحية.*موجب/); expect(ui.requests).toEqual([])
    expect(snapshot()).toEqual(before); expect(ui.successes).toEqual([])
    ui.change({ validityHours: '72' }); await ui.save()
    expect(ui.error()).toBeUndefined(); expect(ui.successes).toEqual(['تم حفظ الإعدادات'])
    expect(ui.requests.filter(r => r.method === 'set')).toHaveLength(5)
    expect(ui.requests.filter(r => r.method === 'getAll')).toHaveLength(1)
    expect(audits()).toHaveLength(10); expect(ui.draft()).toEqual(requested)
    expect(getAllSettings()).toMatchObject({ [K.depositPercentBp]: 4000, [K.quotationValidityHours]: 72, [K.companyName]: requested.companyName, [K.companyPhone]: requested.companyPhone, [K.companyAddress]: requested.companyAddress })
  })
  it('valid inputs settle all five calls before authoritative refresh and complete success', async () => {
    const ui = editor(); ui.change(requested); await ui.save()
    expect(ui.requests.map(r => r.method)).toEqual(['set', 'set', 'set', 'set', 'set', 'getAll'])
    expect(ui.requests.every(r => r.result.ok)).toBe(true); expect(ui.error()).toBeUndefined()
    expect(ui.successes).toHaveLength(1); expect(ui.draft()).toEqual(requested); expect(ui.busy()).toBe(false)
  })
  it('phone audit failure rolls back only that owner; partial refresh and retry stay truthful', async () => {
    const ui = editor(); ui.change(requested); const beforeAudits = audits().length
    failAudit(K.companyPhone); await ui.save()
    expect(getAllSettings()).toMatchObject({ [K.depositPercentBp]: 4000, [K.companyPhone]: 'Original phone', [K.companyName]: requested.companyName })
    expect(audits()).toHaveLength(beforeAudits + 4); expect(ui.error()).toMatch(/بعض الإعدادات فقط/)
    expect(ui.error()).toContain('هاتف الشركة'); expect(ui.successes).toEqual([])
    expect(ui.requests.at(-1)?.method).toBe('getAll'); expect(ui.draft()).toEqual(requested)
    expect(ui.requests.filter(r => r.method === 'set')).toHaveLength(5) // no compensation
    raw().exec('DROP TRIGGER uiwf03_fail'); await ui.save()
    expect(getAllSettings()[K.companyPhone]).toBe('0303'); expect(ui.error()).toBeUndefined()
    expect(ui.requests.filter(r => r.method === 'set')).toHaveLength(10)
    expect(audits()).toHaveLength(beforeAudits + 9) // legitimate same-value sets remain real audited writes
    expect(ui.successes).toHaveLength(1)
  })
  it('all required audits failing leave every table unchanged, with no false partial/success', async () => {
    const ui = editor(); ui.change(requested); const before = snapshot(); failAudit(); await ui.save()
    expect(snapshot()).toEqual(before); expect(ui.error()).toMatch(/لم يتأكد حفظ أي إعداد/)
    expect(ui.error()).not.toContain('بعض الإعدادات'); expect(ui.successes).toEqual([])
    expect(ui.requests.filter(r => r.method === 'getAll')).toHaveLength(1); expect(ui.busy()).toBe(false)
  })
  it('real settings.view-only user is denied at registered and direct boundaries without mutation', async () => {
    const role = createRole({ name: 'Settings reader', permissions: ['settings.view'] }, env.ctx)
    createUser({ username: 'reader', password: 'secret123', fullName: 'Reader', roleId: role }, env.ctx)
    const { session } = login('reader', 'secret123', 99)
    const ui = editor(99); ui.change(requested); const before = snapshot(); await ui.save()
    expect(ui.requests.filter(r => r.method === 'set').every(r => !r.result.ok && r.result.error.code === 'FORBIDDEN')).toBe(true)
    expect(() => setSetting(K.depositPercentBp, 4000, { session })).toThrow()
    expect(snapshot()).toEqual(before); expect(ui.successes).toEqual([]); expect(ui.error()).toMatch(/لم يتأكد حفظ أي إعداد/)
  })
  it('refresh failure preserves the actual partial outcome without inventing rollback', async () => {
    const ui = editor(); ui.change(requested); failAudit(K.companyPhone); ui.failRead(); await ui.save()
    expect(ui.error()).toMatch(/بعض الإعدادات فقط.*تعذر إعادة تحميل/)
    expect(getAllSettings()[K.depositPercentBp]).toBe(4000); expect(ui.successes).toEqual([]); expect(ui.busy()).toBe(false)
  })
  it('empty company name is rejected before all writes; optional text remains valid', async () => {
    const ui = editor(); ui.change({ ...requested, companyName: '' }); const before = snapshot(); await ui.save()
    expect(ui.error()).toBe('اسم الشركة مطلوب'); expect(ui.requests).toEqual([]); expect(snapshot()).toEqual(before)
    ui.change({ companyName: 'Valid', companyPhone: '', companyAddress: '' }); await ui.save()
    expect(getAllSettings()[K.companyPhone]).toBe(''); expect(ui.successes).toHaveLength(1)
  })
  it.each(['0', '0.01', '99.99', '100'])('accepts deposit boundary %s using existing basis-point conversion', async percent => {
    const ui = editor(); ui.change({ depositPercent: percent }); await ui.save()
    expect(getAllSettings()[K.depositPercentBp]).toBe(Math.round(Number(percent) * 100)); expect(ui.successes).toHaveLength(1)
  })
  it.each(['-1', '100.01', 'NaN', 'Infinity', ''])('rejects deposit %s before sibling writes', async percent => {
    const ui = editor(); ui.change({ ...requested, depositPercent: percent }); const before = snapshot(); await ui.save()
    expect(ui.error()).toMatch(/الدفعة المقدمة/); expect(ui.requests).toEqual([]); expect(snapshot()).toEqual(before)
  })
  it.each(['1', '48', String(Number.MAX_SAFE_INTEGER)])('accepts existing positive safe validity %s without inventing a ceiling', async hours => {
    const ui = editor(); ui.change({ validityHours: hours }); await ui.save()
    expect(getAllSettings()[K.quotationValidityHours]).toBe(Number(hours)); expect(ui.successes).toHaveLength(1)
  })
  it.each(['0', '-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1), 'NaN', 'Infinity', ''])('rejects validity %s before sibling writes', async hours => {
    const ui = editor(); ui.change({ ...requested, validityHours: hours }); const before = snapshot(); await ui.save()
    expect(ui.error()).toMatch(/صلاحية/); expect(ui.requests).toEqual([]); expect(snapshot()).toEqual(before)
  })
})
