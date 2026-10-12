import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS as C } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import {
  PERMISSION_KEYS as P,
  PERMISSION_SECTIONS,
  allPermissionKeys
} from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice, approveFinalInvoice } from '@main/services/sales/final-invoices.service'
import { createQuotation } from '@main/services/sales/quotations.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor as m } from '@shared/money/money'
import { quantityFromDisplay as q } from '@shared/quantity/quantity'

/**
 * RBAC for the two customer-facing commercial documents.
 *
 * The Preliminary Invoice and the Approved Invoice used to share the
 * Customer Order's permissions, which made "prepare a commercial
 * document" and "commit the factory to it" the same privilege. These
 * tests pin the separation, its backward compatibility, and the fact
 * that it is enforced in main rather than by hiding buttons.
 */
let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 41200
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

/** Signs in a NON-admin user holding exactly these keys; returns the role. */
function signInWith(permissions: string[]): number {
  const roleId = createRole({ name: `دور ${permissions.length}-${windowId}`, permissions }, env.ctx)
  createUser(
    { username: `u${windowId}`, fullName: 'مستخدم', password: 'secret123', roleId },
    env.ctx
  )
  login(`u${windowId}`, 'secret123', windowId)
  return roleId
}

function seedInvoice(): { invoiceId: number; customerId: number } {
  const customerId = createCustomer({ name: 'عميل تجاري' }, env.ctx)
  const invoice = createFinalInvoice(
    {
      customerId,
      lines: [{ lineKind: 'custom', description: 'خزانة', quantityMicro: q(1), unitPriceMinor: m(1000) }]
    },
    env.ctx
  )
  return { invoiceId: invoice.id, customerId }
}

// ───────────────────────────── permission metadata / role editor

describe('permission metadata drives the role editor correctly', () => {
  it('every key resolves to a real section, a non-empty Arabic label, and appears exactly once', () => {
    const all = allPermissionKeys()
    const sections = new Set(PERMISSION_SECTIONS.map((section) => section.key))
    const seen = new Set<string>()
    for (const permission of all) {
      expect(sections.has(permission.section)).toBe(true)
      expect(permission.label.trim().length).toBeGreaterThan(0)
      expect(permission.label).not.toMatch(/undefined/)
      expect(seen.has(permission.key)).toBe(false) // no duplicate rows
      seen.add(permission.key)
    }
  })

  it('the Preliminary Invoice has its OWN section and NO approval permission', () => {
    const quotationKeys = allPermissionKeys().filter((p) => p.key.startsWith('quotations.'))
    expect(quotationKeys.map((p) => p.key).sort()).toEqual([
      'quotations.issue',
      'quotations.manage',
      'quotations.remove',
      'quotations.view'
    ])
    // Its own group, not lumped under Customer Orders.
    for (const permission of quotationKeys) expect(permission.section).toBe('quotations')
    // The retired misnomer is gone from the editor entirely...
    expect(allPermissionKeys().some((p) => p.key === 'quotations.approve')).toBe(false)
    // ...and no preliminary-invoice row may read as an approval.
    for (const permission of quotationKeys) expect(permission.label).not.toContain('اعتماد')
  })

  it('the Approved Invoice has its own section, with approval separated and marked sensitive', () => {
    const keys = allPermissionKeys().filter((p) => p.section === 'finalInvoices')
    const byKey = new Map(keys.map((p) => [p.key, p]))
    for (const key of [
      P.finalInvoices.view,
      P.finalInvoices.manage,
      P.finalInvoices.approve,
      P.finalInvoices.cancel,
      P.finalInvoices.remove,
      P.finalInvoices.viewApprovedTotal,
      P.finalInvoices.viewOutstanding
    ]) {
      expect(byKey.has(key)).toBe(true)
    }
    expect(byKey.get(P.finalInvoices.approve)?.sensitive).toBe(true)
    expect(byKey.get(P.finalInvoices.approve)?.label).toContain('اعتماد')
    expect(byKey.get(P.finalInvoices.viewApprovedTotal)?.sensitive).toBe(true)
    expect(byKey.get(P.finalInvoices.viewOutstanding)?.sensitive).toBe(true)
    // Un-approving is displayed beside the document it reverses, while
    // keeping its original key (so existing roles are unaffected).
    expect(byKey.has(P.orders.unapproveInvoice)).toBe(true)
    expect(P.orders.unapproveInvoice).toBe('orders.unapproveInvoice')
  })

  it('customers expose only the actions that exist: view, create/edit, archive — and no permanent delete', () => {
    const customerKeys = allPermissionKeys().filter((p) => p.key.startsWith('customers.'))
    expect(customerKeys.map((p) => p.key).sort()).toEqual([
      'customers.archive',
      'customers.manage',
      'customers.view'
    ])
    // There is no cascade permanent-delete workflow for a customer, so
    // there is no permission pretending to authorise one.
    expect(customerKeys.some((p) => p.key === 'customers.fullDelete')).toBe(false)
    for (const permission of customerKeys) expect(permission.label).not.toContain('حذف نهائي')
  })

  it('payroll has its own section rather than sitting inside المالية', () => {
    const employeeKeys = allPermissionKeys().filter((p) => p.key.startsWith('employees.'))
    for (const permission of employeeKeys) expect(permission.section).toBe('employees')
  })

  it('Inventory permissions are untouched by this pass', () => {
    const inventory = allPermissionKeys().filter((p) => p.key.startsWith('inventory.'))
    expect(inventory.map((p) => p.key).sort()).toEqual([
      'inventory.adjust',
      'inventory.consume',
      'inventory.valuation',
      'inventory.view',
      'inventory.waste'
    ])
    for (const permission of inventory) expect(permission.section).toBe('inventory')
    expect(inventory.find((p) => p.key === 'inventory.valuation')?.sensitive).toBe(true)
  })
})

