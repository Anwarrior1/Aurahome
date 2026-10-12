import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertDb10Equivalence } from '../helpers/db10-equivalence'
import type { IpcMainInvokeEvent } from 'electron'
import { eq, sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { approveToOrder } from '../helpers/sales-flow'
import {
  createCategory,
  createColor,
  createMaterial,
  deleteColor,
  getMaterial,
  updateMaterial
} from '@main/services/catalog/catalog.service'
import {
  createCustomer,
  createSupplier,
  supplierBalances
} from '@main/services/parties/parties.service'
import {
  createPurchase,
  deletePurchase,
  getPurchase,
  paySupplier,
  updatePurchase
} from '@main/services/purchasing/purchasing.service'
import { createAccount, accountBalance } from '@main/services/finance/cash.service'
import {
  availableQty,
  consumeMaterial,
  listMovements,
  listRemainders,
  recordRemainder,
  recordWaste
} from '@main/services/inventory/inventory.service'
import { createFinalInvoice } from '@main/services/sales/final-invoices.service'
import { recordPayment } from '@main/services/sales/orders.service'
import {
  correctMaterialConsumption,
  consumeForOrder,
  getProductionOrder,
  issueWorkSheet,
  reverseMaterialConsumption
} from '@main/services/production/production.service'
import { orderCostBreakdown, orderCostEstimate } from '@main/services/costing/costing.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { registerIpcRouter } from '@main/ipc/router'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { closeDatabase, getDatabase, getRawConnection } from '@main/db/connection'
import { fifoAllocations, fifoLayers, inventoryMovements } from '@main/db/schema/inventory.schema'
import { materials } from '@main/db/schema/catalog.schema'
import { orderMaterialLines, plannedMaterials } from '@main/db/schema/production.schema'
import { purchases } from '@main/db/schema/parties.schema'
import { cashTransactions } from '@main/db/schema/finance.schema'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
beforeEach(() => {
  env = setupTestDatabase()
})
afterEach(() => env.cleanup())

function rootMaterial(overrides: Record<string, unknown> = {}) {
  const categoryId = createCategory({ name: `رئيسي-${Math.random()}` }, env.ctx)
  const materialId = createMaterial(
    {
      sku: `MAT-${Math.random()}`,
      name: 'مادة اختبار',
      categoryId,
      unit: 'قطعة',
      currentMarketPriceMicro: unitCostFromMajor(10),
      pricingRule: 'exact',
      ...overrides
    } as never,
    env.ctx
  )
  return { categoryId, materialId }
}

describe('safe purchase correction and deletion', () => {
  it('rebuilds one unused receipt transactionally with correct purchase-unit FIFO cost', () => {
    const { materialId } = rootMaterial({
      purchaseUnit: 'علبة',
      purchaseUnitFactorMicro: quantityFromDisplay(50)
    })
    const supplierId = createSupplier({ name: 'مورد الصناديق' }, env.ctx)
    const purchase = createPurchase(
      {
        supplierId,
        purchaseDate: '2026-09-01',
        lines: [
          {
            materialId,
            purchaseQtyMicro: quantityFromDisplay(2),
            purchaseUnitCostMicro: unitCostFromMajor(250),
            batchCode: 'LOT-A'
          }
        ]
      },
      env.ctx
    )

    updatePurchase(
      purchase.id,
      {
        purchaseDate: '2026-09-02',
        lines: [
          {
            materialId,
            purchaseQtyMicro: quantityFromDisplay(3),
            purchaseUnitCostMicro: unitCostFromMajor(250),
            batchCode: 'LOT-A'
          }
        ]
      },
      env.ctx
    )

    expect(availableQty(materialId)).toBe(quantityFromDisplay(150))
    const layer = getDatabase()
      .select()
      .from(fifoLayers)
      .where(eq(fifoLayers.materialId, materialId))
      .get()!
    expect(layer.qtyReceivedMicro).toBe(quantityFromDisplay(150))
    expect(layer.qtyRemainingMicro).toBe(quantityFromDisplay(150))
    expect(layer.unitCostMicro).toBe(unitCostFromMajor(5))
    expect(layer.batchCode).toBe('LOT-A')
    expect(getPurchase(purchase.id).purchase.totalMinor).toBe(moneyFromMajor(750))
    expect(supplierBalances().find((row) => row.supplierId === supplierId)?.remainingMinor).toBe(
      moneyFromMajor(750)
    )
    expect(
      getDatabase()
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.materialId, materialId))
        .all()
    ).toHaveLength(1)
    expect(
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'purchases.update'`
      )?.c
    ).toBe(1)
  })

  it('preserves an unpaid purchase because its receipt and FIFO layer are already posted', () => {
    const { materialId } = rootMaterial()
    const supplierId = createSupplier({ name: 'مورد' }, env.ctx)
    const purchase = createPurchase(
      {
        supplierId,
        lines: [
          { materialId, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(10) }
        ]
      },
      env.ctx
    )

    expect(() => deletePurchase(purchase.id, env.ctx)).toThrowError(/سجل تجاري ومخزني مُرحّل/)
    expect(
      getDatabase().select().from(purchases).where(eq(purchases.id, purchase.id)).get()
    ).toBeDefined()
    expect(availableQty(materialId)).toBe(quantityFromDisplay(5))
    expect(
      getDatabase().select().from(fifoLayers).where(eq(fifoLayers.materialId, materialId)).all()
    ).toHaveLength(1)
    expect(
      getDatabase()
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.materialId, materialId))
        .all()
    ).toHaveLength(1)
    expect(
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'purchases.delete'`
      )?.c
    ).toBe(0)
  })

  it('blocks destructive edit/delete after FIFO allocation and preserves historical actual cost', () => {
    const { materialId } = rootMaterial()
    const supplierId = createSupplier({ name: 'مورد FIFO' }, env.ctx)
    const purchase = createPurchase(
      {
        supplierId,
        lines: [
          { materialId, qtyMicro: quantityFromDisplay(100), unitCostMicro: unitCostFromMajor(5) }
        ]
      },
      env.ctx
    )
    const consumed = consumeMaterial({
      materialId,
      physicalQtyMicro: quantityFromDisplay(80),
      ctx: env.ctx
    })

    expect(() => deletePurchase(purchase.id, env.ctx)).toThrowError(/سجل تجاري|FIFO|استُخدم/)
    expect(() =>
      updatePurchase(
        purchase.id,
        {
          lines: [
            { materialId, qtyMicro: quantityFromDisplay(90), unitCostMicro: unitCostFromMajor(5) }
          ]
        },
        env.ctx
      )
    ).toThrowError(/FIFO|استُخدم/)
    expect(consumed.actualCostMinor).toBe(moneyFromMajor(400))
    expect(availableQty(materialId)).toBe(quantityFromDisplay(20))
    expect(getDatabase().select().from(fifoAllocations).all()).toHaveLength(1)
  })

  it('blocks delete and value/supplier changes when a supplier payment exists, while allowing notes', () => {
    const { materialId } = rootMaterial()
    const supplierId = createSupplier({ name: 'مورد مدفوع' }, env.ctx)
    const otherSupplierId = createSupplier({ name: 'مورد آخر' }, env.ctx)
    const purchase = createPurchase(
      {
        supplierId,
        paidNowMinor: moneyFromMajor(10),
        lines: [
          { materialId, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(10) }
        ]
      },
      env.ctx
    )

    updatePurchase(purchase.id, { notes: 'ملاحظة مصححة' }, env.ctx)
    expect(getPurchase(purchase.id).purchase.notes).toBe('ملاحظة مصححة')
    expect(() =>
      updatePurchase(purchase.id, { supplierId: otherSupplierId }, env.ctx)
    ).toThrowError(/دفعة مالية/)
    expect(() => deletePurchase(purchase.id, env.ctx)).toThrowError(/سجل تجاري|دفعة مورد|حركة نقدية/)
    expect(supplierBalances().find((row) => row.supplierId === supplierId)?.remainingMinor).toBe(
      moneyFromMajor(40)
    )
  })
})

