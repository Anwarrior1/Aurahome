import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { savePlannedMaterials, savePlannedMachines, savePlannedWorkers } from '@main/services/planning/planning.service'
import { issueWorkSheet, startProduction, completeProduction, getProductionOrder, productionActualCostMinor, issueStandardStockFromBom } from '@main/services/production/production.service'
import { createMachine, addMachineUsage } from '@main/services/production/machines.service'
import { createWorker, workerBalances, assignWorkerToOrder, payWorkerCommission, recordWorkerTransaction, listWorkers } from '@main/services/production/workers.service'
import { createProduct } from '@main/services/products/products.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 80600
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

const raw = () => getRawConnection()
const rows = (table: string) => raw().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
const count = (sql: string, ...params: unknown[]) => (raw().prepare(sql).get(...params) as { c: number }).c
function tables() {
  return (raw().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
}
function authenticate(permissions: string[]) {
  const roleId = createRole({ name: `CC04B role ${windowId}`, permissions }, env.ctx)
  createUser({ username: `cc04b-${windowId}`, fullName: 'CC04B', password: 'secret123', roleId }, env.ctx)
  login(`cc04b-${windowId}`, 'secret123', windowId)
}
const call = (channel: string, request: unknown) => handlers.get(channel)!(event, request)
const payable = (workerId: number) => workerBalances(workerId).payableMinor

let seq = 0
function preparedOrder(workers: Array<[workerId: number, major: number]>, machines: Array<[machineId: number, qty: number]> = []) {
  seq += 1
  const customerId = createCustomer({ name: `عميل CC04B ${seq}` }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: `خزانة ${seq}`, quantityMicro: q(1), unitPriceMinor: m(9000) }] }, env.ctx)
  const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
  savePlannedWorkers({ orderId }, workers.map(([workerId, major]) => ({ workerId, workerName: `عامل ${workerId}`, estimatedCostMinor: m(major) })), env.ctx)
  if (machines.length) savePlannedMachines({ orderId }, machines.map(([machineId, qty]) => ({ machineId, machineName: 'آلة', usageQtyMicro: q(qty), usageUnit: 'ساعة' })), env.ctx)
  const sheet = issueWorkSheet({ orderId }, env.ctx)
  return { orderId, sheetId: sheet.id }
}