// ───────────────────────────── the Sales role scenario

describe('the SALES role: prepares commercial documents, commits nothing', () => {
  const SALES = [
    P.customers.view,
    P.customers.manage,
    P.quotations.view,
    P.quotations.manage,
    P.quotations.issue,
    P.finalInvoices.view,
    P.finalInvoices.manage
  ]

  it('may create and edit an Approved Invoice', async () => {
    const customerId = createCustomer({ name: 'عميل المبيعات' }, env.ctx)
    signInWith(SALES)
    const created = await call(C.finalInvoices.create, {
      customerId,
      lines: [{ lineKind: 'custom', description: 'مطبخ', quantityMicro: q(1), unitPriceMinor: m(5000) }]
    })
    expect(created.ok).toBe(true)
    expect((await call(C.finalInvoices.list, {})).ok).toBe(true)
  })

  it('may NOT approve it — approval is a different privilege, refused in main', async () => {
    const { invoiceId } = seedInvoice()
    signInWith(SALES)
    const result = await call(C.finalInvoices.approve, { id: invoiceId })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    // and no Customer Order came into existence
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM orders').get()).toEqual({ c: 0 })
  })

  it('may NOT reach Customer Orders, production, or delete an approved invoice', async () => {
    const { invoiceId } = seedInvoice()
    signInWith(SALES)
    for (const [channel, request] of [
      [C.orders.list, {}],
      [C.finalInvoices.remove, { id: invoiceId }],
      [C.finalInvoices.unapprove, { id: invoiceId, expectedRevision: 1 }]
    ] as const) {
      const result = await call(channel, request)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    }
  })

  it('never receives the company-wide financial summaries, nor per-row receivables', async () => {
    seedInvoice()
    signInWith(SALES)
    const result = await call(C.finalInvoices.list, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const payload = result.data as {
      summary: Record<string, number>
      items: Array<Record<string, unknown>>
    }
    // The values are ABSENT from the DTO — not merely hidden by the UI.
    expect(payload.summary.totalApprovedMinor).toBeUndefined()
    expect(payload.summary.totalOutstandingMinor).toBeUndefined()
    expect(payload.items.length).toBeGreaterThan(0)
    for (const row of payload.items) {
      expect(row).not.toHaveProperty('remainingMinor')
      expect(row).not.toHaveProperty('paidMinor')
      expect(row).not.toHaveProperty('paymentStatus')
      // its own agreed total stays: that is the document's own content
      expect(row.totalMinor).toBeDefined()
    }
  })

  it('CAN see the summaries once explicitly granted — the permission is what gates it', async () => {
    seedInvoice()
    signInWith([...SALES, P.finalInvoices.viewApprovedTotal, P.finalInvoices.viewOutstanding])
    const result = await call(C.finalInvoices.list, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const payload = result.data as {
      summary: { totalApprovedMinor?: number; totalOutstandingMinor?: number }
      items: Array<Record<string, unknown>>
    }
    expect(payload.summary.totalApprovedMinor).toBe(m(1000))
    expect(payload.summary.totalOutstandingMinor).toBeDefined()
    expect(payload.items[0]).toHaveProperty('remainingMinor')
  })

  it('a sales user issuing a preliminary invoice performs no approval of any kind', async () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = createQuotation(
      {
        customerId,
        lines: [{ lineKind: 'custom', description: 'عرض', quantityMicro: q(1), unitPriceMinor: m(700) }]
      },
      env.ctx
    )
    signInWith(SALES)
    expect((await call(C.quotations.issue, { id: quotation.id })).ok).toBe(true)
    // Issuing a preliminary invoice creates no order and no approved invoice.
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM orders').get()).toEqual({ c: 0 })
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM final_invoices').get()).toEqual({ c: 0 })
  })
})

// ───────────────────────────── approval as its own privilege

describe('approval is grantable on its own', () => {
  it('an approver with no editing rights can approve but not edit', async () => {
    const { invoiceId } = seedInvoice()
    signInWith([P.finalInvoices.view, P.finalInvoices.approve])
    const edit = await call(C.finalInvoices.update, { id: invoiceId, notes: 'تعديل' })
    expect(edit.ok).toBe(false)
    if (!edit.ok) expect(edit.error.code).toBe('FORBIDDEN')

    const approved = await call(C.finalInvoices.approve, { id: invoiceId })
    expect(approved.ok).toBe(true)
    expect(getRawConnection().prepare('SELECT COUNT(*) AS c FROM orders').get()).toEqual({ c: 1 })
  })
})

// ───────────────────────────── backward compatibility

describe('existing roles keep working: no assignment is rewritten, no access is broadened', () => {
  it('a legacy role holding only orders.* still performs every Approved Invoice action', async () => {
    const { invoiceId } = seedInvoice()
    signInWith([P.orders.view, P.orders.manage])
    expect((await call(C.finalInvoices.list, {})).ok).toBe(true)
    expect((await call(C.finalInvoices.get, { id: invoiceId })).ok).toBe(true)
    expect((await call(C.finalInvoices.approve, { id: invoiceId })).ok).toBe(true)
  })

  it('a legacy role holding the retired quotations.approve can still issue', async () => {
    const customerId = createCustomer({ name: 'عميل قديم' }, env.ctx)
    const quotation = createQuotation(
      {
        customerId,
        lines: [{ lineKind: 'custom', description: 'عرض', quantityMicro: q(1), unitPriceMinor: m(500) }]
      },
      env.ctx
    )
    // The retired key can no longer be SAVED (setRolePermissions drops
    // keys that are not in the catalog), so a database written by an
    // older build is simulated the only faithful way: the grant is
    // already sitting in role_permissions.
    const roleId = signInWith([P.quotations.view])
    getRawConnection()
      .prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)')
      .run(roleId, 'quotations.approve')
    login(`u${windowId}`, 'secret123', windowId) // re-read the role

    expect((await call(C.quotations.issue, { id: quotation.id })).ok).toBe(true)
  })

  it('archiving is NOT inherited from customers.manage — a deliberate tightening', async () => {
    const customerId = createCustomer({ name: 'عميل للأرشفة' }, env.ctx)
    // `customers.manage` is precisely what a sales role is given, so
    // bridging it to the archive key would re-create the bundling this
    // pass removed. The admin must grant it explicitly.
    signInWith([P.customers.view, P.customers.manage])
    const archived = await call(C.customers.archive, { id: customerId })
    expect(archived.ok).toBe(false)
    if (!archived.ok) expect(archived.error.code).toBe('FORBIDDEN')
  })

  it('granting the archive key explicitly is what enables it', async () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    signInWith([P.customers.view, P.customers.manage, P.customers.archive])
    expect((await call(C.customers.archive, { id: customerId })).ok).toBe(true)
    expect((await call(C.customers.restore, { id: customerId })).ok).toBe(true)
  })

  it('a role still holding the obsolete customers.fullDelete key gains nothing from it', async () => {
    const customerId = createCustomer({ name: 'عميل بلا تاريخ' }, env.ctx)
    // Simulates a database written before the key was retired.
    const roleId = signInWith([P.customers.view])
    getRawConnection()
      .prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)')
      .run(roleId, 'customers.fullDelete')
    login(`u${windowId}`, 'secret123', windowId)

    // It matches no check anywhere: it is inert, never reinterpreted.
    for (const [channel, request] of [
      [C.customers.remove, { id: customerId, confirmation: 'عميل بلا تاريخ' }],
      [C.customers.archive, { id: customerId }],
      [C.customers.update, { id: customerId, name: 'محاولة' }]
    ] as const) {
      const result = await call(channel, request)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('FORBIDDEN')
    }
    // and the customer is untouched
    expect(
      getRawConnection().prepare('SELECT COUNT(*) AS c FROM customers WHERE id = ?').get(customerId)
    ).toEqual({ c: 1 })
  })
})

