import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync('src/renderer/pages/orders/OrderDetailPage.tsx', 'utf8')
const materialSelect = readFileSync('src/renderer/components/materials/SearchableMaterialSelect.tsx', 'utf8')
const colorSelect = readFileSync('src/renderer/components/materials/SearchableColorSelect.tsx', 'utf8')
const dropdown = readFileSync('src/renderer/components/materials/DropdownPanel.tsx', 'utf8')
const router = readFileSync('src/main/ipc/router.ts', 'utf8')

describe('Production Materials catalog color selector', () => {
  it('loads the existing active catalog and reuses the exact invoice searchable component', () => {
    expect(page).toContain("useQuery<Array<{ id: number; code: string; name: string }>>('colors', 'list', { activeOnly: true }")
    expect(page).toContain('<SearchableColorSelect')
    expect(page).toContain('colors={colors.data ?? []}')
    expect(page).toContain('historicalValueLabel=')
  })

  it('inherits the proven internal search, empty state, below-anchor placement and exact trigger width', () => {
    expect(colorSelect).toContain('placeholder="بحث عن كود لون أو تشطيب..."')
    expect(colorSelect).toContain('لا يوجد كود لون/تشطيب مطابق')
    expect(dropdown).toContain('top: anchor.bottom + TRIGGER_OFFSET')
    expect(dropdown).toContain('width, minWidth: width, maxWidth: width')
  })
})

describe('Production Materials searchable material selector', () => {
  it('reuses the invoice searchable material component with the existing Raw Materials source', () => {
    expect(page).toContain("useQuery<Array<{ id: number; sku: string; name: string; unit: string;")
    expect(page).toContain("('materials', 'list', {}, { enabled: can(P.orders.viewEstimatedCost) })")
    expect(page).toContain('<SearchableMaterialSelect')
    expect(page).toContain('materials={rawMaterials.data ?? []}')
  })

  it('keeps the existing material selection side effects exactly at the call site', () => {
    expect(page).toContain('materialName: material?.name ?? line.materialName')
    expect(page).toContain('unit: material?.unit ?? line.unit')
    expect(page).toContain('thickness: material?.thickness ?? line.thickness')
    expect(page).toContain('dimensions: material?.dimensions ?? line.dimensions')
    expect(page).toContain('unitCost: material ? String(material.currentMarketPriceMicro / 1_000_000) : line.unitCost')
  })

  it('inherits invoice search, keyboard navigation, temporary-query reset and the shared single-open coordinator', () => {
    expect(materialSelect).toContain("searchPlaceholder = 'بحث عن مادة...'")
    expect(materialSelect).toContain("emptyText = 'لا توجد مادة مطابقة'")
    expect(materialSelect).toContain('norm(m.name).includes(q) || norm(m.sku).includes(q)')
    expect(materialSelect).toContain("event.key === 'ArrowDown'")
    expect(materialSelect).toContain("event.key === 'ArrowUp'")
    expect(materialSelect).toContain("event.key === 'Enter'")
    expect(materialSelect).toContain("event.key === 'Escape'")
    expect(materialSelect).toContain("event.key === 'Tab'")
    expect(materialSelect).toContain("setQuery('')")
    expect(materialSelect).toContain('useSingleOpenDropdown()')
    expect(colorSelect).toContain('useSingleOpenDropdown()')
  })
})

describe('Production Machines automatic estimate UI', () => {
  it('updates the rate when machine selection changes and when legacy usage is edited', () => {
    expect(page).toContain('const rateMicro = machine?.defaultRateMicro ?? null')
    expect(page).toContain('const rateMicro = line.rateMicro ?? selectedMachine?.defaultRateMicro ?? null')
    expect(page).toContain('machineEstimateMinor(line)')
  })

  it('keeps estimated cost visible and read-only, with a clear missing-configuration state', () => {
    const estimateField = page.slice(page.indexOf('<Field label="التكلفة التقديرية (د.ل)"'))
    expect(estimateField.slice(0, 900)).toContain('readOnly')
    expect(estimateField.slice(0, 900)).toContain('aria-readonly="true"')
    expect(estimateField.slice(0, 900)).not.toContain('onChange=')
    expect(page).toContain('اضبط تكلفة الوحدة للآلة المحددة قبل حفظ تجهيز الإنتاج')
  })

  it('does not send a client-calculated total and retains orders.manage RBAC', () => {
    const payload = page.slice(page.indexOf("call('orders', 'savePlannedMachines'"), page.indexOf("} else if (which === 'workers')"))
    expect(payload).not.toContain('estimatedCostMinor')
    expect(router.slice(router.indexOf('IPC_CHANNELS.orders.savePlannedMachines,'), router.indexOf('IPC_CHANNELS.orders.savePlannedWorkers,'))).toContain('permission: P.productionPrep.manage')
  })
})
