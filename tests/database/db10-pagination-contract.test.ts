import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRawConnection } from '@main/db/connection'
import type { CursorPage } from '@shared/pagination/cursor-page'
import { PAGE_SIZE } from '@shared/pagination/cursor-page'
import { encodeCursor } from '@main/services/base/pagination'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { seedDb10Fixture, type Db10Fixture } from '../helpers/db10-fixtures'
import {paymentHistoryReference} from '../helpers/payment-history-reference'
import { listExpenses } from '@main/services/finance/expenses.service'
import { listOrders } from '@main/services/sales/orders.service'
import { listReleases, listDeliveries, listWorkSheets, listOperationalWorkSheets } from '@main/services/production/production.service'
import { listPurchases } from '@main/services/purchasing/purchasing.service'
import { listQuotations } from '@main/services/sales/quotations.service'
import { listTransactions } from '@main/services/finance/cash.service'
import { listMovements, listRemainders } from '@main/services/inventory/inventory.service'
import { listAuditLog } from '@main/services/admin/users.service'
import { listFinalInvoices } from '@main/services/sales/final-invoices.service'
import { customerBalancesPage, customerStatement, listCustomers, supplierStatement } from '@main/services/parties/parties.service'
import { workerStatement } from '@main/services/production/workers.service'
import { employeeStatement, listAdvances, listSalaryPayments } from '@main/services/hr/employees.service'
import { listWithdrawals, savingsHistory } from '@main/services/finance/profit.service'
import { listFinishedGoodsMovements } from '@main/services/production/finished-goods.service'

type Fetch<T> = (request: { limit?: number; cursor?: string }) => CursorPage<T, unknown>

/** Follows only returned cursors forward, then backward from the last page. */
function traverse<T>(fetch: Fetch<T>, limit: number, keyOf: (row: T) => string | number) {
  const forward: Array<string | number> = []
  const pages: CursorPage<T, unknown>[] = []
  let cursor: string | undefined
  let guard = 0
  do {
    const page = fetch({ limit, cursor })
    expect(page.items.length).toBeLessThanOrEqual(limit)
    pages.push(page)
    forward.push(...page.items.map(keyOf))
    cursor = page.nextCursor ?? undefined
    expect(page.hasMore).toBe(page.nextCursor !== null)
    guard += 1
    expect(guard).toBeLessThan(10_000)
  } while (cursor)
  const backward: Array<string | number> = []
  let back = pages[pages.length - 1]!
  backward.unshift(...back.items.map(keyOf))
  while (back.prevCursor) {
    back = fetch({ limit, cursor: back.prevCursor })
    backward.unshift(...back.items.map(keyOf))
  }
  return { forward, backward, pages: pages.length }
}

function column<T = number>(sqlText: string, ...params: unknown[]): T[] {
  return (getRawConnection().prepare(sqlText).all(...params) as Array<Record<string, T>>).map((row) => Object.values(row)[0]!)
}

function expectExact(actual: Array<string | number>, oracle: Array<string | number>): void {
  expect(new Set(actual).size).toBe(actual.length)
  expect(actual).toEqual(oracle)
}

let env: TestEnv
let fixture: Db10Fixture

beforeAll(() => {
  env = setupTestDatabase()
  fixture = seedDb10Fixture(1_500)
  // Remainders have no fixture rows of their own; give the endpoint something to page.
  const insert = getRawConnection().prepare('INSERT INTO material_remainders (material_id, size_micro, available, created_at) VALUES (?, ?, ?, ?)')
  for (let index = 0; index < 60; index += 1) insert.run(fixture.materialIds[index % 3]!, 100_000 + index, index % 5 === 0 ? 0 : 1, '2026-01-01T00:00:00.000Z')
}, 120_000)
afterAll(() => env.cleanup())

