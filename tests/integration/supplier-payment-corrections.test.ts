import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier, supplierBalances, supplierStatement } from '@main/services/parties/parties.service'
import {
  createPurchase,
  getPurchase,
  paySupplier,
  reverseSupplierPayment,
  updateSupplierPayment
} from '@main/services/purchasing/purchasing.service'
import { accountBalance, createAccount } from '@main/services/finance/cash.service'
import { getDatabase, getRawConnection, closeDatabase, setDatabasePath } from '@main/db/connection'
import { cashTransactions } from '@main/db/schema/finance.schema'
import { moneyFromMajor } from '@shared/money/money'
import { quantityFromDisplay } from '@shared/quantity/quantity'
import { unitCostFromMajor } from '@shared/money/cost'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

function invoice10k() {
  const categoryId = createCategory({ name: `فئة-${Math.random()}` }, env.ctx)
  const materialId = createMaterial({
    sku: `PAY-${Math.random()}`,
    name: 'مادة دفعة مورد',
    categoryId,
    unit: 'قطعة',
    currentMarketPriceMicro: unitCostFromMajor(1000),
    pricingRule: 'exact'
  }, env.ctx)
  const supplierId = createSupplier({ name: `مورد-${Math.random()}` }, env.ctx)
  const purchase = createPurchase({
    supplierId,
    purchaseDate: '2026-09-13',
    lines: [{
      materialId,
      qtyMicro: quantityFromDisplay(10),
      unitCostMicro: unitCostFromMajor(1000)
    }]
  }, env.ctx)
  return { supplierId, purchase }
}

function paymentCashRows(paymentId: number) {
  return getDatabase().select().from(cashTransactions).where(and(
    eq(cashTransactions.refTable, 'supplier_payments'),
    eq(cashTransactions.refId, paymentId)
  )).all()
}

