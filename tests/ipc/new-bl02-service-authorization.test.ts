import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { getRawConnection } from '@main/db/connection'
import { login } from '@main/auth/auth.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import type { ServiceContext } from '@main/services/base/service.types'
import * as expenses from '@main/services/finance/expenses.service'
import * as cash from '@main/services/finance/cash.service'
import * as purchasing from '@main/services/purchasing/purchasing.service'
import * as inventory from '@main/services/inventory/inventory.service'
import * as profit from '@main/services/finance/profit.service'
import * as planning from '@main/services/planning/planning.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createMachine } from '@main/services/production/machines.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment, cancelOrder } from '@main/services/sales/orders.service'
import { issueWorkSheet, startProduction, consumeForOrder, completeProduction } from '@main/services/production/production.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'

let env: TestEnv
let sequence = 58100
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let f: { material: number; supplier: number; account: number; other: number; purchase: number; correction: number; order: number; sheet: number; machine: number }
const db = () => getRawConnection()
const scalar = (sql: string, ...args: (number | string)[]) => (db().prepare(sql).get(...args) as { value: number }).value
const key = () => `NEW-BL02-${++sequence}`

beforeEach(async () => {
  env = setupTestDatabase()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'))
  const material = createMaterial({ sku: key(), name: 'Board', categoryId: createCategory({ name: key() }, env.ctx), unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(100) }, env.ctx)
  const supplier = createSupplier({ name: key() }, env.ctx)
  const account = cash.createAccount({ name: key(), kind: 'cash', openingBalanceMinor: m(100000) }, env.ctx)
  const other = cash.createAccount({ name: key(), kind: 'bank' }, env.ctx)
  const purchase = purchasing.createPurchase({ supplierId: supplier, lines: [{ materialId: material, qtyMicro: q(100), unitCostMicro: c(100) }] }, env.ctx).id
  const correction = purchasing.createPurchase({ supplierId: supplier, lines: [{ materialId: material, qtyMicro: q(10), unitCostMicro: c(100) }] }, env.ctx).id
  const invoice = createFinalInvoice({ customerId: createCustomer({ name: key() }, env.ctx), depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'Custom cabinet', quantityMicro: q(1), unitPriceMinor: m(2000) }] }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx).id
  const sheet = issueWorkSheet({ orderId: order }, env.ctx).id
  const machine = createMachine({ name: key(), costingUnit: 'hour', defaultRateMicro: c(10) }, env.ctx)
  f = { material, supplier, account, other, purchase, correction, order, sheet, machine }
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((name: string, handler: never) => { handlers.set(name, handler) }) as never)
  try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
})
afterEach(() => {
  vi.useRealTimers()
  try {
    expect(db().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db().pragma('foreign_key_check')).toEqual([])
  } finally { env.cleanup() }
})

