import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { and, eq, like } from 'drizzle-orm'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { traceQueries } from '../helpers/query-counter'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { workers } from '@main/db/schema/production.schema'
import * as owner from '@main/services/production/workers.service'
import { createAccount } from '@main/services/finance/cash.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { savePlannedWorkers } from '@main/services/planning/planning.service'
import { issueWorkSheet, startProduction, completeProduction, issueRelease, recordDelivery, cancelDelivery } from '@main/services/production/production.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { acquireRestoreExclusivity, captureRestoreGeneration } from '@main/restore/restore-lifecycle'
import { reconcileDatabase } from '@main/db/reconciliation'
import { IPC_CHANNELS as C } from '@shared/constants/channels'

let env: TestEnv
const raw = () => getRawConnection()
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => { env.cleanup() })

/** Original list construction, copied before PERF-03; the single-worker projection stays unchanged. */
function originalList(filter: { search?: string; activeOnly?: boolean } = {}) {
  const clauses = []
  if (filter.search?.trim()) clauses.push(like(workers.name, `%${filter.search.trim()}%`))
  if (filter.activeOnly) clauses.push(eq(workers.active, true))
  const rows = getDatabase().select().from(workers).where(clauses.length ? and(...clauses) : undefined).all()
  return rows.map((worker) => ({ ...worker, ...owner.workerBalances(worker.id) }))
}

/** CC04 §3 integer oracle: separate ledgers; no joins, SUM, or production SQL constants. */
function oracle(id: number) {
  const facts = raw().prepare('SELECT kind, amount_minor FROM worker_transactions WHERE worker_id=?').all(id) as Array<{ kind: string; amount_minor: number }>
  let payable = 0n, debt = 0n
  for (const fact of facts) {
    expect(Number.isSafeInteger(fact.amount_minor)).toBe(true)
    const amount = BigInt(fact.amount_minor)
    switch (fact.kind) {
      case 'earning': case 'adjustment': payable += amount; break
      case 'commission_payment': payable -= amount; break
      case 'withdrawal': debt += amount; break
      case 'repayment': debt -= amount; break
    }
  }
  return { payableMinor: Number(payable), debtMinor: Number(debt) }
}
function hashes() {
  return Object.fromEntries((raw().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => {
    const hash = createHash('sha256')
    for (const row of raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).iterate()) hash.update(JSON.stringify(row))
    return [name, hash.digest('hex')]
  }))
}
function equivalent(filter: { search?: string; activeOnly?: boolean } = {}) {
  const expected = originalList(filter)
  for (const worker of expected) expect(owner.workerBalances(worker.id)).toStrictEqual(oracle(worker.id))
  const before = hashes(), changes = raw().prepare('SELECT total_changes() n').get()
  const result = owner.listWorkers(filter)
  expect(result).toStrictEqual(expected)
  expect(hashes()).toStrictEqual(before)
  expect(raw().prepare('SELECT total_changes() n').get()).toStrictEqual(changes)
  return result
}
function job(commissions: Array<[number, number]>) {
  const customerId = createCustomer({ name: 'PERF03 fictional customer' }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'PERF03 fictional work', quantityMicro: 1000000, unitPriceMinor: 900000 }] }, env.ctx)
  const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
  savePlannedWorkers({ orderId }, commissions.map(([workerId, estimatedCostMinor]) => ({ workerId, workerName: 'PERF03', estimatedCostMinor })), env.ctx)
  return { orderId, sheetId: issueWorkSheet({ orderId }, env.ctx).id }
}
function financialFixture() {
  const ids = Array.from({ length: 9 }, (_, i) => owner.createWorker({ name: i % 2 ? 'Shared worker' : `عامل PERF03 ${i}` }, env.ctx))
  const account = createAccount({ name: 'PERF03 fictional cash', kind: 'cash', openingBalanceMinor: 1000000 }, env.ctx)
  const j = job([[ids[1], 10001], [ids[2], 10001], [ids[3], 10001], [ids[4], 0]])
  equivalent() // Prepared is not accrued.
  startProduction(j.sheetId, env.ctx)
  equivalent() // Started is not accrued.
  completeProduction(j.sheetId, env.ctx)
  const permit = issueRelease({ orderId: j.orderId, kind: 'delivery' }, env.ctx)
  recordDelivery({ orderId: j.orderId, releaseId: permit.id, kind: 'handover' }, env.ctx)
  owner.payWorkerCommission({ workerId: ids[2], cashAccountId: account, amountMinor: 3001 }, env.ctx)
  owner.payWorkerCommission({ workerId: ids[2], cashAccountId: account, amountMinor: 2000 }, env.ctx)
  owner.payWorkerCommission({ workerId: ids[3], cashAccountId: account, amountMinor: 10001 }, env.ctx)
  for (const workerId of [ids[1], ids[4]]) {
    owner.recordWorkerTransaction({ workerId, kind: 'withdrawal', amountMinor: 9001, occurredAt: '2026-01-01' }, env.ctx)
    owner.recordWorkerTransaction({ workerId, kind: 'repayment', amountMinor: 2001, occurredAt: '2026-12-31' }, env.ctx)
  }
  owner.recordWorkerTransaction({ workerId: ids[5], kind: 'withdrawal', amountMinor: 17, occurredAt: '2025-12-31' }, env.ctx)
  owner.recordWorkerTransaction({ workerId: ids[5], kind: 'repayment', amountMinor: 17, occurredAt: '2027-01-01' }, env.ctx)
  for (let i = 0; i < 200; i++) owner.recordWorkerTransaction({ workerId: ids[6], kind: i % 2 ? 'repayment' : 'withdrawal', amountMinor: 1, occurredAt: '2026-06-01' }, env.ctx)
  // Existing legacy outsourced completion/reversal, including a valid negative payable after reversal of paid earning.
  const customerId = createCustomer({ name: 'PERF03 legacy outsourced' }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'Outsourced', quantityMicro: 1000000, unitPriceMinor: 900000 }] }, env.ctx)
  const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
  owner.assignWorkerToOrder({ orderId, workerId: ids[7], method: 'fixed', amountMinor: 101 }, env.ctx)
  const release = issueRelease({ orderId, kind: 'delivery' }, env.ctx)
  const delivery = recordDelivery({ orderId, releaseId: release.id, kind: 'handover' }, env.ctx)
  owner.payWorkerCommission({ workerId: ids[7], cashAccountId: account, amountMinor: 101 }, env.ctx)
  cancelDelivery({ id: delivery.id }, env.ctx)
  owner.deleteWorker(ids[4], env.ctx) // History means archive, not deletion.
  owner.deleteWorker(ids[8], env.ctx) // No history means physical deletion.
  return ids
}

