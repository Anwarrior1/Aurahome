import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { readFileSync } from 'node:fs'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import * as workers from '@main/services/production/workers.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createProduct } from '@main/services/products/products.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { issueStandardStockFromBom } from '@main/services/production/production.service'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import type { IpcResult } from '@shared/types/ipc.types'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<IpcResult<unknown>>>
let workerId: number
let accountId: number
let actorId = 81000
let event: IpcMainInvokeEvent
const raw = () => getRawConnection()
function snapshot() {
  return (raw().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
}
function actor(permissions: string[]) {
  const id = ++actorId
  const roleId = createRole({ name: `UI05 role ${id}`, permissions }, env.ctx)
  createUser({ username: `ui05-${id}`, fullName: 'UI05', password: 'secret123', roleId }, env.ctx)
  const { session } = login(`ui05-${id}`, 'secret123', id)
  event = { sender: { id } } as IpcMainInvokeEvent
  return { session }
}
const call = (channel: string, input: unknown = {}) => handlers.get(channel)!(event, input)
const payment = (requestKey = 'ui05-payment-once') => ({ workerId, cashAccountId: accountId, amountMinor: m(10), requestKey })

beforeEach(async () => {
  env = setupTestDatabase()
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => {
    expect(handlers.has(channel)).toBe(false)
    handlers.set(channel, handler)
  }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
  workerId = workers.createWorker({ name: 'UI05 worker' }, env.ctx)
  accountId = createAccount({ name: 'UI05 selector', kind: 'cash', openingBalanceMinor: m(100), notes: 'PRIVATE NOTE' }, env.ctx)
  const categoryId = createCategory({ name: 'UI05 material' }, env.ctx)
  const materialId = createMaterial({ sku: 'UI05-M', name: 'Material', categoryId, unit: 'unit', currentMarketPriceMicro: 0, pricingRule: 'exact' } as never, env.ctx)
  createPurchase({ supplierId: createSupplier({ name: 'Supplier' }, env.ctx), lines: [{ materialId, qtyMicro: q(1), unitCostMicro: 0 }] }, env.ctx)
  const productId = createProduct({ code: 'UI05-P', name: 'Stock', bom: [{ materialId, qtyMicro: q(1), unit: 'unit' }], commission: [{ workerId, amountMinor: m(50) }] }, env.ctx)
  issueStandardStockFromBom({ productId, quantityMicro: q(1), requestKey: 'ui05-earned-fixture' }, env.ctx)
})
afterEach(() => {
  expect(raw().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(raw().pragma('foreign_key_check')).toEqual([])
  env.cleanup()
})

describe('UI-WF-05 permission-safe commission account selection', () => {
  it('restricted payer obtains ID/name only through direct service and registered IPC; reads are pure', async () => {
    const ctx = actor([P.workers.view, P.workers.finance])
    const before = snapshot()
    const choices = workers.listCommissionPaymentAccounts(ctx)
    expect(choices).toContainEqual({ id: accountId, name: 'UI05 selector' })
    for (const choice of choices) expect(Object.keys(choice).sort()).toEqual(['id', 'name'])
    expect(await call(C.workers.commissionAccounts)).toEqual({ ok: true, data: choices })
    expect(workers.listCommissionPaymentAccounts(ctx)).toEqual(choices)
    expect(snapshot()).toEqual(before)
  })
  it('restricted payer still cannot read broad accounts, cash journal or adjust cash', async () => {
    actor([P.workers.view, P.workers.finance])
    for (const channel of [C.cash.accounts, C.cash.transactions]) expect(await call(channel)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await call(C.cash.adjustBalance, { accountId, desiredBalanceMinor: m(100), reason: 'UI05', requestKey: 'ui05-denied-adjustment' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
  it('restricted payer pays 10 of 50 exactly once with linked cash source and required audit', async () => {
    const ctx = actor([P.workers.view, P.workers.finance])
    const result = await call(C.workers.payCommission, payment()) as IpcResult<{ id: number }>
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    const id = result.data.id
    expect(workers.workerBalances(workerId)).toEqual({ payableMinor: m(40), debtMinor: 0 })
    expect(accountBalance(accountId)).toBe(m(90))
    expect(raw().prepare("SELECT worker_id, amount_minor, cash_account_id, created_by FROM worker_transactions WHERE id=? AND kind='commission_payment'").get(id)).toEqual({ worker_id: workerId, amount_minor: m(10), cash_account_id: accountId, created_by: ctx.session.user.id })
    expect(raw().prepare("SELECT account_id, direction, amount_minor, ref_table, ref_id FROM cash_transactions WHERE kind='worker_commission_payment'").all()).toEqual([{ account_id: accountId, direction: 'out', amount_minor: m(10), ref_table: 'worker_transactions', ref_id: id }])
    expect(raw().prepare("SELECT user_id, entity_id FROM audit_log WHERE action='workers.commission.payment'").all()).toEqual([{ user_id: ctx.session.user.id, entity_id: String(id) }])
    const beforeRetry = snapshot()
    expect(await call(C.workers.payCommission, payment())).toEqual(result)
    expect(snapshot()).toEqual(beforeRetry)
  })
  it.each([
    ['view only', [P.workers.view]],
    ['cash only', [P.cash.view]],
    ['neither', []]
  ])('%s actor cannot abuse direct selector or commission mutation', async (_name, permissions) => {
    const ctx = actor(permissions)
    const before = snapshot()
    expect(() => workers.listCommissionPaymentAccounts(ctx)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => workers.payWorkerCommission(payment(), ctx)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(await call(C.workers.commissionAccounts)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await call(C.workers.payCommission, payment())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(snapshot()).toEqual(before)
  })
  it('finance-only actor has owner capability but does not gain worker view', async () => {
    const ctx = actor([P.workers.finance])
    expect(workers.listCommissionPaymentAccounts(ctx)).toContainEqual({ id: accountId, name: 'UI05 selector' })
    expect(await call(C.workers.list)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await call(C.workers.payCommission, payment())).toMatchObject({ ok: true })
  })
  it('both worker capabilities plus cash.view retain both legitimate reads and payment', async () => {
    actor([P.workers.view, P.workers.finance, P.cash.view])
    expect(await call(C.workers.list)).toMatchObject({ ok: true })
    expect(await call(C.workers.commissionAccounts)).toMatchObject({ ok: true })
    expect(await call(C.cash.accounts)).toMatchObject({ ok: true })
    expect(await call(C.workers.payCommission, payment())).toMatchObject({ ok: true })
  })
  it('view-only worker list and cash-only broad read retain their existing permissions', async () => {
    actor([P.workers.view])
    expect(await call(C.workers.list)).toMatchObject({ ok: true })
    actor([P.cash.view])
    expect(await call(C.cash.accounts)).toMatchObject({ ok: true })
    expect(await call(C.workers.list)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
  it('owner rejects an account removed after selection without residue', async () => {
    const staleId = createAccount({ name: 'stale', kind: 'bank', openingBalanceMinor: m(20) }, env.ctx)
    const ctx = actor([P.workers.finance])
    expect(workers.listCommissionPaymentAccounts(ctx)).toContainEqual({ id: staleId, name: 'stale' })
    raw().prepare('DELETE FROM cash_accounts WHERE id=?').run(staleId)
    const before = snapshot()
    expect(() => workers.payWorkerCommission({ ...payment(), cashAccountId: staleId }, ctx)).toThrow('الحساب النقدي غير موجود')
    expect(snapshot()).toEqual(before)
  })
  it('owner rechecks funds after selection; lookup is not account validation', () => {
    const lowId = createAccount({ name: 'stale funds', kind: 'cash', openingBalanceMinor: m(15) }, env.ctx)
    const ctx = actor([P.workers.finance])
    expect(workers.listCommissionPaymentAccounts(ctx)).toContainEqual({ id: lowId, name: 'stale funds' })
    workers.payWorkerCommission({ ...payment('ui05-drain-funds'), cashAccountId: lowId }, ctx)
    expect(accountBalance(lowId)).toBe(m(5))
    const before = snapshot()
    expect(() => workers.payWorkerCommission({ ...payment(), amountMinor: m(6), cashAccountId: lowId }, ctx)).toThrow('رصيد الحساب النقدي لا يكفي')
    expect(snapshot()).toEqual(before)
  })
  it('inactive accounts retain established owner behavior, without inventing an eligibility policy', () => {
    raw().prepare('UPDATE cash_accounts SET active=0 WHERE id=?').run(accountId)
    const ctx = actor([P.workers.finance])
    expect(workers.listCommissionPaymentAccounts(ctx)).toContainEqual({ id: accountId, name: 'UI05 selector' })
    workers.payWorkerCommission(payment(), ctx)
    expect(workers.workerBalances(workerId).payableMinor).toBe(m(40))
  })
  it('required audit failure rolls payment and cash back, then same identity retries once', async () => {
    actor([P.workers.finance])
    raw().exec("CREATE TRIGGER ui05_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action='workers.commission.payment' BEGIN SELECT RAISE(ABORT, 'UI05 audit failure'); END")
    const before = snapshot()
    expect(await call(C.workers.payCommission, payment())).toMatchObject({ ok: false })
    expect(snapshot()).toEqual(before)
    raw().exec('DROP TRIGGER ui05_audit_failure')
    expect(await call(C.workers.payCommission, payment())).toMatchObject({ ok: true })
    expect(workers.workerBalances(workerId).payableMinor).toBe(m(40))
    expect(raw().prepare("SELECT COUNT(*) AS count FROM cash_transactions WHERE kind='worker_commission_payment'").get()).toEqual({ count: 1 })
  })
  it('selector IPC rejects unexpected inputs', async () => {
    actor([P.workers.finance])
    expect(await call(C.workers.commissionAccounts, { arbitrarySql: 'SELECT *' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })
  it('renderer commission selector uses the narrow read and displays read errors with retry', () => {
    const page = readFileSync('src/renderer/pages/workers/WorkersPage.tsx', 'utf8')
    expect(page).toContain("('workers', 'commissionAccounts', undefined, { enabled: can(P.workers.finance) })")
    const modal = page.slice(page.indexOf('title={`دفعة مستحقات:'))
    expect(modal).toContain('(commissionAccounts.data ?? []).map')
    expect(modal).toContain('<ErrorNote>{commissionAccounts.error}</ErrorNote>')
    expect(modal).toContain('commissionAccounts.reload()')
    expect(modal).not.toContain('balanceMinor')
    expect(modal).not.toContain('(accounts.data ?? []).map')
  })
})
