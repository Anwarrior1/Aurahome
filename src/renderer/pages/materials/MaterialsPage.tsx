import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@renderer/lib/useQuery'
import { useSession } from '@renderer/state/session.store'
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  PageHeader,
  Select,
  Toolbar
} from '@renderer/components/ui'
import { fmtMoney, fmtQty } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { History, Pencil } from 'lucide-react'
import {
  MaterialFormModal,
  assignmentCategoryOptions,
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
 * material under this category). This page also creates a direct material
 * assignment to any explicitly enabled category.
 */
export function MaterialsPage(): ReactElement {
  const { can } = useSession()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [materialRequest, setMaterialRequest] = useState<MaterialFormRequest | undefined>()

  const filters = { search, categoryId: categoryId ? Number(categoryId) : undefined, activeOnly: true }
  const list = useQuery<Material[]>('materials', 'list', filters)
  const stock = useQuery<Stock[]>('inventory', 'stock', filters)
  const categoryTree = useQuery<CategoryNode[]>('categories', 'tree')
  const { reload: reloadList } = list
  const { reload: reloadStock } = stock
  const { reload: reloadCategories } = categoryTree
  useEffect(() => {
    const refresh = (): void => { void Promise.all([reloadList(), reloadStock(), reloadCategories()]) }
    window.addEventListener('catalog-category-changed', refresh)
    return () => window.removeEventListener('catalog-category-changed', refresh)
  }, [reloadList, reloadStock, reloadCategories])
  const stockById = new Map(stock.data?.map((row) => [row.materialId, row]))
  // Keep every category for existing material edits; the navigation lists
  // only categories explicitly enabled for Raw Materials.
  const categoryOptions = flattenCategoryOptions(categoryTree.data ?? [])
  const navigationOptions = assignmentCategoryOptions(categoryOptions)

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
        subtitle="أنشئ مادة خام ضمن أي تصنيف مفعّل للظهور هنا"
        actions={can(P.materials.manage) && (
          <Button onClick={() => setMaterialRequest({})}>+ مادة خام</Button>
        )}
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
              {navigationOptions.map((c) => (
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

    </>
  )
}
