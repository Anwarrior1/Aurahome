import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

/**
 * BR-66/BR-67: a user-created recursive category tree with explicit
 * semantics. The initial levels are generic rows, never names such
 * as Wood/MDF hard-coded into the schema; material types may nest further.
 */
export const materialCategories = sqliteTable(
  'material_categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    /**
     * Explicit business meaning. Inventory behaviour must never be inferred
     * from "currently has no children", because adding/moving a child would
     * silently change what the node represents.
     */
    nodeKind: text('node_kind', {
      enum: [
        'main_category',
        'material_family',
        'material_type',
        'inventory_leaf',
        'legacy_ambiguous'
      ]
    })
      .notNull()
      .default('legacy_ambiguous'),
    parentId: integer('parent_id').references((): AnySQLiteColumn => materialCategories.id, {
      onDelete: 'restrict'
    }),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Legacy invoice-selection compatibility. The current classification
     * workflow no longer exposes or assigns this marker, but existing rows
     * must retain it so old invoice behavior does not change. */
    isAccessory: integer('is_accessory', { mode: 'boolean' }).notNull().default(false),
    showInRawMaterials: integer('show_in_raw_materials', { mode: 'boolean' }).notNull().default(false),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    parentIdx: index('material_categories_parent_idx').on(t.parentId),
    nodeKindIdx: index('material_categories_node_kind_idx').on(t.nodeKind)
  })
)

/** BR-69: user-maintained Color / Finish Catalog. */
export const colorFinishCatalog = sqliteTable(
  'color_finish_catalog',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    relatedMaterialType: text('related_material_type'),
    relatedMaterialId: integer('related_material_id').references(
      (): AnySQLiteColumn => materials.id,
      { onDelete: 'set null' }
    ),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ activeIdx: index('color_finish_active_idx').on(t.active) })
)

/**
 * One unified raw-material inventory (BR-4/BR-67). Accessories and
 * components are rows here too, separated only by their category
 * (BR-50). Per-material rules live on the row (BR-13/BR-32/BR-34/BR-35).
 */
export const materials = sqliteTable(
  'materials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sku: text('sku').notNull().unique(),
    name: text('name').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => materialCategories.id),
    /**
     * Stable 1:1 identity for hierarchy-backed materials. New child
     * nodes use their own category row as both their recursive tree
     * position and this immutable material link. Legacy materials stay
     * null and keep their existing category assignment untouched.
     */
    hierarchyNodeId: integer('hierarchy_node_id').references(() => materialCategories.id, {
      onDelete: 'restrict'
    }),
    /** Renderer/IPC retry key for atomic child creation. Nullable keeps
     * all historical rows compatible; new hierarchy creations always
     * provide one and the unique index makes retries idempotent. */
    creationKey: text('creation_key'),
    /** Stable Color Catalog identity for a stockable coloured variant.
     * Null means an uncoloured/raw variant (and never a fake "خام" color). */
    colorId: integer('color_id').references((): AnySQLiteColumn => colorFinishCatalog.id, {
      onDelete: 'restrict'
    }),
    /** The BASE STOCK UNIT — what AURA home actually tracks inventory in
     *  (قطعة، لوح، متر، لتر…). Every quantity everywhere for this
     *  material (FIFO layers, movements, BOM lines, planned materials)
     *  is expressed in this unit. Never assumed to be a board. */
    unit: text('unit').notNull(),
    /**
     * BR-34 (item 7, refined): the material may optionally be PURCHASED
     * in a different commercial unit than it is stocked in. When
     * `purchaseUnit` is set, `purchaseUnitFactorMicro` says how many
     * base stock units one purchase unit contains (e.g. 1 علبة = 50
     * قطعة → 50, stored ×10^6 like every other quantity). When
     * `purchaseUnit` is null, the material is purchased in its own
     * stock unit and no conversion applies. This column was previously
     * named conversion_unit/conversion_factor_micro; it carried no live
     * data (nothing ever read it), so the rename in migration 0003 is
     * safe and gives the concept its real, single meaning.
     */
    purchaseUnit: text('purchase_unit'),
    purchaseUnitFactorMicro: integer('purchase_unit_factor_micro'),
    /** Item 8/9: dimensions/thickness are only asked for — and only
     *  required — when this is explicitly turned on for the material.
     *  Never inferred from its name or category. */
    tracksDimensions: integer('tracks_dimensions', { mode: 'boolean' }).notNull().default(false),
    dimensions: text('dimensions'),
    thickness: text('thickness'),
    /** BR-7: current market price, independent of purchase history. */
    currentMarketPriceMicro: integer('current_market_price_micro').notNull().default(0),
    /** BR-32: exact | full_unit | round_up | manual. */
    pricingRule: text('pricing_rule').notNull().default('full_unit'),
    /** Size of one full commercial unit, for full_unit / round_up rules. */
    commercialUnitSizeMicro: integer('commercial_unit_size_micro'),
    /**
     * Legacy databases still contain allows_remainder,
     * track_remainder_pieces, track_batches and supports_color. They are
     * intentionally omitted from the active Drizzle model: the obsolete
     * per-material tracking-settings feature no longer reads or writes
     * them. Keeping the physical columns avoids a risky SQLite table
     * rebuild and preserves migration compatibility.
     */
    reorderLevelMicro: integer('reorder_level_micro').notNull().default(0),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    categoryIdx: index('materials_category_idx').on(t.categoryId),
    nameIdx: index('materials_name_idx').on(t.name),
    hierarchyNodeUnique: uniqueIndex('materials_hierarchy_node_unique').on(t.hierarchyNodeId),
    creationKeyUnique: uniqueIndex('materials_creation_key_unique').on(t.creationKey),
    colorIdx: index('materials_color_idx').on(t.colorId)
  })
)
