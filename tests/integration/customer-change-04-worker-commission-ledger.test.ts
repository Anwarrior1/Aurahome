import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { closeDatabase, getRawConnection, setDatabasePath } from '@main/db/connection'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { issueRelease, recordDelivery, cancelDelivery } from '@main/services/production/production.service'
import { savePlannedWorkers } from '@main/services/planning/planning.service'
import { issueWorkSheet, startProduction, completeProduction, productionActualCostMinor, issueStandardStockFromBom } from '@main/services/production/production.service'
import {
  createWorker, workerBalances, listWorkers, workerStatement, assignWorkerToOrder, payWorkerCommission,
  recordWorkerTransaction, updateWorkerTransaction, deleteWorkerTransaction, type WorkerTransactionSnapshot
} from '@main/services/production/workers.service'
import { createProduct } from '@main/services/products/products.service'
import { buildReport } from '@main/services/reports/reports.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor as m, formatMoney, money } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 70500
let event: IpcMainInvokeEvent
beforeEach(async () => {
  env = setupTestDatabase()
  event = { sender: { id: ++windowId } } as IpcMainInvokeEvent
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})
afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})

const raw = () => getRawConnection()
function tables() {
  return (raw().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
}
function expectRejectedWithoutResidue(operation: () => unknown, message: RegExp) {
  const before = tables()
  expect(operation).toThrow(message)
  expect(tables()).toEqual(before)
}
function authenticate(permissions: string[]) {
  const roleId = createRole({ name: `CC04 role ${windowId}`, permissions }, env.ctx)
  createUser({ username: `cc04-${windowId}`, fullName: 'CC04', password: 'secret123', roleId }, env.ctx)
  login(`cc04-${windowId}`, 'secret123', windowId)
}
const call = (channel: string, request: unknown) => handlers.get(channel)!(event, request)
const payable = (workerId: number) => workerBalances(workerId).payableMinor
const debt = (workerId: number) => workerBalances(workerId).debtMinor

let seq = 0
/** A customer Manufacturing Order whose تجهيز الإنتاج carries the given worker commissions. */
function customerOrder(commissions: Array<[workerId: number, major: number]>) {
  seq += 1
  const customerId = createCustomer({ name: `عميل CC04 ${seq}` }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: `مطبخ ${seq}`, quantityMicro: q(1), unitPriceMinor: m(9000) }] }, env.ctx)
  const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
  savePlannedWorkers({ orderId }, commissions.map(([workerId, major]) => ({ workerId, workerName: `عامل ${workerId}`, estimatedCostMinor: m(major) })), env.ctx)
  const sheet = issueWorkSheet({ orderId }, env.ctx)
  return { orderId, sheetId: sheet.id }
}
const cashBox = (openingMajor = 1000) => createAccount({ name: `خزينة ${++seq}`, kind: 'cash', openingBalanceMinor: m(openingMajor) }, env.ctx)
const snapshot = (id: number): WorkerTransactionSnapshot => {
  const row = raw().prepare('SELECT worker_id AS workerId, kind, amount_minor AS amountMinor, order_id AS orderId, reversal_of_transaction_id AS reversalOfTransactionId, cash_account_id AS cashAccountId, notes, created_at AS createdAt FROM worker_transactions WHERE id = ?').get(id)
  return row as WorkerTransactionSnapshot
}
const cashRows = (refId: number) => raw().prepare("SELECT * FROM cash_transactions WHERE ref_table = 'worker_transactions' AND ref_id = ?").all(refId)

