import { fulfillOrder } from '../helpers/sales-flow'
import { insertHistoricalStockSheet } from '../helpers/historical-stock-sheet'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createProduct, replaceProductCommission } from '@main/services/products/products.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder } from '@main/services/sales/orders.service'
import { savePlannedMachines, savePlannedWorkers } from '@main/services/planning/planning.service'
import { cancelProductionOrder, completeProduction, consumeForOrder, getProductionOrder, issueStandardStockFromBom, issueWorkSheet, productionActualCostMinor, reverseMaterialConsumption, reverseWorkSheet, startProduction } from '@main/services/production/production.service'
import { createMaterialReturn, editMaterialReturn, reverseMaterialReturn } from '@main/services/production/material-returns.service'
import * as machineService from '@main/services/production/machines.service'
import * as workerService from '@main/services/production/workers.service'
import { addMachineUsage, createMachine, removeMachineUsage, updateMachineUsage } from '@main/services/production/machines.service'
import { assignWorkerToOrder, createWorker, removeAssignment, updateAssignment, workerBalances } from '@main/services/production/workers.service'
import { onHandMicro } from '@main/services/production/finished-goods.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
let key = 0
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  env.cleanup()
})
const raw = () => getRawConnection()
const one = (query: string, ...args: unknown[]) => raw().prepare(query).get(...args) as Record<string, number>
const all = (query: string, ...args: unknown[]) => raw().prepare(query).all(...args) as Array<Record<string, number>>
const count = (table: string) => one(`SELECT COUNT(*) AS n FROM ${table}`).n
function stock(available = 5) {
  const categoryId = createCategory({ name: 'BL11 material' }, env.ctx)
  const materialId = createMaterial({ sku: 'BL11-BOARD', name: 'Board', categoryId, unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(100) }, env.ctx)
  createPurchase({ supplierId: createSupplier({ name: 'BL11 supplier' }, env.ctx), lines: [{ materialId, qtyMicro: q(available), unitCostMicro: c(100) }] }, env.ctx)
  const workerId = createWorker({ name: 'Stock worker' }, env.ctx)
  const machineId = createMachine({ name: 'Stock machine', costingUnit: 'hour', defaultRateMicro: c(30) }, env.ctx)
  const productId = createProduct({ code: `BL11-STOCK-${++key}`, name: 'Stock item',
    bom: [{ materialId, qtyMicro: q(1), unit: 'board' }],
    machines: [{ machineId, usageQtyMicro: q(1) }],
    commission: [{ workerId, amountMinor: m(20) }] }, env.ctx)
  return { materialId, workerId, machineId, productId }
}

function custom() {
  const customerId = createCustomer({ name: 'BL11 customer' }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'Custom', quantityMicro: q(1), unitPriceMinor: m(1000) }] }, env.ctx)
  const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
  const workerId = createWorker({ name: 'Custom worker' }, env.ctx)
  const machineId = createMachine({ name: 'Custom machine', costingUnit: 'hour', defaultRateMicro: c(30) }, env.ctx)
  savePlannedWorkers({ orderId }, [{ workerId, workerName: 'Custom worker', estimatedCostMinor: m(20) }], env.ctx)
  savePlannedMachines({ orderId }, [{ machineId, machineName: 'Custom machine', usageQtyMicro: q(1) }], env.ctx)
  const sheet = issueWorkSheet({ orderId }, env.ctx)
  return { orderId, sheet, workerId, machineId }
}

function financialState() {
  return Object.fromEntries([
    'work_sheets', 'planned_materials', 'planned_machines', 'planned_workers',
    'order_material_lines', 'inventory_movements', 'fifo_layers', 'fifo_allocations',
    'order_machine_usage', 'order_worker_assignments', 'worker_transactions',
    'finished_goods_movements', 'financial_command_requests', 'audit_log'
  ].map((table) => [table, all(`SELECT * FROM ${table} ORDER BY rowid`)]))
}

