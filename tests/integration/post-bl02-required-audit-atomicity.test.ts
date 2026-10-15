import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { reconcileDatabase } from '@main/db/reconciliation'
import { login } from '@main/auth/auth.service'
import * as admin from '@main/services/admin/users.service'
import * as catalog from '@main/services/catalog/catalog.service'
import * as products from '@main/services/products/products.service'
import * as parties from '@main/services/parties/parties.service'
import * as machines from '@main/services/production/machines.service'
import * as workers from '@main/services/production/workers.service'
import * as invoices from '@main/services/sales/final-invoices.service'
import * as quotations from '@main/services/sales/quotations.service'
import * as orders from '@main/services/sales/orders.service'
import * as inventory from '@main/services/inventory/inventory.service'
import * as purchasing from '@main/services/purchasing/purchasing.service'
import * as expenses from '@main/services/finance/expenses.service'
import * as cash from '@main/services/finance/cash.service'
import * as employees from '@main/services/hr/employees.service'
import * as profit from '@main/services/finance/profit.service'
import * as production from '@main/services/production/production.service'
import * as settings from '@main/services/settings.service'
import type { ServiceContext } from '@main/services/base/service.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'

let env: TestEnv
let sequence = 68000
let handlers: Map<
  string,
  (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>
>
let f: {
  category: number
  type: number
  material: number
  product: number
  machine: number
  worker: number
  customer: number
  supplier: number
  account: number
}
const db = () => getRawConnection()
const key = () => `POSTBL02-${++sequence}`
const scalar = (sql: string, ...args: (string | number)[]) =>
  (
    db()
      .prepare(sql)
      .get(...args) as { value: number }
  ).value
function snapshot() {
  const tables = db()
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as { name: string }[]
  return Object.fromEntries(
    tables.map(({ name }) => [name, db().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
  )
}
function actor(permissions: string[]) {
  const windowId = ++sequence
  const roleId = admin.createRole({ name: key(), permissions }, env.ctx)
  const username = key()
  admin.createUser({ username, password: 'secret123', fullName: 'Operator', roleId }, env.ctx)
  return { windowId, ctx: { session: login(username, 'secret123', windowId).session } }
}
const call = (channel: string, request: unknown, windowId: number) =>
  handlers.get(channel)!({ sender: { id: windowId } } as IpcMainInvokeEvent, request)
const materialInput = () => ({
  sku: key(),
  name: key(),
  categoryId: f.category,
  unit: 'board',
  pricingRule: 'exact' as const,
  currentMarketPriceMicro: c(100)
})
const newMaterial = () => catalog.createMaterial(materialInput(), env.ctx)
const newProduct = () =>
  products.createProduct({ code: key(), name: key(), defaultPriceMinor: m(10000) }, env.ctx)
const draft = () =>
  invoices.createFinalInvoice(
    {
      customerId: f.customer,
      depositPercentBp: 0,
      termIndexes: [],
      lines: [
        {
          lineKind: 'custom',
          description: 'Cabinet',
          quantityMicro: q(1),
          unitPriceMinor: m(10000)
        }
      ]
    },
    env.ctx
  ).id
const quotationInput = () => ({
  customerId: f.customer,
  lines: [
    {
      lineKind: 'custom' as const,
      description: 'Cabinet',
      quantityMicro: q(1),
      unitPriceMinor: m(10000)
    }
  ]
})
const quote = () => quotations.createQuotation(quotationInput(), env.ctx).id
const newSupplier = () => parties.createSupplier({ name: key() }, env.ctx)
const newExpenseCategory = () => expenses.createCategory({ name: key(), kind: 'variable' }, env.ctx)

beforeEach(async () => {
  env = setupTestDatabase()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'))
  const category = catalog.createCategory({ name: key() }, env.ctx)
  const family = catalog.createCategory({ name: key(), parentId: category }, env.ctx)
  const type = catalog.createCategory({ name: key(), parentId: family }, env.ctx)
  f = {
    category,
    type,
    material: 0,
    product: 0,
    machine: 0,
    worker: 0,
    customer: 0,
    supplier: 0,
    account: 0
  }
  f.material = newMaterial()
  f.product = newProduct()
  f.machine = machines.createMachine(
    { name: key(), costingUnit: 'hour', defaultRateMicro: c(10) },
    env.ctx
  )
  f.worker = workers.createWorker({ name: key() }, env.ctx)
  f.customer = parties.createCustomer({ name: key() }, env.ctx)
  f.supplier = newSupplier()
  f.account = cash.createAccount(
    { name: key(), kind: 'cash', openingBalanceMinor: m(10000) },
    env.ctx
  )
  purchasing.createPurchase(
    {
      supplierId: f.supplier,
      lines: [{ materialId: f.material, qtyMicro: q(100), unitCostMicro: c(100) }]
    },
    env.ctx
  )
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi
    .spyOn(electron.ipcMain, 'handle')
    .mockImplementation(((name: string, handler: never) => handlers.set(name, handler)) as never)
  try {
    (await import('@main/ipc/router')).registerIpcRouter()
  } finally {
    spy.mockRestore()
  }
})
afterEach(() => {
  vi.useRealTimers()
  try {
    expect(db().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db().pragma('foreign_key_check')).toEqual([])
  } finally {
    env.cleanup()
  }
})
type Prepared = { request: object; run: (ctx: ServiceContext) => unknown; verify?: () => void }
type Operation = {
  name: string
  action: string
  permission: string
  channel?: string
  retiredIPC?: boolean
  prepare: () => Prepared
}
function manufacturing() {
  const order = approveToOrder(draft(), env.ctx).id
  const sheet = production.issueWorkSheet({ orderId: order }, env.ctx).id
  return { order, sheet }
}
function auditCount(action: string) {
  return scalar('SELECT COUNT(*) AS value FROM audit_log WHERE action=?', action)
}
function inject(action: string) {
  db().exec(
    `CREATE TRIGGER post02_fail BEFORE INSERT ON audit_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT, 'POST02 required audit failure'); END;`
  )
}
function drop() {
  db().exec('DROP TRIGGER post02_fail')
}
const operations: Operation[] = [
  {
    action: 'settings.update',
    name: 'settings.setSettingInternal/public-key',
    permission: P.settings.manage,
    channel: C.settings.set,
    prepare: () => {
      const value = key()
      return {
        request: { key: settings.SETTING_KEYS.companyName, value },
        run: (ctx) => settings.setSettingInternal(settings.SETTING_KEYS.companyName, value, ctx)
      }
    }
  },
  {
    action: 'products.update',
    name: 'products.updateProduct',
    permission: P.products.manage,
    channel: C.products.update,
    prepare: () => {
      const input = { name: key() }
      return {
        request: { id: f.product, ...input },
        run: (ctx) => products.updateProduct(f.product, input, ctx)
      }
    }
  },
  {
    action: 'products.bom.replace',
    name: 'products.replaceBom',
    permission: P.products.manage,
    channel: C.products.setBom,
    prepare: () => {
      const id = newProduct()
      const lines = [{ materialId: f.material, qtyMicro: q(2), unit: 'board' }]
      return {
        request: { productId: id, lines },
        run: (ctx) => products.replaceBom(id, lines, ctx)
      }
    }
  },
  {
    action: 'products.machines.replace',
    name: 'products.replaceProductMachines',
    permission: P.products.manage,
    channel: C.products.setMachines,
    prepare: () => {
      const id = newProduct()
      const lines = [{ machineId: f.machine, usageQtyMicro: q(1) }]
      return {
        request: { productId: id, lines },
        run: (ctx) => products.replaceProductMachines(id, lines, ctx)
      }
    }
  },
  {
    action: 'machines.create',
    name: 'machines.createMachine',
    permission: P.machines.manage,
    channel: C.machines.create,
    prepare: () => {
      const input = { name: key(), costingUnit: 'hour', defaultRateMicro: c(10) }
      return { request: input, run: (ctx) => machines.createMachine(input, ctx) }
    }
  },
  {
    action: 'machines.update',
    name: 'machines.updateMachine',
    permission: P.machines.manage,
    channel: C.machines.update,
    prepare: () => {
      const input = { name: key() }
      return {
        request: { id: f.machine, ...input },
        run: (ctx) => machines.updateMachine(f.machine, input, ctx)
      }
    }
  },
  {
    action: 'machines.delete',
    name: 'machines.deleteMachine',
    permission: P.machines.manage,
    channel: C.machines.remove,
    prepare: () => {
      const id = machines.createMachine(
        { name: key(), costingUnit: 'hour', defaultRateMicro: c(1) },
        env.ctx
      )
      return { request: { id }, run: (ctx) => machines.deleteMachine(id, ctx) }
    }
  },
  {
    action: 'workers.create',
    name: 'workers.createWorker',
    permission: P.workers.manage,
    channel: C.workers.create,
    prepare: () => {
      const input = { name: key() }
      return { request: input, run: (ctx) => workers.createWorker(input, ctx) }
    }
  },
  {
    action: 'workers.update',
    name: 'workers.updateWorker',
    permission: P.workers.manage,
    channel: C.workers.update,
    prepare: () => {
      const input = { name: key() }
      return {
        request: { id: f.worker, ...input },
        run: (ctx) => workers.updateWorker(f.worker, input, ctx)
      }
    }
  },
  {
    action: 'workers.delete',
    name: 'workers.deleteWorker',
    permission: P.workers.manage,
    channel: C.workers.remove,
    prepare: () => {
      const id = workers.createWorker({ name: key() }, env.ctx)
      return { request: { id }, run: (ctx) => workers.deleteWorker(id, ctx) }
    }
  },
  {
    action: 'expenses.category.create',
    name: 'expenses.createCategory',
    permission: P.expenses.manage,
    channel: C.expenses.createCategory,
    prepare: () => {
      const input = { name: key(), kind: 'variable' as const }
      return { request: input, run: (ctx) => expenses.createCategory(input, ctx) }
    }
  },
  {
    action: 'expenses.category.update',
    name: 'expenses.updateCategory',
    permission: P.expenses.manage,
    channel: C.expenses.updateCategory,
    prepare: () => {
      const id = newExpenseCategory()
      const input = { name: key() }
      return { request: { id, ...input }, run: (ctx) => expenses.updateCategory(id, input, ctx) }
    }
  },
  {
    action: 'expenses.category.delete',
    name: 'expenses.deleteCategory',
    permission: P.expenses.manage,
    channel: C.expenses.removeCategory,
    prepare: () => {
      const id = newExpenseCategory()
      return { request: { id }, run: (ctx) => expenses.deleteCategory(id, ctx) }
    }
  },
  {
    action: 'customers.create',
    name: 'parties.createCustomer',
    permission: P.customers.manage,
    channel: C.customers.create,
    prepare: () => {
      const input = { name: key() }
      return { request: input, run: (ctx) => parties.createCustomer(input, ctx) }
    }
  },
  {
    action: 'suppliers.create',
    name: 'parties.createSupplier',
    permission: P.suppliers.manage,
    channel: C.suppliers.create,
    prepare: () => {
      const input = { name: key() }
      return { request: input, run: (ctx) => parties.createSupplier(input, ctx) }
    }
  },
  {
    action: 'suppliers.update',
    name: 'parties.updateSupplier',
    permission: P.suppliers.manage,
    channel: C.suppliers.update,
    prepare: () => {
      const input = { name: key() }
      return {
        request: { id: f.supplier, ...input },
        run: (ctx) => parties.updateSupplier(f.supplier, input, ctx)
      }
    }
  },
  {
    action: 'suppliers.delete',
    name: 'parties.deleteSupplier',
    permission: P.suppliers.manage,
    channel: C.suppliers.remove,
    prepare: () => {
      const id = newSupplier()
      return { request: { id }, run: (ctx) => parties.deleteSupplier(id, ctx) }
    }
  },
  {
    action: 'catalog.material.create',
    name: 'catalog.createMaterial',
    permission: P.materials.manage,
    channel: C.materials.create,
    prepare: () => {
      const input = materialInput()
      return { request: input, run: (ctx) => catalog.createMaterial(input, ctx) }
    }
  },
  {
    action: 'finalInvoices.terms.add',
    name: 'invoices.addFinalInvoiceTerms',
    permission: P.finalInvoices.manage,
    channel: C.finalInvoices.addTerms,
    prepare: () => {
      const id = draft()
      return {
        request: { id, termIndexes: [0] },
        run: (ctx) => invoices.addFinalInvoiceTerms(id, [0], ctx)
      }
    }
  },
  {
    action: 'finalInvoices.terms.remove',
    name: 'invoices.removeFinalInvoiceTerm',
    permission: P.finalInvoices.manage,
    channel: C.finalInvoices.removeTerm,
    prepare: () => {
      const id = draft()
      invoices.addFinalInvoiceTerms(id, [0], env.ctx)
      const termId = invoices.getFinalInvoiceTerms(id)[0]!.id
      return {
        request: { id, termId },
        run: (ctx) => invoices.removeFinalInvoiceTerm(id, termId, ctx)
      }
    }
  },
  {
    action: 'settings.update',
    name: 'settings.setSetting',
    permission: P.settings.manage,
    channel: C.settings.set,
    prepare: () => {
      const value = key()
      return {
        request: { key: settings.SETTING_KEYS.companyName, value },
        run: (ctx) => settings.setSetting(settings.SETTING_KEYS.companyName, value, ctx)
      }
    }
  },
  {
    action: 'quotations.update',
    name: 'quotations.updateQuotation',
    permission: P.quotations.manage,
    channel: C.quotations.update,
    prepare: () => {
      const id = quote()
      const input = { notes: key() }
      return { request: { id, ...input }, run: (ctx) => quotations.updateQuotation(id, input, ctx) }
    }
  },
  {
    action: 'quotations.issue',
    name: 'quotations.issueQuotation',
    permission: P.quotations.issue,
    channel: C.quotations.issue,
    prepare: () => {
      const id = quote()
      return { request: { id }, run: (ctx) => quotations.issueQuotation(id, ctx) }
    }
  },
  {
    action: 'quotations.cancel',
    name: 'quotations.cancelQuotation',
    permission: P.quotations.manage,
    channel: C.quotations.cancel,
    prepare: () => {
      const id = quote()
      return { request: { id }, run: (ctx) => quotations.cancelQuotation(id, ctx) }
    }
  },
  {
    action: 'orders.update',
    name: 'orders.updateOrder',
    permission: P.orders.manage,
    channel: C.orders.update,
    prepare: () => {
      const id = approveToOrder(draft(), env.ctx).id
      const input = { notes: key() }
      return { request: { id, ...input }, run: (ctx) => orders.updateOrder(id, input, ctx) }
    }
  },
  {
    action: 'purchases.full_delete',
    name: 'purchasing.performFullDeletePurchase',
    permission: P.purchases.fullDelete,
    channel: C.purchases.fullDelete,
    prepare: () => {
      const documentNumber = key()
      const id = Number(
        db()
          .prepare(
            "INSERT INTO purchases (document_number, supplier_id, purchase_date, total_minor) VALUES (?, ?, '2026-10-15', 0)"
          )
          .run(documentNumber, f.supplier).lastInsertRowid
      )
      return {
        request: { id, confirmation: documentNumber },
        run: (ctx) => purchasing.performFullDeletePurchase(id, ctx)
      }
    }
  },
  {
    action: 'orders.payment.reverse',
    name: 'orders.reverseCustomerPayment',
    permission: P.cash.fullDelete,
    prepare: () => {
      const orderId = approveToOrder(draft(), env.ctx).id
      orders.recordPayment({ orderId, amountMinor: m(1000), cashAccountId: f.account }, env.ctx)
      const paymentId = scalar(
        'SELECT id AS value FROM customer_payments WHERE order_id = ?',
        orderId
      )
      return {
        request: {},
        run: (ctx) => orders.reverseCustomerPayment(paymentId, ctx),
        verify: () => expect(orders.getOrder(orderId).order.paidMinor).toBe(0)
      }
    }
  },
  {
    name: 'inventory.recordOpeningStock',
    action: 'inventory.openingStock',
    permission: P.inventory.adjust,
    prepare: () => {
      const input = { materialId: f.material, qtyMicro: q(3), unitCostMicro: c(100) }
      return {
        request: input,
        run: (ctx) => inventory.recordOpeningStock(input, ctx),
        verify: () => expect(inventory.availableQty(f.material)).toBe(q(103))
      }
    }
  },
  ...(['in', 'out'] as const).map((direction) => ({
    name: `inventory.adjustStock/${direction}`,
    action: `inventory.adjust_${direction}`,
    permission: P.inventory.adjust,
    channel: C.inventory.adjust,
    prepare: () => {
      const input = {
        materialId: f.material,
        qtyMicro: q(3),
        direction,
        unitCostMicro: c(100),
        reason: 'Audit correction'
      }
      return {
        request: input,
        run: (ctx: ServiceContext) => inventory.adjustStock({ ...input, unitCost: c(100), ctx }),
        verify: () =>
          expect(inventory.availableQty(f.material)).toBe(q(direction === 'in' ? 103 : 97))
      }
    }
  })),
  {
    name: 'workers.assignWorkerToOrder',
    action: 'orders.worker.assign',
    permission: P.worksheets.issue,
    prepare: () => {
      const owner = manufacturing()
      const input = {
        workSheetId: owner.sheet,
        workerId: f.worker,
        method: 'fixed' as const,
        amountMinor: m(50)
      }
      return {
        request: input,
        run: (ctx) => workers.assignWorkerToOrder(input, ctx),
        verify: () =>
          expect(
            scalar(
              'SELECT SUM(amount_minor) AS value FROM order_worker_assignments WHERE work_sheet_id=?',
              owner.sheet
            )
          ).toBe(m(50))
      }
    }
  },
  ...(['update', 'remove'] as const).map((kind) => ({
    name: `workers.${kind}Assignment`,
    action: `orders.worker.${kind}`,
    permission: P.worksheets.issue,
    prepare: () => {
      const owner = manufacturing()
      const id = workers.assignWorkerToOrder(
        { workSheetId: owner.sheet, workerId: f.worker, method: 'fixed', amountMinor: m(50) },
        env.ctx
      ).id
      return {
        request: {},
        run: (ctx: ServiceContext) =>
          kind === 'update'
            ? workers.updateAssignment(id, { amountMinor: m(70) }, ctx)
            : workers.removeAssignment(id, ctx),
        verify: () =>
          expect(
            scalar(
              'SELECT COALESCE(SUM(amount_minor),0) AS value FROM order_worker_assignments WHERE id=?',
              id
            )
          ).toBe(kind === 'update' ? m(70) : 0)
      }
    }
  })),
  {
    name: 'workers.deleteWorker/archive',
    action: 'workers.archive',
    permission: P.workers.manage,
    channel: C.workers.remove,
    prepare: () => {
      const owner = manufacturing()
      workers.assignWorkerToOrder(
        { workSheetId: owner.sheet, workerId: f.worker, method: 'fixed', amountMinor: m(50) },
        env.ctx
      )
      return {
        request: { id: f.worker },
        run: (ctx) => workers.deleteWorker(f.worker, ctx),
        verify: () =>
          expect(scalar('SELECT active AS value FROM workers WHERE id=?', f.worker)).toBe(0)
      }
    }
  },
  {
    name: 'expenses.updateRecurringExpense',
    action: 'expenses.recurring.update',
    permission: P.expenses.manage,
    channel: C.expenses.updateRecurring,
    prepare: () => {
      const id = expenses.createRecurringExpense(
        { description: key(), amountMinor: m(300), startDate: '2026-10-01' },
        env.ctx
      )
      return {
        request: { id, active: false },
        run: (ctx) => expenses.updateRecurringExpense(id, { active: false }, ctx),
        verify: () =>
          expect(
            expenses
              .scheduledRecurringOccurrences('2026-10-01', '2026-10-31')
              .filter((row) => row.recurringExpenseId === id)
          ).toHaveLength(0)
      }
    }
  },
  {
    name: 'employees.updateEmployee',
    action: 'employees.update',
    permission: P.employees.manage,
    channel: C.employees.update,
    prepare: () => {
      const id = employees.createEmployee(
        { name: key(), monthlySalaryMinor: m(1000), hiredAt: '2026-09-01' },
        env.ctx
      )
      const input = { monthlySalaryMinor: m(2000), effectiveFrom: '2026-10-01' }
      return {
        request: { id, ...input },
        run: (ctx) => employees.updateEmployee(id, input, ctx),
        verify: () => {
          expect(scalar('SELECT monthly_salary_minor AS value FROM employees WHERE id=?', id)).toBe(
            m(2000)
          )
          expect(
            scalar('SELECT COUNT(*) AS value FROM employee_salary_history WHERE employee_id=?', id)
          ).toBe(2)
        }
      }
    }
  },
  {
    name: 'products.replaceProductCommission',
    action: 'products.commission.replace',
    permission: P.products.manage,
    channel: C.products.setCommission,
    prepare: () => {
      const lines = [{ workerId: f.worker, amountMinor: m(50) }]
      products.replaceProductCommission(
        f.product,
        [{ workerId: f.worker, amountMinor: m(20) }],
        env.ctx
      )
      return {
        request: { productId: f.product, lines },
        run: (ctx) => products.replaceProductCommission(f.product, lines, ctx),
        verify: () =>
          expect(
            scalar(
              'SELECT SUM(amount_minor) AS value FROM product_commission_lines WHERE product_id=?',
              f.product
            )
          ).toBe(m(50))
      }
    }
  },
  {
    name: 'admin.createUser',
    action: 'users.create',
    permission: P.users.manage,
    channel: C.admin.createUser,
    prepare: () => {
      const input = {
        username: key(),
        password: 'secret123',
        fullName: 'Operator',
        roleId: admin.createRole({ name: key(), permissions: [] }, env.ctx)
      }
      return {
        request: input,
        run: (ctx) => admin.createUser(input, ctx),
        verify: () =>
          expect(
            scalar('SELECT COUNT(*) AS value FROM users WHERE username=?', input.username)
          ).toBe(1)
      }
    }
  },
  ...(['permissions', 'name'] as const).map((kind) => ({
    name: `admin.updateRole/${kind}`,
    action: kind === 'permissions' ? 'roles.permissions.update' : 'roles.update',
    permission: P.roles.manage,
    channel: C.admin.updateRole,
    prepare: () => {
      const id = admin.createRole({ name: key(), permissions: [P.products.manage] }, env.ctx)
      const input = kind === 'permissions' ? { permissions: [] } : { name: key() }
      return {
        request: { id, ...input },
        run: (ctx: ServiceContext) => admin.updateRole(id, input, ctx)
      }
    }
  })),
  {
    name: 'profit.setSavingsRateBp',
    action: 'settings.update',
    permission: P.savings.manage,
    channel: C.profit.setSavingsRate,
    prepare: () => ({
      request: { rateBp: 5000 },
      run: (ctx) => profit.setSavingsRateBp(5000, ctx),
      verify: () => expect(settings.getSavingsRateBp()).toBe(5000)
    })
  },
  {
    name: 'parties.updateCustomer',
    action: 'customers.update',
    permission: P.customers.manage,
    channel: C.customers.update,
    prepare: () => {
      const input = { name: key() }
      return {
        request: { id: f.customer, ...input },
        run: (ctx) => parties.updateCustomer(f.customer, input, ctx)
      }
    }
  },
  {
    name: 'cash.updateAccount',
    action: 'cash.account.update',
    permission: P.cash.manage,
    channel: C.cash.updateAccount,
    prepare: () => {
      const input = { name: key() }
      return {
        request: { id: f.account, ...input },
        run: (ctx) => cash.updateAccount(f.account, input, ctx)
      }
    }
  },
  {
    name: 'cash.deleteAccount',
    action: 'cash.account.delete',
    permission: P.cash.manage,
    channel: C.cash.removeAccount,
    prepare: () => {
      const id = cash.createAccount({ name: key(), kind: 'cash', openingBalanceMinor: 0 }, env.ctx)
      return { request: { id }, run: (ctx) => cash.deleteAccount(id, ctx) }
    }
  }
]

describe('POST-BL-02 required audit atomicity on real migrated SQLite', () => {
  it.each(operations)(
    '$name rejects restricted calls, rolls back required-audit failure, then retries once',
    (operation) => {
      const limited = actor([])
      const allowed = actor(
        operation.name === 'admin.updateRole/permissions'
          ? [operation.permission, P.users.manage]
          : [operation.permission]
      )
      const prepared = operation.prepare()
      const before = snapshot()
      const count = auditCount(operation.action)
      for (let retry = 0; retry < 2; retry++) {
        expect(() => prepared.run(limited.ctx)).toThrowError(
          expect.objectContaining({ code: 'FORBIDDEN' })
        )
        expect(() => withTransaction(() => prepared.run(limited.ctx))).toThrowError(
          expect.objectContaining({ code: 'FORBIDDEN' })
        )
        expect(snapshot()).toEqual(before)
      }
      inject(operation.action)
      try {
        expect(() => prepared.run(env.ctx)).toThrow(/POST02 required audit failure/)
        expect(snapshot()).toEqual(before)
        expect(() => withTransaction(() => prepared.run(env.ctx))).toThrow(
          /POST02 required audit failure/
        )
        expect(snapshot()).toEqual(before)
        // Catching an inner failure must not retain its business writes inside the caller's transaction.
        withTransaction(() => {
          expect(() => prepared.run(env.ctx)).toThrow(/POST02 required audit failure/)
          expect(snapshot()).toEqual(before)
        })
        expect(snapshot()).toEqual(before)
      } finally {
        drop()
      }
      prepared.run(allowed.ctx)
      prepared.verify?.()
      expect(snapshot()).not.toEqual(before)
      expect(auditCount(operation.action)).toBe(count + 1)
      expect(
        db()
          .prepare('SELECT user_id FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1')
          .get(operation.action)
      ).toEqual({ user_id: allowed.ctx.session.user.id })
      expect(reconcileDatabase(db()).findings).toEqual([])
    }
  )
  it.each(operations)(
    '$name and its audit roll back when a caller throws after inner success',
    (operation) => {
      const prepared = operation.prepare()
      const before = snapshot()
      expect(() =>
        withTransaction(() => {
          prepared.run(env.ctx)
          throw new Error('POST02 outer rollback')
        })
      ).toThrow('POST02 outer rollback')
      expect(snapshot()).toEqual(before)
      withTransaction(() => prepared.run(env.ctx))
      prepared.verify?.()
    }
  )
  it.each(operations.filter((operation) => operation.channel && !operation.retiredIPC))(
    '$name registered IPC preserves permission, rollback and successful retry',
    async (operation) => {
      const limited = actor([])
      const allowed = actor(
        operation.name === 'admin.updateRole/permissions'
          ? [operation.permission, P.users.manage]
          : [operation.permission]
      )
      const prepared = operation.prepare()
      const before = snapshot()
      const count = auditCount(operation.action)
      expect(await call(operation.channel!, prepared.request, limited.windowId)).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' }
      })
      expect(snapshot()).toEqual(before)
      inject(operation.action)
      try {
        expect(await call(operation.channel!, prepared.request, allowed.windowId)).toMatchObject({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'حدث خطأ غير متوقع' }
        })
        expect(snapshot()).toEqual(before)
      } finally {
        drop()
      }
      expect(await call(operation.channel!, prepared.request, allowed.windowId)).toMatchObject({
        ok: true
      })
      prepared.verify?.()
      expect(auditCount(operation.action)).toBe(count + 1)
      expect(reconcileDatabase(db()).findings).toEqual([])
    }
  )
  it('inventory 100 → failed -3 leaves 100 → retry leaves 97; FIFO, allocations, cost, movement and audit are atomic', () => {
    const command = () =>
      inventory.adjustStock({
        materialId: f.material,
        qtyMicro: q(3),
        direction: 'out',
        reason: 'Correction',
        ctx: env.ctx
      })
    const before = snapshot()
    inject('inventory.adjust_out')
    try {
      expect(command).toThrow(/POST02 required audit failure/)
      expect(inventory.availableQty(f.material)).toBe(q(100))
      expect(snapshot()).toEqual(before)
    } finally {
      drop()
    }
    command()
    expect(inventory.availableQty(f.material)).toBe(q(97))
    expect(
      db()
        .prepare(
          "SELECT qty_micro, actual_cost_minor FROM inventory_movements WHERE kind='adjustment_out'"
        )
        .all()
    ).toEqual([{ qty_micro: q(3), actual_cost_minor: m(300) }])
    expect(
      scalar(
        'SELECT SUM(qty_remaining_micro) AS value FROM fifo_layers WHERE material_id=?',
        f.material
      )
    ).toBe(q(97))
    expect(auditCount('inventory.adjust_out')).toBe(1)
    expect(reconcileDatabase(db()).findings).toEqual([])
  })
  it('worker retry creates one unearned assignment; normal manufacturing completion earns exactly 50, not 100', () => {
    const owner = manufacturing()
    const command = () =>
      workers.assignWorkerToOrder(
        { workSheetId: owner.sheet, workerId: f.worker, method: 'fixed', amountMinor: m(50) },
        env.ctx
      )
    const before = snapshot()
    inject('orders.worker.assign')
    try {
      expect(command).toThrow(/POST02 required audit failure/)
      expect(snapshot()).toEqual(before)
    } finally {
      drop()
    }
    command()
    expect(scalar('SELECT COUNT(*) AS value FROM order_worker_assignments')).toBe(1)
    expect(workers.workerBalances(f.worker).payableMinor).toBe(0)
    production.startProduction(owner.sheet, env.ctx)
    production.completeProduction(owner.sheet, env.ctx)
    expect(workers.workerBalances(f.worker).payableMinor).toBe(m(50))
    expect(production.productionActualCostMinor(owner.sheet)).toBe(m(50))
    expect(auditCount('orders.worker.assign')).toBe(1)
    // CC04: manufacturing completion earns this commission before customer-order completion.
    expect(production.getWorkSheetOrThrow(owner.sheet).status).toBe('completed')
    expect(orders.getOrder(owner.order).order.status).toBe('confirmed')
    expect(reconcileDatabase(db()).findings).toEqual([])
  })
  it('employee salary/history failure leaves 1000 intact; retry updates once and normal payroll pays only the intended 2000', () => {
    const id = employees.createEmployee(
      { name: key(), monthlySalaryMinor: m(1000), hiredAt: '2026-09-01' },
      env.ctx
    )
    const command = () =>
      employees.updateEmployee(
        id,
        { monthlySalaryMinor: m(2000), effectiveFrom: '2026-10-01' },
        env.ctx
      )
    const before = snapshot()
    inject('employees.update')
    try {
      expect(command).toThrow(/POST02 required audit failure/)
      expect(snapshot()).toEqual(before)
    } finally {
      drop()
    }
    command()
    expect(
      scalar('SELECT COUNT(*) AS value FROM employee_salary_history WHERE employee_id=?', id)
    ).toBe(2)
    const result = employees.paySalary(
      {
        employeeId: id,
        amountMinor: m(2000),
        periodYear: 2026,
        periodMonth: 10,
        cashAccountId: f.account,
        paidAt: '2026-10-28'
      },
      env.ctx
    )
    expect(result.netPaidMinor).toBe(m(2000))
    expect(cash.accountBalance(f.account)).toBe(m(8000))
    expect(auditCount('employees.update')).toBe(1)
    expect(auditCount('employees.paySalary')).toBe(1)
    expect(reconcileDatabase(db()).findings).toEqual([])
  })
})

