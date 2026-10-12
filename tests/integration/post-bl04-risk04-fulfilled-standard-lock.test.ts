import { seedFinishedGoods } from '../helpers/finished-goods-fixture'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCustomer } from '@main/services/parties/parties.service'
import { createProduct } from '@main/services/products/products.service'
import {
  approveFinalInvoice,
  createFinalInvoice,
  createStandardFinalInvoice,
  getFinalInvoice,
  updateFinalInvoice,
  unapproveFinalInvoice
} from '@main/services/sales/final-invoices.service'
import { getOrder, recordPayment, refundPayment, updateOrder } from '@main/services/sales/orders.service'
import {
  onHandMicro,
} from '@main/services/production/finished-goods.service'
import { issueRelease, recordDelivery } from '@main/services/production/production.service'
import { createAccount } from '@main/services/finance/cash.service'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { approveToOrder } from '../helpers/sales-flow'

const FULFILLED_STANDARD_LOCK = /تم صرف المنتج القياسي.+فاتورة جديدة/

let env: TestEnv

beforeEach(() => {
  env = setupTestDatabase()
})

afterEach(() => env.cleanup())

function issuedStandardOrder(units = 1) {
  const customerId = createCustomer({ name: 'عميل مخزون جاهز' }, env.ctx)
  const productId = createProduct(
    { code: 'STD-R4', name: 'خزانة قياسية', defaultPriceMinor: moneyFromMajor(3000) },
    env.ctx
  )
  seedFinishedGoods(
    { productId, qtyMicro: q(5), totalCostMinor: moneyFromMajor(5000) },
    env.ctx
  )
  const invoice = createStandardFinalInvoice(
    {
      customerId,
      productId,
      quantityMicro: q(units),
      unitPriceMinor: moneyFromMajor(3000)
    },
    env.ctx
  )
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: order.totalMinor }, env.ctx)
  const release = issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)
  return { customerId, productId, invoiceId: invoice.id, orderId: order.id, releaseId: release.id }
}

function stageHistoricalCorrection(invoiceId: number, orderId: number) {
  const raw = getRawConnection()
  raw.prepare("UPDATE final_invoices SET status = 'draft', issued_at = NULL, issued_by = NULL WHERE id = ?").run(invoiceId)
  raw.prepare("UPDATE orders SET status = 'awaiting_approval' WHERE id = ?").run(orderId)
}

function stateSnapshot(invoiceId: number, orderId: number) {
  const raw = getRawConnection()
  const all = (table: string, where: string, id: number) =>
    raw.prepare(`SELECT * FROM ${table} WHERE ${where} = ? ORDER BY id`).all(id)
  return {
    invoice: all('final_invoices', 'id', invoiceId),
    invoiceLines: all('final_invoice_lines', 'final_invoice_id', invoiceId),
    order: all('orders', 'id', orderId),
    orderLines: all('order_lines', 'order_id', orderId),
    releases: all('releases', 'order_id', orderId),
    finishedGoods: all('finished_goods_movements', 'order_id', orderId),
    payments: all('customer_payments', 'order_id', orderId),
    refunds: all('customer_payment_refunds', 'order_id', orderId),
    revisions: all('invoice_approval_history', 'invoice_id', invoiceId)
  }
}

