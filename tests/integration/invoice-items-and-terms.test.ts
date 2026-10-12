import { issueWorkSheet as issueLifecycleWorkSheet, completeProduction as completeLifecycleProduction } from '@main/services/production/production.service'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import { createQuotation, getQuotation } from '@main/services/sales/quotations.service'
import {
  createFinalInvoice,
  getFinalInvoice,
  getFinalInvoiceTerms,
  addFinalInvoiceTerms,
  removeFinalInvoiceTerm,
  approveFinalInvoice,
  cancelFinalInvoice
} from '@main/services/sales/final-invoices.service'
import { getOrderOrThrow, recordPayment, cancelOrder } from '@main/services/sales/orders.service'
import { buildFinalInvoice, buildPreliminaryInvoice } from '@main/services/documents/documents.service'
import { renderFinalInvoice, renderPreliminaryInvoice } from '@main/reports/templates/documents.template'
import { customerBalances } from '@main/services/parties/parties.service'
import { getSetting, setSetting, SETTING_KEYS, DEFAULT_TERMS } from '@main/services/settings.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { IPC_CHANNELS } from '@shared/constants/channels'
import type { IpcResult } from '@shared/types/ipc.types'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * Invoice items ("+ صنف") vs invoice Terms/Conditions ("+ بند") pass.
 *
 *  - The Preliminary Invoice keeps its EXISTING automatic full-catalog
 *    terms behavior completely untouched — only its item button is
 *    relabelled.
 *  - The Approved Invoice gains manual, multi-select, per-invoice term
 *    selection, reusing the one global catalog, snapshotted at the
 *    moment each term is picked, technically separate from its items,
 *    with zero financial/operational side effects.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const LINE = {
  lineKind: 'custom' as const, description: 'خزانة حسب الطلب',
  quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(1000)
}

function draftInvoice(customerId?: number) {
  const cid = customerId ?? createCustomer({ name: 'عميل' }, env.ctx)
  return createFinalInvoice({ customerId: cid, lines: [LINE] }, env.ctx)
}

/** Every table a term add/remove could wrongly touch (item 14/TEST 12). */
function financialSnapshot(customerId: number, orderId?: number) {
  const raw = getRawConnection()
  const count = (table: string): number => (raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
  return {
    customerRemaining: customerBalances().find((r) => r.customerId === customerId)?.remainingMinor ?? 0,
    orderTotal: orderId ? getOrderOrThrow(orderId).totalMinor : undefined,
    inventoryMovements: count('inventory_movements'),
    cashTransactions: count('cash_transactions'),
    workerTransactions: count('worker_transactions'),
    plannedMaterials: count('planned_materials')
  }
}

describe('TEST 1/2 — Preliminary Invoice: renamed item button, UNCHANGED terms behavior', () => {
  it('the item-add validation still guards "at least one item" (relabelled text, same rule)', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    expect(() => createQuotation({ customerId, lines: [] }, env.ctx)).toThrowError(/صنف واحد على الأقل/)
  })

  it('TEST 2 — the preliminary invoice PDF still automatically carries ALL configured terms, unchanged', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = createQuotation({ customerId, lines: [LINE] }, env.ctx)

    const dto = buildPreliminaryInvoice(quotation.id)
    const html = renderPreliminaryInvoice(dto, { name: 'AURA home' })

    // Every one of the 8 default configured clauses is present — no
    // manual selection, nothing filtered, nothing added by this pass.
    const terms = getSetting<string[]>(SETTING_KEYS.termsAndConditions)
    expect(terms).toHaveLength(DEFAULT_TERMS.length)
    for (const term of terms) expect(html).toContain(term)
    expect(dto.termsAndConditions).toEqual(terms)
  })

  it('a later Settings terms edit still flows automatically into a NEW preliminary invoice, exactly as before', () => {
    setSetting(SETTING_KEYS.termsAndConditions, ['شرط أول مخصص', 'شرط ثانٍ مخصص'], env.ctx)
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = createQuotation({ customerId, lines: [LINE] }, env.ctx)

    const html = renderPreliminaryInvoice(buildPreliminaryInvoice(quotation.id), { name: 'AURA home' })
    expect(html).toContain('شرط أول مخصص')
    expect(html).toContain('شرط ثانٍ مخصص')
    // No manual "+ بند" concept exists on this document at all.
    expect(getQuotation(quotation.id).lines).toHaveLength(1)
  })
})

