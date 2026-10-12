import { requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import {
  catalogRepository,
  categoryIdsMatchingPath
} from '../../repositories/catalog/catalog.repository'
import { AppError, notFound } from '../../utils/errors'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, type ServiceContext } from '../base/service.types'
import { getDatabase, getRawConnection } from '../../db/connection'
import { sql } from 'drizzle-orm'
import { withTransaction } from '../../db/transactions'
import {
  purchaseFullDeletePreview,
  performFullDeletePurchase
} from '../purchasing/purchasing.service'
import { clearLowStockStateIfResolved } from '../notifications/notification-state.service'
import { requireSafeInteger, requireSafeNonNegativeInteger, requireSafePositiveInteger } from '../../utils/numeric'

export type CategoryNodeKind =
  'main_category' | 'material_family' | 'material_type' | 'inventory_leaf' | 'legacy_ambiguous'

export interface CategoryNode {
  id: number
  name: string
  parentId: number | null
  active: boolean
  sortOrder: number
  nodeKind: CategoryNodeKind
  depth: number
  /** Null only for organizational roots and untouched legacy category rows. */
  rawMaterialId: number | null
  children: CategoryNode[]
  materialCount: number
}

/**
 * The category tree stays recursive and name-agnostic. New writes use the
 * four explicit business levels; legacy deeper rows remain visible.
 */
export function categoryTree(): CategoryNode[] {
  const rows = catalogRepository.listCategories()
  const materialRows = catalogRepository.listMaterials({})
  const materialByNode = new Map(
    materialRows
      .filter((material) => material.hierarchyNodeId !== null)
      .map((material) => [material.hierarchyNodeId!, material])
  )
  const materialCountByCategory = new Map<number, number>()
  for (const material of materialRows) {
    materialCountByCategory.set(
      material.categoryId,
      (materialCountByCategory.get(material.categoryId) ?? 0) + 1
    )
  }
  const byId = new Map<number, CategoryNode>()
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      active: row.active,
      sortOrder: row.sortOrder,
      nodeKind: row.nodeKind,
      depth: 0,
      rawMaterialId: materialByNode.get(row.id)?.id ?? null,
      children: [],
      materialCount: materialCountByCategory.get(row.id) ?? 0
    })
  }
  const roots: CategoryNode[] = []
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId)!.children.push(node)
    else roots.push(node)
  }
  const setDepth = (nodes: CategoryNode[], depth: number): void => {
    for (const node of nodes) {
      node.depth = depth
      setDepth(node.children, depth + 1)
    }
  }
  setDepth(roots, 0)
  return roots
}

export function listCategories() {
  return catalogRepository.listCategories()
}

function assertNoCycle(categoryId: number, parentId: number | null | undefined): void {
  let cursor = parentId ?? null
  const seen = new Set<number>([categoryId])
  while (cursor) {
    if (seen.has(cursor)) {
      throw new AppError('VALIDATION_ERROR', 'لا يمكن جعل التصنيف تابعاً لنفسه')
    }
    seen.add(cursor)
    cursor = catalogRepository.getCategory(cursor)?.parentId ?? null
  }
}

export function createCategory(
  input: { name: string; parentId?: number | null; sortOrder?: number; isAccessory?: boolean },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.materials.manage)
  if (input.sortOrder !== undefined) requireSafeInteger(input.sortOrder, 'ترتيب التصنيف')
  if (input.parentId != null) requireSafePositiveInteger(input.parentId, 'التصنيف الأب')
  const name = input.name.trim()
  if (!name) throw new AppError('VALIDATION_ERROR', 'اسم التصنيف مطلوب')
  const parent = input.parentId ? catalogRepository.getCategory(input.parentId) : undefined
  if (input.parentId && !parent) throw notFound('التصنيف الأب غير موجود')
  const nodeKind: CategoryNodeKind = !parent
    ? 'main_category'
    : parent.nodeKind === 'main_category'
      ? 'material_family'
      : parent.nodeKind === 'material_family'
        ? 'material_type'
        : (() => {
            throw new AppError(
              'VALIDATION_ERROR',
              'هذا المستوى يقبل صنف مادة مخزونياً فقط، وليس مستوىً تنظيمياً إضافياً'
            )
          })()
  if (catalogRepository.findSiblingCategory(input.name, input.parentId ?? null)) {
    throw new AppError('CONFLICT', 'يوجد عنصر بالاسم نفسه تحت هذا المستوى')
  }
  return withTransaction(() => {
    const id = catalogRepository.insertCategory({
      name,
      nodeKind,
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 0,
      isAccessory: input.isAccessory ?? false,
      createdAt: nowIso()
    })
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.category.create',
      entity: 'material_categories',
      entityId: String(id),
      details: { ...input, name, nodeKind }
    })
    return id
  })
}

function assertValidParentForKind(kind: CategoryNodeKind, parentId: number | null): void {
  if (kind === 'legacy_ambiguous') {
    throw new AppError(
      'VALIDATION_ERROR',
      'لا يمكن نقل هذا السجل القديم الغامض قبل مراجعته وتصنيفه يدوياً'
    )
  }
  const requiredParentKind: Partial<Record<CategoryNodeKind, CategoryNodeKind>> = {
    material_family: 'main_category',
    material_type: 'material_family',
    inventory_leaf: 'material_type'
  }
  if (kind === 'main_category') {
    if (parentId !== null) throw new AppError('VALIDATION_ERROR', 'التصنيف الرئيسي لا يقبل أباً')
    return
  }
  const parent = parentId === null ? undefined : catalogRepository.getCategory(parentId)
  if (!parent) throw notFound('التصنيف الأب غير موجود')
  if (parent.nodeKind !== requiredParentKind[kind]) {
    throw new AppError('VALIDATION_ERROR', 'المستوى الجديد لا يطابق تسلسل تصنيفات المواد')
  }
}

