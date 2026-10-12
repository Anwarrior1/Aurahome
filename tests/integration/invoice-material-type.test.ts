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
  listMaterialTypeOptions
} from '@main/services/catalog/catalog.service'
import { createQuotation, getQuotation, updateQuotation } from '@main/services/sales/quotations.service'
import {
  createFinalInvoice,
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
 * "نوع المادة" (materialType) on invoice lines, linked to Raw Materials.
 *
 * Unlike accessories, "نوع المادة" is not scoped to any flagged
 * category — it describes what a custom/standard item is made from in
 * general, so the source is every ACTIVE Raw Material. Each picked
 * line stores the stable material reference PLUS a frozen snapshot of
 * its name in the pre-existing `materialType` text column — the same
 * reference+snapshot shape already established for accessories/terms,
 * so renaming or deleting the material can never rewrite an existing
 * document.
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

function seedCatalog() {
  const cat = createCategory({ name: 'مواد عامة' }, env.ctx)
  const mdf = createMaterial(
    { sku: 'MDF-18W', name: 'MDF أبيض 18mm', categoryId: cat, unit: 'لوح', pricingRule: 'exact' },
    env.ctx
  )
  const beech = createMaterial(
    { sku: 'WD-BEECH', name: 'خشب زان', categoryId: cat, unit: 'لوح', pricingRule: 'exact' },
    env.ctx
  )
  return { cat, mdf, beech }
}

const customer = () => createCustomer({ name: 'عميل' }, env.ctx)

describe('1/12 — the selector loads active Raw Materials, and only those', () => {
  it('lists an active material', () => {
    const { mdf } = seedCatalog()
    expect(listMaterialTypeOptions().map((m) => m.id)).toContain(mdf)
  })

  it('never lists a deactivated material for new selection', () => {
    const { mdf } = seedCatalog()
    updateMaterial(mdf, { active: false }, env.ctx)
    expect(listMaterialTypeOptions().map((m) => m.id)).not.toContain(mdf)
  })

  it('is not restricted to any category — unlike accessories, every active material qualifies', () => {
    const catA = createCategory({ name: 'أ' }, env.ctx)
    const catB = createCategory({ name: 'ب' }, env.ctx)
    const a = createMaterial({ sku: 'A-1', name: 'مادة أ', categoryId: catA, unit: 'قطعة', pricingRule: 'exact' }, env.ctx)
    const b = createMaterial({ sku: 'B-1', name: 'مادة ب', categoryId: catB, unit: 'قطعة', pricingRule: 'exact' }, env.ctx)
    const ids = listMaterialTypeOptions().map((m) => m.id)
    expect(ids).toEqual(expect.arrayContaining([a, b]))
  })
})

describe('4/5 — Preliminary Invoice saves and restores the reference (items 4, 5)', () => {
  it('saves the reference and freezes the name as the snapshot', () => {
    const { mdf } = seedCatalog()
    const { id } = createQuotation(
      { customerId: customer(), lines: [{ ...LINE, materialTypeMaterialId: mdf }] },
      env.ctx
    )
    const line = getDatabase().select().from(quotationLines).where(eq(quotationLines.quotationId, id)).get()!
    expect(line.materialTypeMaterialId).toBe(mdf)
    expect(line.materialType).toBe('MDF أبيض 18mm')
  })

  it('restores the selection when the document is reopened', () => {
    const { mdf } = seedCatalog()
    const { id } = createQuotation(
      { customerId: customer(), lines: [{ ...LINE, materialTypeMaterialId: mdf }] },
      env.ctx
    )
    const reopened = getQuotation(id)
    expect(reopened.lines[0]!.materialTypeMaterialId).toBe(mdf)
    expect(reopened.lines[0]!.materialType).toBe('MDF أبيض 18mm')
  })

  it('keeps the reference through an edit that does not resend the lines', () => {
    const { mdf } = seedCatalog()
    const { id } = createQuotation(
      { customerId: customer(), lines: [{ ...LINE, materialTypeMaterialId: mdf }] },
      env.ctx
    )
    updateQuotation(id, { notes: 'ملاحظة' }, env.ctx)
    expect(getQuotation(id).lines[0]!.materialTypeMaterialId).toBe(mdf)
  })

  it('refuses a reference that does not exist rather than storing a dangling link', () => {
    seedCatalog()
    expect(() =>
      createQuotation({ customerId: customer(), lines: [{ ...LINE, materialTypeMaterialId: 999_999 }] }, env.ctx)
    ).toThrowError(/المادة المحددة غير موجودة/)
  })
})

describe('6 — the saved snapshot reaches the internal work sheet (the field\'s existing print path)', () => {
  it('the material name printed on the work sheet is the frozen snapshot, not a live lookup', () => {
    const { mdf } = seedCatalog()
    const { id } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, materialTypeMaterialId: mdf }] },
      env.ctx
    )
    const { orderId } = approveFinalInvoice(id, env.ctx)
    recordPayment({ orderId, amountMinor: moneyFromMajor(1000) }, env.ctx) // BR-42 60% deposit
    const sheet = issueWorkSheet({ orderId }, env.ctx)
    expect(JSON.stringify(buildWorkSheet(sheet.id, env.ctx))).toContain('MDF أبيض 18mm')
  })
})