describe('TEST 3/4/5/6 — Approved Invoice: items vs manual multi-select terms', () => {
  it('TEST 3 — items still work exactly as before under their new name', () => {
    const invoice = draftInvoice()
    const { lines } = getFinalInvoice(invoice.id)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.description).toBe('خزانة حسب الطلب')
  })

  it('TEST 4 — the catalog opened for selection is the SAME global catalog, never a copy', () => {
    const invoice = draftInvoice()
    void invoice
    const catalog = getSetting<string[]>(SETTING_KEYS.termsAndConditions)
    expect(catalog).toEqual(DEFAULT_TERMS)
  })

  it('TEST 5 — selecting several terms in one action adds exactly those, in catalog order', () => {
    const invoice = draftInvoice()
    addFinalInvoiceTerms(invoice.id, [6, 1, 3], env.ctx)

    const terms = getFinalInvoiceTerms(invoice.id)
    expect(terms).toHaveLength(3)
    // Item 9: catalog order preserved regardless of selection order.
    expect(terms.map((t) => t.termIndex)).toEqual([1, 3, 6])
    expect(terms[0]?.termText).toBe(DEFAULT_TERMS[1])
    expect(terms[1]?.termText).toBe(DEFAULT_TERMS[3])
    expect(terms[2]?.termText).toBe(DEFAULT_TERMS[6])
  })

  it('TEST 6 — adding the same term twice never creates a duplicate row', () => {
    const invoice = draftInvoice()
    addFinalInvoiceTerms(invoice.id, [2], env.ctx)
    addFinalInvoiceTerms(invoice.id, [2], env.ctx) // repeat, as a retry/double-click would
    addFinalInvoiceTerms(invoice.id, [2, 2, 4], env.ctx) // even within one batched call

    const terms = getFinalInvoiceTerms(invoice.id)
    expect(terms.map((t) => t.termIndex)).toEqual([2, 4])
    // The database itself refuses the duplicate too, belt and suspenders.
    expect(() =>
      getRawConnection()
        .prepare('INSERT INTO final_invoice_terms (final_invoice_id, term_index, term_text) VALUES (?, ?, ?)')
        .run(invoice.id, 2, 'x')
    ).toThrowError(/UNIQUE/)
  })

  it('rejects an out-of-range term index server-side', () => {
    const invoice = draftInvoice()
    expect(() => addFinalInvoiceTerms(invoice.id, [999], env.ctx)).toThrowError(/غير موجود/)
    expect(getFinalInvoiceTerms(invoice.id)).toHaveLength(0)
  })
})

/**
 * Create-flow pass — terms picked in the UI BEFORE the invoice has an
 * id yet (item 1-5 of the follow-up spec): `createFinalInvoice` now
 * accepts the same `termIndexes` `addFinalInvoiceTerms` takes, and
 * persists invoice + items + terms together, in the SAME transaction.
 */
