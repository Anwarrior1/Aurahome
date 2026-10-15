import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as Array<() => void>,
  api: vi.fn(), reload: vi.fn(), tree: [] as unknown[], colors: [] as unknown[], materials: [] as unknown[]
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = runtime.cursor++
    if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [runtime.slots[index], (next: unknown) => {
      runtime.slots[index] = typeof next === 'function'
        ? (next as (value: unknown) => unknown)(runtime.slots[index]) : next
    }]
  },
  useEffect: (effect: () => void) => { runtime.effects.push(effect) }
}))
vi.mock('@renderer/lib/useQuery', () => ({ useQuery: (group: string, method: string) => ({
  data: group === 'categories' && method === 'tree' ? runtime.tree
    : group === 'materials' && method === 'list' ? runtime.materials
    : group === 'materials' && method === 'colorOptions' ? runtime.colors : [],
  loading: false, reload: runtime.reload
}) }))
vi.mock('@renderer/lib/api', () => ({ call: (...args: unknown[]) => runtime.api(...args), ApiError: class extends Error {} }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: vi.fn() }) }))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: () => true }) }))

import { CategoriesPage } from '@renderer/pages/categories/CategoriesPage'
import { MaterialFormModal, type CategoryOption, type MaterialFormRequest } from '@renderer/pages/materials/MaterialFormModal'
import { Button, Field, Input, Modal } from '@renderer/components/ui'
import { SearchableColorSelect } from '@renderer/components/materials/SearchableColorSelect'

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [element, ...elements(element.props.children as ReactNode), ...elements(element.props.footer as ReactNode)]
}
function renderCategories() {
  runtime.cursor = 0
  return elements(CategoriesPage())
}
function renderForm(request: MaterialFormRequest, categoryOptions: CategoryOption[] = []) {
  runtime.cursor = 0
  MaterialFormModal({ request, categoryOptions, onClose: vi.fn(), onSaved: vi.fn() })
  runtime.effects.splice(0).forEach((effect) => effect())
  runtime.cursor = 0
  return elements(MaterialFormModal({ request, categoryOptions, onClose: vi.fn(), onSaved: vi.fn() }))
}
function rerenderForm(request: MaterialFormRequest, categoryOptions: CategoryOption[] = []) {
  runtime.cursor = 0
  return elements(MaterialFormModal({ request, categoryOptions, onClose: vi.fn(), onSaved: vi.fn() }))
}
function field(nodes: ReturnType<typeof elements>, label: string) {
  return nodes.find((element) => element.type === Field && element.props.label === label)!
}
function click(nodes: ReturnType<typeof elements>, label: string) {
  const button = nodes.find((element) => element.type === Button && element.props.children === label)!
  ;(button.props.onClick as () => void)()
}
const node = (id: number, name: string, children: unknown[] = [], parentId: number | null = null, kind = 'material_type') => ({
  id, name, parentId, active: true, showInRawMaterials: false, nodeKind: kind,
  depth: 0, rawMaterialId: null, visibilityMaterialId: null, materialColorId: null,
  materialCount: 0, children
})

beforeEach(() => {
  runtime.slots = []; runtime.cursor = 0; runtime.effects = []; runtime.api.mockReset()
  runtime.reload.mockReset().mockResolvedValue(undefined)
  runtime.api.mockResolvedValue({ id: 10 })
  runtime.colors = [{ id: 5, code: 'WHT', name: 'أبيض' }]
  runtime.materials = []
  runtime.tree = [node(1, 'Wood', [node(2, 'MDF', [node(3, '18', [], 2)], 1)], null, 'main_category')]
})

