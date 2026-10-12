import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer, customerBalances } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder, completeOrder, getOrderOrThrow, recordPayment } from '@main/services/sales/orders.service'
import { cancelDelivery, completeProduction, issueRelease, issueWorkSheet, recordDelivery, startProduction } from '@main/services/production/production.service'
import { assignWorkerToOrder, createWorker } from '@main/services/production/workers.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { buildApi } from '../../src/preload/api/build-api'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  env.cleanup()
})

function order(paid = 0) {
  const customerId = createCustomer({ name: `عميل BL12 ${Math.random()}` }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 5000,
    lines: [{ lineKind: 'custom', description: 'منتج مخصص', quantityMicro: q(1), unitPriceMinor: m(1000) }]
  }, env.ctx)
  const customerOrder = approveToOrder(invoice.id, env.ctx)
  if (paid) recordPayment({ orderId: customerOrder.id, amountMinor: m(paid) }, env.ctx)
  return customerOrder
}
function count(table: string, orderId: number) {
  return (getRawConnection().prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE order_id = ?`).get(orderId) as { c: number }).c
}
function limited(permissions: string[]) {
  return { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions } }
}

describe('BL-12 physical completion authority', () => {
  it('retires the standalone IPC/preload channel and rejects direct completion without physical evidence', async () => {
    const o = order()
    expect('complete' in IPC_CHANNELS.orders).toBe(false)
    expect('complete' in buildApi().orders).toBe(false)
    const channels = new Set<string>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string) => { channels.add(channel) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    expect(channels.has('orders:complete')).toBe(false)
    expect(() => completeOrder({ orderId: o.id }, env.ctx)).toThrow(/إذن خروج فعّال/)
    expect(getOrderOrThrow(o.id)).toMatchObject({ status: 'confirmed', completedAt: null })
    expect(count('releases', o.id)).toBe(0)
    expect(count('deliveries', o.id)).toBe(0)
  })

  it('keeps a ready and in-production Custom MO from permit or commercial completion', () => {
    const o = order()
    const sheet = issueWorkSheet({ orderId: o.id }, env.ctx)
    for (const state of ['ready', 'in_production']) {
      expect(() => issueRelease({ orderId: o.id, kind: 'delivery' }, env.ctx)).toThrow(/إكمال أمر التصنيع/)
      expect(() => completeOrder({ orderId: o.id }, env.ctx)).toThrow(/إذن خروج فعّال/)
      expect(getOrderOrThrow(o.id).status).toBe('confirmed')
      if (state === 'ready') startProduction(sheet.id, env.ctx)
    }
  })

  it.each([0, 400])('physically fulfills a %i-paid outsourced Custom order, completes it, and preserves AR', (paid) => {
    const o = order(paid)
    const now = new Date()
    const before = monthlyProfitSummary(now.getUTCFullYear(), now.getUTCMonth() + 1)
    expect(before.completedOrderCount).toBe(0)
    const permit = issueRelease({ orderId: o.id, kind: 'delivery' }, env.ctx)
    expect(getOrderOrThrow(o.id).status).toBe('confirmed')
    expect(() => completeOrder({ orderId: o.id }, env.ctx)).toThrow(/إذن خروج فعّال/)
    const recordedAt = now.toISOString()
    const physical = recordDelivery({ orderId: o.id, releaseId: permit.id, kind: 'handover', recordedAt, complete: false } as never, env.ctx)
    expect(physical.completedAt).toBe(recordedAt)
    expect(getOrderOrThrow(o.id)).toMatchObject({ status: 'completed', completedAt: recordedAt, paidMinor: m(paid), remainingMinor: m(1000 - paid) })
    expect(customerBalances().find((balance) => balance.customerId === o.customerId)?.remainingMinor).toBe(m(1000 - paid))
    expect(count('deliveries', o.id)).toBe(1)
    expect(monthlyProfitSummary(now.getUTCFullYear(), now.getUTCMonth() + 1).completedOrderCount).toBe(1)
    expect(() => recordDelivery({ orderId: o.id, releaseId: permit.id, kind: 'handover' }, env.ctx)).toThrow()
    expect(count('deliveries', o.id)).toBe(1)
    cancelDelivery({ id: physical.id }, env.ctx)
    expect(getOrderOrThrow(o.id)).toMatchObject({ status: 'confirmed', completedAt: null })
    expect(monthlyProfitSummary(now.getUTCFullYear(), now.getUTCMonth() + 1).completedOrderCount).toBe(0)
  })

  it('allows completed internal manufacturing through the same permit and physical action', () => {
    const o = order()
    const sheet = issueWorkSheet({ orderId: o.id }, env.ctx)
    startProduction(sheet.id, env.ctx)
    completeProduction(sheet.id, env.ctx)
    expect(getOrderOrThrow(o.id).status).toBe('confirmed')
    const permit = issueRelease({ orderId: o.id, kind: 'delivery' }, env.ctx)
    expect(getOrderOrThrow(o.id).status).toBe('confirmed')
    recordDelivery({ orderId: o.id, releaseId: permit.id, kind: 'handover' }, env.ctx)
    expect(getOrderOrThrow(o.id).status).toBe('completed')
  })

  it('prevents cancelled orders from permit issuance, physical fulfillment, and completion', () => {
    const o = order()
    const sheet = issueWorkSheet({ orderId: o.id }, env.ctx)
    startProduction(sheet.id, env.ctx)
    cancelOrder({ orderId: o.id, reason: 'ألغى العميل' }, env.ctx)
    expect(() => issueRelease({ orderId: o.id, kind: 'delivery' }, env.ctx)).toThrow()
    expect(() => recordDelivery({ orderId: o.id, kind: 'handover' }, env.ctx)).toThrow()
    expect(() => completeOrder({ orderId: o.id }, env.ctx)).toThrow()
    expect(getOrderOrThrow(o.id).status).toBe('cancelled')
  })

  it('requires service permissions for permit, physical event, and completion', () => {
    const o = order()
    expect(() => issueRelease({ orderId: o.id, kind: 'delivery' }, limited([]))).toThrow(/صلاحية/)
    const permit = issueRelease({ orderId: o.id, kind: 'delivery' }, env.ctx)
    expect(() => recordDelivery({ orderId: o.id, releaseId: permit.id, kind: 'handover' }, limited([]))).toThrow(/صلاحية/)
    expect(() => completeOrder({ orderId: o.id }, limited([P.releases.issue]))).toThrow(/صلاحية/)
    expect(count('deliveries', o.id)).toBe(0)
    expect(getOrderOrThrow(o.id).status).toBe('confirmed')
  })

  it('rolls back physical record, order completion, and worker earning when earning insertion fails', () => {
    const o = order()
    const workerId = createWorker({ name: 'عامل BL12' }, env.ctx)
    assignWorkerToOrder({ orderId: o.id, workerId, method: 'fixed', amountMinor: m(30) }, env.ctx)
    const permit = issueRelease({ orderId: o.id, kind: 'delivery' }, env.ctx)
    const db = getRawConnection()
    db.exec("CREATE TRIGGER bl12_fail_earning BEFORE INSERT ON worker_transactions WHEN NEW.kind = 'earning' BEGIN SELECT RAISE(ABORT, 'bl12 injected earning failure'); END")
    expect(() => recordDelivery({ orderId: o.id, releaseId: permit.id, kind: 'handover' }, env.ctx)).toThrow(/bl12 injected/)
    expect(getOrderOrThrow(o.id)).toMatchObject({ status: 'confirmed', completedAt: null })
    expect(count('deliveries', o.id)).toBe(0)
    expect(db.prepare("SELECT COUNT(*) AS c FROM worker_transactions WHERE kind = 'earning'").get()).toEqual({ c: 0 })
    db.exec('DROP TRIGGER bl12_fail_earning')
    recordDelivery({ orderId: o.id, releaseId: permit.id, kind: 'handover' }, env.ctx)
    expect(getOrderOrThrow(o.id).status).toBe('completed')
    expect(count('deliveries', o.id)).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS c FROM worker_transactions WHERE kind = 'earning'").get()).toEqual({ c: 1 })
  })
})
