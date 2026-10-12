import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { materials } from './catalog.schema'

/** BR-2: standard/repeatable products with a fully editable BOM. */
export const products = sqliteTable(
  'products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    defaultPriceMinor: integer('default_price_minor').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ nameIdx: index('products_name_idx').on(t.name) })
)

export const productBomLines = sqliteTable(
  'product_bom_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    materialId: integer('material_id')
      .notNull()
      .references(() => materials.id),
    qtyMicro: integer('qty_micro').notNull(),
    unit: text('unit').notNull(),
    dimensions: text('dimensions'),
    componentName: text('component_name'),
    /**
     * The unit price used to estimate this component's share of the
     * product's standard manufacturing cost. Nullable — when unset, the
     * estimate falls back to the material's own live current-market
     * price (`materials.current_market_price_micro`), which is exactly
     * the behavior every existing row already has, so this column adds
     * an override without changing any existing product's estimate.
     */
    unitPriceMicro: integer('unit_price_micro'),
    notes: text('notes')
  },
  (t) => ({ productIdx: index('product_bom_lines_product_idx').on(t.productId) })
)
