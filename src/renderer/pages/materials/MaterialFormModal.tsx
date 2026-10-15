import { useState, useEffect, type ReactElement } from 'react'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { Button, ErrorNote, Field, Input, Modal, Select, Textarea } from '@renderer/components/ui'
import { toMicro, fromMicro } from '@renderer/lib/format'
import { useQuery } from '@renderer/lib/useQuery'
import {
  SearchableColorSelect,
  type ColorOption
} from '@renderer/components/materials/SearchableColorSelect'

export interface Material {
  id: number
  sku: string
  name: string
  categoryId: number
  unit: string
  hierarchyNodeId: number | null
  creationKey?: string | null
  hierarchyPath?: string
  purchaseUnit: string | null
  purchaseUnitFactorMicro: number | null
  tracksDimensions: boolean
  dimensions: string | null
  thickness: string | null
  currentMarketPriceMicro: number
  pricingRule: string
  commercialUnitSizeMicro: number | null
  reorderLevelMicro: number
  notes: string | null
  active: boolean
  colorId: number | null
  baseCategoryName?: string | null
}
export interface CategoryOption {
  id: number
  name: string
  label: string
  showInRawMaterials: boolean
}
/** Loose enough that both المواد الخام's own tree query and تصنيفات
 *  المواد's richer one (extra fields like materialCount) satisfy it. */
export interface CategoryNode {
  id: number
  name: string
  showInRawMaterials: boolean
  children: CategoryNode[]
}

const RULES: Record<string, string> = {
  exact: 'الكمية المستهلكة فعلياً',
  full_unit: 'وحدة تجارية كاملة',
  round_up: 'تقريب لأعلى وحدة',
  manual: 'إدخال يدوي'
}

/**
 * A hierarchical picker, not a flattened list. "Wood / MDF / Contour" as
 * three equal choices was the original bug: a child renders indented
 * under its parent with a connector, in the tree's own order.
 */
export function flattenCategoryOptions(nodes: CategoryNode[], depth = 0): CategoryOption[] {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name, label: `${'  '.repeat(depth)}${depth > 0 ? '└ ' : ''}${node.name}`, showInRawMaterials: node.showInRawMaterials },
    ...flattenCategoryOptions(node.children, depth + 1)
  ])
}

export function assignmentCategoryOptions(options: CategoryOption[], currentId?: number): CategoryOption[] {
  const selectable = options.filter((category) => category.showInRawMaterials)
  const current = options.find((category) => category.id === currentId)
  return current && !current.showInRawMaterials
    ? [{ ...current, label: `${current.label} — غير متاح للتعيينات الجديدة` }, ...selectable]
    : selectable
}

/**
 * `material` set = editing that authoritative row. Otherwise the
 * stable material-type node and request id create one linked leaf atomically.
 */
export interface MaterialFormRequest {
  material?: Material
  parentNodeId?: number
  parentNodePath?: string
  clientRequestId?: string
  categoryToEnable?: { id?: number; name: string; parentId?: number; path: string }
}

/**
 * The Raw Material create/edit form — used from المواد الخام and
 * تصنيفات المواد's "صنف مادة" action.
 * Every field, every validation rule and
 * the save call itself live here once; neither caller repeats any of it.
 */