describe('DB-10 server-enforced page bounds', () => {
  it('applies the default page size and rejects every out-of-contract limit at the service boundary', () => {
    expect(listExpenses({}).items).toHaveLength(PAGE_SIZE.default)
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, PAGE_SIZE.max + 1, 1_000_000, Number.NaN]) {
      expect(() => listExpenses({}, { limit })).toThrow(/حجم الصفحة/)
      expect(() => listOrders({}, { limit })).toThrow(/حجم الصفحة/)
    }
    expect(listOrders({}, { limit: PAGE_SIZE.max }).items).toHaveLength(PAGE_SIZE.max)
  })

  it('rejects malformed, forged, cross-endpoint and filter-mismatched cursors', () => {
    const page = listExpenses({ search: 'مصروف' }, { limit: 5 })
    const valid = page.nextCursor!
    const forged = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
    const fingerprint = JSON.parse(Buffer.from(valid, 'base64url').toString('utf8'))[2]
    for (const cursor of [
      'not a cursor', '%%%%', 'abc', 'x'.repeat(600), forged('{'), forged({ id: 1 }), forged([2, 'n', fingerprint, 5]),
      forged([1, 'z', fingerprint, 5]), forged([1, 'n', fingerprint]), forged([1, 'n', fingerprint, 'five']),
      forged([1, 'n', fingerprint, Number.MAX_SAFE_INTEGER + 2]), forged([1, 'n', 'wrong-fingerprint', 5]), forged([1, 'n', fingerprint, 5, 6])
    ]) {
      expect(() => listExpenses({ search: 'مصروف' }, { limit: 5, cursor })).toThrow(/مؤشر الصفحة/)
    }
    // A cursor is bound to its endpoint and filters.
    expect(() => listExpenses({ search: 'عام' }, { limit: 5, cursor: valid })).toThrow(/مؤشر الصفحة/)
    expect(() => listPurchases({}, { cursor: listOrders({}, { limit: 5 }).nextCursor! })).toThrow(/مؤشر الصفحة/)
    expect(() => listExpenses({}, { cursor: encodeCursor('next', [5], 'orders.list', {}) })).toThrow(/مؤشر الصفحة/)
    expect(listExpenses({ search: 'مصروف' }, { limit: 5, cursor: valid }).items).toHaveLength(5)
  })

  it('rejects excessively long search text instead of scanning with it', () => {
    expect(() => listOrders({ search: 'x'.repeat(201) })).toThrow(/البحث/)
    expect(listOrders({ search: 'x'.repeat(200) }).items).toEqual([])
  })
})