describe('CC04B — تجهيز الإنتاج is the single source for workers and commissions', () => {
  it('A/C: prepared Mohamed 500 is used as-is; opening/reloading the Manufacturing Order creates nothing; completion pays exactly 500', async () => {
    const mohamed = createWorker({ name: 'محمد' }, env.ctx)
    const job = preparedOrder([[mohamed, 500]])
    authenticate([P.worksheets.view, P.orders.viewEstimatedCost, P.orders.viewActualCost, P.workers.view])
    const before = tables()
    for (let reload = 0; reload < 3; reload++) {
      expect(await call(C.production.getWorkSheet, { id: job.sheetId })).toMatchObject({ ok: true })
      getProductionOrder(job.sheetId)
      listWorkers()
    }
    expect(tables()).toEqual(before)
    expect(count('SELECT COUNT(*) AS c FROM order_worker_assignments')).toBe(0)
    startProduction(job.sheetId, env.ctx)
    completeProduction(job.sheetId, env.ctx)
    expect(payable(mohamed)).toBe(m(500))
    expect(count('SELECT COUNT(*) AS c FROM order_worker_assignments WHERE worker_id = ?', mohamed)).toBe(1)
  })

  it('B/J: Mohamed 500 + Ahmed 200 → payables 500/200 and recognised labour cost 700', () => {
    const mohamed = createWorker({ name: 'محمد' }, env.ctx)
    const ahmed = createWorker({ name: 'أحمد' }, env.ctx)
    const job = preparedOrder([[mohamed, 500], [ahmed, 200]])
    completeProduction(job.sheetId, env.ctx)
    expect([payable(mohamed), payable(ahmed)]).toEqual([m(500), m(200)])
    expect(orderCostBreakdown(job.orderId).workerCostMinor).toBe(m(700))
    expect(productionActualCostMinor(job.sheetId)).toBe(m(700))
  })

  it('D: repeated completion keeps Package 04 exactly-once recognition (workers and machines)', () => {
    const mohamed = createWorker({ name: 'محمد' }, env.ctx)
    const machine = createMachine({ name: 'مكبس', costingUnit: 'ساعة', defaultRateMicro: c(25) }, env.ctx)
    const job = preparedOrder([[mohamed, 500]], [[machine, 2]])
    completeProduction(job.sheetId, env.ctx)
    const before = tables()
    expect(() => completeProduction(job.sheetId, env.ctx)).toThrow()
    expect(tables()).toEqual(before)
    expect(payable(mohamed)).toBe(m(500))
    expect(count('SELECT COUNT(*) AS c FROM order_machine_usage')).toBe(1)
  })

  it('G: prepared workers are available to the Manufacturing Order (amounts only with estimated-cost permission)', async () => {
    const mohamed = createWorker({ name: 'محمد' }, env.ctx)
    const job = preparedOrder([[mohamed, 500]])
    expect(getProductionOrder(job.sheetId).preparedWorkers).toMatchObject([{ workerId: mohamed, estimatedCostMinor: m(500) }])
    authenticate([P.worksheets.view])
    const redacted = await call(C.production.getWorkSheet, { id: job.sheetId }) as IpcResult<{ preparedWorkers: Array<Record<string, unknown>> }>
    expect(redacted.ok).toBe(true)
    if (redacted.ok) {
      expect(redacted.data.preparedWorkers).toMatchObject([{ workerId: mohamed }])
      expect(redacted.data.preparedWorkers[0]).not.toHaveProperty('estimatedCostMinor')
    }
  })

  it('K/L: a worker added through preparation while manufacturing runs flows into completion; afterwards preparation is locked', () => {
    const mohamed = createWorker({ name: 'محمد' }, env.ctx)
    const ahmed = createWorker({ name: 'أحمد' }, env.ctx)
    const job = preparedOrder([[mohamed, 500]])
    startProduction(job.sheetId, env.ctx)
    savePlannedWorkers({ orderId: job.orderId }, [
      { workerId: mohamed, workerName: 'محمد', estimatedCostMinor: m(500) },
      { workerId: ahmed, workerName: 'أحمد', estimatedCostMinor: m(200) }
    ], env.ctx)
    expect(getProductionOrder(job.sheetId).preparedWorkers.map((w) => w.workerId)).toEqual([mohamed, ahmed])
    completeProduction(job.sheetId, env.ctx)
    expect([payable(mohamed), payable(ahmed)]).toEqual([m(500), m(200)])
    const before = tables()
    expect(() => savePlannedWorkers({ orderId: job.orderId }, [], env.ctx)).toThrow(/تجهيز الإنتاج مغلق/)
    expect(() => savePlannedMachines({ orderId: job.orderId }, [], env.ctx)).toThrow(/تجهيز الإنتاج مغلق/)
    expect(tables()).toEqual(before)
  })
})

