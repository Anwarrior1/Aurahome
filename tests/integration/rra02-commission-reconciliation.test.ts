import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { traceQueries } from '../helpers/query-counter'
import { getRawConnection } from '@main/db/connection'
import { reconcileDatabase } from '@main/db/reconciliation'
import { createWorker, workerBalances, listWorkers, payWorkerCommission, assignWorkerToOrder, deleteWorker } from '@main/services/production/workers.service'
import { createAccount } from '@main/services/finance/cash.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createProduct } from '@main/services/products/products.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { archiveOrder } from '@main/services/sales/orders.service'
import { savePlannedWorkers } from '@main/services/planning/planning.service'
import { issueStandardStockFromBom, issueWorkSheet, completeProduction, issueRelease, recordDelivery, cancelDelivery, cancelProductionOrder, reverseWorkSheet, deleteProductionOrder } from '@main/services/production/production.service'
let env: TestEnv
let worker: number
const code = 'WORKER_EARNED_ON_OPEN_ORDER'
const raw = () => getRawConnection()
beforeEach(() => { env = setupTestDatabase(); worker = createWorker({ name: 'Fictional RRA02 worker' }, env.ctx) })
afterEach(() => env.cleanup())
function hashes() {
  const tables = raw().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{name: string}>
  return Object.fromEntries(tables.map(({name}) => [name, createHash('sha256').update(JSON.stringify(raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())).digest('hex')]))
}
function verify(label: string, expectedPayable: bigint, expectedCodes: string[] = []) {
  const before = hashes(), changes = raw().prepare('SELECT total_changes() n').get()
  const facts = raw().prepare('SELECT kind, amount_minor FROM worker_transactions WHERE worker_id=? ORDER BY id').all(worker) as Array<{kind: string; amount_minor: number}>
  let payable = 0n, debt = 0n
  for (const fact of facts) {
    expect(Number.isSafeInteger(fact.amount_minor)).toBe(true)
    const n = BigInt(fact.amount_minor)
    if (fact.kind === 'earning' || fact.kind === 'adjustment') payable += n
    if (fact.kind === 'commission_payment') payable -= n
    if (fact.kind === 'withdrawal') debt += n
    if (fact.kind === 'repayment') debt -= n
  }
  expect(payable).toBe(expectedPayable); expect(debt).toBe(0n)
  expect(workerBalances(worker)).toEqual({payableMinor: Number(expectedPayable), debtMinor: 0})
  expect(listWorkers().find(w => w.id === worker)).toMatchObject({payableMinor: Number(expectedPayable), debtMinor: 0})
  const trace = traceQueries(() => reconcileDatabase(raw()))
  expect(trace.count).toBe(73); expect(trace.result.checksRun).toBe(73)
  expect(trace.result.findings.map(f => f.code).sort()).toEqual([...expectedCodes].sort())
  const checks = trace.statements.map((sql, i) => ({index: i + 1, sql, violatingIds: raw().prepare(sql).pluck().all()}))
  expect(hashes()).toEqual(before); expect(raw().prepare('SELECT total_changes() n').get()).toEqual(changes)
  expect(raw().pragma('integrity_check')).toEqual([{integrity_check: 'ok'}]); expect(raw().pragma('foreign_key_check')).toEqual([])
  const evidence = process.env.RRA_EVIDENCE_DIR
  if (evidence) { mkdirSync(evidence, {recursive: true}); const fixture = raw().serialize(); writeFileSync(join(evidence, `${label}.db`), fixture); writeFileSync(join(evidence, `${label}.json`), JSON.stringify({label, fixtureSha256: createHash('sha256').update(fixture).digest('hex'), oracle: {payable: String(payable), debt: String(debt)}, projection: workerBalances(worker), checks, reconciliation: trace.result, tableHashes: before, readOnly: true}, null, 2)) }
}
function stock(amount = 50000) {
  const categoryId = createCategory({name: 'Fictional category'}, env.ctx)
  const materialId = createMaterial({sku: 'RRA02-M', name: 'Fictional material', categoryId, unit: 'unit', currentMarketPriceMicro: 0, pricingRule: 'exact'} as never, env.ctx)
  createPurchase({supplierId: createSupplier({name: 'Fictional supplier'}, env.ctx), lines: [{materialId, qtyMicro: 1000000, unitCostMicro: 0}]}, env.ctx)
  const productId = createProduct({code: 'RRA02-P', name: 'Fictional Standard', bom: [{materialId, qtyMicro: 1000000, unit: 'unit'}], commission: [{workerId: worker, amountMinor: amount}]}, env.ctx)
  return issueStandardStockFromBom({productId, quantityMicro: 1000000, requestKey: 'rra02-stock'}, env.ctx)
}
function order(commission = 50000, legacy = false) {
  const customerId = createCustomer({name: 'Fictional customer'}, env.ctx)
  const invoice = createFinalInvoice({customerId, depositPercentBp: 0, lines: [{lineKind: 'custom', description: 'Fictional custom job', quantityMicro: 1000000, unitPriceMinor: 9000000}]}, env.ctx)
  const {orderId} = approveFinalInvoice(invoice.id, env.ctx)
  if (legacy) { assignWorkerToOrder({orderId, workerId: worker, method: 'fixed', amountMinor: commission}, env.ctx); return {orderId, sheetId: undefined} }
  savePlannedWorkers({orderId}, [{workerId: worker, workerName: 'Fictional worker', estimatedCostMinor: commission}], env.ctx)
  return {orderId, sheetId: issueWorkSheet({orderId}, env.ctx).id}
}
function deliver(orderId: number) {
  const release = issueRelease({orderId, kind: 'delivery'}, env.ctx)
  return recordDelivery({orderId, releaseId: release.id, kind: 'handover'}, env.ctx)
}
describe('RRA02 commission source reconciliation and independent exact oracle', () => {
  it('accepts customer manufacturing before customer-order completion', () => {
    const job = order(); completeProduction(job.sheetId!, env.ctx); verify('order-manufactured', 50000n)
  })
  for (const payment of [0, 10000, 50000]) it(`accepts standalone Standard commission with payment ${payment}`, () => {
    stock(); if (payment) { const cashAccountId = createAccount({name: 'Fictional cash', kind: 'cash', openingBalanceMinor: 100000}, env.ctx); payWorkerCommission({workerId: worker, amountMinor: payment, cashAccountId, requestKey: `payment-${payment}`}, env.ctx) }
    verify(`standalone-payment-${payment}`, 50000n - BigInt(payment))
  })
  it('accepts mixed customer-linked and standalone sources for one worker', () => {
    stock(); const job = order(20000); completeProduction(job.sheetId!, env.ctx); verify('mixed', 70000n)
  })
  it('retains legacy order-completion provenance and negative reversal adjustments', () => {
    const job = order(20000, true), delivery = deliver(job.orderId); verify('legacy-completed', 20000n)
    cancelDelivery({id: delivery.id}, env.ctx); verify('legacy-reversed', 0n)
  })
  it('accepts an order-level assignment recognized by its manufacturing completion', () => {
    const job = order(20000, true), sheet = issueWorkSheet({orderId: job.orderId}, env.ctx)
    completeProduction(sheet.id, env.ctx); verify('manufactured-order-level-assignment', 20000n)
  })
  it('rejects duplicate accrual at the existing database constraint without residue', () => {
    stock(); const before = hashes(), row = raw().prepare("SELECT assignment_id FROM worker_transactions WHERE kind='earning'").get() as {assignment_id: number}
    expect(() => raw().prepare("INSERT INTO worker_transactions(worker_id,kind,amount_minor,assignment_id) VALUES(?,'earning',50000,?)").run(worker, row.assignment_id)).toThrow(/UNIQUE constraint failed/)
    expect(hashes()).toEqual(before); verify('duplicate-refused', 50000n)
  })
  it('rejects an earned standalone assignment with an orphaned source', () => {
    stock(); raw().exec('UPDATE order_worker_assignments SET work_sheet_id=NULL'); verify('orphan-source', 50000n, [code])
  })
  it('rejects a linked earning whose assignment is no longer marked earned', () => {
    stock(); raw().exec('UPDATE order_worker_assignments SET earned=0'); verify('unearned-linked-source', 50000n, [code])
  })
  it('rejects a linked earning whose worker differs from its assignment', () => {
    stock(); const other = createWorker({name: 'Other fictional worker'}, env.ctx)
    raw().prepare('UPDATE worker_transactions SET worker_id=?').run(other); verify('wrong-worker', 0n, [code])
  })
  it('rejects a linked earning whose amount differs from its assignment', () => {
    stock(); raw().exec('UPDATE worker_transactions SET amount_minor=49999'); verify('wrong-amount', 49999n, [code])
  })
  it('accepts cancellation before manufacturing with no commission', () => {
    const job = order(); cancelProductionOrder({id: job.sheetId!, reason: 'Fictional cancellation'}, env.ctx); verify('cancelled-before-start', 0n)
  })
  it('preserves completed standalone manufacturing cancellation and reversal refusal without residue', () => {
    const source = stock(), before = hashes()
    expect(() => cancelProductionOrder({id: source.workSheetId, reason: 'Fictional cancellation'}, env.ctx)).toThrow()
    expect(() => reverseWorkSheet({id: source.workSheetId, expectedToken: 'stock-source-is-irreversible', confirmation: source.documentNumber, reason: 'Fictional reversal'}, env.ctx)).toThrow()
    expect(hashes()).toEqual(before); verify('completed-stock-reversal-refused', 50000n)
  })
  it('rejects earned commission attached to a cancelled manufacturing source', () => {
    stock(); raw().exec("UPDATE work_sheets SET status='cancelled',cancelled_at=completed_at"); verify('invalid-cancelled-source', 50000n, [code, 'FG_PRODUCTION_LINK_MISMATCH'])
  })
  it('preserves issued-source deletion refusal and worker archival history', () => {
    const source = stock(), before = hashes(); expect(() => deleteProductionOrder(source.workSheetId, env.ctx)).toThrow(); expect(hashes()).toEqual(before)
    expect(deleteWorker(worker, env.ctx)).toEqual({deleted: false, archived: true}); verify('archived-worker-source-retained', 50000n)
  })
  it('accepts archived completed customer-order manufacturing history', () => {
    const job = order(); completeProduction(job.sheetId!, env.ctx); deliver(job.orderId); archiveOrder({id: job.orderId, archive: true}, env.ctx); verify('archived-order', 50000n)
  })
  it('preserves exact safe minor-unit values above the 32-bit boundary', () => {
    const amount = 2 ** 40 + 1; stock(amount); verify('large-exact-integer', BigInt(amount))
  })
  it('refuses negative Standard commission input without residue', () => {
    const before = hashes(); expect(() => createProduct({code: 'INVALID', name: 'Invalid fictional product', commission: [{workerId: worker, amountMinor: -1}]}, env.ctx)).toThrow(); expect(hashes()).toEqual(before); verify('negative-input-refused', 0n)
  })
})