/**
 * Editing a paid purchase's Cash Account (spec: "Edit Purchase
 * Invoice" flow). accountBalance() is always derived live from
 * cash_transactions, so moving a payment's ONE ledger row from
 * account A to account B — never leaving a second row behind — is
 * the complete, atomic reversal: A gains back the amount, B loses
 * exactly that much, and there is still exactly one active movement.
 */
describe("changing a purchase payment's cash account", () => {
  function paidPurchase(accountId: number, amountMajor = 560) {
    const { materialId } = rootMaterial()
    const supplierId = createSupplier({ name: 'مورد مدفوع نقداً' }, env.ctx)
    const purchase = createPurchase(
      {
        supplierId,
        paidNowMinor: moneyFromMajor(amountMajor),
        cashAccountId: accountId,
        lines: [
          {
            materialId,
            qtyMicro: quantityFromDisplay(5),
            unitCostMicro: unitCostFromMajor(amountMajor / 5)
          }
        ]
      },
      env.ctx
    )
    return { purchase, supplierId, materialId }
  }

  function cashRowsFor(paymentId: number) {
    return getDatabase()
      .select()
      .from(cashTransactions)
      .where(
        sql`${cashTransactions.refTable} = 'supplier_payments' AND ${cashTransactions.refId} = ${paymentId}`
      )
      .all()
  }

  it('Test 1 — preselects the exact account that actually paid for it', () => {
    const accountA = createAccount({ name: 'الصندوق الرئيسي', kind: 'cash' }, env.ctx)
    const { purchase } = paidPurchase(accountA)

    const detail = getPurchase(purchase.id)
    expect(detail.payments).toHaveLength(1)
    expect(detail.payments[0]?.cashAccountId).toBe(accountA)
  })

  it('Test 2 — Account A → Account B, amount unchanged: reversed on A, applied on B, exactly once', () => {
    const accountA = createAccount(
      { name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(2000) },
      env.ctx
    )
    const accountB = createAccount(
      { name: 'البنك', kind: 'bank', openingBalanceMinor: moneyFromMajor(2000) },
      env.ctx
    )
    const { purchase } = paidPurchase(accountA, 560)
    const paymentId = getPurchase(purchase.id).payments[0]!.id

    expect(accountBalance(accountA)).toBe(moneyFromMajor(2000 - 560))
    expect(accountBalance(accountB)).toBe(moneyFromMajor(2000))

    updatePurchase(purchase.id, { cashAccountId: accountB }, env.ctx)

    expect(accountBalance(accountA)).toBe(moneyFromMajor(2000)) // fully restored
    expect(accountBalance(accountB)).toBe(moneyFromMajor(2000 - 560)) // deducted exactly once
    expect(getPurchase(purchase.id).payments[0]?.cashAccountId).toBe(accountB)
    // Item 12: never active on both accounts — there is still only ONE row.
    const rows = cashRowsFor(paymentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.accountId).toBe(accountB)
    expect(rows[0]?.amountMinor).toBe(moneyFromMajor(560))
  })

  it('Test 3 — an account change alongside an allowed field (notes/date) stays fully consistent, and a disallowed one (lines/supplier) is still blocked atomically', () => {
    const accountA = createAccount({ name: 'الصندوق', kind: 'cash' }, env.ctx)
    const accountB = createAccount({ name: 'البنك', kind: 'bank' }, env.ctx)
    const { purchase, supplierId } = paidPurchase(accountA, 560)

    // The invoice's own lines/total are FIFO-protected once paid
    // (pre-existing rule, item 18 — untouched) — that guard must keep
    // firing even when a cashAccountId is present in the same call,
    // and firing it must not partially apply the account move either.
    expect(() =>
      updatePurchase(
        purchase.id,
        {
          cashAccountId: accountB,
          lines: [
            {
              materialId: getPurchase(purchase.id).lines[0]!.materialId,
              qtyMicro: quantityFromDisplay(9),
              unitCostMicro: unitCostFromMajor(50)
            }
          ]
        },
        env.ctx
      )
    ).toThrowError(/دفعة مالية/)
    expect(getPurchase(purchase.id).payments[0]?.cashAccountId).toBe(accountA) // untouched
    expect(accountBalance(accountA)).toBe(-moneyFromMajor(560))
    expect(accountBalance(accountB)).toBe(0)

    // Notes/date ARE allowed alongside the account move — everything
    // lands together, in the one transaction.
    updatePurchase(
      purchase.id,
      { cashAccountId: accountB, notes: 'صُحّح الحساب والتاريخ معاً', purchaseDate: '2026-01-15' },
      env.ctx
    )
    const after = getPurchase(purchase.id)
    expect(after.payments[0]?.cashAccountId).toBe(accountB)
    expect(after.purchase.notes).toBe('صُحّح الحساب والتاريخ معاً')
    expect(after.purchase.purchaseDate).toBe('2026-01-15')
    expect(after.purchase.totalMinor).toBe(moneyFromMajor(560)) // untouched, as required
    expect(accountBalance(accountA)).toBe(0)
    expect(accountBalance(accountB)).toBe(-moneyFromMajor(560))
    expect(supplierBalances().find((row) => row.supplierId === supplierId)?.remainingMinor).toBe(0)
  })

  it('Test 4 — saving with the SAME account never creates a duplicate movement', () => {
    const accountA = createAccount(
      { name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) },
      env.ctx
    )
    const { purchase } = paidPurchase(accountA, 560)
    const paymentId = getPurchase(purchase.id).payments[0]!.id

    updatePurchase(purchase.id, { cashAccountId: accountA }, env.ctx)

    expect(cashRowsFor(paymentId)).toHaveLength(1)
    expect(accountBalance(accountA)).toBe(moneyFromMajor(1000 - 560))
  })

  it('Test 5 — survives a connection restart against the same database file', () => {
    const accountA = createAccount({ name: 'الصندوق', kind: 'cash' }, env.ctx)
    const accountB = createAccount({ name: 'البنك', kind: 'bank' }, env.ctx)
    const { purchase } = paidPurchase(accountA, 560)

    updatePurchase(purchase.id, { cashAccountId: accountB }, env.ctx)
    closeDatabase() // simulates the app closing and reopening the same erp.db

    expect(getPurchase(purchase.id).payments[0]?.cashAccountId).toBe(accountB)
    expect(accountBalance(accountA)).toBe(0)
    expect(accountBalance(accountB)).toBe(-moneyFromMajor(560))
  })

  it('Test 6 — the Cash Movement ledger shows the payment on the correct account, never duplicated', () => {
    const accountA = createAccount({ name: 'الصندوق', kind: 'cash' }, env.ctx)
    const accountB = createAccount({ name: 'البنك', kind: 'bank' }, env.ctx)
    const { purchase } = paidPurchase(accountA, 560)
    const paymentId = getPurchase(purchase.id).payments[0]!.id

    updatePurchase(purchase.id, { cashAccountId: accountB }, env.ctx)

    const onA = getDatabase()
      .select()
      .from(cashTransactions)
      .where(
        sql`${cashTransactions.accountId} = ${accountA} AND ${cashTransactions.refTable} = 'supplier_payments'`
      )
      .all()
    const onB = getDatabase()
      .select()
      .from(cashTransactions)
      .where(
        sql`${cashTransactions.accountId} = ${accountB} AND ${cashTransactions.refTable} = 'supplier_payments'`
      )
      .all()
    expect(onA).toHaveLength(0) // no lingering active deduction on the old account
    expect(onB).toHaveLength(1)
    expect(onB[0]?.refId).toBe(paymentId)
    expect(onB[0]?.direction).toBe('out')
  })

  it('Test 7 — a forced mid-transaction failure rolls back the invoice, payment AND ledger together', () => {
    const accountA = createAccount(
      { name: 'الصندوق', kind: 'cash', openingBalanceMinor: moneyFromMajor(1000) },
      env.ctx
    )
    const accountB = createAccount({ name: 'البنك', kind: 'bank' }, env.ctx)
    const { purchase } = paidPurchase(accountA, 560)
    const paymentId = getPurchase(purchase.id).payments[0]!.id

    getRawConnection().exec(
      "CREATE TRIGGER test_block_cash_move BEFORE UPDATE ON cash_transactions BEGIN SELECT RAISE(ABORT, 'forced rollback'); END"
    )

    expect(() =>
      updatePurchase(purchase.id, { cashAccountId: accountB, notes: 'محاولة فاشلة' }, env.ctx)
    ).toThrow()

    const after = getPurchase(purchase.id)
    expect(after.purchase.notes).not.toBe('محاولة فاشلة') // the notes change rolled back too
    expect(after.payments[0]?.cashAccountId).toBe(accountA) // supplier_payments row rolled back
    expect(cashRowsFor(paymentId)).toHaveLength(1)
    expect(cashRowsFor(paymentId)[0]?.accountId).toBe(accountA)
    expect(accountBalance(accountA)).toBe(moneyFromMajor(1000 - 560))
    expect(accountBalance(accountB)).toBe(0)
  })

  it('Test 8 — multiple payments: the invoice-level field is blocked, and no payment is silently reassigned', () => {
    const { materialId } = rootMaterial()
    const supplierId = createSupplier({ name: 'مورد بدفعات متعددة' }, env.ctx)
    const accountA = createAccount({ name: 'الصندوق', kind: 'cash' }, env.ctx)
    const accountB = createAccount({ name: 'البنك', kind: 'bank' }, env.ctx)
    const purchase = createPurchase(
      {
        supplierId,
        lines: [
          { materialId, qtyMicro: quantityFromDisplay(10), unitCostMicro: unitCostFromMajor(56) }
        ]
      },
      env.ctx
    )
    paySupplier(
      {
        supplierId,
        purchaseId: purchase.id,
        amountMinor: moneyFromMajor(300),
        cashAccountId: accountA
      },
      env.ctx
    )
    paySupplier(
      {
        supplierId,
        purchaseId: purchase.id,
        amountMinor: moneyFromMajor(260),
        cashAccountId: accountB
      },
      env.ctx
    )

    expect(() => updatePurchase(purchase.id, { cashAccountId: accountA }, env.ctx)).toThrowError(
      /أكثر من دفعة/
    )

    // Existing payment-level accounting is completely untouched.
    const payments = getPurchase(purchase.id).payments
    expect(payments).toHaveLength(2)
    expect(payments.find((p) => p.amountMinor === moneyFromMajor(300))?.cashAccountId).toBe(
      accountA
    )
    expect(payments.find((p) => p.amountMinor === moneyFromMajor(260))?.cashAccountId).toBe(
      accountB
    )
    expect(accountBalance(accountA)).toBe(-moneyFromMajor(300))
    expect(accountBalance(accountB)).toBe(-moneyFromMajor(260))
  })

  it('a purchase with no recorded payment cannot have an account attached through this field', () => {
    const { materialId } = rootMaterial()
    const supplierId = createSupplier({ name: 'مورد غير مدفوع' }, env.ctx)
    const accountA = createAccount({ name: 'الصندوق', kind: 'cash' }, env.ctx)
    const purchase = createPurchase(
      {
        supplierId,
        lines: [
          { materialId, qtyMicro: quantityFromDisplay(5), unitCostMicro: unitCostFromMajor(10) }
        ]
      },
      env.ctx
    )

    expect(getPurchase(purchase.id).payments).toHaveLength(0)
    expect(() => updatePurchase(purchase.id, { cashAccountId: accountA }, env.ctx)).toThrowError(
      /لا توجد دفعة/
    )
  })
})