describe('7/8/9 — Approved Invoice behaves identically, approval and order creation unaffected', () => {
  it('saves and restores the reference plus its snapshot', () => {
    const { mdf } = seedCatalog()
    const { id } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, materialTypeMaterialId: mdf }] },
      env.ctx
    )
    const line = getFinalInvoiceLines(id)[0]!
    expect(line.materialTypeMaterialId).toBe(mdf)
    expect(line.materialType).toBe('MDF أبيض 18mm')
  })

  it('keeps the reference through an edit that does not resend the lines', () => {
    const { mdf } = seedCatalog()
    const { id } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, materialTypeMaterialId: mdf }] },
      env.ctx
    )
    updateFinalInvoice(id, { address: 'طرابلس' }, env.ctx)
    expect(getFinalInvoiceLines(id)[0]!.materialTypeMaterialId).toBe(mdf)
  })

  it('approves and creates the order without any regression, carrying the link onto the order line', () => {
    const { mdf } = seedCatalog()
    const { id } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, materialTypeMaterialId: mdf }] },
      env.ctx
    )
    const { orderId } = approveFinalInvoice(id, env.ctx)
    const order = getOrderOrThrow(orderId)
    expect(order.id).toBe(orderId)

    const line = getDatabase().select().from(orderLines).where(eq(orderLines.orderId, orderId)).get()!
    expect(line.materialTypeMaterialId).toBe(mdf)
    expect(line.materialType).toBe('MDF أبيض 18mm')
  })

  it('approval still works for a line with no material type selected at all', () => {
    seedCatalog()
    const { id } = createFinalInvoice({ customerId: customer(), lines: [LINE] }, env.ctx)
    const { orderId } = approveFinalInvoice(id, env.ctx)
    const line = getDatabase().select().from(orderLines).where(eq(orderLines.orderId, orderId)).get()!
    expect(line.materialTypeMaterialId).toBeNull()
    expect(line.materialType).toBeNull()
  })
})

describe('10/11/13 — legacy data and history are never rewritten or erased', () => {
  it('keeps a legacy free-text "نوع المادة" readable, with no reference', () => {
    const { id } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, materialType: 'MDF أبيض مكتوب يدوياً' }] },
      env.ctx
    )
    const line = getFinalInvoiceLines(id)[0]!
    expect(line.materialType).toBe('MDF أبيض مكتوب يدوياً')
    expect(line.materialTypeMaterialId).toBeNull()
  })

  it('renaming the Raw Material does not rewrite an existing document', () => {
    const { mdf } = seedCatalog()
    const { id: quoteId } = createQuotation(
      { customerId: customer(), lines: [{ ...LINE, materialTypeMaterialId: mdf }] },
      env.ctx
    )
    const { id: invoiceId } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, materialTypeMaterialId: mdf }] },
      env.ctx
    )

    updateMaterial(mdf, { name: 'MDF أبيض (تمت إعادة التسمية)' }, env.ctx)

    expect(getQuotation(quoteId).lines[0]!.materialType).toBe('MDF أبيض 18mm')
    expect(getFinalInvoiceLines(invoiceId)[0]!.materialType).toBe('MDF أبيض 18mm')
  })

  it('deleting/archiving the material leaves old documents intact and the catalog stays clean', () => {
    const { mdf } = seedCatalog()
    const { id: invoiceId } = createFinalInvoice(
      { customerId: customer(), lines: [{ ...LINE, materialTypeMaterialId: mdf }] },
      env.ctx
    )
    // Referenced by a document, so it archives rather than hard-deletes.
    expect(deleteMaterial(mdf, env.ctx)).toEqual({ deleted: false, archived: true })

    expect(listMaterialTypeOptions().map((m) => m.id)).not.toContain(mdf)
    expect(getFinalInvoiceLines(invoiceId)[0]!.materialType).toBe('MDF أبيض 18mm')
    expect(getFinalInvoiceLines(invoiceId)[0]!.materialTypeMaterialId).toBe(mdf)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})

