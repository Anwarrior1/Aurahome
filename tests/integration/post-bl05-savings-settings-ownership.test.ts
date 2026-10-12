import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { withTransaction } from '@main/db/transactions'
import { reconcileDatabase } from '@main/db/reconciliation'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createCustomer, createSupplier } from '@main/services/parties/parties.service'
import { createPurchase } from '@main/services/purchasing/purchasing.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import {
  recordPayment,
  cancelOrder,
  authoritativeOrderPaymentPosition
} from '@main/services/sales/orders.service'
import {
  issueWorkSheet,
  startProduction,
  completeProduction,
  productionActualCostMinor
} from '@main/services/production/production.service'
import { savePlannedMaterials } from '@main/services/planning/planning.service'
import * as cash from '@main/services/finance/cash.service'
import * as profit from '@main/services/finance/profit.service'
import * as settings from '@main/services/settings.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import type { ServiceContext } from '@main/services/base/service.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import { businessDate, businessDayBounds } from '@shared/business-date'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'
import { unitCostFromMajor as c } from '@shared/money/cost'

let env: TestEnv
let restricted: ServiceContext
let savingsActor: ServiceContext
let settingsActor: ServiceContext
let previousTz: string | undefined
const db = () => getRawConnection()
const key = settings.SETTING_KEYS.savingsRateBp
const n = (query: string, ...args: (number | string)[]) =>
  (
    db()
      .prepare(query)
      .get(...args) as { n: number }
  ).n
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
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'))
  previousTz = process.env.TZ
  restricted = actor('restricted', [], 75011)
  savingsActor = actor('savings', [P.savings.manage], 75012)
  settingsActor = actor('settings', [P.settings.manage], 75013)
})
afterEach(() => {
  try {
    expect(db().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    expect(db().pragma('foreign_key_check')).toEqual([])
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
    vi.useRealTimers()
    env.cleanup()
  }
})
function denied(command: () => unknown, code: string) {
  const before = snapshot()
  expect(command).toThrow(expect.objectContaining({ code }))
  expect(snapshot()).toEqual(before)
}
function retainedProfit() {
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
  const account = cash.createAccount(
    { name: 'Cash', kind: 'cash', openingBalanceMinor: m(10000) },
    env.ctx
  )
  const invoice = createFinalInvoice(
    {
      customerId: createCustomer({ name: 'Customer' }, env.ctx),
      depositPercentBp: 0,
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
  )
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: m(7000), cashAccountId: account }, env.ctx)
  savePlannedMaterials(
    { orderId: order.id },
    [{ materialId: material, materialName: 'Board', qtyMicro: q(60), unit: 'board' }],
    env.ctx
  )
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
  startProduction(sheet.id, env.ctx)
  cancelOrder({ orderId: order.id, reason: 'Cancelled after actual start' }, env.ctx)
  completeProduction(sheet.id, env.ctx)
  expect(productionActualCostMinor(sheet.id)).toBe(m(6000))
  expect(
    n('SELECT COUNT(*) AS n FROM uncollected_products WHERE source_order_id=?', order.id)
  ).toBe(1)
  expect(n('SELECT COUNT(*) AS n FROM customer_payment_refunds')).toBe(0)
  expect(authoritativeOrderPaymentPosition(order.id).paidMinor).toBe(m(7000))
  expect(profit.monthlyProfitSummary(2026, 10).netProfitMinor).toBe(m(1000))
  expect(profit.availableProfitMinor()).toBe(m(1000))
  expect(reconcileDatabase(db()).findings).toEqual([])
  return { order: order.id, account }
}

