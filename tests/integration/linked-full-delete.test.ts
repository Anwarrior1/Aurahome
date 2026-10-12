import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { purchases, suppliers } from '@main/db/schema/parties.schema'
import { cashAccounts } from '@main/db/schema/finance.schema'
import { createSupplier, fullDeleteSupplier, supplierBalances, supplierFullDeletePreview } from '@main/services/parties/parties.service'
import { createPurchase, fullDeletePurchase, purchaseFullDeletePreview } from '@main/services/purchasing/purchasing.service'
import { accountBalance, cashAccountFullDeletePreview, createAccount, fullDeleteCashAccount, transfer } from '@main/services/finance/cash.service'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { availableQty } from '@main/services/inventory/inventory.service'
import { createExpense, listExpenses } from '@main/services/finance/expenses.service'
import { monthlyProfitSummary } from '@main/services/finance/profit.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
let sequence = 0
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => { assertDb10Equivalence(); env.cleanup() })

function paidPurchase() {
  const suffix = ++sequence
  const supplierName = `مورد DB11-${suffix}`
  const accountName = `صندوق DB11-${suffix}`
  const supplierId = createSupplier({ name: supplierName }, env.ctx)
  const categoryId = createCategory({ name: `تصنيف DB11-${suffix}` }, env.ctx)
  const materialId = createMaterial({
    sku: `DB11-${suffix}`, name: `مادة DB11-${suffix}`, categoryId, unit: 'قطعة',
    currentMarketPriceMicro: unitCostFromMajor(20), pricingRule: 'exact'
  } as never, env.ctx)
  const accountId = createAccount({ name: accountName, kind: 'cash', openingBalanceMinor: moneyFromMajor(10_000) }, env.ctx)
  const purchase = createPurchase({
    supplierId,
    lines: [{ materialId, qtyMicro: quantityFromDisplay(10), unitCostMicro: unitCostFromMajor(20) }],
    paidNowMinor: moneyFromMajor(200), cashAccountId: accountId
  }, env.ctx)
  return { supplierId, supplierName, materialId, accountId, accountName, purchase }
}

describe('DB-11 — posted purchase and supplier history', () => {
  it('previews the impact but refuses to erase a posted purchase', () => {
    const chain = paidPurchase()
    const balanceBefore = accountBalance(chain.accountId)
    const stockBefore = availableQty(chain.materialId)
    const supplierBefore = supplierBalances().find((row) => row.supplierId === chain.supplierId)
    const preview = purchaseFullDeletePreview(chain.purchase.id)
    const counts = Object.fromEntries(preview.dependencies.map((row) => [row.key, row.count]))

    expect(counts).toMatchObject({ payments: 1, cashTransactions: 1, inventoryMovements: 1 })
    expect(preview.blockers.join(' ')).toMatch(/سجل تجاري ومخزني/)
    expect(() => fullDeletePurchase({ id: chain.purchase.id, confirmation: chain.purchase.documentNumber }, env.ctx))
      .toThrowError(/تعذر حذف فاتورة الشراء/)

    expect(getDatabase().select().from(purchases).where(eq(purchases.id, chain.purchase.id)).get()).toBeDefined()
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM purchase_lines WHERE purchase_id = ${chain.purchase.id}`)?.c).toBe(1)
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM supplier_payments WHERE purchase_id = ${chain.purchase.id}`)?.c).toBe(1)
    expect(accountBalance(chain.accountId)).toBe(balanceBefore)
    expect(availableQty(chain.materialId)).toBe(stockBefore)
    expect(supplierBalances().find((row) => row.supplierId === chain.supplierId)).toEqual(supplierBefore)
  })

  it('refuses parent supplier deletion and preserves every invoice, payment and stock fact', () => {
    const chain = paidPurchase()
    expect(supplierFullDeletePreview(chain.supplierId).blockers.join(' ')).toMatch(/فواتير شراء مُرحّلة/)
    const stockBefore = availableQty(chain.materialId)
    const balanceBefore = accountBalance(chain.accountId)

    expect(() => fullDeleteSupplier({ id: chain.supplierId, confirmation: chain.supplierName }, env.ctx))
      .toThrowError(/تعذر حذف المورد/)

    expect(getDatabase().select().from(suppliers).where(eq(suppliers.id, chain.supplierId)).get()).toBeDefined()
    expect(getDatabase().select().from(purchases).where(eq(purchases.id, chain.purchase.id)).get()).toBeDefined()
    expect(availableQty(chain.materialId)).toBe(stockBefore)
    expect(accountBalance(chain.accountId)).toBe(balanceBefore)
  })

  it('keeps exact confirmation gates ahead of full-delete attempts', () => {
    const chain = paidPurchase()
    expect(() => fullDeletePurchase({ id: chain.purchase.id, confirmation: 'wrong' }, env.ctx)).toThrowError(/اكتب رقم الفاتورة/)
    expect(() => fullDeleteSupplier({ id: chain.supplierId, confirmation: 'wrong' }, env.ctx)).toThrowError(/اكتب اسم المورد/)
  })
})

