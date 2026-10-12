import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder, getOrderOrThrow } from '@main/services/sales/orders.service'
import {
  completeProduction,
  consumeForOrder,
  correctMaterialConsumption,
  getProductionOrder,
  issueWorkSheet,
  reverseMaterialConsumption,
  reverseWorkSheet
} from '@main/services/production/production.service'
import {
  availableQty,
  reverseConsumptionMovement
} from '@main/services/inventory/inventory.service'
import {
  getUncollectedProduct,
  productsFromOrder,
  resumeOriginalOrder
} from '@main/services/sales/uncollected-products.service'
import { getRawConnection } from '@main/db/connection'
import { moneyFromMajor as money } from '@shared/money/money'
import { quantityFromDisplay as quantity } from '@shared/quantity/quantity'
import { unitCostFromMajor as unitCost } from '@shared/money/cost'
import { IPC_CHANNELS } from '@shared/constants/channels'

let env: TestEnv

beforeEach(() => {
  env = setupTestDatabase()
})

afterEach(() => env.cleanup())

const SNAPSHOT_TABLES = [
  'orders',
  'work_sheets',
  'order_material_lines',
  'inventory_movements',
  'fifo_layers',
  'fifo_allocations',
  'uncollected_products',
  'final_invoices',
  'final_invoice_lines',
  'customer_payments',
  'cash_transactions',
  'audit_log'
] as const

function authoritativeState() {
  const db = getRawConnection()
  return Object.fromEntries(
    SNAPSHOT_TABLES.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    ])
  )
}

function fixture(lineCount = 1, complete = true) {
  const categoryId = createCategory({ name: `BL01 boards ${crypto.randomUUID()}` }, env.ctx)
  const materialId = createMaterial(
    {
      sku: `BL01-${crypto.randomUUID()}`,
      name: 'BL01 board',
      categoryId,
      unit: 'board',
      pricingRule: 'exact',
      currentMarketPriceMicro: unitCost(100)
    },
    env.ctx
  )
  const supplierId = createSupplier({ name: `BL01 supplier ${crypto.randomUUID()}` }, env.ctx)
  createPurchase(
    {
      supplierId,
      lines: [{ materialId, qtyMicro: quantity(100), unitCostMicro: unitCost(100) }]
    },
    env.ctx
  )
  const customerId = createCustomer({ name: `BL01 customer ${crypto.randomUUID()}` }, env.ctx)
  const invoice = createFinalInvoice(
    {
      customerId,
      depositPercentBp: 0,
      lines: Array.from({ length: lineCount }, (_, index) => ({
        lineKind: 'custom' as const,
        description: `BL01 product ${index + 1}`,
        quantityMicro: quantity(1),
        unitPriceMinor: money(1_000)
      }))
    },
    env.ctx
  )
  const approval = approveFinalInvoice(invoice.id, env.ctx)
  const sheet = issueWorkSheet({ orderId: approval.orderId }, env.ctx)
  const consumption = consumeForOrder(
    { workSheetId: sheet.id, materialId, physicalQtyMicro: quantity(10) },
    env.ctx
  )
  if (complete) completeProduction(sheet.id, env.ctx)
  return { ...approval, customerId, materialId, invoiceId: invoice.id, sheet, consumption }
}

function cancel(f: ReturnType<typeof fixture>) {
  cancelOrder({ orderId: f.orderId, reason: 'BL-01 cancellation' }, env.ctx)
  return productsFromOrder(f.orderId)
}

function worksheetReversal(f: ReturnType<typeof fixture>) {
  const current = getProductionOrder(f.sheet.id)
  return () =>
    reverseWorkSheet(
      {
        id: f.sheet.id,
        expectedToken: current.reversalToken,
        confirmation: f.sheet.documentNumber,
        reason: 'BL-01 prohibited reversal'
      },
      env.ctx
    )
}

function expectRefusedWithoutResidue(operation: () => unknown) {
  const before = authoritativeState()
  expect(operation).toThrow(/المنتجات غير المستلمة|تكلفة الإنتاج أصبحت تاريخية/)
  expect(authoritativeState()).toEqual(before)
}

