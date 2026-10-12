import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer, customerBalances } from '@main/services/parties/parties.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrderOrThrow, recordPayment } from '@main/services/sales/orders.service'
import {
  accountBalance,
  adjustAccountBalance,
  createAccount,
  transfer
} from '@main/services/finance/cash.service'
import { createExpense, createRecurringExpense } from '@main/services/finance/expenses.service'
import { createPurchase, paySupplier } from '@main/services/purchasing/purchasing.service'
import {
  createEmployee,
  paySalary,
  recordEmployeeTransaction
} from '@main/services/hr/employees.service'
import { createWorker, recordWorkerTransaction } from '@main/services/production/workers.service'
import {
  confirmSavingsAllocation,
  recordProfitWithdrawal,
  recordSavingsUsage
} from '@main/services/finance/profit.service'
import { closeDatabase, getRawConnection, setDatabasePath } from '@main/db/connection'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

let env: TestEnv
beforeEach(() => {
  env = setupTestDatabase()
})
afterEach(() => env.cleanup())

function paymentFixture() {
  const customerId = createCustomer({ name: `DB05 customer ${Math.random()}` }, env.ctx)
  const accountId = createAccount({ name: `DB05 cash ${Math.random()}`, kind: 'cash' }, env.ctx)
  const invoice = createFinalInvoice(
    {
      customerId,
      depositPercentBp: 0,
      lines: [
        {
          lineKind: 'custom',
          description: 'DB05 payment item',
          quantityMicro: quantityFromDisplay(1),
          unitPriceMinor: moneyFromMajor(1_000)
        }
      ]
    },
    env.ctx
  )
  const order = approveToOrder(invoice.id, env.ctx)
  return { customerId, accountId, orderId: order.id }
}

function paymentRequest(fixture: ReturnType<typeof paymentFixture>, requestKey: string) {
  return {
    orderId: fixture.orderId,
    amountMinor: moneyFromMajor(100),
    cashAccountId: fixture.accountId,
    paidAt: '2026-09-15',
    notes: 'DB05 exact retry',
    requestKey
  }
}

function allDatabaseRows(): Record<string, unknown[]> {
  const db = getRawConnection()
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>
  return Object.fromEntries(
    tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
  )
}

function expectHealthyDatabase(): void {
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
}

function economicCounts(orderId: number) {
  const db = getRawConnection()
  return {
    payments: db
      .prepare('SELECT COUNT(*) AS count FROM customer_payments WHERE order_id = ?')
      .get(orderId),
    cash: db
      .prepare("SELECT COUNT(*) AS count FROM cash_transactions WHERE kind = 'customer_payment'")
      .get(),
    audits: db
      .prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'orders.payment'")
      .get(),
    requests: db
      .prepare(
        "SELECT COUNT(*) AS count FROM financial_command_requests WHERE command_scope = 'orders.recordPayment'"
      )
      .get()
  }
}