describe('POST-BL04 Risk 4 — fulfilled Standard Product quantity lock', () => {
  it('rejects correction after an Exit Permit with a new-invoice business error and zero residue', () => {
    const issued = issuedStandardOrder()
    expect(onHandMicro(issued.productId)).toBe(q(4))
    const before = stateSnapshot(issued.invoiceId, issued.orderId)

    expect(() =>
      unapproveFinalInvoice(
        {
          id: issued.invoiceId,
          expectedRevision: getFinalInvoice(issued.invoiceId).invoice.approvalRevision
        },
        env.ctx
      )
    ).toThrow(FULFILLED_STANDARD_LOCK)

    expect(stateSnapshot(issued.invoiceId, issued.orderId)).toEqual(before)
    expect(onHandMicro(issued.productId)).toBe(q(4))
  })

  it.each([
    ['increase', 1, (issued: ReturnType<typeof issuedStandardOrder>) => [{
      lineKind: 'standard' as const,
      productId: issued.productId,
      description: 'خزانة قياسية',
      quantityMicro: q(2),
      unitPriceMinor: moneyFromMajor(3000)
    }]],
    ['decrease', 2, (issued: ReturnType<typeof issuedStandardOrder>) => [{
      lineKind: 'standard' as const,
      productId: issued.productId,
      description: 'خزانة قياسية',
      quantityMicro: q(1),
      unitPriceMinor: moneyFromMajor(3000)
    }]],
    ['remove', 1, () => []],
    ['replace', 1, () => [{
      lineKind: 'standard' as const,
      productId: createProduct({ code: 'STD-R4-OTHER', name: 'منتج بديل' }, env.ctx),
      description: 'منتج بديل',
      quantityMicro: q(1),
      unitPriceMinor: moneyFromMajor(3000)
    }]],
    ['add', 1, (issued: ReturnType<typeof issuedStandardOrder>) => [{
      lineKind: 'standard' as const,
      productId: issued.productId,
      description: 'خزانة قياسية',
      quantityMicro: q(1),
      unitPriceMinor: moneyFromMajor(3000)
    }, {
      lineKind: 'standard' as const,
      productId: createProduct({ code: 'STD-R4-ADDED', name: 'منتج إضافي' }, env.ctx),
      description: 'منتج إضافي',
      quantityMicro: q(1),
      unitPriceMinor: moneyFromMajor(1500)
    }]]
  ])('rejects %s of fulfilled Standard Product lines before any mutation', (_case, units, proposedLines) => {
    const issued = issuedStandardOrder(units)
    stageHistoricalCorrection(issued.invoiceId, issued.orderId)
    const before = stateSnapshot(issued.invoiceId, issued.orderId)

    expect(() =>
      updateFinalInvoice(
        issued.invoiceId,
        { lines: proposedLines(issued) },
        env.ctx
      )
    ).toThrow(FULFILLED_STANDARD_LOCK)

    expect(stateSnapshot(issued.invoiceId, issued.orderId)).toEqual(before)
  })

  it('rejects reapproval of a fulfilled Standard Product before order revision artifacts are created', () => {
    const issued = issuedStandardOrder()
    stageHistoricalCorrection(issued.invoiceId, issued.orderId)
    const before = stateSnapshot(issued.invoiceId, issued.orderId)

    expect(() => approveFinalInvoice(issued.invoiceId, env.ctx)).toThrow(FULFILLED_STANDARD_LOCK)

    expect(stateSnapshot(issued.invoiceId, issued.orderId)).toEqual(before)
  })

  it('allows a completely new invoice/order/permit for additional quantity and decrements FG only at each permit', () => {
    const first = issuedStandardOrder()
    expect(onHandMicro(first.productId)).toBe(q(4))

    const secondInvoice = createStandardFinalInvoice(
      {
        customerId: first.customerId,
        productId: first.productId,
        quantityMicro: q(1),
        unitPriceMinor: moneyFromMajor(3000)
      },
      env.ctx
    )
    const secondOrder = approveToOrder(secondInvoice.id, env.ctx)

    expect(secondInvoice.id).not.toBe(first.invoiceId)
    expect(secondOrder.id).not.toBe(first.orderId)
    expect(onHandMicro(first.productId)).toBe(q(4))

    recordPayment({ orderId: secondOrder.id, amountMinor: secondOrder.totalMinor }, env.ctx)
    const secondPermit = issueRelease({ orderId: secondOrder.id, kind: 'delivery' }, env.ctx)

    expect(secondPermit.id).not.toBe(first.releaseId)
    expect(onHandMicro(first.productId)).toBe(q(3))
    expect(
      getRawConnection()
        .prepare("SELECT order_id AS orderId, COUNT(*) AS count FROM finished_goods_movements WHERE kind = 'sale_out' GROUP BY order_id ORDER BY order_id")
        .all()
    ).toEqual([
      { orderId: first.orderId, count: 1 },
      { orderId: secondOrder.id, count: 1 }
    ])
  })

  it('keeps legitimate order metadata editing and Exit Permit → Delivery behavior unchanged', () => {
    const issued = issuedStandardOrder()
    const releaseBefore = getRawConnection().prepare('SELECT * FROM releases WHERE id = ?').get(issued.releaseId)
    const fgBefore = getRawConnection().prepare('SELECT * FROM finished_goods_movements WHERE order_id = ? ORDER BY id').all(issued.orderId)

    updateOrder(issued.orderId, { address: 'طرابلس الجديدة', notes: 'ملاحظة تشغيلية فقط' }, env.ctx)
    expect(getOrder(issued.orderId).order).toMatchObject({ address: 'طرابلس الجديدة', notes: 'ملاحظة تشغيلية فقط' })
    expect(getRawConnection().prepare('SELECT * FROM releases WHERE id = ?').get(issued.releaseId)).toEqual(releaseBefore)
    expect(getRawConnection().prepare('SELECT * FROM finished_goods_movements WHERE order_id = ? ORDER BY id').all(issued.orderId)).toEqual(fgBefore)

    const delivery = recordDelivery(
      { orderId: issued.orderId, releaseId: issued.releaseId, kind: 'handover' },
      env.ctx
    )
    expect(delivery.completedAt).toBeTruthy()
    expect(getOrder(issued.orderId).order.status).toBe('completed')
    expect(getRawConnection().prepare('SELECT * FROM releases WHERE id = ?').get(issued.releaseId)).toEqual(releaseBefore)
  })

  it('preserves the existing customer payment/refund workflow', () => {
    const customerId = createCustomer({ name: 'عميل دفعة واسترداد' }, env.ctx)
    const accountId = createAccount({ name: 'صندوق Risk 4', kind: 'cash' }, env.ctx)
    const invoice = createFinalInvoice({
      customerId,
      paidAmountMinor: moneyFromMajor(3000),
      initialCashAccountId: accountId,
      lines: [{
        lineKind: 'custom',
        description: 'طلب مخصص',
        quantityMicro: q(1),
        unitPriceMinor: moneyFromMajor(5000)
      }]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)

    expect(getOrder(order.id).order).toMatchObject({ paidMinor: moneyFromMajor(3000), remainingMinor: moneyFromMajor(2000) })
    expect(refundPayment({
      orderId: order.id,
      amountMinor: moneyFromMajor(1000),
      cashAccountId: accountId,
      requestKey: 'post-bl04-risk04-refund'
    }, env.ctx)).toMatchObject({ paidMinor: moneyFromMajor(2000), remainingMinor: moneyFromMajor(3000) })
  })

  it('preserves Custom Order correction and reapproval when no fulfilled Standard Product exists', () => {
    const customerId = createCustomer({ name: 'عميل مخصص' }, env.ctx)
    const invoice = createFinalInvoice({
      customerId,
      lines: [{
        lineKind: 'custom',
        description: 'مطبخ مخصص',
        quantityMicro: q(1),
        unitPriceMinor: moneyFromMajor(5000)
      }]
    }, env.ctx)
    const original = approveToOrder(invoice.id, env.ctx)

    unapproveFinalInvoice({ id: invoice.id, expectedRevision: 1 }, env.ctx)
    updateFinalInvoice(invoice.id, { lines: [{
      lineKind: 'custom',
      description: 'مطبخ مخصص مصحح',
      quantityMicro: q(2),
      unitPriceMinor: moneyFromMajor(5000)
    }] }, env.ctx)
    const reapproved = approveFinalInvoice(invoice.id, env.ctx)

    expect(reapproved.orderId).toBe(original.id)
    expect(getOrder(original.id).lines).toEqual([
      expect.objectContaining({ lineKind: 'custom', description: 'مطبخ مخصص مصحح', quantityMicro: q(2) })
    ])
  })
})
