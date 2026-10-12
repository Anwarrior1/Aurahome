import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createExpense, createRecurringExpense } from '@main/services/finance/expenses.service'
import { safeIntegerSchema, percentageSchema } from '@shared/schemas/common.schema'
import { requireSafeInteger } from '@main/utils/numeric'
import { scanIntegerDomainStorage } from '@main/db/integer-domain-scan'
import { createCategory, createMaterial, updateMaterial } from '@main/services/catalog/catalog.service'
import { createWorker, updateWorker } from '@main/services/production/workers.service'
import { createMachine } from '@main/services/production/machines.service'
import {
  createProduct,
  replaceBom,
  replaceProductCommission,
  replaceProductMachines
} from '@main/services/products/products.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment, refundPayment } from '@main/services/sales/orders.service'
import { createPurchase, paySupplier, updateSupplierPayment } from '@main/services/purchasing/purchasing.service'
import { adjustAccountBalance } from '@main/services/finance/cash.service'
import { paySalary } from '@main/services/hr/employees.service'
import { approveToOrder } from '../helpers/sales-flow'
import {
  savePlannedOrderExpenses,
  savePlannedWorkers
} from '@main/services/planning/planning.service'
import { attributeActualCost } from '@main/services/sales/uncollected-products.service'
import { commercialQuantityFor, consumeMaterial } from '@main/services/inventory/inventory.service'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => { env.cleanup() })

