import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { cashTransactions } from '@main/db/schema/finance.schema'
import { workerTransactions } from '@main/db/schema/production.schema'
import {
  createWorker,
  deleteWorkerTransaction,
  recordWorkerTransaction,
  updateWorkerTransaction,
  workerBalances,
  workerStatement,
  type WorkerTransactionSnapshot
} from '@main/services/production/workers.service'
import { accountBalance, createAccount } from '@main/services/finance/cash.service'
import { moneyFromMajor } from '@shared/money/money'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function fixture(kind: 'withdrawal' | 'repayment', amount = 200) {
  const workerId = createWorker({ name: `عامل-${kind}-${Math.random()}` }, env.ctx)
  const accountId = createAccount({
    name: `صندوق-${kind}-${Math.random()}`,
    kind: 'cash',
    openingBalanceMinor: moneyFromMajor(1000)
  }, env.ctx)
  // CC04: a return needs existing worker debt; the prior withdrawal carries no cash account.
  if (kind === 'repayment') recordWorkerTransaction({ workerId, kind: 'withdrawal', amountMinor: moneyFromMajor(500) }, env.ctx)
  const id = recordWorkerTransaction({
    workerId, kind, amountMinor: moneyFromMajor(amount), cashAccountId: accountId, notes: 'أصل'
  }, env.ctx)
  return { workerId, accountId, id }
}

function snapshot(workerId: number, id: number): WorkerTransactionSnapshot {
  const row = workerStatement(workerId).transactions.items.find((item) => item.id === id)
  if (!row) throw new Error('missing worker transaction')
  const { workerId: wid, kind, amountMinor, orderId, reversalOfTransactionId, cashAccountId, notes, createdAt } = row
  return { workerId: wid, kind, amountMinor, orderId, reversalOfTransactionId, cashAccountId, notes, createdAt }
}

function cashRows(id: number) {
  return getDatabase().select().from(cashTransactions).where(and(
    eq(cashTransactions.refTable, 'worker_transactions'),
    eq(cashTransactions.refId, id)
  )).all()
}