export function updateCategory(
  id: number,
  input: {
    name?: string
    parentId?: number | null
    sortOrder?: number
    active?: boolean
    isAccessory?: boolean
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.materials.manage)
  if (input.sortOrder !== undefined) requireSafeInteger(input.sortOrder, 'ترتيب التصنيف')
  if (input.parentId != null) requireSafePositiveInteger(input.parentId, 'التصنيف الأب')
  const existing = catalogRepository.getCategory(id)
  if (!existing) throw notFound('التصنيف غير موجود')
  const linkedMaterial = catalogRepository.getMaterialByHierarchyNode(id)
  if (linkedMaterial?.colorId && input.name !== undefined) {
    const color = catalogRepository.getColor(linkedMaterial.colorId)
    const authoritativeName = color ? colorDisplayName(color) : linkedMaterial.name
    if (input.name.trim() !== authoritativeName) {
      throw new AppError(
        'VALIDATION_ERROR',
        'اسم الصنف الملوّن مشتق من كتالوج الألوان ويُعدّل من هناك'
      )
    }
  }
  if (input.parentId !== undefined) {
    assertValidParentForKind(existing.nodeKind, input.parentId)
  }
  if (input.parentId !== undefined) assertNoCycle(id, input.parentId)
  const targetParentId = input.parentId === undefined ? existing.parentId : input.parentId
  if (input.name && input.name.trim() !== existing.name.trim()) {
    const duplicate = catalogRepository.findSiblingCategory(input.name, targetParentId)
    if (duplicate && duplicate.id !== id) {
      throw new AppError('CONFLICT', 'يوجد عنصر بالاسم نفسه تحت هذا المستوى')
    }
  }
  withTransaction(() => {
    catalogRepository.updateCategory(id, { ...input })
    if (linkedMaterial) {
      catalogRepository.updateMaterial(linkedMaterial.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.active !== undefined ? { active: input.active } : {})
      })
    }
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: linkedMaterial ? 'catalog.material.update' : 'catalog.category.update',
      entity: linkedMaterial ? 'materials' : 'material_categories',
      entityId: String(linkedMaterial?.id ?? id),
      details: linkedMaterial ? { ...input, hierarchyNodeId: id } : input
    })
  })
}

export function deleteCategory(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.materials.manage)
  if (catalogRepository.getMaterialByHierarchyNode(id)) {
    throw new AppError('CONFLICT', 'هذا العنصر مادة خام؛ استخدم مسار حذف المادة الآمن')
  }
  if (catalogRepository.countChildren(id) > 0) {
    throw new AppError('CONFLICT', 'لا يمكن حذف تصنيف يحتوي على تصنيفات فرعية')
  }
  if (catalogRepository.countMaterialsInCategory(id) > 0) {
    throw new AppError('CONFLICT', 'لا يمكن حذف تصنيف يحتوي على مواد')
  }
  withTransaction(() => {
    catalogRepository.deleteCategory(id)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.category.delete',
      entity: 'material_categories',
      entityId: String(id)
    })
  })
}

/** BR-69: user-maintained Color / Finish Catalog. */
export function listColors(activeOnly = false) {
  return catalogRepository.listColors(activeOnly)
}

function colorDisplayName(color: { code: string; name: string }): string {
  return `${color.code.trim()} — ${color.name.trim()}`
}

interface ColorMaterialInput {
  relatedMaterialId?: number | null
  /** Compatibility only: no new arbitrary material labels are accepted. */
  relatedMaterialType?: string | null
}

function colorMaterialReference(
  input: ColorMaterialInput,
  existing?: { relatedMaterialId: number | null; relatedMaterialType: string | null }
) {
  if (input.relatedMaterialId === undefined) {
    if (
      input.relatedMaterialType !== undefined &&
      input.relatedMaterialType !== existing?.relatedMaterialType
    ) {
      if (input.relatedMaterialType?.trim())
        throw new AppError('VALIDATION_ERROR', 'اختر مادة موجودة من القائمة')
      return { relatedMaterialId: null, relatedMaterialType: null }
    }
    return existing ? {} : { relatedMaterialId: null, relatedMaterialType: null }
  }
  if (input.relatedMaterialId === null)
    return { relatedMaterialId: null, relatedMaterialType: null }
  if (!Number.isSafeInteger(input.relatedMaterialId) || input.relatedMaterialId <= 0) {
    throw new AppError('VALIDATION_ERROR', 'معرّف المادة غير صحيح')
  }
  const material = catalogRepository.getMaterial(input.relatedMaterialId)
  if (!material) throw notFound('المادة المحددة غير موجودة')
  // An archived material can remain linked to its existing color, but
  // cannot be chosen as a new link, matching the active selector catalog.
  if (!material.active && material.id !== existing?.relatedMaterialId) {
    throw new AppError('VALIDATION_ERROR', 'المادة المحددة غير مفعّلة')
  }
  return { relatedMaterialId: material.id, relatedMaterialType: material.name }
}

/** The same lightweight Raw Materials options used by the invoice picker,
 *  plus this color's existing archived link so it remains visible in edit. */
export function colorMaterialOptions(colorId?: number) {
  const options = listMaterialTypeOptions()
  if (colorId !== undefined) {
    const color = catalogRepository.getColor(colorId)
    if (!color) throw notFound('اللون أو التشطيب غير موجود')
    if (
      color.relatedMaterialId !== null &&
      !options.some((option) => option.id === color.relatedMaterialId)
    ) {
      const selected = getMaterial(color.relatedMaterialId)
      if (selected) {
        options.push({
          id: selected.id,
          sku: selected.sku,
          name: selected.name,
          hierarchyPath: selected.hierarchyPath
        })
      }
    }
  }
  return options
}

