import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { uiWf07Fixture, uiWf07Snapshot } from '../helpers/ui-wf07-production'
import { getRawConnection } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { hasPermission } from '@main/permissions/permission-guard'
import type { ServiceContext } from '@main/services/base/service.types'
import { getProductionOrder, correctMaterialConsumption, completeProduction, productionActualCostMinor } from '@main/services/production/production.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { reconcileDatabase } from '@main/db/reconciliation'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'

const shell = vi.hoisted(() => ({ can: (_permission: string) => false, query: (_group: string, _method: string) => ({ data: undefined as unknown, loading: false, reload: async () => undefined }) }))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: shell.can }) }))
vi.mock('@renderer/lib/useQuery', () => ({ useQuery: (group: string, method: string) => shell.query(group, method) }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: () => undefined }) }))
import { ProductionOrderPage } from '@renderer/pages/worksheets/ProductionOrderPage'

let env: TestEnv
let fixture: ReturnType<typeof uiWf07Fixture>
const frozenError = 'لا يمكن تعديل صرف أمر تصنيع مكتمل لأن تكلفة الإنتاج أصبحت تاريخية'
beforeEach(() => { env = setupTestDatabase(); fixture = uiWf07Fixture(env.ctx) })
afterEach(() => env.cleanup())
function actor(consume: boolean): ServiceContext {
  const permissions = ['worksheets.view', 'worksheets.issue', 'orders.view', 'orders.viewActualCost', 'materials.view', ...(consume ? ['inventory.consume'] : [])]
  const roleId = createRole({ name: consume ? 'Corrector' : 'Viewer', permissions }, env.ctx)
  createUser({ username: 'actor', fullName: 'Actor', password: 'secret123', roleId }, env.ctx)
  return { session: login('actor', 'secret123', 92).session }
}
function page(sheetId: number, ctx: ServiceContext) {
  shell.can = (permission) => hasPermission(ctx.session, permission)
  shell.query = (group, method) => ({ data: group === 'production' && method === 'getWorkSheet' ? getProductionOrder(sheetId) : group === 'materials' ? [{ id: fixture.materialId, name: 'UIWF07 Board', unit: 'board' }] : { lines: [] }, loading: false, reload: async () => undefined })
  return renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: ['/worksheets/' + sheetId] }, React.createElement(Routes, null, React.createElement(Route, { path: '/worksheets/:id', element: React.createElement(ProductionOrderPage) }))))
}
const editCount = (html: string) => (html.match(/aria-label="تعديل"/g) ?? []).length
function input(id: number) { return { id, materialId: fixture.materialId, physicalQtyMicro: 8000000, reason: 'UIWF07 correction' } }
async function handlers() {
  const result = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<IpcResult<unknown>>>()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { result.set(channel, handler) }) as never)
  try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
  return result
}