describe('CC04B — تجهيز الإنتاج is the single source for machines', () => {
  it('H/I: prepared machine cost is visible to manufacturing and becomes actual machine cost exactly once at completion', () => {
    const machine = createMachine({ name: 'منشار', costingUnit: 'ساعة', defaultRateMicro: c(40) }, env.ctx)
    const job = preparedOrder([], [[machine, 3]])
    const prepared = getProductionOrder(job.sheetId).preparedMachines
    expect(prepared).toMatchObject([{ machineId: machine, estimatedCostMinor: m(120) }])
    expect(orderCostBreakdown(job.orderId).machineCostMinor).toBe(0)
    completeProduction(job.sheetId, env.ctx)
    expect(orderCostBreakdown(job.orderId).machineCostMinor).toBe(m(120))
    expect(getProductionOrder(job.sheetId).machineUsage).toMatchObject([{ machineId: machine, finalAmountMinor: m(120) }])
    expect(productionActualCostMinor(job.sheetId)).toBe(m(120))
  })

  it('N: a stock Manufacturing Order recognises its configured worker commission and machine cost exactly once, capitalised into finished goods', () => {
    const worker = createWorker({ name: 'عامل مخزون' }, env.ctx)
    const machine = createMachine({ name: 'مخرطة', costingUnit: 'ساعة', defaultRateMicro: c(10) }, env.ctx)
    const categoryId = createCategory({ name: 'مادة مخزون' }, env.ctx)
    const materialId = createMaterial({ sku: 'CC04B-M', name: 'مادة', categoryId, unit: 'unit', currentMarketPriceMicro: c(1), pricingRule: 'exact' } as never, env.ctx)
    createPurchase({ supplierId: createSupplier({ name: 'مورد مخزون' }, env.ctx), lines: [{ materialId, qtyMicro: q(2), unitCostMicro: c(1) }] }, env.ctx)
    const productId = createProduct({ code: 'CC04B', name: 'منتج', bom: [{ materialId, qtyMicro: q(1), unit: 'unit' }], commission: [{ workerId: worker, amountMinor: m(100) }], machines: [{ machineId: machine, usageQtyMicro: q(1) }] }, env.ctx)
    const sheet = issueStandardStockFromBom({ productId, quantityMicro: q(2), requestKey: 'cc04b-stock-complete' }, env.ctx)
    expect(getProductionOrder(sheet.workSheetId)).toMatchObject({ preparedWorkers: [{ workerId: worker }], preparedMachines: [{ machineId: machine }] })
    expect(payable(worker)).toBe(m(200))
    expect(raw().prepare('SELECT total_cost_minor AS t FROM finished_goods_movements WHERE work_sheet_id = ?').get(sheet.workSheetId)).toEqual({ t: m(222) })
    const before = tables()
    expect(() => completeProduction(sheet.workSheetId, env.ctx)).toThrow()
    expect(tables()).toEqual(before)
  })
})

describe('CC04B — the Manufacturing Order duplicate authoring path is gone', () => {
  it('E/F: the Manufacturing Order screen exposes neither "تعيين عامل" nor "إضافة استخدام آلة" and never calls their channels', () => {
    const page = readFileSync('src/renderer/pages/worksheets/ProductionOrderPage.tsx', 'utf8')
    for (const text of ['تعيين عامل', 'إضافة استخدام آلة', "'workers', 'assign'", "'machines', 'addUsage'", "'machines', 'updateUsage'", "'machines', 'removeUsage'", "'workers', 'updateAssignment'", "'workers', 'removeAssignment'"]) {
      expect(page).not.toContain(text)
    }
    expect(page).toContain('الموارد المجهزة (من تجهيز الإنتاج)')
    const renderer = ['src/renderer/pages/orders/OrderDetailPage.tsx', 'src/renderer/pages/workers/WorkersPage.tsx'].map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(renderer).not.toContain("'workers', 'assign'")
    expect(renderer).not.toContain("'machines', 'addUsage'")
  })

  it('M: no IPC route can author Manufacturing Order workers or machine usage; the read-only usage view still works', async () => {
    const channels = ['workers:assign', 'workers:updateAssignment', 'workers:removeAssignment', 'machines:addUsage', 'machines:updateUsage', 'machines:removeUsage']
    for (const channel of channels) expect(handlers.has(channel), channel).toBe(false)
    expect(JSON.stringify(C)).not.toMatch(/workers:assign|workers:updateAssignment|workers:removeAssignment|machines:addUsage|machines:updateUsage|machines:removeUsage/)
    const machine = createMachine({ name: 'مثقاب', costingUnit: 'ساعة', defaultRateMicro: c(5) }, env.ctx)
    const job = preparedOrder([], [[machine, 2]])
    completeProduction(job.sheetId, env.ctx)
    authenticate([P.orders.view])
    expect(await call(C.machines.usageForOrder, { orderId: job.orderId })).toMatchObject({ ok: true, data: [{ machineId: machine, finalAmountMinor: m(10) }] })
  })

  it('same-worker commission can no longer be double-counted through two authoring paths', async () => {
    const mohamed = createWorker({ name: 'محمد' }, env.ctx)
    const job = preparedOrder([[mohamed, 500]])
    authenticate([P.orders.manage, P.worksheets.issue, P.worksheets.view])
    expect(handlers.get('workers:assign')).toBeUndefined()
    completeProduction(job.sheetId, env.ctx)
    expect(payable(mohamed)).toBe(m(500))
    expect(orderCostBreakdown(job.orderId).workerCostMinor).toBe(m(500))
  })
})

