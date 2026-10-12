import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { PERMISSION_KEYS as P, allPermissionKeys } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { listPlannedMaterials } from '@main/services/planning/planning.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

/**
 * "تجهيز الإنتاج" (Production Preparation) — the planning block on a
 * Customer Order: planned materials, machines, worker commissions and
 * order expenses.
 *
 * It previously had no permission of its own: reading it needed only
 * `orders.view`, writing it rode on `orders.manage`, and the section
 * was shown in the UI on the strength of a COST-visibility key. These
 * tests pin its two new permissions, the fact that they sit on top of
 * Customer Order access rather than replacing it, and the fact that
 * they reveal no money by themselves.
 */
let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 52300
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

function signInWith(permissions: string[]): number {
  const roleId = createRole({ name: `دور ${windowId}-${permissions.length}`, permissions }, env.ctx)
  createUser({ username: `u${windowId}`, fullName: 'مستخدم', password: 'secret123', roleId }, env.ctx)
  login(`u${windowId}`, 'secret123', windowId)
  return roleId
}

/** An approved invoice creates the Customer Order the planning hangs off. */
function seedOrder(): { orderId: number; materialId: number } {
  const customerId = createCustomer({ name: 'عميل التجهيز' }, env.ctx)
  const invoice = createFinalInvoice(
    {
      customerId,
      lines: [{ lineKind: 'custom', description: 'خزانة', quantityMicro: q(1), unitPriceMinor: m(5000) }]
    },
    env.ctx
  )
  const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
  const categoryId = createCategory({ name: 'ألواح' }, env.ctx)
  const materialId = createMaterial(
    { sku: 'PREP-1', name: 'لوح', categoryId, unit: 'لوح', pricingRule: 'exact', currentMarketPriceMicro: c(10) },
    env.ctx
  )
  return { orderId, materialId }
}

const materialLines = (materialId: number): unknown[] => [
  { materialId, materialName: 'لوح', qtyMicro: q(3), estimatedUnitCostMicro: c(10) }
]

// ───────────────────────────── the permissions exist and are grouped right

describe('the two Production Preparation permissions', () => {
  it('appear as "تجهيز الإنتاج — عرض" and "تجهيز الإنتاج — إنشاء وتعديل"', () => {
    const byKey = new Map(allPermissionKeys().map((p) => [p.key, p]))
    expect(byKey.get(P.productionPrep.view)?.label).toBe('تجهيز الإنتاج — عرض')
    expect(byKey.get(P.productionPrep.manage)?.label).toBe('تجهيز الإنتاج — إنشاء وتعديل')
  })

  it('sit inside the existing الإنتاج group — no new top-level accordion', () => {
    const sections = allPermissionKeys().filter((p) => p.key.startsWith('productionPrep.'))
    expect(sections).toHaveLength(2)
    for (const permission of sections) expect(permission.section).toBe('production')
  })

  it('are not themselves marked sensitive — the money inside keeps its own keys', () => {
    const byKey = new Map(allPermissionKeys().map((p) => [p.key, p]))
    expect(byKey.get(P.productionPrep.view)?.sensitive).toBe(false)
    expect(byKey.get(P.productionPrep.manage)?.sensitive).toBe(false)
    // the sensitive cost/profit keys are untouched and still sensitive
    expect(byKey.get(P.orders.viewEstimatedCost)?.sensitive).toBe(true)
    expect(byKey.get(P.orders.viewExpectedProfit)?.sensitive).toBe(true)
  })
})

// ───────────────────────────── READ

describe('reading Production Preparation', () => {
  it('is refused outright without the view permission, even with full Customer Order access', async () => {
    const { orderId } = seedOrder()
    signInWith([P.orders.view, P.orders.manage])
    const result = await call(C.orders.planningSnapshot, { id: orderId })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
  })

  it('is allowed with Customer Order access + the view permission', async () => {
    const { orderId } = seedOrder()
    signInWith([P.orders.view, P.productionPrep.view])
    const result = await call(C.orders.planningSnapshot, { id: orderId })
    expect(result.ok).toBe(true)
  })

  it('does NOT replace Customer Order access — the order permission is still required', async () => {
    const { orderId } = seedOrder()
    signInWith([P.productionPrep.view]) // no orders.view
    const result = await call(C.orders.planningSnapshot, { id: orderId })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
  })
})

// ───────────────────────────── WRITE

