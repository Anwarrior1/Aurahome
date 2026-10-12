import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@renderer/lib/useQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Toolbar
} from '@renderer/components/ui'
import { fmtMoney, fmtQty } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { History, Pencil, Trash2 } from 'lucide-react'
import {
  MaterialFormModal,
  flattenCategoryOptions,
  type Material,
  type CategoryNode,
  type MaterialFormRequest
} from './MaterialFormModal'

interface Stock {
  materialId: number
  qtyMicro: number
  unit: string
  categoryName: string
}
interface FullDeletePreview {
  materialId: number
  name: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}

const RULES: Record<string, string> = {
  exact: 'الكمية المستهلكة فعلياً',
  full_unit: 'وحدة تجارية كاملة',
  round_up: 'تقريب لأعلى وحدة',
  manual: 'إدخال يدوي'
}

function MaterialPathBreadcrumb({ path }: { path?: string }): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [truncated, setTruncated] = useState(false)
  const segments = path?.split(' ← ').filter(Boolean) ?? []
  const displayPath = segments.join(' › ')

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = (): void => setTruncated(container.scrollWidth > container.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [displayPath])

  if (!segments.length) return <span>—</span>

  return (
    <div
      ref={containerRef}
      className="material-path-breadcrumb"
      dir="ltr"
      aria-label={displayPath}
      title={truncated ? displayPath : undefined}
    >
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`}>
          {index > 0 && (
            <span className="material-path-breadcrumb__separator" aria-hidden="true">
              ›
            </span>
          )}
          <bdi
            dir="auto"
            className={
              index === segments.length - 1
                ? 'material-path-breadcrumb__current'
                : 'material-path-breadcrumb__parent'
            }
          >
            {segment}
          </bdi>
        </span>
      ))}
    </div>
  )
}

/**
 * Item 4 — ONE generic material MODEL for anything the factory stocks:
 * boards, hinges, glue, fabric, glass, screws — there is no per-material
 * hard-coded shape. The create/edit form itself now lives in
 * MaterialFormModal, shared with "تصنيفات المواد"'s child-material action (add a
 * material under this category); this page creates nothing on its own
 * — it is the listing/search/filter/stock/edit/delete surface only.
 */
export function MaterialsPage(): ReactElement {
  const { can } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [materialRequest, setMaterialRequest] = useState<MaterialFormRequest | undefined>()
  const [deleteDialog, setDeleteDialog] = useState<{
    row: Material
    preview: FullDeletePreview
    confirmation: string
    error?: string
  }>()

  const filters = { search, categoryId: categoryId ? Number(categoryId) : undefined }
  const list = useQuery<Material[]>('materials', 'list', filters)
  const stock = useQuery<Stock[]>('inventory', 'stock', filters)
  const categoryTree = useQuery<CategoryNode[]>('categories', 'tree')
  const stockById = new Map(stock.data?.map((row) => [row.materialId, row]))
  // A raw material may reference any category in the tree, root or a
  // subcategory at any depth — the filter and the (shared) create/edit
  // form both use this one hierarchical, indented option list.
  const categoryOptions = flattenCategoryOptions(categoryTree.data ?? [])

  /**
   * Delete is always the explicit, permanent full-delete workflow now
   * — never a silent disable. Every click inspects the real dependency
   * graph first and requires the material's exact current name typed
   * back before the final button is even enabled.
   */
  async function removeMaterial(material: Material): Promise<void> {
    try {
      const preview = await call<FullDeletePreview>('materials', 'fullDeletePreview', {
        id: material.id
      })
      setDeleteDialog({ row: material, preview, confirmation: '' })
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر فحص المادة', 'error')
    }
  }

  async function fullDeleteFromDialog(): Promise<void> {
    if (!deleteDialog) return
    if (deleteDialog.confirmation.trim() !== deleteDialog.row.name.trim()) {
      setDeleteDialog({
        ...deleteDialog,
        error: `اكتب اسم المادة "${deleteDialog.row.name}" للتأكيد النهائي`
      })
      return
    }
    try {
      await call('materials', 'fullDelete', {
        id: deleteDialog.row.id,
        confirmation: deleteDialog.confirmation
      })
      toast.show('تم حذف المادة بالكامل مع كل سجلاتها المرتبطة', 'success')
      setDeleteDialog(undefined)
      await Promise.all([list.reload(), stock.reload()])
    } catch (err) {
      setDeleteDialog({
        ...deleteDialog,
        error: err instanceof ApiError ? err.message : 'تعذر حذف المادة بالكامل'
      })
    }
  }

  // MaterialFormModal already shows the success toast — this only
  // closes the modal and refreshes this page's own queries.
  async function onMaterialSaved(): Promise<void> {
    setMaterialRequest(undefined)
    await Promise.all([list.reload(), stock.reload(), categoryTree.reload()])
  }

  return (
    <>
      <PageHeader
        title="المواد الخام"
        subtitle="يعرض أصناف المواد المخزونية النهائية فقط؛ تُنشأ من مستوى «نوع المادة» في شجرة التصنيفات"
      />
      <Card>
        <Toolbar>
          <Field label="بحث">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="الاسم أو الكود أو المسار"
            />
          </Field>
          <Field label="التصنيف">
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">كل التصنيفات</option>
              {categoryOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        </Toolbar>
        <DataTable
          loading={list.loading}
          rows={list.data ?? []}
          rowKey={(row) => row.id}
          empty="لا توجد مواد"
          columns={[
            { key: 'sku', header: 'الكود', render: (row) => row.sku },
            { key: 'name', header: 'المادة', render: (row) => row.name },
            {
              key: 'cat',
              header: 'المسار',
              render: (row) => <MaterialPathBreadcrumb path={row.hierarchyPath} />
            },
            { key: 'unit', header: 'وحدة المخزون', render: (row) => row.unit },
            {
              key: 'stock',
              header: 'الرصيد',
              numeric: true,
              render: (row) => fmtQty(stockById.get(row.id)?.qtyMicro ?? 0, row.unit)
            },
            {
              key: 'price',
              header: 'سعر مرجعي',
              numeric: true,
              render: (row) => fmtMoney(Math.round(row.currentMarketPriceMicro / 1000))
            },
            {
              key: 'rule',
              header: 'قاعدة التسعير',
              render: (row) => (
                <Badge tone="info">{RULES[row.pricingRule] ?? row.pricingRule}</Badge>
              )
            },
            {
              key: 'actions',
              header: '',
              render: (row) => (
                <div className="row-actions">
                  {can(P.inventory.view) && (
                    <button
                      type="button"
                      className="icon-btn"
                      title="سجل حركة المخزون"
                      aria-label="سجل حركة المخزون"
                      onClick={() => navigate(`/inventory?materialId=${row.id}`)}
                    >
                      <History size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                  {can(P.materials.manage) && (
                    <button
                      type="button"
                      className="icon-btn"
                      title="تعديل"
                      aria-label="تعديل"
                      onClick={() => setMaterialRequest({ material: row })}
                    >
                      <Pencil size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                  {can(P.materials.fullDelete) && (
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger"
                      title="حذف"
                      aria-label="حذف"
                      onClick={() => void removeMaterial(row)}
                    >
                      <Trash2 size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )
            }
          ]}
        />
      </Card>

      <MaterialFormModal
        request={materialRequest}
        categoryOptions={categoryOptions}
        onClose={() => setMaterialRequest(undefined)}
        onSaved={() => void onMaterialSaved()}
      />

      <Modal
        open={Boolean(deleteDialog)}
        wide
        title="حذف المادة نهائيًا"
        onClose={() => setDeleteDialog(undefined)}
        footer={
          <>
            <Button
              variant="destructive"
              disabled={
                Boolean(deleteDialog?.preview.blockers.length) ||
                deleteDialog?.confirmation.trim() !== deleteDialog?.row.name.trim()
              }
              onClick={() => void fullDeleteFromDialog()}
            >
              حذف نهائي
            </Button>
            <Button variant="secondary" onClick={() => setDeleteDialog(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{deleteDialog?.error}</ErrorNote>
        <p>أنت على وشك حذف:</p>
        <p>
          <strong>اسم المادة:</strong> {deleteDialog?.row.name}
        </p>
        <p>سيتم حذف المادة وجميع السجلات المرتبطة بها نهائيًا. قد يشمل ذلك:</p>
        <ul>
          <li>حركات المخزون</li>
          <li>أرصدة المخزون (طبقات التكلفة)</li>
          <li>سجلات الشراء المرتبطة (أو بندها ضمن فاتورة شراء متعددة المواد)</li>
          <li>مكونات في قوائم المنتجات</li>
          <li>مراجع في خطط الإنتاج والفواتير — مع الحفاظ على النسخة التاريخية منها</li>
        </ul>
        <p style={{ fontWeight: 600, fontSize: 12.5 }}>سيتم حذف:</p>
        <ul>
          <li>المادة: 1</li>
          {(deleteDialog?.preview.dependencies ?? []).map((item) => (
            <li key={item.key}>
              {item.label}: {item.count}
            </li>
          ))}
        </ul>
        {(deleteDialog?.preview.blockers.length ?? 0) > 0 && (
          <div className="error-note">
            لا يمكن تنفيذ الحذف الكامل حالياً: {deleteDialog!.preview.blockers.join('، ')}
          </div>
        )}
        <p className="muted">هذا الإجراء نهائي ولا يمكن التراجع عنه.</p>
        <Field label={`للتأكيد، اكتب اسم المادة "${deleteDialog?.row.name ?? ''}"`} required>
          <Input
            value={deleteDialog?.confirmation ?? ''}
            onChange={(e) =>
              setDeleteDialog(
                deleteDialog
                  ? { ...deleteDialog, confirmation: e.target.value, error: undefined }
                  : undefined
              )
            }
          />
        </Field>
      </Modal>
    </>
  )
}
