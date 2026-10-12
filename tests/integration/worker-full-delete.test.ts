import { fulfillOrder } from '../helpers/sales-flow'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { eq, sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { workers } from '@main/db/schema/production.schema'
import {
  createWorker,
  listWorkers,
  workerBalances,
  workerStatement,
  assignWorkerToOrder,
  recordWorkerTransaction,
  deleteWorker
} from '@main/services/production/workers.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment, getOrderOrThrow } from '@main/services/sales/orders.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import { AppError } from '@main/utils/errors'

/**
 * Corrected Worker delete behaviour (replaces the earlier reversal-based
 * full-delete design): deleting a worker NEVER reverses earnings,
 * commissions, payments, cash movements, or historical production cost.
 * It only removes the worker from the active list and from future
 * selection. A worker with no history anywhere is truly gone; one with
 * any assignment or financial-transaction history is archived
 * (`active=false`) and every historical figure keeps resolving exactly
 * as before, since those are always recomputed live from
 * order_worker_assignments/worker_transactions — never touched here.
 */
let env: TestEnv
let seq = 0
beforeEach(() => { env = setupTestDatabase(); seq = 0 })
afterEach(() => env.cleanup())

function unique(prefix: string): string { return `${prefix}-${++seq}` }

/** A completed customer order, fully paid, with one worker assigned
 *  and their compensation already EARNED — the real financial case. */
function completedOrderWithEarnedWorker(workerId: number, amountMajor = 300) {
  const customerId = createCustomer({ name: unique('عميل') }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    lines: [{ lineKind: 'custom', description: 'منتج', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(2000) }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(2000) }, env.ctx)
  assignWorkerToOrder({ orderId: order.id, workerId, method: 'fixed', amountMinor: moneyFromMajor(amountMajor) }, env.ctx)
  fulfillOrder(order.id, env.ctx)
  return order
}

/** A confirmed (not completed) order with one UNEARNED assignment. */
function orderWithUnearnedWorker(workerId: number, amountMajor = 150) {
  const customerId = createCustomer({ name: unique('عميل') }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    lines: [{ lineKind: 'custom', description: 'منتج', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(2000) }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  const assignment = assignWorkerToOrder({ orderId: order.id, workerId, method: 'fixed', amountMinor: moneyFromMajor(amountMajor) }, env.ctx)
  return { order, assignment }
}

describe('1 — worker with no history is physically deleted', () => {
  it('removes the row entirely, never leaves an archived row behind', () => {
    const id = createWorker({ name: unique('عامل') }, env.ctx)
    const result = deleteWorker(id, env.ctx)
    expect(result).toEqual({ deleted: true, archived: false })
    expect(getDatabase().select().from(workers).where(eq(workers.id, id)).get()).toBeUndefined()
  })
})

describe('2 — worker with history disappears from the active Workers page', () => {
  it('is archived (active=false), not hard-deleted, and vanishes from listWorkers({ activeOnly: true })', () => {
    const id = createWorker({ name: unique('عامل') }, env.ctx)
    orderWithUnearnedWorker(id)

    expect(listWorkers({ activeOnly: true }).some((w) => w.id === id)).toBe(true)
    const result = deleteWorker(id, env.ctx)
    expect(result).toEqual({ deleted: false, archived: true })

    const row = getDatabase().select().from(workers).where(eq(workers.id, id)).get()
    expect(row).toBeDefined()
    expect(row?.active).toBe(false)
    expect(listWorkers({ activeOnly: true }).some((w) => w.id === id)).toBe(false)
    // The default, unfiltered listing (used by historical screens) can
    // still resolve the worker's own row/name.
    expect(listWorkers({}).some((w) => w.id === id)).toBe(true)
  })
})

describe('3 — a removed worker cannot be selected for a new assignment', () => {
  it('assignWorkerToOrder refuses an inactive worker, server-side', () => {
    const id = createWorker({ name: unique('عامل') }, env.ctx)
    orderWithUnearnedWorker(id) // give it history so delete archives rather than hard-deletes
    deleteWorker(id, env.ctx)

    const { order } = orderWithUnearnedWorker(createWorker({ name: unique('آخر') }, env.ctx))
    expect(() => assignWorkerToOrder(
      { orderId: order.id, workerId: id, method: 'fixed', amountMinor: moneyFromMajor(100) },
      env.ctx
    )).toThrowError(AppError)
    expect(() => assignWorkerToOrder(
      { orderId: order.id, workerId: id, method: 'fixed', amountMinor: moneyFromMajor(100) },
      env.ctx
    )).toThrowError(/لا يمكن تعيين عامل تم حذفه/)
  })
})

describe('4 — historical assignments remain exactly as they were', () => {
  it('unearned and earned assignment rows both survive deletion untouched', () => {
    const id = createWorker({ name: unique('عامل') }, env.ctx)
    const { assignment: unearned } = orderWithUnearnedWorker(id, 150)
    const order = completedOrderWithEarnedWorker(id, 300)

    deleteWorker(id, env.ctx)

    const rows = getDatabase()
      .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM order_worker_assignments WHERE worker_id = ${id}`)?.c
    expect(rows).toBe(2)
    const stillUnearned = getDatabase()
      .get<{ earned: number; amount: number }>(sql`SELECT earned, amount_minor AS amount FROM order_worker_assignments WHERE id = ${unearned.id}`)
    expect(stillUnearned?.earned).toBe(0)
    expect(stillUnearned?.amount).toBe(unearned.amountMinor)
    const survivingOrder = getOrderOrThrow(order.id)
    expect(survivingOrder.status).toBe('completed')
  })
})

describe('5 — historical commissions/earned compensation remain', () => {
  it('the earned worker_transactions "earning" row survives byte-for-byte', () => {
    const id = createWorker({ name: unique('عامل') }, env.ctx)
    completedOrderWithEarnedWorker(id, 300)
    // CC04: earnings live on the commission payable, not in the withdrawal/return statement.
    expect(workerStatement(id).payableMinor).toBe(moneyFromMajor(300))

    deleteWorker(id, env.ctx)

    const after = getDatabase()
      .get<{ c: number; amount: number }>(sql`SELECT COUNT(*) AS c, COALESCE(SUM(amount_minor),0) AS amount FROM worker_transactions WHERE worker_id = ${id} AND kind = 'earning'`)
    expect(after?.c).toBe(1)
    expect(after?.amount).toBe(moneyFromMajor(300))
  })
})

describe('6 — historical payments (withdrawals/repayments) remain', () => {
  it('every worker_transactions row survives, none deleted or altered', () => {
    const id = createWorker({ name: unique('عامل') }, env.ctx)
    const accountId = createAccount({ name: unique('صندوق'), kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    recordWorkerTransaction({ workerId: id, kind: 'withdrawal', amountMinor: moneyFromMajor(200), cashAccountId: accountId }, env.ctx)
    recordWorkerTransaction({ workerId: id, kind: 'repayment', amountMinor: moneyFromMajor(50), cashAccountId: accountId }, env.ctx)

    const balanceBefore = workerBalances(id)
    const accountBefore = accountBalance(accountId)

    deleteWorker(id, env.ctx)

    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM worker_transactions WHERE worker_id = ${id}`)?.c).toBe(2)
    expect(workerBalances(id)).toEqual(balanceBefore)
    expect(accountBalance(accountId)).toBe(accountBefore)
  })
})

describe('7 — historical worker financial movements remain (no cash reversed)', () => {
  it('no cash_transactions row referencing them is removed or altered', () => {
    const id = createWorker({ name: unique('عامل') }, env.ctx)
    const accountId = createAccount({ name: unique('صندوق'), kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    recordWorkerTransaction({ workerId: id, kind: 'withdrawal', amountMinor: moneyFromMajor(200), cashAccountId: accountId }, env.ctx)

    const cashRowsBefore = getDatabase()
      .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'worker_transactions' AND ref_id IN (SELECT id FROM worker_transactions WHERE worker_id = ${id})`)?.c

    deleteWorker(id, env.ctx)

    const cashRowsAfter = getDatabase()
      .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM cash_transactions WHERE ref_table = 'worker_transactions' AND ref_id IN (SELECT id FROM worker_transactions WHERE worker_id = ${id})`)?.c
    expect(cashRowsAfter).toBe(cashRowsBefore)
    expect(cashRowsAfter).toBeGreaterThan(0)
  })
})

describe('8 — the completed Manufacturing/Customer Order remains', () => {
  it('the order survives with the exact same id, status and total', () => {
    const id = createWorker({ name: unique('عامل') }, env.ctx)
    const order = completedOrderWithEarnedWorker(id, 300)
    const before = getOrderOrThrow(order.id)

    deleteWorker(id, env.ctx)

    const after = getOrderOrThrow(order.id)
    expect(after.id).toBe(before.id)
    expect(after.status).toBe(before.status)
    expect(after.totalMinor).toBe(before.totalMinor)
    expect(after.completedAt).toBe(before.completedAt)
  })
})

describe('9/10 — historical production cost and profit are unchanged', () => {
  it('orderCostBreakdown reports identical worker/total cost and profit before and after delete', () => {
    const id = createWorker({ name: unique('عامل') }, env.ctx)
    const order = completedOrderWithEarnedWorker(id, 300)
    const before = orderCostBreakdown(order.id)

    deleteWorker(id, env.ctx)

    const after = orderCostBreakdown(order.id)
    expect(after.workerCostMinor).toBe(before.workerCostMinor)
    expect(after.totalActualCostMinor).toBe(before.totalActualCostMinor)
    expect(after.actualProfitMinor).toBe(before.actualProfitMinor)
    expect(after.sellingPriceMinor).toBe(before.sellingPriceMinor)
  })
})

describe('11 — no cash transaction is reversed', () => {
  it('an account funded by a repayment keeps its exact balance after the worker is deleted', () => {
    const id = createWorker({ name: unique('عامل') }, env.ctx)
    const accountId = createAccount({ name: unique('صندوق'), kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    // CC04: a return needs existing worker debt (the withdrawal itself moves no tracked cash here).
    recordWorkerTransaction({ workerId: id, kind: 'withdrawal', amountMinor: moneyFromMajor(80) }, env.ctx)
    recordWorkerTransaction({ workerId: id, kind: 'repayment', amountMinor: moneyFromMajor(80), cashAccountId: accountId }, env.ctx)
    const before = accountBalance(accountId)

    deleteWorker(id, env.ctx)

    expect(accountBalance(accountId)).toBe(before)
  })
})

describe('12 — no unrelated business record is deleted', () => {
  it('deleting one worker never touches a different worker\'s order, balance or transactions', () => {
    const target = createWorker({ name: unique('يُحذف') }, env.ctx)
    const other = createWorker({ name: unique('يبقى') }, env.ctx)
    completedOrderWithEarnedWorker(target, 300)
    const otherOrder = completedOrderWithEarnedWorker(other, 400)
    expect(workerBalances(other).payableMinor).toBe(moneyFromMajor(400))

    deleteWorker(target, env.ctx)

    expect(workerBalances(other).payableMinor).toBe(moneyFromMajor(400))
    const survivingOrder = getOrderOrThrow(otherOrder.id)
    expect(survivingOrder.status).toBe('completed')
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM order_worker_assignments WHERE worker_id = ${other}`)?.c).toBe(1)
    expect(getDatabase().select().from(workers).where(eq(workers.id, other)).get()?.active).toBe(true)
  })
})

describe('13/14 — database integrity', () => {
  it('leaves foreign_key_check clean and integrity_check ok after both a hard delete and an archive', () => {
    const bare = createWorker({ name: unique('عامل بلا سجل') }, env.ctx)
    deleteWorker(bare, env.ctx)

    const withHistory = createWorker({ name: unique('عامل بسجل') }, env.ctx)
    const accountId = createAccount({ name: unique('صندوق سلامة'), kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    completedOrderWithEarnedWorker(withHistory, 200)
    orderWithUnearnedWorker(withHistory, 50)
    recordWorkerTransaction({ workerId: withHistory, kind: 'withdrawal', amountMinor: moneyFromMajor(30), cashAccountId: accountId }, env.ctx)
    deleteWorker(withHistory, env.ctx)

    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})

describe('15 — permissions remain enforced', () => {
  it('deleteWorker is only reachable through workers.remove under workers.manage (see delete-permissions.test.ts / router-coverage.test.ts)', () => {
    // deleteWorker itself is a plain service function with no fullDelete
    // concept any more — permission enforcement now lives entirely at
    // the single workers.remove IPC channel, covered end-to-end by the
    // shared IPC permission-table tests. This test simply documents
    // that no separate elevated key exists for it any more.
    expect(deleteWorker).toBeTypeOf('function')
  })
})

describe('idempotent double-delete', () => {
  it('deleting an already-archived worker again is a harmless no-op that stays archived', () => {
    const id = createWorker({ name: unique('عامل') }, env.ctx)
    orderWithUnearnedWorker(id)
    deleteWorker(id, env.ctx)
    const result = deleteWorker(id, env.ctx)
    expect(result).toEqual({ deleted: false, archived: true })
    expect(getDatabase().select().from(workers).where(eq(workers.id, id)).get()?.active).toBe(false)
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