describe('editing Production Preparation', () => {
  const WRITES = [
    [C.orders.savePlannedMaterials, 'lines'],
    [C.orders.savePlannedMachines, 'lines'],
    [C.orders.savePlannedWorkers, 'lines'],
    [C.orders.savePlannedExpenses, 'lines']
  ] as const

  it('a view-only user cannot mutate any of the four planning paths', async () => {
    const { orderId, materialId } = seedOrder()
    signInWith([P.orders.view, P.productionPrep.view])
    for (const [channel] of WRITES) {
      const result = await call(channel, {
        orderId,
        lines: channel === C.orders.savePlannedMaterials ? materialLines(materialId) : []
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    }
    // nothing was written
    expect(listPlannedMaterials({ orderId })).toHaveLength(0)
  })

  it('a user with the manage permission can use the existing mutations', async () => {
    const { orderId, materialId } = seedOrder()
    signInWith([P.orders.view, P.productionPrep.view, P.productionPrep.manage])
    const saved = await call(C.orders.savePlannedMaterials, { orderId, lines: materialLines(materialId) })
    expect(saved.ok).toBe(true)
    expect(listPlannedMaterials({ orderId })).toHaveLength(1)

    for (const [channel] of WRITES.slice(1)) {
      expect((await call(channel, { orderId, lines: [] })).ok).toBe(true)
    }
  })

  it('order-editing rights alone no longer authorise planning changes', async () => {
    const { orderId, materialId } = seedOrder()
    signInWith([P.orders.view, P.orders.manage])
    const result = await call(C.orders.savePlannedMaterials, { orderId, lines: materialLines(materialId) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
  })

  it('writing still requires Customer Order access as well', async () => {
    const { orderId, materialId } = seedOrder()
    signInWith([P.productionPrep.view, P.productionPrep.manage]) // no orders.view
    const result = await call(C.orders.savePlannedMaterials, { orderId, lines: materialLines(materialId) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
  })
})

// ───────────────────────────── sensitive data stays independent

describe('the new permissions reveal no money on their own', () => {
  it('planning view without عرض التكلفة التقديرية exposes no estimated cost or profit', async () => {
    const { orderId, materialId } = seedOrder()
    // plan something first, as an admin
    const planner = signInWith([P.orders.view, P.productionPrep.view, P.productionPrep.manage])
    void planner
    await call(C.orders.savePlannedMaterials, { orderId, lines: materialLines(materialId) })

    const result = await call(C.orders.planningSnapshot, { id: orderId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data as Record<string, unknown>
    expect(data).not.toHaveProperty('estimatedMaterialMinor')
    expect(data).not.toHaveProperty('totalEstimatedCostMinor')
    expect(data).not.toHaveProperty('expectedProfitMinor')
    expect(data).not.toHaveProperty('materials')
  })

  it('adding the existing cost key is what reveals the figures — the logic is not duplicated', async () => {
    const { orderId, materialId } = seedOrder()
    signInWith([P.orders.view, P.productionPrep.view, P.productionPrep.manage, P.orders.viewEstimatedCost])
    await call(C.orders.savePlannedMaterials, { orderId, lines: materialLines(materialId) })
    const result = await call(C.orders.planningSnapshot, { id: orderId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveProperty('estimatedMaterialMinor')
    // profit still needs its own separate key
    expect(result.data).not.toHaveProperty('expectedProfitMinor')
  })
})

// ───────────────────────────── independence from the Manufacturing Order

describe('Production Preparation is not Manufacturing Order issuance', () => {
  it('full planning rights grant no manufacturing action whatsoever', async () => {
    const { orderId } = seedOrder()
    signInWith([P.orders.view, P.productionPrep.view, P.productionPrep.manage])
    for (const [channel, request] of [
      [C.production.issueWorkSheet, { orderId }],
      [C.production.startProduction, { id: 1 }],
      [C.production.completeProduction, { id: 1 }]
    ] as const) {
      const result = await call(channel, request)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    }
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM work_sheets').get()).toEqual({ c: 0 })
  })

  it('and the Manufacturing Order keys are unchanged', () => {
    const worksheets = allPermissionKeys().filter((p) => p.key.startsWith('worksheets.'))
    expect(worksheets.map((p) => p.key).sort()).toEqual([
      'worksheets.issue',
      'worksheets.reverse',
      'worksheets.view'
    ])
  })
})

// ───────────────────────────── the Sales role

describe('the SALES role is unaffected', () => {
  it('is not granted Production Preparation, and cannot read or write it', async () => {
    const { orderId, materialId } = seedOrder()
    const SALES = [
      P.customers.view,
      P.customers.manage,
      P.quotations.view,
      P.quotations.manage,
      P.quotations.issue,
      P.finalInvoices.view,
      P.finalInvoices.manage
    ]
    expect(SALES).not.toContain(P.productionPrep.view)
    expect(SALES).not.toContain(P.productionPrep.manage)
    signInWith(SALES)

    for (const [channel, request] of [
      [C.orders.planningSnapshot, { id: orderId }],
      [C.orders.savePlannedMaterials, { orderId, lines: materialLines(materialId) }]
    ] as const) {
      const result = await call(channel, request)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    }
  })
})

// ───────────────────────────── Inventory untouched

describe('Inventory RBAC is untouched by this pass', () => {
  it('still exposes exactly its five keys under its own section', () => {
    const inventory = allPermissionKeys().filter((p) => p.key.startsWith('inventory.'))
    expect(inventory.map((p) => p.key).sort()).toEqual([
      'inventory.adjust',
      'inventory.consume',
      'inventory.valuation',
      'inventory.view',
      'inventory.waste'
    ])
    for (const permission of inventory) expect(permission.section).toBe('inventory')
  })
})
