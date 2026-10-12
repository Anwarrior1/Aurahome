import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { approveToOrder } from '../helpers/sales-flow'
import { traceQueries } from '../helpers/query-counter'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { completeProduction, issueRelease, issueWorkSheet, recordDelivery } from '@main/services/production/production.service'
import {
  createExpense,
  createRecurringExpense,
  updateRecurringExpense
} from '@main/services/finance/expenses.service'
import {
  availableProfitMinor,
  confirmSavingsAllocation,
  cumulativeNetProfitMinor,
  listWithdrawals,
  monthlyProfitSummary,
  recordProfitWithdrawal
} from '@main/services/finance/profit.service'
import { createEmployee, paySalary, reverseSalaryPayment } from '@main/services/hr/employees.service'
import { recordWaste } from '@main/services/inventory/inventory.service'
import { createWorker, payWorkerCommission } from '@main/services/production/workers.service'
import { savePlannedWorkers } from '@main/services/planning/planning.service'
import { createAccount } from '@main/services/finance/cash.service'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor as m } from '@shared/money/money'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv

beforeEach(() => {
  env = setupTestDatabase()
})

afterEach(() => {
  try {
    assertDb10Equivalence()
  } finally {
    env.cleanup()
  }
})

function period(offset: number): { year: number; month: number; start: string } {
  const now = new Date()
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    start: date.toISOString().slice(0, 10)
  }
}

const PRIOR = period(-1)
const CURRENT = period(0)
const FUTURE = period(1)

function completeRevenueOnlyOrder(priceMajor: number): number {
  const customerId = createCustomer({ name: `BL-09 customer ${crypto.randomUUID()}` }, env.ctx)
  const invoice = createFinalInvoice(
    {
      customerId,
      lines: [{ lineKind: 'custom', description: 'BL-09 order', quantityMicro: q(1), unitPriceMinor: m(priceMajor) }]
    },
    env.ctx
  )
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: m(priceMajor) }, env.ctx)
  const release = issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)
  recordDelivery({ orderId: order.id, releaseId: release.id, kind: 'handover' }, env.ctx)
  return order.id
}

function oneHistoricalRecurringExpense(amountMajor: number): void {
  const id = createRecurringExpense(
    { description: 'historical recurring rent', amountMinor: m(amountMajor), startDate: PRIOR.start },
    env.ctx
  )
  updateRecurringExpense(id, { endDate: PRIOR.start }, env.ctx)
}

function stockedMaterial(unitCostMajor = 100): number {
  const categoryId = createCategory({ name: `BL-09 category ${crypto.randomUUID()}` }, env.ctx)
  const materialId = createMaterial(
    {
      sku: `BL09-${crypto.randomUUID()}`,
      name: 'BL-09 material',
      categoryId,
      unit: 'board',
      currentMarketPriceMicro: c(unitCostMajor),
      pricingRule: 'exact'
    } as never,
    env.ctx
  )
  createPurchase(
    {
      supplierId: createSupplier({ name: `BL-09 supplier ${crypto.randomUUID()}` }, env.ctx),
      lines: [{ materialId, qtyMicro: q(100), unitCostMicro: c(unitCostMajor) }]
    },
    env.ctx
  )
  return materialId
}

