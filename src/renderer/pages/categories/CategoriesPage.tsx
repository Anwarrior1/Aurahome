import { useState, type ReactElement } from 'react'
import { ChevronDown, ChevronLeft, Pencil, Trash2 } from 'lucide-react'
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
  nodeKind:
    'main_category' | 'material_family' | 'material_type' | 'inventory_leaf' | 'legacy_ambiguous'
  depth: number
  rawMaterialId: number | null
  materialCount: number
  children: Node[]
}
interface FullDeletePreview {
  materialId: number
  name: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
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

/**
 * A real expand/collapse tree (item 2/10): collapse state is per-category,
 * lives only in this component, and starts EMPTY on every fresh visit to
 * the page — so every parent begins collapsed (item 1) and any number of
 * them can be opened independently, with no forced accordion.
 *
 * Roots are visually stronger; explicit inventory leaves receive a subtle
 * badge, while organizational levels remain ordinary tree branches.
 */
export function CategoriesPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [editing, setEditing] = useState<
    | {
        id?: number
        name: string
        parentId?: number
        levelLabel: string
      }
    | undefined
  >()
  const [error, setError] = useState<string>()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [search, setSearch] = useState('')
  // One shared material form creates only the final inventory leaf.
  const [materialRequest, setMaterialRequest] = useState<MaterialFormRequest | undefined>()
  const [deleteDialog, setDeleteDialog] = useState<{
    materialId: number
    name: string
    preview: FullDeletePreview
    confirmation: string
    error?: string
  }>()

  const tree = useQuery<Node[]>('categories', 'tree')
  const categoryOptions = flattenCategoryOptions(tree.data ?? [])

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
    try {
      const payload = {
        name: editing.name,
        ...(!editing.id && editing.parentId ? { parentId: editing.parentId } : {})
      }
      if (editing.id) await call('categories', 'update', { id: editing.id, ...payload })
      else await call('categories', 'create', payload)
      toast.show('تم حفظ التصنيف', 'success')
      setEditing(undefined)
      setError(undefined)
      await tree.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  async function remove(id: number): Promise<void> {
    try {
      await call('categories', 'remove', { id })
      toast.show('تم حذف التصنيف', 'success')
      await tree.reload()
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error')
    }
  }

  async function editNode(node: Node): Promise<void> {
    if (!node.rawMaterialId) {
      setEditing({
        id: node.id,
        name: node.name,
        levelLabel:
          node.nodeKind === 'main_category'
            ? 'تصنيف رئيسي'
            : node.nodeKind === 'material_family'
              ? 'فئة مادة'
              : node.nodeKind === 'material_type'
                ? 'نوع مادة'
                : 'عنصر تصنيف قديم'
      })
      setError(undefined)
      return
    }
    try {
      const material = await call<Material>('materials', 'get', { id: node.rawMaterialId })
      setMaterialRequest({ material })
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر تحميل المادة', 'error')
    }
  }

  async function openMaterialDelete(node: Node): Promise<void> {
    if (!node.rawMaterialId) return
    try {
      const preview = await call<FullDeletePreview>('materials', 'fullDeletePreview', {
        id: node.rawMaterialId
      })
      setDeleteDialog({
        materialId: node.rawMaterialId,
        name: node.name,
        preview,
        confirmation: ''
      })
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر فحص المادة', 'error')
    }
  }

  async function confirmMaterialDelete(): Promise<void> {
    if (!deleteDialog) return
    try {
      await call('materials', 'fullDelete', {
        id: deleteDialog.materialId,
        confirmation: deleteDialog.confirmation
      })
      toast.show('تم حذف المادة', 'success')
      setDeleteDialog(undefined)
      await tree.reload()
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
    const hasChildren = node.children.length > 0
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
    const children = hasChildren
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
            {node.nodeKind === 'inventory_leaf' && (
              <span className="badge badge--success">مادة خام</span>
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
                        clientRequestId: crypto.randomUUID()
                      })
                    } else {
                      setEditing({
                        name: '',
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
              <button
                type="button"
                className="icon-btn"
                title="تعديل"
                aria-label="تعديل"
                onClick={() => void editNode(node)}
              >
                <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
              </button>
              {node.rawMaterialId ? (
                can(P.materials.fullDelete) && (
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    title="حذف"
                    aria-label="حذف"
                    onClick={() => void openMaterialDelete(node)}
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
        {hasChildren && isExpanded && children.length > 0 && (
          <div className="category-branch__children">{children}</div>
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
        subtitle="التصنيف الرئيسي وفئة المادة ونوع المادة للتنظيم؛ صنف المادة النهائي فقط يصبح مادة مخزونية"
        actions={
          can(P.materials.manage) && (
            <Button
              onClick={() => {
                setEditing({ name: '', levelLabel: 'تصنيف رئيسي' })
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
        open={Boolean(editing)}
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
            onChange={(e) => setEditing({ ...editing!, name: e.target.value })}
          />
        </Field>
      </Modal>

      <MaterialFormModal
        request={materialRequest}
        categoryOptions={categoryOptions}
        onClose={() => setMaterialRequest(undefined)}
        onSaved={() => {
          setMaterialRequest(undefined)
          void tree.reload()
        }}
      />

      <Modal
        open={Boolean(deleteDialog)}
        title="حذف المادة نهائيًا"
        onClose={() => setDeleteDialog(undefined)}
        footer={
          <>
            <Button
              variant="destructive"
              disabled={
                Boolean(deleteDialog?.preview.blockers.length) ||
                deleteDialog?.confirmation.trim() !== deleteDialog?.name.trim()
              }
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
        {(deleteDialog?.preview.blockers.length ?? 0) > 0 && (
          <div className="error-note">
            لا يمكن الحذف: {deleteDialog!.preview.blockers.join('، ')}
          </div>
        )}
        <p className="muted">
          يستخدم هذا الإجراء فحص تبعيات المادة نفسه المستخدم في صفحة المواد الخام، ولا يحذف أي فرع
          بصمت.
        </p>
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