describe('UI-WF-07 actual worksheet page + authoritative manufacturing owners', () => {
  it.each([
    ['ready', true, 1], ['ready', false, 0],
    ['active', true, 1], ['active', false, 0],
    ['completed', true, 0], ['completed', false, 0]
  ] as const)('%s worksheet / inventory.consume=%s has %i executable correction controls', (which, consume, expected) => {
    const ctx = actor(consume)
    const before = uiWf07Snapshot()
    const html = page(fixture[which].sheetId, ctx)
    expect(editCount(html)).toBe(expected)
    expect(html).toContain('الصرف الفعلي من المخزون')
    expect(html).toContain('UIWF07 Board')
    expect(uiWf07Snapshot()).toEqual(before)
  })
  it('retains completed material history, cost and unrelated view/print controls', () => {
    const html = page(fixture.completed.sheetId, env.ctx)
    expect(editCount(html)).toBe(0)
    for (const label of ['UIWF07 Board', 'مكتمل', 'صافي الاستهلاك', 'صافي التكلفة', 'طباعة أمر التصنيع', 'PDF', 'فتح الطلب', 'رجوع']) expect(html).toContain(label)
    expect(getProductionOrder(fixture.completed.sheetId).materialLines[0]).toMatchObject({ physicalQtyMicro: 10000000, actualCostMinor: 1000000, status: 'active' })
  })
  it.each(['ready', 'active'] as const)('preserves legitimate %s correction, FIFO, cost, lineage and required audit', (which) => {
    const ctx = actor(true)
    const result = correctMaterialConsumption(input(fixture[which].lineId), ctx)
    expect(result.actualCostMinor).toBe(800000)
    expect(availableQty(fixture.materialId)).toBe(72000000)
    expect(productionActualCostMinor(fixture[which].sheetId)).toBe(800000)
    expect(orderCostBreakdown(fixture[which].orderId).materialCostMinor).toBe(800000)
    const detail = getProductionOrder(fixture[which].sheetId)
    expect(detail.sheet.status).toBe(which === 'ready' ? 'ready' : 'in_production')
    expect(detail.materialLines.find((line) => line.id === fixture[which].lineId)).toMatchObject({ status: 'reversed', replacementLineId: result.id })
    expect(getRawConnection().prepare('SELECT correction_of_line_id,physical_qty_micro FROM order_material_lines WHERE id=?').get(result.id)).toEqual({ correction_of_line_id: fixture[which].lineId, physical_qty_micro: 8000000 })
    expect(getRawConnection().prepare("SELECT count(*) AS n FROM audit_log WHERE action='orders.material.correct'").get()).toEqual({ n: 1 })
    expect(reconcileDatabase(getRawConnection()).findings).toEqual([])
  })
  it('rejects completed direct correction and preserves every table, FIFO and manufacturing cost', () => {
    const ctx = actor(true)
    const before = uiWf07Snapshot()
    expect(() => correctMaterialConsumption(input(fixture.completed.lineId), ctx)).toThrow(frozenError)
    expect(uiWf07Snapshot()).toEqual(before)
    expect(productionActualCostMinor(fixture.completed.sheetId)).toBe(1000000)
    expect(orderCostBreakdown(fixture.completed.orderId).materialCostMinor).toBe(1000000)
  })
  it('rejects missing permission before active correction without any writes', () => {
    const ctx = actor(false)
    const before = uiWf07Snapshot()
    expect(() => correctMaterialConsumption(input(fixture.active.lineId), ctx)).toThrow()
    expect(uiWf07Snapshot()).toEqual(before)
  })
  it('replaces active edit availability with read-only history when authoritative completion arrives', () => {
    const ctx = actor(true)
    expect(editCount(page(fixture.active.sheetId, ctx))).toBe(1)
    completeProduction(fixture.active.sheetId, env.ctx)
    const before = uiWf07Snapshot()
    const html = page(fixture.active.sheetId, ctx)
    expect(editCount(html)).toBe(0)
    expect(html).toContain('UIWF07 Board')
    expect(() => correctMaterialConsumption(input(fixture.active.lineId), ctx)).toThrow(frozenError)
    expect(uiWf07Snapshot()).toEqual(before)
  })
  it('registered IPC rejects completed correction from a genuinely authorized actor', async () => {
    actor(true)
    const routes = await handlers()
    const before = uiWf07Snapshot()
    const result = await routes.get(IPC_CHANNELS.production.correctMaterialConsumption)!({ sender: { id: 92 } } as IpcMainInvokeEvent, input(fixture.completed.lineId))
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: frozenError } })
    expect(uiWf07Snapshot()).toEqual(before)
  })
  it('registered IPC rejects a viewer even on an active worksheet', async () => {
    actor(false)
    const routes = await handlers()
    const before = uiWf07Snapshot()
    const result = await routes.get(IPC_CHANNELS.production.correctMaterialConsumption)!({ sender: { id: 92 } } as IpcMainInvokeEvent, input(fixture.active.lineId))
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(uiWf07Snapshot()).toEqual(before)
  })
  it('registered IPC keeps the authorized active correction owner operational', async () => {
    actor(true)
    const routes = await handlers()
    const result = await routes.get(IPC_CHANNELS.production.correctMaterialConsumption)!({ sender: { id: 92 } } as IpcMainInvokeEvent, input(fixture.active.lineId))
    expect(result).toMatchObject({ ok: true, data: { actualCostMinor: 800000 } })
    expect(productionActualCostMinor(fixture.active.sheetId)).toBe(800000)
  })
})