export function createColor(
  input: { code: string; name: string; notes?: string } & ColorMaterialInput,
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.colors.manage)
  if (catalogRepository.getColorByCode(input.code)) {
    throw new AppError('CONFLICT', 'كود اللون مستخدم بالفعل')
  }
  const fields = { code: input.code, name: input.name, notes: input.notes }
  const material = colorMaterialReference(input)
  return withTransaction(() => {
    const id = catalogRepository.insertColor({ ...fields, ...material, createdAt: nowIso() })
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.color.create',
      entity: 'color_finish_catalog',
      entityId: String(id),
      details: { ...fields, ...material }
    })
    return id
  })
}

export function updateColor(
  id: number,
  input: { code?: string; name?: string; notes?: string; active?: boolean } & ColorMaterialInput,
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.colors.manage)
  const existing = catalogRepository.getColor(id)
  if (!existing) throw notFound('اللون أو التشطيب غير موجود')
  if (input.code && input.code !== existing.code && catalogRepository.getColorByCode(input.code)) {
    throw new AppError('CONFLICT', 'كود اللون مستخدم بالفعل')
  }
  const fields = { code: input.code, name: input.name, notes: input.notes, active: input.active }
  const material = colorMaterialReference(input, existing)
  withTransaction(() => {
    catalogRepository.updateColor(id, { ...fields, ...material })
    if (input.code !== undefined || input.name !== undefined) {
      const displayName = colorDisplayName({
        code: input.code ?? existing.code,
        name: input.name ?? existing.name
      })
      for (const linked of catalogRepository.listMaterialsByColor(id)) {
        catalogRepository.updateMaterial(linked.id, { name: displayName })
        if (linked.hierarchyNodeId) {
          catalogRepository.updateCategory(linked.hierarchyNodeId, { name: displayName })
        }
      }
    }
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.color.update',
      entity: 'color_finish_catalog',
      entityId: String(id),
      details: { ...fields, ...material }
    })
  })
}

/**
 * Historical documents keep immutable text snapshots. Inventory variants now
 * also hold a stable color id, so a catalog row linked to any material is
 * archived rather than physically removed.
 */
export function deleteColor(
  id: number,
  ctx: ServiceContext
): { deleted: boolean; archived: boolean } {
  requirePermission(ctx.session, P.colors.manage)
  const color = catalogRepository.getColor(id)
  if (!color) throw notFound('اللون أو التشطيب غير موجود')
  const code = color.code
  const scalar = (query: ReturnType<typeof sql>): number =>
    getDatabase().get<{ c: number }>(query)?.c ?? 0
  const references =
    scalar(sql`SELECT COUNT(*) AS c FROM quotation_lines WHERE color_code = ${code}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM order_lines WHERE color_code = ${code}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM planned_materials WHERE color_code = ${code}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM order_material_lines WHERE color_code = ${code}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM final_invoices WHERE snapshot LIKE ${'%' + code + '%'}`) +
    catalogRepository.listMaterialsByColor(id).length

  if (references > 0) {
    return withTransaction(() => {
      catalogRepository.updateColor(id, { active: false })
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'catalog.color.archive',
        entity: 'color_finish_catalog',
        entityId: String(id),
        details: { code, references }
      })
      return { deleted: false, archived: true }
    })
  }

  return withTransaction(() => {
    catalogRepository.deleteColor(id)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.color.delete',
      entity: 'color_finish_catalog',
      entityId: String(id),
      details: { code, name: color.name }
    })
    return { deleted: true, archived: false }
  })
}

/**
 * The generic material master (items 4/5/6/7/8). Every field beyond the
 * core five is an OPTIONAL, EXPLICIT capability the user turns on for
 * this specific material — never inferred from its name or category.
 * A hinge, a litre of glue and a board of MDF are all valid rows with
 * none, some, or all of these switched on.
 */
export interface MaterialInput {
  // ---- Core (item 5) ----
  sku: string
  name: string
  categoryId: number
  /** Base stock unit — item 6. What inventory is actually tracked in. */
  unit: string
  reorderLevelMicro?: number
  notes?: string | null
  active?: boolean
  /** Stable catalog identity for a coloured inventory leaf. Legacy and
   * uncoloured materials keep this null. */
  colorId?: number | null

  // ---- Purchase-unit conversion (item 7), optional ----
  /** Null/omitted = purchased in the same unit it is stocked in. */
  purchaseUnit?: string | null
  /** How many base stock units one purchase unit contains (×10^6). */
  purchaseUnitFactorMicro?: number | null

  // ---- Dimensions (item 9), gated by its own explicit toggle ----
  tracksDimensions?: boolean
  dimensions?: string | null
  thickness?: string | null

  // ---- Pricing (item 13) — customer-facing reference, never FIFO ----
  currentMarketPriceMicro: number
  pricingRule: 'exact' | 'full_unit' | 'round_up' | 'manual'
  commercialUnitSizeMicro?: number | null

}

export interface ChildMaterialInput extends Omit<MaterialInput, 'categoryId'> {
  parentId: number
  leafType?: 'raw' | 'colored'
  /** Stable key generated once when the dialog opens and reused by retries. */
  clientRequestId: string
}