export function MaterialFormModal({
  request,
  categoryOptions,
  onClose,
  onSaved
}: {
  request: MaterialFormRequest | undefined
  categoryOptions: CategoryOption[]
  onClose: () => void
  onSaved: () => void
}): ReactElement {
  const toast = useToast()
  const [form, setForm] = useState<Record<string, string | boolean> | undefined>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const colors = useQuery<ColorOption[]>('materials', 'colorOptions', undefined, {
    enabled: Boolean(request)
  })
  const assignmentOptions = assignmentCategoryOptions(
    categoryOptions,
    request?.material && !request.material.hierarchyNodeId ? request.material.categoryId : undefined
  )
  const selectedCategoryName = categoryOptions.find((category) => category.id === Number(form?.categoryId))?.name
  const baseName = request?.categoryToEnable?.name ??
    (request?.parentNodeId ? categoryOptions.find((category) => category.id === request.parentNodeId)?.name : undefined) ??
    request?.material?.baseCategoryName ?? selectedCategoryName

  // Re-seeds the form fresh every time a NEW open request arrives —
  // editing a different row, or creating under a different clicked
  // category — never on every keystroke, since only `request` itself
  // (a fresh object each time the caller opens the modal) is watched.
  useEffect(() => {
    if (!request) return
    const material = request.material
    setForm({
      sku: material?.sku ?? '',
      name: request.categoryToEnable?.name ??
        (request.parentNodeId ? categoryOptions.find((category) => category.id === request.parentNodeId)?.name : undefined) ??
        material?.baseCategoryName ??
        (material ? categoryOptions.find((category) => category.id === material.categoryId)?.name : undefined) ??
        material?.name ?? '',
      leafType: material?.colorId ? 'colored' : 'raw',
      colorId: material?.colorId ? String(material.colorId) : '',
      categoryId: String(material?.categoryId ?? request.categoryToEnable?.id ?? ''),
      unit: material?.unit ?? '',
      hasPurchaseUnit: Boolean(material?.purchaseUnit),
      purchaseUnit: material?.purchaseUnit ?? '',
      purchaseUnitFactor: material?.purchaseUnitFactorMicro
        ? fromMicro(material.purchaseUnitFactorMicro)
        : '',
      tracksDimensions: material?.tracksDimensions ?? false,
      dimensions: material?.dimensions ?? '',
      thickness: material?.thickness ?? '',
      marketPrice: material ? String(material.currentMarketPriceMicro / 1_000_000) : '',
      pricingRule: material?.pricingRule ?? 'exact',
      commercialUnitSize: material?.commercialUnitSizeMicro
        ? fromMicro(material.commercialUnitSizeMicro)
        : '',
      reorderLevel: material ? fromMicro(material.reorderLevelMicro) : '',
      notes: material?.notes ?? '',
      active: material?.active ?? true
    })
    setError(undefined)
    setSaving(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  async function save(): Promise<void> {
    if (!form || saving) return
    if (!request?.parentNodeId && !request?.categoryToEnable && !request?.material?.hierarchyNodeId && !form.categoryId) {
      setError('اختر التصنيف')
      return
    }
    if (form.leafType === 'colored' && (!form.colorId ||
      (Number(form.colorId) !== request?.material?.colorId &&
        !colors.data?.some((color) => color.id === Number(form.colorId))))) {
      setError('يرجى اختيار لون الصنف من كتالوج الألوان.')
      return
    }
    setSaving(true)
    try {
      const hasPurchaseUnit = Boolean(form.hasPurchaseUnit)
      const tracksDimensions = Boolean(form.tracksDimensions)
      const payload = {
        sku: String(form.sku),
        name: String(form.name),
        unit: String(form.unit),
        purchaseUnit: hasPurchaseUnit && form.purchaseUnit ? String(form.purchaseUnit) : null,
        purchaseUnitFactorMicro:
          hasPurchaseUnit && form.purchaseUnitFactor
            ? toMicro(String(form.purchaseUnitFactor))
            : null,
        tracksDimensions,
        dimensions: tracksDimensions && form.dimensions ? String(form.dimensions) : null,
        thickness: tracksDimensions && form.thickness ? String(form.thickness) : null,
        currentMarketPriceMicro: Math.round(Number(form.marketPrice || 0) * 1_000_000),
        pricingRule: String(form.pricingRule) as 'exact',
        commercialUnitSizeMicro: form.commercialUnitSize
          ? toMicro(String(form.commercialUnitSize))
          : null,
        reorderLevelMicro: form.reorderLevel ? toMicro(String(form.reorderLevel)) : 0,
        notes: form.notes ? String(form.notes) : null,
        active: Boolean(form.active),
        colorId: form.leafType === 'colored' ? Number(form.colorId) : null
      }
      if (request?.categoryToEnable) {
        const { id, name, parentId } = request.categoryToEnable
        if (id) {
          await call('categories', 'update', { id, name, showInRawMaterials: true, materialDetails: payload })
        } else {
          await call('categories', 'create', { name, parentId, showInRawMaterials: true, materialDetails: payload })
        }
      } else if (request?.material) {
        const { name, ...materialUpdate } = payload
        await call('materials', 'update', {
          id: request.material.id,
          ...materialUpdate,
          ...(!baseName ? { name } : {}),
          categoryId: request.material.hierarchyNodeId
            ? request.material.categoryId
            : Number(form.categoryId)
        })
      } else if (request?.parentNodeId && request.clientRequestId) {
        await call('categories', 'createChildMaterial', {
          ...payload,
          leafType: String(form.leafType) as 'raw' | 'colored',
          parentId: request.parentNodeId,
          clientRequestId: request.clientRequestId
        })
      } else {
        await call('materials', 'create', { ...payload, categoryId: Number(form.categoryId) })
      }
      toast.show('تم حفظ المادة', 'success')
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('catalog-changed'))
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
      setSaving(false)
    }
  }

  return (
    <Modal
      open={Boolean(request)}
      wide
      title={request?.material ? 'تعديل مادة' : 'إضافة مادة'}
      onClose={onClose}
      footer={
        <>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? 'جارٍ الحفظ…' : 'حفظ'}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            إلغاء
          </Button>
        </>
      }
    >
      <ErrorNote>{error}</ErrorNote>
      {form && (
        <>
          {/* ---------- البيانات الأساسية — كل مادة تحتاجها ---------- */}
          <h3 className="form-section-title">البيانات الأساسية</h3>
          <div className="grid grid--3">
            {request && (
              <Field label="نوع المادة" required>
                <Select
                  value={String(form.leafType)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      leafType: e.target.value,
                      colorId: ''
                    })
                  }
                >
                  <option value="raw">خام</option>
                  <option value="colored">ملون</option>
                </Select>
              </Field>
            )}
            <Field label="الكود / SKU" required>
              <Input
                value={String(form.sku)}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
              />
            </Field>
            <Field label="اسم المادة" required>
              <Input
                value={String(form.name)}
                disabled={Boolean(baseName)}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            {form.leafType === 'colored' && (
              <Field label="لون الصنف" required>
                <SearchableColorSelect
                  colors={colors.data ?? []}
                  value={String(form.colorId)}
                  valueMode="id"
                  noneLabel="— اختر من كتالوج الألوان —"
                  historicalValueLabel={`لون محفوظ (#${form.colorId})`}
                  onChange={(colorId) => setForm({ ...form, colorId })}
                />
              </Field>
            )}
            {form.leafType === 'colored' && !colors.loading && !colors.data?.length && (
              <p className="muted">لا توجد ألوان متاحة في كتالوج الألوان.</p>
            )}
            {request?.categoryToEnable ? (
              <Field label="المسار">
                <Input value={request.categoryToEnable.path} disabled />
              </Field>
            ) : request?.material?.hierarchyNodeId ? (
              <Field label="المسار">
                <Input
                  value={`${request.material.hierarchyPath ?? request.material.name}${
                    categoryOptions.find((category) => category.id === request.material?.categoryId)?.showInRawMaterials === false
                      ? ' — غير متاح للتعيينات الجديدة'
                      : ''
                  }`}
                  disabled
                />
              </Field>
            ) : request?.material || !request?.parentNodeId ? (
              <Field label="التصنيف" required>
                <Select
                  value={String(form.categoryId)}
                  onChange={(e) => setForm({
                    ...form,
                    categoryId: e.target.value,
                    name: categoryOptions.find((category) => category.id === Number(e.target.value))?.name ?? ''
                  })}
                >
                  <option value="">— اختر التصنيف —</option>
                  {assignmentOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="المسار">
                <Input
                  value={request?.parentNodePath ?? categoryOptions.find((c) => c.id === request?.parentNodeId)?.name ?? '—'}
                  disabled
                />
              </Field>
            )}
          </div>

          {/* ---------- وحدة المخزون والشراء ---------- */}
          <h3 className="form-section-title">وحدة المخزون والشراء</h3>
          <div className="grid grid--3">
            <Field label="وحدة المخزون (الأساس)" required hint="قطعة، لوح، متر، لتر، كغ…">
              <Input
                value={String(form.unit)}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
              />
            </Field>
            <Field label="حد إعادة الطلب">
              <Input
                type="number"
                step="0.001"
                value={String(form.reorderLevel)}
                onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })}
              />
            </Field>
            <div />
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(form.hasPurchaseUnit)}
              onChange={(e) => setForm({ ...form, hasPurchaseUnit: e.target.checked })}
            />
            <span>تُشترى بوحدة مختلفة عن وحدة المخزون (مثال: تُخزَّن بالقطعة وتُشترى بالعلبة)</span>
          </label>
          {Boolean(form.hasPurchaseUnit) && (
            <div className="grid grid--3" style={{ marginTop: 4 }}>
              <Field label="وحدة الشراء" required hint="علبة، جالون، رول…">
                <Input
                  value={String(form.purchaseUnit)}
                  onChange={(e) => setForm({ ...form, purchaseUnit: e.target.value })}
                />
              </Field>
              <Field
                label={`كل وحدة شراء تحتوي على`}
                required
                hint={`بوحدة المخزون (${String(form.unit) || '—'})`}
              >
                <Input
                  type="number"
                  step="0.001"
                  value={String(form.purchaseUnitFactor)}
                  onChange={(e) => setForm({ ...form, purchaseUnitFactor: e.target.value })}
                />
              </Field>
              <div />
            </div>
          )}

          {/* ---------- الأبعاد — فقط للمواد التي تحتاجها ---------- */}
          <h3 className="form-section-title">الأبعاد</h3>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(form.tracksDimensions)}
              onChange={(e) => setForm({ ...form, tracksDimensions: e.target.checked })}
            />
            <span>تتبّع الأبعاد لهذه المادة (طول/عرض/سماكة) — للألواح والزجاج ونحوها</span>
          </label>
          {Boolean(form.tracksDimensions) && (
            <div className="grid grid--3" style={{ marginTop: 4 }}>
              <Field label="الأبعاد" required>
                <Input
                  value={String(form.dimensions)}
                  onChange={(e) => setForm({ ...form, dimensions: e.target.value })}
                />
              </Field>
              <Field label="السماكة">
                <Input
                  value={String(form.thickness)}
                  onChange={(e) => setForm({ ...form, thickness: e.target.value })}
                />
              </Field>
              <div />
            </div>
          )}

          {/* ---------- التسعير المرجعي ---------- */}
          <h3 className="form-section-title">التسعير</h3>
          <div className="grid grid--3">
            <Field
              label="سعر مرجعي (د.ل للوحدة)"
              required
              hint="للتقدير الداخلي فقط — لا يغيّر تكلفة المشتريات السابقة المسجّلة"
            >
              <Input
                type="number"
                step="0.000001"
                value={String(form.marketPrice)}
                onChange={(e) => setForm({ ...form, marketPrice: e.target.value })}
              />
            </Field>
            <Field label="قاعدة تسعير العميل" required>
              <Select
                value={String(form.pricingRule)}
                onChange={(e) => setForm({ ...form, pricingRule: e.target.value })}
              >
                {Object.entries(RULES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            {form.pricingRule === 'full_unit' && (
              <Field label="حجم الوحدة التجارية" required hint="مطلوب لتسعير الوحدة الكاملة">
                <Input
                  type="number"
                  step="0.000001"
                  value={String(form.commercialUnitSize)}
                  onChange={(e) => setForm({ ...form, commercialUnitSize: e.target.value })}
                />
              </Field>
            )}
          </div>

          <h3 className="form-section-title">ملاحظات</h3>
          <Field label="ملاحظات">
            <Textarea
              value={String(form.notes)}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
        </>
      )}
    </Modal>
  )
}