describe('BL-11 completed-resource freeze and Standard stock production', () => {
  it('keeps authorized machine and worker resource management open before completion and pre-start reversal intact', () => {
    const f = custom()
    const machine = addMachineUsage({ workSheetId: f.sheet.id, machineId: f.machineId, usageQtyMicro: q(1) }, env.ctx)
    const worker = assignWorkerToOrder({ workSheetId: f.sheet.id, workerId: f.workerId, method: 'fixed', amountMinor: m(5) }, env.ctx)
    updateMachineUsage(machine.id, { finalAmountMinor: m(40) }, env.ctx)
    updateAssignment(worker.id, { amountMinor: m(7) }, env.ctx)
    expect(productionActualCostMinor(f.sheet.id)).toBe(m(47))
    removeMachineUsage(machine.id, env.ctx)
    removeAssignment(worker.id, env.ctx)
    expect(productionActualCostMinor(f.sheet.id)).toBe(0)
    const again = addMachineUsage({ workSheetId: f.sheet.id, machineId: f.machineId, usageQtyMicro: q(1) }, env.ctx)
    const labour = assignWorkerToOrder({ workSheetId: f.sheet.id, workerId: f.workerId, method: 'fixed', amountMinor: m(5) }, env.ctx)
    cancelProductionOrder({ id: f.sheet.id, reason: 'pre-start cancellation' }, env.ctx)
    reverseWorkSheet({ id: f.sheet.id, expectedToken: getProductionOrder(f.sheet.id).reversalToken,
      confirmation: f.sheet.documentNumber, reason: 'pre-start' }, env.ctx)
    expect(one('SELECT status FROM work_sheets WHERE id = ?', f.sheet.id).status).toBe('reversed')
    expect(one('SELECT reversed_at IS NOT NULL AS reversed FROM order_machine_usage WHERE id = ?', again.id).reversed).toBe(1)
    expect(one('SELECT reversed_at IS NOT NULL AS reversed FROM order_worker_assignments WHERE id = ?', labour.id).reversed).toBe(1)
  })

  it('rejects every legacy resource mutation after Custom completion and preserves completed-order profit', () => {
    const f = custom()
    completeProduction(f.sheet.id, env.ctx)
    const machineId = one('SELECT id FROM order_machine_usage WHERE work_sheet_id = ?', f.sheet.id).id
    const assignmentId = one('SELECT id FROM order_worker_assignments WHERE work_sheet_id = ?', f.sheet.id).id
    const before = financialState()
    const cost = productionActualCostMinor(f.sheet.id)
    for (const action of [
      () => addMachineUsage({ workSheetId: f.sheet.id, machineId: f.machineId, usageQtyMicro: q(1) }, env.ctx),
      () => addMachineUsage({ orderId: f.orderId, machineId: f.machineId, usageQtyMicro: q(1) }, env.ctx),
      () => updateMachineUsage(machineId, { finalAmountMinor: m(99) }, env.ctx),
      () => removeMachineUsage(machineId, env.ctx),
      () => assignWorkerToOrder({ workSheetId: f.sheet.id, workerId: f.workerId, method: 'fixed', amountMinor: m(1) }, env.ctx),
      () => assignWorkerToOrder({ orderId: f.orderId, workerId: f.workerId, method: 'fixed', amountMinor: m(1) }, env.ctx),
      () => updateAssignment(assignmentId, { amountMinor: m(99) }, env.ctx),
      () => removeAssignment(assignmentId, env.ctx),
    ]) expect(action).toThrow()
    expect(financialState()).toEqual(before)
    expect('reverseMachineUsage' in machineService).toBe(false)
    expect('reverseWorkerAssignment' in workerService).toBe(false)
    expect(productionActualCostMinor(f.sheet.id)).toBe(cost)
    fulfillOrder(f.orderId, env.ctx)
    const now = new Date()
    const profit = monthlyProfitSummary(now.getUTCFullYear(), now.getUTCMonth() + 1).netProfitMinor
    expect(() => addMachineUsage({ orderId: f.orderId, machineId: f.machineId, usageQtyMicro: q(1) }, env.ctx)).toThrow()
    expect(monthlyProfitSummary(now.getUTCFullYear(), now.getUTCMonth() + 1).netProfitMinor).toBe(profit)
  })

  it('also freezes material issue corrections and return economics after Custom completion', () => {
    const f = custom()
    const categoryId = createCategory({ name: 'BL11 custom material' }, env.ctx)
    const materialId = createMaterial({ sku: 'BL11-CUSTOM', name: 'Board', categoryId, unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(10) }, env.ctx)
    createPurchase({ supplierId: createSupplier({ name: 'BL11 custom supplier' }, env.ctx), lines: [{ materialId, qtyMicro: q(3), unitCostMicro: c(10) }] }, env.ctx)
    const issue = consumeForOrder({ workSheetId: f.sheet.id, materialId, physicalQtyMicro: q(2) }, env.ctx)
    const returned = createMaterialReturn({ orderId: f.orderId, materialId, quantityMicro: q(1), requestKey: `bl11-return-${++key}` }, env.ctx)
    completeProduction(f.sheet.id, env.ctx)
    const cost = productionActualCostMinor(f.sheet.id)
    const before = financialState()
    for (const action of [
      () => reverseMaterialConsumption({ id: issue.id, reason: 'late reversal' }, env.ctx),
      () => createMaterialReturn({ orderId: f.orderId, materialId, quantityMicro: q(1), requestKey: `bl11-late-${++key}` }, env.ctx),
      () => editMaterialReturn({ id: returned.id, quantityMicro: q(2), expectedVersion: returned.version, requestKey: `bl11-edit-${++key}` }, env.ctx),
      () => reverseMaterialReturn({ id: returned.id, expectedVersion: returned.version, requestKey: `bl11-reverse-${++key}` }, env.ctx)
    ]) expect(action).toThrow()
    expect(financialState()).toEqual(before)
    expect(productionActualCostMinor(f.sheet.id)).toBe(cost)
  })

  it('requires a worker in Standard commission configuration and rejects invalid stored plans safely', () => {
    const f = stock()
    const beforeConfig = financialState()
    expect(() => replaceProductCommission(f.productId, [{ workerId: null, amountMinor: m(20) }], env.ctx)).toThrow(/اختر عاملاً/)
    expect(financialState()).toEqual(beforeConfig)
    raw().prepare('UPDATE product_commission_lines SET worker_id = NULL WHERE product_id = ?').run(f.productId)
    const beforeIssue = financialState()
    expect(() => issueStandardStockFromBom({ productId: f.productId, quantityMicro: q(2), requestKey: `bl11-invalid-${++key}` }, env.ctx)).toThrow(/دون تعيين عامل/)
    expect(financialState()).toEqual(beforeIssue)
    expect(onHandMicro(f.productId)).toBe(0)
    const sheet = insertHistoricalStockSheet(f.productId, q(2))
    const beforeCompletion = financialState()
    expect(() => completeProduction(sheet.id, env.ctx)).toThrow(/للعرض فقط/)
    expect(financialState()).toEqual(beforeCompletion)
    expect(one('SELECT status FROM work_sheets WHERE id = ?', sheet.id).status).toBe('ready')
  })

  it('scales every configured resource for five one-step units, posts payable and full FG value once', () => {
    const f = stock()
    const request = { productId: f.productId, quantityMicro: q(5), requestKey: `bl11-full-${++key}` }
    const result = issueStandardStockFromBom(request, env.ctx)
    expect(result.totalCostMinor).toBe(m(750))
    expect(one('SELECT SUM(actual_cost_minor) AS cost FROM order_material_lines WHERE work_sheet_id = ?', result.workSheetId).cost).toBe(m(500))
    expect(one('SELECT SUM(final_amount_minor) AS cost FROM order_machine_usage WHERE work_sheet_id = ?', result.workSheetId).cost).toBe(m(150))
    expect(one('SELECT SUM(amount_minor) AS cost FROM order_worker_assignments WHERE work_sheet_id = ?', result.workSheetId).cost).toBe(m(100))
    expect(one('SELECT total_cost_minor AS cost FROM finished_goods_movements WHERE work_sheet_id = ?', result.workSheetId).cost).toBe(m(750))
    expect(productionActualCostMinor(result.workSheetId)).toBe(m(750))
    expect(workerBalances(f.workerId).payableMinor).toBe(m(100))
    expect(onHandMicro(f.productId)).toBe(q(5))
    expect(issueStandardStockFromBom(request, env.ctx)).toEqual(result)
    expect([count('order_machine_usage'), count('order_worker_assignments'), count('worker_transactions'), count('finished_goods_movements')]).toEqual([1, 1, 1, 1])
    const state = financialState()
    const usageId = one('SELECT id FROM order_machine_usage WHERE work_sheet_id = ?', result.workSheetId).id
    const assignmentId = one('SELECT id FROM order_worker_assignments WHERE work_sheet_id = ?', result.workSheetId).id
    for (const action of [
      () => addMachineUsage({ workSheetId: result.workSheetId, machineId: f.machineId, usageQtyMicro: q(1) }, env.ctx),
      () => updateMachineUsage(usageId, { finalAmountMinor: m(1) }, env.ctx),
      () => removeMachineUsage(usageId, env.ctx),
      () => assignWorkerToOrder({ workSheetId: result.workSheetId, workerId: f.workerId, method: 'fixed', amountMinor: m(1) }, env.ctx),
      () => updateAssignment(assignmentId, { amountMinor: m(1) }, env.ctx),
      () => removeAssignment(assignmentId, env.ctx)
    ]) expect(action).toThrow()
    expect(financialState()).toEqual(state)
    expect(productionActualCostMinor(result.workSheetId)).toBe(m(750))
  })

  it('retains actual machine usage history when a configured machine has a zero rate', () => {
    const f = stock()
    raw().prepare('UPDATE machines SET default_rate_micro = 0 WHERE id = ?').run(f.machineId)
    const result = issueStandardStockFromBom({ productId: f.productId, quantityMicro: q(1), requestKey: `bl11-zero-machine-${++key}` }, env.ctx)
    expect(one('SELECT usage_qty_micro AS qty, final_amount_minor AS cost FROM order_machine_usage WHERE work_sheet_id = ?', result.workSheetId))
      .toEqual({ qty: q(1), cost: 0 })
    expect(result.totalCostMinor).toBe(m(120))
  })

  it.each(['machine', 'worker', 'fg'] as const)('rolls back a %s posting failure and retries without duplicate resources', (stage) => {
    const f = stock()
    const request = { productId: f.productId, quantityMicro: q(5), requestKey: `bl11-fail-${stage}-${++key}` }
    const before = financialState()
    const trigger = stage === 'machine'
      ? "CREATE TRIGGER bl11_fail BEFORE INSERT ON order_machine_usage BEGIN SELECT RAISE(ABORT, 'machine posting failure'); END"
      : stage === 'worker'
        ? "CREATE TRIGGER bl11_fail BEFORE INSERT ON worker_transactions WHEN NEW.kind = 'earning' BEGIN SELECT RAISE(ABORT, 'worker earning failure'); END"
        : "CREATE TRIGGER bl11_fail BEFORE INSERT ON finished_goods_movements WHEN NEW.kind = 'production_in' BEGIN SELECT RAISE(ABORT, 'FG posting failure'); END"
    raw().exec(trigger)
    expect(() => issueStandardStockFromBom(request, env.ctx)).toThrow(/failure/)
    expect(financialState()).toEqual(before)
    expect(workerBalances(f.workerId).payableMinor).toBe(0)
    expect(onHandMicro(f.productId)).toBe(0)
    raw().exec('DROP TRIGGER bl11_fail')
    const result = issueStandardStockFromBom(request, env.ctx)
    expect(result.totalCostMinor).toBe(m(750))
    expect(issueStandardStockFromBom(request, env.ctx)).toEqual(result)
    expect([count('order_machine_usage'), count('order_worker_assignments'), count('worker_transactions'), count('finished_goods_movements')]).toEqual([1, 1, 1, 1])
  })

  it('rolls back an insufficient-material attempt without any resource or FG posting', () => {
    const f = stock(4)
    const before = financialState()
    expect(() => issueStandardStockFromBom({ productId: f.productId, quantityMicro: q(5), requestKey: `bl11-short-${++key}` }, env.ctx)).toThrow(/غير كافية/)
    expect(financialState()).toEqual(before)
    expect(workerBalances(f.workerId).payableMinor).toBe(0)
  })

  it('keeps an already-started cancelled-parent Custom MO completable and freezes its final resources', () => {
    const f = custom()
    startProduction(f.sheet.id, env.ctx)
    cancelOrder({ orderId: f.orderId, reason: 'customer cancelled' }, env.ctx)
    expect(one('SELECT COUNT(*) AS n FROM uncollected_products WHERE source_order_id = ?', f.orderId).n).toBe(0)
    completeProduction(f.sheet.id, env.ctx)
    const cost = productionActualCostMinor(f.sheet.id)
    expect(cost).toBe(m(50))
    expect(one('SELECT cost_basis_minor AS cost FROM uncollected_products WHERE source_order_id = ?', f.orderId).cost).toBe(cost)
    const machineId = one('SELECT id FROM order_machine_usage WHERE work_sheet_id = ?', f.sheet.id).id
    expect(() => updateMachineUsage(machineId, { finalAmountMinor: m(1) }, env.ctx)).toThrow()
    expect(() => assignWorkerToOrder({ orderId: f.orderId, workerId: f.workerId, method: 'fixed', amountMinor: m(1) }, env.ctx)).toThrow()
    expect(productionActualCostMinor(f.sheet.id)).toBe(cost)
  })

  it('requires service permission even for otherwise open legacy resource methods', () => {
    const f = custom()
    const roleId = createRole({ name: 'BL11 no resource rights', permissions: [] }, env.ctx)
    createUser({ username: `bl11-locked-${++key}`, fullName: 'No rights', password: 'secret123', roleId }, env.ctx)
    const ctx = { session: login(`bl11-locked-${key}`, 'secret123', 91000 + key).session }
    const machine = addMachineUsage({ workSheetId: f.sheet.id, machineId: f.machineId, usageQtyMicro: q(1) }, env.ctx)
    const worker = assignWorkerToOrder({ workSheetId: f.sheet.id, workerId: f.workerId, method: 'fixed', amountMinor: m(1) }, env.ctx)
    const productId = createProduct({ code: `BL11-PERM-${key}`, name: 'Permission fixture' }, env.ctx)
    const before = financialState()
    for (const action of [
      () => createProduct({ code: `BL11-DENIED-${key}`, name: 'Denied', commission: [{ workerId: f.workerId, amountMinor: m(1) }] }, ctx),
      () => replaceProductCommission(productId, [{ workerId: f.workerId, amountMinor: m(1) }], ctx),
      () => addMachineUsage({ workSheetId: f.sheet.id, machineId: f.machineId, usageQtyMicro: q(1) }, ctx),
      () => updateMachineUsage(machine.id, { finalAmountMinor: m(1) }, ctx),
      () => removeMachineUsage(machine.id, ctx),
      () => assignWorkerToOrder({ workSheetId: f.sheet.id, workerId: f.workerId, method: 'fixed', amountMinor: m(1) }, ctx),
      () => updateAssignment(worker.id, { amountMinor: m(2) }, ctx),
      () => removeAssignment(worker.id, ctx),
      () => completeProduction(f.sheet.id, ctx)
    ]) expect(action).toThrow()
    expect(financialState()).toEqual(before)
  })

  it('keeps one-step stock authority at products.manage plus inventory.consume', () => {
    const f = stock()
    const roleId = createRole({ name: 'BL11 stock issue rights', permissions: [P.products.manage, P.inventory.consume] }, env.ctx)
    createUser({ username: `bl11-stock-${++key}`, fullName: 'Stock producer', password: 'secret123', roleId }, env.ctx)
    const ctx = { session: login(`bl11-stock-${key}`, 'secret123', 92000 + key).session }
    const result = issueStandardStockFromBom({ productId: f.productId, quantityMicro: q(5), requestKey: `bl11-authorized-${++key}` }, ctx)
    expect(result.totalCostMinor).toBe(m(750))
    expect(workerBalances(f.workerId).payableMinor).toBe(m(100))
  })
})