describe('DB-10 complete keyset traversal (forward and backward, no duplicates, no gaps)', () => {
  const cases: Array<{ name: string; fetch: Fetch<Record<string, unknown>>; key: (row: Record<string, unknown>) => string | number; oracle: () => Array<string | number>; limit: number }> = [
    { name: 'active orders', fetch: (r) => listOrders({}, r), key: (row) => row.id as number, oracle: () => column('SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.archived_at IS NULL ORDER BY o.id DESC'), limit: 97 },
    { name: 'filtered orders', fetch: (r) => listOrders({ status: 'confirmed', search: 'ORD-1' }, r), key: (row) => row.id as number, oracle: () => column("SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.archived_at IS NULL AND o.status = 'confirmed' AND (o.document_number LIKE '%ORD-1%' OR c.name LIKE '%ORD-1%') ORDER BY o.id DESC"), limit: 13 },
    { name: 'expenses history', fetch: (r) => listExpenses({}, r), key: (row) => row.id as number, oracle: () => column('SELECT id FROM expenses ORDER BY id DESC'), limit: 71 },
    { name: 'linked expenses in a range', fetch: (r) => listExpenses({ linkedOnly: true, from: '2022-01-01', to: '2023-12-31' }, r), key: (row) => row.id as number, oracle: () => column("SELECT id FROM expenses WHERE order_id IS NOT NULL AND spent_at >= '2022-01-01' AND spent_at <= '2023-12-31' ORDER BY id DESC"), limit: 17 },
    { name: 'exit permits', fetch: (r) => listReleases({ includeReversed: true }, r), key: (row) => row.id as number, oracle: () => column('SELECT r.id FROM releases r JOIN orders o ON o.id = r.order_id ORDER BY r.id DESC'), limit: 41 },
    { name: 'deliveries', fetch: (r) => listDeliveries({}, r), key: (row) => row.id as number, oracle: () => column("SELECT d.id FROM deliveries d JOIN orders o ON o.id = d.order_id JOIN customers c ON c.id = o.customer_id WHERE d.status = 'recorded' ORDER BY d.id DESC"), limit: 39 },
    { name: 'work sheets', fetch: (r) => listWorkSheets({ includeReversed: true }, r), key: (row) => row.id as number, oracle: () => column('SELECT id FROM work_sheets ORDER BY id DESC'), limit: 43 },
    { name: 'operational work sheets', fetch: (r) => listOperationalWorkSheets({}, r), key: (row) => row.id as number, oracle: () => column("SELECT id FROM work_sheets WHERE status != 'reversed' ORDER BY id DESC"), limit: 100 },
    { name: 'purchases', fetch: (r) => listPurchases({}, r), key: (row) => row.id as number, oracle: () => column('SELECT id FROM purchases ORDER BY id DESC'), limit: 59 },
    { name: 'quotations', fetch: (r) => listQuotations({}, r), key: (row) => row.id as number, oracle: () => column('SELECT id FROM quotations ORDER BY id DESC'), limit: 100 },
    { name: 'cash movements for one account', fetch: (r) => listTransactions({ accountId: fixture.accountIds[1] }, r), key: (row) => row.id as number, oracle: () => column('SELECT id FROM cash_transactions WHERE account_id = ? ORDER BY id DESC', fixture.accountIds[1]), limit: 33 },
    { name: 'inventory movements', fetch: (r) => listMovements({}, r), key: (row) => row.id as number, oracle: () => column('SELECT id FROM inventory_movements ORDER BY id DESC'), limit: 77 },
    { name: 'audit log', fetch: (r) => listAuditLog({ action: 'orders' }, r), key: (row) => row.id as number, oracle: () => column("SELECT id FROM audit_log WHERE action LIKE '%orders%' ORDER BY id DESC"), limit: 100 },
    { name: 'approved invoices', fetch: (r) => listFinalInvoices({}, env.ctx.session, r), key: (row) => row.id as number, oracle: () => column('SELECT f.id FROM final_invoices f LEFT JOIN orders o ON o.id = f.order_id JOIN customers c ON c.id = f.customer_id WHERE f.order_id IS NULL OR o.archived_at IS NULL ORDER BY f.id DESC'), limit: 100 },
    { name: 'customers by name', fetch: (r) => listCustomers({}, r), key: (row) => row.id as number, oracle: () => column('SELECT id FROM customers WHERE active = 1 ORDER BY name ASC, id ASC'), limit: 23 },
    { name: 'customer receivables ranking', fetch: (r) => customerBalancesPage({}, r), key: (row) => row.customerId as number, oracle: () => column("SELECT c.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status IN ('confirmed', 'completed') GROUP BY c.id ORDER BY COALESCE(SUM(o.total_minor - o.paid_minor), 0) DESC, c.name ASC, c.id ASC"), limit: 29 },
    { name: 'customer statement orders', fetch: (r) => customerStatement(fixture.bigCustomerId, env.ctx, { sections: ['orders'], orders: r }).orders, key: (row) => row.id as number, oracle: () => column('SELECT id FROM orders WHERE customer_id = ? ORDER BY id DESC', fixture.bigCustomerId), limit: 11 },
    { name: 'customer statement payments (effective factory day, execution, id, type)', fetch: (r) => customerStatement(fixture.bigCustomerId, env.ctx, { sections: ['payments'], payments: r }).payments, key: (row) => row.rowKey as string, oracle: () => paymentHistoryReference(fixture.bigCustomerId), limit: 9 },
    { name: 'customer statement approved invoices', fetch: (r) => customerStatement(fixture.bigCustomerId, env.ctx, { sections: ['approvedInvoices'], approvedInvoices: r }).approvedInvoices, key: (row) => row.id as number, oracle: () => column('SELECT id FROM final_invoices WHERE customer_id = ? ORDER BY id DESC', fixture.bigCustomerId), limit: 25 },
    { name: 'supplier statement payments', fetch: (r) => supplierStatement(fixture.bigSupplierId, { sections: ['payments'], payments: r }).payments, key: (row) => row.id as number, oracle: () => column('SELECT id FROM supplier_payments WHERE supplier_id = ? ORDER BY id DESC', fixture.bigSupplierId), limit: 19 },
    { name: 'worker statement', fetch: (r) => workerStatement(fixture.bigWorkerId, r).transactions, key: (row) => row.id as number, oracle: () => column("SELECT id FROM worker_transactions WHERE worker_id = ? AND kind IN ('withdrawal', 'repayment') ORDER BY id DESC", fixture.bigWorkerId), limit: 7 },
    { name: 'employee statement', fetch: (r) => employeeStatement(fixture.bigEmployeeId, r).transactions, key: (row) => row.id as number, oracle: () => column('SELECT id FROM employee_transactions WHERE employee_id = ? ORDER BY id DESC', fixture.bigEmployeeId), limit: 8 },
    { name: 'employee advances', fetch: (r) => listAdvances({}, r), key: (row) => row.id as number, oracle: () => column("SELECT t.id FROM employee_transactions t JOIN employees e ON e.id = t.employee_id WHERE t.kind IN ('advance', 'repayment') ORDER BY t.id DESC"), limit: 6 },
    { name: 'salary payments (createdAt, id)', fetch: (r) => listSalaryPayments({}, r), key: (row) => row.id as number, oracle: () => column("SELECT t.id FROM employee_transactions t JOIN employees e ON e.id = t.employee_id WHERE t.kind = 'salary_payment' AND t.history_hidden_at IS NULL ORDER BY t.created_at DESC, t.id DESC"), limit: 37 },
    { name: 'profit withdrawals', fetch: (r) => listWithdrawals({}, r), key: (row) => row.id as number, oracle: () => column('SELECT id FROM profit_withdrawals ORDER BY id DESC'), limit: 10 },
    { name: 'savings transactions', fetch: (r) => savingsHistory(r).transactions, key: (row) => row.id as number, oracle: () => column('SELECT id FROM savings_transactions ORDER BY id DESC'), limit: 12 },
    { name: 'finished-goods movements', fetch: (r) => listFinishedGoodsMovements({}, r), key: (row) => row.id as number, oracle: () => column('SELECT id FROM finished_goods_movements ORDER BY id DESC'), limit: 31 },
    { name: 'available remainders (oldest first)', fetch: (r) => listRemainders(undefined, r), key: (row) => row.id as number, oracle: () => column('SELECT id FROM material_remainders WHERE available = 1 ORDER BY id ASC'), limit: 9 }
  ]

  it.each(cases)('$name', ({ fetch, key, oracle, limit }) => {
    const expected = oracle()
    expect(expected.length).toBeGreaterThan(limit)
    const result = traverse(fetch, limit, key)
    expectExact(result.forward, expected)
    expectExact(result.backward, expected)
    expect(result.pages).toBe(Math.ceil(expected.length / limit))
  })

  it('returns a correct empty page and a correct last page', () => {
    const empty = listOrders({ search: 'لا يوجد أبداً' })
    expect(empty).toMatchObject({ items: [], nextCursor: null, prevCursor: null, hasMore: false })
    const total = column('SELECT id FROM expenses').length
    const exact = listExpenses({}, { limit: 100 })
    let cursor = exact.nextCursor
    let seen = exact.items.length
    let last = exact
    while (cursor) {
      last = listExpenses({}, { limit: 100, cursor })
      seen += last.items.length
      cursor = last.nextCursor
    }
    expect(seen).toBe(total)
    expect(last.hasMore).toBe(false)
    expect(last.prevCursor).not.toBeNull()
  })
})

