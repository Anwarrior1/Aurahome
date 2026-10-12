import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { businessDate, businessDayBounds, businessMonthBounds } from '@shared/business-date'
import { today } from '@main/services/base/service.types'
import { todayIso } from '@renderer/lib/format'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { createExpense, createRecurringExpense, materializeDueRecurringExpenses, scheduledRecurringOccurrences } from '@main/services/finance/expenses.service'
import { monthlyProfitSummary, cumulativeNetProfitMinor, recordProfitWithdrawal } from '@main/services/finance/profit.service'
import { buildReport } from '@main/services/reports/reports.service'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { createSupplier, createCustomer } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase, paySupplier } from '@main/services/purchasing/purchasing.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { approveToOrder } from '../helpers/sales-flow'
import { recordPayment } from '@main/services/sales/orders.service'
import { issueRelease, recordDelivery } from '@main/services/production/production.service'
import { createEmployee, paySalary } from '@main/services/hr/employees.service'
import { createWorker, recordWorkerTransaction } from '@main/services/production/workers.service'
import { createRole, createUser, listAuditLog } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
let priorTz: string | undefined
const atMidnight = () => vi.setSystemTime(new Date('2026-09-30T22:30:00.000Z'))
const row = (query: string) => getRawConnection().prepare(query).get() as Record<string, unknown>
const count = (table: string) => Number(row(`SELECT COUNT(*) AS n FROM ${table}`).n)

beforeEach(() => {
  priorTz = process.env.TZ
  process.env.TZ = 'Africa/Tripoli'
  env = setupTestDatabase()
  vi.useFakeTimers({ toFake: ['Date'] })
  atMidnight()
})
afterEach(() => {
  vi.useRealTimers()
  try {
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  } finally {
    env.cleanup()
    if (priorTz === undefined) delete process.env.TZ
    else process.env.TZ = priorTz
  }
})

