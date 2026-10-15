import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P, allPermissionKeys, PERMISSION_SECTIONS } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCategory, createMaterial, createColor } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { approveToOrder } from '../helpers/sales-flow'
import { cancelOrder } from '@main/services/sales/orders.service'
import { issueWorkSheet, consumeForOrder, completeProduction } from '@main/services/production/production.service'
import { productsFromOrder } from '@main/services/sales/uncollected-products.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor } from '@shared/money/cost'

/**
 * RBAC for "المنتجات غير المستلمة".
 *
 * Seeing the physical product, seeing what it COST to build, and being
 * allowed to sell it are three separate privileges, and all three are
 * enforced in main — a direct IPC call with the wrong role fails, and
 * an unauthorised session never receives the cost fields at all.
 */
let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 55100
let event: IpcMainInvokeEvent

beforeEach(async () => {
  env = setupTestDatabase()
  event = { sender: { id: ++windowId } } as IpcMainInvokeEvent
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi
    .spyOn(electron.ipcMain, 'handle')
    .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})
afterEach(() => env.cleanup())

const call = (channel: string, request?: unknown): Promise<IpcResult<unknown>> =>
  handlers.get(channel)!(event, request)

function signInWith(permissions: string[]): void {
  const roleId = createRole({ name: `دور ${windowId}`, permissions }, env.ctx)
  createUser({ username: `u${windowId}`, fullName: 'مستخدم', password: 'secret123', roleId }, env.ctx)
  login(`u${windowId}`, 'secret123', windowId)
}

/** A real transferred product, created by the real cancellation. */
function seedProduct(): number {
  const categoryId = createCategory({ name: 'أخشاب' }, env.ctx)
  const colorId = createColor({ code: '205', name: 'بني' }, env.ctx)
  const materialId = createMaterial(
    { sku: 'MDF', name: 'لوح', categoryId, colorId, unit: 'لوح', currentMarketPriceMicro: unitCostFromMajor(150), pricingRule: 'exact' } as never,
    env.ctx
  )
  createPurchase(
    { supplierId: createSupplier({ name: 'مورد' }, env.ctx), lines: [{ materialId, qtyMicro: q(100), unitCostMicro: unitCostFromMajor(100) }] },
    env.ctx
  )
  const customerId = createCustomer({ name: 'عميل' }, env.ctx)
  const invoice = createFinalInvoice(
    { customerId, depositPercentBp: 0, lines: [{ lineKind: 'custom', description: 'خزانة', quantityMicro: q(1), unitPriceMinor: m(6000) }] },
    env.ctx
  )
  const order = approveToOrder(invoice.id, env.ctx)
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
  consumeForOrder({ workSheetId: sheet.id, materialId, physicalQtyMicro: q(10) }, env.ctx)
  completeProduction(sheet.id, env.ctx)
  cancelOrder({ orderId: order.id, reason: 'إلغاء' }, env.ctx)
  return productsFromOrder(order.id)[0]!.id
}

describe('35. a direct, unauthorised IPC call fails', () => {
  it('every uncollected-product channel refuses a role that lacks its key', async () => {
    seedProduct()
    signInWith([P.orders.view])

    for (const channel of [C.uncollectedProducts.list, C.uncollectedProducts.get, C.uncollectedProducts.forOrder, C.uncollectedProducts.available]) {
      const result = await call(channel, { id: 1 })
      expect(result.ok, channel).toBe(false)
      expect((result as { error: { code: string } }).error.code).toBe('FORBIDDEN')
    }
  })

  it('selling is its own key — viewing the page does not grant the resale picker', async () => {
    seedProduct()
    signInWith([P.uncollectedProducts.view])

    expect((await call(C.uncollectedProducts.list, {})).ok).toBe(true)
    const picker = await call(C.uncollectedProducts.available, {})
    expect(picker.ok).toBe(false)
    expect((picker as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('the operational Manufacturing Order query keeps the existing worksheet-view permission', async () => {
    seedProduct()
    signInWith([P.uncollectedProducts.view])

    const denied = await call(C.production.listOperationalWorkSheets, {})
    expect(denied.ok).toBe(false)
    expect((denied as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('an authorised direct IPC query receives the server-filtered page', async () => {
    seedProduct()
    signInWith([P.worksheets.view])

    const result = await call(C.production.listOperationalWorkSheets, { limit: 25 })
    expect(result.ok).toBe(true)
    expect((result as { data: { items: unknown[]; summary: { totalCount: number } } }).data).toMatchObject({ items: [], summary: { totalCount: 0 } })
  })
})

describe('34. internal cost never leaves main for an unauthorised session', () => {
  it('the list omits the cost fields entirely rather than hiding them', async () => {
    seedProduct()
    signInWith([P.uncollectedProducts.view])

    const result = await call(C.uncollectedProducts.list, {})
    expect(result.ok).toBe(true)
    const row = (result as { data: { items: Array<Record<string, unknown>> } }).data.items[0]!
    expect(row.name).toBe('خزانة')
    // Absent from the payload — not merely unrendered.
    expect('costBasisMinor' in row).toBe(false)
    expect('soldPriceMinor' in row).toBe(false)
  })

  it('the detail omits every cost and historical-price field', async () => {
    const productId = seedProduct()
    signInWith([P.uncollectedProducts.view])

    const result = await call(C.uncollectedProducts.get, { id: productId })
    expect(result.ok).toBe(true)
    const product = (result as { data: Record<string, unknown> }).data
    expect(product.name).toBe('خزانة')
    expect(product.selectedMaterials).toBeDefined()
    for (const field of [
      'costBasisMinor', 'costBasisMethod', 'costBasisOrderTotalMinor',
      'costBasisMaterialMinor', 'costBasisMachineMinor', 'costBasisWorkerMinor',
      'costBasisDeliveryMinor', 'costBasisExpenseMinor',
      'soldPriceMinor', 'originalUnitPriceMinor', 'originalLineTotalMinor'
    ]) {
      expect(field in product, field).toBe(false)
    }
  })

  it('the cost permission delivers them, so the redaction is the permission and nothing else', async () => {
    const productId = seedProduct()
    signInWith([P.uncollectedProducts.view, P.uncollectedProducts.viewCost])

    const result = await call(C.uncollectedProducts.get, { id: productId })
    const product = (result as { data: Record<string, unknown> }).data
    expect(product.costBasisMinor).toBeGreaterThan(0)
    expect(product.costBasisMethod).toBe('sole_manufactured_item')
  })
})

describe('the permission catalog exposes the new keys correctly', () => {
  it('all four keys are published with a section, and cost visibility is marked sensitive', () => {
    const keys = allPermissionKeys()
    const mine = keys.filter((entry) => entry.module === 'uncollectedProducts')
    expect(mine.map((entry) => entry.key).sort()).toEqual(
      [P.uncollectedProducts.resume, P.uncollectedProducts.sell, P.uncollectedProducts.view, P.uncollectedProducts.viewCost].sort()
    )
    expect(mine.every((entry) => entry.section === 'uncollectedProducts')).toBe(true)
    expect(mine.find((entry) => entry.key === P.uncollectedProducts.viewCost)!.sensitive).toBe(true)
    expect(PERMISSION_SECTIONS.map((section) => section.key)).toContain('uncollectedProducts')
  })
})