function validateMaterial(input: Partial<MaterialInput>): void {
  if (input.currentMarketPriceMicro !== undefined)
    requireSafeNonNegativeInteger(input.currentMarketPriceMicro, 'سعر السوق')
  if (input.reorderLevelMicro !== undefined)
    requireSafeNonNegativeInteger(input.reorderLevelMicro, 'حد إعادة الطلب')
  if (input.purchaseUnitFactorMicro != null)
    requireSafePositiveInteger(input.purchaseUnitFactorMicro, 'معامل وحدة الشراء')
  if (input.commercialUnitSizeMicro != null)
    requireSafePositiveInteger(input.commercialUnitSizeMicro, 'حجم الوحدة التجارية')
  if (input.pricingRule === 'full_unit' && !input.commercialUnitSizeMicro) {
    throw new AppError(
      'VALIDATION_ERROR',
      'التسعير بالوحدة الكاملة يتطلب تحديد حجم الوحدة التجارية'
    )
  }
  // Item 7: the two purchase-conversion fields are one concept — either
  // both are set (a real conversion) or neither is (no conversion).
  if (input.purchaseUnit && !input.purchaseUnitFactorMicro) {
    throw new AppError(
      'VALIDATION_ERROR',
      'عند تحديد وحدة شراء مختلفة يجب إدخال عدد وحدات المخزون التي تحتوي عليها'
    )
  }
  if (input.purchaseUnitFactorMicro && input.purchaseUnitFactorMicro <= 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'عدد وحدات المخزون في وحدة الشراء يجب أن يكون أكبر من صفر'
    )
  }
  // Item 21: dimensions are required only when the material explicitly
  // opts into tracking them — never a blanket requirement.
  if (input.tracksDimensions && !input.dimensions?.trim()) {
    throw new AppError('VALIDATION_ERROR', 'هذه المادة تتطلب تحديد الأبعاد')
  }
}

function buildHierarchyPaths(
  categories: ReturnType<typeof catalogRepository.listCategories>
): Map<number, string> {
  const byId = new Map(categories.map((category) => [category.id, category]))
  const paths = new Map<number, string>()
  const pathFor = (categoryId: number, visiting = new Set<number>()): string => {
    const cached = paths.get(categoryId)
    if (cached !== undefined) return cached
    const names: string[] = []
    let cursor = byId.get(categoryId)
    while (cursor && !visiting.has(cursor.id)) {
      visiting.add(cursor.id)
      names.push(cursor.name)
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
    }
    const path = names.reverse().join(' ← ')
    paths.set(categoryId, path)
    return path
  }
  for (const category of categories) pathFor(category.id)
  return paths
}

function materialPath(
  material: { name: string; categoryId: number; hierarchyNodeId: number | null },
  paths: Map<number, string>
): string {
  const categoryPath = paths.get(material.categoryId) ?? ''
  if (material.hierarchyNodeId === material.categoryId) return categoryPath
  return [categoryPath, material.name].filter(Boolean).join(' ← ')
}

export function listMaterials(filter: {
  search?: string
  categoryId?: number
  activeOnly?: boolean
}) {
  const categories = catalogRepository.listCategories()
  const paths = buildHierarchyPaths(categories)
  const pathMatches = filter.search?.trim() ? categoryIdsMatchingPath(filter.search) : []
  return catalogRepository.listMaterials(filter, pathMatches).map((material) => ({
    ...material,
    hierarchyPath: materialPath(material, paths)
  }))
}

export function getMaterial(id: number) {
  const material = catalogRepository.getMaterial(id)
  if (!material) throw notFound('المادة غير موجودة')
  const paths = buildHierarchyPaths(catalogRepository.listCategories())
  return { ...material, hierarchyPath: materialPath(material, paths) }
}

export function createMaterial(input: MaterialInput, ctx: ServiceContext): number {
  requirePermission(ctx.session, P.materials.manage)
  return withTransaction(() => {
    validateMaterial(input)
    if (input.colorId != null) {
      throw new AppError(
        'VALIDATION_ERROR',
        'يُربط لون المخزون عند إنشاء صنف مادة نهائي من شجرة التصنيفات'
      )
    }
    // A material may reference any category in the hierarchy — root or a
    // subcategory at any depth (BR-66: an arbitrary user-built tree) — as
    // long as the category itself actually exists. The root-only rule
    // this used to enforce is gone; only real-category validation stays.
    if (!catalogRepository.getCategory(input.categoryId)) throw notFound('التصنيف غير موجود')
    if (catalogRepository.getMaterialBySku(input.sku)) {
      throw new AppError('CONFLICT', 'كود المادة مستخدم بالفعل')
    }
    const id = catalogRepository.insertMaterial({
      ...input,
      createdAt: nowIso()
    })
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.material.create',
      entity: 'materials',
      entityId: String(id),
      details: { sku: input.sku, name: input.name }
    })
    return id
  })
}

/**
 * Creates one logical level-four inventory leaf: its hierarchy position
 * and authoritative Raw Material row. Both inserts and the single audit
 * event share one SQLite transaction, while `clientRequestId` makes a
 * renderer retry return the first result instead of duplicating it.
 */