describe('Supplier Payment edit/delete financial corrections', () => {
  it('edits 4,000 to 3,500 and then 4,200 using one payment and one corrected cash row', () => {
    const { supplierId, purchase } = invoice10k()
    const accountId = createAccount({
      name: 'صندوق دفعات المورد', kind: 'cash', openingBalanceMinor: moneyFromMajor(20_000)
    }, env.ctx)
    const paymentId = paySupplier({
      supplierId,
      purchaseId: purchase.id,
      amountMinor: moneyFromMajor(4000),
      cashAccountId: accountId,
      paidAt: '2026-09-10',
      notes: 'قبل التصحيح'
    }, env.ctx)

    updateSupplierPayment(paymentId, {
      amountMinor: moneyFromMajor(3500),
      cashAccountId: accountId,
      paidAt: '2026-09-11',
      notes: 'بعد التخفيض'
    }, env.ctx)

    expect(getPurchase(purchase.id).purchase).toMatchObject({
      paidMinor: moneyFromMajor(3500), paymentStatus: 'partial'
    })
    expect(supplierBalances().find((row) => row.supplierId === supplierId)).toMatchObject({
      paidMinor: moneyFromMajor(3500), remainingMinor: moneyFromMajor(6500)
    })
    expect(accountBalance(accountId)).toBe(moneyFromMajor(16_500))
    expect(paymentCashRows(paymentId)).toMatchObject([{
      amountMinor: moneyFromMajor(3500), accountId, occurredAt: '2026-09-11'
    }])

    updateSupplierPayment(paymentId, {
      amountMinor: moneyFromMajor(4200),
      cashAccountId: accountId,
      paidAt: '2026-09-12',
      notes: 'بعد الزيادة'
    }, env.ctx)

    expect(getPurchase(purchase.id).purchase.paidMinor).toBe(moneyFromMajor(4200))
    expect(supplierBalances().find((row) => row.supplierId === supplierId)).toMatchObject({
      paidMinor: moneyFromMajor(4200), remainingMinor: moneyFromMajor(5800)
    })
    expect(accountBalance(accountId)).toBe(moneyFromMajor(15_800))
    expect(paymentCashRows(paymentId)).toHaveLength(1)
    expect(paymentCashRows(paymentId)[0]).toMatchObject({ amountMinor: moneyFromMajor(4200) })
    const editAudit = getRawConnection().prepare(
      "SELECT details FROM audit_log WHERE action = 'purchases.pay.update' AND entity_id = ? ORDER BY id DESC LIMIT 1"
    ).get(String(paymentId)) as { details: string }
    expect(JSON.parse(editAudit.details)).toMatchObject({
      paymentId,
      supplierId,
      purchaseId: purchase.id,
      before: { amountMinor: moneyFromMajor(3500), cashAccountId: accountId },
      after: { amountMinor: moneyFromMajor(4200), cashAccountId: accountId },
      amountDeltaMinor: moneyFromMajor(700)
    })
  })

  it('moves a payment from Account A to B atomically without a duplicate withdrawal', () => {
    const { supplierId, purchase } = invoice10k()
    const accountA = createAccount({ name: 'صندوق أ', kind: 'cash', openingBalanceMinor: moneyFromMajor(10_000) }, env.ctx)
    const accountB = createAccount({ name: 'بنك ب', kind: 'bank', openingBalanceMinor: moneyFromMajor(10_000) }, env.ctx)
    const paymentId = paySupplier({ supplierId, purchaseId: purchase.id, amountMinor: moneyFromMajor(4000), cashAccountId: accountA }, env.ctx)

    updateSupplierPayment(paymentId, {
      amountMinor: moneyFromMajor(4000), cashAccountId: accountB, paidAt: '2026-09-13'
    }, env.ctx)

    expect(accountBalance(accountA)).toBe(moneyFromMajor(10_000))
    expect(accountBalance(accountB)).toBe(moneyFromMajor(6000))
    expect(paymentCashRows(paymentId)).toMatchObject([{ accountId: accountB, amountMinor: moneyFromMajor(4000) }])
    expect(supplierStatement(supplierId).payments.items).toMatchObject([{ id: paymentId, cashAccountId: accountB }])
  })

  it('deletes one payment and restores invoice, supplier and cash as if it never existed', () => {
    const { supplierId, purchase } = invoice10k()
    const accountId = createAccount({ name: 'صندوق الحذف', kind: 'cash', openingBalanceMinor: moneyFromMajor(10_000) }, env.ctx)
    const paymentId = paySupplier({ supplierId, purchaseId: purchase.id, amountMinor: moneyFromMajor(4000), cashAccountId: accountId }, env.ctx)

    reverseSupplierPayment(paymentId, env.ctx)

    expect(getPurchase(purchase.id).purchase).toMatchObject({ paidMinor: 0, paymentStatus: 'unpaid' })
    expect(getPurchase(purchase.id).payments).toEqual([])
    expect(supplierBalances().find((row) => row.supplierId === supplierId)).toMatchObject({
      paidMinor: 0, remainingMinor: moneyFromMajor(10_000)
    })
    expect(accountBalance(accountId)).toBe(moneyFromMajor(10_000))
    expect(paymentCashRows(paymentId)).toEqual([])
    const deleteAudit = getRawConnection().prepare(
      "SELECT details FROM audit_log WHERE action = 'purchases.pay.reverse' AND entity_id = ? ORDER BY id DESC LIMIT 1"
    ).get(String(paymentId)) as { details: string }
    expect(JSON.parse(deleteAudit.details)).toMatchObject({
      paymentId,
      supplierId,
      purchaseId: purchase.id,
      amountMinor: moneyFromMajor(4000),
      cashAccountId: accountId,
      reversedByUserId: env.ctx.session.user.id
    })
    expect(() => reverseSupplierPayment(paymentId, env.ctx)).toThrowError(/غير موجودة|حذفها/)
  })

  it('edits and deletes only the selected payment when multiple partial payments exist', () => {
    const { supplierId, purchase } = invoice10k()
    const accountId = createAccount({ name: 'صندوق الجزئي', kind: 'cash', openingBalanceMinor: moneyFromMajor(20_000) }, env.ctx)
    const paymentA = paySupplier({ supplierId, purchaseId: purchase.id, amountMinor: moneyFromMajor(2000), cashAccountId: accountId }, env.ctx)
    const paymentB = paySupplier({ supplierId, purchaseId: purchase.id, amountMinor: moneyFromMajor(3000), cashAccountId: accountId }, env.ctx)

    updateSupplierPayment(paymentA, {
      amountMinor: moneyFromMajor(1500), cashAccountId: accountId, paidAt: '2026-09-13'
    }, env.ctx)
    expect(getPurchase(purchase.id).purchase.paidMinor).toBe(moneyFromMajor(4500))
    expect(supplierBalances().find((row) => row.supplierId === supplierId)?.remainingMinor).toBe(moneyFromMajor(5500))
    expect(supplierStatement(supplierId).payments.items.find((row) => row.id === paymentB)?.amountMinor).toBe(moneyFromMajor(3000))

    reverseSupplierPayment(paymentA, env.ctx)
    expect(getPurchase(purchase.id).purchase.paidMinor).toBe(moneyFromMajor(3000))
    expect(supplierBalances().find((row) => row.supplierId === supplierId)).toMatchObject({
      paidMinor: moneyFromMajor(3000), remainingMinor: moneyFromMajor(7000)
    })
    expect(supplierStatement(supplierId).payments.items).toMatchObject([{ id: paymentB, amountMinor: moneyFromMajor(3000) }])
    expect(paymentCashRows(paymentB)).toHaveLength(1)
  })

  it('supports supplier advances instead of clamping a two-way balance to zero', () => {
    const { supplierId, purchase } = invoice10k()
    const paymentId = paySupplier({ supplierId, purchaseId: purchase.id, amountMinor: moneyFromMajor(10_500) }, env.ctx)
    expect(supplierBalances().find((row) => row.supplierId === supplierId)).toMatchObject({
      paidMinor: moneyFromMajor(10_500), remainingMinor: -moneyFromMajor(500)
    })
    updateSupplierPayment(paymentId, { amountMinor: moneyFromMajor(11_000), paidAt: '2026-09-13' }, env.ctx)
    expect(supplierBalances().find((row) => row.supplierId === supplierId)?.remainingMinor).toBe(-moneyFromMajor(1000))
  })

  it('persists edits and deletions across a database reopen', () => {
    const { supplierId, purchase } = invoice10k()
    const accountId = createAccount({ name: 'صندوق الاستمرارية', kind: 'cash', openingBalanceMinor: moneyFromMajor(20_000) }, env.ctx)
    const edited = paySupplier({ supplierId, purchaseId: purchase.id, amountMinor: moneyFromMajor(4000), cashAccountId: accountId }, env.ctx)
    const deleted = paySupplier({ supplierId, purchaseId: purchase.id, amountMinor: moneyFromMajor(1000), cashAccountId: accountId }, env.ctx)
    updateSupplierPayment(edited, { amountMinor: moneyFromMajor(3500), cashAccountId: accountId, paidAt: '2026-09-12' }, env.ctx)
    reverseSupplierPayment(deleted, env.ctx)
    const dbPath = join(env.dir, readdirSync(env.dir).find((name) => name.endsWith('.db'))!)

    closeDatabase()
    setDatabasePath(dbPath)

    expect(getPurchase(purchase.id).purchase.paidMinor).toBe(moneyFromMajor(3500))
    expect(supplierStatement(supplierId).payments.items).toMatchObject([{ id: edited, amountMinor: moneyFromMajor(3500) }])
    expect(accountBalance(accountId)).toBe(moneyFromMajor(16_500))
    expect(paymentCashRows(deleted)).toEqual([])
  })

  it('rejects invalid references, amounts, dates and stale payments without partial effects', () => {
    const { supplierId, purchase } = invoice10k()
    const accountId = createAccount({ name: 'صندوق التحقق', kind: 'cash', openingBalanceMinor: moneyFromMajor(10_000) }, env.ctx)
    const paymentId = paySupplier({ supplierId, purchaseId: purchase.id, amountMinor: moneyFromMajor(4000), cashAccountId: accountId }, env.ctx)

    expect(() => updateSupplierPayment(paymentId, { amountMinor: 0, paidAt: '2026-09-13' }, env.ctx)).toThrowError(/أكبر من صفر/)
    expect(() => updateSupplierPayment(paymentId, { amountMinor: moneyFromMajor(3500), paidAt: '2026-02-30' }, env.ctx)).toThrowError(/تاريخ/)
    expect(() => updateSupplierPayment(paymentId, { amountMinor: moneyFromMajor(3500), cashAccountId: 999999, paidAt: '2026-09-13' }, env.ctx)).toThrowError(/الحساب النقدي/)
    expect(() => paySupplier({ supplierId: 999999, amountMinor: moneyFromMajor(1) }, env.ctx)).toThrowError(/المورد/)
    expect(() => paySupplier({ supplierId, purchaseId: 999999, amountMinor: moneyFromMajor(1) }, env.ctx)).toThrowError(/فاتورة الشراء/)

    expect(getPurchase(purchase.id).purchase.paidMinor).toBe(moneyFromMajor(4000))
    expect(paymentCashRows(paymentId)).toMatchObject([{ amountMinor: moneyFromMajor(4000), accountId }])
  })

  it('rolls back payment, invoice and cash together if a linked cash correction fails', () => {
    const { supplierId, purchase } = invoice10k()
    const accountId = createAccount({ name: 'صندوق rollback', kind: 'cash', openingBalanceMinor: moneyFromMajor(10_000) }, env.ctx)
    const paymentId = paySupplier({ supplierId, purchaseId: purchase.id, amountMinor: moneyFromMajor(4000), cashAccountId: accountId }, env.ctx)
    getRawConnection().exec(
      "CREATE TRIGGER block_supplier_payment_cash_edit BEFORE UPDATE ON cash_transactions BEGIN SELECT RAISE(ABORT, 'forced rollback'); END"
    )

    expect(() => updateSupplierPayment(paymentId, {
      amountMinor: moneyFromMajor(3500), cashAccountId: accountId, paidAt: '2026-09-12'
    }, env.ctx)).toThrow()

    expect(getPurchase(purchase.id).purchase.paidMinor).toBe(moneyFromMajor(4000))
    expect(supplierStatement(supplierId).payments.items).toMatchObject([{
      id: paymentId, amountMinor: moneyFromMajor(4000)
    }])
    expect(paymentCashRows(paymentId)).toMatchObject([{ amountMinor: moneyFromMajor(4000) }])
    expect(accountBalance(accountId)).toBe(moneyFromMajor(6000))
  })

  it('rolls back cash removal when deleting the payment row fails', () => {
    const { supplierId, purchase } = invoice10k()
    const accountId = createAccount({ name: 'صندوق rollback حذف', kind: 'cash', openingBalanceMinor: moneyFromMajor(10_000) }, env.ctx)
    const paymentId = paySupplier({ supplierId, purchaseId: purchase.id, amountMinor: moneyFromMajor(4000), cashAccountId: accountId }, env.ctx)
    getRawConnection().exec(
      "CREATE TRIGGER block_supplier_payment_delete BEFORE DELETE ON supplier_payments BEGIN SELECT RAISE(ABORT, 'forced rollback'); END"
    )

    expect(() => reverseSupplierPayment(paymentId, env.ctx)).toThrow()

    expect(getPurchase(purchase.id).purchase.paidMinor).toBe(moneyFromMajor(4000))
    expect(getPurchase(purchase.id).payments).toMatchObject([{ id: paymentId, amountMinor: moneyFromMajor(4000) }])
    expect(paymentCashRows(paymentId)).toMatchObject([{ amountMinor: moneyFromMajor(4000), accountId }])
    expect(accountBalance(accountId)).toBe(moneyFromMajor(6000))
  })
})