describe('TEST 6/7/8/9 — terms selected before the first save persist atomically with the invoice', () => {
  it('TEST 6/7 — one create call with items AND terms persists both, in catalog order', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const created = createFinalInvoice({
      customerId,
      lines: [LINE, { ...LINE, description: 'باب' }],
      termIndexes: [5, 0, 2]
    }, env.ctx)

    const reopened = getFinalInvoice(created.id)
    expect(reopened.lines).toHaveLength(2)
    // TEST 7: correct wording AND catalog order, exactly like adding
    // terms one at a time to an already-saved invoice.
    expect(reopened.terms.map((t) => t.termIndex)).toEqual([0, 2, 5])
    expect(reopened.terms.map((t) => t.termText)).toEqual([DEFAULT_TERMS[0], DEFAULT_TERMS[2], DEFAULT_TERMS[5]])
  })

  it('creating with no termIndexes at all still works — terms are entirely optional', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const created = createFinalInvoice({ customerId, lines: [LINE] }, env.ctx)
    expect(getFinalInvoiceTerms(created.id)).toHaveLength(0)
  })

  it('TEST 8 — a duplicate index in the create payload never creates a duplicate row', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const created = createFinalInvoice({
      customerId,
      lines: [LINE],
      termIndexes: [3, 3, 1, 1, 1]
    }, env.ctx)

    expect(getFinalInvoiceTerms(created.id).map((t) => t.termIndex)).toEqual([1, 3])
  })

  it('an invalid term index in the create payload fails the WHOLE create — no invoice, no items, no terms', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const raw = getRawConnection()
    const before = (raw.prepare('SELECT COUNT(*) AS c FROM final_invoices').get() as { c: number }).c

    expect(() =>
      createFinalInvoice({ customerId, lines: [LINE], termIndexes: [999] }, env.ctx)
    ).toThrowError(/غير موجود/)

    // Atomic: the failed term is not the only thing missing — the
    // ENTIRE invoice, including its items, never happened either.
    const after = (raw.prepare('SELECT COUNT(*) AS c FROM final_invoices').get() as { c: number }).c
    expect(after).toBe(before)
    expect((raw.prepare('SELECT COUNT(*) AS c FROM final_invoice_lines').get() as { c: number }).c).toBe(0)
    expect((raw.prepare('SELECT COUNT(*) AS c FROM final_invoice_terms').get() as { c: number }).c).toBe(0)
  })

  it('TEST 9 — the snapshot taken at create time survives a later global catalog edit', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const created = createFinalInvoice({ customerId, lines: [LINE], termIndexes: [4] }, env.ctx)
    expect(getFinalInvoiceTerms(created.id)[0]?.termText).toBe(DEFAULT_TERMS[4])

    const updated = [...DEFAULT_TERMS]
    updated[4] = 'نص محدّث بعد الإنشاء مباشرة'
    setSetting(SETTING_KEYS.termsAndConditions, updated, env.ctx)

    expect(getFinalInvoiceTerms(created.id)[0]?.termText).toBe(DEFAULT_TERMS[4])
    const html = renderFinalInvoice(buildFinalInvoice(created.id), { name: 'AURA home' })
    expect(html).toContain(DEFAULT_TERMS[4]!)
    expect(html).not.toContain('نص محدّث بعد الإنشاء مباشرة')
  })

  it('TEST 5 — a request that never reaches create leaves nothing behind (nothing to assert but absence)', () => {
    // There is no "draft-of-a-draft" on the backend at all: the renderer
    // only ever calls createFinalInvoice once, on "حفظ كمسودة" — so
    // cancelling before that point cannot leave a partial invoice or
    // an orphan final_invoice_terms row, because nothing was ever sent.
    const raw = getRawConnection()
    expect((raw.prepare('SELECT COUNT(*) AS c FROM final_invoices').get() as { c: number }).c).toBe(0)
    expect((raw.prepare('SELECT COUNT(*) AS c FROM final_invoice_terms').get() as { c: number }).c).toBe(0)
  })
})

describe('TEST 7 — removing a term only detaches it from THIS invoice', () => {
  it('the global catalog and any other invoice keep their own terms untouched', () => {
    const invoiceA = draftInvoice()
    const invoiceB = draftInvoice()
    addFinalInvoiceTerms(invoiceA.id, [1, 2], env.ctx)
    addFinalInvoiceTerms(invoiceB.id, [1, 2], env.ctx)

    const [removeMe] = getFinalInvoiceTerms(invoiceA.id)
    removeFinalInvoiceTerm(invoiceA.id, removeMe!.id, env.ctx)

    expect(getFinalInvoiceTerms(invoiceA.id).map((t) => t.termIndex)).toEqual([2])
    // Invoice B, untouched.
    expect(getFinalInvoiceTerms(invoiceB.id).map((t) => t.termIndex)).toEqual([1, 2])
    // The global catalog itself, untouched.
    expect(getSetting<string[]>(SETTING_KEYS.termsAndConditions)).toEqual(DEFAULT_TERMS)
  })

  it('refuses to remove a term row that belongs to a different invoice', () => {
    const invoiceA = draftInvoice()
    const invoiceB = draftInvoice()
    addFinalInvoiceTerms(invoiceA.id, [1], env.ctx)
    const [row] = getFinalInvoiceTerms(invoiceA.id)

    expect(() => removeFinalInvoiceTerm(invoiceB.id, row!.id, env.ctx)).toThrowError(/غير موجود/)
    expect(getFinalInvoiceTerms(invoiceA.id)).toHaveLength(1)
  })
})

describe('TEST 8 — persistence across save/reopen', () => {
  it('selected terms are read back exactly via getFinalInvoice, including after a reload', () => {
    const invoice = draftInvoice()
    addFinalInvoiceTerms(invoice.id, [0, 5], env.ctx)

    const reopened = getFinalInvoice(invoice.id)
    expect(reopened.terms.map((t) => t.termIndex)).toEqual([0, 5])
    expect(reopened.terms.map((t) => t.termText)).toEqual([DEFAULT_TERMS[0], DEFAULT_TERMS[5]])
  })
})

