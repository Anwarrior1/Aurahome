import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection, getDatabase } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import {
  createCategory,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  listAccessoryMaterials,
  updateCategory
} from '@main/services/catalog/catalog.service'
import { createQuotation, getQuotation, updateQuotation } from '@main/services/sales/quotations.service'
import {
  createFinalInvoice,
  getFinalInvoice,
  getFinalInvoiceLines,
  updateFinalInvoice,
  approveFinalInvoice
} from '@main/services/sales/final-invoices.service'
import { getOrderOrThrow, recordPayment } from '@main/services/sales/orders.service'
import { buildWorkSheet } from '@main/services/documents/documents.service'
import { issueWorkSheet } from '@main/services/production/production.service'
import { quotationLines, orderLines } from '@main/db/schema/sales.schema'
import { stockLevels } from '@main/services/inventory/valuation.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import { eq } from 'drizzle-orm'

/**
 * Invoice accessories linked to Raw Materials.
 *
 * BR-50: accessories are ordinary materials, told apart only by their
 * category. A category flagged `is_accessory` (plus everything nested
 * under it) is the source both sales documents pick from, and each
 * picked line stores the stable material reference PLUS a frozen
 * snapshot of its name — the same reference+snapshot shape
 * `final_invoice_terms` already uses, so renaming or deleting the
 * material can never rewrite an existing document.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const LINE = {
  lineKind: 'custom' as const,
  description: 'خزانة حسب الطلب',
  quantityMicro: quantityFromDisplay(1),
  unitPriceMinor: moneyFromMajor(1000)
}

/** An accessories category with one accessory, plus a non-accessory material. */
function seedCatalog() {
  const accCat = createCategory({ name: 'إكسسوارات', isAccessory: true }, env.ctx)
  const woodCat = createCategory({ name: 'أخشاب' }, env.ctx)
  const handle = createMaterial(
    { sku: 'ACC-001', name: 'مقبض ذهبي', categoryId: accCat, unit: 'قطعة', pricingRule: 'exact' },
    env.ctx
  )
  const mdf = createMaterial(
    { sku: 'MDF-18', name: 'خشب MDF', categoryId: woodCat, unit: 'لوح', pricingRule: 'exact' },
    env.ctx
  )
  return { accCat, woodCat, handle, mdf }
}

const customer = () => createCustomer({ name: 'عميل' }, env.ctx)

describe('1-2 — the selector shows accessories and nothing else', () => {
  it('lists a material in a flagged category, and never a non-accessory one', () => {
    const { handle, mdf } = seedCatalog()
    const list = listAccessoryMaterials()
    expect(list.map((m) => m.id)).toContain(handle)
    expect(list.map((m) => m.id)).not.toContain(mdf)
    expect(list[0]).toMatchObject({ sku: 'ACC-001', name: 'مقبض ذهبي' })
  })

  it('rolls the flag down the whole subtree, exactly like category filtering does', () => {
    const accCat = createCategory({ name: 'إكسسوارات', isAccessory: true }, env.ctx)
    const hinges = createCategory({ name: 'مفصلات', parentId: accCat }, env.ctx)
    const deep = createCategory({ name: 'مفصلات مخفية', parentId: hinges }, env.ctx)
    const nested = createMaterial(
      { sku: 'ACC-009', name: 'مفصلة مخفية', categoryId: deep, unit: 'قطعة', pricingRule: 'exact' },
      env.ctx
    )
    expect(listAccessoryMaterials().map((m) => m.id)).toContain(nested)
  })

  it('offers nothing at all when no category is flagged — never the whole material master', () => {
    const woodCat = createCategory({ name: 'أخشاب' }, env.ctx)
    createMaterial({ sku: 'MDF-18', name: 'خشب MDF', categoryId: woodCat, unit: 'لوح', pricingRule: 'exact' }, env.ctx)
    expect(listAccessoryMaterials()).toEqual([])
  })

  it('drops a material from the catalog once it is deactivated', () => {
    const { handle } = seedCatalog()
    updateMaterial(handle, { active: false }, env.ctx)
    expect(listAccessoryMaterials().map((m) => m.id)).not.toContain(handle)
  })

  it('follows the flag being turned off again', () => {
    const { accCat, handle } = seedCatalog()
    expect(listAccessoryMaterials().map((m) => m.id)).toContain(handle)
    updateCategory(accCat, { isAccessory: false }, env.ctx)
    expect(listAccessoryMaterials()).toEqual([])
  })
})

