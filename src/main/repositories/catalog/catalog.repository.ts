import { and, asc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { colorFinishCatalog, materialCategories, materials } from '../../db/schema/catalog.schema'

/**
 * `rootId` plus every category reachable from it at any depth, walked
 * purely by id/parent_id (BR-66: an arbitrary user-built tree, never
 * assumed from a name). Selecting a category — parent or child — must
 * show materials assigned to it directly AND to anything nested under
 * it; a plain `= rootId` match misses every descendant.
 */
export function categoryIdsWithDescendants(rootId: number): number[] {
  const rows = getDatabase()
    .select({ id: materialCategories.id, parentId: materialCategories.parentId })
    .from(materialCategories)
    .all()
  const childrenByParent = new Map<number, number[]>()
  for (const row of rows) {
    if (row.parentId === null) continue
    const siblings = childrenByParent.get(row.parentId)
    if (siblings) siblings.push(row.id)
    else childrenByParent.set(row.parentId, [row.id])
  }
  const ids = [rootId]
  const seen = new Set(ids)
  const queue = [rootId]
  while (queue.length) {
    const current = queue.shift()!
    for (const childId of childrenByParent.get(current) ?? []) {
      if (seen.has(childId)) continue
      seen.add(childId)
      ids.push(childId)
      queue.push(childId)
    }
  }
  return ids
}

/** Category ids whose complete ancestor path contains `search`.
 * The tree is loaded once, so path-aware material search never performs
 * one parent query per result row. */
export function categoryIdsMatchingPath(search: string): number[] {
  const query = search.trim().toLocaleLowerCase()
  if (!query) return []
  const rows = getDatabase()
    .select({
      id: materialCategories.id,
      name: materialCategories.name,
      parentId: materialCategories.parentId
    })
    .from(materialCategories)
    .all()
  const byId = new Map(rows.map((row) => [row.id, row]))
  const memo = new Map<number, string>()
  const pathFor = (id: number, visiting = new Set<number>()): string => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    const row = byId.get(id)
    if (!row || visiting.has(id)) return ''
    visiting.add(id)
    const parentPath = row.parentId === null ? '' : pathFor(row.parentId, visiting)
    visiting.delete(id)
    const path = `${parentPath} ${row.name}`.trim().toLocaleLowerCase()
    memo.set(id, path)
    return path
  }
  return rows.filter((row) => pathFor(row.id).includes(query)).map((row) => row.id)
}

