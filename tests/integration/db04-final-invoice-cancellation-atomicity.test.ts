import { describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer } from '@main/services/parties/parties.service'
import {
  approveFinalInvoice,
  cancelFinalInvoice,
  createFinalInvoice
} from '@main/services/sales/final-invoices.service'
import { cancelOrder } from '@main/services/sales/orders.service'
import {
  completeProduction,
  issueWorkSheet
} from '@main/services/production/production.service'
import { productsFromOrder } from '@main/services/sales/uncollected-products.service'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

interface CancellationFixture {
  env: TestEnv
  invoiceId: number
  orderId: number
  productIds: number[]
}

function makeTransferredProducts(env: TestEnv, count: number): number[] {
  const customerId = createCustomer({ name: `DB04 source ${count}` }, env.ctx)
  const invoice = createFinalInvoice(
    {
      customerId,
      depositPercentBp: 0,
      lines: Array.from({ length: count }, (_, index) => ({
        lineKind: 'custom' as const,
        description: `DB04 manufactured item ${index + 1}`,
        quantityMicro: quantityFromDisplay(1),
        unitPriceMinor: moneyFromMajor(1000 + index * 100)
      }))
    },
    env.ctx
  )
  const order = approveToOrder(invoice.id, env.ctx)
  const workSheet = issueWorkSheet({ orderId: order.id }, env.ctx)
  completeProduction(workSheet.id, env.ctx)
  cancelOrder({ orderId: order.id, reason: 'DB04 source cancellation' }, env.ctx)
  return productsFromOrder(order.id).map((product) => product.id)
}

function soldFixture(count = 2): CancellationFixture {
  const env = setupTestDatabase()
  const productIds = makeTransferredProducts(env, count)
  const buyerId = createCustomer({ name: `DB04 buyer ${count}` }, env.ctx)
  const invoice = createFinalInvoice(
    {
      customerId: buyerId,
      depositPercentBp: 0,
      lines: productIds.map((productId, index) => ({
        lineKind: 'custom' as const,
        description: `DB04 resale item ${index + 1}`,
        quantityMicro: quantityFromDisplay(1),
        unitPriceMinor: moneyFromMajor(900 + index * 100),
        uncollectedProductId: productId
      }))
    },
    env.ctx
  )
  const approval = approveFinalInvoice(invoice.id, env.ctx)
  // This is the established legacy-order reversal branch: a final invoice
  // may be cancelled only after the order it created is already cancelled.
  getRawConnection().prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(approval.orderId)
  return { env, invoiceId: invoice.id, orderId: approval.orderId, productIds }
}

function reservedFixture(): CancellationFixture {
  const env = setupTestDatabase()
  const productIds = makeTransferredProducts(env, 1)
  const buyerId = createCustomer({ name: 'DB04 draft buyer' }, env.ctx)
  const invoice = createFinalInvoice(
    {
      customerId: buyerId,
      lines: [{
        lineKind: 'custom',
        description: 'DB04 reserved item',
        quantityMicro: quantityFromDisplay(1),
        unitPriceMinor: moneyFromMajor(950),
        uncollectedProductId: productIds[0]
      }]
    },
    env.ctx
  )
  return { env, invoiceId: invoice.id, orderId: 0, productIds }
}

function allDatabaseRows(): Record<string, unknown[]> {
  const db = getRawConnection()
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>
  return Object.fromEntries(
    tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
  )
}

