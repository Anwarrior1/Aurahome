import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { reconcileDatabase } from '@main/db/reconciliation'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createProduct } from '@main/services/products/products.service'
import { createWorker } from '@main/services/production/workers.service'
import { createMachine } from '@main/services/production/machines.service'
import * as invoices from '@main/services/sales/final-invoices.service'
import * as planning from '@main/services/planning/planning.service'
import * as production from '@main/services/production/production.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import type { ServiceContext } from '@main/services/base/service.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
const db = () => getRawConnection()
const n = (query: string, ...args: (number | string)[]) =>
  (
    db()
      .prepare(query)
      .get(...args) as { n: number }
  ).n
const seeders = [
  'seedOrderProductionConfig',
  'seedWorkSheetMaterials',
  'seedWorkSheetMachines',
  'seedWorkSheetWorkers',
  'seedWorkSheetOrderExpenses'
] as const
function snapshot() {
  return Object.fromEntries(
    (
      db()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all() as { name: string }[]
    ).map(({ name }) => [name, db().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
  )
}
function actor(name: string, permissions: string[], windowId: number): ServiceContext {
  const roleId = createRole({ name, permissions }, env.ctx)
  createUser({ username: name, fullName: name, password: 'secret123', roleId }, env.ctx)
  return { session: login(name, 'secret123', windowId).session }
}
beforeEach(() => {
  env = setupTestDatabase()
})
afterEach(() => {
  try {
    expect(db().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db().pragma('foreign_key_check')).toEqual([])
  } finally {
    env.cleanup()
  }
})
function fixture(boards = 2, extra = false) {
  const material = createMaterial(
    {
      sku: 'BOARD',
      name: 'Board',
      unit: 'board',
      pricingRule: 'exact',
      categoryId: createCategory({ name: 'Boards' }, env.ctx),
      currentMarketPriceMicro: c(100)
    },
    env.ctx
  )
  createPurchase(
    {
      supplierId: createSupplier({ name: 'Supplier' }, env.ctx),
      lines: [{ materialId: material, qtyMicro: q(100), unitCostMicro: c(100) }]
    },
    env.ctx
  )
  const worker = createWorker({ name: 'Named worker' }, env.ctx)
  const machine = extra
    ? createMachine({ name: 'Saw', costingUnit: 'hour', defaultRateMicro: c(20) }, env.ctx)
    : undefined
  const product = createProduct(
    {
      code: 'CABINET',
      name: 'Cabinet',
      bom: [{ materialId: material, qtyMicro: q(boards), unit: 'board' }],
      commission: [{ workerId: worker, amountMinor: m(50) }],
      machines: machine ? [{ machineId: machine, usageQtyMicro: q(1) }] : []
    },
    env.ctx
  )
  const invoice = invoices.createFinalInvoice(
    {
      customerId: createCustomer({ name: 'Customer' }, env.ctx),
      depositPercentBp: 0,
      lines: [
        {
          lineKind: 'custom',
          productId: product,
          description: 'Cabinet',
          quantityMicro: q(1),
          unitPriceMinor: m(10000)
        }
      ]
    },
    env.ctx
  )
  return { material, worker, product, invoice: invoice.id }
}
function approve(f: ReturnType<typeof fixture>, ctx = env.ctx) {
  return invoices.approveFinalInvoice(f.invoice, ctx).orderId
}
function complete(order: number, ctx = env.ctx) {
  const sheet = production.issueWorkSheet({ orderId: order }, ctx)
  production.startProduction(sheet.id, ctx)
  production.completeProduction(sheet.id, ctx)
  return sheet.id
}
function plans(parent: 'order_id' | 'work_sheet_id', id: number) {
  return Object.fromEntries(
    ['planned_materials', 'planned_machines', 'planned_workers', 'planned_order_expenses'].map(
      (table) => [
        table,
        db().prepare(`SELECT * FROM ${table} WHERE ${parent}=? ORDER BY id`).all(id)
      ]
    )
  )
}
function noExports() {
  for (const name of seeders)
    for (const mod of [planning, invoices, production]) expect(Object.keys(mod)).not.toContain(name)
}
function independent(name: string, args: unknown[], ctx: ServiceContext) {
  const fn = (planning as unknown as Record<string, (...input: unknown[]) => unknown>)[name]
  return fn(...args, ctx)
}
function reconciliation() {
  const result = reconcileDatabase(db())
  // CC04: legitimate manufacturing commissions must have no reconciliation findings.
  expect(result.findings.map((f) => f.code)).toEqual([])
}

describe('POST-BL-04 private lifecycle seed ownership', () => {
  it.each(seeders)('%s has only private lifecycle owners, no export or public alias', (name) => {
    noExports()
    const file =
      name === 'seedOrderProductionConfig'
        ? 'src/main/services/sales/final-invoices.service.ts'
        : 'src/main/services/production/production.service.ts'
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const owners: string[] = []
    const declarations: ts.FunctionDeclaration[] = []
    function walk(node: ts.Node, owner = '') {
      if (ts.isFunctionDeclaration(node)) {
        owner = node.name?.text ?? owner
        if (owner === name) declarations.push(node)
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === name
      )
        owners.push(owner)
      ts.forEachChild(node, (child) => walk(child, owner))
    }
    walk(source)
    expect(declarations).toHaveLength(1)
    expect(
      declarations[0].modifiers?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword) ?? false
    ).toBe(false)
    expect(owners).toEqual(
      name === 'seedOrderProductionConfig'
        ? ['createOrderFromApprovedInvoice']
        : name === 'seedWorkSheetOrderExpenses'
          ? ['issueWorkSheet']
          : ['issueWorkSheet', 'issueStandardStockFromBom']
    )
  })

  for (const stage of ['approved', 'issued', 'started', 'completed'])
    it.each(seeders)(
      '%s independent replay is inaccessible at ' +
        stage +
        ' for permission-bearing user and Admin',
      (name) => {
        const f = fixture(2, true)
        const order = approve(f)
        planning.savePlannedOrderExpenses(
          order,
          [{ expenseName: 'Preparation', amountMinor: m(30) }],
          env.ctx
        )
        const operator = actor(
          'operator',
          [
            P.productionPrep.manage,
            P.orders.view,
            P.worksheets.issue,
            P.inventory.consume,
            P.finalInvoices.approve
          ],
          74001
        )
        let sheet = 999999
        if (stage !== 'approved') sheet = production.issueWorkSheet({ orderId: order }, env.ctx).id
        if (stage === 'started' || stage === 'completed') production.startProduction(sheet, env.ctx)
        if (stage === 'completed') production.completeProduction(sheet, env.ctx)
        const args =
          name === 'seedOrderProductionConfig'
            ? [order]
            : name === 'seedWorkSheetOrderExpenses'
              ? [sheet, order]
              : [{ workSheetId: sheet, orderId: order }]
        const before = snapshot()
        for (const ctx of [operator, env.ctx])
          for (const transaction of [false, true])
            for (let retry = 0; retry < 2; retry++) {
              expect(() =>
                transaction
                  ? withTransaction(() => independent(name, args, ctx))
                  : independent(name, args, ctx)
              ).toThrow(TypeError)
              expect(snapshot()).toEqual(before)
            }
        noExports()
        reconciliation()
      }
    )

  it('normal approval/issuance/completion consumes 2, stock 98, material 200, commission 50, cost 250 exactly once', () => {
    const f = fixture()
    const order = approve(f)
    expect(plans('order_id', order).planned_materials).toHaveLength(1)
    expect(plans('order_id', order).planned_workers).toHaveLength(1)
    expect(n("SELECT COUNT(*) AS n FROM worker_transactions WHERE kind='earning'")).toBe(0)
    const before = snapshot()
    expect(invoices.approveFinalInvoice(f.invoice, env.ctx).alreadyApproved).toBe(true)
    expect(snapshot()).toEqual(before)
    const sheet = complete(order)
    expect(availableQty(f.material)).toBe(q(98))
    expect(
      n('SELECT SUM(actual_cost_minor) AS n FROM order_material_lines WHERE work_sheet_id=?', sheet)
    ).toBe(m(200))
    expect(n("SELECT SUM(amount_minor) AS n FROM worker_transactions WHERE kind='earning'")).toBe(
      m(50)
    )
    expect(n('SELECT COUNT(*) AS n FROM order_worker_assignments WHERE earned=1')).toBe(1)
    expect(production.productionActualCostMinor(sheet)).toBe(m(250))
    const final = snapshot()
    expect(() => production.issueWorkSheet({ orderId: order }, env.ctx)).toThrow()
    expect(() => production.completeProduction(sheet, env.ctx)).toThrow()
    expect(snapshot()).toEqual(final)
    for (const action of ['finalInvoices.approve', 'worksheets.issue', 'worksheets.complete'])
      expect(n('SELECT COUNT(*) AS n FROM audit_log WHERE action=?', action)).toBe(1)
    reconciliation()
  })
  it('completed 10-board worksheet preserves every plan and actual/FIFO evidence against public edits', () => {
    const f = fixture(10, true)
    const order = approve(f)
    planning.savePlannedOrderExpenses(
      order,
      [{ expenseName: 'Preparation', amountMinor: m(30) }],
      env.ctx
    )
    const sheet = complete(order)
    const before = snapshot()
    for (const scope of [{ orderId: order }, { workSheetId: sheet }]) {
      expect(() => planning.savePlannedMaterials(scope, [], env.ctx)).toThrow()
      expect(() => planning.savePlannedMachines(scope, [], env.ctx)).toThrow()
      expect(() => planning.savePlannedWorkers(scope, [], env.ctx)).toThrow()
      expect(snapshot()).toEqual(before)
    }
    expect(() => planning.savePlannedOrderExpenses(order, [], env.ctx)).toThrow()
    expect(snapshot()).toEqual(before)
    expect(
      n('SELECT SUM(qty_micro) AS n FROM planned_materials WHERE work_sheet_id=?', sheet)
    ).toBe(q(10))
    for (const rows of Object.values(plans('work_sheet_id', sheet))) expect(rows).toHaveLength(1)
    expect(availableQty(f.material)).toBe(q(90))
    expect(production.productionActualCostMinor(sheet)).toBe(m(1070))
    expect(n('SELECT SUM(final_amount_minor) AS n FROM order_machine_usage')).toBe(m(20))
    reconciliation()
  })
  it('unapproval/reapproval retains an edited order plan without re-seeding templates', () => {
    const f = fixture()
    const order = approve(f)
    planning.savePlannedMaterials(
      { orderId: order },
      [
        {
          materialId: f.material,
          materialName: 'Board',
          qtyMicro: q(3),
          unit: 'board',
          estimatedUnitCostMicro: c(100)
        }
      ],
      env.ctx
    )
    const before = plans('order_id', order)
    invoices.unapproveFinalInvoice({ id: f.invoice, expectedRevision: 1 }, env.ctx)
    expect(invoices.approveFinalInvoice(f.invoice, env.ctx, 1).orderId).toBe(order)
    expect(plans('order_id', order)).toEqual(before)
    const sheet = complete(order)
    expect(availableQty(f.material)).toBe(q(97))
    expect(production.productionActualCostMinor(sheet)).toBe(m(350))
    reconciliation()
  })
  it('Standard production owner seeds once and idempotent retry creates no duplicate FG or plan', () => {
    const f = fixture(2, true)
    const input = { productId: f.product, quantityMicro: q(1), requestKey: 'post04-standard' }
    const result = production.issueStandardStockFromBom(input, env.ctx)
    expect(result.totalCostMinor).toBe(m(270))
    expect(availableQty(f.material)).toBe(q(98))
    for (const table of ['planned_materials', 'planned_machines', 'planned_workers'])
      expect(
        n(`SELECT COUNT(*) AS n FROM ${table} WHERE work_sheet_id=?`, result.workSheetId)
      ).toBe(1)
    expect(n("SELECT COUNT(*) AS n FROM worker_transactions WHERE kind='earning'")).toBe(1)
    const before = snapshot()
    expect(production.issueStandardStockFromBom(input, env.ctx)).toEqual(result)
    expect(snapshot()).toEqual(before)
    expect(n("SELECT COUNT(*) AS n FROM audit_log WHERE action='products.issueStockFromBom'")).toBe(
      1
    )
    reconciliation()
  })

  it.each(
    [
      'orders.create',
      'finalInvoices.approve',
      'planned_materials',
      'worksheets.issue',
      'products.issueStockFromBom'
    ].flatMap((action) => [false, true].map((caller) => ({ action, caller })))
  )(
    'owner failure at $action (caller transaction=$caller) rolls back seed, parent, FIFO and audit; retry seeds once',
    ({ action, caller }) => {
      const f = fixture()
      const order =
        action === 'worksheets.issue' || action === 'planned_materials' ? approve(f) : undefined
      const before = snapshot()
      const isTable = action === 'planned_materials'
      db().exec(
        isTable
          ? "CREATE TEMP TRIGGER post04_fail BEFORE INSERT ON planned_materials WHEN NEW.work_sheet_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'POST04 injected failure'); END"
          : `CREATE TEMP TRIGGER post04_fail BEFORE INSERT ON audit_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT, 'POST04 injected failure'); END`
      )
      const command = () =>
        order
          ? production.issueWorkSheet({ orderId: order }, env.ctx)
          : action === 'products.issueStockFromBom'
            ? production.issueStandardStockFromBom(
                { productId: f.product, quantityMicro: q(1), requestKey: 'post04-failure' },
                env.ctx
              )
            : invoices.approveFinalInvoice(f.invoice, env.ctx)
      try {
        if (caller)
          withTransaction(() => {
            expect(command).toThrow(/POST04 injected failure/)
          })
        else expect(command).toThrow(/POST04 injected failure/)
        expect(snapshot()).toEqual(before)
      } finally {
        db().exec('DROP TRIGGER post04_fail')
      }
      command()
      const parent = order
        ? 'work_sheet_id'
        : action === 'products.issueStockFromBom'
          ? 'work_sheet_id'
          : 'order_id'
      expect(n(`SELECT COUNT(*) AS n FROM planned_materials WHERE ${parent} IS NOT NULL`)).toBe(1)
      expect(n("SELECT COUNT(*) AS n FROM worker_transactions WHERE kind='earning'")).toBe(
        action === 'products.issueStockFromBom' ? 1 : 0
      )
      expect(
        n(
          'SELECT COUNT(*) AS n FROM audit_log WHERE action=?',
          isTable ? 'worksheets.issue' : action
        )
      ).toBe(1)
      reconciliation()
    }
  )
  it.each(['approval', 'issuance', 'standard'])(
    'outer rollback removes inner %s plan and required audit',
    (owner) => {
      const f = fixture()
      const order = owner === 'issuance' ? approve(f) : undefined
      const before = snapshot()
      expect(() =>
        withTransaction(() => {
          if (owner === 'approval') approve(f)
          else if (owner === 'issuance') production.issueWorkSheet({ orderId: order! }, env.ctx)
          else
            production.issueStandardStockFromBom(
              { productId: f.product, quantityMicro: q(1), requestKey: 'post04-outer' },
              env.ctx
            )
          throw new Error('forced outer rollback')
        })
      ).toThrow('forced outer rollback')
      expect(snapshot()).toEqual(before)
      reconciliation()
    }
  )
  it('safe worksheet reversal permits fresh issuance with one new snapshot and no overconsumption', () => {
    const f = fixture()
    const order = approve(f)
    const first = production.issueWorkSheet({ orderId: order }, env.ctx)
    const detail = production.getProductionOrder(first.id)
    production.reverseWorkSheet(
      {
        id: first.id,
        expectedToken: detail.reversalToken,
        confirmation: detail.sheet.documentNumber,
        reason: 'Correct issuance'
      },
      env.ctx
    )
    expect(availableQty(f.material)).toBe(q(100))
    const oldPlan = plans('work_sheet_id', first.id)
    const next = production.issueWorkSheet({ orderId: order }, env.ctx)
    expect(next.id).not.toBe(first.id)
    expect(plans('work_sheet_id', first.id)).toEqual(oldPlan)
    expect(plans('work_sheet_id', next.id).planned_materials).toHaveLength(1)
    expect(availableQty(f.material)).toBe(q(98))
    production.completeProduction(next.id, env.ctx)
    expect(production.productionActualCostMinor(next.id)).toBe(m(250))
    reconciliation()
  })
  it('cancelled worksheet does not authorize another issuance or independent seed replay', () => {
    const f = fixture()
    const order = approve(f)
    const sheet = production.issueWorkSheet({ orderId: order }, env.ctx)
    production.cancelProductionOrder({ id: sheet.id, reason: 'Cancel before start' }, env.ctx)
    const before = snapshot()
    expect(() => production.issueWorkSheet({ orderId: order }, env.ctx)).toThrow()
    for (const name of seeders)
      expect(() =>
        withTransaction(() =>
          independent(
            name,
            name === 'seedOrderProductionConfig'
              ? [order]
              : name === 'seedWorkSheetOrderExpenses'
                ? [sheet.id, order]
                : [{ workSheetId: sheet.id, orderId: order }],
            env.ctx
          )
        )
      ).toThrow(TypeError)
    expect(snapshot()).toEqual(before)
    reconciliation()
  })
  it('real permission-bearing service owners work; restricted owner calls remain FORBIDDEN', () => {
    const f = fixture()
    const restricted = actor('restricted', [], 74002)
    const operator = actor(
      'operator',
      [P.finalInvoices.approve, P.worksheets.issue, P.inventory.consume],
      74003
    )
    const before = snapshot()
    expect(() => approve(f, restricted)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(snapshot()).toEqual(before)
    const order = approve(f, operator)
    const approved = snapshot()
    expect(() =>
      withTransaction(() => production.issueWorkSheet({ orderId: order }, restricted))
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(snapshot()).toEqual(approved)
    const sheet = complete(order, operator)
    expect(production.productionActualCostMinor(sheet)).toBe(m(250))
    reconciliation()
  })
  it('registered owners preserve permissions, rollback audit failure and seed once on retry; seed IPC does not exist', async () => {
    const f = fixture()
    actor('restricted', [], 74004)
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
    >()
    const electron = await import('electron')
    const spy = vi
      .spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel: string, handler: never) =>
        handlers.set(channel, handler)) as never)
    try {
      (await import('@main/ipc/router')).registerIpcRouter()
    } finally {
      spy.mockRestore()
    }
    const invoke = (channel: string, input: unknown, windowId = 1) =>
      handlers.get(channel)!({ sender: { id: windowId } } as IpcMainInvokeEvent, input)
    expect([...handlers.keys()].filter((x) => /seed/i.test(x))).toEqual([])
    const before = snapshot()
    expect(await invoke(C.finalInvoices.approve, { id: f.invoice }, 74004)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' }
    })
    expect(snapshot()).toEqual(before)
    db().exec(
      "CREATE TEMP TRIGGER post04_ipc BEFORE INSERT ON audit_log WHEN NEW.action='finalInvoices.approve' BEGIN SELECT RAISE(ABORT, 'POST04 IPC failure'); END"
    )
    try {
      expect(await invoke(C.finalInvoices.approve, { id: f.invoice })).toMatchObject({ ok: false })
      expect(snapshot()).toEqual(before)
    } finally {
      db().exec('DROP TRIGGER post04_ipc')
    }
    expect(await invoke(C.finalInvoices.approve, { id: f.invoice })).toMatchObject({ ok: true })
    const order = n('SELECT order_id AS n FROM final_invoices WHERE id=?', f.invoice)
    expect(plans('order_id', order).planned_materials).toHaveLength(1)
    reconciliation()
  })
  it.each(['issuance', 'standard'])(
    'registered %s owner preserves authorization and atomic retry',
    async (owner) => {
      const f = fixture()
      const order = owner === 'issuance' ? approve(f) : undefined
      actor('restricted', [], 74005)
      const handlers = new Map<
        string,
        (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>
      >()
      const electron = await import('electron')
      const spy = vi
        .spyOn(electron.ipcMain, 'handle')
        .mockImplementation(((channel: string, handler: never) =>
          handlers.set(channel, handler)) as never)
      try {
        (await import('@main/ipc/router')).registerIpcRouter()
      } finally {
        spy.mockRestore()
      }
      const channel =
        owner === 'issuance' ? C.production.issueWorkSheet : C.products.issueStockFromBom
      const input =
        owner === 'issuance'
          ? { orderId: order }
          : { productId: f.product, quantityMicro: q(1), requestKey: 'post04-ipc-standard' }
      const invoke = (windowId = 1) =>
        handlers.get(channel)!({ sender: { id: windowId } } as IpcMainInvokeEvent, input)
      const before = snapshot()
      expect(await invoke(74005)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(snapshot()).toEqual(before)
      const action = owner === 'issuance' ? 'worksheets.issue' : 'products.issueStockFromBom'
      db().exec(
        `CREATE TEMP TRIGGER post04_ipc BEFORE INSERT ON audit_log WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT, 'POST04 IPC failure'); END`
      )
      try {
        expect(await invoke()).toMatchObject({ ok: false })
        expect(snapshot()).toEqual(before)
      } finally {
        db().exec('DROP TRIGGER post04_ipc')
      }
      expect(await invoke()).toMatchObject({ ok: true })
      expect(n('SELECT COUNT(*) AS n FROM planned_materials WHERE work_sheet_id IS NOT NULL')).toBe(
        1
      )
      expect(n('SELECT COUNT(*) AS n FROM audit_log WHERE action=?', action)).toBe(1)
      expect(availableQty(f.material)).toBe(q(98))
      reconciliation()
    }
  )
})
