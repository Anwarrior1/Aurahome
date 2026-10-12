import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { reconcileDatabase } from '@main/db/reconciliation'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

const output = vi.hoisted(() => ({ html: [] as string[] }))
vi.mock('@main/services/documents/print.service', async (original) => ({
  ...(await original<typeof import('@main/services/documents/print.service')>()),
  printHtml: vi.fn(async (html: string) => {
    output.html.push(html)
  }),
  exportPdf: vi.fn(async (html: string) => {
    output.html.push(html)
    return { path: 'fictional.pdf' }
  })
}))
let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>>
const owner = { sender: { id: 78101 } } as IpcMainInvokeEvent
const restricted = { sender: { id: 78102 } } as IpcMainInvokeEvent
const other = { sender: { id: 78103 } } as IpcMainInvokeEvent
beforeAll(async () => {
  env = setupTestDatabase()
  for (let i = 0; i < 101; i++)
    createCustomer({ name: `PERF ${String(i).padStart(3, '0')}` }, env.ctx)
  const roleId = createRole(
    { name: 'PERF report reader', permissions: [P.reports.view, P.customers.view] },
    env.ctx
  )
  createUser(
    { username: 'perf-report-reader', fullName: 'Fictional reader', password: 'secret123', roleId },
    env.ctx
  )
  const otherRole = createRole(
    { name: 'PERF nonreport reader', permissions: [P.customers.view] },
    env.ctx
  )
  createUser(
    {
      username: 'perf-other',
      fullName: 'Fictional other',
      password: 'secret123',
      roleId: otherRole
    },
    env.ctx
  )
  login('owner', 'secret123', owner.sender.id)
  login('perf-report-reader', 'secret123', restricted.sender.id)
  login('perf-other', 'secret123', other.sender.id)
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi
    .spyOn(electron.ipcMain, 'handle')
    .mockImplementation(((channel: string, handler: never) =>
      handlers.set(channel, handler)) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})
afterAll(() => env.cleanup())
function call(channel: string, payload: unknown, event = owner) {
  return handlers.get(channel)!(event, payload)
}
function snapshot(): string {
  const db = getRawConnection()
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[]
  return JSON.stringify(
    tables.map(({ name }) => [
      name,
      db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()
    ])
  )
}
describe('PERF-01 registered report contracts remain complete and read-only', () => {
  it('preserves all 101 authoritative customer rows, exact order/values/totals, print and PDF beyond a visible page', async () => {
    const before = snapshot()
    const result = (await call(C.reports.build, { key: 'customer_balances' })) as {
      ok: true
      data: { rows: Record<string, string>[]; columns: string[]; totals: Record<string, string> }
    }
    expect(result.ok).toBe(true)
    expect(result.data.rows).toHaveLength(101)
    const names = result.data.rows.map((row) => row[result.data.columns[0]!])
    expect(names).toEqual(
      Array.from({ length: 101 }, (_, i) => `PERF ${String(i).padStart(3, '0')}`)
    )
    expect(result.data.columns).toEqual([
      'العميل',
      'الهاتف',
      'عدد الطلبات',
      'الإجمالي',
      'المدفوع',
      'المتبقي'
    ])
    for (const row of result.data.rows) {
      expect(row['الهاتف']).toBe('')
      expect(row['عدد الطلبات']).toBe('0')
      for (const column of ['الإجمالي', 'المدفوع', 'المتبقي']) expect(row[column]).toBe('0,00 د.ل')
    }
    expect(Object.values(result.data.totals)).toEqual(['0,00 د.ل'])
    output.html = []
    for (const channel of [C.documents.printReport, C.documents.exportReportPdf])
      expect(await call(channel, { key: 'customer_balances' })).toMatchObject({ ok: true })
    expect(output.html).toHaveLength(2)
    for (const html of output.html) {
      const tbody = html.split('<tbody>')[1]!.split('</tbody>')[0]!
      expect((tbody.match(/<tr>/g) ?? []).length).toBe(101)
      for (const name of names) expect(tbody).toContain(name)
      expect(tbody.indexOf(names[0]!)).toBeLessThan(tbody.indexOf(names[100]!))
    }
    expect(snapshot()).toBe(before)
    expect(reconcileDatabase(getRawConnection())).toMatchObject({
      checksRun: 73,
      errorCount: 0,
      warningCount: 0,
      findings: []
    })
  })
  it('keeps report-specific confidentiality, authentication and export permission checks in registered main handlers', async () => {
    const before = snapshot()
    expect(await call(C.reports.build, { key: 'customer_balances' }, restricted)).toMatchObject({
      ok: true
    })
    expect(await call(C.reports.build, { key: 'worker_balances' }, restricted)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' }
    })
    for (const channel of [C.documents.printReport, C.documents.exportReportPdf])
      expect(await call(channel, { key: 'customer_balances' }, restricted)).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' }
      })
    expect(await call(C.reports.build, { key: 'customer_balances' }, other)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' }
    })
    expect(
      await call(C.reports.build, { key: 'customer_balances' }, {
        sender: { id: 999999 }
      } as IpcMainInvokeEvent)
    ).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
    expect(snapshot()).toBe(before)
  })
})