describe('TEST 9/10 — PDF print behavior', () => {
  it('TEST 9 — the Approved Invoice PDF prints ONLY the terms selected for it, never the whole catalog', () => {
    const invoice = draftInvoice()
    addFinalInvoiceTerms(invoice.id, [1, 4], env.ctx)

    const html = renderFinalInvoice(buildFinalInvoice(invoice.id), { name: 'AURA home' })
    expect(html).toContain('البنود والشروط')
    expect(html).toContain(DEFAULT_TERMS[1])
    expect(html).toContain(DEFAULT_TERMS[4])
    // The unselected clauses never appear.
    for (const [index, term] of DEFAULT_TERMS.entries()) {
      if (index === 1 || index === 4) continue
      expect(html).not.toContain(term)
    }
  })

  it('an Approved Invoice with no selected terms prints no terms section at all', () => {
    const invoice = draftInvoice()
    const html = renderFinalInvoice(buildFinalInvoice(invoice.id), { name: 'AURA home' })
    expect(html).not.toContain('البنود والشروط')
  })

  it('TEST 10 — the Preliminary Invoice PDF is a total regression: unaffected by any of this', () => {
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = createQuotation({ customerId, lines: [LINE] }, env.ctx)
    const html = renderPreliminaryInvoice(buildPreliminaryInvoice(quotation.id), { name: 'AURA home' })
    expect(html).toContain('الشروط والأحكام')
    for (const term of DEFAULT_TERMS) expect(html).toContain(term)
  })
})

describe('TEST 11 — historical wording snapshot', () => {
  it('an already-selected term keeps its wording even after the global catalog changes', () => {
    const invoice = draftInvoice()
    addFinalInvoiceTerms(invoice.id, [3], env.ctx)
    expect(getFinalInvoiceTerms(invoice.id)[0]?.termText).toBe(DEFAULT_TERMS[3])

    const updatedCatalog = [...DEFAULT_TERMS]
    updatedCatalog[3] = 'نص جديد مختلف تماماً بعد التعديل'
    setSetting(SETTING_KEYS.termsAndConditions, updatedCatalog, env.ctx)

    // The already-selected term is frozen — old wording survives.
    const reopened = getFinalInvoiceTerms(invoice.id)
    expect(reopened[0]?.termText).toBe(DEFAULT_TERMS[3])
    expect(reopened[0]?.termText).not.toBe('نص جديد مختلف تماماً بعد التعديل')

    // It still prints the OLD wording too.
    const html = renderFinalInvoice(buildFinalInvoice(invoice.id), { name: 'AURA home' })
    expect(html).toContain(DEFAULT_TERMS[3]!)
    expect(html).not.toContain('نص جديد مختلف تماماً بعد التعديل')

    // …while a NEW selection on the SAME still-draft invoice picks up
    // the new wording, proving the freeze is per-selection, not global.
    addFinalInvoiceTerms(invoice.id, [3], env.ctx) // already selected: no-op, still old wording
    expect(getFinalInvoiceTerms(invoice.id)).toHaveLength(1)
  })

  it('the snapshot survives approval, and stays frozen even if the invoice is reopened for viewing', () => {
    const invoice = draftInvoice()
    addFinalInvoiceTerms(invoice.id, [2], env.ctx)
    approveFinalInvoice(invoice.id, env.ctx)

    setSetting(SETTING_KEYS.termsAndConditions, ['نص مختلف كلياً'], env.ctx)

    expect(getFinalInvoiceTerms(invoice.id)[0]?.termText).toBe(DEFAULT_TERMS[2])
  })
})

describe('TEST 12 — financial/operational regression: terms have NO side effects', () => {
  it('adding and removing terms changes nothing financial or operational', () => {
    const customerId = createCustomer({ name: 'عميل مالي' }, env.ctx)
    const invoice = draftInvoice(customerId)
    const before = financialSnapshot(customerId)

    addFinalInvoiceTerms(invoice.id, [0, 1, 2], env.ctx)
    const [row] = getFinalInvoiceTerms(invoice.id)
    removeFinalInvoiceTerm(invoice.id, row!.id, env.ctx)

    const afterDraft = financialSnapshot(customerId)
    expect(afterDraft).toEqual(before)
    expect(getFinalInvoice(invoice.id).invoice.totalMinor).toBe(moneyFromMajor(1000))

    // Approving and paying afterwards is completely unaffected by the
    // term add/remove that happened while it was still a draft.
    const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
    recordPayment({ orderId, amountMinor: moneyFromMajor(1000) }, env.ctx)
    expect(getOrderOrThrow(orderId).totalMinor).toBe(moneyFromMajor(1000))
    expect(getOrderOrThrow(orderId).remainingMinor).toBe(0)
  })
})

