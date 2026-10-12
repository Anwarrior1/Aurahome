import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const orderPage = readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')
const productionPage = readFileSync('src/renderer/pages/worksheets/ProductionOrderPage.tsx', 'utf8')
const router = readFileSync('src/main/ipc/router.ts', 'utf8')

describe('customer-order raw-material return UI', () => {
  it('offers only authoritative issued materials with all required quantities', () => {
    expect(orderPage).toContain("('production', 'materialReturns', { orderId })")
    expect(orderPage).not.toContain("createMaterialReturn', {\n          orderId, materialId: Number(raw")
    for (const label of [
      'المادة', 'الكمية المصروفة', 'المرتجع سابقاً', 'المتاح للإرجاع',
      'الكمية المراد إرجاعها', 'ملاحظات (اختياري)'
    ]) expect(orderPage).toContain(`label="${label}"`)
  })

  it('renders compact icon-only Pencil/Trash actions with Arabic tooltips', () => {
    expect(orderPage).toContain('title="تعديل المرتجع"')
    expect(orderPage).toContain('aria-label="تعديل المرتجع"')
    expect(orderPage).toContain('<Pencil size={15}')
    expect(orderPage).toContain('title="حذف المرتجع"')
    expect(orderPage).toContain('aria-label="حذف المرتجع"')
    expect(orderPage).toContain('<Trash2 size={15}')
    const actions = orderPage.slice(orderPage.indexOf('title="تعديل المرتجع"'), orderPage.indexOf('title="حذف المرتجع"') + 250)
    expect(actions).not.toContain('>تعديل<')
    expect(actions).not.toContain('>حذف<')
  })

  it('shows active history and refreshes every derived consumer after writes', () => {
    for (const header of ['الكمية المرتجعة', 'قيمة المرتجع', 'التاريخ', 'المستخدم', 'ملاحظات']) {
      expect(orderPage).toContain(`header: '${header}'`)
    }
    expect(orderPage).toContain('materialReturns.reload(),')
    expect(orderPage).toContain('accounts.reload()')
    expect(orderPage).not.toContain('actualCosting.reload()')
    expect(orderPage).toContain("returnBusy ? 'جارٍ الحفظ…'")
    expect(orderPage).toContain("returnBusy ? 'جارٍ العكس…'")
  })

  it('shows immutable issued, returned, net-consumed and net-cost values in both preparation views', () => {
    for (const header of ['المصروف', 'المرتجع', 'صافي الاستهلاك', 'صافي التكلفة']) {
      expect(orderPage).toContain(`header: '${header}'`)
      expect(productionPage).toContain(`header: '${header}'`)
    }
    expect(productionPage).toContain('row.physicalQtyMicro')
    expect(productionPage).toContain('row.returnedQtyMicro')
    expect(productionPage).toContain('row.netConsumedQtyMicro')
    expect(productionPage).toContain('row.netCostMinor')
  })

  it('keeps all three write endpoints behind production.returnMaterial', () => {
    for (const method of ['createMaterialReturn', 'editMaterialReturn', 'reverseMaterialReturn']) {
      expect(router).toMatch(new RegExp(`production\\.${method},[\\s\\S]*?permission: P\\.production\\.returnMaterial`))
    }
  })
})