describe('CC04 rule 1 — production commission becomes payable exactly once at manufacturing completion', () => {
  it('A/B/C: planned 500 is not payable before completion or after start; completion makes it payable and it enters actual labour cost', () => {
    const worker = createWorker({ name: 'نجار' }, env.ctx)
    const job = customerOrder([[worker, 500]])
    expect(payable(worker)).toBe(0)
    startProduction(job.sheetId, env.ctx)
    expect(payable(worker)).toBe(0)
    expect(raw().prepare('SELECT COUNT(*) AS c FROM worker_transactions').get()).toEqual({ c: 0 })
    completeProduction(job.sheetId, env.ctx)
    expect(payable(worker)).toBe(m(500))
    const [earning] = raw().prepare("SELECT * FROM worker_transactions WHERE kind = 'earning'").all() as Array<{ assignment_id: number; order_id: number; amount_minor: number }>
    expect(earning).toMatchObject({ order_id: job.orderId, amount_minor: m(500) })
    expect(raw().prepare('SELECT work_sheet_id, worker_id, amount_minor, earned FROM order_worker_assignments WHERE id = ?').get(earning.assignment_id))
      .toEqual({ work_sheet_id: job.sheetId, worker_id: worker, amount_minor: m(500), earned: 1 })
    expect(productionActualCostMinor(job.sheetId)).toBe(m(500))
  })

  it('D/Z: repeated completion, later order completion and reloads never recognise it twice; the database refuses a second earning', () => {
    const worker = createWorker({ name: 'دهان' }, env.ctx)
    const job = customerOrder([[worker, 500]])
    startProduction(job.sheetId, env.ctx)
    completeProduction(job.sheetId, env.ctx)
    expectRejectedWithoutResidue(() => completeProduction(job.sheetId, env.ctx), /./)
    const permit = issueRelease({ orderId: job.orderId, kind: 'delivery' }, env.ctx)
    const physical = recordDelivery({ orderId: job.orderId, releaseId: permit.id, kind: 'handover' }, env.ctx)
    cancelDelivery({ id: physical.id }, env.ctx)
    recordDelivery({ orderId: job.orderId, releaseId: permit.id, kind: 'handover' }, env.ctx)
    expect(payable(worker)).toBe(m(500))
    expect(listWorkers().find((w) => w.id === worker)).toMatchObject({ payableMinor: m(500) })
    expect(raw().prepare("SELECT COUNT(*) AS c FROM worker_transactions WHERE kind IN ('earning', 'adjustment')").get()).toEqual({ c: 1 })
    const assignmentId = (raw().prepare("SELECT assignment_id AS a FROM worker_transactions WHERE kind = 'earning'").get() as { a: number }).a
    expect(() => raw().prepare("INSERT INTO worker_transactions (worker_id, kind, amount_minor, assignment_id, created_at) VALUES (?, 'earning', 1, ?, '2026-09-17T00:00:00.000Z')").run(worker, assignmentId))
      .toThrow(/UNIQUE constraint failed/)
  })

  it('E/K: jobs accumulate and each worker receives only their own commissions (planned and manually assigned); zero commission posts nothing', () => {
    const a = createWorker({ name: 'أ' }, env.ctx)
    const b = createWorker({ name: 'ب' }, env.ctx)
    const c = createWorker({ name: 'ج' }, env.ctx)
    const first = customerOrder([[a, 500], [b, 200], [c, 0]])
    assignWorkerToOrder({ workSheetId: first.sheetId, workerId: b, method: 'fixed', amountMinor: m(100) }, env.ctx)
    completeProduction(first.sheetId, env.ctx)
    const second = customerOrder([[a, 300]])
    completeProduction(second.sheetId, env.ctx)
    expect([payable(a), payable(b), payable(c)]).toEqual([m(800), m(300), 0])
    expect(raw().prepare("SELECT COUNT(*) AS c FROM worker_transactions WHERE worker_id = ?").get(c)).toEqual({ c: 0 })
  })

  it('BL-05: atomic stock production credits the named worker exactly once and capitalises labour', () => {
    const planned = createWorker({ name: 'عامل قياسي' }, env.ctx)
    const extra = createWorker({ name: 'عامل إضافي' }, env.ctx)
    const categoryId = createCategory({ name: 'مواد قياسية' }, env.ctx)
    const materialId = createMaterial({ sku: 'CC04-M', name: 'مادة', categoryId, unit: 'unit', currentMarketPriceMicro: 0, pricingRule: 'exact' } as never, env.ctx)
    createPurchase({ supplierId: createSupplier({ name: 'مورد' }, env.ctx), lines: [{ materialId, qtyMicro: q(2), unitCostMicro: 0 }] }, env.ctx)
    const productId = createProduct({ code: 'CC04-P', name: 'منتج مخزون', bom: [{ materialId, qtyMicro: q(1), unit: 'unit' }], commission: [{ workerId: planned, amountMinor: m(100) }] }, env.ctx)
    expect([payable(planned), payable(extra)]).toEqual([0, 0])
    const result = issueStandardStockFromBom({ productId, quantityMicro: q(2), requestKey: 'cc04-stock-labour' }, env.ctx)
    expect([payable(planned), payable(extra)]).toEqual([m(200), 0])
    expect(() => assignWorkerToOrder({ workSheetId: result.workSheetId, workerId: extra, method: 'fixed', amountMinor: m(300) }, env.ctx)).toThrow()
    const movement = raw().prepare('SELECT total_cost_minor AS total FROM finished_goods_movements WHERE work_sheet_id = ?').get(result.workSheetId) as { total: number }
    expect(movement.total).toBe(m(200))
    expectRejectedWithoutResidue(() => completeProduction(result.workSheetId, env.ctx), /./)
    expect([payable(planned), payable(extra)]).toEqual([m(200), 0])
  })
})

