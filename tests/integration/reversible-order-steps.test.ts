import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCategory, createMaterial, createColor, updateColor } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier, supplierBalances } from '@main/services/parties/parties.service'
import { createPurchase, getPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice, approveFinalInvoice, getFinalInvoice, updateFinalInvoice, unapproveFinalInvoice, addFinalInvoiceTerms } from '@main/services/sales/final-invoices.service'
import { getOrder, listOrders, reverseCustomerPayment, archiveOrder, refundPayment } from '@main/services/sales/orders.service'
import { savePlannedMaterials, listPlannedMaterials, savePlannedMachines, savePlannedWorkers, savePlannedOrderExpenses } from '@main/services/planning/planning.service'
import { issueWorkSheet, completeProduction, getProductionOrder, reverseWorkSheet, issueRelease, listReleases, reverseRelease, recordDelivery, cancelDelivery } from '@main/services/production/production.service'
import { createMaterialReturn, reverseMaterialReturn } from '@main/services/production/material-returns.service'
import { createMachine, addMachineUsage, removeMachineUsage } from '@main/services/production/machines.service'
import { createWorker, assignWorkerToOrder, recordWorkerTransaction, workerBalances, removeAssignment } from '@main/services/production/workers.service'
import { availableQty, consumeMaterial } from '@main/services/inventory/inventory.service'
import { materialValuation } from '@main/services/inventory/valuation.service'
import { orderCostBreakdown, orderProfitabilityReport } from '@main/services/costing/costing.service'
import { buildWorkSheet } from '@main/services/documents/documents.service'
import { createAccount } from '@main/services/finance/cash.service'
import { listNotifications } from '@main/services/notifications/notifications.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})
function rows(table: string) { return getRawConnection().prepare(`SELECT * FROM ${table} ${table === 'sqlite_sequence' ? "WHERE name != 'audit_log'" : ''} ORDER BY rowid`).all() }
function financial() { return ['customer_payments', 'cash_transactions', 'purchases', 'purchase_lines', 'supplier_payments'].map(rows) }
function database(exclude: string[] = []) { return (getRawConnection().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).filter(({ name }) => !exclude.includes(name)).map(({ name }) => [name, rows(name)]) }
function limited(permissions: string[]) { return { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions } } }
function seed(opts: { paid?: number; produce?: boolean; start?: boolean; fulfill?: boolean; costs?: boolean } = {}) {
  const customerId = createCustomer({ name: 'عميل دورة قابلة للتراجع' }, env.ctx)
  const accountId = createAccount({ name: 'صندوق دورة التراجع', kind: 'cash' }, env.ctx)
  const invoice = createFinalInvoice({ customerId, depositPercentBp: 0, requiresInstallation: true, paidAmountMinor: m(opts.paid ?? 10000), initialCashAccountId: accountId,
    lines: [{ lineKind: 'custom', description: 'مطبخ أصلي', quantityMicro: q(1), unitPriceMinor: m(10000), dimensions: 'قديم', specifications: 'أصلية' }] }, env.ctx)
  const approved = approveFinalInvoice(invoice.id, env.ctx)
  const order = getOrder(approved.orderId).order
  const categoryId = createCategory({ name: 'مواد دورة التراجع' }, env.ctx)
  const materialColorId = createColor({ code: 'STEP-BASE', name: 'تشطيب أساسي' }, env.ctx)
  const materialId = createMaterial({ sku: 'STEP-MDF', name: 'لوح', categoryId, colorId: materialColorId, unit: 'لوح', pricingRule: 'exact', currentMarketPriceMicro: c(999) }, env.ctx)
  const supplierId = createSupplier({ name: 'مورد دورة التراجع' }, env.ctx)
  const purchase = createPurchase({ supplierId, customerOrderId: order.id, paidNowMinor: m(200), cashAccountId: accountId, lines: [{ materialId, qtyMicro: q(3), unitCostMicro: c(100) }] }, env.ctx)
  createPurchase({ supplierId, customerOrderId: order.id, lines: [{ materialId, qtyMicro: q(7), unitCostMicro: c(150) }] }, env.ctx)
  const machineId = createMachine({ name: 'آلة دورة التراجع', costingUnit: 'ساعة', defaultRateMicro: c(20) }, env.ctx)
  const workerId = createWorker({ name: 'عامل دورة التراجع' }, env.ctx)
  savePlannedMaterials({ orderId: order.id }, [{ materialId, materialName: 'لوح', qtyMicro: q(5), estimatedUnitCostMicro: c(999) }], env.ctx)
  savePlannedMachines({ orderId: order.id }, [{ machineId, machineName: 'آلة', usageQtyMicro: q(2), usageUnit: 'ساعة' }], env.ctx)
  savePlannedWorkers({ orderId: order.id }, [{ workerId, workerName: 'عامل', estimatedCostMinor: m(80) }], env.ctx)
  savePlannedOrderExpenses(order.id, [{ expenseName: 'تجهيز', amountMinor: m(33) }], env.ctx)
  const planBefore = ['planned_materials', 'planned_machines', 'planned_workers', 'planned_order_expenses'].map((table) => getRawConnection().prepare(`SELECT * FROM ${table} WHERE order_id=? ORDER BY id`).all(order.id))
  const layersBefore = rows('fifo_layers')
  const valuationBefore = materialValuation({ search: 'STEP-MDF' })
  if (opts.produce === false) return { invoice, order, materialId, supplierId, purchase, machineId, workerId, planBefore, layersBefore, valuationBefore, sheet: undefined, permit: undefined, delivery: undefined }
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
  if (opts.costs) {
    addMachineUsage({ workSheetId: sheet.id, machineId, usageQtyMicro: q(2) }, env.ctx)
    assignWorkerToOrder({ workSheetId: sheet.id, workerId, method: 'fixed', amountMinor: m(80) }, env.ctx)
  }
  if (opts.start === false) return { invoice, order, materialId, supplierId, purchase, machineId, workerId, planBefore, layersBefore, valuationBefore, sheet, permit: undefined, delivery: undefined }
  completeProduction(sheet.id, env.ctx)
  if (opts.fulfill === false) return { invoice, order, materialId, supplierId, purchase, machineId, workerId, planBefore, layersBefore, valuationBefore, sheet, permit: undefined, delivery: undefined }
  const permit = issueRelease({ orderId: order.id, kind: 'installation', unpaidReleaseOverride: opts.paid !== undefined && opts.paid < 10000 }, env.ctx)
  const delivery = opts.paid !== undefined && opts.paid < 10000 ? undefined : recordDelivery({ orderId: order.id, releaseId: permit.id, kind: 'installation', actualCostMinor: m(150) }, env.ctx)
  return { invoice, order, materialId, supplierId, purchase, machineId, workerId, planBefore, layersBefore, valuationBefore, sheet, permit, delivery }
}
function sheetRequest(id: number) { const d = getProductionOrder(id); return { id, expectedToken: d.reversalToken, confirmation: d.sheet.documentNumber, reason: 'تصحيح قرار التصنيع' } }
function permitRequest(id: number, orderId: number) { const row = listReleases({ orderId, includeReversed: true }).items.find((r) => r.id === id)!; return { id, expectedToken: row.reversalToken } }
function refundAll(orderId: number) {
  // The fixture's supplier payment spent from the receipt account, so refunds come from a funded account.
  const cashAccountId = createAccount({ name: 'صندوق الاسترداد ' + orderId, kind: 'cash', openingBalanceMinor: m(100000) }, env.ctx)
  const payments = getRawConnection().prepare('SELECT amount_minor AS amount FROM customer_payments WHERE order_id = ?').all(orderId) as Array<{ amount: number }>
  for (const p of payments) refundPayment({ orderId, amountMinor: p.amount, cashAccountId, requestKey: crypto.randomUUID() }, env.ctx)
}
function unapprove(id: number) { unapproveFinalInvoice({ id, expectedRevision: getFinalInvoice(id).invoice.approvalRevision }, env.ctx) }
function undo(f: ReturnType<typeof seed>) {
  if (f.delivery) cancelDelivery({ id: f.delivery.id }, env.ctx)
  if (f.permit) reverseRelease(permitRequest(f.permit.id, f.order.id), env.ctx)
  if (f.sheet) reverseWorkSheet(sheetRequest(f.sheet.id), env.ctx)
}

