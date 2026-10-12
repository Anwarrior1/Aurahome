import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import {
  savePlannedMaterials, savePlannedMachines, savePlannedWorkers, savePlannedOrderExpenses, orderPlanningSnapshot
} from '@main/services/planning/planning.service'
import {
  issueWorkSheet, startProduction, completeProduction, getProductionOrder, reverseWorkSheet
} from '@main/services/production/production.service'
import { createMachine } from '@main/services/production/machines.service'
import { createWorker } from '@main/services/production/workers.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

const STARTED = /بعد بدء التصنيع/
const LOCKED = /تجهيز الإنتاج مغلق بعد إنهاء التصنيع/

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 30100
let event: IpcMainInvokeEvent
beforeEach(async () => {
  env = setupTestDatabase()
  event = { sender: { id: ++windowId } } as IpcMainInvokeEvent
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})
afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})

function database() {
  const raw = getRawConnection()
  return (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
}
function authenticate(permissions: string[]) {
  const roleId = createRole({ name: 'CC01 role', permissions }, env.ctx)
  createUser({ username: 'cc01-user', fullName: 'CC01', password: 'secret123', roleId }, env.ctx)
  login('cc01-user', 'secret123', windowId)
}
function call(channel: string, request: unknown) { return handlers.get(channel)!(event, request) }

function seed(stage: 'issued' | 'started' | 'completed') {
  const customerId = createCustomer({ name: 'عميل CC01' }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'مطبخ CC01', quantityMicro: q(1), unitPriceMinor: m(5000) }] }, env.ctx)
  const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
  const categoryId = createCategory({ name: 'مواد CC01' }, env.ctx)
  const materialId = createMaterial({ sku: 'CC01-MDF', name: 'لوح', categoryId, unit: 'لوح', pricingRule: 'exact', currentMarketPriceMicro: c(10) }, env.ctx)
  const supplierId = createSupplier({ name: 'مورد CC01' }, env.ctx)
  createPurchase({ supplierId, customerOrderId: orderId, lines: [{ materialId, qtyMicro: q(10), unitCostMicro: c(10) }] }, env.ctx)
  const machineId = createMachine({ name: 'آلة CC01', costingUnit: 'ساعة', defaultRateMicro: c(20) }, env.ctx)
  const workerId = createWorker({ name: 'عامل CC01' }, env.ctx)
  savePlannedMaterials({ orderId }, [{ materialId, materialName: 'لوح', qtyMicro: q(4), estimatedUnitCostMicro: c(10) }], env.ctx)
  savePlannedMachines({ orderId }, [{ machineId, machineName: 'آلة', usageQtyMicro: q(2), usageUnit: 'ساعة' }], env.ctx)
  savePlannedWorkers({ orderId }, [{ workerId, workerName: 'عامل', estimatedCostMinor: m(80) }], env.ctx)
  savePlannedOrderExpenses(orderId, [{ expenseName: 'نقل', amountMinor: m(15) }], env.ctx)
  const sheet = issueWorkSheet({ orderId }, env.ctx)
  if (stage !== 'issued') startProduction(sheet.id, env.ctx)
  if (stage === 'completed') completeProduction(sheet.id, env.ctx)
  const request = () => {
    const d = getProductionOrder(sheet.id)
    return { id: sheet.id, expectedToken: d.reversalToken, confirmation: d.sheet.documentNumber, reason: 'CC01' }
  }
  return { orderId, sheet, materialId, machineId, workerId, request }
}