describe('material category assignment — any hierarchy level is valid, invalid ids are still rejected', () => {
  it('accepts a child-category assignment on create/update exactly like a legacy one, and still rejects a nonexistent category', () => {
    const parent = createCategory({ name: 'Wood' }, env.ctx)
    const child = createCategory({ name: 'mdf', parentId: parent }, env.ctx)

    // A brand-new material can go straight on the child — no more
    // root-only restriction, no legacy carve-out needed for this.
    const freshId = createMaterial(
      {
        sku: 'CHILD-NEW',
        name: 'مادة جديدة',
        categoryId: child,
        unit: 'لوح',
        currentMarketPriceMicro: unitCostFromMajor(10),
        pricingRule: 'exact'
      },
      env.ctx
    )
    expect(getMaterial(freshId).categoryId).toBe(child)

    // A pre-existing (legacy-style, directly inserted) child-assigned
    // row behaves identically — an ordinary edit, and a category move
    // to another root, both just work.
    const legacyId = Number(
      getDatabase()
        .insert(materials)
        .values({
          sku: 'LEGACY-CHILD',
          name: 'مادة قديمة',
          categoryId: child,
          unit: 'لوح',
          currentMarketPriceMicro: unitCostFromMajor(10),
          pricingRule: 'exact'
        })
        .run().lastInsertRowid
    )
    updateMaterial(legacyId, { notes: 'تعديل آمن' }, env.ctx)
    expect(getMaterial(legacyId).categoryId).toBe(child)

    const otherParent = createCategory({ name: 'Accessories' }, env.ctx)
    updateMaterial(legacyId, { categoryId: otherParent }, env.ctx)
    expect(getMaterial(legacyId).categoryId).toBe(otherParent)
    // Moving straight back onto the child now succeeds too.
    updateMaterial(legacyId, { categoryId: child }, env.ctx)
    expect(getMaterial(legacyId).categoryId).toBe(child)

    // Only a genuinely nonexistent category id is still rejected.
    expect(() =>
      createMaterial(
        {
          sku: 'BAD-CAT',
          name: 'مادة بتصنيف غير موجود',
          categoryId: 999999,
          unit: 'لوح',
          currentMarketPriceMicro: unitCostFromMajor(10),
          pricingRule: 'exact'
        },
        env.ctx
      )
    ).toThrowError(/التصنيف غير موجود/)
    expect(() => updateMaterial(legacyId, { categoryId: 999999 }, env.ctx)).toThrowError(
      /التصنيف غير موجود/
    )

    // The category tree itself is untouched by any of this.
    expect(
      getDatabase().get<{ parentId: number }>(
        sql`SELECT parent_id AS parentId FROM material_categories WHERE id = ${child}`
      )?.parentId
    ).toBe(parent)
  })
})

