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
import { withImmediateTransaction, withTransaction } from '../../db/transactions'
import { inventoryRepository } from '../../repositories/inventory/inventory.repository'
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
  showInRawMaterials: boolean
  depth: number
  /** Null only for organizational roots and untouched legacy category rows. */
  rawMaterialId: number | null
  visibilityMaterialId: number | null
  materialColorId: number | null
  children: CategoryNode[]
  materialCount: number
}

/**
 * The category tree stays recursive and name-agnostic. New writes use the
 * explicit business levels; material-type branches may continue at any depth.
 */
export function categoryTree(): CategoryNode[] {
  const rows = catalogRepository.listCategories()
  const materialRows = catalogRepository.listMaterials({})
  const materialByNode = new Map(
    materialRows
      .filter((material) => material.hierarchyNodeId !== null)
      .map((material) => [material.hierarchyNodeId!, material])
  )
  const materialByVisibilityKey = new Map(
    materialRows
      .filter((material) => material.creationKey?.startsWith('category-visibility:'))
      .map((material) => [material.creationKey!, material])
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
    const linkedMaterial = materialByNode.get(row.id)
    const directItems = materialRows.filter((material) => material.categoryId === row.id && material.hierarchyNodeId === null)
    const associatedMaterial = linkedMaterial ??
      materialByVisibilityKey.get(ownedCategoryVisibilityKey(row.id)) ??
      materialByVisibilityKey.get(categoryVisibilityKey(row.id)) ??
      (directItems.length === 1 ? directItems[0] : undefined)
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      active: row.active,
      sortOrder: row.sortOrder,
      nodeKind: row.nodeKind,
      showInRawMaterials: row.showInRawMaterials,
      depth: 0,
      rawMaterialId: linkedMaterial?.id ?? null,
      visibilityMaterialId: associatedMaterial?.id ?? null,
      materialColorId: associatedMaterial?.colorId ?? null,
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

const NONZERO_CATEGORY_STOCK_ERROR =
  'لا يمكن إيقاف ظهور هذا التصنيف في مواد الخام لوجود رصيد بالمخزون. يجب أن يصبح الرصيد صفرًا أولًا.'

function categoryVisibilityKey(categoryId: number): string {
  return `category-visibility:${categoryId}`
}

function ownedCategoryVisibilityKey(categoryId: number): string {
  return `${categoryVisibilityKey(categoryId)}:owned`
}

export interface CategoryMaterialDetails extends Omit<MaterialInput, 'categoryId' | 'name'> {
  name?: string
}

/** Existing leaf materials and one matching direct material keep their original identity. */
function visibilityMaterial(categoryId: number, name: string) {
  const linked = catalogRepository.getMaterialByHierarchyNode(categoryId)
  if (linked) return linked
  const keyed = catalogRepository.getMaterialByCreationKey(ownedCategoryVisibilityKey(categoryId)) ??
    catalogRepository.getMaterialByCreationKey(categoryVisibilityKey(categoryId))
  if (keyed) {
    if (keyed.categoryId !== categoryId) {
      throw new AppError('CONFLICT', 'المادة المرتبطة بهذا التصنيف نُقلت إلى تصنيف آخر؛ راجع ارتباطها قبل إعادة التفعيل')
    }
    return keyed
  }
  const matching = catalogRepository.listMaterials({ categoryId })
    .filter((material) => material.categoryId === categoryId && material.name === name &&
      material.hierarchyNodeId === null && material.creationKey === null)
  return matching.length === 1 ? matching[0] : undefined
}

function ensureVisibilityMaterial(
  categoryId: number,
  name: string,
  details: CategoryMaterialDetails | undefined,
  ctx: ServiceContext
): void {
  const material = visibilityMaterial(categoryId, name)
  if (material) {
    if (!material.active) catalogRepository.updateMaterial(material.id, { active: true })
    if (!material.hierarchyNodeId && !material.creationKey) {
      catalogRepository.updateMaterial(material.id, { creationKey: categoryVisibilityKey(categoryId) })
    }
    return
  }
  if (catalogRepository.listMaterials({ categoryId }).some((row) => row.categoryId === categoryId && row.active)) return
  if (!details?.sku?.trim() || !details.unit?.trim() || details.currentMarketPriceMicro === undefined || !details.pricingRule) {
    throw new AppError('VALIDATION_ERROR', 'لإظهار التصنيف في مواد الخام، أدخل كود المادة ووحدة المخزون وسعر السوق وقاعدة التسعير')
  }
  const materialId = createMaterial({
    ...details,
    sku: details.sku.trim(),
    name: details.name?.trim() || name,
    categoryId,
    unit: details.unit.trim(),
    active: true
  }, ctx)
  catalogRepository.updateMaterial(materialId, { creationKey: ownedCategoryVisibilityKey(categoryId) })
}

function assertZeroCategoryStock(categoryId: number): void {
  const materialIds = new Set(
    catalogRepository.listMaterials({ categoryId })
      .filter((material) => material.categoryId === categoryId)
      .map((material) => material.id)
  )
  const linked = catalogRepository.getMaterialByHierarchyNode(categoryId)
  const keyed = catalogRepository.getMaterialByCreationKey(categoryVisibilityKey(categoryId))
  if (linked) materialIds.add(linked.id)
  if (keyed) materialIds.add(keyed.id)
  for (const materialId of materialIds) {
    if (inventoryRepository.availableQtyMicro(materialId) !== 0) {
      throw new AppError('VALIDATION_ERROR', NONZERO_CATEGORY_STOCK_ERROR)
    }
    // The current inventory model has FIFO batches but no warehouse column.
    // Check each batch so opposite signed rows cannot hide a nonzero balance.
    const nonzeroLayer = getDatabase().get<{ id: number }>(
      sql`SELECT id FROM fifo_layers WHERE material_id = ${materialId} AND qty_remaining_micro <> 0 LIMIT 1`
    )
    if (nonzeroLayer) throw new AppError('VALIDATION_ERROR', NONZERO_CATEGORY_STOCK_ERROR)
    const availableRemainder = getDatabase().get<{ id: number }>(
      sql`SELECT id FROM material_remainders WHERE material_id = ${materialId} AND available = 1 AND size_micro <> 0 LIMIT 1`
    )
    if (availableRemainder) throw new AppError('VALIDATION_ERROR', NONZERO_CATEGORY_STOCK_ERROR)
  }
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
  input: { name: string; parentId?: number | null; sortOrder?: number; isAccessory?: boolean; showInRawMaterials?: boolean; materialDetails?: CategoryMaterialDetails },
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
      : parent.nodeKind === 'material_family' || parent.nodeKind === 'material_type'
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
  return withImmediateTransaction(() => {
    const id = catalogRepository.insertCategory({
      name,
      nodeKind,
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 0,
      isAccessory: input.isAccessory ?? false,
      showInRawMaterials: input.showInRawMaterials ?? true,
      createdAt: nowIso()
    })
    if (input.showInRawMaterials === true) {
      ensureVisibilityMaterial(id, name, input.materialDetails, ctx)
    }
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
  if (parent.nodeKind !== requiredParentKind[kind] &&
      !(kind === 'material_type' && parent.nodeKind === 'material_type')) {
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
    showInRawMaterials?: boolean
    materialDetails?: CategoryMaterialDetails
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.materials.manage)
  if (input.sortOrder !== undefined) requireSafeInteger(input.sortOrder, 'ترتيب التصنيف')
  if (input.parentId != null) requireSafePositiveInteger(input.parentId, 'التصنيف الأب')
  const existing = catalogRepository.getCategory(id)
  if (!existing) throw notFound('التصنيف غير موجود')
  const linkedMaterial = catalogRepository.getMaterialByHierarchyNode(id)
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
  withImmediateTransaction(() => {
    const current = catalogRepository.getCategory(id)!
    const boundMaterial = visibilityMaterial(id, current.name)
    if (input.showInRawMaterials === false && current.showInRawMaterials) {
      assertZeroCategoryStock(id)
    }
    const { materialDetails, ...categoryInput } = input
    catalogRepository.updateCategory(id, categoryInput)
    if (linkedMaterial && (input.name !== undefined || input.active !== undefined)) {
      catalogRepository.updateMaterial(linkedMaterial.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.active !== undefined ? { active: input.active } : {})
      })
    }
    if (boundMaterial && !linkedMaterial && input.name !== undefined && input.name.trim() !== existing.name && !boundMaterial.creationKey) {
      catalogRepository.updateMaterial(boundMaterial.id, {
        creationKey: categoryVisibilityKey(id)
      })
    }
    if (input.showInRawMaterials === true) {
      ensureVisibilityMaterial(id, input.name?.trim() ?? existing.name, materialDetails, ctx)
    } else if (input.showInRawMaterials === false && current.showInRawMaterials) {
      if (boundMaterial) catalogRepository.updateMaterial(boundMaterial.id, { active: false })
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

export type CategoryDeleteBlocker = 'children' | 'materials' | 'stock' | 'history' | 'ambiguous'
export interface CategoryDeletePreview {
  categoryId: number
  name: string
  ownedMaterialId: number | null
  blocker: CategoryDeleteBlocker | null
  message: string | null
}

const CATEGORY_DELETE_MESSAGES: Record<CategoryDeleteBlocker, string> = {
  children: 'لا يمكن حذف التصنيف لأنه يحتوي على تصنيفات فرعية. احذف أو انقل التصنيفات الفرعية أولًا.',
  materials: 'لا يمكن حذف التصنيف لأنه يحتوي على مواد تابعة له. يجب معالجة المواد أولًا.',
  stock: 'لا يمكن حذف المادة أو التصنيف لوجود رصيد غير صفري في المخزون.',
  history: 'لا يمكن حذف المادة أو التصنيف لوجود فواتير أو حركات مخزون أو سجلات مرتبطة بها. عطّل ظهور التصنيف في مواد الخام بدلًا من الحذف.',
  ambiguous: 'لا يمكن إتمام الحذف بأمان لوجود مادة مرتبطة لا يمكن تحديد ملكيتها تلقائيًا.'
}

/** Every declared inbound FK counts, including nullable snapshot and legacy color links. */
function inboundReferences(table: 'materials' | 'material_categories', id: number, ignored: Array<{ table: string; column: string; rowId: number }> = []): number {
  const raw = getRawConnection()
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  let count = 0
  for (const row of tables) {
    const quotedTable = `"${row.name.replaceAll('"', '""')}"`
    const foreignKeys = raw.prepare(`PRAGMA foreign_key_list(${quotedTable})`).all() as Array<{ table: string; from: string }>
    for (const fk of foreignKeys) {
      if (fk.table !== table) continue
      const quotedColumn = `"${fk.from.replaceAll('"', '""')}"`
      const ownRow = ignored.find((item) => row.name === item.table && fk.from === item.column)
      const found = ownRow
        ? raw.prepare(`SELECT 1 FROM ${quotedTable} WHERE ${quotedColumn} = ? AND id <> ? LIMIT 1`).get(id, ownRow.rowId)
        : raw.prepare(`SELECT 1 FROM ${quotedTable} WHERE ${quotedColumn} = ? LIMIT 1`).get(id)
      if (found) count++
    }
  }
  return count
}

function hasNonzeroMaterialStock(id: number): boolean {
  if (inventoryRepository.availableQtyMicro(id) !== 0) return true
  const raw = getRawConnection()
  return Boolean(raw.prepare('SELECT 1 FROM fifo_layers WHERE material_id = ? AND qty_remaining_micro <> 0 LIMIT 1').get(id) ||
    raw.prepare('SELECT 1 FROM material_remainders WHERE material_id = ? AND available = 1 AND size_micro <> 0 LIMIT 1').get(id))
}

export function categoryDeletePreview(id: number): CategoryDeletePreview {
  const category = catalogRepository.getCategory(id)
  if (!category) throw notFound('التصنيف غير موجود')
  const direct = catalogRepository.listMaterials({ categoryId: id }).filter((material) => material.categoryId === id)
  const onlyMaterial = direct.length === 1 ? direct[0] : undefined
  const owned = onlyMaterial?.creationKey === ownedCategoryVisibilityKey(id) &&
    onlyMaterial.hierarchyNodeId === null ? onlyMaterial : undefined
  let blocker: CategoryDeleteBlocker | null = null
  if (catalogRepository.countChildren(id) > 0) blocker = 'children'
  else if (catalogRepository.getMaterialByHierarchyNode(id)) blocker = 'ambiguous'
  else if (direct.length > 0 && !owned) {
    blocker = direct.some((material) => material.creationKey?.startsWith('category-visibility:')) ? 'ambiguous' : 'materials'
  } else if (owned && hasNonzeroMaterialStock(owned.id)) blocker = 'stock'
  else if ((owned && inboundReferences('materials', owned.id) > 0) ||
    inboundReferences('material_categories', id, owned ? [{ table: 'materials', column: 'category_id', rowId: owned.id }] : []) > 0) blocker = 'history'
  return {
    categoryId: id,
    name: category.name,
    ownedMaterialId: owned?.id ?? null,
    blocker,
    message: blocker ? CATEGORY_DELETE_MESSAGES[blocker] : null
  }
}

export function deleteCategory(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.materials.manage)
  withImmediateTransaction(() => {
    const preview = categoryDeletePreview(id)
    if (preview.message) throw new AppError('CONFLICT', preview.message)
    if (preview.ownedMaterialId !== null) catalogRepository.deleteMaterial(preview.ownedMaterialId)
    catalogRepository.deleteCategory(id)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.category.delete',
      entity: 'material_categories',
      entityId: String(id),
      details: { ownedMaterialId: preview.ownedMaterialId }
    })
  })
}

export interface MaterialDefinitionDeletePreview {
  materialId: number
  name: string
  categoryId: number
  blocker: CategoryDeleteBlocker | null
  message: string | null
}

export function materialDefinitionDeletePreview(id: number): MaterialDefinitionDeletePreview {
  const material = getMaterial(id)
  const legacyNode = material.hierarchyNodeId === material.categoryId ? material.categoryId : null
  let blocker: CategoryDeleteBlocker | null = null
  if (material.creationKey?.startsWith('category-visibility:') ||
      (material.hierarchyNodeId !== null && legacyNode === null)) blocker = 'ambiguous'
  else if (legacyNode !== null && catalogRepository.countChildren(legacyNode) > 0) blocker = 'children'
  else if (legacyNode !== null && catalogRepository.countMaterialsInCategory(legacyNode) > 1) blocker = 'materials'
  else if (hasNonzeroMaterialStock(id)) blocker = 'stock'
  else if (inboundReferences('materials', id) > 0 ||
      (legacyNode !== null && inboundReferences('material_categories', legacyNode, [
        { table: 'materials', column: 'category_id', rowId: id },
        { table: 'materials', column: 'hierarchy_node_id', rowId: id }
      ]) > 0)) blocker = 'history'
  return { materialId: id, name: material.name, categoryId: material.categoryId,
    blocker, message: blocker ? CATEGORY_DELETE_MESSAGES[blocker] : null }
}

export function deleteMaterialDefinition(input: { id: number; confirmation: string }, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.materials.fullDelete)
  withImmediateTransaction(() => {
    const preview = materialDefinitionDeletePreview(input.id)
    if (preview.message) throw new AppError('CONFLICT', preview.message)
    if (input.confirmation.trim() !== preview.name.trim()) {
      throw new AppError('VALIDATION_ERROR', `اكتب اسم المادة "${preview.name}" لتأكيد الحذف النهائي`)
    }
    const material = getMaterial(input.id)
    catalogRepository.deleteMaterial(input.id)
    if (material.hierarchyNodeId !== null) catalogRepository.deleteCategory(material.hierarchyNodeId)
    recordAuditEvent({ userId: ctx.session.user.id, action: 'catalog.material.delete',
      entity: 'materials', entityId: String(input.id),
      details: { categoryId: preview.categoryId, hierarchyNodeId: material.hierarchyNodeId } })
  })
}

/** BR-69: user-maintained Color / Finish Catalog. */
export function listColors(activeOnly = false) {
  const colors = catalogRepository.listColors(activeOnly)
  const categories = new Map(catalogRepository.listCategories().map((category) => [category.id, category]))
  const byColor = new Map<number, Array<{ id: number; sku: string; name: string }>>()
  const baseNames = new Map<number, Set<string>>()
  const unresolvedMaterialIds = new Map<number, number[]>()
  for (const material of catalogRepository.listMaterials({})) {
    if (material.colorId === null) continue
    const linked = byColor.get(material.colorId) ?? []
    linked.push({ id: material.id, sku: material.sku, name: material.name })
    byColor.set(material.colorId, linked)
    const base = baseCategoryFor(material, categories)
    if (base) {
      const names = baseNames.get(material.colorId) ?? new Set<string>()
      names.add(base.name)
      baseNames.set(material.colorId, names)
    } else {
      const ids = unresolvedMaterialIds.get(material.colorId) ?? []
      ids.push(material.id)
      unresolvedMaterialIds.set(material.colorId, ids)
    }
  }
  return colors.map((color) => {
    const associatedMaterials = byColor.get(color.id) ?? []
    return {
      ...color,
      associatedMaterials,
      baseMaterialNames: [...(baseNames.get(color.id) ?? [])],
      unresolvedMaterialIds: unresolvedMaterialIds.get(color.id) ?? [],
      legacyAssociationConflict: color.relatedMaterialId !== null
        ? !associatedMaterials.some((material) => material.id === color.relatedMaterialId)
        : Boolean(color.relatedMaterialType?.trim())
    }
  })
}

interface ColorMaterialInput {
  /** Legacy catalog links are retained for history; new assignments use materials.color_id. */
  relatedMaterialId?: number | null
  /** Compatibility only: no new arbitrary material labels are accepted. */
  relatedMaterialType?: string | null
}

/** Compatibility option endpoint; catalog associations are now read-only. */
export function colorMaterialOptions(colorId?: number) {
  if (colorId !== undefined) {
    if (!catalogRepository.getColor(colorId)) throw notFound('اللون أو التشطيب غير موجود')
  }
  return listMaterials({ activeOnly: true })
    .filter((material) => material.colorId !== null)
    .map(({ id, sku, name, hierarchyPath }) => ({ id, sku, name, hierarchyPath }))
}

export function createColor(
  input: { code: string; name: string; notes?: string } & ColorMaterialInput,
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.colors.manage)
  if (input.relatedMaterialId != null || input.relatedMaterialType?.trim()) {
    throw new AppError('VALIDATION_ERROR', 'اربط المادة باللون من نموذج المادة')
  }
  if (catalogRepository.getColorByCode(input.code)) {
    throw new AppError('CONFLICT', 'كود اللون مستخدم بالفعل')
  }
  const fields = { code: input.code, name: input.name, notes: input.notes }
  const material = { relatedMaterialId: null, relatedMaterialType: null }
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
  if ((input.relatedMaterialId !== undefined && input.relatedMaterialId !== existing.relatedMaterialId) ||
      (input.relatedMaterialType !== undefined && input.relatedMaterialType !== existing.relatedMaterialType)) {
    throw new AppError('VALIDATION_ERROR', 'اربط المادة باللون من نموذج المادة')
  }
  if (input.code && input.code !== existing.code && catalogRepository.getColorByCode(input.code)) {
    throw new AppError('CONFLICT', 'كود اللون مستخدم بالفعل')
  }
  const fields = { code: input.code, name: input.name, notes: input.notes, active: input.active }
  withTransaction(() => {
    catalogRepository.updateColor(id, fields)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.color.update',
      entity: 'color_finish_catalog',
      entityId: String(id),
      details: fields
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
    catalogRepository.listMaterialsByColor(id).length +
    (color.relatedMaterialId !== null || color.relatedMaterialType?.trim() ? 1 : 0)

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

function validateStockColor(colorId: number): void {
  const color = catalogRepository.getColor(colorId)
  if (!color) throw notFound('اللون أو التشطيب غير موجود')
  if (!color.active) throw new AppError('VALIDATION_ERROR', 'اللون المحدد غير مفعّل')
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
  paths: Map<number, string>,
  baseName?: string
): string {
  const categoryPath = paths.get(material.categoryId) ?? ''
  if (material.hierarchyNodeId === material.categoryId || material.name === baseName) return categoryPath
  return [categoryPath, material.name].filter(Boolean).join(' ← ')
}

function baseCategoryFor(
  material: { categoryId: number; hierarchyNodeId: number | null },
  categories: Map<number, ReturnType<typeof catalogRepository.listCategories>[number]>
) {
  if (material.hierarchyNodeId !== null && material.hierarchyNodeId !== material.categoryId) return undefined
  const assigned = categories.get(material.hierarchyNodeId ?? material.categoryId)
  if (!assigned || assigned.nodeKind === 'legacy_ambiguous') return undefined
  const category = assigned.nodeKind === 'inventory_leaf'
    ? (assigned.parentId === null ? undefined : categories.get(assigned.parentId))
    : categories.get(material.categoryId)
  return category
}

export function listMaterials(filter: {
  search?: string
  categoryId?: number
  activeOnly?: boolean
}) {
  const categories = catalogRepository.listCategories()
  const byId = new Map(categories.map((category) => [category.id, category]))
  const paths = buildHierarchyPaths(categories)
  const pathMatches = filter.search?.trim() ? categoryIdsMatchingPath(filter.search) : []
  return catalogRepository.listMaterials(filter, pathMatches).map((material) => {
    const baseCategoryName = baseCategoryFor(material, byId)?.name ?? null
    return { ...material, hierarchyPath: materialPath(material, paths, baseCategoryName ?? undefined), baseCategoryName }
  })
}

export function getMaterial(id: number) {
  const material = catalogRepository.getMaterial(id)
  if (!material) throw notFound('المادة غير موجودة')
  const categories = catalogRepository.listCategories()
  const byId = new Map(categories.map((category) => [category.id, category]))
  const baseCategoryName = baseCategoryFor(material, byId)?.name ?? null
  return { ...material, hierarchyPath: materialPath(material, buildHierarchyPaths(categories), baseCategoryName ?? undefined), baseCategoryName }
}

function assertSelectableCategory(id: number): void {
  const category = catalogRepository.getCategory(id)
  if (!category) throw notFound('التصنيف غير موجود')
  if (!category.showInRawMaterials) {
    throw new AppError('VALIDATION_ERROR', 'التصنيف لا يظهر في مواد الخام للتعيينات الجديدة')
  }
}

export function createMaterial(input: MaterialInput, ctx: ServiceContext): number {
  requirePermission(ctx.session, P.materials.manage)
  return withTransaction(() => {
    validateMaterial(input)
    if (input.colorId != null) validateStockColor(input.colorId)
    // Eligibility is explicit and independent of hierarchy depth.
    assertSelectableCategory(input.categoryId)
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

/** Create an item under an existing base category without adding a color-named category. */
export function createChildMaterial(
  input: ChildMaterialInput,
  ctx: ServiceContext
): { categoryId: number; materialId: number } {
  requirePermission(ctx.session, P.materials.manage)
  const leafType = input.leafType ?? 'raw'
  if (leafType !== 'raw' && leafType !== 'colored') {
    throw new AppError('VALIDATION_ERROR', 'نوع صنف المادة غير صحيح')
  }
  if (leafType === 'colored' && !input.colorId) {
    throw new AppError('VALIDATION_ERROR', 'اختر لوناً من كتالوج الألوان')
  }
  if (leafType === 'raw' && input.colorId != null) {
    throw new AppError('VALIDATION_ERROR', 'الصنف الخام لا يقبل مرجع لون')
  }
  if (input.colorId != null) validateStockColor(input.colorId)
  const parent = catalogRepository.getCategory(input.parentId)
  if (!parent) throw notFound('العنصر الأب غير موجود')
  if (parent.nodeKind !== 'material_type') {
    throw new AppError('VALIDATION_ERROR', 'لا يُنشأ صنف المادة إلا تحت مستوى نوع المادة')
  }
  const retry = catalogRepository.getMaterialByCreationKey(input.clientRequestId)
  if (retry) {
    const retryParentId = retry.hierarchyNodeId
      ? catalogRepository.getCategory(retry.hierarchyNodeId)?.parentId
      : retry.categoryId
    if (
      retry.sku !== input.sku ||
      retry.colorId !== (input.colorId ?? null) ||
      retryParentId !== input.parentId
    ) {
      throw new AppError('CONFLICT', 'مفتاح طلب إنشاء المادة مستخدم لبيانات مختلفة')
    }
    return { categoryId: retry.categoryId, materialId: retry.id }
  }
  validateMaterial({ ...input, categoryId: input.parentId })
  if (catalogRepository.getMaterialBySku(input.sku)) {
    throw new AppError('CONFLICT', 'كود المادة مستخدم بالفعل')
  }

  return withTransaction(() => {
    const existing = catalogRepository.getMaterialByCreationKey(input.clientRequestId)
    if (existing) {
      const existingParentId = existing.hierarchyNodeId
        ? catalogRepository.getCategory(existing.hierarchyNodeId)?.parentId
        : existing.categoryId
      if (
        existing.sku !== input.sku ||
        existing.colorId !== (input.colorId ?? null) ||
        existingParentId !== input.parentId
      ) {
        throw new AppError('CONFLICT', 'مفتاح طلب إنشاء المادة مستخدم لبيانات مختلفة')
      }
      return { categoryId: existing.categoryId, materialId: existing.id }
    }
    const {
      parentId,
      clientRequestId,
      leafType: _leafType,
      ...materialInput
    } = input
    void _leafType
    const materialId = catalogRepository.insertMaterial({
      ...materialInput,
      name: parent.name,
      colorId: input.colorId ?? null,
      categoryId: parentId,
      creationKey: clientRequestId,
      createdAt: nowIso()
    })
    if (!parent.showInRawMaterials) {
      catalogRepository.updateCategory(parentId, { showInRawMaterials: true })
    }
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'catalog.material.create',
      entity: 'materials',
      entityId: String(materialId),
      details: {
        sku: materialInput.sku,
        name: parent.name,
        leafType,
        colorId: input.colorId ?? null,
        parentId
      }
    })
    return { categoryId: parentId, materialId }
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
  const normalizedInput = { ...input }
  const targetColorId = input.colorId === undefined ? existing.colorId : input.colorId
  if (targetColorId !== null) {
    const color = catalogRepository.getColor(targetColorId)
    if (!color) throw notFound('اللون أو التشطيب غير موجود')
    if (!color.active && targetColorId !== existing.colorId) {
      throw new AppError('VALIDATION_ERROR', 'اللون المحدد غير مفعّل')
    }
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
  if (existing.creationKey?.startsWith('category-visibility:')) {
    if (normalizedInput.categoryId !== undefined && normalizedInput.categoryId !== existing.categoryId) {
      throw new AppError('VALIDATION_ERROR', 'المادة المرتبطة بظهور التصنيف لا تُنقل إلى تصنيف آخر')
    }
    if (normalizedInput.active === true && !catalogRepository.getCategory(existing.categoryId)?.showInRawMaterials) {
      throw new AppError('VALIDATION_ERROR', 'فعّل ظهور التصنيف في مواد الخام أولًا')
    }
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
    // Existing assignments survive disabling a category; only a new
    // category target must be selectable.
    assertSelectableCategory(normalizedInput.categoryId)
  }
  withTransaction(() => {
    if (input.colorId !== undefined && input.colorId !== existing.colorId &&
        materialFullDeletePreview(id).dependencies.length > 0) {
      throw new AppError('VALIDATION_ERROR', 'لا يمكن تغيير نوع المادة أو لونها بعد ارتباطها بحركات أو مستندات تاريخية')
    }
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