describe('CC01 change 1 — Manufacturing Order reversal only before manufacturing starts', () => {
  it('A: a created, not-started Manufacturing Order still reverses with FIFO restoration (service)', () => {
    const f = seed('issued')
    expect(availableQty(f.materialId)).toBe(q(6))
    reverseWorkSheet(f.request(), env.ctx)
    expect(getProductionOrder(f.sheet.id).sheet.status).toBe('reversed')
    expect(availableQty(f.materialId)).toBe(q(10))
  })

  it('A: a created, not-started Manufacturing Order still reverses through IPC', async () => {
    const f = seed('issued')
    authenticate([P.worksheets.reverse])
    expect(await call(C.production.reverseWorkSheet, f.request())).toMatchObject({ ok: true })
    expect(getProductionOrder(f.sheet.id).sheet.status).toBe('reversed')
    expect(availableQty(f.materialId)).toBe(q(10))
  })

  it.each(['started', 'completed'] as const)('B/C: rejects reversal once manufacturing is %s with zero residue (service)', (stage) => {
    const f = seed(stage)
    const request = f.request()
    const before = database()
    expect(() => reverseWorkSheet(request, env.ctx)).toThrow(STARTED)
    expect(database()).toEqual(before)
    expect(availableQty(f.materialId)).toBe(q(6))
  })

  it.each(['started', 'completed'] as const)('B/C/H: rejects reversal once manufacturing is %s with zero residue (direct IPC)', async (stage) => {
    const f = seed(stage)
    authenticate([P.worksheets.reverse])
    const request = f.request()
    const before = database()
    expect(await call(C.production.reverseWorkSheet, request)).toMatchObject({
      ok: false, error: { code: 'CONFLICT', message: expect.stringMatching(STARTED) }
    })
    expect(database()).toEqual(before)
  })

  it('B: a started-then-cancelled order stays irreversible (the start timestamp is authoritative)', () => {
    const f = seed('started')
    getRawConnection().prepare("UPDATE work_sheets SET status='cancelled' WHERE id=?").run(f.sheet.id)
    const request = f.request()
    const before = database()
    expect(() => reverseWorkSheet(request, env.ctx)).toThrow(STARTED)
    expect(database()).toEqual(before)
  })
})