describe('DB-05 durable idempotency — confirmed customer payment path', () => {
  it('returns the original result for immediate and repeated retries, while a new key permits a new intent', () => {
    const fixture = paymentFixture()
    const request = paymentRequest(fixture, 'db05-payment-retry-0001')

    const first = recordPayment(request, env.ctx)
    const firstRows = allDatabaseRows()
    const second = recordPayment(request, env.ctx)
    expect(second).toEqual(first)
    expect(allDatabaseRows()).toEqual(firstRows)
    for (let index = 0; index < 8; index += 1) {
      expect(recordPayment(request, env.ctx)).toEqual(first)
    }

    expect(economicCounts(fixture.orderId)).toEqual({
      payments: { count: 1 },
      cash: { count: 1 },
      audits: { count: 1 },
      requests: { count: 1 }
    })
    expect(getOrderOrThrow(fixture.orderId)).toMatchObject({
      paidMinor: moneyFromMajor(100),
      remainingMinor: moneyFromMajor(900)
    })
    expect(customerBalances(undefined, fixture.customerId)[0]).toMatchObject({
      paidMinor: moneyFromMajor(100),
      remainingMinor: moneyFromMajor(900)
    })
    expect(accountBalance(fixture.accountId)).toBe(moneyFromMajor(100))

    expect(() => recordPayment({ ...request, amountMinor: moneyFromMajor(101) }, env.ctx)).toThrow(
      /عملية مختلفة/
    )
    expect(economicCounts(fixture.orderId)).toMatchObject({ payments: { count: 1 } })

    const distinct = recordPayment(
      { ...request, requestKey: 'db05-payment-new-intent-0002' },
      env.ctx
    )
    expect(distinct.paidMinor).toBe(moneyFromMajor(200))
    expect(economicCounts(fixture.orderId)).toEqual({
      payments: { count: 2 },
      cash: { count: 2 },
      audits: { count: 2 },
      requests: { count: 2 }
    })
    expectHealthyDatabase()
  })

  it('recovers the successful result after caller uncertainty and after reopening SQLite', () => {
    const fixture = paymentFixture()
    const request = paymentRequest(fixture, 'db05-payment-timeout-restart')

    // Simulated timeout: the caller loses the first successful response.
    recordPayment(request, env.ctx)
    const committedRows = allDatabaseRows()
    expect(recordPayment(request, env.ctx)).toMatchObject({ paidMinor: moneyFromMajor(100) })
    expect(allDatabaseRows()).toEqual(committedRows)

    const dbPath = join(
      env.dir,
      readdirSync(env.dir).find((name) => name.endsWith('.db'))!
    )
    closeDatabase()
    setDatabasePath(dbPath)

    expect(recordPayment(request, env.ctx)).toMatchObject({ paidMinor: moneyFromMajor(100) })
    expect(allDatabaseRows()).toEqual(committedRows)
    expect(economicCounts(fixture.orderId)).toEqual({
      payments: { count: 1 },
      cash: { count: 1 },
      audits: { count: 1 },
      requests: { count: 1 }
    })
    expectHealthyDatabase()
  })

  const failureCases: Array<{
    name: string
    install: () => () => void
  }> = [
    {
      name: 'before idempotency reservation',
      install: () => {
        getRawConnection().exec(`CREATE TRIGGER db05_fail_before_request
          BEFORE INSERT ON financial_command_requests
          BEGIN SELECT RAISE(ABORT, 'DB05 injected before request'); END`)
        return () => getRawConnection().exec('DROP TRIGGER db05_fail_before_request')
      }
    },
    {
      name: 'after reservation but before the primary payment row',
      install: () => {
        getRawConnection().exec(`CREATE TRIGGER db05_fail_before_payment
          BEFORE INSERT ON customer_payments
          BEGIN SELECT RAISE(ABORT, 'DB05 injected before payment'); END`)
        return () => getRawConnection().exec('DROP TRIGGER db05_fail_before_payment')
      }
    },
    {
      name: 'after primary payment creation',
      install: () => {
        getRawConnection().exec(`CREATE TRIGGER db05_fail_after_payment
          BEFORE UPDATE ON orders
          BEGIN SELECT RAISE(ABORT, 'DB05 injected after payment'); END`)
        return () => getRawConnection().exec('DROP TRIGGER db05_fail_after_payment')
      }
    },
    {
      name: 'during the stored order balance effect',
      install: () => {
        getRawConnection().exec(`CREATE TRIGGER db05_fail_order_balance
          AFTER UPDATE ON orders
          BEGIN SELECT RAISE(ABORT, 'DB05 injected during balance'); END`)
        return () => getRawConnection().exec('DROP TRIGGER db05_fail_order_balance')
      }
    },
    {
      name: 'during child cash movement creation',
      install: () => {
        getRawConnection().exec(`CREATE TRIGGER db05_fail_cash_child
          BEFORE INSERT ON cash_transactions WHEN NEW.kind = 'customer_payment'
          BEGIN SELECT RAISE(ABORT, 'DB05 injected during cash movement'); END`)
        return () => getRawConnection().exec('DROP TRIGGER db05_fail_cash_child')
      }
    },
    {
      name: 'during audit insertion',
      install: () => {
        getRawConnection().exec(`CREATE TRIGGER db05_fail_audit
          BEFORE INSERT ON audit_log WHEN NEW.action = 'orders.payment'
          BEGIN SELECT RAISE(ABORT, 'DB05 injected during audit'); END`)
        return () => getRawConnection().exec('DROP TRIGGER db05_fail_audit')
      }
    },
    {
      name: 'immediately before commit',
      install: () => {
        const db = getRawConnection()
        db.pragma('defer_foreign_keys = ON')
        db.exec(`CREATE TRIGGER db05_fail_before_commit
          AFTER UPDATE OF result_json ON financial_command_requests
          WHEN OLD.result_json = 'null' AND NEW.result_json <> 'null'
          BEGIN
            INSERT INTO final_invoice_terms(final_invoice_id, term_index, term_text)
            VALUES (-505, 505, 'DB05 deferred violation');
          END`)
        return () => {
          db.exec('DROP TRIGGER db05_fail_before_commit')
          db.pragma('defer_foreign_keys = OFF')
        }
      }
    }
  ]

  for (const failure of failureCases) {
    it(`fully rolls back ${failure.name} and permits a same-key retry`, () => {
      const fixture = paymentFixture()
      const request = paymentRequest(
        fixture,
        `db05-failure-${failureCases.indexOf(failure)}-request`
      )
      const before = allDatabaseRows()
      const removeFailure = failure.install()
      try {
        expect(() => recordPayment(request, env.ctx)).toThrow()
      } finally {
        removeFailure()
      }

      expect(allDatabaseRows()).toEqual(before)
      expect(economicCounts(fixture.orderId)).toEqual({
        payments: { count: 0 },
        cash: { count: 0 },
        audits: { count: 0 },
        requests: { count: 0 }
      })
      expect(getOrderOrThrow(fixture.orderId)).toMatchObject({
        paidMinor: 0,
        remainingMinor: moneyFromMajor(1_000)
      })
      expect(accountBalance(fixture.accountId)).toBe(0)
      expectHealthyDatabase()

      const success = recordPayment(request, env.ctx)
      expect(recordPayment(request, env.ctx)).toEqual(success)
      expect(economicCounts(fixture.orderId)).toEqual({
        payments: { count: 1 },
        cash: { count: 1 },
        audits: { count: 1 },
        requests: { count: 1 }
      })
      expectHealthyDatabase()
    })
  }

  it('scopes a request key by command and rejects an unauthorized replay before key lookup', async () => {
    const fixture = paymentFixture()
    const sharedKey = 'db05-cross-command-key'
    const request = paymentRequest(fixture, sharedKey)
    recordPayment(request, env.ctx)
    const expenseId = createExpense(
      {
        amountMinor: moneyFromMajor(5),
        description: 'DB05 separate command',
        requestKey: sharedKey
      },
      env.ctx
    )
    expect(expenseId).toBeGreaterThan(0)
    expect(
      getRawConnection()
        .prepare(
          'SELECT command_scope FROM financial_command_requests WHERE request_key = ? ORDER BY command_scope'
        )
        .all(sharedKey)
    ).toEqual([{ command_scope: 'expenses.create' }, { command_scope: 'orders.recordPayment' }])

    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>
    >()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((
      channel: string,
      handler: never
    ) => {
      handlers.set(channel, handler)
    }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()

    const roleId = createRole(
      { name: 'DB05 payment observer', permissions: [P.orders.view] },
      env.ctx
    )
    createUser(
      {
        username: 'db05-observer',
        password: 'secret123',
        fullName: 'DB05 observer',
        roleId
      },
      env.ctx
    )
    login('db05-observer', 'secret123', 505)
    const unauthorized = await handlers.get(IPC_CHANNELS.orders.recordPayment)!(
      { sender: { id: 505 } } as never,
      request
    )
    expect(unauthorized).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(economicCounts(fixture.orderId)).toMatchObject({ payments: { count: 1 } })

    const missingKey = await handlers.get(IPC_CHANNELS.orders.recordPayment)!(
      { sender: { id: 1 } } as never,
      { ...request, requestKey: undefined }
    )
    expect(missingKey).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(economicCounts(fixture.orderId)).toMatchObject({ payments: { count: 1 } })
  })

  it('deduplicates every other A-class command scope without duplicating its durable children', () => {
    const db = getRawConnection()

    const accountAInput = {
      name: 'DB05 account A',
      kind: 'cash' as const,
      openingBalanceMinor: moneyFromMajor(50_000),
      requestKey: 'db05-account-a-create'
    }
    const accountA = createAccount(accountAInput, env.ctx)
    expect(createAccount(accountAInput, env.ctx)).toBe(accountA)
    const accountBInput = {
      name: 'DB05 account B',
      kind: 'bank' as const,
      openingBalanceMinor: 0,
      requestKey: 'db05-account-b-create'
    }
    const accountB = createAccount(accountBInput, env.ctx)
    expect(createAccount(accountBInput, env.ctx)).toBe(accountB)
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM cash_accounts WHERE name LIKE 'DB05 account %'")
        .get()
    ).toEqual({ count: 2 })

    const adjustment = {
      accountId: accountB,
      desiredBalanceMinor: moneyFromMajor(1_000),
      reason: 'DB05 adjustment',
      occurredAt: '2026-09-15',
      requestKey: 'db05-adjust-balance'
    }
    const adjusted = adjustAccountBalance(adjustment, env.ctx)
    expect(adjustAccountBalance(adjustment, env.ctx)).toEqual(adjusted)
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM cash_transactions WHERE kind = 'balance_adjustment'"
        )
        .get()
    ).toEqual({ count: 1 })

    const transferInput = {
      fromAccountId: accountA,
      toAccountId: accountB,
      amountMinor: moneyFromMajor(200),
      occurredAt: '2026-09-15',
      requestKey: 'db05-cash-transfer'
    }
    transfer(transferInput, env.ctx)
    transfer(transferInput, env.ctx)
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM cash_transactions WHERE kind LIKE 'transfer_%'")
        .get()
    ).toEqual({ count: 2 })
    expect(
      db
        .prepare(
          "SELECT COUNT(DISTINCT transfer_group) AS count FROM cash_transactions WHERE kind LIKE 'transfer_%'"
        )
        .get()
    ).toEqual({ count: 1 })

    const categoryId = createCategory({ name: 'DB05 materials' }, env.ctx)
    const materialId = createMaterial(
      {
        sku: 'DB05-MATERIAL',
        name: 'DB05 material',
        categoryId,
        unit: 'قطعة',
        currentMarketPriceMicro: unitCostFromMajor(25),
        pricingRule: 'exact'
      },
      env.ctx
    )
    const supplierId = createSupplier({ name: 'DB05 supplier' }, env.ctx)
    const purchaseInput = {
      supplierId,
      purchaseDate: '2026-09-15',
      lines: [
        {
          materialId,
          qtyMicro: quantityFromDisplay(10),
          unitCostMicro: unitCostFromMajor(20)
        }
      ],
      requestKey: 'db05-purchase-create'
    }
    const purchase = createPurchase(purchaseInput, env.ctx)
    expect(createPurchase(purchaseInput, env.ctx)).toEqual(purchase)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM purchases WHERE id = ?').get(purchase.id)
    ).toEqual({ count: 1 })
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM purchase_lines WHERE purchase_id = ?')
        .get(purchase.id)
    ).toEqual({ count: 1 })
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE kind = 'purchase'").get()
    ).toEqual({ count: 1 })

    const supplierPaymentInput = {
      supplierId,
      purchaseId: purchase.id,
      amountMinor: moneyFromMajor(50),
      cashAccountId: accountA,
      paidAt: '2026-09-15',
      requestKey: 'db05-supplier-payment'
    }
    const supplierPayment = paySupplier(supplierPaymentInput, env.ctx)
    expect(paySupplier(supplierPaymentInput, env.ctx)).toBe(supplierPayment)
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM supplier_payments WHERE id = ?')
        .get(supplierPayment)
    ).toEqual({ count: 1 })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM cash_transactions WHERE ref_table = 'supplier_payments' AND ref_id = ?"
        )
        .get(supplierPayment)
    ).toEqual({ count: 1 })

    const expenseInput = {
      amountMinor: moneyFromMajor(30),
      cashAccountId: accountA,
      description: 'DB05 expense',
      spentAt: '2026-09-15',
      requestKey: 'db05-expense-create'
    }
    const expenseId = createExpense(expenseInput, env.ctx)
    expect(createExpense(expenseInput, env.ctx)).toBe(expenseId)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM expenses WHERE id = ?').get(expenseId)
    ).toEqual({ count: 1 })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM cash_transactions WHERE ref_table = 'expenses' AND ref_id = ?"
        )
        .get(expenseId)
    ).toEqual({ count: 1 })

    const recurringInput = {
      description: 'DB05 recurring',
      amountMinor: moneyFromMajor(40),
      startDate: '2026-10-01',
      cashAccountId: accountA,
      requestKey: 'db05-recurring-create'
    }
    const recurringId = createRecurringExpense(recurringInput, env.ctx)
    expect(createRecurringExpense(recurringInput, env.ctx)).toBe(recurringId)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM recurring_expenses WHERE id = ?').get(recurringId)
    ).toEqual({ count: 1 })
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM recurring_expense_amounts WHERE recurring_expense_id = ?'
        )
        .get(recurringId)
    ).toEqual({ count: 1 })

    const employeeId = createEmployee(
      {
        name: 'DB05 employee',
        monthlySalaryMinor: moneyFromMajor(1_000),
        hiredAt: '2026-01-01'
      },
      env.ctx
    )
    const salaryInput = {
      employeeId,
      amountMinor: moneyFromMajor(100),
      periodYear: 2026,
      periodMonth: 9,
      cashAccountId: accountA,
      paidAt: '2026-09-15',
      requestKey: 'db05-salary-payment'
    }
    const salary = paySalary(salaryInput, env.ctx)
    expect(paySalary(salaryInput, env.ctx)).toEqual(salary)
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM employee_transactions WHERE kind = 'salary_payment'"
        )
        .get()
    ).toEqual({ count: 1 })
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM expenses WHERE source = 'salary'").get()
    ).toEqual({ count: 1 })

    const advanceInput = {
      employeeId,
      kind: 'advance' as const,
      amountMinor: moneyFromMajor(25),
      cashAccountId: accountA,
      occurredAt: '2026-09-15',
      requestKey: 'db05-employee-advance'
    }
    const advanceId = recordEmployeeTransaction(advanceInput, env.ctx)
    expect(recordEmployeeTransaction(advanceInput, env.ctx)).toBe(advanceId)
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM employee_transactions WHERE id = ?').get(advanceId)
    ).toEqual({ count: 1 })

    const workerId = createWorker({ name: 'DB05 worker' }, env.ctx)
    const workerInput = {
      workerId,
      kind: 'withdrawal' as const,
      amountMinor: moneyFromMajor(15),
      cashAccountId: accountA,
      occurredAt: '2026-09-15',
      requestKey: 'db05-worker-withdrawal'
    }
    const workerTransactionId = recordWorkerTransaction(workerInput, env.ctx)
    expect(recordWorkerTransaction(workerInput, env.ctx)).toBe(workerTransactionId)
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM worker_transactions WHERE id = ?')
        .get(workerTransactionId)
    ).toEqual({ count: 1 })

    const profitCustomerId = createCustomer({ name: 'DB05 profit customer' }, env.ctx)
    db.prepare(
      `INSERT INTO orders
      (document_number, customer_id, status, total_minor, paid_minor, remaining_minor,
       payment_status, completed_at, created_at)
      VALUES (?, ?, 'completed', ?, 0, ?, 'unpaid', ?, ?)`
    ).run(
      'SO-DB05-PROFIT',
      profitCustomerId,
      moneyFromMajor(100_000),
      moneyFromMajor(100_000),
      '2026-09-10T10:00:00.000Z',
      '2026-09-01T10:00:00.000Z'
    )

    const allocationInput = { year: 2026, month: 9, requestKey: 'db05-savings-allocation' }
    const allocation = confirmSavingsAllocation(allocationInput, env.ctx)
    expect(confirmSavingsAllocation(allocationInput, env.ctx)).toEqual(allocation)
    expect(db.prepare('SELECT COUNT(*) AS count FROM savings_allocations').get()).toEqual({
      count: 1
    })
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM savings_transactions WHERE kind = 'allocation'")
        .get()
    ).toEqual({ count: 1 })

    const savingsUsageInput = {
      amountMinor: moneyFromMajor(100),
      cashAccountId: accountB,
      occurredAt: '2026-09-15',
      requestKey: 'db05-savings-usage'
    }
    const savingsUsageId = recordSavingsUsage(savingsUsageInput, env.ctx)
    expect(recordSavingsUsage(savingsUsageInput, env.ctx)).toBe(savingsUsageId)
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM savings_transactions WHERE kind = 'usage'").get()
    ).toEqual({ count: 1 })

    const withdrawalInput = {
      amountMinor: moneyFromMajor(100),
      cashAccountId: accountA,
      withdrawnAt: '2026-09-15',
      requestKey: 'db05-profit-withdrawal'
    }
    const withdrawal = recordProfitWithdrawal(withdrawalInput, env.ctx)
    expect(recordProfitWithdrawal(withdrawalInput, env.ctx)).toEqual(withdrawal)
    expect(db.prepare('SELECT COUNT(*) AS count FROM profit_withdrawals').get()).toEqual({
      count: 1
    })

    const expectedScopes = [
      'cash.adjustBalance',
      'cash.createAccount',
      'cash.transfer',
      'employees.paySalary',
      'employees.transaction',
      'expenses.create',
      'expenses.createRecurring',
      'profit.confirmSavingsAllocation',
      'profit.recordSavingsUsage',
      'profit.recordWithdrawal',
      'purchases.create',
      'purchases.paySupplier',
      'workers.transaction'
    ]
    expect(
      db
        .prepare(
          `SELECT command_scope, COUNT(*) AS count
      FROM financial_command_requests
      WHERE command_scope <> 'orders.recordPayment'
      GROUP BY command_scope ORDER BY command_scope`
        )
        .all()
    ).toEqual([
      { command_scope: 'cash.adjustBalance', count: 1 },
      { command_scope: 'cash.createAccount', count: 2 },
      ...expectedScopes.slice(2).map((command_scope) => ({ command_scope, count: 1 }))
    ])
    expectHealthyDatabase()
  })
})
