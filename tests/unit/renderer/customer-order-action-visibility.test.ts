import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const orderPage = readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')
const productionPage = readFileSync('src/renderer/pages/worksheets/ProductionOrderPage.tsx', 'utf8')

describe('persisted Customer Order action availability', () => {
  it('does not expose the Finished Goods issue action on Customer Order Details', () => {
    expect(orderPage).not.toContain('صرف من المخزون الجاهز')
    expect(orderPage).not.toContain("'orders', 'fulfillFromStock'")
  })

  it('offers no separate material issue from the Manufacturing Order screen', () => {
    expect(productionPage).not.toContain("'production', 'consumeMaterial'")
    expect(productionPage).not.toContain('صرف مواد إنتاج المخزون')
    expect(productionPage).not.toContain('صرف مواد لأمر التصنيع')
  })

  it('derives one-time actions from persisted worksheet, release and fulfilment queries', () => {
    expect(orderPage).toContain('!manufacturingIssued')
    expect(orderPage).toContain('!releaseIssued')
    expect(orderPage).toContain('detail.data!.workflow.manufacturingIssued')
    expect(orderPage).toContain('detail.data!.workflow.releaseIssued')
    expect(orderPage).toContain('detail.data!.workflow.requiredCompletion')
    expect(orderPage).toContain('COMPLETION_ACTION_LABEL[requiredCompletion.completionKind]')
  })

  it('shows returns only while authoritative issued quantity remains returnable', () => {
    expect(orderPage).toContain('returnAvailable &&')
    expect(orderPage).toContain("('production', 'materialReturns', { orderId })")
    expect(orderPage).not.toContain('disabled={!materialReturns.data?.materials.some')
  })

  it('requires both Manufacturing Order and inventory permissions in the UI', () => {
    expect(orderPage).toContain('can(P.worksheets.issue) && can(P.inventory.consume)')
  })

  it('offers ordinary Manufacturing issuance regardless of deposit status', () => {
    expect(orderPage).not.toContain('can(P.production.overrideDepositRequirement)')
    expect(orderPage).not.toContain('overrideDepositRequirement: true')
    expect(orderPage).toContain('تبقى ذمة العميل مستحقة')
    expect(orderPage).toContain("order.paidMinor === 0 ? 'لم يتم دفع العربون.'")
    expect(orderPage).not.toContain('disabled={processing || !depositMet}')
  })
})

const ordersTable = readFileSync('src/renderer/pages/orders/OrdersPage.tsx', 'utf8')
describe('Customer Order Delete/Cancel and Archive eligibility UI', () => {
  it('gates the Trash action on authoritative eligibility and permanent-delete permission only', () => {
    expect(ordersTable).toContain('row.canDeleteCancel && can(P.orders.fullDelete)')
    expect(ordersTable).toContain('if (!row.canDeleteCancel) return')
    expect(ordersTable).toContain("'orders', 'fullDeletePreview'")
    expect(ordersTable).toContain("'orders', 'fullDelete'")
    expect(ordersTable).not.toContain("'orders', 'cancel'")
    expect(ordersTable).not.toContain('cancelOrderFromDialog')
    expect(ordersTable).not.toContain('سبب إلغاء الطلب')
    expect(ordersTable).not.toContain('إلغاء الطلب')
  })
  it('opens one permanent-delete dialog with exact typed order-number confirmation and close only', () => {
    expect(ordersTable).toContain('setDeleteDialog({ row, preview, confirmation: \'\' })')
    expect(ordersTable).toContain('title="تأكيد حذف الطلب نهائياً"')
    expect(ordersTable).toContain('حذف الطلب نهائياً')
    expect(ordersTable).toContain('إغلاق')
    expect(ordersTable).toContain('deleteDialog?.confirmation !== deleteDialog?.row.documentNumber')
    expect(ordersTable).toContain('deleteDialog.confirmation !== deleteDialog.row.documentNumber')
    expect(ordersTable).toContain('onClose={() => setDeleteDialog(undefined)}')
    expect(ordersTable).toContain('<Button variant="secondary" onClick={() => setDeleteDialog(undefined)}>')
  })
  it('gates the same Archive/Restore action on backend eligibility and archive permission', () => {
    expect(ordersTable).toContain('can(P.orders.archive) && (archived || row.canArchive)')
    expect(ordersTable).toContain("archived ? 'restore' : 'archive'")
  })
  it('also gates the existing detail cancellation action on backend eligibility', () => {
    expect(orderPage).toContain('can(P.orders.cancel) && detail.data!.actions.canCancel')
  })
})