describe('3-5 — Preliminary Invoice stores, restores and prints the accessory', () => {
  it('saves the reference and freezes the name as the snapshot', () => {
    const { handle } = seedCatalog()
    const { id } = createQuotation(
      { customerId: customer(), lines: [{ ...LINE, accessoryMaterialId: handle }] },
      env.ctx
    )
    const line = getDatabase().select().from(quotationLines).where(eq(quotationLines.quotationId, id)).get()!
    expect(line.accessoryMaterialId).toBe(handle)
    expect(line.accessories).toBe('مقبض ذهبي')
  })

  it('restores the selection when the document is reopened', () => {
    const { handle } = seedCatalog()
    const { id } = createQuotation(
      { customerId: customer(), lines: [{ ...LINE, accessoryMaterialId: handle }] },
      env.ctx
    )
    const reopened = getQuotation(id)
    expect(reopened.lines[0]!.accessoryMaterialId).toBe(handle)
    expect(reopened.lines[0]!.accessories).toBe('مقبض ذهبي')
  })

  it('carries the snapshot to the manufacturing output that actually prints it', () => {
    // Customer-facing invoice documents deliberately show only
    // description/quantity/price; accessories print on the internal work
    // sheet. That existing split is left exactly as it is.
    const { handle } = seedCatalog()
    const { id } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, accessoryMaterialId: handle }] },
      env.ctx
    )
    const { orderId } = approveFinalInvoice(id, env.ctx)
    // BR-42: a work sheet needs its 60% deposit received first.
    recordPayment({ orderId, amountMinor: moneyFromMajor(1000) }, env.ctx)
    const sheet = issueWorkSheet({ orderId }, env.ctx)
    expect(JSON.stringify(buildWorkSheet(sheet.id, env.ctx))).toContain('مقبض ذهبي')
  })

  it('keeps the reference through an edit that does not resend the lines', () => {
    const { handle } = seedCatalog()
    const { id } = createQuotation(
      { customerId: customer(), lines: [{ ...LINE, accessoryMaterialId: handle }] },
      env.ctx
    )
    updateQuotation(id, { notes: 'ملاحظة' }, env.ctx)
    expect(getQuotation(id).lines[0]!.accessoryMaterialId).toBe(handle)
  })
})

describe('6-7 — Approved Invoice behaves identically', () => {
  it('saves and restores the reference plus its snapshot', () => {
    const { handle } = seedCatalog()
    const { id } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, accessoryMaterialId: handle }] },
      env.ctx
    )
    const line = getFinalInvoiceLines(id)[0]!
    expect(line.accessoryMaterialId).toBe(handle)
    expect(line.accessories).toBe('مقبض ذهبي')
  })

  it('keeps the reference through an edit that does not resend the lines', () => {
    const { handle } = seedCatalog()
    const { id } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, accessoryMaterialId: handle }] },
      env.ctx
    )
    updateFinalInvoice(id, { address: 'طرابلس' }, env.ctx)
    expect(getFinalInvoiceLines(id)[0]!.accessoryMaterialId).toBe(handle)
  })

  it('refuses a reference that does not exist rather than storing a dangling link', () => {
    seedCatalog()
    expect(() =>
      createFinalInvoice(
        { customerId: customer(), lines: [{ ...LINE, accessoryMaterialId: 999_999 }] },
        env.ctx
      )
    ).toThrowError(/الإكسسوار المحدد غير موجود/)
  })
})

describe('8-9 — approval and Customer Order creation are unchanged', () => {
  it('approves, creates the order, and carries the accessory link onto the order line', () => {
    const { handle } = seedCatalog()
    const { id } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, accessoryMaterialId: handle }] },
      env.ctx
    )
    const { orderId } = approveFinalInvoice(id, env.ctx)
    const order = getOrderOrThrow(orderId)
    expect(order.id).toBe(orderId)

    const line = getDatabase().select().from(orderLines).where(eq(orderLines.orderId, orderId)).get()!
    expect(line.accessoryMaterialId).toBe(handle)
    expect(line.accessories).toBe('مقبض ذهبي')
  })

  it('approval still works for a line with no accessory at all', () => {
    seedCatalog()
    const { id } = createFinalInvoice({ customerId: customer(), lines: [LINE] }, env.ctx)
    const { orderId } = approveFinalInvoice(id, env.ctx)
    const line = getDatabase().select().from(orderLines).where(eq(orderLines.orderId, orderId)).get()!
    expect(line.accessoryMaterialId).toBeNull()
    expect(line.accessories).toBeNull()
  })
})