function cancellationRows(fixture: CancellationFixture) {
  const db = getRawConnection()
  const placeholders = fixture.productIds.map(() => '?').join(', ')
  return {
    invoice: db.prepare(
      'SELECT id, status, cancelled_at, cancel_reason, order_id FROM final_invoices WHERE id = ?'
    ).get(fixture.invoiceId) as Record<string, unknown>,
    order: fixture.orderId
      ? db.prepare(
          'SELECT id, status, cancelled_at, cancel_reason, total_minor, paid_minor FROM orders WHERE id = ?'
        ).get(fixture.orderId) as Record<string, unknown>
      : null,
    products: db.prepare(
      `SELECT id, status, reserved_invoice_id, sold_invoice_id, sold_order_id, sold_at, sold_price_minor
       FROM uncollected_products WHERE id IN (${placeholders}) ORDER BY id`
    ).all(...fixture.productIds) as Array<Record<string, unknown>>,
    releaseAudits: db.prepare(
      `SELECT action, entity_id FROM audit_log
       WHERE action = 'uncollectedProducts.released' AND entity_id IN (${placeholders}) ORDER BY id`
    ).all(...fixture.productIds.map(String)),
    cancelAudits: db.prepare(
      "SELECT action, entity_id FROM audit_log WHERE action = 'finalInvoices.cancel' AND entity_id = ? ORDER BY id"
    ).all(String(fixture.invoiceId))
  }
}

function expectHealthyDatabase(): void {
  const db = getRawConnection()
  expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(db.pragma('foreign_key_check')).toEqual([])
}

function expectFailureRollsBack(
  installFailure: (fixture: CancellationFixture) => () => void,
  expectedMessage = /DB04 injected/
): void {
  const fixture = soldFixture(2)
  try {
    const before = allDatabaseRows()
    const removeFailure = installFailure(fixture)
    try {
      expect(() => cancelFinalInvoice(
        { id: fixture.invoiceId, reason: 'DB04 cancellation' },
        fixture.env.ctx
      )).toThrow(expectedMessage)
    } finally {
      removeFailure()
    }
    expect(allDatabaseRows()).toEqual(before)
    const state = cancellationRows(fixture)
    expect(state.invoice).toMatchObject({ status: 'approved', cancelled_at: null, cancel_reason: null })
    expect(state.products).toHaveLength(2)
    expect(state.products.every((product) => product.status === 'sold')).toBe(true)
    expect(state.products.map((product) => product.sold_invoice_id)).toEqual([
      fixture.invoiceId,
      fixture.invoiceId
    ])
    expect(state.releaseAudits).toEqual([])
    expect(state.cancelAudits).toEqual([])
    expectHealthyDatabase()
  } finally {
    fixture.env.cleanup()
  }
}

function sqlFailure(triggerSql: string, triggerName: string): () => void {
  const db = getRawConnection()
  db.exec(triggerSql)
  return () => db.exec(`DROP TRIGGER ${triggerName}`)
}

