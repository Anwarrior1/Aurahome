import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment, reverseCustomerPayment } from '@main/services/sales/orders.service'
import { issueWorkSheet, startProduction, cancelProductionOrder, getWorkSheetOrThrow, productionActualCostMinor } from '@main/services/production/production.service'
import { recordWaste, availableQty } from '@main/services/inventory/inventory.service'
import { createMachine, addMachineUsage, updateMachineUsage, removeMachineUsage } from '@main/services/production/machines.service'
import { savePlannedMaterials, savePlannedMachines, savePlannedWorkers, savePlannedOrderExpenses } from '@main/services/planning/planning.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
let material: number
const raw = () => getRawConnection()
function snapshot() {
  const tables = raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  return Object.fromEntries(tables.map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
}
function auditCount(action: string) { return (raw().prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action=?').get(action) as { n: number }).n }
function inject(action: string) {
  raw().exec(`CREATE TRIGGER new08_fail BEFORE INSERT ON audit_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT, 'NEW08 required audit failure'); END;`)
}
function rollbackThenRetry(action: string, command: () => unknown) {
  const before = snapshot(); const count = auditCount(action)
  inject(action)
  try { expect(command).toThrow(/NEW08 required audit failure/); expect(snapshot()).toEqual(before) }
  finally { raw().exec('DROP TRIGGER new08_fail') }
  const result = command()
  expect(auditCount(action)).toBe(count + 1)
  return result
}
function manufacturing() {
  const invoice = createFinalInvoice({ customerId: createCustomer({ name: 'Customer' }, env.ctx), depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'Cabinet', quantityMicro: q(1), unitPriceMinor: m(10000) }] }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
  return { order: order.id, sheet: sheet.id }
}
function machine() { return createMachine({ name: 'Saw', costingUnit: 'hour', defaultRateMicro: c(100) }, env.ctx) }
function plan(f: ReturnType<typeof manufacturing>, kind: string) {
  if (kind === 'materials') return () => savePlannedMaterials({ orderId: f.order }, [{ materialId: material, materialName: 'Board', qtyMicro: q(4), estimatedUnitCostMicro: c(100) }], env.ctx)
  if (kind === 'worksheet materials') return () => savePlannedMaterials({ workSheetId: f.sheet }, [{ materialId: material, materialName: 'Board', qtyMicro: q(4), estimatedUnitCostMicro: c(100) }], env.ctx)
  if (kind === 'machines') { const id = machine(); return () => savePlannedMachines({ orderId: f.order }, [{ machineId: id, machineName: 'Saw', usageQtyMicro: q(2) }], env.ctx) }
  if (kind === 'workers') return () => savePlannedWorkers({ orderId: f.order }, [{ workerName: 'Worker', estimatedCostMinor: m(200) }], env.ctx)
  return () => savePlannedOrderExpenses(f.order, [{ expenseName: 'Preparation', amountMinor: m(50) }], env.ctx)
}
beforeEach(() => {
  env = setupTestDatabase()
  material = createMaterial({ sku: 'BOARD', name: 'Board', unit: 'board', pricingRule: 'exact', categoryId: createCategory({ name: 'Boards' }, env.ctx), currentMarketPriceMicro: c(100) }, env.ctx)
  createPurchase({ supplierId: createSupplier({ name: 'Supplier' }, env.ctx), lines: [{ materialId: material, qtyMicro: q(100), unitCostMicro: c(100) }] }, env.ctx)
})
afterEach(() => {
  try { expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); expect(raw().pragma('foreign_key_check')).toEqual([]) }
  finally { env.cleanup() }
})

describe('NEW-BL-08 required audit shares business transaction', () => {
  it('waste failure and retry is 100 → 100 → 97, preserving FIFO and all business tables on failure', () => {
    rollbackThenRetry('inventory.waste', () => recordWaste({ materialId: material, qtyMicro: q(3), reason: 'Broken boards', ctx: env.ctx }))
    expect(availableQty(material)).toBe(q(97))
    expect(raw().prepare("SELECT qty_micro, actual_cost_minor FROM inventory_movements WHERE kind='waste'").all()).toEqual([{ qty_micro: q(3), actual_cost_minor: m(300) }])
    expect(raw().prepare('SELECT SUM(qty_remaining_micro) AS qty FROM fifo_layers').get()).toEqual({ qty: q(97) })
  })
  it('failed actual start preserves pre-start reversal eligibility; only successful start crosses that boundary', () => {
    const f = manufacturing()
    recordPayment({ orderId: f.order, amountMinor: m(7000) }, env.ctx)
    const payment = (raw().prepare('SELECT id FROM customer_payments WHERE order_id=?').get(f.order) as { id: number }).id
    function preStartEligible() {
      const before = snapshot()
      expect(() => withTransaction(() => { reverseCustomerPayment(payment, env.ctx); throw new Error('probe rollback') })).toThrow('probe rollback')
      expect(snapshot()).toEqual(before)
    }
    preStartEligible()
    const before = snapshot(); inject('worksheets.start')
    try { expect(() => startProduction(f.sheet, env.ctx)).toThrow(/NEW08 required audit failure/); expect(snapshot()).toEqual(before); expect(getWorkSheetOrThrow(f.sheet)).toMatchObject({ status: 'ready', startedAt: null }) }
    finally { raw().exec('DROP TRIGGER new08_fail') }
    preStartEligible()
    startProduction(f.sheet, env.ctx)
    expect(getWorkSheetOrThrow(f.sheet)).toMatchObject({ status: 'in_production', startedAt: expect.any(String) })
    expect(auditCount('worksheets.start')).toBe(1)
    const started = snapshot()
    expect(() => withTransaction(() => reverseCustomerPayment(payment, env.ctx))).toThrowError(expect.objectContaining({ code: 'CONFLICT' }))
    expect(() => startProduction(f.sheet, env.ctx)).toThrow(); expect(snapshot()).toEqual(started)
  })
  it('rolls back eligible manufacturing cancellation and commits only the successful retry', () => {
    const f = manufacturing()
    rollbackThenRetry('worksheets.cancel', () => cancelProductionOrder({ id: f.sheet, reason: 'Replan' }, env.ctx))
    expect(getWorkSheetOrThrow(f.sheet)).toMatchObject({ status: 'cancelled', cancelledAt: expect.any(String), cancelReason: 'Replan' })
    const after = snapshot(); expect(() => cancelProductionOrder({ id: f.sheet, reason: 'Replan' }, env.ctx)).toThrow(); expect(snapshot()).toEqual(after)
  })
  it.each([
    ['materials', 'orders.plannedMaterials.update'], ['worksheet materials', 'production.plannedMaterials.update'],
    ['machines', 'orders.plannedMachines.update'], ['workers', 'orders.plannedWorkers.update'], ['expenses', 'orders.plannedExpenses.update']
  ])('rolls back replace-all %s planning and estimate before one successful retry', (kind, action) => {
    const f = manufacturing(); const command = plan(f, kind)
    command() // Existing rows must be restored too, not just a failed first insertion.
    rollbackThenRetry(action, command)
    const table = kind.includes('materials') ? 'planned_materials' : kind === 'machines' ? 'planned_machines' : kind === 'workers' ? 'planned_workers' : 'planned_order_expenses'
    expect(raw().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 })
    expect(availableQty(material)).toBe(q(100))
  })
  it('machine addition rolls back actual cost; normal retry adds once at the existing usage × rate cost', () => {
    const f = manufacturing(); const id = machine()
    rollbackThenRetry('orders.machine.add', () => addMachineUsage({ workSheetId: f.sheet, machineId: id, usageQtyMicro: q(2) }, env.ctx))
    expect(productionActualCostMinor(f.sheet)).toBe(m(200))
    expect(raw().prepare('SELECT COUNT(*) AS n FROM order_machine_usage').get()).toEqual({ n: 1 })
  })
  it.each(['update', 'remove'])('machine %s failure preserves usage/cost and normal retry commits once', kind => {
    const f = manufacturing(); const usage = addMachineUsage({ workSheetId: f.sheet, machineId: machine(), usageQtyMicro: q(2) }, env.ctx)
    rollbackThenRetry(`orders.machine.${kind}`, () => kind === 'update' ? updateMachineUsage(usage.id, { usageQtyMicro: q(3) }, env.ctx) : removeMachineUsage(usage.id, env.ctx))
    expect(productionActualCostMinor(f.sheet)).toBe(kind === 'update' ? m(300) : 0)
  })
  it('nested owning transactions roll back waste and audit together without early inner commits', () => {
    const before = snapshot()
    expect(() => withTransaction(() => { recordWaste({ materialId: material, qtyMicro: q(3), reason: 'Broken', ctx: env.ctx }); throw new Error('outer failure') })).toThrow('outer failure')
    expect(snapshot()).toEqual(before)
  })

  it.each(['waste', 'start', 'cancel', 'materials', 'worksheet materials', 'machines', 'workers', 'expenses'])('registered IPC %s keeps permission and required-audit rollback below IPC', async kind => {
    const f = manufacturing()
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
    const role = createRole({ name: 'Restricted', permissions: [] }, env.ctx)
    createUser({ username: 'restricted', password: 'secret123', fullName: 'Restricted', roleId: role }, env.ctx); login('restricted', 'secret123', 92)
    let channel: string; let action: string; let input: unknown
    if (kind === 'waste') { channel = C.inventory.waste; action = 'inventory.waste'; input = { materialId: material, qtyMicro: q(3), reason: 'Broken' } }
    else if (kind === 'start') { channel = C.production.startProduction; action = 'worksheets.start'; input = { id: f.sheet } }
    else if (kind === 'cancel') { channel = C.production.cancelProduction; action = 'worksheets.cancel'; input = { id: f.sheet, reason: 'Replan' } }
    else if (kind === 'materials' || kind === 'worksheet materials') {
      channel = kind === 'materials' ? C.orders.savePlannedMaterials : C.production.updatePlannedMaterials
      action = kind === 'materials' ? 'orders.plannedMaterials.update' : 'production.plannedMaterials.update'
      input = { ...(kind === 'materials' ? { orderId: f.order } : { workSheetId: f.sheet }), lines: [{ materialId: material, materialName: 'Board', qtyMicro: q(4) }] }
    } else if (kind === 'machines') { channel = C.orders.savePlannedMachines; action = 'orders.plannedMachines.update'; input = { orderId: f.order, lines: [{ machineId: machine(), machineName: 'Saw', usageQtyMicro: q(2) }] } }
    else if (kind === 'workers') { channel = C.orders.savePlannedWorkers; action = 'orders.plannedWorkers.update'; input = { orderId: f.order, lines: [{ workerName: 'Worker', estimatedCostMinor: m(200) }] } }
    else { channel = C.orders.savePlannedExpenses; action = 'orders.plannedExpenses.update'; input = { orderId: f.order, lines: [{ expenseName: 'Prep', amountMinor: m(50) }] } }
    const invoke = (windowId: number) => handlers.get(channel)!({ sender: { id: windowId } } as IpcMainInvokeEvent, input)
    const before = snapshot(); const count = auditCount(action)
    expect(await invoke(92)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } }); expect(snapshot()).toEqual(before)
    inject(action)
    try { expect(await invoke(1)).toMatchObject({ ok: false }); expect(snapshot()).toEqual(before) }
    finally { raw().exec('DROP TRIGGER new08_fail') }
    expect(await invoke(1)).toMatchObject({ ok: true }); expect(auditCount(action)).toBe(count + 1)
    expect(handlers.has('machines:addUsage')).toBe(false)
  })
})
