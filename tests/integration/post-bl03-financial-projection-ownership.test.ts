import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { reconcileDatabase } from '@main/db/reconciliation'
import { login } from '@main/auth/auth.service'
import * as cash from '@main/services/finance/cash.service'
import * as expenses from '@main/services/finance/expenses.service'
import * as employees from '@main/services/hr/employees.service'
import * as workers from '@main/services/production/workers.service'
import * as production from '@main/services/production/production.service'
import * as purchasing from '@main/services/purchasing/purchasing.service'
import * as parties from '@main/services/parties/parties.service'
import * as invoices from '@main/services/sales/final-invoices.service'
import * as orders from '@main/services/sales/orders.service'
import * as admin from '@main/services/admin/users.service'
import * as profit from '@main/services/finance/profit.service'
import type { ServiceContext } from '@main/services/base/service.types'
import { readFileSync } from 'node:fs'

let env: TestEnv
let account: number
let employee: number
let order: number
let restricted: { ctx: ServiceContext; windowId: number }
let cashActor: { ctx: ServiceContext; windowId: number }
let handlers: Map<
  string,
  (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>
>
const db = () => getRawConnection()
const scalar = (query: string, ...args: (number | string)[]) =>
  (
    db()
      .prepare(query)
      .get(...args) as { n: number }
  ).n
function snapshot() {
  const tables = db()
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as { name: string }[]
  return Object.fromEntries(
    tables.map(({ name }) => [name, db().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
  )
}
function actor(name: string, permissions: string[], windowId: number) {
  const roleId = admin.createRole({ name, permissions }, env.ctx)
  admin.createUser({ username: name, fullName: name, password: 'secret123', roleId }, env.ctx)
  return { ctx: { session: login(name, 'secret123', windowId).session }, windowId }
}
function newOrder() {
  const customerId = parties.createCustomer({ name: 'customer' }, env.ctx)
  return approveToOrder(
    invoices.createFinalInvoice(
      {
        customerId,
        depositPercentBp: 0,
        termIndexes: [],
        lines: [
          {
            lineKind: 'custom',
            description: 'Cabinet',
            quantityMicro: 1000000,
            unitPriceMinor: m(10000)
          }
        ]
      },
      env.ctx
    ).id,
    env.ctx
  ).id
}
beforeEach(async () => {
  env = setupTestDatabase()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'))
  account = cash.createAccount(
    { name: 'cash', kind: 'cash', openingBalanceMinor: m(10000) },
    env.ctx
  )
  employee = employees.createEmployee(
    { name: 'employee', monthlySalaryMinor: m(1000), hiredAt: '2026-09-01' },
    env.ctx
  )
  order = newOrder()
  restricted = actor('restricted', [], 73001)
  cashActor = actor('cash-operator', [P.cash.manage, P.cash.transfer], 73002)
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi
    .spyOn(electron.ipcMain, 'handle')
    .mockImplementation(((name: string, handler: never) => handlers.set(name, handler)) as never)
  try {
    (await import('@main/ipc/router')).registerIpcRouter()
  } finally {
    spy.mockRestore()
  }
})
afterEach(() => {
  vi.useRealTimers()
  env.cleanup()
})
const ipc = (channel: string, input: unknown, windowId = 1) =>
  handlers.get(channel)!({ sender: { id: windowId } } as IpcMainInvokeEvent, input)
function payment() {
  orders.recordPayment(
    { orderId: order, amountMinor: m(1000), cashAccountId: account, paidAt: '2026-10-15' },
    env.ctx
  )
  return scalar('SELECT id AS n FROM customer_payments WHERE order_id=?', order)
}
function salary() {
  return employees.paySalary(
    {
      employeeId: employee,
      amountMinor: m(1000),
      periodYear: 2026,
      periodMonth: 10,
      cashAccountId: account,
      paidAt: '2026-10-15'
    },
    env.ctx
  )
}
function deliveredRevenue() {
  orders.recordPayment({ orderId: order, amountMinor: m(10000), cashAccountId: account }, env.ctx)
  const sheet = production.issueWorkSheet({ orderId: order }, env.ctx)
  production.completeProduction(sheet.id, env.ctx)
  const permit = production.issueRelease({ orderId: order, kind: 'delivery' }, env.ctx)
  production.recordDelivery({ orderId: order, releaseId: permit.id, kind: 'handover' }, env.ctx)
}
function source(event: string): { table: string; id: number } {
  switch (event) {
    case 'payment':
      return { table: 'customer_payments', id: payment() }
    case 'refund':
      payment()
      return {
        table: 'customer_payment_refunds',
        id: orders.refundPayment(
          {
            orderId: order,
            amountMinor: m(300),
            cashAccountId: account,
            refundedAt: '2026-10-15',
            requestKey: 'refund-test'
          },
          env.ctx
        ).refundId
      }
    case 'salary':
      return { table: 'employee_transactions', id: salary().transactionId }
    case 'advance':
      return {
        table: 'employee_transactions',
        id: employees.recordEmployeeTransaction(
          {
            employeeId: employee,
            kind: 'advance',
            amountMinor: m(1000),
            cashAccountId: account,
            occurredAt: '2026-10-15'
          },
          env.ctx
        )
      }
    case 'supplier':
      return {
        table: 'supplier_payments',
        id: purchasing.paySupplier(
          {
            supplierId: parties.createSupplier({ name: 'supplier' }, env.ctx),
            amountMinor: m(1000),
            cashAccountId: account,
            paidAt: '2026-10-15'
          },
          env.ctx
        )
      }
    case 'expense':
      return {
        table: 'expenses',
        id: expenses.createExpense(
          {
            amountMinor: m(1000),
            description: 'expense',
            cashAccountId: account,
            spentAt: '2026-10-15'
          },
          env.ctx
        )
      }
    case 'worker':
      return {
        table: 'worker_transactions',
        id: workers.recordWorkerTransaction(
          {
            workerId: workers.createWorker({ name: 'worker' }, env.ctx),
            kind: 'withdrawal',
            amountMinor: m(1000),
            cashAccountId: account,
            occurredAt: '2026-10-15'
          },
          env.ctx
        )
      }
    default:
      throw new Error(event)
  }
}
function mirror(table: string, id: number) {
  return db()
    .prepare(
      `SELECT id, account_id AS accountId, direction, amount_minor AS amountMinor, kind,
    ref_table AS refTable, ref_id AS refId, occurred_at AS occurredAt FROM cash_transactions
    WHERE ref_table=? AND ref_id=? AND reversal_of_id IS NULL`
    )
    .get(table, id) as {
    id: number
    accountId: number
    direction: 'in' | 'out'
    amountMinor: number
    kind: string
    refTable: string
    refId: number
    occurredAt: string
  }
}
const conflict = expect.objectContaining({ code: 'CONFLICT' })
describe('source-backed cash mirrors', () => {
  for (const event of ['payment', 'refund', 'salary', 'advance', 'supplier', 'expense', 'worker']) {
    for (const attack of [
      'remove',
      'amount',
      'duplicate',
      'account',
      'date',
      'forged-manual',
      'forged-transfer',
      'forged-reversal'
    ]) {
      it(`${event}: independent ${attack} rejected naked and inside caller transaction, without side effects`, () => {
        const { table, id } = source(event)
        const row = mirror(table, id)
        const other = cash.createAccount({ name: 'other', kind: 'bank' }, env.ctx)
        const before = snapshot()
        const call = () => {
          if (attack === 'remove') cash.removeCashMovementForRef(table, id)
          if (attack === 'amount')
            cash.adjustCashMovementForRef(table, id, { amountMinor: m(2000) })
          if (attack === 'account') cash.adjustCashMovementForRef(table, id, { accountId: other })
          if (attack === 'date')
            cash.adjustCashMovementForRef(table, id, { occurredAt: '2027-01-01' })
          if (attack === 'duplicate') cash.postCashMovement({ ...row, ctx: cashActor.ctx })
          if (attack === 'forged-manual')
            cash.postCashMovement({
              ...row,
              refTable: undefined,
              refId: undefined,
              kind: 'balance_adjustment',
              ctx: env.ctx
            })
          if (attack === 'forged-transfer')
            cash.postCashMovement({ ...row, transferGroup: 'forged', ctx: env.ctx })
          if (attack === 'forged-reversal')
            cash.postCashMovement({
              ...row,
              direction: row.direction === 'in' ? 'out' : 'in',
              reversalOfId: row.id,
              kind: 'salary_reversal',
              ctx: env.ctx
            })
        }
        expect(() => call()).toThrowError(conflict)
        expect(() => withTransaction(call)).toThrowError(conflict)
        withTransaction(() => {
          expect(() => call()).toThrowError(conflict)
        }) // caught failure cannot persist
        expect(snapshot()).toEqual(before)
        expect(reconcileDatabase(db()).findings).toEqual([])
        expect(db().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
        expect(db().pragma('foreign_key_check')).toEqual([])
      })
    }
  }
  it('the exact 1000 LYD payment stays source=1000, paid=1000, cash=opening+1000 after restricted replay', () => {
    const id = payment()
    const row = mirror('customer_payments', id)
    const before = snapshot()
    for (let retry = 0; retry < 3; retry++) {
      expect(() =>
        withTransaction(() => cash.postCashMovement({ ...row, ctx: restricted.ctx }))
      ).toThrowError(conflict)
      expect(() =>
        withTransaction(() => cash.removeCashMovementForRef('customer_payments', id))
      ).toThrowError(conflict)
      expect(() =>
        withTransaction(() =>
          cash.adjustCashMovementForRef('customer_payments', id, { amountMinor: m(2000) })
        )
      ).toThrowError(conflict)
    }
    expect(snapshot()).toEqual(before)
    expect(scalar('SELECT amount_minor AS n FROM customer_payments WHERE id=?', id)).toBe(m(1000))
    expect(orders.getOrder(order).order.paidMinor).toBe(m(1000))
    expect(cash.accountBalance(account)).toBe(m(11000))
  })
  it('generic manual update/delete reject source-backed rows even for cash-authorized users', async () => {
    const row = mirror('customer_payments', payment())
    const before = snapshot()
    expect(() =>
      cash.updateCashMovement({ id: row.id, amountMinor: m(2000) }, cashActor.ctx)
    ).toThrowError(conflict)
    expect(() => cash.deleteCashMovement(row.id, cashActor.ctx)).toThrowError(conflict)
    expect(
      await ipc(C.cash.updateTransaction, { id: row.id, amountMinor: m(2000) }, cashActor.windowId)
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(await ipc(C.cash.removeTransaction, { id: row.id }, restricted.windowId)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' }
    })
    expect(snapshot()).toEqual(before)
  })
})

describe('payroll owner and legitimate source corrections', () => {
  it('salary expense helper is module-private with paySalary as its sole caller, no old export or IPC alias', () => {
    expect(Object.hasOwn(expenses, 'createSalaryExpense')).toBe(false)
    expect(Object.hasOwn(employees, 'createSalaryExpense')).toBe(false)
    const payroll = readFileSync('src/main/services/hr/employees.service.ts', 'utf8')
    expect(payroll).toContain('function createSalaryExpense(')
    expect(payroll).not.toContain('export function createSalaryExpense')
    expect(payroll.match(/createSalaryExpense\(/g)).toHaveLength(2)
    expect(readFileSync('src/main/ipc/router.ts', 'utf8')).not.toContain('createSalaryExpense')
    expect(() =>
      employees.paySalary(
        {
          employeeId: employee,
          amountMinor: m(1000),
          periodYear: 2026,
          periodMonth: 10,
          cashAccountId: account
        },
        restricted.ctx
      )
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
  })
  it('salary source, locked expense and cash agree; legitimate reversal is atomic and replay rejected', () => {
    const s = salary()
    expect(s.netPaidMinor).toBe(m(1000))
    expect(cash.accountBalance(account)).toBe(m(9000))
    expect(scalar('SELECT amount_minor AS n FROM expenses WHERE id=?', s.expenseId)).toBe(m(1000))
    expect(() =>
      withTransaction(() =>
        cash.postCashMovement({
          ...mirror('employee_transactions', s.transactionId),
          refTable: 'expenses',
          refId: s.expenseId,
          kind: 'expense',
          ctx: env.ctx
        })
      )
    ).toThrowError(conflict)
    employees.reverseSalaryPayment(s.transactionId, env.ctx)
    expect(cash.accountBalance(account)).toBe(m(10000))
    expect(
      scalar(
        'SELECT COUNT(*) AS n FROM employee_transactions WHERE id=? AND reversed_at IS NOT NULL',
        s.transactionId
      )
    ).toBe(1)
    expect(
      scalar(
        'SELECT COUNT(*) AS n FROM expenses WHERE id=? AND reversed_at IS NOT NULL',
        s.expenseId
      )
    ).toBe(1)
    const before = snapshot()
    expect(() => employees.reverseSalaryPayment(s.transactionId, env.ctx)).toThrowError(conflict)
    const original = mirror('employee_transactions', s.transactionId)
    expect(() =>
      withTransaction(() =>
        cash.postCashMovement({
          ...original,
          direction: 'in',
          kind: 'salary_reversal',
          reversalOfId: original.id,
          ctx: env.ctx
        })
      )
    ).toThrowError(conflict)
    expect(snapshot()).toEqual(before)
    expect(reconcileDatabase(db()).findings).toEqual([])
  })
  it('pre-start legacy payment reversal changes payment, paid state and cash together', () => {
    const id = payment()
    orders.reverseCustomerPayment(id, env.ctx)
    expect(orders.getOrder(order).order.paidMinor).toBe(0)
    expect(cash.accountBalance(account)).toBe(m(10000))
    expect(scalar('SELECT COUNT(*) AS n FROM customer_payments')).toBe(0)
    expect(reconcileDatabase(db()).findings).toEqual([])
  })
  it('actual manufacturing start still blocks refund and legacy reversal', () => {
    const id = payment()
    production.startProduction(production.issueWorkSheet({ orderId: order }, env.ctx).id, env.ctx)
    const before = snapshot()
    expect(() => orders.reverseCustomerPayment(id, env.ctx)).toThrowError(conflict)
    expect(() =>
      orders.refundPayment(
        {
          orderId: order,
          amountMinor: m(1000),
          cashAccountId: account,
          requestKey: 'blocked-refund'
        },
        env.ctx
      )
    ).toThrowError(conflict)
    expect(snapshot()).toEqual(before)
  })
  it('expense correction moves one mirror to its changed source, then source-owned deletion restores cash', () => {
    const { id } = source('expense')
    expenses.updateExpense(id, { amountMinor: m(300), spentAt: '2026-10-16' }, env.ctx)
    expect(mirror('expenses', id).amountMinor).toBe(m(300))
    expect(mirror('expenses', id).occurredAt).toBe('2026-10-16')
    expenses.deleteExpense(id, env.ctx)
    expect(cash.accountBalance(account)).toBe(m(10000))
    expect(reconcileDatabase(db()).findings).toEqual([])
  })
  it('supplier correction and reversal keep the source and mirror consistent', () => {
    const { id } = source('supplier')
    purchasing.updateSupplierPayment(id, { amountMinor: m(300), paidAt: '2026-10-16' }, env.ctx)
    expect(mirror('supplier_payments', id).amountMinor).toBe(m(300))
    purchasing.reverseSupplierPayment(id, env.ctx)
    expect(cash.accountBalance(account)).toBe(m(10000))
    expect(reconcileDatabase(db()).findings).toEqual([])
  })
  for (const event of ['recurring', 'commission', 'withdrawal', 'savings']) {
    it(`${event}: legitimate source owner works while independent cash mutation is rejected`, () => {
      let table: string
      let id: number
      if (event === 'recurring') {
        expenses.createRecurringExpense(
          {
            description: 'rent',
            amountMinor: m(1000),
            startDate: '2026-10-01',
            cashAccountId: account
          },
          env.ctx
        )
        expenses.materializeDueRecurringExpenses()
        table = 'expenses'
        id = scalar("SELECT id AS n FROM expenses WHERE source='recurring'")
      } else if (event === 'commission') {
        const worker = workers.createWorker({ name: 'named worker' }, env.ctx)
        const sheet = production.issueWorkSheet({ orderId: order }, env.ctx)
        workers.assignWorkerToOrder(
          { workSheetId: sheet.id, workerId: worker, method: 'fixed', amountMinor: m(1000) },
          env.ctx
        )
        production.completeProduction(sheet.id, env.ctx)
        expect(workers.workerBalances(worker).payableMinor).toBe(m(1000))
        id = workers.payWorkerCommission(
          { workerId: worker, amountMinor: m(1000), cashAccountId: account },
          env.ctx
        )
        expect(workers.workerBalances(worker).payableMinor).toBe(0)
        expect(scalar("SELECT COUNT(*) AS n FROM worker_transactions WHERE kind='earning'")).toBe(1)
        table = 'worker_transactions'
      } else {
        deliveredRevenue()
        if (event === 'withdrawal') {
          id = profit.recordProfitWithdrawal(
            { amountMinor: m(1000), cashAccountId: account },
            env.ctx
          ).id
          table = 'profit_withdrawals'
        } else {
          profit.confirmSavingsAllocation({ year: 2026, month: 10 }, env.ctx)
          id = profit.recordSavingsUsage({ amountMinor: m(1000), cashAccountId: account }, env.ctx)
          table = 'savings_transactions'
        }
      }
      const row = mirror(table, id)
      const before = snapshot()
      expect(() => withTransaction(() => cash.removeCashMovementForRef(table, id))).toThrowError(
        conflict
      )
      expect(() =>
        withTransaction(() => cash.adjustCashMovementForRef(table, id, { amountMinor: m(2000) }))
      ).toThrowError(conflict)
      expect(() =>
        withTransaction(() => cash.postCashMovement({ ...row, ctx: cashActor.ctx }))
      ).toThrowError(conflict)
      expect(snapshot()).toEqual(before)
      const findings = reconcileDatabase(db()).findings
      if (event === 'commission') {
        // CC04: this manufacturing-linked earning and its payment must reconcile cleanly.
        expect(findings.map((x) => [x.code, x.entity])).toEqual([])
      } else expect(findings).toEqual([])
    })
  }
})

describe('owning transaction and IPC preservation', () => {
  const commands = {
    payment: {
      action: 'orders.payment',
      channel: C.orders.recordPayment,
      input: () => ({
        orderId: order,
        amountMinor: m(1000),
        cashAccountId: account,
        requestKey: 'postbl03-payment-key'
      }),
      direct: () =>
        orders.recordPayment(
          { orderId: order, amountMinor: m(1000), cashAccountId: account },
          env.ctx
        )
    },
    salary: {
      action: 'employees.paySalary',
      channel: C.employees.paySalary,
      input: () => ({
        employeeId: employee,
        amountMinor: m(1000),
        periodYear: 2026,
        periodMonth: 10,
        cashAccountId: account,
        requestKey: 'postbl03-salary-key'
      }),
      direct: () => salary()
    }
  }
  for (const [name, command] of Object.entries(commands)) {
    for (const failAt of ['audit', 'projection']) {
      for (const entry of ['direct', 'IPC']) {
        it(`${name} ${entry}: ${failAt} failure rolls back source/projection/audit, then retry applies once`, async () => {
          const before = snapshot()
          const table = failAt === 'audit' ? 'audit_log' : 'cash_transactions'
          const predicate =
            failAt === 'audit'
              ? `NEW.action = '${command.action}'`
              : `NEW.kind = '${name === 'payment' ? 'customer_payment' : 'salary'}'`
          db().exec(
            `CREATE TEMP TRIGGER postbl03_fail BEFORE INSERT ON ${table} WHEN ${predicate} BEGIN SELECT RAISE(ABORT, 'forced POSTBL03 failure'); END`
          )
          try {
            if (entry === 'direct')
              expect(() => command.direct()).toThrowError('forced POSTBL03 failure')
            else
              expect(await ipc(command.channel, command.input())).toMatchObject({
                ok: false,
                error: { code: 'INTERNAL_ERROR' }
              })
          } finally {
            db().exec('DROP TRIGGER postbl03_fail')
          }
          expect(snapshot()).toEqual(before)
          if (entry === 'direct') command.direct()
          else expect(await ipc(command.channel, command.input())).toMatchObject({ ok: true })
          expect(cash.accountBalance(account)).toBe(m(name === 'payment' ? 11000 : 9000))
          expect(scalar('SELECT COUNT(*) AS n FROM audit_log WHERE action=?', command.action)).toBe(
            1
          )
          expect(reconcileDatabase(db()).findings).toEqual([])
        })
      }
    }
    it(`${name}: inner success and required audit roll back with caller's outer failure`, () => {
      const before = snapshot()
      expect(() =>
        withTransaction(() => {
          command.direct()
          throw new Error('outer failure')
        })
      ).toThrowError('outer failure')
      expect(snapshot()).toEqual(before)
    })
    it(`${name}: restricted direct and real registered IPC remain FORBIDDEN`, async () => {
      const before = snapshot()
      const call = () =>
        name === 'payment'
          ? orders.recordPayment(command.input(), restricted.ctx)
          : employees.paySalary(
              {
                employeeId: employee,
                amountMinor: m(1000),
                periodYear: 2026,
                periodMonth: 10,
                cashAccountId: account
              },
              restricted.ctx
            )
      expect(call).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
      expect(() => withTransaction(call)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN' })
      )
      expect(await ipc(command.channel, command.input(), restricted.windowId)).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' }
      })
      expect(snapshot()).toEqual(before)
    })
  }
  it('standalone manual cash adjustments, corrections/deletion and grouped transfers remain operational', () => {
    cash.adjustAccountBalance(
      { accountId: account, desiredBalanceMinor: m(11000), reason: 'manual' },
      cashActor.ctx
    )
    const id = scalar('SELECT id AS n FROM cash_transactions WHERE account_id=?', account)
    cash.updateCashMovement({ id, amountMinor: m(500) }, cashActor.ctx)
    expect(cash.accountBalance(account)).toBe(m(10500))
    cash.deleteCashMovement(id, cashActor.ctx)
    const other = cash.createAccount({ name: 'bank', kind: 'bank' }, env.ctx)
    cash.transfer(
      { fromAccountId: account, toAccountId: other, amountMinor: m(1000) },
      cashActor.ctx
    )
    expect(cash.accountBalance(account) + cash.accountBalance(other)).toBe(m(10000))
    const group = (
      db().prepare('SELECT transfer_group AS g FROM cash_transactions LIMIT 1').get() as {
        g: string
      }
    ).g
    cash.deleteTransfer(group, cashActor.ctx)
    expect(cash.accountBalance(account)).toBe(m(10000))
    expect(cash.accountBalance(other)).toBe(0)
    expect(reconcileDatabase(db()).findings).toEqual([])
  })
})