describe('POST-BL-05 reserved savings settings ownership', () => {
  it('clean migrated settings use the valid 1000 bp default; raw writer is private and Profit re-export is the same owner', () => {
    expect(key).toBe('savings.rate_bp')
    expect(settings.getSavingsRateBp()).toBe(1000)
    expect(n('SELECT COUNT(*) AS n FROM app_settings WHERE key=?', key)).toBe(0)
    expect(profit.setSavingsRateBp).toBe(settings.setSavingsRateBp)
    expect(Object.keys(settings)).not.toContain('writeSetting')
    const file = 'src/main/services/settings.service.ts'
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const callers: string[] = []
    let privateWriter = false
    function walk(node: ts.Node, owner = '') {
      if (ts.isFunctionDeclaration(node)) {
        owner = node.name?.text ?? owner
        if (owner === 'writeSetting')
          privateWriter = !node.modifiers?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword)
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'writeSetting'
      )
        callers.push(owner)
      ts.forEachChild(node, (child) => walk(child, owner))
    }
    walk(source)
    expect(privateWriter).toBe(true)
    expect(callers).toEqual(['setSetting', 'setSavingsRateBp'])
  })
  it.each([0, 1, 9999, 10000])(
    'valid boundary %s is supported under existing savings permission and Admin',
    (rate) => {
      for (const ctx of [savingsActor, env.ctx]) {
        const auditBefore = n("SELECT COUNT(*) AS n FROM audit_log WHERE action='settings.update'")
        expect(withTransaction(() => profit.setSavingsRateBp(rate, ctx))).toEqual({
          savingsRateBp: rate
        })
        expect(settings.getSavingsRateBp()).toBe(rate)
        expect(n("SELECT COUNT(*) AS n FROM audit_log WHERE action='settings.update'")).toBe(
          auditBefore + 1
        )
        expect(db().prepare('SELECT updated_by FROM app_settings WHERE key=?').get(key)).toEqual({
          updated_by: ctx.session.user.username
        })
      }
    }
  )
  const invalid = [
    -1,
    10001,
    20000,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    '5000',
    '10000',
    '',
    null,
    undefined,
    true,
    false,
    {},
    []
  ]
  it.each(invalid.map((value, index) => ({ value, index })))(
    'invalid runtime value $index is rejected, without coercion, by both owner access paths and Admin',
    ({ value }) => {
      for (const ctx of [savingsActor, env.ctx])
        for (const owner of [profit.setSavingsRateBp, settings.setSavingsRateBp]) {
          denied(() => owner(value as number, ctx), 'VALIDATION_ERROR')
          denied(() => withTransaction(() => owner(value as number, ctx)), 'VALIDATION_ERROR')
        }
      expect(settings.getSavingsRateBp()).toBe(1000)
    }
  )
  it.each([20000, 10000, 5000])(
    'generic command and former internal alias both reject reserved value %s, even for Admin and caller transactions',
    (value) => {
      for (const write of [settings.setSetting, settings.setSettingInternal])
        for (const ctx of [settingsActor, env.ctx]) {
          denied(() => write(key, value, ctx), 'VALIDATION_ERROR')
          withTransaction(() => {
            denied(() => write(key, value, ctx), 'VALIDATION_ERROR')
          })
          denied(() => write(key, value, ctx), 'VALIDATION_ERROR')
        }
      expect(settings.getSavingsRateBp()).toBe(1000)
    }
  )
  it('authorization precedes savings-domain checks; settings permission is not savings ownership', () => {
    for (const ctx of [restricted, settingsActor])
      for (const rate of [5000, 20000]) {
        denied(() => profit.setSavingsRateBp(rate, ctx), 'FORBIDDEN')
        denied(() => withTransaction(() => settings.setSavingsRateBp(rate, ctx)), 'FORBIDDEN')
      }
    for (const write of [settings.setSetting, settings.setSettingInternal]) {
      denied(() => write(key, 20000, restricted), 'FORBIDDEN')
      denied(() => write(key, 20000, savingsActor), 'FORBIDDEN')
      denied(() => write(key, 20000), 'FORBIDDEN')
    }
  })
  it('generic allowlist remains typed and functional; alias cannot create arbitrary/domain keys', () => {
    settings.setSetting(settings.SETTING_KEYS.companyName, 'Factory', settingsActor)
    settings.setSettingInternal(settings.SETTING_KEYS.companyPhone, '123', settingsActor)
    expect(settings.getAllSettings()).toMatchObject({
      'company.name': 'Factory',
      'company.phone': '123'
    })
    for (const write of [settings.setSetting, settings.setSettingInternal]) {
      denied(
        () => write(settings.SETTING_KEYS.depositPercentBp, 20000, settingsActor),
        'VALIDATION_ERROR'
      )
      denied(() => write('savings.rate_bp.evil', 20000, env.ctx), 'VALIDATION_ERROR')
      denied(() => write('unknown.setting', 20000, env.ctx), 'VALIDATION_ERROR')
    }
  })
  it.each([false, true])(
    'required audit failure rolls back valid setting update, normal retry commits once (caller transaction=%s)',
    (caller) => {
      profit.setSavingsRateBp(1000, savingsActor)
      const before = snapshot()
      const audits = n("SELECT COUNT(*) AS n FROM audit_log WHERE action='settings.update'")
      db().exec(
        "CREATE TEMP TRIGGER post05_fail BEFORE INSERT ON audit_log WHEN NEW.action='settings.update' AND NEW.entity_id='savings.rate_bp' BEGIN SELECT RAISE(ABORT, 'POST05 required audit failure'); END"
      )
      try {
        if (caller)
          withTransaction(() => {
            expect(() => profit.setSavingsRateBp(5000, savingsActor)).toThrow(
              'POST05 required audit failure'
            )
          })
        else
          expect(() => profit.setSavingsRateBp(5000, savingsActor)).toThrow(
            'POST05 required audit failure'
          )
        expect(snapshot()).toEqual(before)
        expect(settings.getSavingsRateBp()).toBe(1000)
      } finally {
        db().exec('DROP TRIGGER post05_fail')
      }
      profit.setSavingsRateBp(5000, savingsActor)
      expect(settings.getSavingsRateBp()).toBe(5000)
      expect(n("SELECT COUNT(*) AS n FROM audit_log WHERE action='settings.update'")).toBe(
        audits + 1
      )
      expect(reconcileDatabase(db()).findings).toEqual([])
    }
  )
  it('outer rollback removes valid owner setting update and its required audit', () => {
    profit.setSavingsRateBp(1000, savingsActor)
    const before = snapshot()
    expect(() =>
      withTransaction(() => {
        settings.setSavingsRateBp(5000, savingsActor)
        throw new Error('POST05 outer rollback')
      })
    ).toThrow('POST05 outer rollback')
    expect(snapshot()).toEqual(before)
  })
  it.each([0, 5000, 10000])(
    'real retained 1000 profit at %s bp follows unchanged allocation formula',
    (rate) => {
      retainedProfit()
      for (const write of [settings.setSetting, settings.setSettingInternal])
        for (const ctx of [restricted, settingsActor, env.ctx]) {
          denied(
            () => write(key, 20000, ctx),
            ctx === restricted ? 'FORBIDDEN' : 'VALIDATION_ERROR'
          )
          denied(
            () => withTransaction(() => write(key, 20000, ctx)),
            ctx === restricted ? 'FORBIDDEN' : 'VALIDATION_ERROR'
          )
        }
      denied(() => profit.setSavingsRateBp(20000, savingsActor), 'VALIDATION_ERROR')
      profit.setSavingsRateBp(rate, savingsActor)
      const cashBefore = db().prepare('SELECT * FROM cash_transactions ORDER BY id').all()
      const result = profit.confirmSavingsAllocation(
        { year: 2026, month: 10, requestKey: 'post05-allocation' },
        savingsActor
      )
      expect(result).toEqual({ amountMinor: m(rate / 10), rateBp: rate })
      expect(profit.monthlyProfitSummary(2026, 10)).toMatchObject({
        netProfitMinor: m(1000),
        savingsAllocatedMinor: m(rate / 10),
        remainingProfitMinor: m(1000 - rate / 10)
      })
      expect(profit.availableProfitMinor()).toBe(m(1000 - rate / 10))
      expect(db().prepare('SELECT * FROM cash_transactions ORDER BY id').all()).toEqual(cashBefore)
      expect(n('SELECT COUNT(*) AS n FROM savings_allocations')).toBe(1)
      const before = snapshot()
      expect(
        profit.confirmSavingsAllocation(
          { year: 2026, month: 10, requestKey: 'post05-allocation' },
          savingsActor
        )
      ).toEqual(result)
      expect(snapshot()).toEqual(before)
      expect(reconcileDatabase(db()).findings).toEqual([])
    }
  )
  it('registered savings owner preserves authorization, valid/invalid domain, audit rollback and retry; no alias IPC', async () => {
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, input: unknown) => Promise<IpcResult<unknown>>
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
    const invoke = (channel: string, input: unknown, id = 1) =>
      handlers.get(channel)!({ sender: { id } } as IpcMainInvokeEvent, input)
    expect([...handlers.keys()].filter((x) => /setSettingInternal|writeSetting/.test(x))).toEqual(
      []
    )
    const before = snapshot()
    expect(await invoke(C.profit.setSavingsRate, { rateBp: 5000 }, 75011)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' }
    })
    expect(snapshot()).toEqual(before)
    for (const id of [75012, 1])
      for (const rateBp of [-1, 10001, 20000, 1.5, '5000', null]) {
        expect(await invoke(C.profit.setSavingsRate, { rateBp }, id)).toMatchObject({
          ok: false,
          error: { code: 'VALIDATION_ERROR' }
        })
        expect(snapshot()).toEqual(before)
      }
    expect(await invoke(C.settings.set, { key, value: 20000 }, 75013)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR' }
    })
    expect(snapshot()).toEqual(before)
    db().exec(
      "CREATE TEMP TRIGGER post05_ipc BEFORE INSERT ON audit_log WHEN NEW.action='settings.update' AND NEW.entity_id='savings.rate_bp' BEGIN SELECT RAISE(ABORT, 'POST05 IPC audit failure'); END"
    )
    try {
      expect(await invoke(C.profit.setSavingsRate, { rateBp: 5000 }, 75012)).toMatchObject({
        ok: false
      })
      expect(snapshot()).toEqual(before)
    } finally {
      db().exec('DROP TRIGGER post05_ipc')
    }
    expect(await invoke(C.profit.setSavingsRate, { rateBp: 5000 }, 75012)).toMatchObject({
      ok: true,
      data: { savingsRateBp: 5000 }
    })
    expect(settings.getSavingsRateBp()).toBe(5000)
    expect(n("SELECT COUNT(*) AS n FROM audit_log WHERE action='settings.update'")).toBe(1)
  })
  it.each(['Africa/Tripoli', 'America/New_York'])(
    'POST-BL-06 precision fix includes both same-instant transfer representations in %s',
    (zone) => {
      process.env.TZ = zone
      const from = cash.createAccount(
        { name: 'From', kind: 'cash', openingBalanceMinor: m(1000) },
        env.ctx
      )
      const to = cash.createAccount({ name: 'To', kind: 'cash' }, env.ctx)
      const bounds = businessDayBounds('2026-10-01')
      const at = new Date(new Date(bounds.to).getTime() - 999).toISOString()
      const seconds = at.replace('.000Z', 'Z')
      expect(businessDate(new Date(seconds))).toBe('2026-10-01')
      cash.transfer(
        { fromAccountId: from, toAccountId: to, amountMinor: m(300), occurredAt: seconds },
        env.ctx
      )
      cash.transfer(
        { fromAccountId: from, toAccountId: to, amountMinor: m(50), occurredAt: at },
        env.ctx
      )
      expect(cash.accountBalance(from)).toBe(m(650))
      expect(cash.accountBalance(to)).toBe(m(350))
      const before = snapshot()
      expect(
        cash.listTransactions({ accountId: to, from: '2026-10-01', to: '2026-10-01' }).items
      ).toHaveLength(2)
      expect(cash.accountBalance(from, '2026-10-01')).toBe(m(650))
      expect(cash.accountBalance(to, '2026-10-01')).toBe(m(350))
      expect(snapshot()).toEqual(before)
      expect(reconcileDatabase(db()).findings).toEqual([])
    }
  )
})