export function createChildMaterial(
  input: ChildMaterialInput,
  ctx: ServiceContext
): { categoryId: number; materialId: number } {
  requirePermission(ctx.session, P.materials.manage)
  const leafType = input.leafType ?? 'raw'
  if (leafType !== 'raw' && leafType !== 'colored') {
    throw new AppError('VALIDATION_ERROR', 'نوع صنف المادة غير صحيح')
  }
  const resolvedColor =
    leafType === 'colored'
      ? (() => {
          if (!input.colorId) throw new AppError('VALIDATION_ERROR', 'اختر لوناً من كتالوج الألوان')
          const color = catalogRepository.getColor(input.colorId)
          if (!color) throw notFound('اللون أو التشطيب غير موجود')
          if (!color.active) throw new AppError('VALIDATION_ERROR', 'اللون المحدد غير مفعّل')
          return color
        })()
      : undefined
  if (leafType === 'raw' && input.colorId != null) {
    throw new AppError('VALIDATION_ERROR', 'الصنف الخام لا يقبل مرجع لون')
  }
  const resolvedName = resolvedColor ? colorDisplayName(resolvedColor) : input.name.trim()
  if (!resolvedName) throw new AppError('VALIDATION_ERROR', 'اسم صنف المادة مطلوب')
  const retry = catalogRepository.getMaterialByCreationKey(input.clientRequestId)
  if (retry?.hierarchyNodeId) {
    const retryNode = catalogRepository.getCategory(retry.hierarchyNodeId)
    if (
      retry.sku !== input.sku ||
      retry.name !== resolvedName ||
      retry.colorId !== (resolvedColor?.id ?? null) ||
      retryNode?.parentId !== input.parentId
    ) {
      throw new AppError('CONFLICT', 'مفتاح طلب إنشاء المادة مستخدم لبيانات مختلفة')
    }
    return { categoryId: retry.hierarchyNodeId, materialId: retry.id }
  }
  const parent = catalogRepository.getCategory(input.parentId)
  if (!parent) throw notFound('العنصر الأب غير موجود')
  if (parent.nodeKind !== 'material_type') {
    throw new AppError('VALIDATION_ERROR', 'لا يُنشأ صنف المادة إلا تحت مستوى نوع المادة')
  }
  if (catalogRepository.findSiblingCategory(resolvedName, input.parentId)) {
    throw new AppError('CONFLICT', 'يوجد عنصر بالاسم نفسه تحت هذا المستوى')
  }
  validateMaterial({ ...input, categoryId: input.parentId })
  if (catalogRepository.getMaterialBySku(input.sku)) {
    throw new AppError('CONFLICT', 'كود المادة مستخدم بالفعل')
  }

  return withTransaction(() => {
    const existing = catalogRepository.getMaterialByCreationKey(input.clientRequestId)
    if (existing?.hierarchyNodeId) {
      const existingNode = catalogRepository.getCategory(existing.hierarchyNodeId)
      if (
        existing.sku !== input.sku ||
        existing.name !== resolvedName ||
        existing.colorId !== (resolvedColor?.id ?? null) ||
        existingNode?.parentId !== input.parentId
      ) {
        throw new AppError('CONFLICT', 'مفتاح طلب إنشاء المادة مستخدم لبيانات مختلفة')
      }
      return { categoryId: existing.hierarchyNodeId, materialId: existing.id }
    }
    const {
      parentId,
      clientRequestId,
      leafType: _leafType,
      colorId: _colorId,
      ...materialInput
    } = input
    void _leafType
    void _colorId
    const categoryId = catalogRepository.insertCategory({
      name: resolvedName,
      nodeKind: 'inventory_leaf',
      parentId,
      sortOrder: 0,
      active: materialInput.active ?? true,
      createdAt: nowIso()
    })
    const materialId = catalogRepository.insertMaterial({
      ...materialInput,
      name: resolvedName,
      colorId: resolvedColor?.id ?? null,
      categoryId,
      hierarchyNodeId: categoryId,
      creationKey: clientRequestId,
      createdAt: nowIso()
    })
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.material.create',
      entity: 'materials',
      entityId: String(materialId),
      details: {
        sku: materialInput.sku,
        name: resolvedName,
        leafType,
        colorId: resolvedColor?.id ?? null,
        hierarchyNodeId: categoryId,
        parentId
      }
    })
    return { categoryId, materialId }
  })
}

/**
 * BR-8: updating the current market price NEVER touches historical
 * purchase costs or FIFO layers — those live in fifo_layers and are
 * only ever written by a receipt.
 */
export function updateMaterial(
  id: number,
  input: Partial<MaterialInput>,
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.materials.manage)
  const existing = getMaterial(id)
  const hierarchyNode = existing.hierarchyNodeId
    ? catalogRepository.getCategory(existing.hierarchyNodeId)
    : undefined
  let normalizedInput = { ...input }
  if (input.colorId !== undefined && hierarchyNode?.nodeKind !== 'inventory_leaf') {
    throw new AppError(
      'VALIDATION_ERROR',
      'مرجع اللون المخزوني متاح فقط لصنف مادة نهائي مرتبط بالشجرة'
    )
  }
  const targetColorId =
    hierarchyNode?.nodeKind === 'inventory_leaf'
      ? input.colorId === undefined
        ? existing.colorId
        : input.colorId
      : null
  if (targetColorId !== null) {
    const color = catalogRepository.getColor(targetColorId)
    if (!color) throw notFound('اللون أو التشطيب غير موجود')
    if (!color.active && targetColorId !== existing.colorId) {
      throw new AppError('VALIDATION_ERROR', 'اللون المحدد غير مفعّل')
    }
    normalizedInput = { ...normalizedInput, colorId: targetColorId, name: colorDisplayName(color) }
  }
  validateMaterial({ ...existing, ...normalizedInput } as MaterialInput)
  if (normalizedInput.sku && normalizedInput.sku !== existing.sku) {
    const duplicate = catalogRepository.getMaterialBySku(normalizedInput.sku)
    if (duplicate && duplicate.id !== id) throw new AppError('CONFLICT', 'كود المادة مستخدم بالفعل')
  }
  if (
    existing.hierarchyNodeId &&
    normalizedInput.categoryId !== undefined &&
    normalizedInput.categoryId !== existing.hierarchyNodeId
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      'يُغيّر موقع المادة من شجرة تصنيفات المواد، وليس من نموذج المادة'
    )
  }
  if (
    existing.hierarchyNodeId &&
    normalizedInput.name &&
    normalizedInput.name.trim() !== existing.name.trim()
  ) {
    const node = catalogRepository.getCategory(existing.hierarchyNodeId)
    const duplicate = node
      ? catalogRepository.findSiblingCategory(normalizedInput.name, node.parentId)
      : undefined
    if (duplicate && duplicate.id !== existing.hierarchyNodeId) {
      throw new AppError('CONFLICT', 'يوجد عنصر بالاسم نفسه تحت هذا المستوى')
    }
  }
  if (
    normalizedInput.categoryId !== undefined &&
    normalizedInput.categoryId !== existing.categoryId
  ) {
    // Same rule as createMaterial: any existing category is a valid
    // target, root or child — moving a material between a parent and
    // one of its own subcategories (or the reverse) is a normal edit.
    if (!catalogRepository.getCategory(normalizedInput.categoryId)) {
      throw notFound('التصنيف غير موجود')
    }
  }
  withTransaction(() => {
    catalogRepository.updateMaterial(id, { ...normalizedInput })
    if (
      existing.hierarchyNodeId &&
      (normalizedInput.name !== undefined || normalizedInput.active !== undefined)
    ) {
      catalogRepository.updateCategory(existing.hierarchyNodeId, {
        ...(normalizedInput.name !== undefined ? { name: normalizedInput.name } : {}),
        ...(normalizedInput.active !== undefined ? { active: normalizedInput.active } : {})
      })
    }
    clearLowStockStateIfResolved(id)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.material.update',
      entity: 'materials',
      entityId: String(id),
      details: normalizedInput
    })
  })
}