describe('BL-01 manufactured output retains exactly one material backing', () => {
  it('refuses worksheet reversal for available Uncollected output with zero residue', () => {
    const f = fixture(2)
    const products = cancel(f)
    expect(products).toHaveLength(2)
    expect(products.every((product) => product.status === 'available')).toBe(true)

    expectRefusedWithoutResidue(worksheetReversal(f))
    expect(availableQty(f.materialId)).toBe(quantity(90))
    expect(getProductionOrder(f.sheet.id).sheet.status).toBe('completed')
  })

  it('refuses direct material-consumption reversal with zero residue', () => {
    const f = fixture()
    cancel(f)

    expectRefusedWithoutResidue(() =>
      reverseMaterialConsumption({ id: f.consumption.id, reason: 'BL-01 direct bypass' }, env.ctx)
    )
    expect(availableQty(f.materialId)).toBe(quantity(90))
  })

  it('refuses the lower-level FIFO restoration helper as a direct-service bypass', () => {
    const f = fixture()
    cancel(f)
    const line = getRawConnection()
      .prepare('SELECT movement_id AS movementId FROM order_material_lines WHERE id = ?')
      .get(f.consumption.id) as { movementId: number }

    expectRefusedWithoutResidue(() =>
      reverseConsumptionMovement({
        movementId: line.movementId,
        sourceRefId: f.consumption.id,
        reason: 'BL-01 lower-level bypass',
        ctx: env.ctx
      })
    )
  })

  it('refuses material-consumption correction with zero residue', () => {
    const f = fixture()
    cancel(f)

    expectRefusedWithoutResidue(() =>
      correctMaterialConsumption(
        {
          id: f.consumption.id,
          materialId: f.materialId,
          physicalQtyMicro: quantity(5),
          reason: 'BL-01 correction bypass'
        },
        env.ctx
      )
    )
    expect(availableQty(f.materialId)).toBe(quantity(90))
  })

  it('routes every IPC mutation through the same authoritative guard', async () => {
    const f = fixture()
    cancel(f)
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
    >()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => {
      handlers.set(channel, handler)
    }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    const event = { sender: { id: 1 } } as IpcMainInvokeEvent
    const current = getProductionOrder(f.sheet.id)
    const attempts: Array<[string, unknown]> = [
      [
        IPC_CHANNELS.production.reverseWorkSheet,
        {
          id: f.sheet.id,
          expectedToken: current.reversalToken,
          confirmation: f.sheet.documentNumber,
          reason: 'BL-01 IPC worksheet bypass'
        }
      ],
      [
        IPC_CHANNELS.production.reverseMaterialConsumption,
        { id: f.consumption.id, reason: 'BL-01 IPC reversal bypass' }
      ],
      [
        IPC_CHANNELS.production.correctMaterialConsumption,
        {
          id: f.consumption.id,
          materialId: f.materialId,
          physicalQtyMicro: quantity(5),
          reason: 'BL-01 IPC correction bypass'
        }
      ]
    ]

    for (const [channel, payload] of attempts) {
      const before = authoritativeState()
      expect(await handlers.get(channel)!(event, payload)).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT', message: expect.stringMatching(/المنتجات غير المستلمة|تكلفة الإنتاج أصبحت تاريخية/) }
      })
      expect(authoritativeState()).toEqual(before)
    }
  })

  it.each(['reserved', 'sold'] as const)(
    'refuses reversal and correction while Uncollected output is %s',
    (status) => {
      const f = fixture()
      const [product] = cancel(f)
      const buyerId = createCustomer({ name: `BL01 buyer ${status}` }, env.ctx)
      const resale = createFinalInvoice(
        {
          customerId: buyerId,
          depositPercentBp: 0,
          lines: [
            {
              lineKind: 'custom',
              description: 'BL01 resale',
              quantityMicro: quantity(1),
              unitPriceMinor: money(1_200),
              uncollectedProductId: product!.id
            }
          ]
        },
        env.ctx
      )
      if (status === 'sold') approveFinalInvoice(resale.id, env.ctx)
      expect(getUncollectedProduct(product!.id).status).toBe(status)

      expectRefusedWithoutResidue(() =>
        reverseMaterialConsumption({ id: f.consumption.id, reason: 'BL-01 status bypass' }, env.ctx)
      )
      expectRefusedWithoutResidue(() =>
        correctMaterialConsumption(
          {
            id: f.consumption.id,
            materialId: f.materialId,
            physicalQtyMicro: quantity(5),
            reason: 'BL-01 status correction bypass'
          },
          env.ctx
        )
      )
      expectRefusedWithoutResidue(worksheetReversal(f))
    }
  )

  it('preserves eligible pre-start worksheet reversal and exact FIFO restoration', () => {
    const f = fixture(1, false)
    const db = getRawConnection()
    const line = db
      .prepare('SELECT movement_id AS movementId FROM order_material_lines WHERE id = ?')
      .get(f.consumption.id) as { movementId: number }
    const allocations = db
      .prepare('SELECT layer_id, qty_micro, cost_minor FROM fifo_allocations WHERE movement_id = ? ORDER BY id')
      .all(line.movementId)

    worksheetReversal(f)()

    expect(availableQty(f.materialId)).toBe(quantity(100))
    expect(getProductionOrder(f.sheet.id).sheet.status).toBe('reversed')
    expect(db.prepare('SELECT layer_id, qty_micro, cost_minor FROM fifo_allocations WHERE movement_id = ? ORDER BY id').all(line.movementId)).toEqual(allocations)
    expect(db.prepare('SELECT status FROM order_material_lines WHERE id = ?').get(f.consumption.id)).toEqual({ status: 'reversed' })
  })

  it('preserves eligible pre-completion direct correction and reversal', () => {
    const correctedFixture = fixture(1, false)
    const corrected = correctMaterialConsumption(
      {
        id: correctedFixture.consumption.id,
        materialId: correctedFixture.materialId,
        physicalQtyMicro: quantity(5),
        reason: 'eligible correction'
      },
      env.ctx
    )
    expect(availableQty(correctedFixture.materialId)).toBe(quantity(95))
    reverseMaterialConsumption({ id: corrected.id, reason: 'eligible reversal' }, env.ctx)
    expect(availableQty(correctedFixture.materialId)).toBe(quantity(100))
  })

  it('preserves whole-order resumption without duplicating product or material state', () => {
    const f = fixture(2)
    const products = cancel(f)
    const stock = availableQty(f.materialId)
    const productIds = products.map((product) => product.id)

    const result = resumeOriginalOrder(
      {
        id: productIds[0]!,
        confirmation: f.orderNumber,
        requestKey: crypto.randomUUID(),
        expectedProductIds: productIds
      },
      env.ctx
    )

    expect(result.resumedProductIds).toEqual(productIds)
    expect(getOrderOrThrow(f.orderId).status).toBe('confirmed')
    expect(productsFromOrder(f.orderId).map((product) => product.status)).toEqual(['resumed', 'resumed'])
    expect(availableQty(f.materialId)).toBe(stock)
    expectRefusedWithoutResidue(worksheetReversal(f))
    expectRefusedWithoutResidue(() =>
      reverseMaterialConsumption({ id: f.consumption.id, reason: 'resumed output remains physical' }, env.ctx)
    )
  })
})