describe('DB-11 — financial-account history', () => {
  it('refuses account deletion once a transaction posts and leaves reports identical', () => {
    const accountId = createAccount({ name: 'حساب تاريخي DB11', kind: 'cash', openingBalanceMinor: moneyFromMajor(5000) }, env.ctx)
    const expenseId = createExpense({ amountMinor: moneyFromMajor(125), cashAccountId: accountId, description: 'مصروف تاريخي DB11', spentAt: '2026-09-05' }, env.ctx)
    const balanceBefore = accountBalance(accountId)
    const profitBefore = monthlyProfitSummary(2026, 9)
    expect(cashAccountFullDeletePreview(accountId).blockers.join(' ')).toMatch(/حركات مالية مُرحّلة/)

    expect(() => fullDeleteCashAccount({ id: accountId, confirmation: 'حساب تاريخي DB11' }, env.ctx)).toThrowError(/تعذر حذف الحساب/)

    expect(getDatabase().select().from(cashAccounts).where(eq(cashAccounts.id, accountId)).get()).toBeDefined()
    expect(accountBalance(accountId)).toBe(balanceBefore)
    expect(listExpenses({}).items.some((row) => row.id === expenseId)).toBe(true)
    expect(monthlyProfitSummary(2026, 9)).toEqual(profitBefore)
  })

  it('does not erase the paired leg of a transfer through account deletion', () => {
    const fromId = createAccount({ name: 'حساب تحويل أ', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) }, env.ctx)
    const toId = createAccount({ name: 'حساب تحويل ب', kind: 'cash', openingBalanceMinor: 0 }, env.ctx)
    transfer({ fromAccountId: fromId, toAccountId: toId, amountMinor: moneyFromMajor(200) }, env.ctx)
    const before = [accountBalance(fromId), accountBalance(toId)]

    expect(() => fullDeleteCashAccount({ id: fromId, confirmation: 'حساب تحويل أ' }, env.ctx)).toThrow()
    expect([accountBalance(fromId), accountBalance(toId)]).toEqual(before)
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM cash_transactions WHERE transfer_group IS NOT NULL`)?.c).toBe(2)
  })

  it('still hard-deletes empty accounts and rolls back a late database failure', () => {
    const accountId = createAccount({ name: 'حساب فارغ DB11', kind: 'cash', openingBalanceMinor: 0 }, env.ctx)
    expect(cashAccountFullDeletePreview(accountId).blockers).toEqual([])
    getRawConnection().exec("CREATE TRIGGER db11_block_empty_account BEFORE DELETE ON cash_accounts BEGIN SELECT RAISE(ABORT, 'db11 forced rollback'); END")

    expect(() => fullDeleteCashAccount({ id: accountId, confirmation: 'حساب فارغ DB11' }, env.ctx)).toThrow(/db11 forced rollback/)
    expect(getDatabase().select().from(cashAccounts).where(eq(cashAccounts.id, accountId)).get()).toBeDefined()
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})

describe('DB-11 — authorization and integrity', () => {
  it('retains distinct full-delete permission keys', () => {
    expect(P.purchases.fullDelete).not.toBe(P.purchases.manage)
    expect(P.suppliers.fullDelete).not.toBe(P.suppliers.manage)
    expect(P.cash.fullDelete).not.toBe(P.cash.manage)
  })

  it('leaves SQLite foreign keys and integrity clean after refused parent deletion', () => {
    const chain = paidPurchase()
    expect(() => fullDeletePurchase({ id: chain.purchase.id, confirmation: chain.purchase.documentNumber }, env.ctx)).toThrow()
    expect(() => fullDeleteSupplier({ id: chain.supplierId, confirmation: chain.supplierName }, env.ctx)).toThrow()
    expect(() => fullDeleteCashAccount({ id: chain.accountId, confirmation: chain.accountName }, env.ctx)).toThrow()
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})
