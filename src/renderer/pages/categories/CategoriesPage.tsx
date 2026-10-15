import { useState, type ReactElement } from 'react'
import { ChevronDown, ChevronLeft, Pencil, Settings2, Trash2 } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Toolbar
} from '@renderer/components/ui'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import {
  MaterialFormModal,
  flattenCategoryOptions,
  type Material,
  type MaterialFormRequest
} from '../materials/MaterialFormModal'

interface Node {
  id: number
  name: string
  parentId: number | null
  active: boolean
  showInRawMaterials: boolean
  nodeKind:
    'main_category' | 'material_family' | 'material_type' | 'inventory_leaf' | 'legacy_ambiguous'
  depth: number
  rawMaterialId: number | null
  visibilityMaterialId: number | null
  materialColorId: number | null
  materialCount: number
  children: Node[]
}
interface MaterialDefinitionDeletePreview {
  materialId: number
  name: string
  categoryId: number
  blocker: string | null
  message: string | null
}
interface CategoryDeletePreview {
  categoryId: number
  name: string
  ownedMaterialId: number | null
  blocker: 'children' | 'materials' | 'stock' | 'history' | 'ambiguous' | null
  message: string | null
}

/** Direct child-material count, derived from the recursive tree. */
function childCountLabel(count: number): string {
  if (count === 0) return 'لا توجد مواد فرعية'
  if (count === 1) return 'مادة فرعية واحدة'
  return `${count} مواد فرعية`
}

/** Whether `node` itself, or anything anywhere beneath it, matches the
 *  search text — used both to decide whether a branch is worth keeping
 *  on screen and to auto-open a collapsed ancestor above a match. */
function subtreeMatches(node: Node, query: string): boolean {
  if (node.name.toLowerCase().includes(query)) return true
  return node.children.some((child) => subtreeMatches(child, query))
}

function categoryPath(nodes: Node[], id: number, ancestors: string[] = []): string {
  for (const node of nodes) {
    const path = [...ancestors, node.name]
    if (node.id === id) return path.join(' ← ')
    const found = categoryPath(node.children, id, path)
    if (found) return found
  }
  return ''
}

/**
 * A real expand/collapse tree (item 2/10): collapse state is per-category,
 * lives only in this component, and starts EMPTY on every fresh visit to
 * the page — so every parent begins collapsed (item 1) and any number of
 * them can be opened independently, with no forced accordion.
 *
 * Roots are visually stronger; categories with an associated material
 * receive a type badge, while organizational nodes remain ordinary branches.
 */
