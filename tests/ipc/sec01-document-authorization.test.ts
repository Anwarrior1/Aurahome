import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { sec01Documents } from '../helpers/sec01-documents'
import { getRawConnection } from '@main/db/connection'
import { createRole, createUser, updateRole, updateUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import * as printing from '@main/services/documents/print.service'
import * as builders from '@main/services/documents/documents.service'
import type { ServiceContext } from '@main/services/base/service.types'

const matrix = [
  ['preliminary_invoice', P.quotations.view],
  ['final_invoice', P.finalInvoices.view],
  ['work_sheet', P.worksheets.view],
  ['installation_release', P.releases.view],
  ['delivery_release', P.releases.view]
] as const
const outputs = [C.documents.preview, C.documents.print, C.documents.exportPdf]
let env: TestEnv
let fixture: ReturnType<typeof sec01Documents>
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 72000
let event: IpcMainInvokeEvent
let outputSpies: ReturnType<typeof vi.spyOn>[]
beforeEach(async () => {
  env = setupTestDatabase()
  fixture = sec01Documents(env.ctx)
  event = { sender: { id: ++windowId } } as IpcMainInvokeEvent
  handlers = new Map()
  const electron = await import('electron')
  const registration = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  registration.mockRestore()
  // Only native output is substituted here; sessions, schemas, owners, DTOs and SQLite are real.
  outputSpies = [
    vi.spyOn(printing, 'printHtml').mockResolvedValue(undefined),
    vi.spyOn(printing, 'printFinalInvoice').mockResolvedValue({ method: 'printer' }),
    vi.spyOn(printing, 'exportPdf').mockResolvedValue({ path: '/disposable/document.pdf' })
  ]
})
afterEach(() => { vi.restoreAllMocks(); env.cleanup() })
function call(channel: string, request: unknown) { return handlers.get(channel)!(event, request) }
function actor(permissions: string[]) {
  const roleId = createRole({ name: `SEC01 ${windowId}`, permissions }, env.ctx)
  const userId = createUser({ username: `sec01-${windowId}`, password: 'secret123', fullName: 'SEC01 viewer', roleId }, env.ctx)
  const { session } = login(`sec01-${windowId}`, 'secret123', windowId)
  return { roleId, userId, ctx: { session } as ServiceContext }
}
function snapshot() {
  const db = getRawConnection()
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => {
    const name = (row as { name: string }).name
    return [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]
  })
}
async function denial(channel: string, request: unknown, code = 'FORBIDDEN') {
  const before = snapshot()
  const result = await call(channel, request)
  expect(result).toEqual({ ok: false, error: { code, message: expect.any(String) } })
  expect(JSON.stringify(result)).not.toContain('SEC01 private')
  expect(snapshot()).toEqual(before)
  for (const spy of outputSpies) expect(spy).not.toHaveBeenCalled()
}