describe('DB-06 integer-domain rejection', () => {
  it('rejects malformed numbers, wrong types and absent values without coercion', () => {
    for (const value of [1.25, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
      '12', null, undefined]) {
      expect(safeIntegerSchema.safeParse(value).success).toBe(false)
      expect(() => requireSafeInteger(value as number, 'value')).toThrow()
    }
    expect(safeIntegerSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    expect(safeIntegerSchema.parse(-Number.MAX_SAFE_INTEGER)).toBe(-Number.MAX_SAFE_INTEGER)
    expect(percentageSchema.parse(12.5)).toBe(12.5)
    expect(scanIntegerDomainStorage(getRawConnection())).toEqual([])
  })

  it('rejects original fractional expense command and preserves DB-05 receipts and atomicity', () => {
    const raw = getRawConnection()
    const input = { amountMinor: 1000.5, description: 'fractional', requestKey: 'db06-rejected' }
    expect(() => createExpense(input, env.ctx)).toThrow()
    expect(raw.prepare('SELECT count(*) AS n FROM expenses').get()).toEqual({ n: 0 })
    expect(raw.prepare('SELECT count(*) AS n FROM cash_transactions').get()).toEqual({ n: 0 })
    expect(raw.prepare("SELECT count(*) AS n FROM financial_command_requests WHERE request_key = 'db06-rejected'").get()).toEqual({ n: 0 })
    for (const amountMinor of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0, -1,
      '1000', null, undefined]) {
      expect(() => createExpense({ ...input, amountMinor: amountMinor as number }, env.ctx)).toThrow()
    }
    const id = createExpense({ ...input, amountMinor: 1000 }, env.ctx)
    expect(raw.prepare('SELECT typeof(amount_minor) AS type FROM expenses WHERE id = ?').get(id))
      .toEqual({ type: 'integer' })
    expect(raw.prepare("SELECT count(*) AS n FROM financial_command_requests WHERE request_key = 'db06-rejected'").get()).toEqual({ n: 1 })
  })

  it('guards recurring amounts and direct SQLite fractional expense writes', () => {
    const raw = getRawConnection()
    expect(() => createRecurringExpense({ description: 'rent', amountMinor: 42.5,
      startDate: '2026-09-01', requestKey: 'db06-rent' }, env.ctx)).toThrow()
    expect(raw.prepare("SELECT count(*) AS n FROM financial_command_requests WHERE request_key = 'db06-rent'").get()).toEqual({ n: 0 })
    expect(() => raw.prepare("INSERT INTO expenses (kind, amount_minor, description, spent_at) VALUES ('variable', ?, 'bad', '2026-09-01')").run(1000.5))
      .toThrow(/DB-06 invalid expense amount/)
    expect(() => raw.prepare("INSERT INTO expenses (kind, amount_minor, description, spent_at) VALUES ('variable', ?, 'bad', '2026-09-01')").run('1000.5'))
      .toThrow(/DB-06 invalid expense amount/)
    const id = createRecurringExpense({ description: 'rent', amountMinor: 5000,
      startDate: '2026-09-01' }, env.ctx)
    expect(raw.prepare('SELECT typeof(amount_minor) AS type FROM recurring_expense_amounts WHERE recurring_expense_id = ?').get(id))
      .toEqual({ type: 'integer' })
    expect(() => raw.prepare('UPDATE recurring_expense_amounts SET amount_minor = ? WHERE recurring_expense_id = ?').run(5000.5, id))
      .toThrow(/DB-06 invalid recurring expense amount/)
  })

  it('guards direct material and worker service writers, not only their IPC contracts', () => {
    expect(() => createCategory({ name: 'bad', sortOrder: 1.5 }, env.ctx)).toThrow()
    const categoryId = createCategory({ name: 'valid' }, env.ctx)
    const material = { sku: 'DB06-MAT', name: 'material', categoryId, unit: 'piece',
      currentMarketPriceMicro: 1000, pricingRule: 'exact' as const }
    expect(() => createMaterial({ ...material, currentMarketPriceMicro: 1000.5 }, env.ctx)).toThrow()
    const materialId = createMaterial(material, env.ctx)
    expect(() => updateMaterial(materialId, { reorderLevelMicro: NaN }, env.ctx)).toThrow()
    expect(() => createWorker({ name: 'bad', defaultRateMicro: Infinity }, env.ctx)).toThrow()
    const workerId = createWorker({ name: 'valid', defaultRateMicro: 1000 }, env.ctx)
    expect(() => updateWorker(workerId, { defaultRateMicro: 1000.5 }, env.ctx)).toThrow()
    const raw = getRawConnection()
    expect(raw.prepare('SELECT typeof(current_market_price_micro) AS type FROM materials WHERE id = ?').get(materialId)).toEqual({ type: 'integer' })
    expect(raw.prepare('SELECT typeof(default_rate_micro) AS type FROM workers WHERE id = ?').get(workerId)).toEqual({ type: 'integer' })
  })

  it('rejects direct product and BOM writer bypasses atomically', () => {
    const raw = getRawConnection()
    expect(() => createProduct({ code: 'DB06-FRACTION', name: 'bad', defaultPriceMinor: 1.5 }, env.ctx)).toThrow()
    expect(raw.prepare("SELECT COUNT(*) AS n FROM products WHERE code = 'DB06-FRACTION'").get()).toEqual({ n: 0 })

    const categoryId = createCategory({ name: 'DB06 product category' }, env.ctx)
    const materialId = createMaterial({
      sku: 'DB06-PRODUCT-MATERIAL', name: 'material', categoryId, unit: 'piece',
      currentMarketPriceMicro: 1_000_000, pricingRule: 'exact'
    }, env.ctx)
    const machineId = createMachine({ name: 'DB06 machine', costingUnit: 'hour', defaultRateMicro: 1_000_000 }, env.ctx)
    const productId = createProduct({ code: 'DB06-PRODUCT', name: 'valid' }, env.ctx)

    expect(() => replaceBom(productId, [{ materialId, qtyMicro: 1.5, unit: 'piece' }], env.ctx)).toThrow()
    expect(() => replaceProductMachines(productId, [{ machineId, usageQtyMicro: 1.5 }], env.ctx)).toThrow()
    expect(() => replaceProductCommission(productId, [{ amountMinor: 1.5 }], env.ctx)).toThrow()
    expect(raw.prepare('SELECT COUNT(*) AS n FROM product_bom_lines WHERE product_id = ?').get(productId)).toEqual({ n: 0 })
    expect(raw.prepare('SELECT COUNT(*) AS n FROM product_machine_lines WHERE product_id = ?').get(productId)).toEqual({ n: 0 })
    expect(raw.prepare('SELECT COUNT(*) AS n FROM product_commission_lines WHERE product_id = ?').get(productId)).toEqual({ n: 0 })
  })

  it('rejects unsafe planning values through direct service calls without deleting prior rows', () => {
    const customerId = createCustomer({ name: 'DB06 planning customer' }, env.ctx)
    const invoice = createFinalInvoice({
      customerId,
      lines: [{ lineKind: 'custom', description: 'item', quantityMicro: 1_000_000, unitPriceMinor: 1_000 }]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)

    savePlannedWorkers({ orderId: order.id }, [{ workerName: 'valid', estimatedCostMinor: 1_000 }], env.ctx)
    savePlannedOrderExpenses(order.id, [{ expenseName: 'valid', amountMinor: 1_000 }], env.ctx)
    const raw = getRawConnection()
    const beforeWorkers = raw.prepare('SELECT * FROM planned_workers WHERE order_id = ? ORDER BY id').all(order.id)
    const beforeExpenses = raw.prepare('SELECT * FROM planned_order_expenses WHERE order_id = ? ORDER BY id').all(order.id)

    expect(() => savePlannedWorkers({ orderId: order.id }, [{
      workerName: 'unsafe', estimatedCostMinor: Number.MAX_SAFE_INTEGER + 1
    }], env.ctx)).toThrow()
    expect(() => savePlannedOrderExpenses(order.id, [{
      expenseName: 'unsafe', amountMinor: Number.MAX_SAFE_INTEGER + 1
    }], env.ctx)).toThrow()
    expect(raw.prepare('SELECT * FROM planned_workers WHERE order_id = ? ORDER BY id').all(order.id)).toEqual(beforeWorkers)
    expect(raw.prepare('SELECT * FROM planned_order_expenses WHERE order_id = ? ORDER BY id').all(order.id)).toEqual(beforeExpenses)
  })

  it('allocates large safe integer costs without Number precision loss', () => {
    expect(attributeActualCost(9_007_199_254_740_000, [123_456_789_012_345, 7]).amounts)
      .toEqual([9_007_199_254_739_489, 511])
  })

  it('rounds commercial quantities exactly and rejects a rounded unsafe result', () => {
    const material = { pricingRule: 'round_up', commercialUnitSizeMicro: 2, unit: 'unit' }
    expect(commercialQuantityFor(material, Number.MAX_SAFE_INTEGER - 2)).toEqual({
      qtyMicro: Number.MAX_SAFE_INTEGER - 1,
      ruleUsed: 'round_up'
    })
    expect(() => commercialQuantityFor(material, Number.MAX_SAFE_INTEGER)).toThrow(/النطاق الآمن/)
  })

  it('blocks direct-service bypasses across independent business domains without side effects', () => {
    const raw = getRawConnection()
    const customerId = createCustomer({ name: 'DB06 service customer' }, env.ctx)
    const supplierId = createSupplier({ name: 'DB06 service supplier' }, env.ctx)
    const categoryId = createCategory({ name: 'DB06 service category' }, env.ctx)
    const materialId = createMaterial({
      sku: 'DB06-SERVICE-MATERIAL', name: 'material', categoryId, unit: 'piece',
      currentMarketPriceMicro: 1_000_000, pricingRule: 'exact'
    }, env.ctx)
    const guardedTables = [
      'customer_payments', 'customer_payment_refunds', 'customer_payment_refund_allocations',
      'supplier_payments', 'purchases', 'purchase_lines', 'inventory_movements', 'fifo_layers',
      'employee_transactions', 'expenses', 'cash_transactions', 'financial_command_requests',
      'final_invoices', 'final_invoice_lines', 'audit_log'
    ]
    const counts = () => Object.fromEntries(guardedTables.map((table) => [
      table,
      (raw.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count
    ]))
    const before = counts()

    expect(() => recordPayment({ orderId: 999, amountMinor: 1.5 }, env.ctx)).toThrow()
    expect(() => paySupplier({ supplierId, amountMinor: Infinity }, env.ctx)).toThrow()
    expect(() => createPurchase({
      supplierId,
      lines: [{ materialId, qtyMicro: 1.5, unitCostMicro: 1_000_000 }]
    }, env.ctx)).toThrow()
    expect(() => adjustAccountBalance({
      accountId: 999, desiredBalanceMinor: NaN, reason: 'invalid'
    }, env.ctx)).toThrow()
    expect(() => paySalary({
      employeeId: 999, amountMinor: 1_000, deductionMinor: 0.5,
      periodYear: 2026, periodMonth: 9
    }, env.ctx)).toThrow()
    expect(() => consumeMaterial({ materialId, physicalQtyMicro: 0.5, ctx: env.ctx })).toThrow()
    expect(() => createFinalInvoice({
      customerId,
      lines: [{ lineKind: 'custom', description: 'invalid', quantityMicro: 1.5, unitPriceMinor: 1_000 }]
    }, env.ctx)).toThrow()
    expect(() => updateSupplierPayment(999, {
      amountMinor: Number.MAX_SAFE_INTEGER + 1, paidAt: '2026-09-16'
    }, env.ctx)).toThrow()
    expect(() => refundPayment({
      orderId: 999, amountMinor: 1.5, requestKey: 'db06-invalid-refund'
    }, env.ctx)).toThrow()

    expect(counts()).toEqual(before)
  })
})