describe('PERF-03 actual SQLite list read', () => {
  it.each([10, 100, 1000])('bounds executed SQL at %i fictional workers, with complete original/oracle equivalence', (size) => {
    for (let i = 0; i < size; i++) owner.createWorker({ name: `PERF03 ${i}` }, env.ctx)
    const old = traceQueries(() => originalList())
    expect(old.count).toBe(size + 1)
    const current = traceQueries(() => owner.listWorkers())
    console.log('PERF03_SQL', JSON.stringify({ size, original: old.count, current: current.count, classes: Object.fromEntries([...new Set(current.statements)].map(s => [s, current.statements.filter(x => x === s).length])) }))
    expect(current.result).toStrictEqual(old.result)
    expect(current.result).toHaveLength(size)
    equivalent()
    expect(current.count, 'worker list must execute at most two statements, independent of worker count').toBeLessThanOrEqual(2)
  })
  it('keeps commission recognition, settlements, signed reversals, debt, date boundaries, archives and zero/absent rows exact', () => {
    const ids = financialFixture(), rows = equivalent()
    const byId = new Map(rows.map(w => [w.id, w]))
    const expected = [[0, 0], [10001, 7000], [5000, 0], [0, 0], [0, 7000], [0, 0], [0, 0], [-101, 0]]
    expected.forEach(([payableMinor, debtMinor], i) => expect(byId.get(ids[i])).toMatchObject({ payableMinor, debtMinor }))
    expect(byId.get(ids[4])?.active).toBe(false)
    expect(byId.has(ids[8])).toBe(false)
    expect(reconcileDatabase(raw()).findings).toEqual([])
  })
  it('preserves all filters, wildcard matching, original SQLite row order and the unpaged DTO contract', () => {
    financialFixture()
    for (const filter of [{}, { activeOnly: true }, { activeOnly: false }, { search: ' Shared ' }, { search: '%' }, { search: '_' }, { search: 'عامل' }, { search: 'NO-MATCH' }, { search: '   ' }]) {
      const rows = equivalent(filter)
      expect(Array.isArray(rows)).toBe(true)
      expect(rows).not.toHaveProperty('nextCursor')
      expect(rows).not.toHaveProperty('summary')
    }
    expect(traceQueries(() => owner.listWorkers({ search: 'NO-MATCH' })).count).toBe(1)
  })
  it('isolates another worker despite equal amounts, dates, names and shared order references', () => {
    const ids = financialFixture(), before = equivalent().filter(w => w.id !== ids[0])
    owner.recordWorkerTransaction({ workerId: ids[0], kind: 'withdrawal', amountMinor: 9001, occurredAt: '2026-01-01' }, env.ctx)
    expect(equivalent().filter(w => w.id !== ids[0])).toStrictEqual(before)
  })
  it('keeps safe-integer precision without rounding and inherits an existing transaction without owning one', () => {
    const id = owner.createWorker({ name: 'PERF03 precision' }, env.ctx)
    owner.recordWorkerTransaction({ workerId: id, kind: 'withdrawal', amountMinor: Number.MAX_SAFE_INTEGER }, env.ctx)
    owner.recordWorkerTransaction({ workerId: id, kind: 'repayment', amountMinor: 1 }, env.ctx)
    expect(equivalent()[0].debtMinor).toBe(Number.MAX_SAFE_INTEGER - 1)
    const states: boolean[] = []
    const prep = raw().prepare
    raw().prepare = function (...args: Parameters<typeof prep>) { states.push(this.inTransaction); return prep.apply(this, args) } as typeof prep
    try {
      const outside = traceQueries(() => owner.listWorkers())
      expect(states.every(s => !s)).toBe(true)
      expect(outside.statements.every(s => /^SELECT/i.test(s))).toBe(true)
      states.length = 0
      raw().transaction(() => { owner.listWorkers(); expect(states.every(s => s)).toBe(true); expect(raw().inTransaction).toBe(true) })()
      expect(raw().inTransaction).toBe(false)
    } finally { raw().prepare = prep }
  })
  it('preserves registered anonymous/denied/reader/schema/restore guards and read-only financial DTOs', async () => {
    financialFixture()
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    try { (await import('@main/ipc/router')).registerIpcRouter() } finally { spy.mockRestore() }
    for (const [sender, permissions] of [[93031, []], [93032, ['workers.view']]] as const) {
      const roleId = createRole({ name: `PERF03 ${sender}`, permissions: [...permissions] }, env.ctx)
      createUser({ username: `perf03-${sender}`, fullName: 'Fictional', password: 'secret123', roleId }, env.ctx)
      login(`perf03-${sender}`, 'secret123', sender)
    }
    const call = (sender: number, payload: unknown = {}) => handlers.get(C.workers.list)!({ sender: { id: sender } } as IpcMainInvokeEvent, payload)
    const before = hashes()
    expect(await call(93030)).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
    expect(await call(93031)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await call(93032)).toStrictEqual({ ok: true, data: originalList() })
    expect(await call(1, { search: 1 })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    const release = await acquireRestoreExclusivity(captureRestoreGeneration())
    try { expect(await call(1)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } }) } finally { release() }
    expect(hashes()).toStrictEqual(before)
  })
  it('passes 53 migrations and every one of 73 reconciliations on fresh and valid populated fictional data', () => {
    for (const populated of [false, true]) {
      if (populated) financialFixture()
      const before = hashes()
      expect(raw().prepare('SELECT COUNT(*) n FROM __drizzle_migrations').get()).toEqual({ n: 53 })
      expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw().pragma('foreign_key_check')).toEqual([])
      const report = reconcileDatabase(raw())
      expect(report.checksRun).toBe(73)
      expect(report.findings).toEqual([])
      expect(report.errorCount).toBe(0)
      expect(report.warningCount).toBe(0)
      equivalent()
      expect(hashes()).toStrictEqual(before)
    }
  })
})