describe('SEC-01 authoritative document output permission matrix', () => {
  it('unauthenticated callers cannot use any output operation', async () => {
    for (const channel of outputs) await denial(channel, { kind: 'final_invoice', id: fixture.documents.final_invoice }, 'UNAUTHENTICATED')
  })
  for (const [kind, permission] of matrix) {
    for (const channel of outputs) {
      it(`zero-permission ${kind} ${channel} denies before DTO/output and makes no SQLite mutation`, async () => {
        actor([])
        const company = vi.spyOn(builders, 'companyBlock')
        await denial(channel, { kind, id: fixture.documents[kind], session: env.ctx.session, isAdmin: true })
        expect(company).not.toHaveBeenCalled()
      })
    }
    it(`${kind} accepts exactly its existing ${permission} capability for all outputs`, async () => {
      const { ctx } = actor([permission])
      const before = snapshot()
      expect(printing.renderDocumentHtml(kind, fixture.documents[kind], ctx).html).toContain('SEC01 fictional customer')
      for (const channel of outputs) {
        const result = await call(channel, { kind, id: fixture.documents[kind] })
        expect(result.ok).toBe(true)
        if (result.ok && channel === C.documents.preview) {
          const html = (result.data as { html: string }).html
          expect(html).toContain('SEC01 fictional customer')
          expect(html).not.toContain('fifo')
          if (kind === 'work_sheet') { expect(html).not.toContain('د.ل'); expect(html).not.toContain('تكلفة') }
        }
      }
      expect(outputSpies[2]).toHaveBeenCalledOnce()
      expect(kind === 'final_invoice' ? outputSpies[1] : outputSpies[0]).toHaveBeenCalledOnce()
      expect(snapshot()).toEqual(before)
    })
    it(`${kind} rejects direct output-owner calls with a real restricted actor before any data retrieval`, () => {
      const { ctx } = actor([])
      const company = vi.spyOn(builders, 'companyBlock')
      const before = snapshot()
      expect(() => printing.renderDocumentHtml(kind, fixture.documents[kind], ctx)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
      expect(company).not.toHaveBeenCalled()
      expect(snapshot()).toEqual(before)
    })
  }
  it('unrelated inventory read authority grants none of the five document kinds', async () => {
    actor([P.inventory.view])
    for (const [kind] of matrix) for (const channel of outputs) await denial(channel, { kind, id: fixture.documents[kind] })
  })
  it('quotation-only authority does not grant final invoices or worksheets', async () => {
    actor([P.quotations.view])
    expect((await call(C.documents.preview, { kind: 'preliminary_invoice', id: fixture.documents.preliminary_invoice })).ok).toBe(true)
    for (const kind of ['final_invoice', 'work_sheet'] as const) for (const channel of outputs) await denial(channel, { kind, id: fixture.documents[kind] })
  })
  it('final-invoice-only authority does not grant quotations or worksheets', async () => {
    actor([P.finalInvoices.view])
    expect((await call(C.documents.preview, { kind: 'final_invoice', id: fixture.documents.final_invoice })).ok).toBe(true)
    for (const kind of ['preliminary_invoice', 'work_sheet'] as const) for (const channel of outputs) await denial(channel, { kind, id: fixture.documents[kind] })
  })
  it('worksheet staff require no financial cost permission and cannot access invoices', async () => {
    actor([P.worksheets.view])
    expect((await call(C.documents.preview, { kind: 'work_sheet', id: fixture.documents.work_sheet })).ok).toBe(true)
    await denial(C.documents.preview, { kind: 'final_invoice', id: fixture.documents.final_invoice })
  })
  it('existing legacy orders.view continues to grant final-invoice read, without granting quotations', async () => {
    actor([P.orders.view])
    expect((await call(C.documents.preview, { kind: 'final_invoice', id: fixture.documents.final_invoice })).ok).toBe(true)
    await denial(C.documents.preview, { kind: 'preliminary_invoice', id: fixture.documents.preliminary_invoice })
  })
  it('ordinary reads and guessed, absent, negative and substituted IDs cannot bypass missing read authority', async () => {
    actor([])
    await denial(C.finalInvoices.get, { id: fixture.documents.final_invoice })
    await denial(C.orders.get, { id: fixture.orderId })
    expect(fixture.documents.delivery_release).not.toBe(fixture.documents.final_invoice)
    for (const id of [fixture.documents.final_invoice, fixture.documents.delivery_release, 999999, -1, 0]) {
      for (const channel of outputs) await denial(channel, { kind: 'final_invoice', id })
    }
  })
  it('malformed IDs and unknown kinds retain validation errors and create no output', async () => {
    actor([])
    for (const request of [{ kind: 'unknown', id: 1 }, { kind: 'final_invoice', id: '1' }, { kind: 'final_invoice', id: 1.5 }, { kind: 'final_invoice', id: Number.MAX_SAFE_INTEGER + 1 }]) {
      for (const channel of outputs) await denial(channel, request, 'VALIDATION_ERROR')
    }
    const company = vi.spyOn(builders, 'companyBlock')
    expect(() => printing.renderDocumentHtml('unknown' as printing.DocumentKind, 1, env.ctx)).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
    expect(company).not.toHaveBeenCalled()
  })
  it('authorized absent records retain NOT_FOUND, without output', async () => {
    actor([P.finalInvoices.view])
    for (const channel of outputs) await denial(channel, { kind: 'final_invoice', id: 999999 }, 'NOT_FOUND')
  })
  it('role permission revocation ends the old session; reauthentication reads the reduced authority', async () => {
    const { roleId } = actor([P.finalInvoices.view])
    expect((await call(C.documents.preview, { kind: 'final_invoice', id: fixture.documents.final_invoice })).ok).toBe(true)
    updateRole(roleId, { permissions: [] }, env.ctx)
    for (const channel of outputs) await denial(channel, { kind: 'final_invoice', id: fixture.documents.final_invoice }, 'UNAUTHENTICATED')
    login(`sec01-${windowId}`, 'secret123', windowId)
    for (const channel of outputs) await denial(channel, { kind: 'final_invoice', id: fixture.documents.final_invoice })
  })
  it('disabled users cannot retain a live document session or sign in again', async () => {
    const { userId } = actor([P.finalInvoices.view])
    updateUser(userId, { active: false }, env.ctx)
    for (const channel of outputs) await denial(channel, { kind: 'final_invoice', id: fixture.documents.final_invoice }, 'UNAUTHENTICATED')
    expect(() => login(`sec01-${windowId}`, 'secret123', windowId)).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }))
  })
  it('changing a user to a restricted role invalidates its old authority', async () => {
    const { userId } = actor([P.finalInvoices.view])
    const roleId = createRole({ name: 'SEC01 replacement', permissions: [] }, env.ctx)
    updateUser(userId, { roleId }, env.ctx)
    for (const channel of outputs) await denial(channel, { kind: 'final_invoice', id: fixture.documents.final_invoice }, 'UNAUTHENTICATED')
    login(`sec01-${windowId}`, 'secret123', windowId)
    await denial(C.documents.preview, { kind: 'final_invoice', id: fixture.documents.final_invoice })
  })
})
