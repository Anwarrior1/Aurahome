import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createRole, createUser, listRoles } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { requirePermission } from '@main/permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer } from '@main/services/parties/parties.service'
import { createQuotation } from '@main/services/sales/quotations.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import { issueWorkSheet, issueRelease } from '@main/services/production/production.service'
import { buildPreliminaryInvoice, buildWorkSheet, buildRelease } from '@main/services/documents/documents.service'
import { renderPreliminaryInvoice, renderWorkSheet, renderRelease } from '@main/reports/templates/documents.template'
import { createMachine, addMachineUsage } from '@main/services/production/machines.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

describe('Roles and permissions (BR-54, BR-55, BR-104)', () => {
  it('enforces permissions in the service layer, not just the UI', () => {
    // A sales role that can view orders but must NOT see costs or profit.
    const roleId = createRole({ name: 'مبيعات', permissions: [P.orders.view, P.customers.view] }, env.ctx)
    createUser({ username: 'sales', password: 'sales123', fullName: 'موظف مبيعات', roleId }, env.ctx)
    const { session } = login('sales', 'sales123', 2)

    expect(() => requirePermission(session, P.orders.view)).not.toThrow()
    expect(() => requirePermission(session, P.costing.view)).toThrowError(/صلاحية/)
    expect(() => requirePermission(session, P.profit.view)).toThrowError(/صلاحية/)
    expect(() => requirePermission(session, P.withdrawals.manage)).toThrowError(/صلاحية/)
    expect(() => requirePermission(session, P.backup.restore)).toThrowError(/صلاحية/)
  })

  it('gives the bootstrap administrator every permission and cannot lock it out', () => {
    expect(env.ctx.session.user.isAdmin).toBe(true)
    expect(() => requirePermission(env.ctx.session, P.backup.restore)).not.toThrow()

    const adminRole = listRoles().find((role) => role.isAdmin)!
    expect(adminRole.permissions.length).toBeGreaterThan(30)
  })
})

describe('Document safety (BR-17, BR-73, BR-88, BR-83)', () => {
  function fullOrder() {
    const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
    createMaterial({
      sku: 'M1', name: 'مادة', categoryId, unit: 'لوح',
      currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact'
    } as never, env.ctx)
    const customerId = createCustomer({ name: 'شركة العميل', phone: '0911234567' }, env.ctx)
    // The customer-facing preliminary invoice, prepared for the same job.
    const quotation = createQuotation({
      customerId,
      requiresInstallation: true,
      lines: [{
        lineKind: 'custom', description: 'مطبخ حسب الطلب', dimensions: '300×60',
        colorCode: '205', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(10000)
      }]
    }, env.ctx)
    const invoice = createFinalInvoice({
      customerId,
      requiresInstallation: true,
      lines: [{
        lineKind: 'custom', description: 'مطبخ حسب الطلب', dimensions: '300×60',
        colorCode: '205', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(10000)
      }]
    }, env.ctx)
    const order = approveToOrder(invoice.id, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(10000) }, env.ctx)

    const machineId = createMachine({ name: 'آلة', costingUnit: 'لوح', defaultRateMicro: unitCostFromMajor(30) }, env.ctx)
    addMachineUsage({ orderId: order.id, machineId, usageQtyMicro: quantityFromDisplay(5) }, env.ctx)
    return { quotationId: quotation.id, orderId: order.id }
  }

  it('never exposes internal cost or profit data on a customer document (BR-73)', () => {
    const { quotationId } = fullOrder()
    const dto = buildPreliminaryInvoice(quotationId)
    const html = renderPreliminaryInvoice(dto, { name: 'AURA home' })

    // The customer DTO has no cost-bearing fields at all.
    const serialised = JSON.stringify(dto)
    for (const forbidden of ['costMinor', 'actualCost', 'machineCost', 'laborCost', 'profit', 'fifo']) {
      expect(serialised).not.toContain(forbidden)
    }
    // The rendered document shows the deposit and terms, not internals.
    expect(html).toContain('فاتورة مبدئية')
    expect(html).toContain('الدفعة المقدمة المطلوبة')
    expect(html).not.toContain('تكلفة')
    // The eight confirmed terms are printed.
    expect(html).toContain('يسري هذا العرض لمدة 48 ساعة')
    // Western digits only — never Arabic-Indic (BR-27).
    expect(html).not.toMatch(/[٠-٩]/)
  })

  it('never puts a monetary figure on the factory production order, for ANY role (item 14)', () => {
    const { orderId } = fullOrder()
    const sheet = issueWorkSheet({ orderId, workerIds: [] }, env.ctx)

    // Item 14 narrows BR-88: the factory document is now cost-free for
    // everyone, including the owner. Internal costing stays on screen in
    // the ERP, gated by costing.view — it just never reaches this print.
    const asOwner = buildWorkSheet(sheet.id, env.ctx)
    expect('costBlock' in asOwner).toBe(false)

    const roleId = createRole({ name: 'إنتاج', permissions: [P.worksheets.view] }, env.ctx)
    createUser({ username: 'prod', password: 'prod123', fullName: 'عامل إنتاج', roleId }, env.ctx)
    const { session } = login('prod', 'prod123', 3)
    const asProduction = buildWorkSheet(sheet.id, { session })

    for (const dto of [asOwner, asProduction]) {
      const serialised = JSON.stringify(dto)
      for (const forbidden of ['costBlock', 'costMinor', 'Cost', 'price', 'profit']) {
        expect(serialised).not.toContain(forbidden)
      }
    }

    const html = renderWorkSheet(asProduction, { name: 'AURA home' })
    expect(html).toContain('مستند داخلي')
    expect(html).toContain('المواد المطلوبة للتصنيع')
    expect(html).toContain('كود اللون: 205') // colour flows to the factory (BR-70)
    expect(html).not.toContain('تكلفة')
    expect(html).not.toContain('د.ل') // no money on the factory sheet at all
  })

  it('marks the installation authorization as fully paid and uses its own wording (BR-83/BR-112)', () => {
    const { orderId } = fullOrder()
    const release = issueRelease({ orderId, kind: 'installation' }, env.ctx)
    const dto = buildRelease(release.id)

    expect(dto.balanceConfirmedPaid).toBe(true)
    expect(dto.kind).toBe('installation')
    const html = renderRelease(dto, { name: 'AURA home' })
    expect(html).toContain('إذن تركيب')
    expect(html).toContain('مسدد بالكامل')
    // No selling price or profit on an internal release document.
    expect(html).not.toContain('سعر البيع')
  })
})
