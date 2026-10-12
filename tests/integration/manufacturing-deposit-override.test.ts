import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier, customerBalances } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { getOrderOrThrow, recordPayment } from '@main/services/sales/orders.service'
import { completeProduction, issueRelease, issueWorkSheet, listReleases, listWorkSheets } from '@main/services/production/production.service'
import { savePlannedMaterials } from '@main/services/planning/planning.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { getRawConnection } from '@main/db/connection'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import type { ServiceContext } from '@main/services/base/service.types'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const issuePermissions = [P.worksheets.issue, P.inventory.consume]
function context(permissions: string[]): ServiceContext {
  return { session: { ...env.ctx.session, user: { ...env.ctx.session.user, isAdmin: false }, permissions } }
}
function order() {
  const customerId = createCustomer({ name: `عميل ائتمان ${Math.random()}` }, env.ctx)
  const invoice = createFinalInvoice({
    customerId, depositPercentBp: 1_000, requiresInstallation: true,
    lines: [{ lineKind: 'custom', description: 'طلب تصنيع ائتماني', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(50_000) }]
  }, env.ctx)
  return { customerId, order: approveToOrder(invoice.id, env.ctx) }
}
function finances(orderId: number, customerId: number) {
  const stored = getOrderOrThrow(orderId)
  return {
    paidMinor: stored.paidMinor,
    remainingMinor: stored.remainingMinor,
    payments: getRawConnection().prepare('SELECT * FROM customer_payments WHERE order_id = ?').all(orderId),
    receivable: customerBalances(undefined, customerId)[0],
    cash: getRawConnection().prepare('SELECT * FROM cash_transactions').all()
  }
}

describe('BL-12 payment-independent manufacturing', () => {
  it.each([0, 2_000, 5_000])('issues manufacturing with %i paid and preserves receivable', (paid) => {
    const seeded = order()
    if (paid) recordPayment({ orderId: seeded.order.id, amountMinor: moneyFromMajor(paid) }, env.ctx)
    const before = finances(seeded.order.id, seeded.customerId)
    const sheet = issueWorkSheet({ orderId: seeded.order.id }, context(issuePermissions))
    expect(sheet.id).toBeGreaterThan(0)
    expect(finances(seeded.order.id, seeded.customerId)).toEqual(before)
    expect(getRawConnection().prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'worksheets.issue' AND entity_id = ?").get(String(sheet.id))).toEqual({ c: 1 })
    expect(() => issueWorkSheet({ orderId: seeded.order.id }, context(issuePermissions))).toThrow(/بالفعل/)
  })

  it('requires ordinary worksheet and inventory permissions despite unpaid balance', () => {
    const seeded = order()
    expect(() => issueWorkSheet({ orderId: seeded.order.id }, context([P.worksheets.issue]))).toThrow(/صلاحية/)
    expect(() => issueWorkSheet({ orderId: seeded.order.id }, context([P.inventory.consume]))).toThrow(/صلاحية/)
    expect(listWorkSheets({ orderId: seeded.order.id }).items).toEqual([])
  })

  it('rolls back a zero-paid worksheet when planned material is insufficient', () => {
    const seeded = order()
    const categoryId = createCategory({ name: 'مواد تصنيع ائتماني' }, env.ctx)
    const materialId = createMaterial({ sku: 'BL12-SHORT', name: 'لوح', categoryId, unit: 'لوحة', currentMarketPriceMicro: unitCostFromMajor(100), pricingRule: 'exact' } as never, env.ctx)
    const supplierId = createSupplier({ name: 'مورد تصنيع ائتماني' }, env.ctx)
    createPurchase({ supplierId, lines: [{ materialId, qtyMicro: quantityFromDisplay(7), unitCostMicro: unitCostFromMajor(100) }] }, env.ctx)
    savePlannedMaterials({ orderId: seeded.order.id }, [{ materialId, materialName: 'لوح', qtyMicro: quantityFromDisplay(10), unit: 'لوحة', estimatedUnitCostMicro: unitCostFromMajor(100) }], env.ctx)
    const before = finances(seeded.order.id, seeded.customerId)
    expect(() => issueWorkSheet({ orderId: seeded.order.id }, context(issuePermissions))).toThrow(/الرصيد المتاح/)
    expect(listWorkSheets({ orderId: seeded.order.id }).items).toEqual([])
    expect(availableQty(materialId)).toBe(quantityFromDisplay(7))
    expect(finances(seeded.order.id, seeded.customerId)).toEqual(before)
  })

  it('allows ordinary IPC issuance without a deposit and keeps the normal permission gate', async () => {
    const seeded = order()
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    const roleId = createRole({ name: 'إصدار تصنيع ائتماني', permissions: issuePermissions }, env.ctx)
    createUser({ username: 'bl12-manufacturing', password: 'secret123', fullName: 'مستخدم تصنيع', roleId }, env.ctx)
    login('bl12-manufacturing', 'secret123', 12_400)
    const result = await handlers.get(IPC_CHANNELS.production.issueWorkSheet)!({ sender: { id: 12_400 } } as IpcMainInvokeEvent, { orderId: seeded.order.id })
    expect(result.ok).toBe(true)
    expect(listWorkSheets({ orderId: seeded.order.id }).items).toHaveLength(1)
    expect(finances(seeded.order.id, seeded.customerId).paidMinor).toBe(0)
  })

  it('allows an unpaid Exit Permit after completed manufacturing without an override', () => {
    const seeded = order()
    const ctx = context([...issuePermissions, P.releases.issue])
    completeProduction(issueWorkSheet({ orderId: seeded.order.id }, ctx).id, ctx)
    const before = finances(seeded.order.id, seeded.customerId)
    const permit = issueRelease({ orderId: seeded.order.id, kind: 'installation' }, ctx)
    expect(permit.id).toBeGreaterThan(0)
    expect(listReleases({ orderId: seeded.order.id }).items[0]).toMatchObject({ authorizationType: 'unpaid', paidMinorAtIssue: 0, remainingMinorAtIssue: moneyFromMajor(50_000) })
    expect(finances(seeded.order.id, seeded.customerId)).toEqual(before)
  })
})