describe('manual Worker Financial Transaction corrections', () => {
  it('keeps historical adjustment rows readable with their original financial effect but rejects new adjustments', () => {
    const workerId = createWorker({ name: 'عامل تسوية تاريخية' }, env.ctx)
    const id = Number(getDatabase().insert(workerTransactions).values({
      workerId, kind: 'adjustment', amountMinor: moneyFromMajor(75), notes: 'تسوية قديمة'
    }).run().lastInsertRowid)

    // CC04: an adjustment belongs to the commission payable, not to the withdrawal/return ledger.
    expect(getDatabase().select().from(workerTransactions).where(eq(workerTransactions.id, id)).get()).toMatchObject({
      kind: 'adjustment', amountMinor: moneyFromMajor(75), notes: 'تسوية قديمة'
    })
    expect(workerStatement(workerId).transactions.items.find((row) => row.id === id)).toBeUndefined()
    expect(workerBalances(workerId)).toEqual({ payableMinor: moneyFromMajor(75), debtMinor: 0 })
    expect(() => recordWorkerTransaction({
      workerId, kind: 'adjustment', amountMinor: moneyFromMajor(10)
    } as never, env.ctx)).toThrowError(/غير مسموح/)
    expect(workerBalances(workerId)).toEqual({ payableMinor: moneyFromMajor(75), debtMinor: 0 })
  })

  it('marks only withdrawal and repayment business rows as manual action targets', () => {
    const workerId = createWorker({ name: 'عامل أهلية' }, env.ctx)
    const withdrawal = recordWorkerTransaction({ workerId, kind: 'withdrawal', amountMinor: moneyFromMajor(20) }, env.ctx)
    const repayment = recordWorkerTransaction({ workerId, kind: 'repayment', amountMinor: moneyFromMajor(10) }, env.ctx)
    getDatabase().insert(workerTransactions).values({ workerId, kind: 'earning', amountMinor: moneyFromMajor(50), notes: 'عمولة طلب' }).run()
    getDatabase().insert(workerTransactions).values({ workerId, kind: 'adjustment', amountMinor: moneyFromMajor(-5), notes: 'عكس تاريخي' }).run()

    const rows = workerStatement(workerId).transactions.items
    expect(rows.find((row) => row.id === withdrawal)?.manual).toBe(true)
    expect(rows.find((row) => row.id === repayment)?.manual).toBe(true)
    expect(rows.filter((row) => row.kind === 'earning' || row.kind === 'adjustment')).toEqual([])
  })

  it.each([
    ['withdrawal', 150, 150, 'out'],
    ['repayment', 100, 400, 'in']
  ] as const)('edits %s 200 to %i and synchronizes worker and exact cash effects', (kind, nextMajor, debtMajor, direction) => {
    const f = fixture(kind)
    updateWorkerTransaction({
      id: f.id, expected: snapshot(f.workerId, f.id), amountMinor: moneyFromMajor(nextMajor),
      cashAccountId: f.accountId, notes: 'مصححة'
    }, env.ctx)

    expect(workerBalances(f.workerId).debtMinor).toBe(moneyFromMajor(debtMajor))
    expect(workerStatement(f.workerId).transactions.items.find((row) => row.id === f.id)).toMatchObject({
      amountMinor: moneyFromMajor(nextMajor), notes: 'مصححة'
    })
    expect(cashRows(f.id)).toMatchObject([{ amountMinor: moneyFromMajor(nextMajor), accountId: f.accountId, direction }])
  })

  it('moves the linked effect from account A to B without duplicating it', () => {
    const f = fixture('withdrawal')
    const accountB = createAccount({ name: 'صندوق ب', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    updateWorkerTransaction({
      id: f.id, expected: snapshot(f.workerId, f.id), amountMinor: moneyFromMajor(150), cashAccountId: accountB
    }, env.ctx)
    expect(accountBalance(f.accountId)).toBe(moneyFromMajor(1000))
    expect(accountBalance(accountB)).toBe(moneyFromMajor(850))
    expect(cashRows(f.id)).toMatchObject([{ accountId: accountB, amountMinor: moneyFromMajor(150) }])
  })

  it.each([
    ['withdrawal', 1000, 0],
    ['repayment', 1000, 500]
  ] as const)('deletes %s once and restores worker and cash as if it never existed', (kind, opening, debtMajor) => {
    const f = fixture(kind)
    const expected = snapshot(f.workerId, f.id)
    deleteWorkerTransaction({ id: f.id, expected }, env.ctx)
    expect(workerBalances(f.workerId).debtMinor).toBe(moneyFromMajor(debtMajor))
    expect(accountBalance(f.accountId)).toBe(moneyFromMajor(opening))
    expect(cashRows(f.id)).toEqual([])
    const audit = getRawConnection().prepare(
      "SELECT details FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY id DESC LIMIT 1"
    ).get(`workers.${kind}.delete`, String(f.id)) as { details: string }
    expect(JSON.parse(audit.details)).toMatchObject({
      before: { id: f.id, workerId: f.workerId, kind, amountMinor: moneyFromMajor(200) },
      reversedByUserId: env.ctx.session.user.id
    })
    expect(() => deleteWorkerTransaction({ id: f.id, expected }, env.ctx)).toThrowError(/غير موجودة|حذفها/)
    expect(accountBalance(f.accountId)).toBe(moneyFromMajor(opening))
  })

  it('rejects a stale edit without changing either financial side', () => {
    const f = fixture('withdrawal')
    const stale = snapshot(f.workerId, f.id)
    updateWorkerTransaction({ id: f.id, expected: stale, amountMinor: moneyFromMajor(150) }, env.ctx)
    expect(() => updateWorkerTransaction({ id: f.id, expected: stale, amountMinor: moneyFromMajor(100) }, env.ctx)).toThrowError(/تم تغيير/)
    expect(workerBalances(f.workerId).debtMinor).toBe(moneyFromMajor(150))
    expect(cashRows(f.id)[0]?.amountMinor).toBe(moneyFromMajor(150))
  })

  it('rolls back the worker edit if the linked cash update fails', () => {
    const f = fixture('withdrawal')
    getRawConnection().exec("CREATE TRIGGER block_worker_cash_edit BEFORE UPDATE ON cash_transactions BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")
    expect(() => updateWorkerTransaction({
      id: f.id, expected: snapshot(f.workerId, f.id), amountMinor: moneyFromMajor(150)
    }, env.ctx)).toThrow()
    expect(workerBalances(f.workerId).debtMinor).toBe(moneyFromMajor(200))
    expect(cashRows(f.id)[0]?.amountMinor).toBe(moneyFromMajor(200))
  })

  it('rolls back linked cash removal if deleting the worker row fails', () => {
    const f = fixture('repayment')
    getRawConnection().exec("CREATE TRIGGER block_worker_tx_delete BEFORE DELETE ON worker_transactions BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")
    expect(() => deleteWorkerTransaction({ id: f.id, expected: snapshot(f.workerId, f.id) }, env.ctx)).toThrow()
    expect(workerBalances(f.workerId).debtMinor).toBe(moneyFromMajor(300))
    expect(cashRows(f.id)).toHaveLength(1)
    expect(accountBalance(f.accountId)).toBe(moneyFromMajor(1200))
  })
})