describe('single shared material form in Categories', () => {
  it('renders the persisted material type badge for root and nested materials after tree refresh', () => {
    const leaf = { ...node(3, 'DEMO-N', [], 2, 'inventory_leaf'), rawMaterialId: 31,
      visibilityMaterialId: 31, materialColorId: 5 }
    runtime.tree = [{ ...node(1, 'PVC', [node(2, 'milamin', [leaf], 1)], null, 'main_category'),
      visibilityMaterialId: 30, materialColorId: null }]
    let page = renderCategories()
    expect(page.filter((item) => item.type === 'span' && item.props.children === 'مادة خام')).toHaveLength(1)
    ;(page.find((item) => item.props['aria-label'] === 'إظهار فروع PVC')!.props.onClick as () => void)()
    page = renderCategories()
    ;(page.find((item) => item.props['aria-label'] === 'إظهار فروع milamin')!.props.onClick as () => void)()
    page = renderCategories()
    expect(page.filter((item) => item.type === 'span' && item.props.children === 'مادة ملونة')).toHaveLength(1)
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    try {
      const onSaved = page.find((item) => item.type === MaterialFormModal)!.props.onSaved as () => void
      onSaved()
      expect(runtime.reload).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
    runtime.tree = [{ ...(runtime.tree[0] as object), materialColorId: 5,
      children: [{ ...node(2, 'milamin', [{ ...leaf, materialColorId: null }], 1) }] }]
    page = renderCategories()
    expect(page.filter((item) => item.type === 'span' && item.props.children === 'مادة ملونة')).toHaveLength(1)
    expect(page.filter((item) => item.type === 'span' && item.props.children === 'مادة خام')).toHaveLength(1)
  })

  it('opens the existing full form from the checkbox with category name and complete path; cancel leaves it unchecked', () => {
    let page = renderCategories()
    const edit = page.find((element) => element.props['aria-label'] === 'تعديل')!
    ;(edit.props.onClick as () => void)()
    page = renderCategories()
    const checkbox = page.find((element) => element.type === 'input' && element.props.type === 'checkbox')!
    ;(checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } })
    page = renderCategories()
    const shared = page.find((element) => element.type === MaterialFormModal)!
    expect((shared.props.request as MaterialFormRequest).categoryToEnable).toMatchObject({
      id: 1, name: 'Wood', path: 'Wood'
    })
    expect(page.find((element) => element.type === Modal)?.props.open).toBe(false)
    ;(shared.props.onClose as () => void)()
    page = renderCategories()
    expect(page.find((element) => element.type === 'input' && element.props.type === 'checkbox')?.props.checked).toBe(false)
    expect(runtime.api).not.toHaveBeenCalled()
  })

  it('uses that same MaterialFormModal for the existing Add Material Item action', () => {
    runtime.tree = [node(1, 'Wood', [node(2, 'MDF', [node(3, '18', [], 2)], 1)], null, 'main_category')]
    let page = renderCategories()
    ;(page.find((element) => element.props['aria-label'] === 'إظهار فروع Wood')!.props.onClick as () => void)()
    page = renderCategories()
    ;(page.find((element) => element.props['aria-label'] === 'إظهار فروع MDF')!.props.onClick as () => void)()
    page = renderCategories()
    const open = page.filter((element) => element.type === Button &&
      Array.isArray(element.props.children) && element.props.children.join('') === '+ إضافة صنف مادة').at(-1)!
    ;(open.props.onClick as () => void)()
    page = renderCategories()
    const shared = page.find((element) => element.type === MaterialFormModal)!
    expect((shared.props.request as MaterialFormRequest).parentNodeId).toBe(3)
    expect((shared.props.request as MaterialFormRequest).parentNodePath).toBe('Wood ← MDF ← 18')
  })

  it('keeps a leaf category name and full path while choosing or changing colors', async () => {
    const options = [{ id: 3, name: 'milamin 18', label: 'milamin 18', showInRawMaterials: true }]
    const request = { parentNodeId: 3, parentNodePath: 'wood ← milamin ← milamin 18', clientRequestId: 'base-name' }
    let form = renderForm(request, options)
    const name = () => elements(field(form, 'اسم المادة').props.children as ReactNode).find((item) => item.type === Input)!
    expect(name().props.value).toBe('milamin 18')
    expect(name().props.disabled).toBe(true)
    expect(elements(field(form, 'المسار').props.children as ReactNode).find((item) => item.type === Input)?.props.value).toBe(request.parentNodePath)
    ;(elements(field(form, 'نوع المادة').props.children as ReactNode)[0]!.props.onChange as (event: unknown) => void)({ target: { value: 'colored' } })
    form = rerenderForm(request, options)
    expect(name().props.value).toBe('milamin 18')
    ;(form.find((item) => item.type === SearchableColorSelect)!.props.onChange as (id: string) => void)('5')
    form = rerenderForm(request, options)
    expect(name().props.value).toBe('milamin 18')
    click(form, 'حفظ')
    await Promise.resolve()
    expect(runtime.api).toHaveBeenCalledWith('categories', 'createChildMaterial', expect.objectContaining({
      parentId: 3, name: 'milamin 18', colorId: 5
    }))
  })

  it('fills the base name when the shared form selects a standalone or intermediate category', () => {
    const options = [
      { id: 1, name: 'PVC', label: 'PVC', showInRawMaterials: true },
      { id: 2, name: 'milamin', label: '└ milamin', showInRawMaterials: true }
    ]
    const request = {}
    let form = renderForm(request, options)
    const category = elements(field(form, 'التصنيف').props.children as ReactNode)[0]!
    ;(category.props.onChange as (event: unknown) => void)({ target: { value: '1' } })
    form = rerenderForm(request, options)
    expect(elements(field(form, 'اسم المادة').props.children as ReactNode).find((item) => item.type === Input)?.props.value).toBe('PVC')
    ;(elements(field(form, 'التصنيف').props.children as ReactNode)[0]!.props.onChange as (event: unknown) => void)({ target: { value: '2' } })
    form = rerenderForm(request, options)
    expect(elements(field(form, 'اسم المادة').props.children as ReactNode).find((item) => item.type === Input)?.props.value).toBe('milamin')
  })

  it('opens a linked material in the same full form for editing', async () => {
    runtime.tree = [{ ...node(1, 'moop'), visibilityMaterialId: 17 }]
    let page = renderCategories()
    ;(page.find((element) => element.props['aria-label'] === 'تعديل')!.props.onClick as () => void)()
    page = renderCategories()
    click(page, 'تعديل المادة')
    await Promise.resolve()
    page = renderCategories()
    const shared = page.find((element) => element.type === MaterialFormModal)!
    expect((shared.props.request as MaterialFormRequest).material).toMatchObject({ id: 10 })
    expect(runtime.api).toHaveBeenCalledWith('materials', 'get', { id: 17 })
  })

  it('preflights category deletion, and cancel leaves the category untouched', async () => {
    runtime.tree = [node(1, 'PVC', [], null, 'main_category')]
    runtime.api.mockResolvedValue({ categoryId: 1, name: 'PVC', ownedMaterialId: 7, blocker: null, message: null })
    let page = renderCategories()
    ;(page.find((item) => item.props['aria-label'] === 'حذف')!.props.onClick as () => Promise<void>)()
    await Promise.resolve()
    page = renderCategories()
    expect(runtime.api).toHaveBeenCalledWith('categories', 'deletePreview', { id: 1 })
    expect(page.find((item) => item.type === Modal && item.props.title === 'حذف التصنيف نهائيًا')?.props.open).toBe(true)
    expect(page.some((item) => item.props.children === 'سيتم حذف هذا التصنيف والمادة المرتبطة به نهائيًا. هل تريد المتابعة؟')).toBe(true)
    const confirmation = page.find((item) => item.type === Modal && item.props.title === 'حذف التصنيف نهائيًا')!
    ;(elements(confirmation.props.footer as ReactNode).find((item) => item.type === Button && item.props.children === 'إلغاء')!.props.onClick as () => void)()
    expect(runtime.api).not.toHaveBeenCalledWith('categories', 'remove', expect.anything())
  })

  it('renders direct material items for edit and safe deletion under their category', () => {
    runtime.tree = [node(1, 'PVC', [], null, 'main_category')]
    runtime.materials = [{ id: 8, sku: 'PVC-W', name: 'PVC', categoryId: 1, hierarchyNodeId: null, creationKey: 'manual-request' }]
    let page = renderCategories()
    ;(page.find((item) => item.props['aria-label'] === 'إظهار فروع PVC')!.props.onClick as () => void)()
    page = renderCategories()
    expect(page.some((item) => item.props['aria-label'] === 'تعديل المادة PVC-W')).toBe(true)
    expect(page.some((item) => item.props['aria-label'] === 'حذف المادة PVC-W')).toBe(true)
  })

  it('refreshes category and catalog views after confirmed category deletion', async () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    runtime.tree = [node(1, 'PVC', [], null, 'main_category')]
    runtime.api.mockResolvedValueOnce({ categoryId: 1, name: 'PVC', ownedMaterialId: 7, blocker: null, message: null })
    let page = renderCategories()
    ;(page.find((item) => item.props['aria-label'] === 'حذف')!.props.onClick as () => Promise<void>)()
    await Promise.resolve()
    page = renderCategories()
    const dialog = page.find((item) => item.type === Modal && item.props.title === 'حذف التصنيف نهائيًا')!
    ;(elements(dialog.props.footer as ReactNode).find((item) => item.type === Button && item.props.children === 'حذف نهائي')!.props.onClick as () => Promise<void>)()
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.api).toHaveBeenCalledWith('categories', 'remove', { id: 1 })
    expect(runtime.reload).toHaveBeenCalled()
    await vi.waitFor(() => expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'catalog-changed' })))
  })

  it('shows the full existing fields in both modes and sends the complete payload through the category transaction', async () => {
    const enabled = renderForm({ categoryToEnable: { id: 3, name: '18', path: 'Wood ← MDF ← 18' } })
    const leaf = renderForm({ parentNodeId: 3, clientRequestId: 'request-123' })
    for (const label of ['نوع المادة', 'الكود / SKU', 'اسم المادة', 'وحدة المخزون (الأساس)',
      'حد إعادة الطلب', 'سعر مرجعي (د.ل للوحدة)', 'قاعدة تسعير العميل', 'ملاحظات']) {
      expect(field(enabled, label)).toBeDefined()
      expect(field(leaf, label)).toBeDefined()
    }
    expect((enabled.find((element) => element.type === Modal)?.props.title)).toBe('إضافة مادة')
    expect((elements(field(enabled, 'اسم المادة').props.children as ReactNode).find((element) => element.type === Input)?.props.value)).toBe('18')
    expect((elements(field(enabled, 'المسار').props.children as ReactNode).find((element) => element.type === Input)?.props.value)).toBe('Wood ← MDF ← 18')
    click(enabled, 'حفظ')
    await Promise.resolve()
    expect(runtime.api).toHaveBeenCalledWith('categories', 'update', expect.objectContaining({
      id: 3, showInRawMaterials: true,
      materialDetails: expect.objectContaining({ name: '18', purchaseUnit: null, tracksDimensions: false, pricingRule: 'exact' })
    }))
  })

  it('offers Raw and Colored in a standalone root; requires a catalog color in the same form', async () => {
    const request = { categoryToEnable: { name: 'PVC', path: 'PVC' } }
    let form = renderForm(request)
    const type = elements(field(form, 'نوع المادة').props.children as ReactNode)[0]!
    expect(type.props.disabled).toBeFalsy()
    expect(elements(type.props.children as ReactNode).filter((item) => item.type === 'option').map((item) => item.props.value)).toEqual(['raw', 'colored'])
    expect(form.some((item) => item.type === SearchableColorSelect)).toBe(false)
    ;(type.props.onChange as (event: unknown) => void)({ target: { value: 'colored' } })
    form = rerenderForm(request)
    expect(form.some((item) => item.type === SearchableColorSelect)).toBe(true)
    click(form, 'حفظ')
    await Promise.resolve()
    expect(runtime.api).not.toHaveBeenCalled()
    form = rerenderForm(request)
    const picker = form.find((item) => item.type === SearchableColorSelect)!
    ;(picker.props.onChange as (id: string) => void)('5')
    form = rerenderForm(request)
    click(form, 'حفظ')
    await Promise.resolve()
    expect(runtime.api).toHaveBeenCalledWith('categories', 'create', expect.objectContaining({
      name: 'PVC', showInRawMaterials: true,
      materialDetails: expect.objectContaining({ name: 'PVC', colorId: 5 })
    }))
  })

  it('loads the saved type and color in the edit form', () => {
    const material = {
      id: 9, sku: 'PVC-001', name: 'PVC', categoryId: 1, unit: 'لوح', hierarchyNodeId: null,
      purchaseUnit: null, purchaseUnitFactorMicro: null, tracksDimensions: false,
      dimensions: null, thickness: null, currentMarketPriceMicro: 0, pricingRule: 'exact',
      commercialUnitSizeMicro: null, reorderLevelMicro: 0, notes: null, active: true, colorId: 5
    }
    const form = renderForm({ material })
    expect(form.find((item) => item.type === Modal)?.props.title).toBe('تعديل مادة')
    expect(elements(field(form, 'نوع المادة').props.children as ReactNode)[0]?.props.value).toBe('colored')
    expect(form.find((item) => item.type === SearchableColorSelect)?.props.value).toBe('5')
  })

  it('displays the base category for a legacy color-named item without persisting a rename', async () => {
    runtime.colors = [{ id: 5, code: 'WHT', name: 'أبيض' }, { id: 6, code: 'GRY', name: 'رمادي' }]
    const material = {
      id: 9, sku: '898', name: 'WHT — أبيض', baseCategoryName: 'milamin 18',
      categoryId: 4, hierarchyNodeId: 4, unit: 'لوح', purchaseUnit: null,
      purchaseUnitFactorMicro: null, tracksDimensions: false, dimensions: null,
      thickness: null, currentMarketPriceMicro: 0, pricingRule: 'exact',
      commercialUnitSizeMicro: null, reorderLevelMicro: 0, notes: null,
      active: true, colorId: 5
    }
    const request = { material }
    let form = renderForm(request)
    expect(elements(field(form, 'اسم المادة').props.children as ReactNode).find((item) => item.type === Input)?.props.value).toBe('milamin 18')
    expect(form.find((item) => item.type === SearchableColorSelect)?.props.value).toBe('5')
    ;(form.find((item) => item.type === SearchableColorSelect)!.props.onChange as (id: string) => void)('6')
    form = rerenderForm(request)
    expect(elements(field(form, 'اسم المادة').props.children as ReactNode).find((item) => item.type === Input)?.props.value).toBe('milamin 18')
    click(form, 'حفظ')
    await Promise.resolve()
    expect(runtime.api).toHaveBeenCalledWith('materials', 'update', expect.objectContaining({ id: 9, sku: '898', colorId: 6 }))
    const payload = runtime.api.mock.calls.at(-1)![2] as Record<string, unknown>
    expect(payload).not.toHaveProperty('name')
  })

  it('explains an empty Color Catalog and rejects an unlisted color', async () => {
    runtime.colors = []
    const request = { categoryToEnable: { name: 'PVC', path: 'PVC' } }
    let form = renderForm(request)
    ;(elements(field(form, 'نوع المادة').props.children as ReactNode)[0]!.props.onChange as (event: unknown) => void)({ target: { value: 'colored' } })
    form = rerenderForm(request)
    expect(form.some((item) => item.type === 'p' && item.props.children === 'لا توجد ألوان متاحة في كتالوج الألوان.')).toBe(true)
    ;(form.find((item) => item.type === SearchableColorSelect)!.props.onChange as (id: string) => void)('999')
    click(rerenderForm(request), 'حفظ')
    await Promise.resolve()
    expect(runtime.api).not.toHaveBeenCalled()
  })
})