describe('DB-04 final-invoice cancellation atomicity', () => {
  it('rolls back when failure occurs before the first cancellation write', () => {
    expectFailureRollsBack((fixture) => sqlFailure(
      `CREATE TRIGGER db04_before_invoice
       BEFORE UPDATE ON final_invoices WHEN OLD.id = ${fixture.invoiceId}
       BEGIN SELECT RAISE(ABORT, 'DB04 injected before invoice write'); END`,
      'db04_before_invoice'
    ))
  })

  it('rolls back when failure occurs after invoice mutation but before the first product mutation', () => {
    expectFailureRollsBack((fixture) => sqlFailure(
      `CREATE TRIGGER db04_after_invoice
       BEFORE UPDATE ON uncollected_products WHEN OLD.id = ${fixture.productIds[0]}
       BEGIN SELECT RAISE(ABORT, 'DB04 injected after invoice mutation'); END`,
      'db04_after_invoice'
    ))
  })

  it('rolls back when failure occurs after the first product mutation during its release audit', () => {
    expectFailureRollsBack((fixture) => sqlFailure(
      `CREATE TRIGGER db04_after_first_product
       BEFORE INSERT ON audit_log
       WHEN NEW.action = 'uncollectedProducts.released' AND NEW.entity_id = '${fixture.productIds[0]}'
       BEGIN SELECT RAISE(ABORT, 'DB04 injected after first product mutation'); END`,
      'db04_after_first_product'
    ))
  })

  it('rolls back when failure occurs between multiple product releases', () => {
    expectFailureRollsBack((fixture) => sqlFailure(
      `CREATE TRIGGER db04_between_products
       BEFORE UPDATE ON uncollected_products WHEN OLD.id = ${fixture.productIds[1]}
       BEGIN SELECT RAISE(ABORT, 'DB04 injected between product releases'); END`,
      'db04_between_products'
    ))
  })

  it('rolls back when SQLite fails during an uncollected-product mutation', () => {
    expectFailureRollsBack((fixture) => sqlFailure(
      `CREATE TRIGGER db04_during_product
       AFTER UPDATE ON uncollected_products WHEN OLD.id = ${fixture.productIds[0]}
       BEGIN SELECT RAISE(ABORT, 'DB04 injected during product mutation'); END`,
      'db04_during_product'
    ))
  })

  it('rolls back all releases when the final cancellation audit insert fails', () => {
    expectFailureRollsBack(() => sqlFailure(
      `CREATE TRIGGER db04_cancel_audit
       BEFORE INSERT ON audit_log WHEN NEW.action = 'finalInvoices.cancel'
       BEGIN SELECT RAISE(ABORT, 'DB04 injected during cancellation audit'); END`,
      'db04_cancel_audit'
    ))
  })

  it('rolls back when a deferred foreign-key failure is detected immediately before commit', () => {
    expectFailureRollsBack(() => {
      const db = getRawConnection()
      db.pragma('defer_foreign_keys = ON')
      db.exec(
        `CREATE TRIGGER db04_before_commit
         AFTER INSERT ON audit_log WHEN NEW.action = 'finalInvoices.cancel'
         BEGIN
           INSERT INTO final_invoice_terms(final_invoice_id, term_index, term_text)
           VALUES (-404, 404, 'DB04 deferred violation');
         END`
      )
      return () => {
        db.exec('DROP TRIGGER db04_before_commit')
        db.pragma('defer_foreign_keys = OFF')
      }
    }, /FOREIGN KEY constraint failed/)
  })

  it('cancels a multi-product approved invoice exactly once without touching unrelated state', () => {
    const fixture = soldFixture(2)
    try {
      const db = getRawConnection()
      const unrelatedBefore = {
        sourceOrders: db.prepare('SELECT * FROM orders WHERE id <> ? ORDER BY id').all(fixture.orderId),
        inventory: db.prepare('SELECT * FROM inventory_movements ORDER BY id').all(),
        finishedGoods: db.prepare('SELECT * FROM finished_goods_movements ORDER BY id').all(),
        payments: db.prepare('SELECT * FROM customer_payments ORDER BY id').all(),
        cash: db.prepare('SELECT * FROM cash_transactions ORDER BY id').all()
      }
      const linkedOrderBefore = cancellationRows(fixture).order

      expect(cancelFinalInvoice(
        { id: fixture.invoiceId, reason: 'DB04 successful cancellation' },
        fixture.env.ctx
      )).toBeUndefined()

      const state = cancellationRows(fixture)
      expect(state.invoice).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'DB04 successful cancellation',
        order_id: fixture.orderId
      })
      expect(state.invoice.cancelled_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(state.order).toEqual(linkedOrderBefore)
      expect(state.products).toHaveLength(2)
      for (const product of state.products) {
        expect(product).toMatchObject({
          status: 'available',
          reserved_invoice_id: null,
          sold_invoice_id: null,
          sold_order_id: null,
          sold_at: null,
          sold_price_minor: null
        })
      }
      expect(state.releaseAudits).toEqual(fixture.productIds.map((id) => ({
        action: 'uncollectedProducts.released', entity_id: String(id)
      })))
      expect(state.cancelAudits).toEqual([{
        action: 'finalInvoices.cancel', entity_id: String(fixture.invoiceId)
      }])
      expect({
        sourceOrders: db.prepare('SELECT * FROM orders WHERE id <> ? ORDER BY id').all(fixture.orderId),
        inventory: db.prepare('SELECT * FROM inventory_movements ORDER BY id').all(),
        finishedGoods: db.prepare('SELECT * FROM finished_goods_movements ORDER BY id').all(),
        payments: db.prepare('SELECT * FROM customer_payments ORDER BY id').all(),
        cash: db.prepare('SELECT * FROM cash_transactions ORDER BY id').all()
      }).toEqual(unrelatedBefore)
      expectHealthyDatabase()
    } finally {
      fixture.env.cleanup()
    }
  })

  it('cancels a single-product approved invoice', () => {
    const fixture = soldFixture(1)
    try {
      cancelFinalInvoice({ id: fixture.invoiceId, reason: 'single product' }, fixture.env.ctx)
      const state = cancellationRows(fixture)
      expect(state.products).toHaveLength(1)
      expect(state.products[0]).toMatchObject({ status: 'available', sold_invoice_id: null })
      expect(state.releaseAudits).toHaveLength(1)
      expect(state.cancelAudits).toHaveLength(1)
      expectHealthyDatabase()
    } finally {
      fixture.env.cleanup()
    }
  })

  it('atomically releases a product reserved by a draft invoice', () => {
    const fixture = reservedFixture()
    try {
      expect(cancellationRows(fixture).products[0]).toMatchObject({
        status: 'reserved', reserved_invoice_id: fixture.invoiceId
      })
      cancelFinalInvoice({ id: fixture.invoiceId, reason: 'draft cancelled' }, fixture.env.ctx)
      const state = cancellationRows(fixture)
      expect(state.invoice.status).toBe('cancelled')
      expect(state.products[0]).toMatchObject({
        status: 'available', reserved_invoice_id: null, sold_invoice_id: null
      })
      expect(state.releaseAudits).toHaveLength(1)
      expect(state.cancelAudits).toHaveLength(1)
      expectHealthyDatabase()
    } finally {
      fixture.env.cleanup()
    }
  })

  it('preserves existing validation and invalid-state rejection without any writes', () => {
    const fixture = soldFixture(1)
    try {
      const db = getRawConnection()
      db.prepare("UPDATE orders SET status = 'awaiting_approval' WHERE id = ?").run(fixture.orderId)
      const beforeLiveOrderAttempt = allDatabaseRows()
      expect(() => cancelFinalInvoice(
        { id: fixture.invoiceId, reason: 'blocked by live order' }, fixture.env.ctx
      )).toThrow(/يجب إلغاء الطلب أولاً/)
      expect(allDatabaseRows()).toEqual(beforeLiveOrderAttempt)

      db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(fixture.orderId)
      const beforeMissingReason = allDatabaseRows()
      expect(() => cancelFinalInvoice(
        { id: fixture.invoiceId, reason: '   ' }, fixture.env.ctx
      )).toThrow(/سبب الإلغاء مطلوب/)
      expect(allDatabaseRows()).toEqual(beforeMissingReason)

      cancelFinalInvoice({ id: fixture.invoiceId, reason: 'valid cancellation' }, fixture.env.ctx)
      const afterSuccess = allDatabaseRows()
      expect(() => cancelFinalInvoice(
        { id: fixture.invoiceId, reason: 'duplicate' }, fixture.env.ctx
      )).toThrow(/ملغاة بالفعل/)
      expect(allDatabaseRows()).toEqual(afterSuccess)
      expectHealthyDatabase()
    } finally {
      fixture.env.cleanup()
    }
  })

  it('rolls the invoice mutation back when a defensive resumed-product conflict is discovered', () => {
    const fixture = soldFixture(1)
    try {
      getRawConnection()
        .prepare("UPDATE uncollected_products SET status = 'resumed' WHERE id = ?")
        .run(fixture.productIds[0])
      const before = allDatabaseRows()

      expect(() => cancelFinalInvoice(
        { id: fixture.invoiceId, reason: 'must reject resumed ownership' }, fixture.env.ctx
      )).toThrow(/لا يمكن تحرير منتج مستأنف/)

      expect(allDatabaseRows()).toEqual(before)
      expect(cancellationRows(fixture).invoice).toMatchObject({
        status: 'approved', cancelled_at: null, cancel_reason: null
      })
      expectHealthyDatabase()
    } finally {
      fixture.env.cleanup()
    }
  })
})