export function deleteMaterial(
  id: number,
  ctx: ServiceContext
): { deleted: boolean; archived: boolean } {
  requirePermission(ctx.session, P.materials.manage)
  const material = getMaterial(id)
  if (material.hierarchyNodeId && catalogRepository.countChildren(material.hierarchyNodeId) > 0) {
    throw new AppError('CONFLICT', 'لا يمكن حذف مادة تحتوي على مواد فرعية')
  }
  const scalar = (query: ReturnType<typeof sql>): number =>
    getDatabase().get<{ c: number }>(query)?.c ?? 0
  const references =
    scalar(sql`SELECT COUNT(*) AS c FROM fifo_layers WHERE material_id = ${id}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM inventory_movements WHERE material_id = ${id}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM product_bom_lines WHERE material_id = ${id}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM quotation_lines WHERE material_id = ${id}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM order_lines WHERE material_id = ${id}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM planned_materials WHERE material_id = ${id}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM order_material_lines WHERE material_id = ${id}`) +
    // A material chosen as an ACCESSORY or as "نوع المادة" on a sales
    // document is history too: without these the delete would hit the
    // new foreign keys and fail with a raw SQLite error instead of
    // archiving, and a document could lose the link behind its frozen
    // snapshot.
    scalar(sql`SELECT COUNT(*) AS c FROM quotation_lines WHERE accessory_material_id = ${id}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM final_invoice_lines WHERE accessory_material_id = ${id}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM order_lines WHERE accessory_material_id = ${id}`) +
    scalar(sql`SELECT COUNT(*) AS c FROM quotation_lines WHERE material_type_material_id = ${id}`) +
    scalar(
      sql`SELECT COUNT(*) AS c FROM final_invoice_lines WHERE material_type_material_id = ${id}`
    ) +
    scalar(sql`SELECT COUNT(*) AS c FROM order_lines WHERE material_type_material_id = ${id}`)

  if (references > 0) {
    return withTransaction(() => {
      catalogRepository.updateMaterial(id, { active: false })
      if (material.hierarchyNodeId) {
        catalogRepository.updateCategory(material.hierarchyNodeId, { active: false })
      }
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'catalog.material.archive',
        entity: 'materials',
        entityId: String(id),
        details: { sku: material.sku, references }
      })
      return { deleted: false, archived: true }
    })
  }
  return withTransaction(() => {
    catalogRepository.deleteMaterial(id)
    if (material.hierarchyNodeId) catalogRepository.deleteCategory(material.hierarchyNodeId)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.material.delete',
      entity: 'materials',
      entityId: String(id),
      details: { sku: material.sku, name: material.name }
    })
    return { deleted: true, archived: false }
  })
}

export interface MaterialFullDeletePreview {
  materialId: number
  name: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}

function scalarCount(query: ReturnType<typeof sql>): number {
  return getDatabase().get<{ c: number }>(query)?.c ?? 0
}

/**
 * Whether ANY of this material's stock has ever actually left the
 * building — consumed, wasted, sold, or reversed. Real, historical
 * production activity always draws a FIFO layer down and posts
 * fifo_allocations against it (BR-6), so checking every layer this way
 * catches it regardless of which downstream table recorded the event.
 * Only fully-untouched (still-full) layers are safe to remove.
 */
function materialInventoryBlockers(materialId: number): string[] {
  const raw = getRawConnection()
  const layers = raw
    .prepare(
      'SELECT id, qty_received_micro AS received, qty_remaining_micro AS remaining FROM fifo_layers WHERE material_id = ?'
    )
    .all(materialId) as Array<{ id: number; received: number; remaining: number }>

  const blockers: string[] = []
  for (const layer of layers) {
    if (layer.remaining !== layer.received) {
      blockers.push(
        'تم استهلاك جزء من مخزون هذه المادة بالفعل — يجب الحفاظ على سجل الاستهلاك التاريخي'
      )
      break
    }
    const allocated = raw
      .prepare('SELECT COUNT(*) AS c FROM fifo_allocations WHERE layer_id = ?')
      .get(layer.id) as { c: number }
    if (allocated.c > 0) {
      blockers.push('توجد توزيعات تكلفة تاريخية مرتبطة بمخزون هذه المادة')
      break
    }
  }
  return blockers
}

/**
 * Discovers everything caused BY this material — its own stock,
 * purchase lines, product-BOM entries, and planning/document
 * references — without mutating anything. `order_material_lines` is a
 * real, historical production consumption record (materialId is
 * NOT NULL there, unlike the snapshot-style tables below) and always
 * blocks: undoing it would corrupt an unrelated order's actual cost.
 */
