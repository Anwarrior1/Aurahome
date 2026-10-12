import { sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import {
  categoryIdsMatchingPath,
  categoryIdsWithDescendants
} from '../../repositories/catalog/catalog.repository'

/** Same category-id resolution `listMaterials` uses (parent selection
 *  rolls up every descendant) — so a material this screen's own list
 *  shows for a category never silently disappears from its stock
 *  figure just because it sits on a subcategory. */
function categoryFilterClause(categoryId: number | undefined) {
  if (!categoryId) return sql``
  const ids = categoryIdsWithDescendants(categoryId)
  return sql`AND m.category_id IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )})`
}

function searchFilterClause(search: string | undefined) {
  if (!search?.trim()) return sql``
  const pattern = `%${search.trim()}%`
  const pathIds = categoryIdsMatchingPath(search)
  return sql`AND (
    m.name LIKE ${pattern} OR m.sku LIKE ${pattern}
    ${
      pathIds.length
        ? sql`OR m.category_id IN (${sql.join(
            pathIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        : sql``
    }
  )`
}

export interface MaterialValuationRow {
  materialId: number
  sku: string
  name: string
  categoryId: number
  categoryName: string
  unit: string
  qtyMicro: number
  /** BR-95 (1): actual value from FIFO purchase cost. */
  fifoValueMinor: number
  /** BR-95 (2): current estimated market value. Never blended with the above. */
  marketValueMinor: number
  currentMarketPriceMicro: number
}

/**
 * BR-95: inventory capital, reported as TWO separate figures per
 * material — actual FIFO cost value and current market value. They
 * are deliberately never summed together into a single number.
 */
export function materialValuation(filter: { categoryId?: number; search?: string } = {}) {
  const categoryIds = filter.categoryId ? categoryIdsWithDescendants(filter.categoryId) : []
  const rows = getDatabase().all<MaterialValuationRow>(sql`
    SELECT
      m.id AS materialId, m.sku, m.name, m.category_id AS categoryId,
      c.name AS categoryName, m.unit,
      COALESCE(stock.qty, 0) AS qtyMicro,
      CAST(ROUND(COALESCE(stock.fifo_value, 0)) AS INTEGER) AS fifoValueMinor,
      CAST(ROUND(
        (COALESCE(stock.qty, 0) / 1000000.0) * (m.current_market_price_micro / 1000.0)
      ) AS INTEGER) AS marketValueMinor,
      m.current_market_price_micro AS currentMarketPriceMicro
    FROM materials m
    JOIN material_categories c ON c.id = m.category_id
    LEFT JOIN (
      SELECT material_id,
             SUM(qty_remaining_micro) AS qty,
             SUM((CAST(qty_remaining_micro AS REAL) / 1000000.0) * (CAST(unit_cost_micro AS REAL) / 1000.0)) AS fifo_value
      FROM fifo_layers GROUP BY material_id
    ) stock ON stock.material_id = m.id
    WHERE 1 = 1
      ${
        filter.categoryId
          ? sql`AND m.category_id IN (${sql.join(
              categoryIds.map((id) => sql`${id}`),
              sql`, `
            )})`
          : sql``
      }
      ${searchFilterClause(filter.search)}
    ORDER BY c.name, m.name
  `)

  const byCategory = new Map<
    number,
    { categoryId: number; categoryName: string; fifoValueMinor: number; marketValueMinor: number }
  >()
  for (const row of rows) {
    const entry = byCategory.get(row.categoryId) ?? {
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      fifoValueMinor: 0,
      marketValueMinor: 0
    }
    entry.fifoValueMinor += row.fifoValueMinor
    entry.marketValueMinor += row.marketValueMinor
    byCategory.set(row.categoryId, entry)
  }

  return {
    materials: rows,
    byCategory: [...byCategory.values()],
    totals: {
      fifoValueMinor: rows.reduce((sum, row) => sum + row.fifoValueMinor, 0),
      marketValueMinor: rows.reduce((sum, row) => sum + row.marketValueMinor, 0)
    }
  }
}

/** Current physical stock per material, for pickers and stock screens. */
export function stockLevels(
  filter: { search?: string; categoryId?: number; lowOnly?: boolean } = {}
) {
  return getDatabase().all<{
    materialId: number
    sku: string
    name: string
    unit: string
    categoryName: string
    qtyMicro: number
    reorderLevelMicro: number
  }>(sql`
    SELECT m.id AS materialId, m.sku, m.name, m.unit, c.name AS categoryName,
           COALESCE((SELECT SUM(qty_remaining_micro) FROM fifo_layers f WHERE f.material_id = m.id), 0) AS qtyMicro,
           m.reorder_level_micro AS reorderLevelMicro
    FROM materials m
    JOIN material_categories c ON c.id = m.category_id
    WHERE m.active = 1
      ${categoryFilterClause(filter.categoryId)}
      ${searchFilterClause(filter.search)}
    ${filter.lowOnly ? sql`HAVING qtyMicro <= m.reorder_level_micro` : sql``}
    ORDER BY m.name
  `)
}
