import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { reconcileDatabase } from '@main/db/reconciliation'
import { createWorker, payWorkerCommission, recordWorkerTransaction, workerBalances } from '@main/services/production/workers.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { createExpense } from '@main/services/finance/expenses.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { savePlannedWorkers } from '@main/services/planning/planning.service'
import { issueWorkSheet, completeProduction, issueRelease, recordDelivery } from '@main/services/production/production.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS as C } from '@shared/constants/channels'

let env: TestEnv
const raw = () => getRawConnection()
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(raw().pragma('foreign_key_check')).toEqual([])
  env.cleanup()
})

function logicalSnapshot() {
  return (raw().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
}
function check() {
  const before = logicalSnapshot()
  const changes = raw().prepare('SELECT total_changes() AS n').get()
  const report = reconcileDatabase(raw())
  expect(logicalSnapshot()).toEqual(before)
  expect(raw().prepare('SELECT total_changes() AS n').get()).toEqual(changes)
  expect(report.checksRun).toBe(73)
  return report
}
function fixture() {
  const workerId = createWorker({ name: 'E2E03 fictional worker' }, env.ctx)
  const accountId = createAccount({ name: 'E2E03 funded cash', kind: 'cash', openingBalanceMinor: 50000 }, env.ctx)
  const otherAccountId = createAccount({ name: 'E2E03 other cash', kind: 'cash', openingBalanceMinor: 20000 }, env.ctx)
  const customerId = createCustomer({ name: 'E2E03 fictional customer' }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'E2E03 fictional job', quantityMicro: 1000000, unitPriceMinor: 90000 }] }, env.ctx)
  const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
  savePlannedWorkers({ orderId }, [{ workerId, workerName: 'E2E03 fictional worker', estimatedCostMinor: 10000 }], env.ctx)
  const sheet = issueWorkSheet({ orderId }, env.ctx)
  completeProduction(sheet.id, env.ctx)
  const release = issueRelease({ orderId, kind: 'delivery' }, env.ctx)
  recordDelivery({ orderId, releaseId: release.id, kind: 'handover' }, env.ctx)
  expect(raw().prepare('SELECT status FROM work_sheets WHERE id=?').get(sheet.id)).toEqual({ status: 'completed' })
  expect(workerBalances(workerId)).toEqual({ payableMinor: 10000, debtMinor: 0 })
  expect(accountBalance(accountId)).toBe(50000)
  expect(check().findings).toEqual([])
  return { workerId, accountId, otherAccountId }
}
function payment() {
  const f = fixture()
  const id = payWorkerCommission({ workerId: f.workerId, cashAccountId: f.accountId, amountMinor: 10000, requestKey: 'e2e03-valid-payment' }, env.ctx)
  const cash = raw().prepare("SELECT id,account_id,direction,amount_minor,kind,ref_table,ref_id FROM cash_transactions WHERE ref_table='worker_transactions' AND ref_id=?").get(id) as { id: number }
  expect(raw().prepare('SELECT kind,amount_minor,cash_account_id,order_id,reversal_of_transaction_id FROM worker_transactions WHERE id=?').get(id))
    .toEqual({ kind: 'commission_payment', amount_minor: 10000, cash_account_id: f.accountId, order_id: null, reversal_of_transaction_id: null })
  expect(cash).toEqual({ id: cash.id, account_id: f.accountId, direction: 'out', amount_minor: 10000, kind: 'worker_commission_payment', ref_table: 'worker_transactions', ref_id: id })
  expect(raw().prepare("SELECT entity_id FROM audit_log WHERE action='workers.commission.payment'").all()).toEqual([{ entity_id: String(id) }])
  expect(workerBalances(f.workerId)).toEqual({ payableMinor: 0, debtMinor: 0 })
  expect(accountBalance(f.accountId)).toBe(40000)
  return { ...f, id, cashId: cash.id }
}
function mismatch(id: number) {
  expect(check().findings).toContainEqual(expect.objectContaining({ code: 'CASH_SOURCE_MIRROR_MISMATCH', entity: 'worker_transactions', sampleIds: expect.arrayContaining([id]) }))
}