export function materialFullDeletePreview(id: number): MaterialFullDeletePreview {
  const material = getMaterial(id)
  const blockers: string[] = [...materialInventoryBlockers(id)]

  if (material.hierarchyNodeId) {
    if (catalogRepository.countChildren(material.hierarchyNodeId) > 0) {
      blockers.push('تحتوي هذه المادة على مواد فرعية — احذف أو انقل المواد الفرعية أولاً')
    }
    const attachedMaterials = catalogRepository.countMaterialsInCategory(material.hierarchyNodeId)
    if (attachedMaterials > 1) {
      blockers.push('توجد مواد قديمة أخرى مرتبطة بعقدة التصنيف هذه')
    }
  }

  const consumedCount = scalarCount(
    sql`SELECT COUNT(*) AS c FROM order_material_lines WHERE material_id = ${id}`
  )
  if (consumedCount > 0) {
    blockers.push(
      'توجد سجلات صرف فعلي لهذه المادة على أوامر تصنيع — لا يمكن حذفها نهائياً، يمكن تعطيلها بدلاً من ذلك'
    )
  }

  const counts = {
    inventoryMovements: scalarCount(
      sql`SELECT COUNT(*) AS c FROM inventory_movements WHERE material_id = ${id}`
    ),
    costLayers: scalarCount(sql`SELECT COUNT(*) AS c FROM fifo_layers WHERE material_id = ${id}`),
    remainders: scalarCount(
      sql`SELECT COUNT(*) AS c FROM material_remainders WHERE material_id = ${id}`
    ),
    purchaseLines: scalarCount(
      sql`SELECT COUNT(*) AS c FROM purchase_lines WHERE material_id = ${id}`
    ),
    productBom: scalarCount(
      sql`SELECT COUNT(*) AS c FROM product_bom_lines WHERE material_id = ${id}`
    ),
    plannedMaterials: scalarCount(
      sql`SELECT COUNT(*) AS c FROM planned_materials WHERE material_id = ${id}`
    ),
    quotationLines: scalarCount(
      sql`SELECT COUNT(*) AS c FROM quotation_lines WHERE material_id = ${id}`
    ),
    orderLines: scalarCount(sql`SELECT COUNT(*) AS c FROM order_lines WHERE material_id = ${id}`),
    finalInvoiceLines: scalarCount(
      sql`SELECT COUNT(*) AS c FROM final_invoice_lines WHERE material_id = ${id}`
    ),
    productionConsumption: consumedCount
  }
  const labels: Record<keyof typeof counts, string> = {
    inventoryMovements: 'حركات المخزون',
    costLayers: 'سجلات التكلفة (طبقات FIFO)',
    remainders: 'قصاصات متبقية',
    purchaseLines: 'سجلات الشراء التابعة',
    productBom: 'مكونات في قوائم منتجات',
    plannedMaterials: 'مراجع في خطط إنتاج',
    quotationLines: 'بنود فواتير مبدئية',
    orderLines: 'بنود طلبات عملاء',
    finalInvoiceLines: 'بنود فواتير معتمدة',
    productionConsumption: 'سجلات صرف فعلي على أوامر تصنيع'
  }
  const dependencies = (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((key) => counts[key] > 0)
    .map((key) => ({ key, label: labels[key], count: counts[key] }))

  if (
    counts.inventoryMovements > 0 ||
    counts.costLayers > 0 ||
    counts.remainders > 0 ||
    counts.purchaseLines > 0
  ) {
    blockers.push(
      'توجد للمادة حركات مخزون أو طبقات تكلفة أو بنود شراء مُرحّلة؛ عطّل المادة بدلاً من حذف تاريخها'
    )
  }

  return { materialId: id, name: material.name, dependencies, blockers: [...new Set(blockers)] }
}

/**
 * Permanent deletion is limited to a material with no posted inventory,
 * FIFO, remainder, or purchase-line history. Current BOM configuration may
 * be removed and snapshot-backed document references may be nulled; the
 * legacy purchase-rewrite branch is unreachable for production data.
 */
export function fullDeleteMaterial(
  input: { id: number; confirmation: string },
  ctx: ServiceContext
): { removed: true; summary: Record<string, number> } {
  requirePermission(ctx.session, P.materials.fullDelete)
  const material = getMaterial(input.id)
  if (input.confirmation.trim() !== material.name.trim()) {
    throw new AppError(
      'VALIDATION_ERROR',
      `اكتب اسم المادة "${material.name}" لتأكيد الحذف النهائي`
    )
  }
  const preview = materialFullDeletePreview(input.id)
  if (preview.blockers.length) {
    throw new AppError(
      'CONFLICT',
      `تعذر حذف المادة بالكامل لحماية السجل التاريخي: ${preview.blockers.join('، ')}`
    )
  }

  return withTransaction(() => {
    // Re-derived inside the open transaction rather than trusting the
    // preview above, matching every other full-delete in this ERP — a
    // change between preview and execution is caught, never acted on.
    const fresh = materialFullDeletePreview(input.id)
    if (fresh.blockers.length) {
      throw new AppError(
        'CONFLICT',
        `تعذر حذف المادة بالكامل لحماية السجل التاريخي: ${fresh.blockers.join('، ')}`
      )
    }
    const raw = getRawConnection()

    const affectedPurchaseIds = (
      raw
        .prepare('SELECT DISTINCT purchase_id AS id FROM purchase_lines WHERE material_id = ?')
        .all(input.id) as Array<{ id: number }>
    ).map((row) => row.id)
    for (const purchaseId of affectedPurchaseIds) {
      const otherLines = raw
        .prepare(
          'SELECT COUNT(*) AS c FROM purchase_lines WHERE purchase_id = ? AND material_id != ?'
        )
        .get(purchaseId, input.id) as { c: number }
      if (otherLines.c === 0) {
        // The whole invoice is about this material alone — remove it
        // (and its own payments/cash effects) through the SAME safe
        // path a Purchase Invoice full delete already uses.
        const invoicePreview = purchaseFullDeletePreview(purchaseId)
        if (invoicePreview.blockers.length) {
          throw new AppError(
            'CONFLICT',
            `تعذر حذف فاتورة الشراء المرتبطة بالكامل: ${invoicePreview.blockers.join('، ')}`
          )
        }
        performFullDeletePurchase(
          purchaseId,
          ctx,
          `Material full delete (${material.name} #${input.id})`
        )
      } else {
        // A multi-material invoice — only this material's own line(s)
        // and the invoice's own stored total go; every other line,
        // the supplier, and any payment on the invoice are untouched.
        const removedTotal = raw
          .prepare(
            'SELECT COALESCE(SUM(line_total_minor), 0) AS t FROM purchase_lines WHERE purchase_id = ? AND material_id = ?'
          )
          .get(purchaseId, input.id) as { t: number }
        raw
          .prepare('DELETE FROM purchase_lines WHERE purchase_id = ? AND material_id = ?')
          .run(purchaseId, input.id)
        raw
          .prepare('UPDATE purchases SET total_minor = total_minor - ? WHERE id = ?')
          .run(removedTotal.t, purchaseId)
      }
    }

    raw.prepare('DELETE FROM material_remainders WHERE material_id = ?').run(input.id)
    raw.prepare('DELETE FROM fifo_layers WHERE material_id = ?').run(input.id)
    raw.prepare('DELETE FROM inventory_movements WHERE material_id = ?').run(input.id)
    raw.prepare('DELETE FROM product_bom_lines WHERE material_id = ?').run(input.id)
    raw
      .prepare('UPDATE planned_materials SET material_id = NULL WHERE material_id = ?')
      .run(input.id)
    raw.prepare('UPDATE quotation_lines SET material_id = NULL WHERE material_id = ?').run(input.id)
    raw.prepare('UPDATE order_lines SET material_id = NULL WHERE material_id = ?').run(input.id)
    raw
      .prepare('UPDATE final_invoice_lines SET material_id = NULL WHERE material_id = ?')
      .run(input.id)
    raw.prepare('DELETE FROM materials WHERE id = ?').run(input.id)
    if (material.hierarchyNodeId) {
      raw.prepare('DELETE FROM material_categories WHERE id = ?').run(material.hierarchyNodeId)
    }

    const summary = Object.fromEntries(
      fresh.dependencies.map((item) => [item.key, item.count])
    ) as Record<string, number>
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.material.full_delete',
      entity: 'materials',
      entityId: String(input.id),
      details: {
        fullDelete: true,
        description: `Full Raw Material deletion (${material.name} #${input.id})`,
        sku: material.sku,
        name: material.name,
        summary
      }
    })
    return { removed: true, summary }
  })
}

