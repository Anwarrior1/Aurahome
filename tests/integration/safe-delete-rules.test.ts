import { fulfillOrder } from '../helpers/sales-flow'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCustomer, deleteCustomer, createSupplier, deleteSupplier } from '@main/services/parties/parties.service'
import { createWorker, deleteWorker, assignWorkerToOrder } from '@main/services/production/workers.service'
import { createMachine, deleteMachine, addMachineUsage } from '@main/services/production/machines.service'
import { createAccount, deleteAccount } from '@main/services/finance/cash.service'
import { createCategory as createExpenseCategory, deleteCategory as deleteExpenseCategory, createExpense } from '@main/services/finance/expenses.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { recordProfitWithdrawal } from '@main/services/finance/profit.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * Item 8 (global edit/delete rule): ordinary, unreferenced user-entered
 * master data can be deleted; the same record becomes protected the
 * moment real history exists against it, with a clear Arabic message
 * — never a silent failure, never an orphaned reference.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function seedMaterial() {
  const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
  return createMaterial(
    { sku: 'M1', name: 'مادة', categoryId, unit: 'لوح', currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact' } as never,
    env.ctx
  )
}

describe('Safe user-entered records can be deleted when unreferenced', () => {
  it('deletes a customer with no quotations or orders', () => {
    const id = createCustomer({ name: 'عميل بلا طلبات' }, env.ctx)
    expect(() => deleteCustomer(id, env.ctx, 'عميل بلا طلبات')).not.toThrow()
  })

  it('deletes a supplier with no purchases', () => {
    const id = createSupplier({ name: 'مورد جديد' }, env.ctx)
    expect(() => deleteSupplier(id, env.ctx)).not.toThrow()
  })

  it('deletes a worker with no assignments or transactions', () => {
    const id = createWorker({ name: 'عامل جديد' }, env.ctx)
    expect(() => deleteWorker(id, env.ctx)).not.toThrow()
  })

  it('deletes a machine with no recorded usage', () => {
    const id = createMachine({ name: 'آلة جديدة', costingUnit: 'قطعة', defaultRateMicro: unitCostFromMajor(10) }, env.ctx)
    expect(() => deleteMachine(id, env.ctx)).not.toThrow()
  })

  it('deletes a cash account with no recorded movements', () => {
    const id = createAccount({ name: 'حساب جديد', kind: 'cash' }, env.ctx)
    expect(() => deleteAccount(id, env.ctx)).not.toThrow()
  })

  it('deletes an expense category with no expenses posted against it', () => {
    const id = createExpenseCategory({ name: 'تصنيف جديد', kind: 'variable' }, env.ctx)
    expect(() => deleteExpenseCategory(id, env.ctx)).not.toThrow()
  })
})

describe('Referenced records are protected with a clear Arabic message, never orphaned', () => {
  it('refuses to delete a customer that has a quotation', () => {
    const id = createCustomer({ name: 'عميل لديه عرض سعر' }, env.ctx)
    createFinalInvoice({
      customerId: id,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(100) }]
    }, env.ctx)

    expect(() => deleteCustomer(id, env.ctx)).toThrowError(/لا يمكن حذف/)
  })

  it('refuses to delete a customer that has a confirmed order', () => {
    const id = createCustomer({ name: 'عميل لديه طلب' }, env.ctx)
    const quotation = createFinalInvoice({
      customerId: id,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(100) }]
    }, env.ctx)
    approveToOrder(quotation.id, env.ctx)

    expect(() => deleteCustomer(id, env.ctx)).toThrowError(/لا يمكن حذف/)
  })

  it('refuses to delete a supplier that has a purchase (protects FIFO history)', () => {
    const supplierId = createSupplier({ name: 'مورد لديه فاتورة' }, env.ctx)
    const materialId = seedMaterial()
    createPurchase({
      supplierId,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(100) }]
    }, env.ctx)

    expect(() => deleteSupplier(supplierId, env.ctx)).toThrowError(/لا يمكن حذف/)
  })

  it('archives (never refuses, never reverses) a worker assigned to an order — actual cost stays untouched', () => {
    // Corrected behaviour: a worker is never hard-blocked from deletion.
    // One with real history — an assignment here — is archived instead
    // (active=false), and the order's own actual-cost/profit figures,
    // which sum order_worker_assignments directly, never change.
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = createFinalInvoice({
      customerId,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)
    const order = approveToOrder(quotation.id, env.ctx)
    const workerId = createWorker({ name: 'عامل مكلّف' }, env.ctx)
    assignWorkerToOrder({ orderId: order.id, workerId, method: 'fixed', amountMinor: moneyFromMajor(100) }, env.ctx)
    const before = orderCostBreakdown(order.id)

    const result = deleteWorker(workerId, env.ctx)

    expect(result).toEqual({ deleted: false, archived: true })
    const after = orderCostBreakdown(order.id)
    expect(after.workerCostMinor).toBe(before.workerCostMinor)
    expect(after.totalActualCostMinor).toBe(before.totalActualCostMinor)
  })

  it('refuses to delete a machine with usage recorded on an order (protects actual cost)', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = createFinalInvoice({
      customerId,
      lines: [{ lineKind: 'custom', description: 'بند', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000) }]
    }, env.ctx)
    const order = approveToOrder(quotation.id, env.ctx)
    const machineId = createMachine({ name: 'آلة', costingUnit: 'قطعة', defaultRateMicro: unitCostFromMajor(10) }, env.ctx)
    addMachineUsage({ orderId: order.id, machineId, usageQtyMicro: quantityFromDisplay(2) }, env.ctx)

    expect(() => deleteMachine(machineId, env.ctx)).toThrowError(/لا يمكن حذف/)
  })

  it('refuses to delete an expense category that already has an expense posted', () => {
    const categoryId = createExpenseCategory({ name: 'كهرباء' }, env.ctx)
    createExpense({ categoryId, kind: 'variable', amountMinor: moneyFromMajor(50), description: 'فاتورة' }, env.ctx)

    expect(() => deleteExpenseCategory(categoryId, env.ctx)).toThrowError(/لا يمكن حذف/)
  })

  it('refuses to delete a cash account that has any recorded movement (BR-114 ledger integrity)', () => {
    const accountId = createAccount({ name: 'حساب مستخدم', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    // Force a real ledger row via an expense payment through the account.
    createExpense({ kind: 'variable', amountMinor: moneyFromMajor(50), description: 'مصروف', cashAccountId: accountId }, env.ctx)

    expect(() => deleteAccount(accountId, env.ctx)).toThrowError(
      /لا يمكن حذف هذا الحساب لوجود حركات مالية/
    )
  })

  /**
   * A profit withdrawal (BR-96/BR-113) is the one movement kind with no
   * reversal service of its own — it is permanent financial history by
   * design. The ledger rule above must therefore hold for it too, not
   * only for a movement that could be undone.
   */
  it('refuses to delete a cash account that carries a profit withdrawal', () => {
    const materialId = seedMaterial()
    const supplierId = createSupplier({ name: 'مورد للربح' }, env.ctx)
    createPurchase({
      supplierId,
      lines: [{ materialId, qtyMicro: quantityFromDisplay(10), unitCostMicro: unitCostFromMajor(100) }]
    }, env.ctx)
    const customerId = createCustomer({ name: 'عميل مكتمل' }, env.ctx)
    const invoice = createFinalInvoice({
      customerId,
      lines: [{ lineKind: 'custom', description: 'عمل منجز', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(2000) }]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(2000) }, env.ctx)
    fulfillOrder(order.id, env.ctx)

    const accountId = createAccount({ name: 'صندوق المسحوبات', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    recordProfitWithdrawal({ amountMinor: moneyFromMajor(100), person: 'anwar', cashAccountId: accountId }, env.ctx)

    expect(() => deleteAccount(accountId, env.ctx)).toThrowError(
      /لا يمكن حذف هذا الحساب لوجود حركات مالية/
    )
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