describe('CC01 change 2 — production preparation locked after manufacturing completion', () => {
  it('E: before completion (started) every preparation category can still be added, edited and deleted', () => {
    const f = seed('started')
    savePlannedMaterials({ orderId: f.orderId }, [
      { materialId: f.materialId, materialName: 'لوح معدل', qtyMicro: q(5), estimatedUnitCostMicro: c(12) },
      { materialId: f.materialId, materialName: 'لوح إضافي', qtyMicro: q(1), estimatedUnitCostMicro: c(12) }
    ], env.ctx)
    savePlannedMachines({ orderId: f.orderId }, [{ machineId: f.machineId, machineName: 'آلة', usageQtyMicro: q(3), usageUnit: 'ساعة' }], env.ctx)
    savePlannedWorkers({ orderId: f.orderId }, [], env.ctx)
    savePlannedOrderExpenses(f.orderId, [{ expenseName: 'تغليف', amountMinor: m(5) }], env.ctx)
    const snapshot = orderPlanningSnapshot(f.orderId)
    expect(snapshot.materials.map((line) => line.materialName)).toEqual(['لوح معدل', 'لوح إضافي'])
    expect(snapshot.machines).toMatchObject([{ usageQtyMicro: q(3) }])
    expect(snapshot.workers).toHaveLength(0)
    expect(snapshot.expenses).toMatchObject([{ expenseName: 'تغليف' }])
  })

  it('F/G: after completion every add/edit/delete via the service is rejected with zero residue and data stays readable', () => {
    const f = seed('completed')
    const readable = orderPlanningSnapshot(f.orderId)
    const before = database()
    const attempts: Array<() => unknown> = [
      // materials: add, edit, delete
      () => savePlannedMaterials({ orderId: f.orderId }, [...readable.materials, { materialId: f.materialId, materialName: 'جديد', qtyMicro: q(1), estimatedUnitCostMicro: c(1) }], env.ctx),
      () => savePlannedMaterials({ orderId: f.orderId }, [{ ...readable.materials[0], qtyMicro: q(9) }], env.ctx),
      () => savePlannedMaterials({ orderId: f.orderId }, [], env.ctx),
      // machines: add, edit, delete
      () => savePlannedMachines({ orderId: f.orderId }, [...readable.machines, { machineId: f.machineId, machineName: 'آلة', usageQtyMicro: q(1), usageUnit: 'ساعة' }], env.ctx),
      () => savePlannedMachines({ orderId: f.orderId }, [{ ...readable.machines[0], usageQtyMicro: q(7) }], env.ctx),
      () => savePlannedMachines({ orderId: f.orderId }, [], env.ctx),
      // worker/technician commissions: add, edit, delete
      () => savePlannedWorkers({ orderId: f.orderId }, [...readable.workers, { workerId: f.workerId, workerName: 'فني', estimatedCostMinor: m(10) }], env.ctx),
      () => savePlannedWorkers({ orderId: f.orderId }, [{ ...readable.workers[0], estimatedCostMinor: m(999) }], env.ctx),
      () => savePlannedWorkers({ orderId: f.orderId }, [], env.ctx),
      // order expenses: add, edit, delete
      () => savePlannedOrderExpenses(f.orderId, [...readable.expenses, { expenseName: 'جديد', amountMinor: m(1) }], env.ctx),
      () => savePlannedOrderExpenses(f.orderId, [{ expenseName: 'نقل', amountMinor: m(99) }], env.ctx),
      () => savePlannedOrderExpenses(f.orderId, [], env.ctx),
      // Manufacturing Order material report copy
      () => savePlannedMaterials({ workSheetId: f.sheet.id }, [], env.ctx)
    ]
    for (const attempt of attempts) {
      expect(attempt).toThrow(LOCKED)
      expect(database()).toEqual(before)
    }
    expect(orderPlanningSnapshot(f.orderId)).toEqual(readable)
    expect(readable.materials).toHaveLength(1)
    expect(readable.machines).toHaveLength(1)
    expect(readable.workers).toHaveLength(1)
    expect(readable.expenses).toHaveLength(1)
  })

  it('F/G/H: after completion every direct IPC preparation mutation is rejected with zero residue; reading still works', async () => {
    const f = seed('completed')
    authenticate([P.orders.view, P.orders.viewEstimatedCost, P.productionPrep.view, P.productionPrep.manage, P.worksheets.issue])
    const readable = await call(C.orders.planningSnapshot, { id: f.orderId })
    expect(readable).toMatchObject({ ok: true })
    const before = database()
    const attempts: Array<[string, unknown]> = [
      [C.orders.savePlannedMaterials, { orderId: f.orderId, lines: [{ materialId: f.materialId, materialName: 'جديد', qtyMicro: q(1) }] }],
      [C.orders.savePlannedMaterials, { orderId: f.orderId, lines: [] }],
      [C.orders.savePlannedMachines, { orderId: f.orderId, lines: [{ machineId: f.machineId, machineName: 'آلة', usageQtyMicro: q(5) }] }],
      [C.orders.savePlannedMachines, { orderId: f.orderId, lines: [] }],
      [C.orders.savePlannedWorkers, { orderId: f.orderId, lines: [{ workerId: f.workerId, workerName: 'فني', estimatedCostMinor: m(10) }] }],
      [C.orders.savePlannedWorkers, { orderId: f.orderId, lines: [] }],
      [C.orders.savePlannedExpenses, { orderId: f.orderId, lines: [{ expenseName: 'جديد', amountMinor: m(1) }] }],
      [C.orders.savePlannedExpenses, { orderId: f.orderId, lines: [] }]
    ]
    for (const [channel, payload] of attempts) {
      expect(await call(channel, payload)).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: expect.stringMatching(LOCKED) } })
      expect(database()).toEqual(before)
    }
    // Existing Manufacturing Order posting guard also refuses the work-sheet material report.
    expect(await call(C.production.updatePlannedMaterials, { workSheetId: f.sheet.id, lines: [] })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(database()).toEqual(before)
    expect(await call(C.orders.planningSnapshot, { id: f.orderId })).toEqual(readable)
  })

  it('G: a reversed pre-start Manufacturing Order never locks preparation', () => {
    const f = seed('issued')
    reverseWorkSheet(f.request(), env.ctx)
    savePlannedOrderExpenses(f.orderId, [], env.ctx)
    expect(orderPlanningSnapshot(f.orderId).expenses).toHaveLength(0)
  })
})