describe('E2E03 — legitimate commission mirrors and read-only reconciliation', () => {
  it('RED: a real completed worksheet commission payment has an exact cash mirror, one audit and zero findings', () => {
    const p = payment()
    const report = check()
    console.log('E2E03_ORACLE', JSON.stringify({ sourceId: p.id, cashId: p.cashId, payableBefore: 10000, payableAfter: 0, cashBefore: 50000, cashAfter: 40000, report }))
    expect(report.findings).toEqual([])
    expect(report.errorCount).toBe(0)
    expect(report.warningCount).toBe(0)
  })
  it.each(['missing', 'account', 'amount', 'direction', 'reference', 'duplicate'] as const)('detects %s mirror with the exact source ID; checker stays read-only', (kind) => {
    const p = payment()
    if (kind === 'missing') raw().prepare('DELETE FROM cash_transactions WHERE id=?').run(p.cashId)
    if (kind === 'account') raw().prepare('UPDATE cash_transactions SET account_id=? WHERE id=?').run(p.otherAccountId, p.cashId)
    if (kind === 'amount') raw().prepare('UPDATE cash_transactions SET amount_minor=9999 WHERE id=?').run(p.cashId)
    if (kind === 'direction') raw().prepare("UPDATE cash_transactions SET direction='in' WHERE id=?").run(p.cashId)
    if (kind === 'reference') raw().prepare('UPDATE cash_transactions SET ref_id=999999 WHERE id=?').run(p.cashId)
    if (kind === 'duplicate') raw().prepare(`INSERT INTO cash_transactions (account_id,direction,amount_minor,kind,ref_table,ref_id,occurred_at,created_at)
      SELECT account_id,direction,amount_minor,kind,ref_table,ref_id,occurred_at,created_at FROM cash_transactions WHERE id=?`).run(p.cashId)
    mismatch(p.id)
    if (kind === 'reference') expect(check().findings).toContainEqual(expect.objectContaining({ code: 'CASH_ORPHAN_MIRROR', sampleIds: [p.cashId] }))
  })
  it('records the established limit: cash kind is not an invariant of the generic mirror checker', () => {
    const p = payment()
    raw().prepare("UPDATE cash_transactions SET kind='worker_withdrawal' WHERE id=?").run(p.cashId)
    expect(check().findings).toEqual([])
  })
  it.each([true, false])('preserves legitimate withdrawal/repayment with tracked account=%s', (tracked) => {
    const f = fixture()
    for (const kind of ['withdrawal', 'repayment'] as const) {
      recordWorkerTransaction({ workerId: f.workerId, kind, amountMinor: 5000, cashAccountId: tracked ? f.accountId : undefined }, env.ctx)
      expect(check().findings).toEqual([])
    }
    expect(workerBalances(f.workerId)).toEqual({ payableMinor: 10000, debtMinor: 0 })
    expect(accountBalance(f.accountId)).toBe(50000)
  })
  it('preserves no-worker transactions and other valid financial mirrors', () => {
    expect(check().findings).toEqual([])
    fixture() // Completed commercial/production records and earning: no cash for earning.
    expect(check().findings).toEqual([])
  })
  it('preserves an independently posted expense cash mirror beside the commission mirror', () => {
    const p = payment()
    const expenseId = createExpense({ amountMinor: 2000, cashAccountId: p.accountId, description: 'E2E03 unrelated legitimate expense' }, env.ctx)
    expect(raw().prepare("SELECT direction,amount_minor,kind FROM cash_transactions WHERE ref_table='expenses' AND ref_id=?").get(expenseId))
      .toEqual({ direction: 'out', amount_minor: 2000, kind: 'expense' })
    expect(accountBalance(p.accountId)).toBe(38000)
    expect(workerBalances(p.workerId).payableMinor).toBe(0)
    expect(check().findings).toEqual([])
  })
  it('required payment audit failure rolls back source, cash and durable command', () => {
    const f = fixture()
    raw().exec("CREATE TEMP TRIGGER e2e03_fail_audit BEFORE INSERT ON audit_log WHEN NEW.action='workers.commission.payment' BEGIN SELECT RAISE(ABORT,'E2E03 audit fault'); END")
    const before = logicalSnapshot()
    expect(() => payWorkerCommission({ ...f, amountMinor: 10000, requestKey: 'e2e03-audit-rollback' }, env.ctx)).toThrow()
    expect(logicalSnapshot()).toEqual(before)
    expect(check().findings).toEqual([])
    raw().exec('DROP TRIGGER e2e03_fail_audit')
  })
  it('actual registered IPC enforces permission/validation and idempotent legitimate payment', async () => {
    const f = fixture()
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
    const roleId = createRole({ name: 'E2E03 no finance', permissions: ['workers.view'] }, env.ctx)
    createUser({ username: 'e2e03-restricted', fullName: 'E2E03 restricted', password: 'secret123', roleId }, env.ctx)
    login('e2e03-restricted', 'secret123', 93003)
    const call = (sender: number, request: unknown) => handlers.get(C.workers.payCommission)!({ sender: { id: sender } } as IpcMainInvokeEvent, request)
    const request = { workerId: f.workerId, cashAccountId: f.accountId, amountMinor: 10000, requestKey: 'e2e03-ipc-payment' }
    const before = logicalSnapshot()
    expect(await call(93003, request)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await call(1, { ...request, amountMinor: 0 })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(logicalSnapshot()).toEqual(before)
    const first = await call(1, request)
    expect(first).toMatchObject({ ok: true })
    const committed = logicalSnapshot()
    expect(await call(1, request)).toEqual(first)
    expect(logicalSnapshot()).toEqual(committed)
    expect(workerBalances(f.workerId).payableMinor).toBe(0)
    expect(accountBalance(f.accountId)).toBe(40000)
    expect(raw().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='workers.commission.payment'").get()).toEqual({ n: 1 })
    expect(check().findings).toEqual([])
  })
})
