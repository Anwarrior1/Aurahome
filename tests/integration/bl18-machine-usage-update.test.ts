import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { fulfillOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder } from '@main/services/sales/orders.service'
import { createMachine, addMachineUsage, updateMachineUsage, machineUsageForOrder } from '@main/services/production/machines.service'
import { issueWorkSheet, startProduction, completeProduction, issueStandardStockFromBom, productionActualCostMinor } from '@main/services/production/production.service'
import { createProduct } from '@main/services/products/products.service'
import { createWorker, workerBalances } from '@main/services/production/workers.service'
import { listFinishedGoods, onHandMicro } from '@main/services/production/finished-goods.service'
import { listPlannedMachines } from '@main/services/planning/planning.service'
import { orderCostBreakdown, orderProfitabilityReport } from '@main/services/costing/costing.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { buildApi } from '../../src/preload/api/build-api'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
let serial = 0
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  try {
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  } finally {
    env.cleanup()
  }
})
const db = () => getRawConnection()
const one = (query: string, ...args: unknown[]) => db().prepare(query).get(...args) as Record<string, number | string | null>
const count = (table: string) => (one(`SELECT COUNT(*) AS n FROM ${table}`).n as number)

function custom() {
  const customerId = createCustomer({ name: `BL18 customer ${++serial}` }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'Cabinet', quantityMicro: q(1), unitPriceMinor: m(1000) }] }, env.ctx)
  const orderId = approveFinalInvoice(invoice.id, env.ctx).orderId
  const sheet = issueWorkSheet({ orderId }, env.ctx)
  const machineId = createMachine({ name: 'BL18 machine', costingUnit: 'hour', defaultRateMicro: c(10) }, env.ctx)
  const usage = addMachineUsage({ workSheetId: sheet.id, machineId, usageQtyMicro: q(10), finalAmountMinor: m(30) }, env.ctx)
  return { orderId, sheetId: sheet.id, machineId, usageId: usage.id }
}
const usage = (id: number) => one('SELECT usage_qty_micro AS qty, rate_micro AS rate, calculated_minor AS calculated, final_amount_minor AS final, notes FROM order_machine_usage WHERE id = ?', id)
const updateAudits = () => (one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'orders.machine.update'").n as number)

describe('BL-18 actual machine usage partial update', () => {
  it('keeps a manual final amount through notes-only and repeated edits, but recalculates quantity/rate changes', () => {
    const f = custom()
    const before = { usages: count('order_machine_usage'), inventory: count('inventory_movements'), fg: count('finished_goods_movements'), cash: count('cash_transactions') }
    expect(usage(f.usageId)).toMatchObject({ qty: q(10), rate: c(10), calculated: m(100), final: m(30) })
    for (const notes of ['first note', 'second note']) {
      updateMachineUsage(f.usageId, { notes }, env.ctx)
      expect(usage(f.usageId)).toMatchObject({ calculated: m(100), final: m(30), notes })
      expect(orderCostBreakdown(f.orderId)).toMatchObject({ machineCostMinor: m(30), actualProfitMinor: m(970) })
    }
    updateMachineUsage(f.usageId, {}, env.ctx)
    expect(usage(f.usageId).final).toBe(m(30))
    updateMachineUsage(f.usageId, { finalAmountMinor: m(40) }, env.ctx)
    expect(usage(f.usageId)).toMatchObject({ calculated: m(100), final: m(40) })
    updateMachineUsage(f.usageId, { usageQtyMicro: q(12) }, env.ctx)
    expect(usage(f.usageId)).toMatchObject({ calculated: m(120), final: m(120) })
    updateMachineUsage(f.usageId, { rateMicro: c(20) }, env.ctx)
    expect(usage(f.usageId)).toMatchObject({ calculated: m(240), final: m(240) })
    updateMachineUsage(f.usageId, { usageQtyMicro: q(11), rateMicro: c(20), finalAmountMinor: m(25) }, env.ctx)
    expect(usage(f.usageId)).toMatchObject({ calculated: m(220), final: m(25) })
    updateMachineUsage(f.usageId, { finalAmountMinor: 0 }, env.ctx)
    expect(usage(f.usageId).final).toBe(0)
    expect(() => updateMachineUsage(f.usageId, { finalAmountMinor: -1 }, env.ctx)).toThrow()
    expect(usage(f.usageId).final).toBe(0)
    expect({ usages: count('order_machine_usage'), inventory: count('inventory_movements'), fg: count('finished_goods_movements'), cash: count('cash_transactions') }).toEqual(before)
  })

  it('keeps the manual amount in order costing and completed monthly profit, then freezes the resource', () => {
    const f = custom()
    updateMachineUsage(f.usageId, { notes: 'maintenance' }, env.ctx)
    expect(machineUsageForOrder(f.orderId)[0]).toMatchObject({ finalAmountMinor: m(30) })
    expect(orderCostBreakdown(f.orderId)).toMatchObject({ machineCostMinor: m(30), actualProfitMinor: m(970) })
    startProduction(f.sheetId, env.ctx)
    completeProduction(f.sheetId, env.ctx)
    expect(() => updateMachineUsage(f.usageId, { notes: 'after MO completion' }, env.ctx)).toThrow()
    fulfillOrder(f.orderId, env.ctx)
    const now = new Date()
    expect(monthlyProfitSummary(now.getUTCFullYear(), now.getUTCMonth() + 1)).toMatchObject({ completedOrderCount: 1, machineCostMinor: m(30), netProfitMinor: m(970) })
    expect(orderProfitabilityReport({ completedOnly: true }).find((row) => row.orderId === f.orderId)).toMatchObject({ machineCostMinor: m(30), actualProfitMinor: m(970) })
    expect(() => updateMachineUsage(f.usageId, { finalAmountMinor: m(100) }, env.ctx)).toThrow()
    expect(usage(f.usageId).final).toBe(m(30))
  })

  it('preserves the manual cost when a started Custom MO finishes after Customer Order cancellation', () => {
    const f = custom()
    startProduction(f.sheetId, env.ctx)
    cancelOrder({ orderId: f.orderId, reason: 'Customer cancelled during manufacturing' }, env.ctx)
    expect((one('SELECT COUNT(*) AS n FROM uncollected_products WHERE source_order_id = ?', f.orderId).n as number)).toBe(0)
    updateMachineUsage(f.usageId, { notes: 'permitted during started MO' }, env.ctx)
    expect(productionActualCostMinor(f.sheetId)).toBe(m(30))
    completeProduction(f.sheetId, env.ctx)
    expect(one('SELECT cost_basis_minor AS cost FROM uncollected_products WHERE source_order_id = ?', f.orderId).cost).toBe(m(30))
    expect(() => updateMachineUsage(f.usageId, { notes: 'too late' }, env.ctx)).toThrow()
  })

  it('rolls back all usage fields and audit on injected audit failure, then commits both on success', () => {
    const f = custom()
    const before = usage(f.usageId)
    const beforeAudit = updateAudits()
    const beforeCounts = { usage: count('order_machine_usage'), inventory: count('inventory_movements'), fg: count('finished_goods_movements'), workers: count('worker_transactions'), cash: count('cash_transactions') }
    const edit = { usageQtyMicro: q(12), rateMicro: c(20), finalAmountMinor: m(40), notes: 'changed' }
    db().exec("CREATE TEMP TRIGGER bl18_fail_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'orders.machine.update' BEGIN SELECT RAISE(ABORT, 'bl18 injected audit failure'); END")
    expect(() => updateMachineUsage(f.usageId, edit, env.ctx)).toThrow(/bl18 injected audit failure/)
    expect(usage(f.usageId)).toEqual(before)
    expect(updateAudits()).toBe(beforeAudit)
    expect(orderCostBreakdown(f.orderId).machineCostMinor).toBe(m(30))
    db().exec('DROP TRIGGER bl18_fail_audit')
    updateMachineUsage(f.usageId, edit, env.ctx)
    expect(usage(f.usageId)).toMatchObject({ qty: q(12), rate: c(20), calculated: m(240), final: m(40), notes: 'changed' })
    expect(updateAudits()).toBe(beforeAudit + 1)
    expect({ usage: count('order_machine_usage'), inventory: count('inventory_movements'), fg: count('finished_goods_movements'), workers: count('worker_transactions'), cash: count('cash_transactions') }).toEqual(beforeCounts)
  })

  it('retains service permission and no machine-usage write IPC/preload route; Production Preparation remains separate', async () => {
    const f = custom()
    const noRights = { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions: [] } }
    expect(() => updateMachineUsage(f.usageId, { notes: 'denied' }, noRights)).toThrow(/صلاحية/)
    expect(usage(f.usageId).final).toBe(m(30))
    const issueOnly = { session: { ...noRights.session, permissions: [P.worksheets.issue] } }
    updateMachineUsage(f.usageId, { notes: 'authorized' }, issueOnly)
    expect(usage(f.usageId).final).toBe(m(30))
    expect('usageUpdate' in C.machines).toBe(false)
    expect('usageUpdate' in buildApi().machines).toBe(false)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<{ ok: boolean }>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    expect(handlers.has('machines:usage:update')).toBe(false)
    const windowId = 94000 + serial * 2
    const roleId = createRole({ name: `BL18 plan role ${serial}`, permissions: [P.productionPrep.manage, P.orders.view] }, env.ctx)
    createUser({ username: `bl18-plan-${serial}`, fullName: 'BL18 plan', password: 'secret123', roleId }, env.ctx)
    login(`bl18-plan-${serial}`, 'secret123', windowId)
    const event = { sender: { id: windowId } } as IpcMainInvokeEvent
    const plan = { machineId: f.machineId, machineName: 'BL18 machine', usageQtyMicro: q(10), notes: 'plan', finalAmountMinor: m(999) }
    expect(await handlers.get(C.orders.savePlannedMachines)!(event, { orderId: f.orderId, lines: [plan] })).toMatchObject({ ok: true })
    const planned = listPlannedMachines({ orderId: f.orderId })[0]!
    expect(planned.estimatedCostMinor).toBe(m(100))
    expect(await handlers.get(C.orders.savePlannedMachines)!(event, { orderId: f.orderId, lines: [{ ...plan, id: planned.id, notes: 'new plan note' }] })).toMatchObject({ ok: true })
    expect(listPlannedMachines({ orderId: f.orderId })[0]!.estimatedCostMinor).toBe(m(100))
    expect(usage(f.usageId).final).toBe(m(30))
  })

  it('leaves atomic Standard stock production and its exactly-once full-resource valuation unchanged', () => {
    const categoryId = createCategory({ name: 'BL18 material' }, env.ctx)
    const materialId = createMaterial({ sku: `BL18-M-${++serial}`, name: 'Board', categoryId, unit: 'unit', currentMarketPriceMicro: c(100), pricingRule: 'exact' }, env.ctx)
    createPurchase({ supplierId: createSupplier({ name: 'BL18 supplier' }, env.ctx), lines: [{ materialId, qtyMicro: q(10), unitCostMicro: c(100) }] }, env.ctx)
    const machineId = createMachine({ name: 'Stock machine', costingUnit: 'hour', defaultRateMicro: c(100) }, env.ctx)
    const workerId = createWorker({ name: 'Stock worker' }, env.ctx)
    const productId = createProduct({ code: `BL18-P-${serial}`, name: 'Standard item', bom: [{ materialId, qtyMicro: q(5), unit: 'unit' }],
      machines: [{ machineId, usageQtyMicro: q(1) }], commission: [{ workerId, amountMinor: m(100) }] }, env.ctx)
    const request = { productId, quantityMicro: q(1), requestKey: `bl18-stock-${serial}` }
    const result = issueStandardStockFromBom(request, env.ctx)
    expect(result.totalCostMinor).toBe(m(700))
    expect(onHandMicro(productId)).toBe(q(1))
    expect(listFinishedGoods({ productId })[0]!.onHandValueMinor).toBe(m(700))
    expect(workerBalances(workerId).payableMinor).toBe(m(100))
    const before = { usage: count('order_machine_usage'), fg: count('finished_goods_movements'), inventory: count('inventory_movements'), workers: count('worker_transactions'), audit: count('audit_log') }
    expect(issueStandardStockFromBom(request, env.ctx)).toEqual(result)
    expect({ usage: count('order_machine_usage'), fg: count('finished_goods_movements'), inventory: count('inventory_movements'), workers: count('worker_transactions'), audit: count('audit_log') }).toEqual(before)
  })
})
