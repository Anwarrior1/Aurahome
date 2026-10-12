import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import {
  createCustomer,
  archiveCustomer,
  restoreCustomer,
  updateCustomer,
  deleteCustomer,
  listCustomers,
  customerBalances,
  customerStatement
} from '@main/services/parties/parties.service'
import {
  createFinalInvoice,
  approveFinalInvoice,
  getFinalInvoice,
  listFinalInvoices
} from '@main/services/sales/final-invoices.service'
import {
  createQuotation,
  issueQuotation,
  createRevision,
  listQuotations
} from '@main/services/sales/quotations.service'
import { getOrder, listOrders, recordPayment } from '@main/services/sales/orders.service'
import { issueWorkSheet } from '@main/services/production/production.service'
import {
  buildFinalInvoice,
  buildPreliminaryInvoice
} from '@main/services/documents/documents.service'
import { buildReport } from '@main/services/reports/reports.service'
import { dashboardSummary } from '@main/services/dashboard/dashboard.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import { getRawConnection, closeDatabase } from '@main/db/connection'
import * as backupService from '@main/backup/backup.service'
import { createBackup, validateBackup } from '@main/backup/backup.service'
import { restoreFromBackup } from '@main/restore/restore.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import type { ServiceContext } from '@main/services/base/service.types'

let env: TestEnv
const LINE = {
  lineKind: 'custom' as const,
  description: 'مطبخ',
  quantityMicro: 1_000_000,
  unitPriceMinor: 10_000_000
}
beforeEach(() => {
  env = setupTestDatabase()
})
afterEach(() => env.cleanup())
function seed(periods = 1) {
  const customerId = createCustomer(
    { name: 'Anwar', phone: '0911111111', address: 'Original address' },
    env.ctx
  )
  const accountId = createAccount({ name: 'صندوق Anwar', kind: 'cash' }, env.ctx)
  const invoices: number[] = [],
    orders: number[] = [],
    quotations: number[] = []
  for (let i = 0; i < periods; i++) {
    const quotation = createQuotation({ customerId, lines: [LINE] }, env.ctx)
    issueQuotation(quotation.id, env.ctx)
    quotations.push(quotation.id)
    const invoice = createFinalInvoice(
      {
        customerId,
        lines: [LINE],
        paidAmountMinor: i ? 10_000_000 : 8_000_000,
        initialCashAccountId: accountId
      },
      env.ctx
    )
    invoices.push(invoice.id)
    orders.push(approveFinalInvoice(invoice.id, env.ctx).orderId)
  }
  return { customerId, accountId, invoices, orders, quotations }
}
function historicalRows() {
  return [
    'orders',
    'order_lines',
    'quotations',
    'quotation_lines',
    'final_invoices',
    'final_invoice_lines',
    'final_invoice_terms',
    'customer_payments',
    'cash_transactions',
    'inventory_movements',
    'work_sheets',
    'releases',
    'deliveries'
  ].map((table) => getRawConnection().prepare(`SELECT * FROM ${table}`).all())
}
function financialViews() {
  return {
    balances: customerBalances(),
    sales: buildReport({ key: 'sales' }),
    orders: buildReport({ key: 'orders' }),
    receivables: buildReport({ key: 'customer_balances' }),
    dashboard: dashboardSummary(
      { date: new Date().toISOString().slice(0, 10), year: 2026, month: 9, currentDay: true },
      env.ctx.session
    )
  }
}
function integrity() {
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
}

