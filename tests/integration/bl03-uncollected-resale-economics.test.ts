import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { cancelOrder, recordPayment, refundPayment } from '@main/services/sales/orders.service'
import { completeProduction, issueRelease, issueWorkSheet, recordDelivery } from '@main/services/production/production.service'
import { savePlannedMachines, savePlannedMaterials, savePlannedWorkers } from '@main/services/planning/planning.service'
import { createMachine } from '@main/services/production/machines.service'
import { createWorker } from '@main/services/production/workers.service'
import {
  getUncollectedProduct,
  productEconomics,
  productsFromOrder,
  resumeOriginalOrder
} from '@main/services/sales/uncollected-products.service'
import { orderCostBreakdown, orderProfitabilityReport } from '@main/services/costing/costing.service'
import { cumulativeNetProfitMinor, monthlyProfitSummary } from '@main/services/finance/profit.service'
import { createExpense, deleteExpense, updateExpense } from '@main/services/finance/expenses.service'
import { createAccount } from '@main/services/finance/cash.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

let env: TestEnv
let materialId: number
let accountId: number
beforeEach(() => {
  env = setupTestDatabase()
  const categoryId = createCategory({ name: 'BL-03 boards' }, env.ctx)
  materialId = createMaterial({ sku: 'BL03', name: 'MDF', categoryId, unit: 'board', pricingRule: 'exact', currentMarketPriceMicro: c(100) } as never, env.ctx)
  createPurchase({ supplierId: createSupplier({ name: 'BL-03 supplier' }, env.ctx), lines: [{ materialId, qtyMicro: q(1000), unitCostMicro: c(100) }] }, env.ctx)
  accountId = createAccount({ name: 'BL-03 cash', kind: 'cash', openingBalanceMinor: m(100000) }, env.ctx)
})
afterEach(() => {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  env.cleanup()
})

const now = new Date()
const month = () => monthlyProfitSummary(now.getUTCFullYear(), now.getUTCMonth() + 1)