/**
 * The accessory catalog offered by sales documents — ordinary Raw
 * Materials living under a category flagged as accessories (BR-50).
 * Read-only here: picking an accessory on an invoice never creates or
 * edits material master data.
 */
export function listAccessoryMaterials() {
  const paths = buildHierarchyPaths(catalogRepository.listCategories())
  return catalogRepository.listAccessoryMaterials().map((material) => ({
    ...material,
    hierarchyPath: materialPath(material, paths)
  }))
}

/**
 * The "نوع المادة" catalog offered by sales documents — every active
 * Raw Material, read-only here exactly like listAccessoryMaterials:
 * picking one on an invoice never creates or edits material master
 * data.
 */
export function listMaterialTypeOptions() {
  return listMaterials({ activeOnly: true }).map(({ id, sku, name, hierarchyPath }) => ({
    id,
    sku,
    name,
    hierarchyPath
  }))
}

/**
 * Shared by resolveAccessorySnapshot and resolveMaterialTypeSnapshot
 * below: turns a picked material id into the stable reference PLUS its
 * current name, or — with no id — passes the caller's own text through
 * untouched. That "no id" branch is what keeps legacy free-text rows
 * (accessories typed before the catalog link existed, or "نوع المادة"
 * typed before this task) working without any migration of old data.
 */
function resolveMaterialReference(
  materialId: number | null | undefined,
  fallbackText: string | null | undefined,
  notFoundMessage: string
): { id: number | null; name: string | null } {
  if (materialId === null || materialId === undefined)
    return { id: null, name: fallbackText ?? null }
  const material = catalogRepository.getMaterial(materialId)
  if (!material) throw notFound(notFoundMessage)
  return { id: material.id, name: material.name }
}

/**
 * Turns an accessory pick into what a sales document actually stores:
 * the stable material reference PLUS the frozen snapshot text, the
 * same reference+snapshot shape `finalInvoiceTerms` uses for terms.
 *
 * With no reference the caller's own text is kept untouched, which is
 * what keeps legacy free-text accessories working and lets a document
 * still carry a typed value the catalog does not have.
 */
export function resolveAccessorySnapshot(
  accessoryMaterialId: number | null | undefined,
  fallbackText: string | null | undefined
): { accessoryMaterialId: number | null; accessories: string | null } {
  const resolved = resolveMaterialReference(
    accessoryMaterialId,
    fallbackText,
    'الإكسسوار المحدد غير موجود'
  )
  return { accessoryMaterialId: resolved.id, accessories: resolved.name }
}

/**
 * The same reference+snapshot resolution for "نوع المادة" — see
 * resolveAccessorySnapshot immediately above, which this mirrors
 * exactly.
 */
export function resolveMaterialTypeSnapshot(
  materialTypeMaterialId: number | null | undefined,
  fallbackText: string | null | undefined
): { materialTypeMaterialId: number | null; materialType: string | null } {
  const resolved = resolveMaterialReference(
    materialTypeMaterialId,
    fallbackText,
    'المادة المحددة غير موجودة'
  )
  return { materialTypeMaterialId: resolved.id, materialType: resolved.name }
}