export const catalogRepository = {
  listCategories() {
    return getDatabase()
      .select()
      .from(materialCategories)
      .orderBy(asc(materialCategories.sortOrder), asc(materialCategories.name))
      .all()
  },
  getCategory(id: number) {
    return getDatabase()
      .select()
      .from(materialCategories)
      .where(eq(materialCategories.id, id))
      .get()
  },
  findSiblingCategory(name: string, parentId: number | null) {
    return getDatabase()
      .select()
      .from(materialCategories)
      .where(
        and(
          sql`lower(trim(${materialCategories.name})) = lower(trim(${name}))`,
          parentId === null
            ? isNull(materialCategories.parentId)
            : eq(materialCategories.parentId, parentId)
        )
      )
      .get()
  },
  insertCategory(values: Record<string, unknown>): number {
    return Number(
      getDatabase()
        .insert(materialCategories)
        .values(values as never)
        .run().lastInsertRowid
    )
  },
  updateCategory(id: number, values: Record<string, unknown>): void {
    getDatabase()
      .update(materialCategories)
      .set(values as never)
      .where(eq(materialCategories.id, id))
      .run()
  },
  countChildren(id: number): number {
    const row = getDatabase().get<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM material_categories WHERE parent_id = ${id}`
    )
    return row?.c ?? 0
  },
  countMaterialsInCategory(id: number): number {
    const row = getDatabase().get<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM materials WHERE category_id = ${id}`
    )
    return row?.c ?? 0
  },
  deleteCategory(id: number): void {
    getDatabase().delete(materialCategories).where(eq(materialCategories.id, id)).run()
  },

  listColors(activeOnly = false) {
    return getDatabase()
      .select()
      .from(colorFinishCatalog)
      .where(activeOnly ? eq(colorFinishCatalog.active, true) : undefined)
      .orderBy(asc(colorFinishCatalog.code))
      .all()
  },
  getColorByCode(code: string) {
    return getDatabase()
      .select()
      .from(colorFinishCatalog)
      .where(eq(colorFinishCatalog.code, code))
      .get()
  },
  getColor(id: number) {
    return getDatabase()
      .select()
      .from(colorFinishCatalog)
      .where(eq(colorFinishCatalog.id, id))
      .get()
  },
  listMaterialsByColor(colorId: number) {
    return getDatabase().select().from(materials).where(eq(materials.colorId, colorId)).all()
  },
  insertColor(values: Record<string, unknown>): number {
    return Number(
      getDatabase()
        .insert(colorFinishCatalog)
        .values(values as never)
        .run().lastInsertRowid
    )
  },
  updateColor(id: number, values: Record<string, unknown>): void {
    getDatabase()
      .update(colorFinishCatalog)
      .set(values as never)
      .where(eq(colorFinishCatalog.id, id))
      .run()
  },
  deleteColor(id: number): void {
    getDatabase().delete(colorFinishCatalog).where(eq(colorFinishCatalog.id, id)).run()
  },

  /**
   * The accessory catalog for sales documents: every ACTIVE material
   * sitting in a category flagged `is_accessory`, or anywhere beneath
   * one (BR-50 — accessories are ordinary materials separated only by
   * their category). Nothing is matched by name, and no parallel
   * accessories master exists; flag a category and its whole subtree
   * becomes selectable. With no category flagged this correctly
   * returns nothing rather than offering MDF, wood or paint.
   */
  listAccessoryMaterials() {
    const roots = getDatabase()
      .select({ id: materialCategories.id })
      .from(materialCategories)
      .where(and(eq(materialCategories.isAccessory, true), eq(materialCategories.active, true)))
      .all()
    if (!roots.length) return []
    const ids = [...new Set(roots.flatMap((r) => categoryIdsWithDescendants(r.id)))]
    return getDatabase()
      .select({
        id: materials.id,
        sku: materials.sku,
        name: materials.name,
        unit: materials.unit,
        categoryId: materials.categoryId,
        hierarchyNodeId: materials.hierarchyNodeId
      })
      .from(materials)
      .where(and(inArray(materials.categoryId, ids), eq(materials.active, true)))
      .orderBy(asc(materials.sku))
      .all()
  },

  /**
   * Every ACTIVE Raw Material, for the "نوع المادة" selector on sales
   * documents (Preliminary/Approved Invoice). Unlike accessories this
   * is not scoped to any flagged category — "نوع المادة" describes what
   * a custom/standard item is made from in general, so the full active
   * catalog is the right source, exactly as the Raw Materials page
   * itself shows it minus inactive rows.
   */
  listMaterialTypeOptions() {
    return getDatabase()
      .select({ id: materials.id, sku: materials.sku, name: materials.name })
      .from(materials)
      .where(eq(materials.active, true))
      .orderBy(asc(materials.sku))
      .all()
  },

  listMaterials(
    filter: { search?: string; categoryId?: number; activeOnly?: boolean },
    pathCategoryIds: number[] = []
  ) {
    const clauses = []
    if (filter.search?.trim()) {
      const p = `%${filter.search.trim()}%`
      clauses.push(
        or(
          like(materials.name, p),
          like(materials.sku, p),
          ...(pathCategoryIds.length ? [inArray(materials.categoryId, pathCategoryIds)] : [])
        )
      )
    }
    if (filter.categoryId)
      clauses.push(inArray(materials.categoryId, categoryIdsWithDescendants(filter.categoryId)))
    if (filter.activeOnly) clauses.push(eq(materials.active, true))
    return getDatabase()
      .select()
      .from(materials)
      .where(clauses.length ? and(...clauses) : undefined)
      .orderBy(asc(materials.name))
      .all()
  },
  getMaterial(id: number) {
    return getDatabase().select().from(materials).where(eq(materials.id, id)).get()
  },
  getMaterialBySku(sku: string) {
    return getDatabase().select().from(materials).where(eq(materials.sku, sku)).get()
  },
  getMaterialByHierarchyNode(nodeId: number) {
    return getDatabase().select().from(materials).where(eq(materials.hierarchyNodeId, nodeId)).get()
  },
  getMaterialByCreationKey(creationKey: string) {
    return getDatabase()
      .select()
      .from(materials)
      .where(eq(materials.creationKey, creationKey))
      .get()
  },
  insertMaterial(values: Record<string, unknown>): number {
    return Number(
      getDatabase()
        .insert(materials)
        .values(values as never)
        .run().lastInsertRowid
    )
  },
  updateMaterial(id: number, values: Record<string, unknown>): void {
    getDatabase()
      .update(materials)
      .set(values as never)
      .where(eq(materials.id, id))
      .run()
  },
  deleteMaterial(id: number): void {
    getDatabase().delete(materials).where(eq(materials.id, id)).run()
  }
}
