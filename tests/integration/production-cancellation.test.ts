import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import { getRawConnection } from '@main/db/connection'
import { createCustomer } from '@main/services/parties/parties.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import {
  issueWorkSheet,
  completeProduction,
  cancelProductionOrder,
  getProductionOrder,
  getWorkSheetOrThrow
} from '@main/services/production/production.service'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'

/**
 * The "إلغاء الأمر" bug: the renderer collected the cancellation reason
 * through `window.prompt()`, which Electron's BrowserWindow does not
 * implement — it returns null without ever showing a dialog, so the
 * reason check silently short-circuited and the `production.cancelProduction`
 * IPC call was never even issued. The backend service below was already
 * correct; these tests pin its behaviour so a future regression shows up
 * here even if a renderer-only bug were reintroduced.
 */
let env: TestEnv
let seq = 0
beforeEach(() => { env = setupTestDatabase(); seq = 0 })
afterEach(() => env.cleanup())

function unique(prefix: string): string { return `${prefix}-${++seq}` }

function openWorkSheet() {
  const customerId = createCustomer({ name: unique('عميل') }, env.ctx)
  const invoice = createFinalInvoice({
    customerId,
    lines: [{ lineKind: 'custom', description: 'منتج', quantityMicro: quantityFromDisplay(1), unitPriceMinor: moneyFromMajor(2000) }]
  }, env.ctx)
  const order = approveToOrder(invoice.id, env.ctx)
  recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(2000) }, env.ctx)
  const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
  return { order, sheet }
}

describe('1 — an eligible production order cancels and the CANCELLED status persists', () => {
  it('cancelProductionOrder writes the canonical cancelled status, timestamp and reason', () => {
    const { sheet } = openWorkSheet()

    cancelProductionOrder({ id: sheet.id, reason: 'خطأ في الطلب' }, env.ctx)

    const fresh = getWorkSheetOrThrow(sheet.id)
    expect(fresh.status).toBe('cancelled')
    expect(fresh.cancelledAt).toBeTruthy()
    expect(fresh.cancelReason).toBe('خطأ في الطلب')
  })
})

describe('2 — reloading/reading again still shows it cancelled', () => {
  it('a brand-new read (getProductionOrder, simulating an app reopen) reports cancelled', () => {
    const { sheet } = openWorkSheet()
    cancelProductionOrder({ id: sheet.id, reason: 'إعادة تخطيط' }, env.ctx)

    // Two independent reads, exactly as a reloaded page/reopened app
    // would each issue their own fresh query — neither is served from
    // any in-memory state left over from the cancel call itself.
    const firstRead = getProductionOrder(sheet.id)
    const secondRead = getProductionOrder(sheet.id)
    expect(firstRead.sheet.status).toBe('cancelled')
    expect(firstRead.sheet.statusLabel).toBe('ملغى')
    expect(secondRead.sheet.status).toBe('cancelled')
  })

  it('a cancelled production order no longer accepts execution postings — it truly stops behaving as active', () => {
    const { sheet } = openWorkSheet()
    cancelProductionOrder({ id: sheet.id, reason: 'إلغاء' }, env.ctx)

    expect(() => completeProduction(sheet.id, env.ctx)).toThrowError(/لا يمكن نقل/)
  })
})

describe('3 — an invalid cancellation reports the exact blocker and mutates nothing', () => {
  it('refuses to cancel an already-completed production order', () => {
    const { sheet } = openWorkSheet()
    completeProduction(sheet.id, env.ctx)
    const before = getWorkSheetOrThrow(sheet.id)

    expect(() => cancelProductionOrder({ id: sheet.id, reason: 'خطأ' }, env.ctx))
      .toThrowError(/لا يمكن نقل أمر التصنيع من "مكتمل" إلى "ملغى"/)

    const after = getWorkSheetOrThrow(sheet.id)
    expect(after.status).toBe(before.status)
    expect(after.status).toBe('completed')
    expect(after.cancelledAt).toBeNull()
    expect(after.cancelReason).toBeNull()
  })

  it('refuses a cancellation without a reason and mutates nothing', () => {
    const { sheet } = openWorkSheet()

    expect(() => cancelProductionOrder({ id: sheet.id, reason: '   ' }, env.ctx))
      .toThrowError(/سبب الإلغاء مطلوب/)

    const after = getWorkSheetOrThrow(sheet.id)
    expect(after.status).toBe('ready')
    expect(after.cancelledAt).toBeNull()
  })
})

describe('4 — a forced failure during cancellation rolls back completely', () => {
  it('leaves the production order exactly as it was, with no partial status/audit change', () => {
    const { sheet } = openWorkSheet()
    const auditCountBefore = getRawConnection()
      .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity = 'work_sheets' AND entity_id = ?")
      .get(String(sheet.id)) as { c: number }

    getRawConnection().exec(
      "CREATE TRIGGER test_block_worksheet_cancel BEFORE UPDATE ON work_sheets BEGIN SELECT RAISE(ABORT, 'forced rollback'); END"
    )

    expect(() => cancelProductionOrder({ id: sheet.id, reason: 'خطأ' }, env.ctx)).toThrow()

    const after = getWorkSheetOrThrow(sheet.id)
    expect(after.status).toBe('ready')
    expect(after.cancelledAt).toBeNull()
    expect(after.cancelReason).toBeNull()
    const auditCountAfter = getRawConnection()
      .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity = 'work_sheets' AND entity_id = ?")
      .get(String(sheet.id)) as { c: number }
    expect(auditCountAfter.c).toBe(auditCountBefore.c)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})