describe('10-12 — history is never rewritten or erased', () => {
  it('keeps a legacy free-text accessory readable, with no reference', () => {
    // Exactly what pre-link documents hold: typed text, no material.
    const { id } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, accessories: 'مقبض قديم مكتوب يدوياً' }] },
      env.ctx
    )
    const line = getFinalInvoiceLines(id)[0]!
    expect(line.accessories).toBe('مقبض قديم مكتوب يدوياً')
    expect(line.accessoryMaterialId).toBeNull()
  })

  it('renaming the Raw Material does not rewrite an existing document', () => {
    const { handle } = seedCatalog()
    const { id: quoteId } = createQuotation(
      { customerId: customer(), lines: [{ ...LINE, accessoryMaterialId: handle }] },
      env.ctx
    )
    const { id: invoiceId } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, accessoryMaterialId: handle }] },
      env.ctx
    )

    updateMaterial(handle, { name: 'مقبض فضي (تمت إعادة التسمية)' }, env.ctx)

    // Both documents still read as they did when they were written.
    expect(getQuotation(quoteId).lines[0]!.accessories).toBe('مقبض ذهبي')
    expect(getFinalInvoiceLines(invoiceId)[0]!.accessories).toBe('مقبض ذهبي')
  })

  it('removing the accessory from the current master leaves old documents intact', () => {
    const { handle } = seedCatalog()
    const { id: invoiceId } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, accessoryMaterialId: handle }] },
      env.ctx
    )
    // An accessory that a document already references is history: the
    // master archives it rather than hard-deleting, so the document's
    // link survives alongside its frozen snapshot.
    expect(deleteMaterial(handle, env.ctx)).toEqual({ deleted: false, archived: true })

    // Gone from what NEW documents may pick...
    expect(listAccessoryMaterials().map((m) => m.id)).not.toContain(handle)
    // ...while the existing document keeps both its reference and text.
    expect(getFinalInvoiceLines(invoiceId)[0]!.accessoryMaterialId).toBe(handle)
    expect(getFinalInvoiceLines(invoiceId)[0]!.accessories).toBe('مقبض ذهبي')
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})

describe('13-14 — no stock or financial side effects', () => {
  it('selecting an accessory moves no stock and changes no total', () => {
    const { handle } = seedCatalog()
    const cid = customer()

    const { id: plain } = createFinalInvoice({ customerId: cid, lines: [LINE] }, env.ctx)
    const plainTotal = getFinalInvoice(plain).invoice.totalMinor
    const stockBefore = stockLevels({})

    const { id: withAccessory } = createFinalInvoice(
      { customerId: cid, lines: [{ ...LINE, accessoryMaterialId: handle }] },
      env.ctx
    )

    // Identical money, and not one inventory movement.
    expect(getFinalInvoice(withAccessory).invoice.totalMinor).toBe(plainTotal)
    expect(stockLevels({})).toEqual(stockBefore)

    approveFinalInvoice(withAccessory, env.ctx)
    expect(stockLevels({})).toEqual(stockBefore)
  })
})

describe('15 — RBAC is unchanged', () => {
  let handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => Promise<IpcResult<unknown>>>
  let event: IpcMainInvokeEvent
  let windowId = 500

  beforeEach(async () => {
    windowId += 1
    event = { sender: { id: windowId } } as IpcMainInvokeEvent
    handlers = new Map()
    const electron = await import('electron')
    const spy = vi
      .spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
  })

  const invoke = (channel: string, request?: unknown) => handlers.get(channel)!(event, request)

  function signInWith(permissions: string[]): void {
    const roleId = createRole({ name: `دور-${Math.random()}`, permissions }, env.ctx)
    const username = `user${Math.floor(Math.random() * 1e9)}`
    createUser({ username, password: 'secret789', fullName: 'مستخدم', roleId }, env.ctx)
    login(username, 'secret789', windowId)
  }

  it('a user without sales-document access cannot read the accessory catalog', async () => {
    seedCatalog()
    signInWith([P.reports.view])
    expect((await invoke(IPC_CHANNELS.materials.accessories)).ok).toBe(false)
  })

  it('a user who may view sales documents can read it without Raw Materials permissions', async () => {
    const { handle } = seedCatalog()
    signInWith([P.quotations.view])
    const res = await invoke(IPC_CHANNELS.materials.accessories)
    expect(res.ok).toBe(true)
    expect(JSON.stringify(res)).toContain(String(handle))
  })

  it('picking accessories never grants Raw Materials create rights', async () => {
    const { accCat } = seedCatalog()
    signInWith([P.quotations.view])
    const res = await invoke(IPC_CHANNELS.materials.create, {
      sku: 'X-1', name: 'x', categoryId: accCat, unit: 'قطعة', pricingRule: 'exact'
    })
    expect(res.ok).toBe(false)
  })
})

describe('database integrity', () => {
  it('stays clean through a full accessory lifecycle', () => {
    const { handle } = seedCatalog()
    const cid = customer()
    const { id: q } = createQuotation({ customerId: cid, lines: [{ ...LINE, accessoryMaterialId: handle }] }, env.ctx)
    const { id: f } = createFinalInvoice({ customerId: cid, lines: [{ ...LINE, accessoryMaterialId: handle }] }, env.ctx)
    approveFinalInvoice(f, env.ctx)
    expect(getQuotation(q).lines[0]!.accessoryMaterialId).toBe(handle)

    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})