function actor(permissions: string[]) {
  const windowId = ++sequence
  const roleId = createRole({ name: key(), permissions }, env.ctx)
  const username = `actor-${windowId}`
  createUser({ username, password: 'secret123', fullName: 'Operator', roleId }, env.ctx)
  return { windowId, ctx: { session: login(username, 'secret123', windowId).session } }
}
function state(tables: string[]) {
  return Object.fromEntries([...tables, 'audit_log', 'financial_command_requests'].map((table) => [table, db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}
const call = (channel: string, request: unknown, windowId: number) => handlers.get(channel)!({ sender: { id: windowId } } as IpcMainInvokeEvent, request)
function sourceProfit(month: number) {
  vi.setSystemTime(new Date(`2026-${String(month).padStart(2, '0')}-15T12:00:00.000Z`))
  const invoice = createFinalInvoice({ customerId: createCustomer({ name: key() }, env.ctx), depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'Manufactured cabinet', quantityMicro: q(1), unitPriceMinor: m(2000) }] }, env.ctx)
  const orderId = approveToOrder(invoice.id, env.ctx).id
  recordPayment({ orderId, amountMinor: m(1500), cashAccountId: f.account }, env.ctx)
  const sheet = issueWorkSheet({ orderId }, env.ctx)
  startProduction(sheet.id, env.ctx)
  cancelOrder({ orderId, reason: 'Customer cancelled after start' }, env.ctx)
  consumeForOrder({ workSheetId: sheet.id, materialId: f.material, physicalQtyMicro: q(10) }, env.ctx)
  completeProduction(sheet.id, env.ctx)
}

type Prepared = { request: object; run: (ctx: ServiceContext) => unknown; verify: () => void }
type Operation = { name: string; permissions: string[]; channel?: string; tables: string[]; prepare: (phase: number) => Prepared }
const expenseTables = ['expenses', 'cash_transactions']
const purchaseTables = ['purchases', 'purchase_lines', 'supplier_payments', 'cash_transactions', 'fifo_layers', 'fifo_allocations', 'inventory_movements']
const stockTables = ['fifo_layers', 'fifo_allocations', 'inventory_movements', 'material_remainders']
const cashTables = ['cash_accounts', 'cash_transactions']
const savingsTables = ['savings_allocations', 'savings_transactions', 'cash_transactions']
const count = (table: string) => scalar(`SELECT COUNT(*) AS value FROM ${table}`)
function expense() { return expenses.createExpense({ amountMinor: m(200), description: key(), cashAccountId: f.account }, env.ctx) }
function recurring() { return expenses.createRecurringExpense({ description: key(), amountMinor: m(300), startDate: '2099-01-01' }, env.ctx) }
function payment() { return purchasing.paySupplier({ supplierId: f.supplier, purchaseId: f.purchase, amountMinor: m(1000), cashAccountId: f.account }, env.ctx) }
function transferGroup() {
  cash.transfer({ fromAccountId: f.account, toAccountId: f.other, amountMinor: m(500) }, env.ctx)
  return (db().prepare("SELECT transfer_group AS transferGroup FROM cash_transactions WHERE kind = 'transfer_out' ORDER BY id DESC LIMIT 1").get() as { transferGroup: string }).transferGroup
}
function manualMovement() {
  cash.adjustAccountBalance({ accountId: f.account, desiredBalanceMinor: cash.accountBalance(f.account) + m(100), reason: 'Cash count correction' }, env.ctx)
  return scalar("SELECT id AS value FROM cash_transactions WHERE kind = 'balance_adjustment' ORDER BY id DESC LIMIT 1")
}

const operations: Operation[] = [
  { name: 'createExpense', permissions: [P.expenses.manage], channel: C.expenses.create, tables: expenseTables, prepare: () => {
    const request = { amountMinor: m(400), description: key(), cashAccountId: f.account, requestKey: key() }
    const before = cash.accountBalance(f.account)
    return { request, run: ctx => expenses.createExpense(request, ctx), verify: () => { expect(cash.accountBalance(f.account)).toBe(before - m(400)); expect(scalar('SELECT amount_minor AS value FROM expenses ORDER BY id DESC LIMIT 1')).toBe(m(400)) } }
  } },
  { name: 'updateExpense', permissions: [P.expenses.manage], channel: C.expenses.update, tables: expenseTables, prepare: () => {
    const id = expense(); const input = { amountMinor: m(400) }; const before = cash.accountBalance(f.account)
    return { request: { id, ...input }, run: ctx => expenses.updateExpense(id, input, ctx), verify: () => { expect(scalar('SELECT amount_minor AS value FROM expenses WHERE id = ?', id)).toBe(m(400)); expect(cash.accountBalance(f.account)).toBe(before - m(200)) } }
  } },
  { name: 'deleteExpense', permissions: [P.expenses.manage], channel: C.expenses.remove, tables: expenseTables, prepare: () => {
    const id = expense(); const before = cash.accountBalance(f.account)
    return { request: { id }, run: ctx => expenses.deleteExpense(id, ctx), verify: () => { expect(scalar('SELECT COUNT(*) AS value FROM expenses WHERE id = ?', id)).toBe(0); expect(cash.accountBalance(f.account)).toBe(before + m(200)) } }
  } },
  { name: 'createRecurringExpense', permissions: [P.expenses.manage], channel: C.expenses.createRecurring, tables: ['recurring_expenses', 'recurring_expense_amounts', ...expenseTables], prepare: () => {
    const request = { description: key(), amountMinor: m(300), startDate: '2099-01-01', requestKey: key() }; const before = count('recurring_expenses')
    return { request, run: ctx => expenses.createRecurringExpense(request, ctx), verify: () => { expect(count('recurring_expenses')).toBe(before + 1); expect(scalar('SELECT amount_minor AS value FROM recurring_expense_amounts ORDER BY id DESC LIMIT 1')).toBe(m(300)) } }
  } },
  { name: 'updateRecurringExpense', permissions: [P.expenses.manage], channel: C.expenses.updateRecurring, tables: ['recurring_expenses', 'recurring_expense_amounts', ...expenseTables], prepare: () => {
    const id = recurring(); const input = { active: false }
    return { request: { id, ...input }, run: ctx => expenses.updateRecurringExpense(id, input, ctx), verify: () => expect(scalar('SELECT active AS value FROM recurring_expenses WHERE id = ?', id)).toBe(0) }
  } },
  { name: 'changeRecurringExpenseAmount', permissions: [P.expenses.manage], channel: C.expenses.changeRecurringAmount, tables: ['recurring_expenses', 'recurring_expense_amounts', ...expenseTables], prepare: () => {
    const id = recurring(); const input = { amountMinor: m(500), effectiveFrom: '2100-01-01' }
    return { request: { id, ...input }, run: ctx => expenses.changeRecurringExpenseAmount(id, input, ctx), verify: () => expect(scalar('SELECT amount_minor AS value FROM recurring_expense_amounts WHERE recurring_expense_id = ? ORDER BY effective_from DESC LIMIT 1', id)).toBe(m(500)) }
  } },
  { name: 'createPurchase', permissions: [P.purchases.manage], channel: C.purchases.create, tables: purchaseTables, prepare: () => {
    const request = { supplierId: f.supplier, paidNowMinor: m(100), cashAccountId: f.account, requestKey: key(), lines: [{ materialId: f.material, qtyMicro: q(2), unitCostMicro: c(100) }] }; const stock = inventory.availableQty(f.material); const balance = cash.accountBalance(f.account)
    return { request, run: ctx => purchasing.createPurchase(request, ctx), verify: () => { expect(inventory.availableQty(f.material)).toBe(stock + q(2)); expect(cash.accountBalance(f.account)).toBe(balance - m(100)); expect(scalar('SELECT paid_minor AS value FROM purchases ORDER BY id DESC LIMIT 1')).toBe(m(100)) } }
  } },
  { name: 'updatePurchase', permissions: [P.purchases.manage], channel: C.purchases.update, tables: purchaseTables, prepare: phase => {
    const input = { lines: [{ materialId: f.material, qtyMicro: q(phase === 1 ? 8 : 6), unitCostMicro: c(100) }] }; const stock = inventory.availableQty(f.material)
    return { request: { id: f.correction, ...input }, run: ctx => purchasing.updatePurchase(f.correction, input, ctx), verify: () => { expect(inventory.availableQty(f.material)).toBe(stock - q(2)); expect(scalar('SELECT total_minor AS value FROM purchases WHERE id = ?', f.correction)).toBe(m(phase === 1 ? 800 : 600)) } }
  } },
  { name: 'paySupplier', permissions: [P.purchases.paySupplier], channel: C.purchases.pay, tables: purchaseTables, prepare: () => {
    const request = { supplierId: f.supplier, purchaseId: f.purchase, amountMinor: m(1000), cashAccountId: f.account, requestKey: key() }; const before = cash.accountBalance(f.account)
    return { request, run: ctx => purchasing.paySupplier(request, ctx), verify: () => expect(cash.accountBalance(f.account)).toBe(before - m(1000)) }
  } },
  { name: 'updateSupplierPayment', permissions: [P.purchases.editSupplierPayment], channel: C.purchases.updateSupplierPayment, tables: purchaseTables, prepare: () => {
    const id = payment(); const input = { amountMinor: m(600), paidAt: '2026-10-15' }; const before = cash.accountBalance(f.account)
    return { request: { id, ...input }, run: ctx => purchasing.updateSupplierPayment(id, input, ctx), verify: () => { expect(scalar('SELECT amount_minor AS value FROM supplier_payments WHERE id = ?', id)).toBe(m(600)); expect(cash.accountBalance(f.account)).toBe(before + m(400)) } }
  } },
  { name: 'reverseSupplierPayment', permissions: [P.purchases.deleteSupplierPayment], channel: C.purchases.deleteSupplierPayment, tables: purchaseTables, prepare: () => {
    const id = payment(); const before = cash.accountBalance(f.account)
    return { request: { id }, run: ctx => purchasing.reverseSupplierPayment(id, ctx), verify: () => { expect(scalar('SELECT COUNT(*) AS value FROM supplier_payments WHERE id = ?', id)).toBe(0); expect(cash.accountBalance(f.account)).toBe(before + m(1000)) } }
  } },
  { name: 'transfer', permissions: [P.cash.transfer], channel: C.cash.transfer, tables: cashTables, prepare: () => {
    const request = { fromAccountId: f.account, toAccountId: f.other, amountMinor: m(500), requestKey: key() }; const a = cash.accountBalance(f.account); const b = cash.accountBalance(f.other)
    return { request, run: ctx => cash.transfer(request, ctx), verify: () => { expect(cash.accountBalance(f.account)).toBe(a - m(500)); expect(cash.accountBalance(f.other)).toBe(b + m(500)) } }
  } },
  { name: 'updateTransfer', permissions: [P.cash.transfer], channel: C.cash.updateTransfer, tables: cashTables, prepare: () => {
    const group = transferGroup(); const request = { transferGroup: group, fromAccountId: f.account, toAccountId: f.other, amountMinor: m(300) }; const a = cash.accountBalance(f.account); const b = cash.accountBalance(f.other)
    return { request, run: ctx => cash.updateTransfer(request, ctx), verify: () => { expect(cash.getTransfer(group).amountMinor).toBe(m(300)); expect(cash.accountBalance(f.account)).toBe(a + m(200)); expect(cash.accountBalance(f.other)).toBe(b - m(200)) } }
  } },
  { name: 'deleteTransfer', permissions: [P.cash.transfer], channel: C.cash.removeTransfer, tables: cashTables, prepare: () => {
    const group = transferGroup(); const a = cash.accountBalance(f.account); const b = cash.accountBalance(f.other)
    return { request: { transferGroup: group }, run: ctx => cash.deleteTransfer(group, ctx), verify: () => { expect(cash.accountBalance(f.account)).toBe(a + m(500)); expect(cash.accountBalance(f.other)).toBe(b - m(500)) } }
  } },
  { name: 'createAccount', permissions: [P.cash.manage], channel: C.cash.createAccount, tables: cashTables, prepare: () => {
    const request = { name: key(), kind: 'cash' as const, openingBalanceMinor: m(500), requestKey: key() }; const before = count('cash_accounts')
    return { request, run: ctx => cash.createAccount(request, ctx), verify: () => { expect(count('cash_accounts')).toBe(before + 1); expect(scalar('SELECT opening_balance_minor AS value FROM cash_accounts ORDER BY id DESC LIMIT 1')).toBe(m(500)) } }
  } },
  { name: 'updateAccount', permissions: [P.cash.manage], channel: C.cash.updateAccount, tables: cashTables, prepare: () => {
    const id = cash.createAccount({ name: key(), kind: 'cash' }, env.ctx); const input = { openingBalanceMinor: m(500) }
    return { request: { id, ...input }, run: ctx => cash.updateAccount(id, input, ctx), verify: () => expect(cash.accountBalance(id)).toBe(m(500)) }
  } },
  { name: 'deleteAccount', permissions: [P.cash.manage], channel: C.cash.removeAccount, tables: cashTables, prepare: () => {
    const id = cash.createAccount({ name: key(), kind: 'cash' }, env.ctx)
    return { request: { id }, run: ctx => cash.deleteAccount(id, ctx), verify: () => expect(scalar('SELECT COUNT(*) AS value FROM cash_accounts WHERE id = ?', id)).toBe(0) }
  } },
  { name: 'fullDeleteCashAccount', permissions: [P.cash.fullDelete], channel: C.cash.fullDeleteAccount, tables: cashTables, prepare: () => {
    const name = key(); const id = cash.createAccount({ name, kind: 'cash' }, env.ctx); const request = { id, confirmation: name }
    return { request, run: ctx => cash.fullDeleteCashAccount(request, ctx), verify: () => expect(scalar('SELECT COUNT(*) AS value FROM cash_accounts WHERE id = ?', id)).toBe(0) }
  } },
  { name: 'adjustAccountBalance', permissions: [P.cash.manage], channel: C.cash.adjustBalance, tables: cashTables, prepare: () => {
    const request = { accountId: f.account, desiredBalanceMinor: cash.accountBalance(f.account) + m(100), reason: 'Cash count', requestKey: key() }
    return { request, run: ctx => cash.adjustAccountBalance(request, ctx), verify: () => expect(cash.accountBalance(f.account)).toBe(request.desiredBalanceMinor) }
  } },
  { name: 'updateCashMovement', permissions: [P.cash.manage], channel: C.cash.updateTransaction, tables: cashTables, prepare: () => {
    const id = manualMovement(); const request = { id, amountMinor: m(200) }; const before = cash.accountBalance(f.account)
    return { request, run: ctx => cash.updateCashMovement(request, ctx), verify: () => expect(cash.accountBalance(f.account)).toBe(before + m(100)) }
  } },
  { name: 'deleteCashMovement', permissions: [P.cash.manage], channel: C.cash.removeTransaction, tables: cashTables, prepare: () => {
    const id = manualMovement(); const before = cash.accountBalance(f.account)
    return { request: { id }, run: ctx => cash.deleteCashMovement(id, ctx), verify: () => expect(cash.accountBalance(f.account)).toBe(before - m(100)) }
  } },
  { name: 'recordProfitWithdrawal', permissions: [P.withdrawals.manage], channel: C.profit.recordWithdrawal, tables: ['profit_withdrawals', 'cash_transactions'], prepare: phase => {
    if (phase === 1) sourceProfit(10)
    const request = { amountMinor: m(100), cashAccountId: f.account, requestKey: key() }; const before = profit.availableProfitMinor(); const balance = cash.accountBalance(f.account)
    return { request, run: ctx => profit.recordProfitWithdrawal(request, ctx), verify: () => { expect(profit.availableProfitMinor()).toBe(before - m(100)); expect(cash.accountBalance(f.account)).toBe(balance - m(100)) } }
  } },
  { name: 'confirmSavingsAllocation', permissions: [P.savings.manage], channel: C.profit.confirmAllocation, tables: savingsTables, prepare: phase => {
    const month = phase === 1 ? 10 : 11; sourceProfit(month); const request = { year: 2026, month, requestKey: key() }; const before = profit.savingsBalanceMinor()
    return { request, run: ctx => profit.confirmSavingsAllocation(request, ctx), verify: () => expect(profit.savingsBalanceMinor()).toBe(before + m(50)) }
  } },
  { name: 'recordSavingsUsage', permissions: [P.savings.manage], channel: C.profit.recordSavingsUsage, tables: savingsTables, prepare: phase => {
    if (phase === 1) { sourceProfit(10); profit.confirmSavingsAllocation({ year: 2026, month: 10 }, env.ctx) }
    const request = { amountMinor: m(10), cashAccountId: f.account, requestKey: key() }; const before = profit.savingsBalanceMinor(); const balance = cash.accountBalance(f.account)
    return { request, run: ctx => profit.recordSavingsUsage(request, ctx), verify: () => { expect(profit.savingsBalanceMinor()).toBe(before - m(10)); expect(cash.accountBalance(f.account)).toBe(balance + m(10)) } }
  } },
  { name: 'recordWaste', permissions: [P.inventory.waste], channel: C.inventory.waste, tables: stockTables, prepare: () => {
    const request = { materialId: f.material, qtyMicro: q(2), reason: 'Broken boards' }; const stock = inventory.availableQty(f.material)
    return { request, run: ctx => inventory.recordWaste({ ...request, ctx }), verify: () => expect(inventory.availableQty(f.material)).toBe(stock - q(2)) }
  } },
  { name: 'adjustStock', permissions: [P.inventory.adjust], channel: C.inventory.adjust, tables: stockTables, prepare: () => {
    const request = { materialId: f.material, qtyMicro: q(2), direction: 'in' as const, unitCostMicro: c(100), reason: 'Count correction' }; const stock = inventory.availableQty(f.material)
    return { request, run: ctx => inventory.adjustStock({ ...request, unitCost: c(100), ctx }), verify: () => expect(inventory.availableQty(f.material)).toBe(stock + q(2)) }
  } },
  { name: 'recordOpeningStock', permissions: [P.inventory.adjust], tables: stockTables, prepare: () => {
    const request = { materialId: f.material, qtyMicro: q(2), unitCostMicro: c(100) }; const stock = inventory.availableQty(f.material)
    return { request, run: ctx => inventory.recordOpeningStock(request, ctx), verify: () => expect(inventory.availableQty(f.material)).toBe(stock + q(2)) }
  } },
  { name: 'recordRemainder', permissions: [P.inventory.consume], channel: C.inventory.addRemainder, tables: stockTables, prepare: () => {
    const request = { materialId: f.material, sizeMicro: q(1), note: 'Reusable offcut' }; const before = count('material_remainders'); const stock = inventory.availableQty(f.material)
    return { request, run: ctx => inventory.recordRemainder({ ...request, ctx }), verify: () => { expect(count('material_remainders')).toBe(before + 1); expect(inventory.availableQty(f.material)).toBe(stock) } }
  } }
]

for (const scope of ['order', 'worksheet'] as const) {
  for (const kind of ['Materials', 'Machines', 'Workers'] as const) {
    if (scope === 'worksheet' && kind === 'Workers') continue // No supported worksheet worker-plan command.
    const tables = [`planned_${kind.toLowerCase()}`, 'orders', 'work_sheets']
    operations.push({ name: `savePlanned${kind}/${scope}`, permissions: scope === 'order' ? [P.productionPrep.manage, P.orders.view] : [P.worksheets.issue],
      channel: scope === 'order' ? C.orders[`savePlanned${kind}`] : kind === 'Materials' ? C.production.updatePlannedMaterials : undefined,
      tables, prepare: phase => {
        const target = scope === 'order' ? { orderId: f.order } : { workSheetId: f.sheet }
        if (kind === 'Materials') {
          const lines = [{ materialId: f.material, materialName: 'Board', qtyMicro: q(phase), estimatedUnitCostMicro: c(100) }]
          return { request: { ...target, lines }, run: ctx => planning.savePlannedMaterials(target, lines, ctx), verify: () => expect(scalar(`SELECT qty_micro AS value FROM planned_materials WHERE ${scope === 'order' ? 'order_id' : 'work_sheet_id'} = ?`, scope === 'order' ? f.order : f.sheet)).toBe(q(phase)) }
        }
        if (kind === 'Machines') {
          const lines = [{ machineId: f.machine, machineName: 'Machine', usageQtyMicro: q(phase) }]
          return { request: { ...target, lines }, run: ctx => planning.savePlannedMachines(target, lines, ctx), verify: () => expect(scalar(`SELECT estimated_cost_minor AS value FROM planned_machines WHERE ${scope === 'order' ? 'order_id' : 'work_sheet_id'} = ?`, scope === 'order' ? f.order : f.sheet)).toBe(m(10 * phase)) }
        }
        const lines = [{ workerName: 'Worker', estimatedCostMinor: m(100 * phase) }]
        return { request: { ...target, lines }, run: ctx => planning.savePlannedWorkers(target, lines, ctx), verify: () => expect(scalar(`SELECT estimated_cost_minor AS value FROM planned_workers WHERE ${scope === 'order' ? 'order_id' : 'work_sheet_id'} = ?`, scope === 'order' ? f.order : f.sheet)).toBe(m(100 * phase)) }
      } })
  }
}
operations.push({ name: 'savePlannedOrderExpenses', permissions: [P.productionPrep.manage, P.orders.view], channel: C.orders.savePlannedExpenses, tables: ['planned_order_expenses', 'orders'], prepare: phase => {
  const lines = [{ expenseName: 'Production preparation', amountMinor: m(100 * phase) }]
  return { request: { orderId: f.order, lines }, run: ctx => planning.savePlannedOrderExpenses(f.order, lines, ctx), verify: () => expect(scalar('SELECT amount_minor AS value FROM planned_order_expenses WHERE order_id = ?', f.order)).toBe(m(100 * phase)) }
} })

describe('NEW-BL-02 direct service and IPC authorization matrix', () => {
  it.each(operations)('$name rejects direct bypass with zero effects and preserves authorized direct/IPC behavior', async operation => {
    const limited = actor([])
    const authorized = actor(operation.permissions)
    const direct = operation.prepare(1)
    const before = state(operation.tables)
    expect(() => direct.run(limited.ctx)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(state(operation.tables)).toEqual(before)
    if (operation.channel) {
      expect(await call(operation.channel, direct.request, limited.windowId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(state(operation.tables)).toEqual(before)
    }
    direct.run(authorized.ctx)
    direct.verify()
    if (operation.channel) {
      const ipc = operation.prepare(2)
      expect(await call(operation.channel, ipc.request, authorized.windowId)).toMatchObject({ ok: true })
      ipc.verify()
    }
  })

  it.each(['Materials', 'Machines', 'Workers', 'OrderExpenses'] as const)('requires both planning permissions for %s before deleting an existing plan', kind => {
    const limited = actor([P.productionPrep.manage])
    const lines = kind === 'Materials' ? [{ materialName: 'Board', qtyMicro: q(1) }] : []
    const before = state(['planned_materials', 'planned_machines', 'planned_workers', 'planned_order_expenses', 'orders'])
    expect(() => {
      if (kind === 'Materials') planning.savePlannedMaterials({ orderId: f.order }, lines, limited.ctx)
      else if (kind === 'Machines') planning.savePlannedMachines({ orderId: f.order }, [], limited.ctx)
      else if (kind === 'Workers') planning.savePlannedWorkers({ orderId: f.order }, [], limited.ctx)
      else planning.savePlannedOrderExpenses(f.order, [], limited.ctx)
    }).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(state(['planned_materials', 'planned_machines', 'planned_workers', 'planned_order_expenses', 'orders'])).toEqual(before)
  })

  it.each(['recordWaste', 'adjustStock', 'recordRemainder'] as const)('rejects %s with omitted context before any stock effect', name => {
    const before = state(stockTables)
    expect(() => {
      if (name === 'recordWaste') inventory.recordWaste({ materialId: f.material, qtyMicro: q(1), reason: 'Waste' })
      else if (name === 'adjustStock') inventory.adjustStock({ materialId: f.material, qtyMicro: q(1), direction: 'in', reason: 'Correction' })
      else inventory.recordRemainder({ materialId: f.material, sizeMicro: q(1) })
    }).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(state(stockTables)).toEqual(before)
  })

  it('preserves the established purchases.manage fallback for supplier payment and correction permissions', () => {
    const manager = actor([P.purchases.manage])
    const id = purchasing.paySupplier({ supplierId: f.supplier, purchaseId: f.purchase, amountMinor: m(1000), cashAccountId: f.account }, manager.ctx)
    purchasing.updateSupplierPayment(id, { amountMinor: m(600), paidAt: '2026-10-15' }, manager.ctx)
    purchasing.reverseSupplierPayment(id, manager.ctx)
    expect(scalar('SELECT COUNT(*) AS value FROM supplier_payments WHERE id = ?', id)).toBe(0)
  })

  it('keeps authorization ahead of idempotent replay', () => {
    const limited = actor([])
    const request = { amountMinor: m(400), description: 'One expense', cashAccountId: f.account, requestKey: key() }
    const id = expenses.createExpense(request, env.ctx)
    const before = state(expenseTables)
    expect(() => expenses.createExpense(request, limited.ctx)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(state(expenseTables)).toEqual(before)
    expect(expenses.createExpense(request, env.ctx)).toBe(id)
    expect(state(expenseTables)).toEqual(before)
  })
})