describe('Customer Archive / Restore lifecycle', () => {
  it('archives five orders/invoices/payment histories without altering any transaction, snapshot, debt, dashboard, or report', () => {
    const f = seed(5)
    const before = historicalRows(),
      finances = financialViews()
    const prelimPDF = buildPreliminaryInvoice(f.quotations[0]!),
      approvedPDF = buildFinalInvoice(f.invoices[0]!)
    archiveCustomer(f.customerId, env.ctx)
    expect(historicalRows()).toEqual(before)
    expect(financialViews()).toEqual(finances)
    expect(customerBalances()[0]).toMatchObject({
      paidMinor: 48_000_000,
      remainingMinor: 2_000_000
    })
    expect(listCustomers().items).toEqual([])
    expect(listCustomers({ activeOnly: true }).items).toEqual([])
    expect(listCustomers({ state: 'archived', search: 'anwar' }).items).toMatchObject([
      { id: f.customerId, active: false, hasHistory: true }
    ])
    expect(listCustomers({ state: 'active', search: 'Anwar' }).items).toEqual([])
    expect(listCustomers({ state: 'archived', search: 'unknown' }).items).toEqual([])
    expect(listOrders({ search: 'Anwar' }).items).toHaveLength(5)
    expect(listFinalInvoices({ search: 'Anwar' }).items).toHaveLength(5)
    expect(listQuotations({ search: 'Anwar' }).items).toHaveLength(5)
    expect(getOrder(f.orders[0]!).customer?.name).toBe('Anwar')
    expect(buildPreliminaryInvoice(f.quotations[0]!)).toEqual(prelimPDF)
    expect(buildFinalInvoice(f.invoices[0]!)).toEqual(approvedPDF)
    const statement = customerStatement(f.customerId, env.ctx)
    expect(statement.customer.active).toBe(false)
    expect(statement.balance.remainingMinor).toBe(2_000_000)
    expect(customerBalances('0911111111')[0].remainingMinor).toBe(2_000_000)
    expect(statement.orders.items).toHaveLength(5)
    expect(statement.payments.items).toHaveLength(5)
    expect(statement.preliminaryInvoices.items).toHaveLength(5)
    expect(statement.approvedInvoices.items).toHaveLength(5)
    integrity()
  })

  it('permits canonical old-debt settlement and manufacturing completion while blocking new business', () => {
    const f = seed()
    archiveCustomer(f.customerId, env.ctx)
    recordPayment(
      { orderId: f.orders[0]!, amountMinor: 1_000_000, cashAccountId: f.accountId },
      env.ctx
    )
    expect(getOrder(f.orders[0]!).order).toMatchObject({
      paidMinor: 9_000_000,
      remainingMinor: 1_000_000,
      status: 'confirmed'
    })
    expect(customerBalances()[0].remainingMinor).toBe(1_000_000)
    expect(accountBalance(f.accountId)).toBe(9_000_000)
    expect(issueWorkSheet({ orderId: f.orders[0]! }, env.ctx).id).toBeGreaterThan(0)
    expect(approveFinalInvoice(f.invoices[0]!, env.ctx).alreadyApproved).toBe(true)
    integrity()
  })

  it.each(['preliminary', 'approved', 'revision'] as const)(
    'rejects new %s business for archived IDs through the service',
    (kind) => {
      const f = seed()
      archiveCustomer(f.customerId, env.ctx)
      const before = historicalRows()
      expect(() =>
        kind === 'preliminary'
          ? createQuotation({ customerId: f.customerId, lines: [LINE] }, env.ctx)
          : kind === 'approved'
            ? createFinalInvoice({ customerId: f.customerId, lines: [LINE] }, env.ctx)
            : createRevision(f.quotations[0]!, env.ctx)
      ).toThrow(/مؤرشف/)
      expect(historicalRows()).toEqual(before)
    }
  )

  it('blocks a new order from an existing draft until restoration, without freezing existing orders', () => {
    const f = seed()
    const pending = createFinalInvoice(
      { customerId: f.customerId, lines: [LINE], paidAmountMinor: 3_000_000 },
      env.ctx
    )
    const pendingQuote = createQuotation({ customerId: f.customerId, lines: [LINE] }, env.ctx)
    archiveCustomer(f.customerId, env.ctx)
    expect(() => approveFinalInvoice(pending.id, env.ctx)).toThrow(/مؤرشف/)
    expect(() => issueQuotation(pendingQuote.id, env.ctx)).toThrow(/مؤرشف/)
    expect(getFinalInvoice(pending.id).invoice).toMatchObject({ status: 'draft', orderId: null })
    restoreCustomer(f.customerId, env.ctx)
    expect(approveFinalInvoice(pending.id, env.ctx).orderId).toBeGreaterThan(0)
    expect(listCustomers({ activeOnly: true }).items).toMatchObject([{ id: f.customerId }])
    integrity()
  })

  it('restores the same ID, supports new invoices again, and preserves the remaining debt and history', () => {
    const f = seed()
    archiveCustomer(f.customerId, env.ctx)
    recordPayment({ orderId: f.orders[0]!, amountMinor: 1_000_000 }, env.ctx)
    const before = historicalRows()
    restoreCustomer(f.customerId, env.ctx)
    expect(historicalRows()).toEqual(before)
    expect(listCustomers().items).toMatchObject([{ id: f.customerId, active: true }])
    expect(listCustomers({ state: 'archived' }).items).toEqual([])
    expect(customerBalances()[0].remainingMinor).toBe(1_000_000)
    expect(
      createFinalInvoice({ customerId: f.customerId, lines: [LINE] }, env.ctx).id
    ).toBeGreaterThan(0)
    expect(
      (getRawConnection().prepare('SELECT COUNT(*) AS c FROM customers').get() as { c: number }).c
    ).toBe(1)
  })

  it('preserves frozen PDF and order identity after master edits, archive and restore', () => {
    const f = seed()
    const preliminary = buildPreliminaryInvoice(f.quotations[0]!),
      approved = buildFinalInvoice(f.invoices[0]!)
    archiveCustomer(f.customerId, env.ctx)
    updateCustomer(
      f.customerId,
      { name: 'Updated master', phone: '0999999999', address: 'New address' },
      env.ctx
    )
    restoreCustomer(f.customerId, env.ctx)
    expect(buildPreliminaryInvoice(f.quotations[0]!)).toEqual(preliminary)
    expect(buildFinalInvoice(f.invoices[0]!)).toEqual(approved)
    expect(getOrder(f.orders[0]!).customer).toMatchObject({
      name: 'Anwar',
      phone: '0911111111',
      address: 'Original address'
    })
    integrity()
  })

  it('archive/restore retries write only one audit per real transition and no duplicate customers', () => {
    const f = seed()
    for (let i = 0; i < 3; i++) archiveCustomer(f.customerId, env.ctx)
    for (let i = 0; i < 3; i++) restoreCustomer(f.customerId, env.ctx)
    const logs = getRawConnection()
      .prepare(
        "SELECT * FROM audit_log WHERE action IN ('customers.archive', 'customers.restore') ORDER BY id"
      )
      .all() as Array<{
      action: string
      entity_id: string
      user_id: number
      created_at: string
      details: string
    }>
    expect(logs).toHaveLength(2)
    expect(logs.map((l) => l.action)).toEqual(['customers.archive', 'customers.restore'])
    expect(logs[0]).toMatchObject({
      user_id: env.ctx.session.user.id,
      entity_id: String(f.customerId)
    })
    expect(JSON.parse(logs[0]!.details)).toMatchObject({
      name: 'Anwar',
      before: 'active',
      after: 'archived'
    })
    integrity()
  })

  it('rolls lifecycle change back if audit fails', () => {
    const f = seed()
    getRawConnection().exec(
      "CREATE TRIGGER fail_archive_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'customers.archive' BEGIN SELECT RAISE(ABORT, 'audit failure'); END"
    )
    expect(() => archiveCustomer(f.customerId, env.ctx)).toThrow(/audit failure/)
    expect(listCustomers().items).toHaveLength(1)
    integrity()
  })

  it('reuses old active=false as Archived and audits legacy active updates through the same lifecycle', () => {
    const id = createCustomer({ name: 'Legacy inactive', active: false }, env.ctx)
    expect(listCustomers({ state: 'archived' }).items).toMatchObject([
      { id, active: false, hasHistory: false }
    ])
    updateCustomer(id, { active: true }, env.ctx)
    expect(listCustomers().items).toHaveLength(1)
    expect(
      getRawConnection()
        .prepare("SELECT action FROM audit_log WHERE action = 'customers.restore'")
        .all()
    ).toHaveLength(1)
  })

  it('allows typed permanent deletion only with no dependencies and never cascades history', () => {
    const id = createCustomer({ name: 'Unreferenced' }, env.ctx)
    expect(() => deleteCustomer(id, env.ctx)).toThrow(/اكتب اسم العميل/)
    expect(() => deleteCustomer(id, env.ctx, 'wrong')).toThrow()
    deleteCustomer(id, env.ctx, 'Unreferenced')
    const f = seed()
    expect(() => deleteCustomer(f.customerId, env.ctx, 'Anwar')).toThrow(/أرشفة/)
    expect(getOrder(f.orders[0]!).order.id).toBe(f.orders[0])
    integrity()
  })

  it('persists archive, debt and snapshots across database reopen and real backup/restore', async () => {
    const f = seed()
    archiveCustomer(f.customerId, env.ctx)
    closeDatabase()
    expect(listCustomers({ state: 'archived' }).items).toMatchObject([{ id: f.customerId }])
    expect(customerBalances()[0].remainingMinor).toBe(2_000_000)
    const backup = await createBackup(
      { destinationDirectory: join(env.dir, 'archive-backup'), includeConfig: false },
      env.ctx
    )
    expect((await validateBackup(backup.path)).valid).toBe(true)
    restoreCustomer(f.customerId, env.ctx)
    const pathSpy = vi
      .spyOn(backupService, 'getLiveDatabasePath')
      .mockReturnValue(getRawConnection().name)
    try {
      await restoreFromBackup({ backupFilePath: backup.path }, env.ctx)
    } finally {
      pathSpy.mockRestore()
    }
    expect(listCustomers().items).toEqual([])
    expect(listCustomers({ state: 'archived' }).items).toMatchObject([{ id: f.customerId }])
    expect(customerBalances()[0].remainingMinor).toBe(2_000_000)
    expect(buildFinalInvoice(f.invoices[0]!).customer.name).toBe('Anwar')
    integrity()
  })

  it('requires manage permission in the service and does not expose invoice history without its view permissions', () => {
    const f = seed()
    const limited: ServiceContext = {
      session: {
        ...env.ctx.session,
        user: { ...env.ctx.session.user, isAdmin: false },
        permissions: [P.customers.view]
      }
    }
    expect(() => archiveCustomer(f.customerId, limited)).toThrow()
    expect(() => restoreCustomer(f.customerId, limited)).toThrow()
    expect(() => updateCustomer(f.customerId, { active: false }, limited)).toThrow()
    expect(customerStatement(f.customerId, limited).preliminaryInvoices.items).toEqual([])
    expect(customerStatement(f.customerId, limited).approvedInvoices.items).toEqual([])
    expect(listCustomers().items).toHaveLength(1)
  })

  it('guards direct IPC archive/restore, new invoice creation, and stale approval, while allowing old-order payment', async () => {
    const f = seed()
    const pending = createFinalInvoice({ customerId: f.customerId, lines: [LINE] }, env.ctx)
    const handlers = new Map<
      string,
      (e: IpcMainInvokeEvent, p: unknown) => Promise<IpcResult<unknown>>
    >()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((
      channel: string,
      handler: never
    ) => {
      handlers.set(channel, handler)
    }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    const roleId = createRole({ name: 'Customer view', permissions: [P.customers.view] }, env.ctx)
    createUser(
      { username: 'customer-view', password: 'secret123', fullName: 'Viewer', roleId },
      env.ctx
    )
    login('customer-view', 'secret123', 9460)
    const event = { sender: { id: 9460 } } as IpcMainInvokeEvent
    for (const channel of [IPC_CHANNELS.customers.archive, IPC_CHANNELS.customers.restore]) {
      const result = await handlers.get(channel)!(event, { id: f.customerId })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    }
    login('owner', 'secret123', 9460)
    expect(
      (await handlers.get(IPC_CHANNELS.customers.archive)!(event, { id: f.customerId })).ok
    ).toBe(true)
    for (const channel of [IPC_CHANNELS.quotations.create, IPC_CHANNELS.finalInvoices.create]) {
      const result = await handlers.get(channel)!(event, {
        customerId: f.customerId,
        lines: [LINE]
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CONFLICT')
    }
    expect(
      (await handlers.get(IPC_CHANNELS.finalInvoices.approve)!(event, { id: pending.id })).ok
    ).toBe(false)
    expect(
      (
        await handlers.get(IPC_CHANNELS.orders.recordPayment)!(event, {
          orderId: f.orders[0],
          amountMinor: 1_000_000,
          requestKey: 'db05-customer-archive-payment'
        })
      ).ok
    ).toBe(true)
    const list = await handlers.get(IPC_CHANNELS.customers.list)!(event, { activeOnly: true })
    expect(list).toMatchObject({ ok: true, data: { items: [] } })
    expect(
      (await handlers.get(IPC_CHANNELS.customers.restore)!(event, { id: f.customerId })).ok
    ).toBe(true)
    expect(
      (
        await handlers.get(IPC_CHANNELS.finalInvoices.create)!(event, {
          customerId: f.customerId,
          lines: [LINE]
        })
      ).ok
    ).toBe(true)
    integrity()
  })
})