describe('domain-owned step-by-step Customer Order correction', () => {
  it('keeps existing delivery reversal, its action, permit, payments and exact-once actual costing', () => {
    const f = seed({ costs: true })
    const paid = financial()
    const permitBefore = rows('releases')
    cancelDelivery({ id: f.delivery!.id }, env.ctx)
    expect(getOrder(f.order.id).workflow.requiredCompletion).toMatchObject({ releaseId: f.permit!.id, completionKind: 'installation' })
    expect(orderCostBreakdown(f.order.id).deliveryCostMinor).toBe(0)
    expect(rows('releases')).toEqual(permitBefore)
    expect(financial()).toEqual(paid)
    expect(() => cancelDelivery({ id: f.delivery!.id }, env.ctx)).toThrow(/بالفعل/)
    expect(orderCostBreakdown(f.order.id).deliveryCostMinor).toBe(0)
  })
  it('enforces the exact dependency order without auto-cascading any later domain', () => {
    const f = seed()
    const before = database()
    expect(() => reverseRelease(permitRequest(f.permit!.id, f.order.id), env.ctx)).toThrow(/التسليم والتركيب/)
    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)).toThrow(/بعد بدء التصنيع/)
    expect(() => unapprove(f.invoice.id)).toThrow(/بعد بدء التصنيع/)
    expect(database()).toEqual(before)
    cancelDelivery({ id: f.delivery!.id }, env.ctx)
    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)).toThrow(/بعد بدء التصنيع/)
    expect(() => unapprove(f.invoice.id)).toThrow(/بعد بدء التصنيع/)
    reverseRelease(permitRequest(f.permit!.id, f.order.id), env.ctx)
    expect(() => unapprove(f.invoice.id)).toThrow(/بعد بدء التصنيع/)
    expect(getProductionOrder(f.sheet!.id).sheet.status).toBe('completed')
  })
  it('undoes the permit alone, keeps completed manufacturing and makes fresh permit issuance possible', () => {
    const f = seed()
    cancelDelivery({ id: f.delivery!.id }, env.ctx)
    const manufacturing = rows('work_sheets')
    const finances = financial()
    const old = permitRequest(f.permit!.id, f.order.id)
    reverseRelease(old, env.ctx)
    expect(listReleases({ orderId: f.order.id }).items).toHaveLength(0)
    expect(getOrder(f.order.id).workflow.releaseIssued).toBe(false)
    expect(rows('work_sheets')).toEqual(manufacturing)
    expect(financial()).toEqual(finances)
    expect(() => reverseRelease(old, env.ctx)).toThrow(/بالفعل/)
    expect(issueRelease({ orderId: f.order.id, kind: 'transport' }, env.ctx).id).not.toBe(f.permit!.id)
  })
  it('undoes Manufacturing Order issuance, restores original FIFO allocations/valuation exactly once, and preserves all preparation', () => {
    const f = seed({ costs: true, start: false })
    const financeBefore = financial()
    undo(f)
    expect(getOrder(f.order.id).workflow).toMatchObject({ manufacturingIssued: false, releaseIssued: false })
    expect(getProductionOrder(f.sheet!.id).sheet.status).toBe('reversed')
    expect(availableQty(f.materialId)).toBe(q(10))
    expect(rows('fifo_layers')).toEqual(f.layersBefore)
    expect(materialValuation({ search: 'STEP-MDF' })).toEqual(f.valuationBefore)
    expect(orderCostBreakdown(f.order.id)).toMatchObject({ materialCostMinor: 0, machineCostMinor: 0, workerCostMinor: 0, deliveryCostMinor: 0 })
    expect(financial()).toEqual(financeBefore)
    const planAfter = ['planned_materials', 'planned_machines', 'planned_workers', 'planned_order_expenses'].map((table) => getRawConnection().prepare(`SELECT * FROM ${table} WHERE order_id=? ORDER BY id`).all(f.order.id))
    expect(planAfter).toEqual(f.planBefore)
    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)).toThrow(/بالفعل/)
    expect(availableQty(f.materialId)).toBe(q(10))
    savePlannedMaterials({ orderId: f.order.id }, [{ materialId: f.materialId, materialName: 'لوح مصحح', qtyMicro: q(4), estimatedUnitCostMicro: c(150) }], env.ctx)
    const next = issueWorkSheet({ orderId: f.order.id }, env.ctx)
    expect(next.id).not.toBe(f.sheet!.id)
    expect(availableQty(f.materialId)).toBe(q(6))
    expect(orderCostBreakdown(f.order.id).materialCostMinor).toBe(m(450))
  })
  it('restores only this Manufacturing Order despite independent later consumption of the same layers', () => {
    const f = seed({ start: false })
    consumeMaterial({ materialId: f.materialId, physicalQtyMicro: q(2), ctx: env.ctx })
    reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)
    expect(availableQty(f.materialId)).toBe(q(8))
    expect(orderCostBreakdown(f.order.id).materialCostMinor).toBe(0)
  })
  it('blocks a dependent raw-material return instead of inventing automatic return reversal', () => {
    const f = seed({ start: false })
    const returned = createMaterialReturn({ orderId: f.order.id, materialId: f.materialId, quantityMicro: q(1), requestKey: 'step-return' }, env.ctx)
    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)).toThrow(/مرتجع/)
    reverseMaterialReturn({ id: returned.id, expectedVersion: returned.version, requestKey: 'undo-step-return' }, env.ctx)
    reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)
    expect(availableQty(f.materialId)).toBe(q(10))
  })
  it('unapproves after a full refund, uses the normal editor, then reapproves the SAME invoice/order with 12,000 total / 0 net paid', () => {
    const f = seed({ paid: 3000, produce: false })
    expect(() => unapprove(f.invoice.id)).toThrow(/استرداد كامل/)
    refundAll(f.order.id)
    const paid = financial()
    unapprove(f.invoice.id)
    expect(getFinalInvoice(f.invoice.id).invoice).toMatchObject({ status: 'draft', orderId: f.order.id })
    expect(getOrder(f.order.id).order.status).toBe('awaiting_approval')
    expect(() => issueWorkSheet({ orderId: f.order.id }, env.ctx)).toThrow(/اعتماد/)
    updateFinalInvoice(f.invoice.id, { lines: [{ lineKind: 'custom', description: 'مطبخ مصحح', quantityMicro: q(2), unitPriceMinor: m(5500), dimensions: 'جديد', specifications: 'مصححة', materialIds: [f.materialId] }], installationPriceMinor: m(600), deliveryPriceMinor: m(400), notes: 'تصحيح العقد', printVisibility: { specifications: false } }, env.ctx)
    const approved = approveFinalInvoice(f.invoice.id, env.ctx)
    expect(approved).toMatchObject({ orderId: f.order.id, orderNumber: f.order.documentNumber, alreadyApproved: false })
    expect(getOrder(f.order.id).order).toMatchObject({ status: 'confirmed', totalMinor: m(12000), paidMinor: 0, remainingMinor: m(12000), installationPriceMinor: m(600), deliveryPriceMinor: m(400) })
    expect(getOrder(f.order.id).lines).toMatchObject([{ description: 'مطبخ مصحح', quantityMicro: q(2), dimensions: 'جديد', specifications: 'مصححة', selectedMaterials: [{ materialId: f.materialId }] }])
    expect(financial()).toEqual(paid)
    expect(rows('orders')).toHaveLength(1)
    expect(rows('final_invoices')).toHaveLength(1)
    for (let retry = 0; retry < 3; retry++) expect(approveFinalInvoice(f.invoice.id, env.ctx)).toMatchObject({ orderId: f.order.id, alreadyApproved: true })
    expect(financial()).toEqual(paid)
    expect(listPlannedMaterials({ orderId: f.order.id })).toHaveLength(1)
    issueWorkSheet({ orderId: f.order.id }, env.ctx)
  })
  it('preserves both the old commercial revision and the historical reversed manufacturing document after invoice correction', () => {
    const f = seed({ paid: 0, costs: true, start: false })
    const worksheetBefore = buildWorkSheet(f.sheet!.id, env.ctx)
    const oldLines = getOrder(f.order.id).lines
    undo(f); unapprove(f.invoice.id)
    updateFinalInvoice(f.invoice.id, { lines: [{ lineKind: 'custom', description: 'عقد جديد', quantityMicro: q(3), unitPriceMinor: m(5000) }] }, env.ctx)
    approveFinalInvoice(f.invoice.id, env.ctx)
    expect(buildWorkSheet(f.sheet!.id, env.ctx)).toEqual({ ...worksheetBefore, status: 'reversed' })
    expect(getProductionOrder(f.sheet!.id).historicalLines).toMatchObject([{ description: 'مطبخ أصلي' }])
    const history = rows('invoice_approval_history') as Array<{ snapshot: string }>
    expect(JSON.parse(history[0].snapshot).orderLines).toEqual(oldLines)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM order_lines WHERE superseded_at IS NOT NULL').get()).toEqual({ c: 1 })
  })
  it('retains every linked Purchase Invoice, receipt, supplier payment and supplier balance throughout correction', () => {
    const f = seed({ paid: 0, start: false })
    const supplier = supplierBalances()
    const purchasesBefore = ['purchases', 'purchase_lines', 'supplier_payments'].map(rows)
    const receiptsBefore = getRawConnection().prepare("SELECT * FROM inventory_movements WHERE kind='purchase' ORDER BY id").all()
    undo(f); unapprove(f.invoice.id)
    updateFinalInvoice(f.invoice.id, { lines: [{ lineKind: 'custom', description: 'مصحح', quantityMicro: q(1), unitPriceMinor: m(12000) }] }, env.ctx)
    approveFinalInvoice(f.invoice.id, env.ctx)
    expect(['purchases', 'purchase_lines', 'supplier_payments'].map(rows)).toEqual(purchasesBefore)
    expect(supplierBalances()).toEqual(supplier)
    expect(getPurchase(f.purchase.id).purchase.customerOrderId).toBe(f.order.id)
    expect(getRawConnection().prepare("SELECT * FROM inventory_movements WHERE kind='purchase' ORDER BY id").all()).toEqual(receiptsBefore)
  })
  it('never reposts a separately reversed initial payment or a previously zero initial instruction', () => {
    const f = seed({ paid: 3000, produce: false })
    const payment = getOrder(f.order.id).payments[0]
    reverseCustomerPayment(payment.id, env.ctx)
    unapprove(f.invoice.id)
    approveFinalInvoice(f.invoice.id, env.ctx)
    expect(getOrder(f.order.id).payments).toHaveLength(0)
    expect(getOrder(f.order.id).order.paidMinor).toBe(0)
    expect(rows('cash_transactions')).toHaveLength(1) // Independent supplier payment only.
    const zero = createFinalInvoice({ customerId: f.order.customerId, paidAmountMinor: 0, depositPercentBp: 0,
      lines: [{ lineKind: 'custom', description: 'اعتماد أصلي بلا دفعة', quantityMicro: q(1), unitPriceMinor: m(1000) }] }, env.ctx)
    const original = approveFinalInvoice(zero.id, env.ctx)
    const before = financial()
    unapprove(zero.id)
    approveFinalInvoice(zero.id, env.ctx)
    expect(getOrder(original.orderId).payments).toHaveLength(0)
    expect(financial()).toEqual(before)
  })
  it('rejects edits to an already-posted initial instruction and never re-posts it after a full refund', () => {
    const f = seed({ paid: 3000, produce: false })
    refundAll(f.order.id)
    const financeBefore = financial()
    unapprove(f.invoice.id)
    expect(() => updateFinalInvoice(f.invoice.id, { paidAmountMinor: m(1000) }, env.ctx)).toThrow(/الدفعة الأولية/)
    updateFinalInvoice(f.invoice.id, { lines: [{ lineKind: 'custom', description: 'أقل', quantityMicro: q(1), unitPriceMinor: m(2000) }] }, env.ctx)
    expect(getFinalInvoice(f.invoice.id).payment.remainingMinor).toBe(m(2000))
    expect(getOrder(f.order.id).order.totalMinor).toBe(m(10000))
    expect(() => approveFinalInvoice(f.invoice.id, env.ctx, 0)).toThrow(/إصدار/)
    approveFinalInvoice(f.invoice.id, env.ctx)
    expect(getOrder(f.order.id).order).toMatchObject({ totalMinor: m(2000), paidMinor: 0, remainingMinor: m(2000) })
    expect(getFinalInvoice(f.invoice.id).payment.remainingMinor).toBe(m(2000))
    expect(financial()).toEqual(financeBefore)
  })
  it('supports repeated unapproval/edit/reapproval cycles with durable order/payment identity', () => {
    const f = seed({ paid: 3000, produce: false })
    refundAll(f.order.id)
    const before = financial()
    for (const total of [12000, 14000, 13000]) {
      unapprove(f.invoice.id)
      updateFinalInvoice(f.invoice.id, { lines: [{ lineKind: 'custom', description: 'تعديل', quantityMicro: q(1), unitPriceMinor: m(total) }] }, env.ctx)
      expect(approveFinalInvoice(f.invoice.id, env.ctx).orderId).toBe(f.order.id)
    }
    expect(rows('orders')).toHaveLength(1)
    expect(rows('invoice_approval_history')).toHaveLength(3)
    expect(financial()).toEqual(before)
  })
  it('rejects stale Manufacturing Order/permit/invoice reversal requests and duplicate unapproval', () => {
    const f = seed({ fulfill: false })
    const stale = sheetRequest(f.sheet!.id)
    const permit = issueRelease({ orderId: f.order.id, kind: 'transport' }, env.ctx)
    const oldPermit = permitRequest(permit.id, f.order.id)
    const delivery = recordDelivery({ orderId: f.order.id, releaseId: permit.id, kind: 'delivery' }, env.ctx)
    expect(() => reverseRelease(oldPermit, env.ctx)).toThrow(/التسليم/)
    cancelDelivery({ id: delivery.id }, env.ctx)
    expect(() => reverseRelease(oldPermit, env.ctx)).toThrow(/تغير/)
    reverseRelease(permitRequest(permit.id, f.order.id), env.ctx)
    expect(() => reverseWorkSheet(stale, env.ctx)).toThrow(/بعد بدء التصنيع/)
  })
  it('rejects a stale pre-start Manufacturing Order reversal and duplicate unapproval', () => {
    const f = seed({ paid: 0, start: false })
    const stale = sheetRequest(f.sheet!.id)
    addMachineUsage({ workSheetId: f.sheet!.id, machineId: f.machineId, usageQtyMicro: q(1) }, env.ctx)
    const before = database()
    expect(() => reverseWorkSheet(stale, env.ctx)).toThrow(/تغير/)
    expect(database()).toEqual(before)
    reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)
    const originalRevision = getFinalInvoice(f.invoice.id).invoice.approvalRevision
    unapprove(f.invoice.id)
    expect(() => unapprove(f.invoice.id)).toThrow(/بالفعل/)
    approveFinalInvoice(f.invoice.id, env.ctx)
    expect(() => unapproveFinalInvoice({ id: f.invoice.id, expectedRevision: originalRevision }, env.ctx)).toThrow(/تغير/)
  })
  it.each(['inventory', 'audit'])('rolls back ALL Manufacturing Order reversal effects on a forced %s failure', (failure) => {
    const f = seed({ start: false, costs: true })
    getRawConnection().exec(failure === 'inventory' ? "CREATE TRIGGER force_failure BEFORE INSERT ON inventory_movements WHEN NEW.kind='consumption_reversal' BEGIN SELECT RAISE(ABORT,'forced failure'); END" : "CREATE TRIGGER force_failure BEFORE INSERT ON audit_log WHEN NEW.action='worksheets.reverse' BEGIN SELECT RAISE(ABORT,'forced failure'); END")
    const before = database()
    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)).toThrow(/forced failure/)
    expect(database()).toEqual(before)
  })
  it('rolls back invoice lifecycle, order state and historical revision when unapproval audit fails', () => {
    const f = seed({ paid: 0, produce: false })
    getRawConnection().exec("CREATE TRIGGER fail_unapproval BEFORE INSERT ON audit_log WHEN NEW.action='finalInvoices.unapprove' BEGIN SELECT RAISE(ABORT,'forced failure'); END")
    const before = database()
    expect(() => unapprove(f.invoice.id)).toThrow(/forced failure/)
    expect(database()).toEqual(before)
  })
  it('rolls back commercial resynchronization and order line revision if reapproval fails', () => {
    const f = seed({ paid: 0, produce: false })
    unapprove(f.invoice.id)
    updateFinalInvoice(f.invoice.id, { notes: 'مصحح' }, env.ctx)
    getRawConnection().exec("CREATE TRIGGER fail_reapproval BEFORE UPDATE OF status ON final_invoices WHEN NEW.status='approved' BEGIN SELECT RAISE(ABORT,'forced failure'); END")
    const before = database()
    expect(() => approveFinalInvoice(f.invoice.id, env.ctx)).toThrow(/forced failure/)
    expect(database()).toEqual(before)
  })
  it('rejects all focused sensitive service actions without their authority', () => {
    const f = seed({ fulfill: false })
    const ctx = limited([P.orders.view, P.orders.manage, P.worksheets.issue, P.releases.issue])
    const permit = issueRelease({ orderId: f.order.id, kind: 'transport' }, env.ctx)
    expect(() => reverseRelease(permitRequest(permit.id, f.order.id), ctx)).toThrow(/صلاحية/)
    reverseRelease(permitRequest(permit.id, f.order.id), env.ctx)
    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), ctx)).toThrow(/صلاحية/)
    expect(() => unapproveFinalInvoice({ id: f.invoice.id, expectedRevision: 1 }, ctx)).toThrow(/صلاحية/)
    expect(() => archiveOrder({ id: f.order.id, archive: true }, ctx)).toThrow(/صلاحية/)
  })
  it('archives/restores only visibility and audit with the SAME order ID/number and zero financial, inventory, costing or report effect', () => {
    const f = seed({ costs: true })
    const before = database(['orders', 'audit_log'])
    const orderBefore = getOrder(f.order.id).order
    const costing = orderCostBreakdown(f.order.id)
    const reports = orderProfitabilityReport({ completedOnly: true })
    archiveOrder({ id: f.order.id, archive: true }, env.ctx)
    expect(listOrders({}).items).toHaveLength(0)
    expect(listOrders({ archived: true }).items).toMatchObject([{ id: f.order.id, documentNumber: f.order.documentNumber }])
    expect(database(['orders', 'audit_log'])).toEqual(before)
    expect(orderCostBreakdown(f.order.id)).toEqual(costing)
    expect(orderProfitabilityReport({ completedOnly: true })).toEqual(reports)
    expect(() => cancelDelivery({ id: f.delivery!.id }, env.ctx)).toThrow(/المؤرشف/)
    archiveOrder({ id: f.order.id, archive: false }, env.ctx)
    expect(getOrder(f.order.id).order).toEqual(orderBefore)
    expect(listOrders({}).items).toMatchObject([{ id: f.order.id, documentNumber: f.order.documentNumber }])
    expect(database(['orders', 'audit_log'])).toEqual(before)
  })
  it('blocks Manufacturing Order reversal while its source order is archived and recalculates normal blockers after restore', () => {
    const f = seed({ costs: true })
    archiveOrder({ id: f.order.id, archive: true }, env.ctx)
    const afterArchive = database()
    const stock = availableQty(f.materialId)
    const cost = orderCostBreakdown(f.order.id)

    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)).toThrow(/لا يمكن التراجع عن أمر تصنيع تابع لطلب مؤرشف/)
    expect(database()).toEqual(afterArchive)
    expect(availableQty(f.materialId)).toBe(stock)
    expect(orderCostBreakdown(f.order.id)).toEqual(cost)
    expect(getProductionOrder(f.sheet!.id).sheet.status).toBe('completed')

    archiveOrder({ id: f.order.id, archive: false }, env.ctx)
    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)).toThrow(/بعد بدء التصنيع/)
    expect(getProductionOrder(f.sheet!.id).sheet.status).toBe('completed')
  })
  it('keeps archive eligibility separate from reversal and has strict bounded active/archived search/filter/pagination', () => {
    const f = seed()
    archiveOrder({ id: f.order.id, archive: true }, env.ctx)
    const other = createFinalInvoice({ customerId: f.order.customerId, lines: [{ lineKind: 'custom', description: 'طلب نشط', quantityMicro: q(1), unitPriceMinor: m(1000) }] }, env.ctx)
    const active = approveFinalInvoice(other.id, env.ctx)
    expect(() => archiveOrder({ id: active.orderId, archive: true }, env.ctx)).toThrow(/مكتمل/)
    const firstActive = listOrders({}, { limit: 1 })
    expect(firstActive.items.map((r) => r.id)).toEqual([active.orderId])
    expect(firstActive.hasMore).toBe(false)
    expect(listOrders({ search: f.order.documentNumber }).items).toHaveLength(0)
    const archivedPage = listOrders({ archived: true, search: f.order.documentNumber, status: 'completed', paymentStatus: 'paid' }, { limit: 1 })
    expect(archivedPage.items).toHaveLength(1)
    expect(archivedPage.hasMore).toBe(false)
    expect(listOrders({ includeArchived: true, search: f.order.documentNumber }).items).toMatchObject([{ id: f.order.id }])
    const insert = getRawConnection().prepare("INSERT INTO orders(document_number,customer_id,status,created_at) VALUES (?,?,'confirmed','2025-01-01')")
    for (let index = 0; index < 102; index++) insert.run('LIST-LEGACY-' + String(index).padStart(4, '0'), f.order.customerId)
    expect(() => listOrders({}, { limit: 999 })).toThrow()
    const firstHundred = listOrders({}, { limit: 100 })
    expect(firstHundred.items).toHaveLength(100)
    expect(listOrders({}, { limit: 100, cursor: firstHundred.nextCursor! }).items).toHaveLength(3)
    expect(listOrders({ search: 'LIST-LEGACY-0000', limit: 1 }).items).toMatchObject([{ documentNumber: 'LIST-LEGACY-0000' }])
    expect(listNotifications(env.ctx.session).items.filter((r) => r.category === 'incomplete_order')).toHaveLength(103)
  })
  it('reopens the order by reversing physical completion without cascading production', () => {
    const f = seed({ fulfill: false, costs: true })
    const permit = issueRelease({ orderId: f.order.id, kind: 'installation' }, env.ctx)
    const completion = recordDelivery({ orderId: f.order.id, releaseId: permit.id, kind: 'installation' }, env.ctx)
    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)).toThrow(/بعد بدء التصنيع/)
    cancelDelivery({ id: completion.id }, env.ctx)
    expect(getProductionOrder(f.sheet!.id).sheet.status).toBe('completed')
    // CC04: labour was recognised at manufacturing completion, which undoing order completion never reverses.
    // The fixture both plans 80 (تجهيز الإنتاج) and assigns 80 on the Manufacturing Order: both are commissions.
    expect(workerBalances(f.workerId)).toEqual({ payableMinor: m(160), debtMinor: 0 })
    const before = database()
    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)).toThrow(/بعد بدء التصنيع/)
    expect(database()).toEqual(before)
  })
  it('manufacturing-completion commission survives delivery undo/redo exactly once and never touches worker debt (CC04)', () => {
    const f = seed({ costs: true })
    recordWorkerTransaction({ workerId: f.workerId, kind: 'withdrawal', amountMinor: m(20) }, env.ctx)
    const cashBefore = rows('cash_transactions')
    // Planned 80 + assigned 80 on the Manufacturing Order (see seed).
    const expected = { payableMinor: m(160), debtMinor: m(20) }
    expect(workerBalances(f.workerId)).toEqual(expected)
    cancelDelivery({ id: f.delivery!.id }, env.ctx)
    expect(workerBalances(f.workerId)).toEqual(expected)
    const next = recordDelivery({ orderId: f.order.id, releaseId: f.permit!.id, kind: 'installation' }, env.ctx)
    expect(workerBalances(f.workerId)).toEqual(expected)
    cancelDelivery({ id: next.id }, env.ctx)
    expect(workerBalances(f.workerId)).toEqual(expected)
    expect(rows('worker_transactions').filter((row) => (row as { kind: string }).kind !== 'withdrawal')).toHaveLength(2)
    expect(rows('cash_transactions')).toEqual(cashBefore)
  })
  it('keeps approved commercial fields and terms immutable until a legitimate unapproval', () => {
    const f = seed({ paid: 0, produce: false })
    expect(() => updateFinalInvoice(f.invoice.id, { notes: 'bypass' }, env.ctx)).toThrow(/بعد اعتمادها/)
    expect(() => addFinalInvoiceTerms(f.invoice.id, [0], env.ctx)).toThrow(/بعد اعتمادها/)
    unapprove(f.invoice.id)
    updateFinalInvoice(f.invoice.id, { notes: 'مسموح' }, env.ctx)
    expect(getFinalInvoice(f.invoice.id).invoice.notes).toBe('مسموح')
  })
  it.each(['delivery', 'transport', 'installation', 'delivery_installation'] as const)('reexecutes the canonical %s permit/completion after explicit undo without touching money', (kind) => {
    const f = seed({ fulfill: false })
    const before = financial()
    const permit = issueRelease({ orderId: f.order.id, kind }, env.ctx)
    const completionKind = kind === 'transport' ? 'delivery' : kind === 'delivery' ? 'handover' : kind
    const delivery = recordDelivery({ orderId: f.order.id, releaseId: permit.id, kind: completionKind, actualCostMinor: m(15) }, env.ctx)
    cancelDelivery({ id: delivery.id }, env.ctx)
    expect(getOrder(f.order.id).workflow.requiredCompletion?.releaseId).toBe(permit.id)
    reverseRelease(permitRequest(permit.id, f.order.id), env.ctx)
    const freshPermit = issueRelease({ orderId: f.order.id, kind }, env.ctx)
    recordDelivery({ orderId: f.order.id, releaseId: freshPermit.id, kind: completionKind, actualCostMinor: m(20) }, env.ctx)
    expect(orderCostBreakdown(f.order.id).deliveryCostMinor).toBe(m(20))
    expect(financial()).toEqual(before)
  })
  it.each(['releases.reverse', 'deliveries.reverse', 'orders.archive', 'orders.restore'] as const)('rolls back the entire %s operation if its audit cannot be written', (action) => {
    const f = seed({ costs: true })
    if (action === 'releases.reverse') cancelDelivery({ id: f.delivery!.id }, env.ctx)
    if (action === 'orders.restore') archiveOrder({ id: f.order.id, archive: true }, env.ctx)
    const before = database()
    getRawConnection().exec(`CREATE TRIGGER fail_step_audit BEFORE INSERT ON audit_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'forced domain audit failure'); END`)
    expect(() => {
      if (action === 'releases.reverse') reverseRelease(permitRequest(f.permit!.id, f.order.id), env.ctx)
      else if (action === 'deliveries.reverse') cancelDelivery({ id: f.delivery!.id }, env.ctx)
      else archiveOrder({ id: f.order.id, archive: action === 'orders.archive' }, env.ctx)
    }).toThrow(/forced domain audit failure/)
    expect(database()).toEqual(before)
  })
  it('refuses missing/ambiguous historical consumption links without exposing an Undone-but-consumed manufacturing state', () => {
    const f = seed({ start: false })
    const line = getProductionOrder(f.sheet!.id).materialLines[0]
    getRawConnection().prepare('UPDATE order_material_lines SET movement_id=NULL WHERE id=?').run(line.id)
    const before = database()
    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)).toThrow(/رابط|الروابط/)
    expect(database()).toEqual(before)
    expect(getOrder(f.order.id).workflow.manufacturingIssued).toBe(true)
    expect(availableQty(f.materialId)).toBe(q(5))
  })
  it('refuses legacy FIFO allocation corruption atomically and does not reconstruct historical costs', () => {
    const f = seed({ start: false })
    getRawConnection().exec('UPDATE fifo_allocations SET cost_minor=cost_minor+1 WHERE id=(SELECT MIN(id) FROM fifo_allocations)')
    const before = database()
    expect(() => reverseWorkSheet(sheetRequest(f.sheet!.id), env.ctx)).toThrow(/تكلفة/)
    expect(database()).toEqual(before)
    expect(getOrder(f.order.id).workflow.manufacturingIssued).toBe(true)
  })
  it('refuses legacy invoices with missing conversion identity or original editable lines, preserving history', () => {
    const f = seed({ paid: 0, produce: false })
    getRawConnection().prepare('UPDATE orders SET final_invoice_id=NULL WHERE id=?').run(f.order.id)
    let before = database()
    expect(() => unapprove(f.invoice.id)).toThrow(/رابط تحويل/)
    expect(database()).toEqual(before)
    getRawConnection().prepare('UPDATE orders SET final_invoice_id=? WHERE id=?').run(f.invoice.id, f.order.id)
    getRawConnection().prepare('DELETE FROM final_invoice_lines WHERE final_invoice_id=?').run(f.invoice.id)
    before = database()
    expect(() => unapprove(f.invoice.id)).toThrow(/بنود تحرير/)
    expect(database()).toEqual(before)
  })
  it('copies corrected material-linked finishes and accessories through normal reapproval and retains the old line FK', () => {
    const f = seed({ paid: 0, start: false, costs: true })
    const oldLine = getOrder(f.order.id).lines[0]
    getRawConnection().prepare('UPDATE order_worker_assignments SET order_line_id=? WHERE work_sheet_id=?').run(oldLine.id, f.sheet!.id)
    undo(f); unapprove(f.invoice.id)
    const colorId = (getRawConnection().prepare('SELECT color_id AS id FROM materials WHERE id = ?').get(f.materialId) as { id: number }).id
    updateColor(colorId, { code: 'STEP-NEW', name: 'تشطيب مصحح' }, env.ctx)
    const accessories = createCategory({ name: 'ملحقات التصحيح', isAccessory: true }, env.ctx)
    const accessoryId = createMaterial({ sku: 'STEP-ACC', name: 'مقبض مصحح', categoryId: accessories, unit: 'قطعة', pricingRule: 'exact', currentMarketPriceMicro: 0 }, env.ctx)
    updateFinalInvoice(f.invoice.id, { lines: [{ lineKind: 'custom', description: 'مصّحح', quantityMicro: q(1), unitPriceMinor: m(12000), materialIds: [f.materialId], colorIds: [colorId], accessoryIds: [accessoryId] }] }, env.ctx)
    approveFinalInvoice(f.invoice.id, env.ctx)
    expect(getOrder(f.order.id).lines[0]).toMatchObject({ selectedMaterials: [{ materialId: f.materialId }], selectedColors: [{ colorId, code: 'STEP-NEW' }], selectedAccessories: [{ materialId: accessoryId }] })
    expect(getRawConnection().prepare('SELECT superseded_at FROM order_lines WHERE id=?').get(oldLine.id)).toMatchObject({ superseded_at: expect.any(String) })
    expect(getRawConnection().prepare('SELECT order_line_id FROM order_worker_assignments WHERE work_sheet_id=?').get(f.sheet!.id)).toEqual({ order_line_id: oldLine.id })
    expect(() => removeMachineUsage((rows('order_machine_usage') as Array<{ id: number }>)[0].id, env.ctx)).toThrow(/تاريخي/)
    expect(() => removeAssignment((rows('order_worker_assignments') as Array<{ id: number }>)[0].id, env.ctx)).toThrow(/تاريخي/)
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