describe('safe colour deletion', () => {
  it('hard-deletes unused colours and archives referenced colours without altering history', () => {
    const unusedId = createColor({ code: 'UNUSED', name: 'غير مستخدم' }, env.ctx)
    expect(deleteColor(unusedId, env.ctx)).toEqual({ deleted: true, archived: false })

    const usedId = createColor({ code: 'HIST-205', name: 'لون تاريخي' }, env.ctx)
    getDatabase()
      .insert(plannedMaterials)
      .values({
        materialName: 'لقطة تاريخية',
        qtyMicro: quantityFromDisplay(1),
        colorCode: 'HIST-205'
      })
      .run()
    expect(deleteColor(usedId, env.ctx)).toEqual({ deleted: false, archived: true })
    expect(
      getDatabase().get<{ active: number }>(
        sql`SELECT active FROM color_finish_catalog WHERE id = ${usedId}`
      )?.active
    ).toBe(0)
    expect(
      getDatabase().get<{ code: string }>(
        sql`SELECT color_code AS code FROM planned_materials WHERE color_code = 'HIST-205'`
      )?.code
    ).toBe('HIST-205')
    expect(
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'catalog.color.archive'`
      )?.c
    ).toBe(1)
  })
})

describe('actual material consumption correction/reversal', () => {
  function seededProduction() {
    const { materialId } = rootMaterial()
    const supplierId = createSupplier({ name: 'مورد ألواح' }, env.ctx)
    createPurchase(
      {
        supplierId,
        lines: [
          {
            materialId,
            qtyMicro: quantityFromDisplay(20),
            unitCostMicro: unitCostFromMajor(100),
            batchCode: 'LOT-BOARD-A'
          }
        ]
      },
      env.ctx
    )
    const customerId = createCustomer({ name: 'عميل' }, env.ctx)
    const quotation = createFinalInvoice(
      {
        customerId,
        lines: [
          {
            lineKind: 'custom',
            description: 'منتج',
            quantityMicro: quantityFromDisplay(1),
            unitPriceMinor: moneyFromMajor(2000)
          }
        ]
      },
      env.ctx
    )
    const order = approveToOrder(quotation.id, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(1200) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    return { materialId, orderId: order.id, sheetId: sheet.id }
  }

  it('edits 10 boards to 1 by reversing exact layers then reallocating once', () => {
    const { materialId, orderId, sheetId } = seededProduction()
    const original = consumeForOrder(
      {
        workSheetId: sheetId,
        materialId,
        physicalQtyMicro: quantityFromDisplay(10)
      },
      env.ctx
    )
    expect(availableQty(materialId)).toBe(quantityFromDisplay(10))

    const corrected = correctMaterialConsumption(
      {
        id: original.id,
        materialId,
        physicalQtyMicro: quantityFromDisplay(1),
        reason: 'أدخلت 10 بدلاً من 1'
      },
      env.ctx
    )

    expect(availableQty(materialId)).toBe(quantityFromDisplay(19))
    const rows = getDatabase()
      .select()
      .from(orderMaterialLines)
      .where(eq(orderMaterialLines.workSheetId, sheetId))
      .all()
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === original.id)?.status).toBe('reversed')
    expect(rows.find((row) => row.id === corrected.id)?.status).toBe('active')
    expect(rows.find((row) => row.id === corrected.id)?.correctionOfLineId).toBe(original.id)
    expect(getProductionOrder(sheetId).actualCostMinor).toBe(moneyFromMajor(100))
    expect(orderCostBreakdown(orderId).materialCostMinor).toBe(moneyFromMajor(100))
    expect(orderCostEstimate(orderId).actualProfitMinor).toBe(moneyFromMajor(1900))

    const movements = listMovements({ materialId }).items
    expect(movements.map((movement) => movement.kind)).toEqual([
      'consumption',
      'consumption_reversal',
      'consumption',
      'purchase'
    ])
    const layer = getDatabase()
      .select()
      .from(fifoLayers)
      .where(eq(fifoLayers.materialId, materialId))
      .get()!
    expect(layer.qtyRemainingMicro).toBe(quantityFromDisplay(19))
    expect(layer.batchCode).toBe('LOT-BOARD-A')
    expect(
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM audit_log WHERE action = 'orders.material.correct'`
      )?.c
    ).toBe(1)
  })

  it('reverses consumption, restores FIFO/lot stock, and removes active actual cost', () => {
    const { materialId, orderId, sheetId } = seededProduction()
    const line = consumeForOrder(
      {
        workSheetId: sheetId,
        materialId,
        physicalQtyMicro: quantityFromDisplay(10)
      },
      env.ctx
    )
    reverseMaterialConsumption({ id: line.id, reason: 'صرف مسجل بالخطأ' }, env.ctx)

    expect(availableQty(materialId)).toBe(quantityFromDisplay(20))
    expect(getProductionOrder(sheetId).actualCostMinor).toBe(0)
    expect(orderCostBreakdown(orderId).materialCostMinor).toBe(0)
    const layer = getDatabase()
      .select()
      .from(fifoLayers)
      .where(eq(fifoLayers.materialId, materialId))
      .get()!
    expect(layer.qtyRemainingMicro).toBe(layer.qtyReceivedMicro)
    expect(layer.batchCode).toBe('LOT-BOARD-A')
    expect(getDatabase().select().from(fifoAllocations).all()).toHaveLength(1)
    expect(
      getDatabase()
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.materialId, materialId))
        .all()
    ).toHaveLength(3)
    expect(() =>
      reverseMaterialConsumption({ id: line.id, reason: 'مرة أخرى' }, env.ctx)
    ).toThrowError(/بالفعل/)
  })

  it('preserves whole-unit pricing, reusable offcuts, and separate waste while reversing', () => {
    const { materialId } = rootMaterial({
      pricingRule: 'full_unit',
      commercialUnitSizeMicro: quantityFromDisplay(1)
    })
    const supplierId = createSupplier({ name: 'مورد وحدات كاملة' }, env.ctx)
    createPurchase(
      {
        supplierId,
        lines: [
          {
            materialId,
            qtyMicro: quantityFromDisplay(2),
            unitCostMicro: unitCostFromMajor(100),
            batchCode: 'WHOLE-A'
          }
        ]
      },
      env.ctx
    )
    const customerId = createCustomer({ name: 'عميل وحدات' }, env.ctx)
    const quotation = createFinalInvoice(
      {
        customerId,
        lines: [
          {
            lineKind: 'custom',
            description: 'منتج',
            quantityMicro: quantityFromDisplay(1),
            unitPriceMinor: moneyFromMajor(1000)
          }
        ]
      },
      env.ctx
    )
    const order = approveToOrder(quotation.id, env.ctx)
    recordPayment({ orderId: order.id, amountMinor: moneyFromMajor(600) }, env.ctx)
    const sheet = issueWorkSheet({ orderId: order.id }, env.ctx)
    const line = consumeForOrder(
      {
        workSheetId: sheet.id,
        materialId,
        physicalQtyMicro: quantityFromDisplay(0.1)
      },
      env.ctx
    )
    const layer = getDatabase()
      .select()
      .from(fifoLayers)
      .where(eq(fifoLayers.materialId, materialId))
      .get()!
    recordRemainder({
      materialId,
      layerId: layer.id,
      sizeMicro: quantityFromDisplay(0.4),
      note: 'قصّة قابلة للاستخدام',
      ctx: env.ctx
    })
    recordWaste({
      materialId,
      qtyMicro: quantityFromDisplay(0.2),
      reason: 'هالك مستقل',
      ctx: env.ctx
    })

    reverseMaterialConsumption({ id: line.id, reason: 'تصحيح صرف الوحدة الكاملة' }, env.ctx)
    expect(availableQty(materialId)).toBe(quantityFromDisplay(1.8))
    expect(listRemainders(materialId).items).toHaveLength(1)
    expect(
      listMovements({ materialId }).items.filter((movement) => movement.kind === 'waste')
    ).toHaveLength(1)
    expect(orderCostBreakdown(order.id).materialCostMinor).toBe(0)
    expect(
      getDatabase().select().from(fifoLayers).where(eq(fifoLayers.id, layer.id)).get()?.batchCode
    ).toBe('WHOLE-A')
  })
})