/** Customer order → payments/refunds → Production Preparation → manufacturing → cancellation. */
function cancelledOrder(opts: {
  lines?: number[]
  boards: number
  payments?: number[]
  refunds?: number[]
  prepared?: (orderId: number) => void
}) {
  const invoice = createFinalInvoice({
    customerId: createCustomer({ name: `source ${crypto.randomUUID()}` }, env.ctx),
    depositPercentBp: 0,
    lines: (opts.lines ?? [10000]).map((price, index) => ({ lineKind: 'custom' as const, description: `item ${index + 1}`, quantityMicro: q(1), unitPriceMinor: m(price) }))
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  for (const amount of opts.payments ?? []) recordPayment({ orderId: order.id, amountMinor: m(amount), cashAccountId: accountId }, env.ctx)
  for (const amount of opts.refunds ?? [])
    refundPayment({ orderId: order.id, amountMinor: m(amount), cashAccountId: accountId, requestKey: crypto.randomUUID() }, env.ctx)
  if (opts.boards) savePlannedMaterials({ orderId: order.id }, [{ materialId, materialName: 'MDF', qtyMicro: q(opts.boards) }], env.ctx)
  opts.prepared?.(order.id)
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
  completeProduction(sheet.id, env.ctx)
  const actual = orderCostBreakdown(order.id).totalActualCostMinor
  cancelOrder({ orderId: order.id, reason: 'customer abandoned' }, env.ctx)
  return { order, invoiceId: invoice.id, sheetId: sheet.id, actual, products: productsFromOrder(order.id) }
}

/** New invoice selling the product → approval → full payment → permit → handover (completion). */
function resell(productId: number, price: number) {
  const invoice = createFinalInvoice({
    customerId: createCustomer({ name: `buyer ${crypto.randomUUID()}` }, env.ctx),
    depositPercentBp: 0,
    lines: [{ lineKind: 'custom', description: 'resale', quantityMicro: q(1), unitPriceMinor: m(price), uncollectedProductId: productId }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: m(price), cashAccountId: accountId }, env.ctx)
  const permit = issueRelease({ orderId: order.id, kind: 'delivery' }, env.ctx)
  recordDelivery({ orderId: order.id, releaseId: permit.id, kind: 'handover' }, env.ctx)
  return { order, invoiceId: invoice.id }
}

const economics = (productId: number) => {
  const e = productEconomics(productId)!
  return { actual: e.actualCostMinor, covered: e.customerCoveredMinor, factory: e.factoryBorneMinor, preparation: e.preparationCostMinor }
}

describe('BL-03 — Uncollected Product cost coverage, factory exposure and resale profit', () => {
  it('A: fully covered manufacture → factory-borne 0, resale of 4,000 earns 4,000, actual cost stays 6,000', () => {
    const src = cancelledOrder({ boards: 60, payments: [6000] })
    const product = src.products[0]!
    expect(economics(product.id)).toEqual({ actual: m(6000), covered: m(6000), factory: 0, preparation: 0 })
    const sale = resell(product.id, 4000)
    expect(orderCostBreakdown(sale.order.id).actualProfitMinor).toBe(m(4000))
    expect(getUncollectedProduct(product.id).resaleProfitMinor).toBe(m(4000))
    expect(economics(product.id).actual).toBe(m(6000))
  })

  it('B/C: partial coverage → factory-borne 2,000; resale 5,000 earns 3,000, and 2,500 after a 500 preparation cost', () => {
    const b = cancelledOrder({ boards: 80, payments: [6000] })
    expect(economics(b.products[0]!.id)).toEqual({ actual: m(8000), covered: m(6000), factory: m(2000), preparation: 0 })
    expect(orderCostBreakdown(resell(b.products[0]!.id, 5000).order.id).actualProfitMinor).toBe(m(3000))

    const cc = cancelledOrder({ boards: 80, payments: [6000] })
    const product = cc.products[0]!.id
    const generalBefore = month().generalExpensesMinor
    createExpense({ amountMinor: m(500), description: 'repaint', uncollectedProductId: product, cashAccountId: accountId }, env.ctx)
    expect(economics(product)).toEqual({ actual: m(8000), covered: m(6000), factory: m(2000), preparation: m(500) })
    expect(month().generalExpensesMinor).toBe(generalBefore) // not an operating expense
    const sale = resell(product, 5000)
    const cost = orderCostBreakdown(sale.order.id)
    expect(cost.actualProfitMinor).toBe(m(2500))
    expect([cost.materialCostMinor, cost.linkedExpensesMinor]).toEqual([m(2000), m(500)])
    expect(getUncollectedProduct(product).resaleProfitMinor).toBe(m(2500))
  })

  it('D: retained money above cost covers the cost only — never negative factory cost, never 8,000 coverage', () => {
    const src = cancelledOrder({ boards: 60, payments: [8000] })
    expect(economics(src.products[0]!.id)).toEqual({ actual: m(6000), covered: m(6000), factory: 0, preparation: 0 })
  })

  it('E: nothing retained → factory bears 6,000; resale 8,000 earns 2,000', () => {
    const src = cancelledOrder({ boards: 60 })
    expect(economics(src.products[0]!.id)).toEqual({ actual: m(6000), covered: 0, factory: m(6000), preparation: 0 })
    expect(orderCostBreakdown(resell(src.products[0]!.id, 8000).order.id).actualProfitMinor).toBe(m(2000))
  })

  it('F/G: refunded money never covers cost; several receipts and refunds net to the live retained amount', () => {
    const f = cancelledOrder({ boards: 60, payments: [6000], refunds: [6000] })
    expect(economics(f.products[0]!.id)).toMatchObject({ covered: 0, factory: m(6000) })
    const g = cancelledOrder({ boards: 60, payments: [2000, 3000], refunds: [1000] })
    expect(economics(g.products[0]!.id)).toMatchObject({ covered: m(4000), factory: m(2000) })
  })

  it('H: multi-line order — each line keeps its cost share, coverage is split without duplication and reconciles', () => {
    const src = cancelledOrder({ lines: [6000, 4000], boards: 80, payments: [6000] })
    const [first, second] = src.products.map((p) => economics(p.id))
    expect([first!.actual, second!.actual]).toEqual([m(4800), m(3200)])
    expect([first!.covered, second!.covered]).toEqual([m(3600), m(2400)])
    expect(first!.covered + second!.covered).toBe(m(6000))
    expect(first!.actual + second!.actual).toBe(src.actual)
    expect(first!.factory + second!.factory).toBe(src.actual - m(6000))
    for (const e of [first!, second!]) expect(e.covered).toBeLessThanOrEqual(e.actual)
  })

  it('I: retries never duplicate the product, its coverage, preparation cost, revenue or cost of goods', () => {
    const src = cancelledOrder({ boards: 80, payments: [6000] })
    const product = src.products[0]!.id
    expect(() => cancelOrder({ orderId: src.order.id, reason: 'again' }, env.ctx)).toThrow()
    expect(productsFromOrder(src.order.id)).toHaveLength(1)
    createExpense({ amountMinor: m(500), description: 'repair', uncollectedProductId: product, requestKey: 'bl03-prep-once' }, env.ctx)
    createExpense({ amountMinor: m(500), description: 'repair', uncollectedProductId: product, requestKey: 'bl03-prep-once' }, env.ctx)
    expect(economics(product).preparation).toBe(m(500))
    const sale = resell(product, 5000)
    expect(approveFinalInvoice(sale.invoiceId, env.ctx).alreadyApproved).toBe(true)
    const summary = month()
    expect(summary.revenueMinor).toBe(m(5000))
    expect(summary.netProfitMinor).toBe(m(2500))
    expect(orderProfitabilityReport({ completedOnly: true }).find((row) => row.orderId === sale.order.id)!.actualProfitMinor).toBe(m(2500))
    expect(cumulativeNetProfitMinor()).toBe(m(2500))
    // After the sale the preparation cost is historical cost of goods.
    const expenseId = (getRawConnection().prepare('SELECT id FROM expenses WHERE uncollected_product_id = ?').get(product) as { id: number }).id
    expect(() => updateExpense(expenseId, { amountMinor: m(1) }, env.ctx)).toThrow(/تم بيعه/)
    expect(() => deleteExpense(expenseId, env.ctx)).toThrow(/تم بيعه/)
    expect(() => createExpense({ amountMinor: m(1), description: 'late', uncollectedProductId: product }, env.ctx)).toThrow(/تم بيعه/)
    expect(() => resell(product, 5000)).toThrow(/تم بيعه/)
  })

  it('J: whole-order resumption moves preparation cost to the source order; a later cancellation refreshes the cost basis', () => {
    const src = cancelledOrder({ lines: [6000, 4000], boards: 80, payments: [6000] })
    const ids = src.products.map((p) => p.id)
    createExpense({ amountMinor: m(300), description: 'touch-up', uncollectedProductId: ids[0] }, env.ctx)
    resumeOriginalOrder({ id: ids[0]!, confirmation: src.order.documentNumber, requestKey: crypto.randomUUID(), expectedProductIds: ids }, env.ctx)
    // No resale charges exist; the source order carries its own manufacture plus the preparation exactly once.
    expect(orderCostBreakdown(src.order.id).totalActualCostMinor).toBe(src.actual + m(300))
    createExpense({ amountMinor: m(1000), description: 'late order cost', orderId: src.order.id }, env.ctx)
    cancelOrder({ orderId: src.order.id, reason: 'abandoned again' }, env.ctx)
    expect(productsFromOrder(src.order.id)).toHaveLength(2)
    const refreshed = ids.map((id) => economics(id))
    expect(refreshed[0]!.actual + refreshed[1]!.actual).toBe(src.actual + m(1000))
    expect(refreshed[0]!.preparation).toBe(m(300))
    expect(orderCostBreakdown(src.order.id).linkedExpensesMinor).toBe(m(1000)) // preparation back on the product
  })

  it('K: consumes the Package 04/04B actual cost — material + machine + worker commission', () => {
    const machine = createMachine({ name: 'CNC', costingUnit: 'hour', defaultRateMicro: c(500) }, env.ctx)
    const worker = createWorker({ name: 'Mohamed' }, env.ctx)
    const src = cancelledOrder({
      boards: 30,
      payments: [6000],
      prepared: (orderId) => {
        savePlannedMachines({ orderId }, [{ machineId: machine, machineName: 'CNC', usageQtyMicro: q(2), usageUnit: 'hour' }], env.ctx)
        savePlannedWorkers({ orderId }, [{ workerId: worker, workerName: 'Mohamed', estimatedCostMinor: m(2000) }], env.ctx)
      }
    })
    expect(src.actual).toBe(m(6000))
    const row = getRawConnection().prepare('SELECT * FROM uncollected_products WHERE id = ?').get(src.products[0]!.id) as Record<string, number>
    expect([row.cost_basis_material_minor, row.cost_basis_machine_minor, row.cost_basis_worker_minor]).toEqual([m(3000), m(1000), m(2000)])
    expect(economics(src.products[0]!.id)).toMatchObject({ actual: m(6000), covered: m(6000), factory: 0 })
  })

  it('L: resale never touches FIFO — material issue cost and stock stay exactly as manufactured', () => {
    const src = cancelledOrder({ boards: 80, payments: [6000] })
    const issues = getRawConnection().prepare('SELECT * FROM order_material_lines ORDER BY id').all()
    const layers = getRawConnection().prepare('SELECT * FROM fifo_layers ORDER BY id').all()
    const stock = availableQty(materialId)
    resell(src.products[0]!.id, 5000)
    expect(getRawConnection().prepare('SELECT * FROM order_material_lines ORDER BY id').all()).toEqual(issues)
    expect(getRawConnection().prepare('SELECT * FROM fifo_layers ORDER BY id').all()).toEqual(layers)
    expect(availableQty(materialId)).toBe(stock)
  })

  it('unattributable legacy cost is never sold with a silent zero cost', () => {
    const src = cancelledOrder({ boards: 60 })
    getRawConnection().prepare("UPDATE uncollected_products SET cost_basis_method = 'unattributable', cost_basis_minor = 0 WHERE id = ?").run(src.products[0]!.id)
    expect(productEconomics(src.products[0]!.id)!.known).toBe(false)
    expect(() => resell(src.products[0]!.id, 5000)).toThrow(/غير قابلة للنسب/)
  })
})

describe('BL-03 — visibility, IPC and UI', () => {
  let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
  let windowId = 90300
  beforeEach(async () => {
    handlers = new Map()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
  })
  function session(permissions: string[]) {
    windowId += 1
    const roleId = createRole({ name: `BL03 ${windowId}`, permissions }, env.ctx)
    createUser({ username: `bl03-${windowId}`, fullName: 'BL03', password: 'secret123', roleId }, env.ctx)
    login(`bl03-${windowId}`, 'secret123', windowId)
    return { sender: { id: windowId } } as IpcMainInvokeEvent
  }

  it('economics reach cost viewers only; preparation cost requires expenses.manage', async () => {
    const product = cancelledOrder({ boards: 80, payments: [6000] }).products[0]!.id
    const viewer = session([P.uncollectedProducts.view])
    const hidden = await handlers.get(C.uncollectedProducts.get)!(viewer, { id: product }) as IpcResult<Record<string, unknown>>
    expect(hidden.ok && ['economics', 'preparationCosts', 'resaleProfitMinor', 'costBasisMinor'].some((key) => key in hidden.data)).toBe(false)
    const costViewer = session([P.uncollectedProducts.view, P.uncollectedProducts.viewCost])
    const shown = await handlers.get(C.uncollectedProducts.get)!(costViewer, { id: product }) as IpcResult<{ economics: object }>
    expect(shown.ok && shown.data.economics).toMatchObject({ actualCostMinor: m(8000), customerCoveredMinor: m(6000), factoryBorneMinor: m(2000) })
    const denied = await handlers.get(C.expenses.create)!(costViewer, { amountMinor: m(1), description: 'x', uncollectedProductId: product, requestKey: 'bl03-denied-key' })
    expect(denied).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const manager = session([P.expenses.manage])
    expect(await handlers.get(C.expenses.create)!(manager, { amountMinor: m(1), description: 'x', uncollectedProductId: product, requestKey: 'bl03-allowed-key' })).toMatchObject({ ok: true })
  })

  it('M/N: the Uncollected Product screen shows the breakdown; Order Details keeps Package 05 without the removed card', () => {
    const page = readFileSync('src/renderer/pages/uncollected/UncollectedProductsPage.tsx', 'utf8')
    for (const label of ['التكلفة الفعلية للتصنيع', 'مغطى من الزبون', 'متحملها المصنع', 'تكلفة إضافية قبل إعادة البيع', 'سعر إعادة البيع', 'ربح إعادة البيع'])
      expect(page).toContain(label)
    expect(page).toContain('uncollectedProductId: item.id')
    expect(readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')).not.toContain('التكلفة والربح الفعلي')
  })
})