describe('CC04B — preserved behaviour', () => {
  it('O: material issue / FIFO consumption is unchanged, and completion never touches inventory', () => {
    const categoryId = createCategory({ name: 'ألواح CC04B' }, env.ctx)
    const materialId = createMaterial({ sku: 'CC04B-MDF', name: 'لوح', categoryId, unit: 'لوح', pricingRule: 'exact', currentMarketPriceMicro: c(10) }, env.ctx)
    const supplierId = createSupplier({ name: 'مورد CC04B' }, env.ctx)
    createPurchase({ supplierId, lines: [{ materialId, qtyMicro: q(4), unitCostMicro: c(10) }] }, env.ctx)
    createPurchase({ supplierId, lines: [{ materialId, qtyMicro: q(6), unitCostMicro: c(15) }] }, env.ctx)
    const customerId = createCustomer({ name: 'عميل مواد' }, env.ctx)
    const invoice = createFinalInvoice({ customerId, depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'مواد', quantityMicro: q(1), unitPriceMinor: m(5000) }] }, env.ctx)
    const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
    savePlannedMaterials({ orderId }, [{ materialId, materialName: 'لوح', qtyMicro: q(5), estimatedUnitCostMicro: c(10) }], env.ctx)
    const sheet = issueWorkSheet({ orderId }, env.ctx)
    expect(availableQty(materialId)).toBe(q(5))
    expect(orderCostBreakdown(orderId).materialCostMinor).toBe(m(55)) // FIFO: 4 × 10 + 1 × 15
    const stock = ['inventory_movements', 'fifo_layers', 'fifo_allocations', 'order_material_lines'].map(rows)
    completeProduction(sheet.id, env.ctx)
    expect(['inventory_movements', 'fifo_layers', 'fifo_allocations', 'order_material_lines'].map(rows)).toEqual(stock)
  })

  it('P: historical Manufacturing Order assignments and machine usages stay readable and unchanged', () => {
    const legacyWorker = createWorker({ name: 'تاريخي' }, env.ctx)
    const machine = createMachine({ name: 'آلة تاريخية', costingUnit: 'ساعة', defaultRateMicro: c(30) }, env.ctx)
    const job = preparedOrder([])
    // Rows created before CC04B through the (now unregistered) Manufacturing Order path.
    const assignment = assignWorkerToOrder({ workSheetId: job.sheetId, workerId: legacyWorker, method: 'fixed', amountMinor: m(90) }, env.ctx)
    addMachineUsage({ workSheetId: job.sheetId, machineId: machine, usageQtyMicro: q(1) }, env.ctx)
    const history = ['order_worker_assignments', 'order_machine_usage'].map(rows)
    const detail = getProductionOrder(job.sheetId)
    expect(detail.assignments).toMatchObject([{ id: assignment.id, amountMinor: m(90) }])
    expect(detail.machineUsage).toMatchObject([{ machineId: machine, finalAmountMinor: m(30) }])
    expect(['order_worker_assignments', 'order_machine_usage'].map(rows)).toEqual(history)
  })

  it('Q/R: worker payable and debt stay separate and commission "دفعة" still works', () => {
    const mohamed = createWorker({ name: 'محمد' }, env.ctx)
    completeProduction(preparedOrder([[mohamed, 500]]).sheetId, env.ctx)
    const box = createAccount({ name: 'خزينة CC04B', kind: 'cash', openingBalanceMinor: m(1000) }, env.ctx)
    recordWorkerTransaction({ workerId: mohamed, kind: 'withdrawal', amountMinor: m(100), cashAccountId: box }, env.ctx)
    payWorkerCommission({ workerId: mohamed, amountMinor: m(200), cashAccountId: box }, env.ctx)
    expect(workerBalances(mohamed)).toEqual({ payableMinor: m(300), debtMinor: m(100) })
    expect(accountBalance(box)).toBe(m(700))
  })
})