describe('IPC permissions for new correction actions', () => {
  it('rejects unauthorized purchase/color/consumption/material calls in main', async () => {
    const roleId = createRole(
      {
        name: 'بلا صلاحيات',
        permissions: []
      },
      env.ctx
    )
    createUser({ username: 'viewer', password: 'viewer123', fullName: 'مشاهد', roleId }, env.ctx)
    login('viewer', 'viewer123', 99)

    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>
    >()
    const electron = await import('electron')
    const spy = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((
      channel: string,
      handler: typeof handlers extends Map<string, infer H> ? H : never
    ) => {
      handlers.set(channel, handler)
    }) as never)
    registerIpcRouter()
    spy.mockRestore()
    const event = { sender: { id: 99 } } as unknown as IpcMainInvokeEvent

    const attempts: Array<[string, unknown]> = [
      [IPC_CHANNELS.purchases.remove, { id: 1 }],
      [IPC_CHANNELS.colors.remove, { id: 1 }],
      [IPC_CHANNELS.admin.deleteUser, { id: 1 }],
      [IPC_CHANNELS.expenses.update, { id: 1, amountMinor: 1000 }],
      [IPC_CHANNELS.expenses.remove, { id: 1 }],
      [IPC_CHANNELS.orders.fullDelete, { id: 1, confirmation: 'SO-1', reason: 'اختبار' }],
      [IPC_CHANNELS.production.reverseMaterialConsumption, { id: 1, reason: 'اختبار' }],
      [IPC_CHANNELS.inventory.movements, { materialId: 1 }],
      [IPC_CHANNELS.materials.colorOptions, undefined],
      [
        IPC_CHANNELS.categories.createChildMaterial,
        {
          parentId: 1,
          clientRequestId: 'permission-check-1',
          sku: 'CHILD-X',
          name: 'Child X',
          unit: 'قطعة',
          currentMarketPriceMicro: 0,
          pricingRule: 'exact'
        }
      ],
      [
        IPC_CHANNELS.materials.create,
        {
          sku: 'X',
          name: 'X',
          categoryId: 1,
          unit: 'قطعة',
          currentMarketPriceMicro: 0,
          pricingRule: 'exact'
        }
      ]
    ]
    for (const [channel, payload] of attempts) {
      const result = (await handlers.get(channel)!(event, payload)) as {
        ok: boolean
        error?: { code: string }
      }
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('FORBIDDEN')
    }
  })
})

// DB-10: each scenario's final state must read identically through the set-based paths.
afterEach(() => assertDb10Equivalence())
