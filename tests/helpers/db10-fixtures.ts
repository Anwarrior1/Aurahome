import { getRawConnection } from '@main/db/connection'
import { initializeFinishedGoodsValuationCutovers } from '@main/services/production/finished-goods.service'

/**
 * Deterministic synthetic business history for DB-10 scale evidence.
 *
 * Rows are inserted with raw SQL so 100k-order databases can be produced in
 * seconds. The shapes follow the real posting rules closely enough for the
 * read paths under test: cached order payment columns agree with the payment
 * ledger, cash movements mirror payments/expenses/withdrawals, finished-goods
 * issues consume exact carrying value, and every exit permit has a recorded
 * completion with a worker team.
 */
export interface Db10Fixture {
  orders: number
  customers: number
  bigCustomerId: number
  bigSupplierId: number
  bigWorkerId: number
  bigEmployeeId: number
  accountIds: number[]
  productIds: number[]
  materialIds: number[]
  firstMonth: { year: number; month: number }
  lastMonth: { year: number; month: number }
}

const MONTHS = 68
const START_YEAR = 2021

function monthOf(index: number): { year: number; month: number } {
  return { year: START_YEAR + Math.floor(index / 12), month: (index % 12) + 1 }
}

function iso(monthIndex: number, day: number, second: number): string {
  const { year, month } = monthOf(monthIndex)
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) + second * 1000)
  return date.toISOString()
}

function plusDays(value: string, days: number): string {
  return new Date(Date.parse(value) + days * 86_400_000).toISOString()
}

