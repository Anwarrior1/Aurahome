import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '@shared/types/ipc.types'
import { IPC_CHANNELS } from '@shared/constants/channels'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { createCategory, createMaterial } from '@main/services/catalog/catalog.service'
import { createSupplier } from '@main/services/parties/parties.service'
import { createPurchase, getPurchase, paySupplier } from '@main/services/purchasing/purchasing.service'
import { accountBalance, createAccount } from '@main/services/finance/cash.service'
import { createRole, createUser } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { moneyFromMajor } from '@shared/money/money'
import { unitCostFromMajor } from '@shared/money/cost'
import { quantityFromDisplay } from '@shared/quantity/quantity'

let env: TestEnv
let handlers: Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<IpcResult<unknown>>>
let windowId = 9800
let event: IpcMainInvokeEvent

beforeEach(async () => {
  windowId += 1
  event = { sender: { id: windowId } } as IpcMainInvokeEvent
  env = setupTestDatabase()
  handlers = new Map()
  const electron = await import('electron')
  const spy = vi.spyOn(electron.ipcMain, 'handle')
    .mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
  const { registerIpcRouter } = await import('@main/ipc/router')
  registerIpcRouter()
  spy.mockRestore()
})

afterEach(() => env.cleanup())

function paidInvoice() {
  const categoryId = createCategory({ name: `فئة صلاحيات-${Math.random()}` }, env.ctx)
  const materialId = createMaterial({
    sku: `PERM-PAY-${Math.random()}`,
    name: 'مادة صلاحيات دفعة',
    categoryId,
    unit: 'قطعة',
    currentMarketPriceMicro: unitCostFromMajor(1000),
    pricingRule: 'exact'
  }, env.ctx)
  const supplierId = createSupplier({ name: 'مورد صلاحيات الدفعة' }, env.ctx)
  const accountId = createAccount({
    name: 'صندوق صلاحيات الدفعة', kind: 'cash', openingBalanceMinor: moneyFromMajor(10_000)
  }, env.ctx)
  const purchase = createPurchase({
    supplierId,
    lines: [{ materialId, qtyMicro: quantityFromDisplay(10), unitCostMicro: unitCostFromMajor(1000) }]
  }, env.ctx)
  const paymentId = paySupplier({
    supplierId, purchaseId: purchase.id, amountMinor: moneyFromMajor(4000), cashAccountId: accountId
  }, env.ctx)
  return { purchaseId: purchase.id, paymentId, accountId }
}

describe('Supplier Payment correction IPC permissions', () => {
  it('rejects unauthorized edit and delete with zero financial side effects', async () => {
    const fixture = paidInvoice()
    const roleId = createRole({ name: 'عرض مشتريات فقط', permissions: [P.purchases.view] }, env.ctx)
    createUser({
      username: 'supplier-payment-view-only',
      password: 'secret123',
      fullName: 'مستخدم عرض دفعات',
      roleId
    }, env.ctx)
    login('supplier-payment-view-only', 'secret123', windowId)

    const updateResult = await handlers.get(IPC_CHANNELS.purchases.updateSupplierPayment)!(event, {
      id: fixture.paymentId,
      amountMinor: moneyFromMajor(3500),
      paidAt: '2026-09-13'
    })
    const deleteResult = await handlers.get(IPC_CHANNELS.purchases.deleteSupplierPayment)!(event, {
      id: fixture.paymentId
    })

    expect(updateResult.ok).toBe(false)
    if (!updateResult.ok) expect(updateResult.error.code).toBe('FORBIDDEN')
    expect(deleteResult.ok).toBe(false)
    if (!deleteResult.ok) expect(deleteResult.error.code).toBe('FORBIDDEN')
    expect(getPurchase(fixture.purchaseId).purchase.paidMinor).toBe(moneyFromMajor(4000))
    expect(getPurchase(fixture.purchaseId).payments).toMatchObject([{
      id: fixture.paymentId, amountMinor: moneyFromMajor(4000), cashAccountId: fixture.accountId
    }])
    expect(accountBalance(fixture.accountId)).toBe(moneyFromMajor(6000))
  })
})