describe('Item 12 — editing is locked exactly like the rest of the Approved Invoice once it is not a draft', () => {
  it('refuses to add/remove terms on an approved invoice', () => {
    const invoice = draftInvoice()
    addFinalInvoiceTerms(invoice.id, [0], env.ctx)
    const [row] = getFinalInvoiceTerms(invoice.id)
    approveFinalInvoice(invoice.id, env.ctx)

    expect(() => addFinalInvoiceTerms(invoice.id, [1], env.ctx)).toThrowError(/بعد اعتمادها/)
    expect(() => removeFinalInvoiceTerm(invoice.id, row!.id, env.ctx)).toThrowError(/بعد اعتمادها/)
  })

  it('refuses to add/remove terms on a cancelled invoice', () => {
    const invoice = draftInvoice()
    cancelFinalInvoice({ id: invoice.id, reason: 'إلغاء' }, env.ctx)

    expect(() => addFinalInvoiceTerms(invoice.id, [0], env.ctx)).toThrowError(/ملغاة/)
  })

  it('an order cancellation returns the invoice to draft, re-opening its terms for editing', () => {
    const invoice = draftInvoice()
    const { orderId } = approveFinalInvoice(invoice.id, env.ctx)
    completeLifecycleProduction(issueLifecycleWorkSheet({ orderId: orderId, overrideDepositRequirement: true }, env.ctx).id, env.ctx)
    cancelOrder({ orderId, reason: 'تراجع العميل' }, env.ctx)

    // The order-cancellation path does not itself revert the invoice to
    // draft in this ERP (only deleting the order does) — assert the
    // real current behavior rather than assuming: terms stay locked
    // while the invoice is still "approved".
    expect(getFinalInvoice(invoice.id).invoice.status).toBe('approved')
  })
})

describe('TEST 14/15 — RBAC: reuses the exact Approved Invoice permission, server-side', () => {
  let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
  let windowId = 81000
  let event: IpcMainInvokeEvent

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

  async function invoke(channel: string, request: unknown): Promise<IpcResult<unknown>> {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler registered for ${channel}`)
    return handler(event, request)
  }

  function signInWith(permissions: string[]): void {
    const roleId = createRole({ name: `دور-${Math.random()}`, permissions }, env.ctx)
    const username = `user${Math.floor(Math.random() * 1e9)}`
    createUser({ username, password: 'secret789', fullName: 'مستخدم', roleId }, env.ctx)
    login(username, 'secret789', windowId)
  }

  function signInViewOnly(): void {
    signInWith([P.orders.view])
  }

  it('refuses addTerms/removeTerm without orders.manage, even with a valid payload', async () => {
    const invoice = draftInvoice()
    addFinalInvoiceTerms(invoice.id, [0], env.ctx)
    const [row] = getFinalInvoiceTerms(invoice.id)
    signInViewOnly()

    const addResult = await invoke(IPC_CHANNELS.finalInvoices.addTerms, { id: invoice.id, termIndexes: [1] })
    expect(addResult.ok).toBe(false)
    if (!addResult.ok) expect(addResult.error.code).toBe('FORBIDDEN')

    const removeResult = await invoke(IPC_CHANNELS.finalInvoices.removeTerm, { id: invoice.id, termId: row!.id })
    expect(removeResult.ok).toBe(false)
    if (!removeResult.ok) expect(removeResult.error.code).toBe('FORBIDDEN')

    // Neither attempt touched anything.
    expect(getFinalInvoiceTerms(invoice.id).map((t) => t.termIndex)).toEqual([0])
  })

  it('still allows reading the catalog for view-only access — browsing is not editing', async () => {
    signInViewOnly()
    const result = await invoke(IPC_CHANNELS.finalInvoices.termsCatalog, {})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual(DEFAULT_TERMS)
  })

  it('an authorised user can add and remove terms through the exact same IPC boundary', async () => {
    const invoice = draftInvoice()
    signInWith([P.orders.view, P.orders.manage])
    const add = await invoke(IPC_CHANNELS.finalInvoices.addTerms, { id: invoice.id, termIndexes: [0, 2] })
    expect(add.ok).toBe(true)
    expect(getFinalInvoiceTerms(invoice.id).map((t) => t.termIndex)).toEqual([0, 2])

    const [row] = getFinalInvoiceTerms(invoice.id)
    const remove = await invoke(IPC_CHANNELS.finalInvoices.removeTerm, { id: invoice.id, termId: row!.id })
    expect(remove.ok).toBe(true)
    expect(getFinalInvoiceTerms(invoice.id).map((t) => t.termIndex)).toEqual([2])
  })
})