describe('already atomic sibling controls stay unchanged', () => {
  it.each([false, true])(
    'cash commands and payroll already roll back their audit failures (request key: %s)',
    (keyed) => {
      const destination = cash.createAccount(
        { name: key(), kind: 'cash', openingBalanceMinor: 0 },
        env.ctx
      )
      const employee = employees.createEmployee(
        { name: key(), monthlySalaryMinor: m(1000), hiredAt: '2026-09-01' },
        env.ctx
      )
      const requestKey = () => (keyed ? key() : undefined)
      const cases = [
        {
          action: 'cash.account.create',
          run: () =>
            cash.createAccount(
              { name: key(), kind: 'cash', openingBalanceMinor: 0, requestKey: requestKey() },
              env.ctx
            )
        },
        {
          action: 'cash.account.adjustBalance',
          run: () =>
            cash.adjustAccountBalance(
              {
                accountId: f.account,
                desiredBalanceMinor: m(9900),
                reason: 'Control',
                requestKey: requestKey()
              },
              env.ctx
            )
        },
        {
          action: 'cash.transfer',
          run: () =>
            cash.transfer(
              {
                fromAccountId: f.account,
                toAccountId: destination,
                amountMinor: m(100),
                requestKey: requestKey()
              },
              env.ctx
            )
        },
        {
          action: 'employees.paySalary',
          run: () =>
            employees.paySalary(
              {
                employeeId: employee,
                amountMinor: m(1000),
                periodYear: 2026,
                periodMonth: 10,
                cashAccountId: f.account,
                requestKey: requestKey()
              },
              env.ctx
            )
        }
      ]
      for (const control of cases) {
        const before = snapshot()
        inject(control.action)
        try {
          expect(control.run).toThrow(/POST02 required audit failure/)
          expect(snapshot()).toEqual(before)
        } finally {
          drop()
        }
      }
      expect(reconcileDatabase(db()).findings).toEqual([])
    }
  )
  it('role audit failure does not revoke the existing session; successful permission replacement does', async () => {
    const { getSessionForWebContents } = await import('@main/auth/session')
    const limited = actor([P.products.manage])
    const role = limited.ctx.session.user.roleId
    const before = snapshot()
    inject('roles.permissions.update')
    try {
      expect(() => admin.updateRole(role, { permissions: [] }, env.ctx)).toThrow(
        /POST02 required audit failure/
      )
      expect(snapshot()).toEqual(before)
      expect(getSessionForWebContents(limited.windowId)).toBeDefined()
    } finally {
      drop()
    }
    admin.updateRole(role, { permissions: [] }, env.ctx)
    expect(getSessionForWebContents(limited.windowId)).toBeUndefined()
  })
  it('POST-BL-03 ownership protection preserves the atomic payment source and cash projection', () => {
    const order = approveToOrder(draft(), env.ctx).id
    orders.recordPayment(
      { orderId: order, amountMinor: m(1000), cashAccountId: f.account },
      env.ctx
    )
    const payment = scalar('SELECT id AS value FROM customer_payments WHERE order_id=?', order)
    const before = snapshot()
    expect(() => cash.removeCashMovementForRef('customer_payments', payment)).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' })
    )
    expect(snapshot()).toEqual(before)
    expect(scalar('SELECT COUNT(*) AS value FROM customer_payments WHERE id=?', payment)).toBe(1)
    expect(orders.getOrder(order).order.paidMinor).toBe(m(1000))
    expect(cash.accountBalance(f.account)).toBe(m(11000))
  })
  it('POST-BL-05 reserved savings ownership rejects the former internal alias without mutation', () => {
    const before = snapshot()
    expect(() => settings.setSettingInternal(settings.SETTING_KEYS.savingsRateBp, 15000, env.ctx)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' })
    )
    expect(snapshot()).toEqual(before)
    expect(settings.getSavingsRateBp()).toBe(1000)
    expect(() => profit.setSavingsRateBp(15000, env.ctx)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' })
    )
  })
})