// ───────────────────────────── destructive separation

describe('destructive actions stand alone', () => {
  it('cancelling an Approved Invoice is blocked without its cancellation permission', async () => {
    const { invoiceId } = seedInvoice()
    signInWith([P.finalInvoices.view, P.finalInvoices.manage])
    const before = getRawConnection()
      .prepare('SELECT status, cancelled_at, cancel_reason FROM final_invoices WHERE id = ?')
      .get(invoiceId)

    const cancelled = await call(C.finalInvoices.cancel, { id: invoiceId, reason: 'غير مصرح' })

    expect(cancelled.ok).toBe(false)
    if (!cancelled.ok) expect(cancelled.error.code).toBe('FORBIDDEN')
    expect(
      getRawConnection()
        .prepare('SELECT status, cancelled_at, cancel_reason FROM final_invoices WHERE id = ?')
        .get(invoiceId)
    ).toEqual(before)
  })

  it('deleting a preliminary invoice is not implied by creating one', async () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = createQuotation(
      {
        customerId,
        lines: [{ lineKind: 'custom', description: 'عرض', quantityMicro: q(1), unitPriceMinor: m(300) }]
      },
      env.ctx
    )
    signInWith([P.quotations.view, P.quotations.manage])
    const removed = await call(C.quotations.remove, { id: quotation.id })
    expect(removed.ok).toBe(false)
    if (!removed.ok) expect(removed.error.code).toBe('FORBIDDEN')
  })

  it('issuing a production order never implies reversing or deleting one', async () => {
    const { invoiceId } = seedInvoice()
    approveFinalInvoice(invoiceId, env.ctx)
    signInWith([P.orders.view, P.worksheets.view, P.worksheets.issue])
    const cancelled = await call(C.production.cancelProduction, { id: 1, reason: 'تصحيح' })
    expect(cancelled.ok).toBe(false)
    if (!cancelled.ok) expect(cancelled.error.code).toBe('FORBIDDEN')
  })
})

// ───────────────────────────── audit log immutability

describe('the audit log is read-only through RBAC', () => {
  it('exposes exactly one audit permission, and it only reads', () => {
    const auditKeys = allPermissionKeys().filter((p) => p.key.startsWith('audit.'))
    expect(auditKeys.map((p) => p.key)).toEqual(['audit.view'])
    // No channel offers writing/editing/deleting audit history at all.
    const auditChannels = [...handlers.keys()].filter((channel) => channel.includes('audit'))
    expect(auditChannels).toEqual(['admin:audit'])
  })
})