export function CategoriesPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [editing, setEditing] = useState<
    | {
        id?: number
        name: string
        showInRawMaterials: boolean
        linkedMaterialId?: number
        visibilityMaterialId?: number
        parentId?: number
        levelLabel: string
      }
    | undefined
  >()
  const [error, setError] = useState<string>()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [search, setSearch] = useState('')
  // Both category visibility and inventory-leaf creation use the shared material form.
  const [materialRequest, setMaterialRequest] = useState<MaterialFormRequest | undefined>()
  const [deleteDialog, setDeleteDialog] = useState<{
    materialId: number
    name: string
    confirmation: string
    error?: string
  }>()
  const [categoryDeleteDialog, setCategoryDeleteDialog] = useState<CategoryDeletePreview>()

  const tree = useQuery<Node[]>('categories', 'tree')
  const materials = useQuery<Material[]>('materials', 'list', {})
  const categoryOptions = flattenCategoryOptions(tree.data ?? [])

  function openVisibilityMaterialForm(category: NonNullable<typeof editing>): void {
    if (!category.name.trim()) {
      setError('اسم التصنيف مطلوب')
      return
    }
    const parentPath = category.parentId ? categoryPath(tree.data ?? [], category.parentId) : ''
    setMaterialRequest({
      categoryToEnable: {
        id: category.id,
        name: category.name.trim(),
        parentId: category.parentId,
        path: [parentPath, category.name.trim()].filter(Boolean).join(' ← ')
      }
    })
    setError(undefined)
  }

  function toggle(id: number): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function save(): Promise<void> {
    if (!editing?.name.trim()) {
      setError('اسم التصنيف مطلوب')
      return
    }
    if (editing.showInRawMaterials && !editing.visibilityMaterialId) {
      openVisibilityMaterialForm(editing)
      return
    }
    try {
      const payload = {
        ...(!editing.linkedMaterialId ? { name: editing.name } : {}),
        showInRawMaterials: editing.showInRawMaterials,
        ...(!editing.id && editing.parentId ? { parentId: editing.parentId } : {})
      }
      if (editing.id) await call('categories', 'update', { id: editing.id, ...payload })
      else await call('categories', 'create', payload)
      toast.show('تم حفظ التصنيف', 'success')
      setEditing(undefined)
      setError(undefined)
      await tree.reload()
      window.dispatchEvent(new Event('catalog-category-changed'))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  async function remove(id: number): Promise<void> {
    try {
      const preview = await call<CategoryDeletePreview>('categories', 'deletePreview', { id })
      if (preview.message) {
        toast.show(preview.message, 'error')
        return
      }
      setCategoryDeleteDialog(preview)
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر فحص التصنيف', 'error')
    }
  }

  async function confirmCategoryDelete(): Promise<void> {
    if (!categoryDeleteDialog) return
    try {
      await call('categories', 'remove', { id: categoryDeleteDialog.categoryId })
      toast.show('تم حذف التصنيف', 'success')
      setCategoryDeleteDialog(undefined)
      await Promise.all([tree.reload(), materials.reload()])
      window.dispatchEvent(new Event('catalog-category-changed'))
      window.dispatchEvent(new Event('catalog-changed'))
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error')
    }
  }

  function editCategory(node: Node): void {
    setEditing({
      id: node.id,
      name: node.name,
      showInRawMaterials: node.showInRawMaterials,
      linkedMaterialId: node.rawMaterialId ?? undefined,
      visibilityMaterialId: node.visibilityMaterialId ?? undefined,
      parentId: node.parentId ?? undefined,
      levelLabel:
        node.nodeKind === 'main_category'
          ? 'تصنيف رئيسي'
          : node.nodeKind === 'material_family'
            ? 'فئة مادة'
            : node.nodeKind === 'material_type'
              ? 'نوع مادة'
              : node.nodeKind === 'inventory_leaf'
                ? 'تصنيف المادة'
                : 'عنصر تصنيف قديم'
    })
    setError(undefined)
  }

  async function editNode(node: Node): Promise<void> {
    if (!node.rawMaterialId) return editCategory(node)
    try {
      const material = await call<Material>('materials', 'get', { id: node.rawMaterialId })
      setMaterialRequest({ material })
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر تحميل المادة', 'error')
    }
  }

  async function openMaterialDelete(materialId: number): Promise<void> {
    try {
      const preview = await call<MaterialDefinitionDeletePreview>('categories', 'materialDeletePreview', { id: materialId })
      if (preview.message) {
        toast.show(preview.message, 'error')
        return
      }
      setDeleteDialog({
        materialId,
        name: preview.name,
        confirmation: ''
      })
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر فحص المادة', 'error')
    }
  }

  async function confirmMaterialDelete(): Promise<void> {
    if (!deleteDialog) return
    try {
      await call('categories', 'removeMaterial', {
        id: deleteDialog.materialId,
        confirmation: deleteDialog.confirmation
      })
      toast.show('تم حذف المادة', 'success')
      setDeleteDialog(undefined)
      await Promise.all([tree.reload(), materials.reload()])
      window.dispatchEvent(new Event('catalog-category-changed'))
      window.dispatchEvent(new Event('catalog-changed'))
    } catch (err) {
      setDeleteDialog({
        ...deleteDialog,
        error: err instanceof ApiError ? err.message : 'تعذر حذف المادة'
      })
    }
  }

  const query = search.trim().toLowerCase()
  const searching = query.length > 0

  /**
   * `forceShow` means an ancestor's own name already matched, so this
   * whole branch renders regardless of what matches further down — the
   * spec's "matching parent categories remain visible" (with their real
   * children, not just the row itself). Without that, a branch renders
   * only while it still has a reason to (item 11: a matching child
   * "temporarily reveals" its parent — never the other way around, and
   * never permanently: none of this touches `expanded`, so clearing the
   * search returns the tree to exactly the manual state it had before).
   */
  function renderNode(node: Node, depth: number, forceShow: boolean): ReactElement | null {
    if (searching && !forceShow && !subtreeMatches(node, query)) return null

    const selfMatched = searching && node.name.toLowerCase().includes(query)
    const childForceShow = forceShow || selfMatched
    const directItems = (materials.data ?? []).filter((item) => item.categoryId === node.id &&
      item.hierarchyNodeId === null && !item.creationKey?.startsWith('category-visibility:'))
    const hasChildren = node.children.length > 0 || directItems.length > 0
    const isExpanded = searching ? true : expanded.has(node.id)
    const isTopLevel = depth === 0
    const addLabel =
      node.nodeKind === 'main_category'
        ? 'فئة مادة'
        : node.nodeKind === 'material_family'
          ? 'نوع مادة'
          : node.nodeKind === 'material_type'
            ? 'صنف مادة'
            : undefined
    const children = node.children.length > 0
      ? node.children
          .map((child) => renderNode(child, depth + 1, childForceShow))
          .filter((el): el is ReactElement => el !== null)
      : []

    return (
      <div
        key={node.id}
        className={isTopLevel ? 'category-branch category-branch--root' : 'category-branch'}
      >
        <div
          className={`category-row ${isTopLevel ? 'category-row--parent' : 'category-row--child'}`}
          style={{ paddingRight: depth * 20 }}
        >
          <div className="category-row__label">
            {node.visibilityMaterialId != null && (
              <span className={`badge badge--${node.materialColorId != null ? 'info' : 'success'}`}>
                {node.materialColorId != null ? 'مادة ملونة' : 'مادة خام'}
              </span>
            )}
            {node.nodeKind === 'legacy_ambiguous' && (
              <span className="badge badge--neutral">قديم — يحتاج مراجعة</span>
            )}
            {hasChildren ? (
              <button
                type="button"
                className="category-row__toggle"
                onClick={() => toggle(node.id)}
                aria-label={isExpanded ? `إخفاء فروع ${node.name}` : `إظهار فروع ${node.name}`}
                title={isExpanded ? 'إخفاء الفروع' : 'إظهار الفروع'}
                aria-expanded={isExpanded}
              >
                {isExpanded ? (
                  <ChevronDown size={15} strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  <ChevronLeft size={15} strokeWidth={2.5} aria-hidden="true" />
                )}
              </button>
            ) : (
              <span
                className="category-row__toggle category-row__toggle--leaf"
                aria-hidden="true"
              />
            )}
            <span className="category-row__name">{node.name}</span>
            {isTopLevel && (
              <span className="category-row__count">{childCountLabel(node.children.length)}</span>
            )}
          </div>
          {can(P.materials.manage) && (
            <div className="row-actions">
              {addLabel && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (node.nodeKind === 'material_type') {
                      setMaterialRequest({
                        parentNodeId: node.id,
                        parentNodePath: categoryPath(tree.data ?? [], node.id),
                        clientRequestId: crypto.randomUUID()
                      })
                    } else {
                      setEditing({
                        name: '',
                        showInRawMaterials: false,
                        parentId: node.id,
                        levelLabel: addLabel
                      })
                      setError(undefined)
                    }
                  }}
                >
                  + إضافة {addLabel}
                </Button>
              )}
              {node.nodeKind === 'material_type' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing({
                      name: '',
                      showInRawMaterials: false,
                      parentId: node.id,
                      levelLabel: 'تصنيف فرعي'
                    })
                    setError(undefined)
                  }}
                >
                  + تصنيف فرعي
                </Button>
              )}
              <button
                type="button"
                className="icon-btn"
                title="تعديل"
                aria-label="تعديل"
                onClick={() => void editNode(node)}
              >
                <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
              </button>
              {node.rawMaterialId && (
                <button
                  type="button"
                  className="icon-btn"
                  title="إعدادات التصنيف"
                  aria-label={`إعدادات تصنيف ${node.name}`}
                  onClick={() => editCategory(node)}
                >
                  <Settings2 size={15} strokeWidth={2.25} aria-hidden="true" />
                </button>
              )}
              {node.rawMaterialId ? (
                can(P.materials.fullDelete) && (
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    title="حذف"
                    aria-label="حذف"
                    onClick={() => void openMaterialDelete(node.rawMaterialId!)}
                  >
                    <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="icon-btn icon-btn--danger"
                  title="حذف"
                  aria-label="حذف"
                  onClick={() => void remove(node.id)}
                >
                  <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </div>
        {hasChildren && isExpanded && (
          <div className="category-branch__children">
            {children}
            {directItems.map((item) => (
              <div key={`material-${item.id}`} className="category-row category-row--child" style={{ paddingRight: (depth + 1) * 20 }}>
                <div className="category-row__label"><span className="category-row__name">{item.name} — {item.sku}</span></div>
                <div className="row-actions">
                  {can(P.materials.manage) && <button type="button" className="icon-btn" title="تعديل المادة" aria-label={`تعديل المادة ${item.sku}`} onClick={() => setMaterialRequest({ material: item })}><Pencil size={15} strokeWidth={2.25} aria-hidden="true" /></button>}
                  {can(P.materials.fullDelete) && <button type="button" className="icon-btn icon-btn--danger" title="حذف المادة" aria-label={`حذف المادة ${item.sku}`} onClick={() => void openMaterialDelete(item.id)}><Trash2 size={15} strokeWidth={2.25} aria-hidden="true" /></button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  const roots = tree.data ?? []
  const visibleRoots = roots
    .map((node) => renderNode(node, 0, false))
    .filter((el): el is ReactElement => el !== null)

  return (
    <>
      <PageHeader
        title="تصنيفات المواد"
        subtitle="يمكن إظهار أي تصنيف في مواد الخام، حتى لو كان له تصنيفات فرعية"
        actions={
          can(P.materials.manage) && (
            <Button
              onClick={() => {
                setEditing({ name: '', showInRawMaterials: false, levelLabel: 'تصنيف رئيسي' })
                setError(undefined)
              }}
            >
              + تصنيف رئيسي
            </Button>
          )
        }
      />
      <Card>
        <Toolbar>
          <Field label="بحث">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث عن تصنيف"
            />
          </Field>
        </Toolbar>
        {roots.length === 0 && <div className="state">لا توجد تصنيفات بعد</div>}
        {roots.length > 0 && visibleRoots.length === 0 && (
          <div className="state">لا توجد نتائج مطابقة</div>
        )}
        <div className="category-tree">{visibleRoots}</div>
      </Card>

      <Modal
        open={Boolean(editing) && !materialRequest}
        title={editing?.id ? `تعديل ${editing.levelLabel}` : `${editing?.levelLabel ?? ''} جديد`}
        onClose={() => setEditing(undefined)}
        footer={
          <>
            <Button onClick={() => void save()}>حفظ</Button>
            <Button variant="secondary" onClick={() => setEditing(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <Field label={`اسم ${editing?.levelLabel ?? 'التصنيف'}`} required>
          <Input
            value={editing?.name ?? ''}
            disabled={Boolean(editing?.linkedMaterialId)}
            onChange={(e) => setEditing({ ...editing!, name: e.target.value })}
          />
        </Field>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={editing?.showInRawMaterials ?? false}
            onChange={(e) => {
              if (e.target.checked && !editing?.visibilityMaterialId) {
                openVisibilityMaterialForm(editing!)
              } else {
                setEditing({ ...editing!, showInRawMaterials: e.target.checked })
              }
            }}
          />
          <span>يظهر في مواد الخام</span>
        </label>
        {editing?.visibilityMaterialId && (
          <Button variant="secondary" onClick={() => {
            void call<Material>('materials', 'get', { id: editing.visibilityMaterialId })
              .then((material) => setMaterialRequest({ material }))
              .catch((err) => setError(err instanceof ApiError ? err.message : 'تعذر تحميل المادة'))
          }}>
            تعديل المادة
          </Button>
        )}
      </Modal>

      <MaterialFormModal
        request={materialRequest}
        categoryOptions={categoryOptions}
        onClose={() => setMaterialRequest(undefined)}
        onSaved={() => {
          if (materialRequest?.categoryToEnable) setEditing(undefined)
          setMaterialRequest(undefined)
          void Promise.all([tree.reload(), materials.reload()])
          window.dispatchEvent(new Event('catalog-category-changed'))
        }}
      />

      <Modal
        open={Boolean(categoryDeleteDialog)}
        title="حذف التصنيف نهائيًا"
        onClose={() => setCategoryDeleteDialog(undefined)}
        footer={<>
          <Button variant="destructive" onClick={() => void confirmCategoryDelete()}>حذف نهائي</Button>
          <Button variant="secondary" onClick={() => setCategoryDeleteDialog(undefined)}>إلغاء</Button>
        </>}
      >
        <p>{categoryDeleteDialog?.ownedMaterialId != null
          ? 'سيتم حذف هذا التصنيف والمادة المرتبطة به نهائيًا. هل تريد المتابعة؟'
          : 'سيتم حذف هذا التصنيف نهائيًا. هل تريد المتابعة؟'}</p>
        <p>{categoryDeleteDialog?.name}</p>
      </Modal>

      <Modal
        open={Boolean(deleteDialog)}
        title="حذف المادة نهائيًا"
        onClose={() => setDeleteDialog(undefined)}
        footer={
          <>
            <Button
              variant="destructive"
              disabled={deleteDialog?.confirmation.trim() !== deleteDialog?.name.trim()}
              onClick={() => void confirmMaterialDelete()}
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
        <p className="muted">سيتم حذف المادة غير المستخدمة نهائيًا بعد إعادة فحص الرصيد والمراجع.</p>
        <Field label={`للتأكيد، اكتب اسم المادة "${deleteDialog?.name ?? ''}"`} required>
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
