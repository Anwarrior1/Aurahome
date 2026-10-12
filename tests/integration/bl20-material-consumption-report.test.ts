import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { approveToOrder } from '../helpers/sales-flow'
import { savePlannedMaterials } from '@main/services/planning/planning.service'
import { issueWorkSheet } from '@main/services/production/production.service'
import { createMaterialReturn, editMaterialReturn, reverseMaterialReturn, getMaterialReturnsOverview } from '@main/services/production/material-returns.service'
import { orderCostBreakdown } from '@main/services/costing/costing.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { buildReport } from '@main/services/reports/reports.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor, money, formatMoney } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay, quantity, formatQuantity } from '@shared/quantity/quantity'

let env: TestEnv
const q = quantityFromDisplay
const m = moneyFromMajor
const report = (from?: string, to?: string) => buildReport({ key: 'material_consumption', from, to })
const count = (table: string) => (getRawConnection().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
const rows = (table: string) => getRawConnection().prepare(`SELECT * FROM ${table} ORDER BY id`).all()
const moneyText = (major: number) => formatMoney(money(m(major)))
const qtyText = (display: number, unit = 'لوحة') => formatQuantity(quantity(q(display)), unit)
const movementHistory = () => getRawConnection().prepare('SELECT kind, qty_micro AS qty, actual_cost_minor AS cost FROM inventory_movements ORDER BY id').all()

function material(name: string, sku: string, unitCost = 100) {
  const categoryId = createCategory({ name: `فئة ${sku}` }, env.ctx)
  const materialId = createMaterial({ sku, name, categoryId, unit: 'لوحة', currentMarketPriceMicro: unitCostFromMajor(unitCost), pricingRule: 'exact' } as never, env.ctx)
  const supplierId = createSupplier({ name: `مورد ${sku}` }, env.ctx)
  createPurchase({ supplierId, lines: [{ materialId, qtyMicro: q(100), unitCostMicro: unitCostFromMajor(unitCost) }] }, env.ctx)
  return materialId
}

function issue(materialId: number, name: string, issued = 10) {
  const customerId = createCustomer({ name: `عميل ${name}` }, env.ctx)
  const invoice = createFinalInvoice({ customerId, lines: [{ lineKind: 'custom', description: `خزانة ${name}`, quantityMicro: q(1), unitPriceMinor: m(1500) }] }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  savePlannedMaterials({ orderId: order.id }, [{ materialId, materialName: name, qtyMicro: q(issued), unit: 'لوحة', estimatedUnitCostMicro: unitCostFromMajor(100) }], env.ctx)
  issueWorkSheet({ orderId: order.id }, env.ctx)
  return order.id
}

function expectRow(name: string, expectedQty: number, expectedCost: number, from?: string, to?: string) {
  const row = report(from, to).rows.find((item) => item['المادة'] === name)
  expect(row).toMatchObject({
    'الكمية المستهلكة فعلياً': qtyText(expectedQty),
    'التكلفة الفعلية': moneyText(expectedCost)
  })
}

beforeEach(() => { env = setupTestDatabase() })
afterEach(() => {
  vi.useRealTimers()
  try {
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  } finally { env.cleanup() }
})

describe('BL-20 material consumption report uses signed movement history', () => {
  it('nets issue, active return, edited return and void without changing the owning ledger', () => {
    const materialId = material('MDF 18mm', 'BL20-MDF')
    const orderId = issue(materialId, 'MDF 18mm')
    expectRow('MDF 18mm', 10, 1000)
    expect(availableQty(materialId)).toBe(q(90))

    const create = { orderId, materialId, quantityMicro: q(4), requestKey: 'bl20-create-once' }
    const returned = createMaterialReturn(create, env.ctx)
    expect(createMaterialReturn(create, env.ctx).id).toBe(returned.id)
    expect(count('material_return_events')).toBe(1)
    expect(availableQty(materialId)).toBe(q(94))
    expect(getMaterialReturnsOverview(orderId).materials[0]).toMatchObject({ netConsumedQtyMicro: q(6), netCostMinor: m(600) })
    expect(orderCostBreakdown(orderId)).toMatchObject({ materialCostMinor: m(600), actualProfitMinor: m(900) })
    expectRow('MDF 18mm', 6, 600)
    expect(report().totals?.['إجمالي تكلفة الاستهلاك']).toBe(moneyText(600))

    const edit = { id: returned.id, quantityMicro: q(2), expectedVersion: returned.version, requestKey: 'bl20-edit-once' }
    const edited = editMaterialReturn(edit, env.ctx)
    expect(editMaterialReturn(edit, env.ctx).id).toBe(edited.id)
    expect(availableQty(materialId)).toBe(q(92))
    expect(orderCostBreakdown(orderId).materialCostMinor).toBe(m(800))
    expectRow('MDF 18mm', 8, 800)

    const reverse = { id: edited.id, expectedVersion: edited.version, requestKey: 'bl20-reverse-once' }
    expect(reverseMaterialReturn(reverse, env.ctx).status).toBe('voided')
    expect(reverseMaterialReturn(reverse, env.ctx).status).toBe('voided')
    expect(count('material_return_events')).toBe(3)
    expect(availableQty(materialId)).toBe(q(90))
    expect(orderCostBreakdown(orderId).materialCostMinor).toBe(m(1000))
    expectRow('MDF 18mm', 10, 1000)
    expect(movementHistory().filter((entry) => (entry as { kind: string }).kind.startsWith('material_return')))
      .toEqual([
        { kind: 'material_return', qty: q(4), cost: -m(400) },
        { kind: 'material_return_reversal', qty: q(2), cost: m(200) },
        { kind: 'material_return_reversal', qty: q(2), cost: m(200) }
      ])
    expect(movementHistory().some((entry) => (entry as { kind: string }).kind === 'consumption')).toBe(true)
    const beforeRead = {
      movements: rows('inventory_movements'), layers: rows('fifo_layers'),
      returns: rows('material_returns'), events: rows('material_return_events'),
      cash: rows('cash_transactions'), payments: rows('customer_payments'),
      workers: rows('worker_transactions'), machines: rows('order_machine_usage'),
      orders: rows('orders'), audit: rows('audit_log')
    }
    expectRow('MDF 18mm', 10, 1000)
    expectRow('MDF 18mm', 10, 1000)
    expect({
      movements: rows('inventory_movements'), layers: rows('fifo_layers'),
      returns: rows('material_returns'), events: rows('material_return_events'),
      cash: rows('cash_transactions'), payments: rows('customer_payments'),
      workers: rows('worker_transactions'), machines: rows('order_machine_usage'),
      orders: rows('orders'), audit: rows('audit_log')
    }).toEqual(beforeRead)
  })

  it('attributes issue, return and return reversal to their own movement dates', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-31T12:00:00.000Z'))
    const materialId = material('بلوط', 'BL20-OAK')
    const orderId = issue(materialId, 'بلوط')
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'))
    const returned = createMaterialReturn({ orderId, materialId, quantityMicro: q(4), requestKey: 'bl20-period-return' }, env.ctx)
    expectRow('بلوط', 10, 1000, '2026-08-31', '2026-08-31')
    expectRow('بلوط', -4, -400, '2026-09-01', '2026-09-01')
    expectRow('بلوط', 6, 600, '2026-08-31', '2026-09-01')
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
    reverseMaterialReturn({ id: returned.id, expectedVersion: returned.version, requestKey: 'bl20-period-void' }, env.ctx)
    expectRow('بلوط', 4, 400, '2026-09-02', '2026-09-02')
    expectRow('بلوط', 6, 600, '2026-08-31', '2026-09-01')
    expectRow('بلوط', 10, 1000, '2026-08-31', '2026-09-02')
  })

  it('aggregates the same material across orders and keeps different materials separate', () => {
    const mdf = material('MDF', 'BL20-MULTI-MDF')
    const oak = material('بلوط', 'BL20-MULTI-OAK', 50)
    const firstOrder = issue(mdf, 'MDF', 10)
    issue(mdf, 'MDF', 5)
    issue(oak, 'بلوط', 3)
    createMaterialReturn({ orderId: firstOrder, materialId: mdf, quantityMicro: q(4), requestKey: 'bl20-multi-return' }, env.ctx)
    expect(report().rows).toHaveLength(2)
    expectRow('MDF', 11, 1100)
    expectRow('بلوط', 3, 150)
    expect(report().totals?.['إجمالي تكلفة الاستهلاك']).toBe(moneyText(1250))
  })

  it('returns the corrected report over authorized IPC and retains both permission gates', async () => {
    const materialId = material('MDF', 'BL20-IPC')
    const orderId = issue(materialId, 'MDF')
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    const asUser = (id: number, permissions: string[]) => {
      const roleId = createRole({ name: `BL20-${id}`, permissions }, env.ctx)
      createUser({ username: `bl20-${id}`, password: 'secret123', fullName: `BL20 ${id}`, roleId }, env.ctx)
      login(`bl20-${id}`, 'secret123', id)
      return { sender: { id } } as IpcMainInvokeEvent
    }
    const viewOnly = asUser(20001, [P.reports.view])
    const reportViewer = asUser(20002, [P.reports.view, P.inventory.valuation])
    const invoke = (channel: string, input: unknown, event: IpcMainInvokeEvent) => handlers.get(channel)!(event, input)
    const returnInput = { orderId, materialId, quantityMicro: q(4), requestKey: 'bl20-ipc-return' }
    const deniedReturn = await invoke(IPC_CHANNELS.production.createMaterialReturn, returnInput, reportViewer)
    expect(deniedReturn.ok).toBe(false)
    if (!deniedReturn.ok) expect(deniedReturn.error.code).toBe('FORBIDDEN')
    expect(count('material_returns')).toBe(0)
    const acceptedReturn = await invoke(IPC_CHANNELS.production.createMaterialReturn, returnInput, { sender: { id: 1 } } as IpcMainInvokeEvent)
    expect(acceptedReturn.ok).toBe(true)
    const request = { key: 'material_consumption', from: '2000-01-01', to: '2999-12-31' }
    const deniedReport = await invoke(IPC_CHANNELS.reports.build, request, viewOnly)
    expect(deniedReport.ok).toBe(false)
    if (!deniedReport.ok) expect(deniedReport.error.code).toBe('FORBIDDEN')
    const acceptedReport = await invoke(IPC_CHANNELS.reports.build, request, reportViewer)
    expect(acceptedReport.ok).toBe(true)
    expect(acceptedReport.ok && acceptedReport.data).toHaveProperty('totals.إجمالي تكلفة الاستهلاك', moneyText(600))
  })

  it('keeps return row, FIFO, stock and audit atomic when an audit insertion fails', () => {
    const materialId = material('MDF', 'BL20-ROLLBACK')
    const orderId = issue(materialId, 'MDF')
    const before = {
      returns: rows('material_returns'), events: rows('material_return_events'),
      movements: rows('inventory_movements'), layers: rows('fifo_layers'),
      allocations: rows('material_return_allocations'), audit: rows('audit_log')
    }
    getRawConnection().exec("CREATE TRIGGER bl20_fail_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'production.materialReturn.create' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")
    expect(() => createMaterialReturn({ orderId, materialId, quantityMicro: q(4), requestKey: 'bl20-retry-audit' }, env.ctx)).toThrow()
    expect({
      returns: rows('material_returns'), events: rows('material_return_events'),
      movements: rows('inventory_movements'), layers: rows('fifo_layers'),
      allocations: rows('material_return_allocations'), audit: rows('audit_log')
    }).toEqual(before)
    expect(availableQty(materialId)).toBe(q(90))
    expectRow('MDF', 10, 1000)
    getRawConnection().exec('DROP TRIGGER bl20_fail_audit')
    createMaterialReturn({ orderId, materialId, quantityMicro: q(4), requestKey: 'bl20-retry-audit' }, env.ctx)
    expectRow('MDF', 6, 600)
    expect(count('material_returns')).toBe(1)
  })
})