describe('additional inventory and configuration preservation', () => {
  it('outward correction across differently priced FIFO layers restores every allocation on audit failure', () => {
    purchasing.createPurchase(
      {
        supplierId: f.supplier,
        lines: [{ materialId: f.material, qtyMicro: q(20), unitCostMicro: c(200) }]
      },
      env.ctx
    )
    const before = snapshot()
    const command = () =>
      inventory.adjustStock({
        materialId: f.material,
        qtyMicro: q(110),
        direction: 'out',
        reason: 'Two-layer correction',
        ctx: env.ctx
      })
    inject('inventory.adjust_out')
    try {
      expect(command).toThrow(/POST02 required audit failure/)
      expect(snapshot()).toEqual(before)
      expect(inventory.availableQty(f.material)).toBe(q(120))
    } finally {
      drop()
    }
    command()
    expect(inventory.availableQty(f.material)).toBe(q(10))
    expect(
      scalar(
        "SELECT actual_cost_minor AS value FROM inventory_movements WHERE kind='adjustment_out'"
      )
    ).toBe(m(12000))
    expect(scalar('SELECT COUNT(*) AS value FROM fifo_allocations')).toBe(2)
    expect(reconcileDatabase(db()).findings).toEqual([])
  })
  it('BOM replacement restores the old quantity on failure; retry retains unchanged Standard production costing', () => {
    products.replaceBom(
      f.product,
      [{ materialId: f.material, qtyMicro: q(2), unit: 'board' }],
      env.ctx
    )
    const command = () =>
      products.replaceBom(
        f.product,
        [{ materialId: f.material, qtyMicro: q(3), unit: 'board' }],
        env.ctx
      )
    const before = snapshot()
    const count = auditCount('products.bom.replace')
    inject('products.bom.replace')
    try {
      expect(command).toThrow(/POST02 required audit failure/)
      expect(snapshot()).toEqual(before)
    } finally {
      drop()
    }
    command()
    expect(auditCount('products.bom.replace')).toBe(count + 1)
    const result = production.issueStandardStockFromBom(
      { productId: f.product, quantityMicro: q(1), requestKey: key() },
      env.ctx
    )
    expect(result).toMatchObject({ totalCostMinor: m(300) })
    expect(inventory.availableQty(f.material)).toBe(q(97))
    expect(reconcileDatabase(db()).findings).toEqual([])
  })
  it('material-create IPC requires permission and records an authorized assignment', async () => {
    const limited = actor([])
    const input = materialInput()
    const before = snapshot()
    expect(await call(C.materials.create, input, limited.windowId)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' }
    })
    expect(snapshot()).toEqual(before)
    const count = auditCount('catalog.material.create')
    expect(await call(C.materials.create, input, 1)).toMatchObject({ ok: true, data: { id: expect.any(Number) } })
    expect(auditCount('catalog.material.create')).toBe(count + 1)
  })
})