describe('CC04 rules 2–4 — Workers section payable and commission "دفعة"', () => {
  function workerOwed(major: number) {
    const worker = createWorker({ name: `مستحق ${++seq}` }, env.ctx)
    const job = customerOrder([[worker, major]])
    completeProduction(job.sheetId, env.ctx)
    return worker
  }

  it('F/G/H: Workers list shows 800; "دفعة" 300 from Cash Box → payable 500 and cash −300 exactly; the same after a real restart', async () => {
    const worker = createWorker({ name: 'فني' }, env.ctx)
    completeProduction(customerOrder([[worker, 500]]).sheetId, env.ctx)
    completeProduction(customerOrder([[worker, 300]]).sheetId, env.ctx)
    const box = cashBox(1000)
    authenticate([P.workers.view, P.workers.finance])
    expect(await call(C.workers.list, {})).toMatchObject({ ok: true, data: expect.arrayContaining([expect.objectContaining({ id: worker, payableMinor: m(800), debtMinor: 0 })]) })

    const result = await call(C.workers.payCommission, { workerId: worker, amountMinor: m(300), cashAccountId: box, requestKey: 'cc04-pay-300-a' }) as IpcResult<{ id: number }>
    expect(result).toMatchObject({ ok: true })
    const paymentId = result.ok ? result.data.id : 0
    expect(payable(worker)).toBe(m(500))
    expect(accountBalance(box)).toBe(m(700))
    expect(cashRows(paymentId)).toMatchObject([{ account_id: box, direction: 'out', amount_minor: m(300), kind: 'worker_commission_payment' }])
    expect(raw().prepare("SELECT action FROM audit_log WHERE action = 'workers.commission.payment' AND entity_id = ?").all(String(paymentId))).toHaveLength(1)

    const dbFile = join(env.dir, readdirSync(env.dir).find((file) => file.endsWith('.db'))!)
    closeDatabase()
    setDatabasePath(dbFile)
    expect(workerBalances(worker)).toEqual({ payableMinor: m(500), debtMinor: 0 })
    expect(accountBalance(box)).toBe(m(700))
    expect(workerStatement(worker)).toMatchObject({ payableMinor: m(500), debtMinor: 0 })
  })

  it('I: overpayment is rejected with zero residue (service and IPC)', async () => {
    const worker = workerOwed(800)
    const box = cashBox(5000)
    expectRejectedWithoutResidue(() => payWorkerCommission({ workerId: worker, amountMinor: m(801), cashAccountId: box }, env.ctx), /أكبر من مستحقات/)
    authenticate([P.workers.finance])
    const before = tables()
    expect(await call(C.workers.payCommission, { workerId: worker, amountMinor: m(900), cashAccountId: box, requestKey: 'cc04-overpay-1' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(tables()).toEqual(before)
  })

  it('J: insufficient tracked cash (OD-04) is rejected with zero residue', () => {
    const worker = workerOwed(800)
    const box = cashBox(100)
    expectRejectedWithoutResidue(() => payWorkerCommission({ workerId: worker, amountMinor: m(300), cashAccountId: box }, env.ctx), /لا يكفي/)
    expect(accountBalance(box)).toBe(m(100))
  })

  it('L/Z: a retried payment request (same request key) pays and moves cash exactly once', async () => {
    const worker = workerOwed(800)
    const box = cashBox(1000)
    authenticate([P.workers.finance])
    const request = { workerId: worker, amountMinor: m(300), cashAccountId: box, requestKey: 'cc04-retry-key-1' }
    const first = await call(C.workers.payCommission, request)
    const second = await call(C.workers.payCommission, request)
    expect(first).toMatchObject({ ok: true })
    expect(second).toEqual(first)
    expect(raw().prepare("SELECT COUNT(*) AS c FROM worker_transactions WHERE kind = 'commission_payment'").get()).toEqual({ c: 1 })
    expect(raw().prepare("SELECT COUNT(*) AS c FROM cash_transactions WHERE kind = 'worker_commission_payment'").get()).toEqual({ c: 1 })
    expect(payable(worker)).toBe(m(500))
    expect(accountBalance(box)).toBe(m(700))
  })
})

describe('CC04 rule 5 — withdrawal / return debt ledger with exact edit and delete', () => {
  function withdrawal(worker: number, box: number, major: number) {
    return recordWorkerTransaction({ workerId: worker, kind: 'withdrawal', amountMinor: m(major), cashAccountId: box }, env.ctx)
  }
  function repayment(worker: number, box: number, major: number) {
    return recordWorkerTransaction({ workerId: worker, kind: 'repayment', amountMinor: m(major), cashAccountId: box }, env.ctx)
  }

  it('M/N/O: withdrawal 200 raises debt and lowers cash; return 50 lowers both; a return above debt is rejected with zero residue', async () => {
    const worker = createWorker({ name: 'ساحب' }, env.ctx)
    const box = cashBox(1000)
    withdrawal(worker, box, 200)
    expect([debt(worker), accountBalance(box)]).toEqual([m(200), m(800)])
    repayment(worker, box, 50)
    expect([debt(worker), accountBalance(box)]).toEqual([m(150), m(850)])
    expectRejectedWithoutResidue(() => repayment(worker, box, 151), /يتجاوز/)
    authenticate([P.workers.finance])
    const before = tables()
    expect(await call(C.workers.transaction, { workerId: worker, kind: 'repayment', amountMinor: m(200), cashAccountId: box, requestKey: 'cc04-return-over' }))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(tables()).toEqual(before)
  })

  it('P/Q: editing withdrawal 200 → 150 leaves only 150 of effect; deleting it removes the effect exactly once', () => {
    const worker = createWorker({ name: 'تعديل سحب' }, env.ctx)
    const box = cashBox(1000)
    const id = withdrawal(worker, box, 200)
    updateWorkerTransaction({ id, expected: snapshot(id), amountMinor: m(150) }, env.ctx)
    expect([debt(worker), accountBalance(box)]).toEqual([m(150), m(850)])
    expect(cashRows(id)).toMatchObject([{ amount_minor: m(150), direction: 'out' }])
    deleteWorkerTransaction({ id, expected: snapshot(id) }, env.ctx)
    expect([debt(worker), accountBalance(box)]).toEqual([0, m(1000)])
    expect(cashRows(id)).toEqual([])
    expect(() => deleteWorkerTransaction({ id, expected: { ...snapshot(id) } }, env.ctx)).toThrow()
  })

  it('R/S: editing return 50 → 30 leaves only 30 of effect; deleting it restores debt and cash exactly', () => {
    const worker = createWorker({ name: 'تعديل إرجاع' }, env.ctx)
    const box = cashBox(1000)
    withdrawal(worker, box, 200)
    const id = repayment(worker, box, 50)
    updateWorkerTransaction({ id, expected: snapshot(id), amountMinor: m(30) }, env.ctx)
    expect([debt(worker), accountBalance(box)]).toEqual([m(170), m(830)])
    expect(cashRows(id)).toMatchObject([{ amount_minor: m(30), direction: 'in' }])
    deleteWorkerTransaction({ id, expected: snapshot(id) }, env.ctx)
    expect([debt(worker), accountBalance(box)]).toEqual([m(200), m(800)])
  })

  it('edits and deletes that would push debt below zero are rejected with zero residue', () => {
    const worker = createWorker({ name: 'حدود' }, env.ctx)
    const box = cashBox(1000)
    const w = withdrawal(worker, box, 200)
    const r = repayment(worker, box, 150)
    expectRejectedWithoutResidue(() => deleteWorkerTransaction({ id: w, expected: snapshot(w) }, env.ctx), /يتجاوز/)
    expectRejectedWithoutResidue(() => updateWorkerTransaction({ id: w, expected: snapshot(w), amountMinor: m(100) }, env.ctx), /يتجاوز/)
    expectRejectedWithoutResidue(() => updateWorkerTransaction({ id: r, expected: snapshot(r), amountMinor: m(201) }, env.ctx), /يتجاوز/)
  })
})

describe('CC04 rule 6 — commission payable and worker debt stay separate', () => {
  it('T/U/V: payable 500 and debt 200 coexist; a payment changes payable only; withdrawal/return change debt only', () => {
    const worker = createWorker({ name: 'منفصل' }, env.ctx)
    completeProduction(customerOrder([[worker, 500]]).sheetId, env.ctx)
    const box = cashBox(2000)
    recordWorkerTransaction({ workerId: worker, kind: 'withdrawal', amountMinor: m(200), cashAccountId: box }, env.ctx)
    expect(workerBalances(worker)).toEqual({ payableMinor: m(500), debtMinor: m(200) })
    payWorkerCommission({ workerId: worker, amountMinor: m(100), cashAccountId: box }, env.ctx)
    expect(workerBalances(worker)).toEqual({ payableMinor: m(400), debtMinor: m(200) })
    recordWorkerTransaction({ workerId: worker, kind: 'repayment', amountMinor: m(50), cashAccountId: box }, env.ctx)
    expect(workerBalances(worker)).toEqual({ payableMinor: m(400), debtMinor: m(150) })
    const statement = workerStatement(worker)
    expect(statement.transactions.items.map((row) => row.kind).sort()).toEqual(['repayment', 'withdrawal'])
  })
})

describe('CC04 rule 8 / BL-17 — reversal adjustments are part of the authoritative payable everywhere', () => {
  it('W: a legacy order-completion earning reversed by completion reversal nets to 0 in the ledger AND the report; manufacturing earnings are untouched', () => {
    const legacy = createWorker({ name: 'W3' }, env.ctx)
    const manufacturing = createWorker({ name: 'W4' }, env.ctx)
    const job = customerOrder([[manufacturing, 400]])
    completeProduction(job.sheetId, env.ctx)
    // The legacy order-completion path is a separate, outsourced Custom
    // order. A completed internal MO can no longer accept a late assignment.
    const customerId = createCustomer({ name: 'Legacy outsourced customer' }, env.ctx)
    const invoice = createFinalInvoice({ customerId, depositPercentBp: 0,
      lines: [{ lineKind: 'custom', description: 'Outsourced', quantityMicro: q(1), unitPriceMinor: m(9000) }] }, env.ctx)
    const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
    assignWorkerToOrder({ orderId, workerId: legacy, method: 'fixed', amountMinor: m(200) }, env.ctx)
    const permit = issueRelease({ orderId, kind: 'delivery' }, env.ctx)
    const physical = recordDelivery({ orderId, releaseId: permit.id, kind: 'handover' }, env.ctx)
    expect([payable(legacy), payable(manufacturing)]).toEqual([m(200), m(400)])
    cancelDelivery({ id: physical.id }, env.ctx)
    expect([payable(legacy), payable(manufacturing)]).toEqual([0, m(400)])
    expect(raw().prepare("SELECT amount_minor FROM worker_transactions WHERE kind = 'adjustment'").all()).toEqual([{ amount_minor: -m(200) }])
    // BL-17: every reported payable/debt equals the authoritative ledger (reversal adjustments included).
    const report = buildReport({ key: 'worker_balances' })
    for (const worker of listWorkers()) {
      const reported = report.rows.find((r) => r['العامل'] === worker.name)!
      expect(reported['المستحقات الحالية']).toBe(formatMoney(money(worker.payableMinor)))
      expect(reported['المسحوبات والمرتجعات المستحقة']).toBe(formatMoney(money(worker.debtMinor)))
    }
    expect(report.rows.find((r) => r['العامل'] === 'W3')!['المستحقات الحالية']).toBe(formatMoney(money(0)))
  })
})

describe('CC04 — direct bypass, rollback and UI contracts', () => {
  it('X: IPC rejects missing permission, unknown kinds, extra fields, and editing/deleting non-manual (commission) rows — zero residue', async () => {
    const worker = createWorker({ name: 'تجاوز' }, env.ctx)
    completeProduction(customerOrder([[worker, 500]]).sheetId, env.ctx)
    const box = cashBox(1000)
    const paymentId = payWorkerCommission({ workerId: worker, amountMinor: m(100), cashAccountId: box }, env.ctx)
    const earningId = (raw().prepare("SELECT id FROM worker_transactions WHERE kind = 'earning'").get() as { id: number }).id

    authenticate([P.workers.view])
    let before = tables()
    expect(await call(C.workers.payCommission, { workerId: worker, amountMinor: m(1), cashAccountId: box, requestKey: 'cc04-noperm-1' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(tables()).toEqual(before)

    windowId += 1
    event = { sender: { id: windowId } } as IpcMainInvokeEvent
    authenticate([P.workers.finance])
    before = tables()
    const attempts: Array<[string, unknown]> = [
      [C.workers.transaction, { workerId: worker, kind: 'commission_payment', amountMinor: m(10), cashAccountId: box, requestKey: 'cc04-kind-1' }],
      [C.workers.transaction, { workerId: worker, kind: 'earning', amountMinor: m(10), requestKey: 'cc04-kind-2' }],
      [C.workers.payCommission, { workerId: worker, amountMinor: m(10), cashAccountId: box, kind: 'withdrawal', requestKey: 'cc04-extra-1' }],
      [C.workers.payCommission, { workerId: worker, amountMinor: -m(10), cashAccountId: box, requestKey: 'cc04-neg-1' }],
      [C.workers.payCommission, { workerId: worker, amountMinor: m(10), requestKey: 'cc04-noacct-1' }],
      [C.workers.updateTransaction, { id: paymentId, expected: snapshot(paymentId), amountMinor: m(5) }],
      [C.workers.deleteTransaction, { id: paymentId, expected: snapshot(paymentId) }],
      [C.workers.updateTransaction, { id: earningId, expected: snapshot(earningId), amountMinor: m(5) }],
      [C.workers.deleteTransaction, { id: earningId, expected: snapshot(earningId) }]
    ]
    for (const [channel, payload] of attempts) {
      expect((await call(channel, payload)).ok, channel).toBe(false)
      expect(tables()).toEqual(before)
    }
  })

  it.each([
    ['payment cash posting', () => "CREATE TRIGGER cc04_fail BEFORE INSERT ON cash_transactions WHEN NEW.kind = 'worker_commission_payment' BEGIN SELECT RAISE(ABORT, 'forced failure'); END", 'pay'],
    ['payment audit', () => "CREATE TRIGGER cc04_fail BEFORE INSERT ON audit_log WHEN NEW.action = 'workers.commission.payment' BEGIN SELECT RAISE(ABORT, 'forced failure'); END", 'pay'],
    ['withdrawal edit cash update', () => "CREATE TRIGGER cc04_fail BEFORE UPDATE ON cash_transactions BEGIN SELECT RAISE(ABORT, 'forced failure'); END", 'edit'],
    ['withdrawal delete audit', () => "CREATE TRIGGER cc04_fail BEFORE INSERT ON audit_log WHEN NEW.action = 'workers.withdrawal.delete' BEGIN SELECT RAISE(ABORT, 'forced failure'); END", 'delete'],
    ['commission recognition audit', () => "CREATE TRIGGER cc04_fail BEFORE INSERT ON audit_log WHEN NEW.action = 'workers.commission.recognize' BEGIN SELECT RAISE(ABORT, 'forced failure'); END", 'complete']
  ] as const)('Y: a failure at %s rolls everything back with zero residue', (_name, trigger, operation) => {
    const worker = createWorker({ name: 'تراجع' }, env.ctx)
    const job = customerOrder([[worker, 500]])
    if (operation !== 'complete') completeProduction(job.sheetId, env.ctx)
    const box = cashBox(1000)
    const w = recordWorkerTransaction({ workerId: worker, kind: 'withdrawal', amountMinor: m(200), cashAccountId: box }, env.ctx)
    raw().exec(trigger())
    const run = {
      pay: () => payWorkerCommission({ workerId: worker, amountMinor: m(100), cashAccountId: box }, env.ctx),
      edit: () => updateWorkerTransaction({ id: w, expected: snapshot(w), amountMinor: m(150) }, env.ctx),
      delete: () => deleteWorkerTransaction({ id: w, expected: snapshot(w) }, env.ctx),
      complete: () => completeProduction(job.sheetId, env.ctx)
    }[operation]
    expectRejectedWithoutResidue(run, /forced failure/)
  })

  it('AA/AB/AC: Workers UI exposes payable + "دفعة", renames the debt ledger and keeps Edit/Delete on manual withdrawal/return rows', () => {
    const page = readFileSync('src/renderer/pages/workers/WorkersPage.tsx', 'utf8')
    expect(page).toContain("header: 'المستحقات'")
    expect(page).toContain('fmtMoney(row.payableMinor)')
    expect(page).toContain('دفعة\n')
    expect(page).toContain("'workers',\n        'payCommission'")
    expect(page).toContain("header: 'المسحوبات والمرتجعات'")
    expect(page).toContain('سجل المسحوبات والمرتجعات')
    expect(page).not.toContain('كشف الحساب')
    expect(page).toContain('حركة')
    expect(page).toContain('row.manual && can(P.workers.finance)')
    expect(page).toContain('title="تعديل" aria-label="تعديل"')
    expect(page).toContain('title="حذف" aria-label="حذف"')
    expect(page).not.toContain("earning: { label")
  })
})