export function seedDb10Fixture(orderCount: number): Db10Fixture {
  const raw = getRawConnection()
  const customerCount = Math.max(20, Math.floor(orderCount / 5))
  const accountIds: number[] = []
  const productIds: number[] = []
  const materialIds: number[] = []

  raw.transaction(() => {
    const account = raw.prepare(
      'INSERT INTO cash_accounts (name, kind, opening_balance_minor, created_at) VALUES (?, ?, ?, ?)'
    )
    for (let i = 0; i < 5; i += 1)
      accountIds.push(Number(account.run(`حساب ${i + 1}`, i === 0 ? 'cash' : 'bank', 1_000_000 * (i + 1), iso(0, 1, i)).lastInsertRowid))

    const customer = raw.prepare('INSERT INTO customers (name, phone, created_at) VALUES (?, ?, ?)')
    for (let i = 1; i <= customerCount; i += 1)
      customer.run(`عميل ${String(i).padStart(6, '0')}`, `09${String(i).padStart(8, '0')}`, iso(0, 1, i))

    const supplier = raw.prepare('INSERT INTO suppliers (name, created_at) VALUES (?, ?)')
    for (let i = 1; i <= 30; i += 1) supplier.run(`مورد ${i}`, iso(0, 1, i))
    const worker = raw.prepare('INSERT INTO workers (name, created_at) VALUES (?, ?)')
    for (let i = 1; i <= 20; i += 1) worker.run(`عامل ${i}`, iso(0, 1, i))
    const employee = raw.prepare(
      'INSERT INTO employees (name, monthly_salary_minor, hired_at, created_at) VALUES (?, ?, ?, ?)'
    )
    for (let i = 1; i <= 12; i += 1) employee.run(`موظف ${i}`, 1_500_000 + i * 10_000, '2021-01-01', iso(0, 1, i))
    const product = raw.prepare('INSERT INTO products (code, name, default_price_minor, created_at) VALUES (?, ?, ?, ?)')
    for (let i = 1; i <= 60; i += 1)
      productIds.push(Number(product.run(`DB10-P${i}`, `منتج ${i}`, 250_000, iso(0, 1, i)).lastInsertRowid))
    const machine = raw.prepare('INSERT INTO machines (name, costing_unit, default_rate_micro, created_at) VALUES (?, ?, ?, ?)')
    for (let i = 1; i <= 8; i += 1) machine.run(`آلة ${i}`, 'hour', 5_000_000, iso(0, 1, i))
    const categoryId = Number(
      raw.prepare('INSERT INTO material_categories (name, created_at) VALUES (?, ?)').run('DB10 مواد', iso(0, 1, 0)).lastInsertRowid
    )
    const material = raw.prepare(
      'INSERT INTO materials (sku, name, category_id, unit, current_market_price_micro, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (let i = 1; i <= 200; i += 1)
      materialIds.push(Number(material.run(`DB10-M${i}`, `مادة ${i}`, categoryId, 'm', 12_000_000, iso(0, 1, i)).lastInsertRowid))
    const expenseCategory = raw.prepare('INSERT INTO expense_categories (name, kind, created_at) VALUES (?, ?, ?)')
    for (let i = 1; i <= 10; i += 1) expenseCategory.run(`تصنيف ${i}`, i <= 3 ? 'fixed' : 'variable', iso(0, 1, i))

    const insertOrder = raw.prepare(`INSERT INTO orders
      (document_number, customer_id, status, subtotal_minor, total_minor, deposit_required_minor, paid_minor,
       remaining_minor, payment_status, completed_at, cancelled_at, created_by, created_at, archived_at, archived_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    const insertQuotation = raw.prepare(`INSERT INTO quotations
      (document_number, customer_id, status, issued_at, valid_until, subtotal_minor, total_minor, deposit_required_minor,
       remaining_minor, created_by, created_at) VALUES (?, ?, 'converted', ?, ?, ?, ?, ?, ?, 1, ?)`)
    const insertInvoice = raw.prepare(`INSERT INTO final_invoices
      (document_number, customer_id, order_id, status, issued_at, subtotal_minor, total_minor, deposit_required_minor,
       created_by, created_at, approval_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`)
    const linkOrder = raw.prepare('UPDATE orders SET quotation_id = ?, final_invoice_id = ? WHERE id = ?')
    const insertPayment = raw.prepare(`INSERT INTO customer_payments
      (order_id, customer_id, amount_minor, cash_account_id, paid_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
    const insertRefund = raw.prepare(`INSERT INTO customer_payment_refunds
      (order_id, customer_id, amount_minor, cash_account_id, refunded_at, reason, request_key, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, 'DB10', ?, 1, ?)`)
    const insertCash = raw.prepare(`INSERT INTO cash_transactions
      (account_id, direction, amount_minor, kind, ref_table, ref_id, occurred_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    const insertSheet = raw.prepare(`INSERT INTO work_sheets
      (document_number, order_id, quantity_micro, status, issued_at, started_at, completed_at, created_by, created_at)
      VALUES (?, ?, 1000000, ?, ?, ?, ?, 1, ?)`)
    const insertInventoryMovement = raw.prepare(`INSERT INTO inventory_movements
      (material_id, kind, qty_micro, order_id, actual_cost_minor, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
    const insertMaterialLine = raw.prepare(`INSERT INTO order_material_lines
      (order_id, work_sheet_id, material_id, movement_id, physical_qty_micro, actual_cost_minor, commercial_qty_micro,
       commercial_value_minor, pricing_rule_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'full_unit', ?)`)
    const insertMachineUsage = raw.prepare(`INSERT INTO order_machine_usage
      (order_id, work_sheet_id, machine_id, usage_qty_micro, rate_micro, calculated_minor, final_amount_minor, created_at)
      VALUES (?, ?, ?, 2000000, 5000000, 10000, 10000, ?)`)
    const insertAssignment = raw.prepare(`INSERT INTO order_worker_assignments
      (order_id, work_sheet_id, worker_id, method, amount_minor, earned, earned_at) VALUES (?, ?, ?, 'fixed', ?, 1, ?)`)
    const insertWorkerTx = raw.prepare(`INSERT INTO worker_transactions
      (worker_id, kind, amount_minor, order_id, created_by, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
    const insertRelease = raw.prepare(`INSERT INTO releases
      (document_number, order_id, kind, authorized_at, address, authorization_type, order_total_minor_at_issue,
       paid_minor_at_issue, remaining_minor_at_issue, created_by, created_at, status)
      VALUES (?, ?, ?, ?, 'طرابلس', 'paid', ?, ?, 0, 1, ?, 'active')`)
    const insertReleaseWorker = raw.prepare('INSERT INTO release_workers (release_id, worker_id) VALUES (?, ?)')
    const insertDelivery = raw.prepare(`INSERT INTO deliveries
      (order_id, kind, recorded_at, address, actual_cost_minor, created_by, created_at, release_id, status)
      VALUES (?, ?, ?, 'طرابلس', ?, 1, ?, ?, 'recorded')`)
    const insertDeliveryWorker = raw.prepare('INSERT INTO delivery_workers (delivery_id, worker_id) VALUES (?, ?)')
    const insertExpense = raw.prepare(`INSERT INTO expenses
      (category_id, kind, amount_minor, order_id, cash_account_id, description, spent_at, source, created_by, created_at, reversed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 1, ?, ?)`)
    const insertPurchase = raw.prepare(`INSERT INTO purchases
      (document_number, supplier_id, purchase_date, total_minor, paid_minor, created_by, created_at, customer_order_id)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    const insertSupplierPayment = raw.prepare(`INSERT INTO supplier_payments
      (supplier_id, purchase_id, amount_minor, cash_account_id, paid_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
    const insertAudit = raw.prepare(
      'INSERT INTO audit_log (user_id, action, entity, entity_id, details, created_at) VALUES (1, ?, ?, ?, ?, ?)'
    )
    const insertFinishedGoods = raw.prepare(`INSERT INTO finished_goods_movements
      (product_id, kind, qty_micro, unit_cost_minor, total_cost_minor, order_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
    const insertEmployeeTx = raw.prepare(`INSERT INTO employee_transactions
      (employee_id, kind, amount_minor, period_year, period_month, cash_account_id, notes, created_by, created_at, paid_amount_minor)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)

    for (let i = 1; i <= orderCount; i += 1) {
      const monthIndex = Math.min(MONTHS - 1, Math.floor(((i - 1) * MONTHS) / orderCount))
      const createdAt = iso(monthIndex, (i % 28) + 1, i % 86_400)
      const customerId = i % 20 === 0 ? 1 : 2 + (i % (customerCount - 1))
      const bucket = i % 20
      const status = bucket < 8 ? 'confirmed' : bucket < 17 ? 'completed' : 'cancelled'
      const total = 100_000 + ((i * 7919) % 900_000)
      const deposit = Math.round(total * 0.6)
      const completedAt = status === 'completed' ? plusDays(createdAt, 20) : null
      const paid = status === 'completed' ? total : status === 'confirmed' && i % 3 !== 0 ? deposit : 0
      const refund = status === 'confirmed' && paid > 0 && i % 50 === 1 ? 10_000 : 0
      const netPaid = paid - refund
      const archivedAt = status !== 'confirmed' && i % 4 === 0 ? plusDays(createdAt, 60) : null
      const paymentStatus = netPaid <= 0 ? 'unpaid' : netPaid >= total ? 'paid' : netPaid >= deposit ? 'deposit_met' : 'partial'
      const orderId = Number(insertOrder.run(
        `ORD-${i}`, customerId, status, total, total, deposit, netPaid, total - netPaid, paymentStatus, completedAt,
        status === 'cancelled' ? plusDays(createdAt, 5) : null, createdAt, archivedAt, archivedAt ? 1 : null
      ).lastInsertRowid)
      const quotationId = Number(insertQuotation.run(`QT-${i}`, customerId, createdAt, plusDays(createdAt, 30), total, total, deposit, total, createdAt).lastInsertRowid)
      const invoiceId = Number(insertInvoice.run(`FI-${i}`, customerId, orderId, status === 'cancelled' ? 'cancelled' : 'approved', createdAt, total, total, deposit, createdAt).lastInsertRowid)
      linkOrder.run(quotationId, invoiceId, orderId)
      const accountId = accountIds[i % accountIds.length]!
      if (paid > 0) {
        const paymentId = Number(insertPayment.run(orderId, customerId, paid, accountId, createdAt.slice(0, 10), createdAt).lastInsertRowid)
        insertCash.run(accountId, 'in', paid, 'customer_payment', 'customer_payments', paymentId, createdAt.slice(0, 10), createdAt)
      }
      if (refund > 0) {
        const refundAt = plusDays(createdAt, 2)
        const refundId = Number(insertRefund.run(orderId, customerId, refund, accountId, refundAt.slice(0, 10), `db10-refund-${i}`, refundAt).lastInsertRowid)
        insertCash.run(accountId, 'out', refund, 'customer_refund', 'customer_payment_refunds', refundId, refundAt.slice(0, 10), refundAt)
      }

      if (status === 'completed' || (status === 'confirmed' && i % 2 === 0)) {
        const done = status === 'completed'
        const sheetId = Number(insertSheet.run(`WS-${i}`, orderId, done ? 'completed' : 'in_progress', createdAt, plusDays(createdAt, 1), done ? plusDays(createdAt, 15) : null, createdAt).lastInsertRowid)
        if (done) {
          for (let line = 0; line < 2; line += 1) {
            const materialId = materialIds[(i + line) % materialIds.length]!
            const cost = 20_000 + ((i + line) % 7) * 1_000
            const movementId = Number(insertInventoryMovement.run(materialId, 'consumption', 1_000_000, orderId, cost, plusDays(createdAt, 3)).lastInsertRowid)
            insertMaterialLine.run(orderId, sheetId, materialId, movementId, 1_000_000, cost, 1_000_000, cost + 5_000, plusDays(createdAt, 3))
          }
          insertMachineUsage.run(orderId, sheetId, 1 + (i % 8), plusDays(createdAt, 4))
          const workerId = i % 10 === 0 ? 1 : 1 + (i % 20)
          const earning = 15_000 + (i % 5) * 1_000
          insertAssignment.run(orderId, sheetId, workerId, earning, plusDays(createdAt, 15))
          insertWorkerTx.run(workerId, 'earning', earning, orderId, plusDays(createdAt, 15))
          // CC04: the big worker also has a withdrawal/return debt ledger to page through.
          if (workerId === 1) insertWorkerTx.run(1, i % 4 === 0 ? 'repayment' : 'withdrawal', 1_000, null, plusDays(createdAt, 16))

          const releaseAt = plusDays(createdAt, 16)
          const releaseId = Number(insertRelease.run(`EX-${i}`, orderId, i % 3 === 0 ? 'installation' : 'delivery', releaseAt, total, total, releaseAt).lastInsertRowid)
          const team = [1 + (i % 20), 1 + ((i + 7) % 20)]
          for (const member of team) insertReleaseWorker.run(releaseId, member)
          const deliveryId = Number(insertDelivery.run(orderId, i % 3 === 0 ? 'installation' : 'handover', completedAt, 5_000, completedAt, releaseId).lastInsertRowid)
          for (const member of team) insertDeliveryWorker.run(deliveryId, member)
        }
      }

      if (i % 2 === 0) {
        const amount = 3_000 + (i % 11) * 500
        const expenseAt = plusDays(createdAt, 6)
        const expenseId = Number(insertExpense.run(4 + (i % 7), 'variable', amount, status === 'completed' ? orderId : null, accountId, `مصروف طلب ${i}`, expenseAt.slice(0, 10), expenseAt, i % 40 === 0 ? expenseAt : null).lastInsertRowid)
        insertCash.run(accountId, 'out', amount, 'expense', 'expenses', expenseId, expenseAt.slice(0, 10), expenseAt)
      }
      if (i % 3 === 0) {
        const amount = 2_000 + (i % 13) * 250
        const expenseAt = plusDays(createdAt, 1)
        const expenseId = Number(insertExpense.run(1 + (i % 3), 'fixed', amount, null, accountId, `مصروف عام ${i}`, expenseAt.slice(0, 10), expenseAt, null).lastInsertRowid)
        insertCash.run(accountId, 'out', amount, 'expense', 'expenses', expenseId, expenseAt.slice(0, 10), expenseAt)
      }
      if (i % 2 === 1) {
        const supplierId = i % 5 === 1 ? 1 : 2 + (i % 29)
        const amount = 40_000 + (i % 17) * 1_000
        const purchaseId = Number(insertPurchase.run(`PUR-${i}`, supplierId, createdAt.slice(0, 10), amount, Math.floor(amount / 2), createdAt, null).lastInsertRowid)
        const paymentId = Number(insertSupplierPayment.run(supplierId, purchaseId, Math.floor(amount / 2), accountId, createdAt.slice(0, 10), createdAt).lastInsertRowid)
        insertCash.run(accountId, 'out', Math.floor(amount / 2), 'supplier_payment', 'supplier_payments', paymentId, createdAt.slice(0, 10), createdAt)
      }
      for (let entry = 0; entry < 3; entry += 1)
        insertAudit.run(entry === 0 ? 'orders.create' : entry === 1 ? 'payments.record' : 'orders.update', 'orders', String(orderId), '{}', plusDays(createdAt, entry))

      if (i % 10 === 0) {
        const productId = productIds[(i / 10) % productIds.length]!
        const unitCost = 90_000 + (i % 9) * 1_000
        insertFinishedGoods.run(productId, 'production_in', 2_000_000, unitCost, unitCost * 2, null, createdAt)
        if (status === 'completed') insertFinishedGoods.run(productId, 'sale_out', 2_000_000, unitCost, unitCost * 2, orderId, plusDays(createdAt, 1))
      }
      if (i % 50 === 0) insertEmployeeTx.run(1, 'advance', 20_000, null, null, accountId, `سلفة ${i}`, createdAt, null)
      if (i % 75 === 0) insertEmployeeTx.run(1, 'repayment', 10_000, null, null, accountId, `سداد ${i}`, createdAt, null)
    }

    const withdrawal = raw.prepare(`INSERT INTO profit_withdrawals (amount_minor, withdrawn_at, person, cash_account_id, created_by, created_at)
      VALUES (?, ?, 'المالك', ?, 1, ?)`)
    const salary = raw.prepare(`INSERT INTO employee_transactions
      (employee_id, kind, amount_minor, period_year, period_month, cash_account_id, created_by, created_at, paid_amount_minor)
      VALUES (?, 'salary_payment', ?, ?, ?, ?, 1, ?, ?)`)
    const savingsTx = raw.prepare(`INSERT INTO savings_transactions (kind, amount_minor, cash_account_id, occurred_at, created_by, created_at)
      VALUES (?, ?, ?, ?, 1, ?)`)
    for (let monthIndex = 0; monthIndex < MONTHS; monthIndex += 1) {
      const { year, month } = monthOf(monthIndex)
      const at = iso(monthIndex, 27, 3_600)
      const withdrawalId = Number(withdrawal.run(50_000 + monthIndex * 100, at.slice(0, 10), accountIds[0]!, at).lastInsertRowid)
      insertCash.run(accountIds[0]!, 'out', 50_000 + monthIndex * 100, 'profit_withdrawal', 'profit_withdrawals', withdrawalId, at.slice(0, 10), at)
      for (let employeeId = 1; employeeId <= 12; employeeId += 1) {
        const amount = 1_500_000 + employeeId * 10_000
        salary.run(employeeId, amount, year, month, accountIds[1]!, iso(monthIndex, 28, employeeId), amount)
      }
      savingsTx.run(monthIndex % 5 === 4 ? 'usage' : 'allocation', 10_000, accountIds[2]!, at.slice(0, 10), at)
    }
  })()

  initializeFinishedGoodsValuationCutovers()
  // Movements after the cutover exercise the prospective replay path.
  raw.transaction(() => {
    const insert = raw.prepare(`INSERT INTO finished_goods_movements
      (product_id, kind, qty_micro, unit_cost_minor, total_cost_minor, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
    const count = Math.max(60, Math.floor(orderCount / 20))
    for (let i = 0; i < count; i += 1) {
      const productId = productIds[i % productIds.length]!
      insert.run(productId, 'production_in', 3_000_000, 50_000, 150_000, iso(MONTHS - 1, 1 + (i % 27), i))
      if (i % 2 === 0) insert.run(productId, 'adjustment_out', 1_000_000, 50_000, 50_000, iso(MONTHS - 1, 1 + (i % 27), i + 1))
    }
  })()
  raw.pragma('optimize')

  return {
    orders: orderCount,
    customers: customerCount,
    bigCustomerId: 1,
    bigSupplierId: 1,
    bigWorkerId: 1,
    bigEmployeeId: 1,
    accountIds,
    productIds,
    materialIds,
    firstMonth: monthOf(0),
    lastMonth: monthOf(MONTHS - 1)
  }
}
