import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrder, getOrderOrThrow, recordPayment } from '@main/services/sales/orders.service'
import { createWorker } from '@main/services/production/workers.service'
import {
  cancelDelivery,
  deliveriesForOrder,
  issueRelease,
  listDeliveries,
  listReleases,
  recordDelivery
} from '@main/services/production/production.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { closeDatabase, getRawConnection, setDatabasePath } from '@main/db/connection'
import {
  COMPLETION_ACTION_LABEL,
  completionKindForPermit,
  type CompletionKind,
  type IssuableExitPermitKind
} from '@shared/production/exit-permit'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function paidOrder() {
  const customerId = createCustomer({ name: `عميل إذن ${Math.random()}` }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    lines: [{
      lineKind: 'custom', description: 'طلب إتمام مصرح',
      quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000)
    }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
  return order
}

const MATRIX: Array<{ permit: IssuableExitPermitKind; completion: CompletionKind; wrong: CompletionKind }> = [
  { permit: 'delivery', completion: 'handover', wrong: 'delivery' },
  { permit: 'transport', completion: 'delivery', wrong: 'installation' },
  { permit: 'delivery_installation', completion: 'delivery_installation', wrong: 'installation' },
  { permit: 'installation', completion: 'installation', wrong: 'handover' }
]

describe('Exit Permit driven completion', () => {
  for (const scenario of MATRIX) {
    it(`${scenario.permit} exposes and persists only ${scenario.completion}`, () => {
      const order = paidOrder()
      const workerId = createWorker({ name: `فريق ${scenario.permit}` }, env.ctx)
      const permit = issueRelease({
        orderId: order.id,
        kind: scenario.permit,
        workerIds: [workerId]
      }, env.ctx)

      const before = getOrder(order.id).workflow.requiredCompletion
      expect(before).toMatchObject({
        releaseId: permit.id,
        permitKind: scenario.permit,
        completionKind: scenario.completion,
        workers: [{ workerId }]
      })
      expect(COMPLETION_ACTION_LABEL[before!.completionKind]).toBeTruthy()

      expect(() => recordDelivery({
        orderId: order.id,
        releaseId: permit.id,
        kind: scenario.wrong,
        actualCostMinor: moneyFromMajor(99)
      }, env.ctx)).toThrowError(/يسمح فقط/)
      expect(listDeliveries({ orderId: order.id }).items).toHaveLength(0)
      expect(orderCostBreakdown(order.id).deliveryCostMinor).toBe(0)

      recordDelivery({
        orderId: order.id,
        releaseId: permit.id,
        kind: scenario.completion,
        actualCostMinor: moneyFromMajor(25),
        notes: 'تم التنفيذ الفعلي'
      }, env.ctx)

      const rows = listDeliveries({ orderId: order.id }).items
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        releaseId: permit.id,
        kind: scenario.completion,
        actualCostMinor: moneyFromMajor(25),
        workers: [`فريق ${scenario.permit}`]
      })
      expect(getOrder(order.id).workflow.requiredCompletion).toBeNull()
      expect(orderCostBreakdown(order.id)).toMatchObject({
        deliveryCostMinor: moneyFromMajor(25),
        totalActualCostMinor: moneyFromMajor(25),
        actualProfitMinor: moneyFromMajor(975)
      })
      expect(() => recordDelivery({
        orderId: order.id,
        releaseId: permit.id,
        kind: scenario.completion
      }, env.ctx)).toThrowError(/بالفعل/)
      expect(listDeliveries({ orderId: order.id }).items).toHaveLength(1)
    })
  }

  for (const [index, scenario] of MATRIX.entries()) {
    it(`safely reverses and re-registers ${scenario.completion} from the same permit`, () => {
      const order = paidOrder()
      const permit = issueRelease({ orderId: order.id, kind: scenario.permit }, env.ctx)
      const firstCost = moneyFromMajor([100, 250, 350, 175][index]!)
      const first = recordDelivery({
        orderId: order.id,
        releaseId: permit.id,
        kind: scenario.completion,
        actualCostMinor: firstCost
      }, env.ctx)

      expect(getOrderOrThrow(order.id)).toMatchObject({ status: 'completed' })
      expect(orderCostBreakdown(order.id).deliveryCostMinor).toBe(firstCost)

      cancelDelivery({ id: first.id }, env.ctx)

      expect(listDeliveries({ orderId: order.id }).items).toEqual([])
      expect(deliveriesForOrder(order.id)).toMatchObject([{
        id: first.id,
        releaseId: permit.id,
        kind: scenario.completion,
        status: 'cancelled',
        actualCostMinor: firstCost
      }])
      expect(orderCostBreakdown(order.id)).toMatchObject({
        deliveryCostMinor: 0,
        totalActualCostMinor: 0,
        actualProfitMinor: moneyFromMajor(1000)
      })
      expect(getOrderOrThrow(order.id)).toMatchObject({ status: 'confirmed', completedAt: null })
      expect(getOrder(order.id).workflow).toMatchObject({
        releaseIssued: true,
        requiredCompletion: {
          releaseId: permit.id,
          permitKind: scenario.permit,
          completionKind: scenario.completion
        }
      })
      expect(listReleases({ orderId: order.id }).items).toMatchObject([{
        id: permit.id,
        kind: scenario.permit,
        completionRecorded: false
      }])

      expect(() => cancelDelivery({ id: first.id }, env.ctx)).toThrowError(/بالفعل/)
      expect(orderCostBreakdown(order.id).deliveryCostMinor).toBe(0)

      const secondCost = moneyFromMajor(40)
      const second = recordDelivery({
        orderId: order.id,
        releaseId: permit.id,
        kind: scenario.completion,
        actualCostMinor: secondCost
      }, env.ctx)
      expect(second.id).not.toBe(first.id)
      expect(listDeliveries({ orderId: order.id }).items).toMatchObject([{
        id: second.id,
        releaseId: permit.id,
        kind: scenario.completion,
        status: 'recorded'
      }])
      expect(deliveriesForOrder(order.id)).toHaveLength(2)
      expect(orderCostBreakdown(order.id)).toMatchObject({
        deliveryCostMinor: secondCost,
        totalActualCostMinor: secondCost,
        actualProfitMinor: moneyFromMajor(960)
      })

      const audit = getRawConnection().prepare(
        "SELECT details FROM audit_log WHERE action = 'deliveries.reverse' AND entity_id = ? ORDER BY id DESC LIMIT 1"
      ).get(String(first.id)) as { details: string }
      expect(JSON.parse(audit.details)).toMatchObject({
        completionId: first.id,
        orderId: order.id,
        releaseId: permit.id,
        operationKind: scenario.completion,
        previousActualCostMinor: firstCost,
        reversedByUserId: env.ctx.session.user.id,
        orderReopened: true
      })
    })
  }

  it('persists pending and completed action state across database reopen', () => {
    const order = paidOrder()
    const permit = issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
    const dbPath = join(env.dir, readdirSync(env.dir).find((name) => name.endsWith('.db'))!)

    closeDatabase()
    setDatabasePath(dbPath)
    expect(getOrder(order.id).workflow.requiredCompletion).toMatchObject({
      releaseId: permit.id,
      permitKind: 'transport',
      completionKind: completionKindForPermit('transport')
    })

    recordDelivery({ orderId: order.id, releaseId: permit.id, kind: 'delivery' }, env.ctx)
    closeDatabase()
    setDatabasePath(dbPath)
    expect(getOrder(order.id).workflow.requiredCompletion).toBeNull()
    expect(listReleases({ orderId: order.id }).items[0]).toMatchObject({ id: permit.id, kind: 'transport' })
    expect(listDeliveries({ orderId: order.id }).items[0]).toMatchObject({ releaseId: permit.id, kind: 'delivery' })
  })

  it('persists a reversed completion and restored action across database reopen', () => {
    const order = paidOrder()
    const permit = issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)
    const completion = recordDelivery({
      orderId: order.id,
      releaseId: permit.id,
      kind: 'delivery',
      actualCostMinor: moneyFromMajor(100)
    }, env.ctx)
    cancelDelivery({ id: completion.id }, env.ctx)
    const dbPath = join(env.dir, readdirSync(env.dir).find((name) => name.endsWith('.db'))!)

    closeDatabase()
    setDatabasePath(dbPath)

    expect(getOrder(order.id).workflow).toMatchObject({
      releaseIssued: true,
      requiredCompletion: {
        releaseId: permit.id,
        permitKind: 'transport',
        completionKind: 'delivery'
      }
    })
    expect(getOrderOrThrow(order.id)).toMatchObject({ status: 'confirmed', completedAt: null })
    expect(listDeliveries({ orderId: order.id }).items).toEqual([])
    expect(deliveriesForOrder(order.id)).toMatchObject([{ id: completion.id, status: 'cancelled' }])
    expect(orderCostBreakdown(order.id).deliveryCostMinor).toBe(0)
    expect(listReleases({ orderId: order.id }).items).toMatchObject([{
      id: permit.id,
      completionRecorded: false
    }])
  })

  it('recognizes a matching pre-link historical completion without rewriting it', () => {
    const order = paidOrder()
    const permit = issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)
    getRawConnection().prepare(`
      INSERT INTO deliveries (order_id, kind, recorded_at, actual_cost_minor, status, created_at)
      VALUES (?, 'delivery', '2026-01-01T10:00:00.000Z', 0, 'recorded', '2026-01-01T10:00:00.000Z')
    `).run(order.id)

    expect(getOrder(order.id).workflow.requiredCompletion).toBeNull()
    expect(() => recordDelivery({
      orderId: order.id, releaseId: permit.id, kind: 'handover'
    }, env.ctx)).toThrowError(/بالفعل/)
  })

  it('allows unpaid balances for every permit kind without changing the receivable', () => {
    const makePartial = () => {
      const customerId = createCustomer({ name: `عميل تصريح جزئي ${Math.random()}` }, env.ctx)
      const invoice = createFinalInvoice({
        customerId,
        lines: [{ lineKind: 'custom', description: 'طلب جزئي', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
      }, env.ctx)
      const order = approveToOrder(invoice.id, env.ctx)
      recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(500) }, env.ctx)
      return order
    }
    const combined = makePartial()
    const permit = issueRelease({
      orderId: combined.id,
      kind: 'delivery_installation',
      unpaidReleaseOverride: true
    }, env.ctx)
    expect(listReleases({ orderId: combined.id }).items[0]).toMatchObject({
      id: permit.id,
      kind: 'delivery_installation',
      authorizationType: 'unpaid',
      remainingMinorAtIssue: moneyFromMajor(500)
    })

    const transport = makePartial()
    expect(issueRelease({
      orderId: transport.id,
      kind: 'transport',
      unpaidReleaseOverride: true
    }, env.ctx).id).toBeGreaterThan(0)
  })

  it('audits the permit linkage, resolved operation and actual team', () => {
    const order = paidOrder()
    const workerId = createWorker({ name: 'فريق تدقيق الإذن' }, env.ctx)
    const permit = issueRelease({ orderId: order.id, kind: 'delivery', workerIds: [workerId] }, env.ctx)
    recordDelivery({ orderId: order.id, releaseId: permit.id, kind: 'handover' }, env.ctx)

    const row = getRawConnection().prepare(
      "SELECT details FROM audit_log WHERE action = 'deliveries.record' ORDER BY id DESC LIMIT 1"
    ).get() as { details: string }
    expect(JSON.parse(row.details)).toMatchObject({
      orderId: order.id,
      releaseId: permit.id,
      permitKind: 'delivery',
      requiredCompletionKind: 'handover',
      actualWorkerIds: [workerId]
    })
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