describe('DB-10 ties and concurrent change semantics (live seek traversal, no snapshot)', () => {
  it('orders many identical timestamps deterministically and never skips a tie', () => {
    const raw = getRawConnection()
    const customerId = Number(raw.prepare("INSERT INTO customers (name, created_at) VALUES ('عميل التعادل', '2026-01-01T00:00:00.000Z')").run().lastInsertRowid)
    const orderId = Number(raw.prepare("INSERT INTO orders (document_number, customer_id, status, total_minor, created_at) VALUES ('TIE-ORDER', ?, 'confirmed', 100, '2026-01-01T00:00:00.000Z')").run(customerId).lastInsertRowid)
    const payment = raw.prepare("INSERT INTO customer_payments (order_id, customer_id, amount_minor, paid_at, created_at) VALUES (?, ?, 1, '2026-03-03', '2026-03-03T00:00:00.000Z')")
    const refund = raw.prepare("INSERT INTO customer_payment_refunds (order_id, customer_id, amount_minor, cash_account_id, refunded_at, reason, request_key, created_at) VALUES (?, ?, 1, 1, '2026-03-03', 'tie', ?, '2026-03-03T00:00:00.000Z')")
    for (let index = 0; index < 40; index += 1) {
      payment.run(orderId, customerId)
      refund.run(orderId, customerId, `tie-${index}`)
    }
    // Same customer name for many customers: (name, id) breaks the tie.
    const sameName = raw.prepare("INSERT INTO customers (name, created_at) VALUES ('اسم مكرر', '2026-01-01T00:00:00.000Z')")
    for (let index = 0; index < 25; index += 1) sameName.run()
    const payments = traverse((r) => customerStatement(customerId, env.ctx, { sections: ['payments'], payments: r }).payments, 7, (row) => row.rowKey)
    expect(payments.forward).toHaveLength(80)
    expectExact(payments.forward, paymentHistoryReference(customerId))
    const names = traverse((r) => listCustomers({ search: 'اسم مكرر' }, r), 4, (row) => row.id)
    expectExact(names.forward, column("SELECT id FROM customers WHERE active = 1 AND name = 'اسم مكرر' ORDER BY id ASC"))
    // Salary payments sharing one created_at.
    const salary = raw.prepare("INSERT INTO employee_transactions (employee_id, kind, amount_minor, period_year, period_month, created_at, paid_amount_minor) VALUES (2, 'salary_payment', 5, 2030, 1, '2030-01-31T00:00:00.000Z', 5)")
    for (let index = 0; index < 30; index += 1) salary.run()
    const salaries = traverse((r) => listSalaryPayments({ year: 2030 }, r), 4, (row) => row.id)
    expectExact(salaries.forward, column("SELECT id FROM employee_transactions WHERE kind = 'salary_payment' AND period_year = 2030 ORDER BY created_at DESC, id DESC"))
  })

  it('B/C/D/E/F/G: inserts, deletes, deleted cursor row, filter change and restart behave as documented', () => {
    const raw = getRawConnection()
    const filter = { from: '2031-01-01', to: '2031-12-31' }
    const insert = raw.prepare("INSERT INTO expenses (kind, amount_minor, description, spent_at, created_at) VALUES ('variable', 100, 'db10-concurrency', ?, '2031-01-01T00:00:00.000Z')")
    for (let index = 0; index < 30; index += 1) insert.run(`2031-01-${String((index % 28) + 1).padStart(2, '0')}`)
    const oracle = () => column("SELECT id FROM expenses WHERE spent_at >= '2031-01-01' AND spent_at <= '2031-12-31' ORDER BY id DESC")
    const original = oracle()
    const first = listExpenses(filter, { limit: 10 })
    expect(first.items.map((row) => row.id)).toEqual(original.slice(0, 10))

    // B. A newer row inserted between pages is not replayed into page 2.
    const newerId = Number(insert.run('2031-06-01').lastInsertRowid)
    // D. A row already seen is deleted.
    raw.prepare('DELETE FROM expenses WHERE id = ?').run(original[3])
    // E. The row the cursor points at is deleted: seek uses the key value, not the row.
    raw.prepare('DELETE FROM expenses WHERE id = ?').run(original[9])
    const second = listExpenses(filter, { limit: 10, cursor: first.nextCursor! })
    expect(second.items.map((row) => row.id)).toEqual(original.slice(10, 20))
    expect(second.items.map((row) => row.id)).not.toContain(newerId)

    // C. An "older" row by the endpoint order — effective day precedes execution, so a
    // back-dated payment sorts after the cursor and is visited exactly once.
    const statementCustomer = fixture.bigCustomerId
    const firstPayments = customerStatement(statementCustomer, env.ctx, { sections: ['payments'], payments: { limit: 5 } }).payments
    const orderId = (raw.prepare('SELECT id FROM orders WHERE customer_id = ? LIMIT 1').get(statementCustomer) as { id: number }).id
    const backdated = Number(raw.prepare("INSERT INTO customer_payments (order_id, customer_id, amount_minor, paid_at, created_at) VALUES (?, ?, 1, '2000-01-01', '2026-09-15T00:00:00.000Z')").run(orderId, statementCustomer).lastInsertRowid)
    const rest: string[] = []
    let cursor = firstPayments.nextCursor
    while (cursor) {
      const page = customerStatement(statementCustomer, env.ctx, { sections: ['payments'], payments: { limit: 50, cursor } }).payments
      rest.push(...page.items.map((row) => row.rowKey))
      cursor = page.nextCursor
    }
    expect(rest.filter((key) => key === `payment-${backdated}`)).toHaveLength(1)
    expect(new Set([...firstPayments.items.map((row) => row.rowKey), ...rest]).size).toBe(firstPayments.items.length + rest.length)

    // F. Filters cannot silently reuse an incompatible cursor.
    expect(() => listExpenses({ ...filter, search: 'db10' }, { limit: 10, cursor: first.nextCursor! })).toThrow(/مؤشر الصفحة/)
    // G. Reopening restarts traversal and sees the inserted row first.
    expect(listExpenses(filter, { limit: 10 }).items[0]!.id).toBe(newerId)
  })
})