describe('BL-09 true cumulative net profit', () => {
  it('includes pre-sale ordinary costs, keeps current costs current, and does not sweep history into the sales month', () => {
    createExpense(
      { kind: 'fixed', amountMinor: m(3_000), description: 'pre-revenue rent', spentAt: PRIOR.start },
      env.ctx
    )
    createExpense(
      { kind: 'variable', amountMinor: m(2_000), description: 'current utilities', spentAt: CURRENT.start },
      env.ctx
    )
    completeRevenueOnlyOrder(10_000)

    expect(monthlyProfitSummary(PRIOR.year, PRIOR.month).netProfitMinor).toBe(-m(3_000))
    expect(monthlyProfitSummary(CURRENT.year, CURRENT.month).netProfitMinor).toBe(m(8_000))
    expect(availableProfitMinor()).toBe(m(5_000))
  })

  it('includes pre-sale payroll by its accounting period and preserves salary reversal', () => {
    const employeeId = createEmployee({ name: 'BL-09 employee', monthlySalaryMinor: m(2_000) }, env.ctx)
    const payment = paySalary(
      { employeeId, amountMinor: m(2_000), periodYear: PRIOR.year, periodMonth: PRIOR.month },
      env.ctx
    )
    completeRevenueOnlyOrder(10_000)

    expect(availableProfitMinor()).toBe(m(8_000))
    reverseSalaryPayment(payment.transactionId, env.ctx)
    expect(availableProfitMinor()).toBe(m(10_000))
  })

  it('includes unposted pre-sale recurring occurrences in their own historical month', () => {
    oneHistoricalRecurringExpense(1_200)
    completeRevenueOnlyOrder(10_000)

    expect(monthlyProfitSummary(PRIOR.year, PRIOR.month).generalExpensesMinor).toBe(m(1_200))
    expect(monthlyProfitSummary(CURRENT.year, CURRENT.month).generalExpensesMinor).toBe(0)
    expect(availableProfitMinor()).toBe(m(8_800))
  })

  it('includes historical waste at actual inventory cost', () => {
    const materialId = stockedMaterial()
    recordWaste({ materialId, qtyMicro: q(5), reason: 'historical loss', ctx: env.ctx })
    // recordWaste intentionally exposes no historical date. Backdating this one
    // append-only row simulates elapsed production time without bypassing FIFO costing.
    getRawConnection()
      .prepare("UPDATE inventory_movements SET created_at = ? WHERE kind = 'waste'")
      .run(`${PRIOR.start}T12:00:00.000Z`)
    completeRevenueOnlyOrder(10_000)

    expect(monthlyProfitSummary(PRIOR.year, PRIOR.month).wasteLossMinor).toBe(m(500))
    expect(availableProfitMinor()).toBe(m(9_500))
  })

  it('excludes future expenses, payroll periods, and recurring occurrences from the current accounting period', () => {
    createExpense(
      { kind: 'variable', amountMinor: m(2_000), description: 'future expense', spentAt: FUTURE.start },
      env.ctx
    )
    const employeeId = createEmployee({ name: 'future employee', monthlySalaryMinor: m(1_500) }, env.ctx)
    paySalary(
      { employeeId, amountMinor: m(1_500), periodYear: FUTURE.year, periodMonth: FUTURE.month },
      env.ctx
    )
    createRecurringExpense(
      { description: 'future rent', amountMinor: m(500), startDate: FUTURE.start },
      env.ctx
    )
    completeRevenueOnlyOrder(10_000)

    expect(monthlyProfitSummary(CURRENT.year, CURRENT.month).netProfitMinor).toBe(m(10_000))
    expect(availableProfitMinor()).toBe(m(10_000))
    expect(monthlyProfitSummary(FUTURE.year, FUTURE.month)).toMatchObject({
      generalExpensesMinor: m(2_500),
      payrollExpenseMinor: m(1_500),
      netProfitMinor: -m(4_000)
    })
  })

  it('deducts savings and withdrawals once, rejects overdraw, and keeps withdrawal retries idempotent', () => {
    createExpense(
      { kind: 'fixed', amountMinor: m(5_000), description: 'historical rent', spentAt: PRIOR.start },
      env.ctx
    )
    completeRevenueOnlyOrder(10_000)
    confirmSavingsAllocation(
      { year: CURRENT.year, month: CURRENT.month, requestKey: 'bl09-savings-allocation' },
      env.ctx
    )

    expect(availableProfitMinor()).toBe(m(4_000))
    expect(() =>
      recordProfitWithdrawal({ amountMinor: m(4_001), requestKey: 'bl09-overdraw' }, env.ctx)
    ).toThrow(/يتجاوز الأرباح المتاحة/)

    const request = { amountMinor: m(2_500), requestKey: 'bl09-withdrawal-retry' }
    const first = recordProfitWithdrawal(request, env.ctx)
    const retry = recordProfitWithdrawal(request, env.ctx)
    expect(retry).toEqual(first)
    expect(first.availableAfterMinor).toBe(m(1_500))
    expect(listWithdrawals().items).toHaveLength(1)
    expect(listWithdrawals().summary.totalWithdrawnMinor).toBe(m(2_500))
    expect(availableProfitMinor()).toBe(m(1_500))

    expect(
      recordProfitWithdrawal(
        { amountMinor: m(1_500), requestKey: 'bl09-withdrawal-at-limit' },
        env.ctx
      ).availableAfterMinor
    ).toBe(0)
    expect(availableProfitMinor()).toBe(0)
  })

  it('returns zero withdrawable profit when historical costs exist but no revenue is recognized', () => {
    createExpense(
      { kind: 'fixed', amountMinor: m(3_000), description: 'pre-revenue rent', spentAt: PRIOR.start },
      env.ctx
    )
    const employeeId = createEmployee({ name: 'pre-revenue employee', monthlySalaryMinor: m(2_000) }, env.ctx)
    paySalary(
      { employeeId, amountMinor: m(2_000), periodYear: PRIOR.year, periodMonth: PRIOR.month },
      env.ctx
    )
    oneHistoricalRecurringExpense(500)

    expect(cumulativeNetProfitMinor()).toBe(0)
    expect(availableProfitMinor()).toBe(0)
  })

  it('recognizes worker commission once and does not count its later cash payment as another cost', () => {
    const workerId = createWorker({ name: 'BL-09 worker' }, env.ctx)
    const customerId = createCustomer({ name: 'BL-09 commission customer' }, env.ctx)
    const invoice = createFinalInvoice(
      {
        customerId,
        depositPercentBp: 0,
        lines: [{ lineKind: 'custom', description: 'commission order', quantityMicro: q(1), unitPriceMinor: m(10_000) }]
      },
      env.ctx
    )
    const order = approveToOrder(invoice.id, env.ctx)
    savePlannedWorkers(
      { orderId: order.id },
      [{ workerId, workerName: 'BL-09 worker', estimatedCostMinor: m(800) }],
      env.ctx
    )
    recordPayment({ orderId: order.id, amountMinor: m(10_000) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    completeProduction(sheet.id, env.ctx)
    const release = issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)
    recordDelivery({ orderId: order.id, releaseId: release.id, kind: 'handover' }, env.ctx)

    expect(availableProfitMinor()).toBe(m(9_200))
    const cashAccountId = createAccount(
      { name: 'BL-09 cash', kind: 'cash', openingBalanceMinor: m(1_000) },
      env.ctx
    )
    payWorkerCommission(
      { workerId, amountMinor: m(800), cashAccountId, requestKey: 'bl09-commission-payment' },
      env.ctx
    )
    expect(availableProfitMinor()).toBe(m(9_200))
  })

  it('keeps cumulative SQL query count constant when the historical span widens', () => {
    completeRevenueOnlyOrder(10_000)
    const short = traceQueries(() => cumulativeNetProfitMinor())
    createExpense(
      { kind: 'fixed', amountMinor: m(1_000), description: 'long-span rent', spentAt: '2010-01-01' },
      env.ctx
    )
    const long = traceQueries(() => cumulativeNetProfitMinor())

    expect(long.result).toBe(m(9_000))
    expect(long.count).toBe(short.count)
    expect(long.count).toBeLessThanOrEqual(6)
    expect(long.statements.join('\n')).not.toContain('UNION ALL')
  })
})