describe('14/15 — no stock or costing side effects', () => {
  it('selecting a material type moves no stock and changes no total', () => {
    const { mdf } = seedCatalog()
    const cid = customer()

    const stockBefore = stockLevels({})

    const { id: withType } = createFinalInvoice(
      { customerId: cid, lines: [{ ...LINE, materialTypeMaterialId: mdf }] },
      env.ctx
    )

    // Identical to the same line with no material type at all.
    const { id: plain } = createFinalInvoice({ customerId: cid, lines: [LINE] }, env.ctx)
    const withTypeLine = getFinalInvoiceLines(withType)[0]!
    const plainLine = getFinalInvoiceLines(plain)[0]!
    expect(withTypeLine.lineTotalMinor).toBe(plainLine.lineTotalMinor)
    expect(withTypeLine.unitPriceMinor).toBe(plainLine.unitPriceMinor)

    expect(stockLevels({})).toEqual(stockBefore)
    approveFinalInvoice(withType, env.ctx)
    expect(stockLevels({})).toEqual(stockBefore)
  })
})

describe('16 — RBAC is unchanged', () => {
  const invoke = async (channel: string, payload: unknown, webContentsId: number) => {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, p: unknown) => Promise<IpcResult<unknown>>>()
    const electron = await import('electron')
    const spy = vi
      .spyOn(electron.ipcMain, 'handle')
      .mockImplementation(((channel2: string, handler: never) => { handlers.set(channel2, handler) }) as never)
    const { registerIpcRouter } = await import('@main/ipc/router')
    registerIpcRouter()
    spy.mockRestore()
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler registered for ${channel}`)
    return handler({ sender: { id: webContentsId } } as never, payload)
  }

  it('a user without sales-document access cannot read the material-type catalog', async () => {
    seedCatalog()
    const roleId = createRole({ name: 'بدون مبيعات', permissions: [P.reports.view] }, env.ctx)
    createUser({ username: 'nosales2', password: 'secret789', fullName: 'بدون', roleId }, env.ctx)
    login('nosales2', 'secret789', 177)

    const res = await invoke(IPC_CHANNELS.materials.types, undefined, 177)
    expect(res.ok).toBe(false)
  })

  it('a user who may view sales documents can read it without Raw Materials permissions', async () => {
    const { mdf } = seedCatalog()
    const roleId = createRole({ name: 'مبيعات2', permissions: [P.quotations.view] }, env.ctx)
    createUser({ username: 'sales3', password: 'secret789', fullName: 'مبيعات', roleId }, env.ctx)
    login('sales3', 'secret789', 178)

    const res = await invoke(IPC_CHANNELS.materials.types, undefined, 178)
    expect(res.ok).toBe(true)
    expect(JSON.stringify(res)).toContain(String(mdf))
  })

  it('picking a material type never grants Raw Materials create rights', async () => {
    const { cat } = seedCatalog()
    const roleId = createRole({ name: 'مبيعات3', permissions: [P.quotations.view] }, env.ctx)
    createUser({ username: 'sales4', password: 'secret789', fullName: 'مبيعات', roleId }, env.ctx)
    login('sales4', 'secret789', 179)

    const res = await invoke(
      IPC_CHANNELS.materials.create,
      { sku: 'X-2', name: 'x', categoryId: cat, unit: 'قطعة', pricingRule: 'exact' },
      179
    )
    expect(res.ok).toBe(false)
  })
})

describe('database integrity', () => {
  it('stays clean through a full material-type lifecycle', () => {
    const { mdf } = seedCatalog()
    const cid = customer()
    const { id: q } = createQuotation({ customerId: cid, lines: [{ ...LINE, materialTypeMaterialId: mdf }] }, env.ctx)
    const { id: f } = createFinalInvoice({ customerId: cid, lines: [{ ...LINE, materialTypeMaterialId: mdf }] }, env.ctx)
    approveFinalInvoice(f, env.ctx)
    expect(getQuotation(q).lines[0]!.materialTypeMaterialId).toBe(mdf)

    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})