describe('BL-22 factory-local business calendar', () => {
  it('uses local today and exact UTC boundaries, including previous day and year rollover', () => {
    expect(today()).toBe('2026-10-01')
    expect(todayIso()).toBe('2026-10-01')
    expect(businessDate()).toBe('2026-10-01')
    expect(businessDayBounds('2026-10-01')).toEqual({ from: '2026-09-30T22:00:00.000Z', to: '2026-10-01T21:59:59.999Z' })
    expect(businessMonthBounds(2026, 10)).toMatchObject({ from: '2026-09-30T22:00:00.000Z', to: '2026-10-31T21:59:59.999Z', fromDate: '2026-10-01', toDate: '2026-10-31' })
    vi.setSystemTime(new Date('2026-09-30T21:30:00.000Z'))
    expect(today()).toBe('2026-09-30')
    expect(todayIso()).toBe('2026-09-30')
    vi.setSystemTime(new Date('2026-12-31T22:30:00.000Z'))
    expect(today()).toBe('2027-01-01')
    expect(businessMonthBounds(2027, 1).from).toBe('2026-12-31T22:00:00.000Z')
  })

  it('dates expense, cash, Dashboard and reports to October; explicit date remains unchanged', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: m(2000) }, env.ctx)
    const id = createExpense({ description: 'إصلاح المصنع', amountMinor: m(400), cashAccountId: accountId }, env.ctx)
    expect(row(`SELECT spent_at AS d, created_at AS instant FROM expenses WHERE id=${id}`)).toMatchObject({ d: '2026-10-01', instant: '2026-09-30T22:30:00.000Z' })
    expect(row(`SELECT occurred_at AS d FROM cash_transactions WHERE ref_table='expenses' AND ref_id=${id}`).d).toBe('2026-10-01')
    expect(row(`SELECT created_at AS instant FROM audit_log WHERE action='expenses.create' ORDER BY id DESC LIMIT 1`).instant).toBe('2026-09-30T22:30:00.000Z')
    expect(listAuditLog({ action: 'expenses.create', from: '2026-10-01', to: '2026-10-01' }).items).toHaveLength(1)
    expect(listAuditLog({ action: 'expenses.create', from: '2026-09-30', to: '2026-09-30' }).items).toHaveLength(0)
    expect(accountBalance(accountId)).toBe(m(1600))
    expect(accountBalance(accountId, '2026-09-30')).toBe(m(2000))
    expect(accountBalance(accountId, '2026-10-01')).toBe(m(1600))
    expect(monthlyProfitSummary(2026, 9).generalExpensesMinor).toBe(0)
    expect(monthlyProfitSummary(2026, 10).generalExpensesMinor).toBe(m(400))
    expect((dashboardSummary({ date: '2026-10-01', year: 2026, month: 10, currentDay: true }, env.ctx.session).costs as { dayExpensesMinor: number }).dayExpensesMinor).toBe(m(400))
    expect((dashboardSummary({ date: '2026-09-30', year: 2026, month: 9, currentDay: false }, env.ctx.session).costs as { dayExpensesMinor: number }).dayExpensesMinor).toBe(0)
    expect(buildReport({ key: 'expenses', from: '2026-10-01', to: '2026-10-01' }).rows).toHaveLength(1)
    expect(buildReport({ key: 'expenses', from: '2026-09-30', to: '2026-09-30' }).rows).toHaveLength(0)
    expect(buildReport({ key: 'monthly_profit' }).title).toContain('10/2026')
    const explicit = createExpense({ description: 'مؤرخ يدوياً', amountMinor: m(50), spentAt: '2026-10-01', cashAccountId: accountId }, env.ctx)
    expect(row(`SELECT spent_at AS d FROM expenses WHERE id=${explicit}`).d).toBe('2026-10-01')
  })

  it('dates purchase and FIFO history locally without altering quantity or cost', () => {
    const categoryId = createCategory({ name: 'خشب' }, env.ctx)
    const materialId = createMaterial({ sku: 'BL22-BOARD', name: 'لوح', categoryId, unit: 'لوح', currentMarketPriceMicro: c(100), pricingRule: 'exact' } as never, env.ctx)
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const purchase = createPurchase({ supplierId, lines: [{ materialId, qtyMicro: q(10), unitCostMicro: c(100) }] }, env.ctx)
    expect(row(`SELECT purchase_date AS d FROM purchases WHERE id=${purchase.id}`).d).toBe('2026-10-01')
    expect(row(`SELECT received_at AS d, qty_remaining_micro AS qty, unit_cost_micro AS cost FROM fifo_layers WHERE material_id=${materialId}`)).toMatchObject({ d: '2026-09-30T22:00:00.000Z', qty: q(10), cost: c(100) })
    expect(row(`SELECT created_at AS d FROM inventory_movements WHERE material_id=${materialId}`).d).toBe('2026-09-30T22:00:00.000Z')
    expect(availableQty(materialId)).toBe(q(10))
    expect(buildReport({ key: 'purchases', from: '2026-10-01', to: '2026-10-01' }).rows).toHaveLength(1)
    expect(buildReport({ key: 'purchases', from: '2026-09-30', to: '2026-09-30' }).rows).toHaveLength(0)
  })

  it('defaults supplier, customer, salary and worker cash business dates without changing amounts', () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: m(10000) }, env.ctx)
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const invoice = createFinalInvoice({ customerId, lines: [{ lineKind: 'custom', description: 'خزانة', quantityMicro: q(1), unitPriceMinor: m(1500) }] }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    const employeeId = createEmployee({ name: 'موظف', monthlySalaryMinor: m(1000), hiredAt: '2026-09-01' }, env.ctx)
    const workerId = createWorker({ name: 'عامل' }, env.ctx)
    paySupplier({ supplierId, amountMinor: m(100), cashAccountId: accountId }, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: m(200), cashAccountId: accountId }, env.ctx)
    paySalary({ employeeId, periodYear: 2026, periodMonth: 9, amountMinor: m(300), cashAccountId: accountId }, env.ctx)
    recordWorkerTransaction({ workerId, kind: 'withdrawal', amountMinor: m(50), cashAccountId: accountId }, env.ctx)
    expect(row('SELECT paid_at AS d FROM supplier_payments ORDER BY id DESC LIMIT 1').d).toBe('2026-10-01')
    expect(row('SELECT paid_at AS d FROM customer_payments ORDER BY id DESC LIMIT 1').d).toBe('2026-10-01')
    expect(row("SELECT spent_at AS d FROM expenses WHERE source='salary' ORDER BY id DESC LIMIT 1").d).toBe('2026-10-01')
    expect(row("SELECT occurred_at AS d FROM cash_transactions WHERE kind='worker_withdrawal' ORDER BY id DESC LIMIT 1").d).toBe('2026-10-01')
    expect(row("SELECT created_at AS d FROM worker_transactions WHERE kind='withdrawal' ORDER BY id DESC LIMIT 1").d).toBe('2026-09-30T22:30:00.000Z')
    expect(accountBalance(accountId)).toBe(m(9750))
  })

  it('posts October recurring rent at local month start and keeps read derivation pure', () => {
    createRecurringExpense({ description: 'إيجار', amountMinor: m(300), startDate: '2026-10-01' }, env.ctx)
    const before = ['expenses', 'cash_transactions', 'audit_log'].map(count)
    expect(scheduledRecurringOccurrences('2026-10-01', '2026-10-01')).toHaveLength(1)
    expect(monthlyProfitSummary(2026, 10).generalExpensesMinor).toBe(m(300))
    expect(['expenses', 'cash_transactions', 'audit_log'].map(count)).toEqual(before)
    expect(materializeDueRecurringExpenses()).toEqual({ created: 1 })
    expect(materializeDueRecurringExpenses()).toEqual({ created: 0 })
    expect(row("SELECT spent_at AS d FROM expenses WHERE source='recurring' LIMIT 1").d).toBe('2026-10-01')
    expect(scheduledRecurringOccurrences('2026-10-01', '2026-10-01')).toHaveLength(0)
    expect(monthlyProfitSummary(2026, 10).generalExpensesMinor).toBe(m(300))
  })

  it('attributes local-October completion to October, retains UTC instant, and dates profit withdrawal locally', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const invoice = createFinalInvoice({ customerId, lines: [{ lineKind: 'custom', description: 'خزانة', quantityMicro: q(1), unitPriceMinor: m(1500) }] }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    const release = issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
    recordDelivery({ orderId: order.id, releaseId: release.id, kind: 'delivery' }, env.ctx)
    expect(row(`SELECT status, completed_at AS d FROM orders WHERE id=${order.id}`)).toMatchObject({ status: 'completed', d: '2026-09-30T22:30:00.000Z' })
    expect(monthlyProfitSummary(2026, 9).revenueMinor).toBe(0)
    expect(monthlyProfitSummary(2026, 10).revenueMinor).toBe(m(1500))
    expect((dashboardSummary({ date: '2026-10-01', year: 2026, month: 10, currentDay: true }, env.ctx.session).orders as { dayCount: number }).dayCount).toBe(1)
    expect((dashboardSummary({ date: '2026-09-30', year: 2026, month: 9, currentDay: false }, env.ctx.session).orders as { dayCount: number }).dayCount).toBe(0)
    expect(buildReport({ key: 'sales', from: '2026-10-01', to: '2026-10-01' }).rows).toHaveLength(1)
    expect(buildReport({ key: 'sales', from: '2026-09-30', to: '2026-09-30' }).rows).toHaveLength(0)
    expect(buildReport({ key: 'order_profitability', from: '2026-10-01', to: '2026-10-01' }).rows).toHaveLength(1)
    expect(buildReport({ key: 'order_profitability', from: '2026-09-30', to: '2026-09-30' }).rows).toHaveLength(0)
    expect(buildReport({ key: 'order_costs', from: '2026-10-01', to: '2026-10-01' }).rows).toHaveLength(1)
    expect(cumulativeNetProfitMinor()).toBe(m(1500))
    const withdrawal = recordProfitWithdrawal({ amountMinor: m(50), requestKey: 'bl22-withdrawal-once' }, env.ctx)
    expect(row(`SELECT withdrawn_at AS d FROM profit_withdrawals WHERE id=${withdrawal.id}`).d).toBe('2026-10-01')
    expect(recordProfitWithdrawal({ amountMinor: m(50), requestKey: 'bl22-withdrawal-once' }, env.ctx)).toEqual(withdrawal)
    expect(count('profit_withdrawals')).toBe(1)
    expect(row(`SELECT status FROM orders WHERE id=${order.id}`).status).toBe('completed')
  })

  it('keeps expense IPC permission, idempotency and audit-failure rollback', async () => {
    const accountId = createAccount({ name: 'الصندوق', kind: 'cash', openingBalanceMinor: m(2000) }, env.ctx)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    const roleId = createRole({ name: 'BL22-viewer', permissions: [P.expenses.view] }, env.ctx)
    createUser({ username: 'bl22-viewer', password: 'secret123', fullName: 'Viewer', roleId }, env.ctx)
    login('bl22-viewer', 'secret123', 22001)
    const viewer = { sender: { id: 22001 } } as IpcMainInvokeEvent
    const owner = { sender: { id: 1 } } as IpcMainInvokeEvent
    const invoke = (event: IpcMainInvokeEvent, input: unknown) => handlers.get(IPC_CHANNELS.expenses.create)!(event, input)
    const input = { description: 'إصلاح المصنع', amountMinor: m(400), cashAccountId: accountId, requestKey: 'bl22-expense-once' }
    const denied = await invoke(viewer, input)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.code).toBe('FORBIDDEN')
    const before = ['expenses', 'cash_transactions', 'audit_log'].map(count)
    getRawConnection().exec("CREATE TRIGGER bl22_fail_audit BEFORE INSERT ON audit_log WHEN NEW.action='expenses.create' BEGIN SELECT RAISE(ABORT,'forced rollback'); END")
    expect((await invoke(owner, input)).ok).toBe(false)
    expect(['expenses', 'cash_transactions', 'audit_log'].map(count)).toEqual(before)
    getRawConnection().exec('DROP TRIGGER bl22_fail_audit')
    const accepted = await invoke(owner, input)
    expect(accepted.ok).toBe(true)
    expect(await invoke(owner, input)).toEqual(accepted)
    expect(count('expenses')).toBe(1)
    expect(row('SELECT spent_at AS d FROM expenses LIMIT 1').d).toBe('2026-10-01')
    expect(accountBalance(accountId)).toBe(m(1600))
  })
})
