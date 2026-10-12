import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrderOrThrow, recordPayment } from '@main/services/sales/orders.service'
import {
  fulfillmentStatus,
  issueRelease,
  listDeliveries,
  listReleases,
  recordDelivery
} from '@main/services/production/production.service'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function paidOrder(options: { delivery: boolean; installation: boolean }) {
  const customerId = createCustomer({ name: 'عميل خطوات الطلب' }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    requiresDelivery: options.delivery,
    requiresInstallation: options.installation,
    lines: [{
      lineKind: 'custom', description: 'طلب خطوات', quantityMicro: quantityFromDisplay(1),
      unitPriceMinor: moneyFromMajor(1000)
    }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
  return order
}

describe('persisted one-time Customer Order actions', () => {
  it('allows only one persisted Exit Permit for an order', () => {
    const order = paidOrder({ delivery: true, installation: false })
    issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)

    expect(() => issueRelease({ orderId: order.id, kind: 'transport' }, env.ctx)).toThrowError(/بالفعل/)
    expect(listReleases({ orderId: order.id }).items).toHaveLength(1)
  })

  it('records delivery-and-installation as one permit-driven combined operation', () => {
    const order = paidOrder({ delivery: true, installation: true })
    const release = issueRelease({ orderId: order.id, kind: 'delivery_installation' }, env.ctx)

    recordDelivery({ orderId: order.id, kind: 'delivery_installation', releaseId: release.id }, env.ctx)
    expect(fulfillmentStatus(order.id)).toBe('delivered_installed')
    expect(getOrderOrThrow(order.id).completedAt).not.toBeNull()
    expect(() => recordDelivery({ orderId: order.id, kind: 'delivery_installation', releaseId: release.id }, env.ctx))
      .toThrowError(/بالفعل/)
    expect(listDeliveries({ orderId: order.id }).items).toHaveLength(1)
  })

  it('completes an installation-only order after its installation event', () => {
    const order = paidOrder({ delivery: false, installation: true })
    const release = issueRelease({ orderId: order.id, kind: 'installation' }, env.ctx)

    recordDelivery({ orderId: order.id, kind: 'installation', releaseId: release.id }, env.ctx)
    expect(fulfillmentStatus(order.id)).toBe('installed')
    expect(getOrderOrThrow(order.id).completedAt).not.toBeNull()
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
