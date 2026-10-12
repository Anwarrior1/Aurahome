import { sqliteTable, integer, text, index, uniqueIndex, foreignKey } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { orders, orderLines, finalInvoices, finalInvoiceLines } from './sales.schema'
import { workSheets } from './production.schema'
import { materials, colorFinishCatalog } from './catalog.schema'

/**
 * "المنتجات غير المستلمة" — a PHYSICAL manufactured product that was
 * actually produced for a Customer Order the customer then abandoned.
 *
 * One row is ONE physical product, not one order: an order that
 * manufactured three independent items produces three rows, each
 * independently sellable. The Customer Order itself never moves here —
 * it retains its history and can resume when its original customer returns.
 *
 * Everything customer-facing is FROZEN at transfer time (the wording
 * columns here and the three child tables), so a later catalog rename
 * can never rewrite what was physically built. Catalog ids are kept
 * beside the frozen wording for traceability only, and are cleared
 * rather than cascaded when a catalog row is deleted.
 */
export const uncollectedProducts = sqliteTable(
  'uncollected_products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    // ---- where the physical product came from -----------------------
    sourceOrderId: integer('source_order_id')
      .notNull()
      .references(() => orders.id),
    /** Frozen: the order number as it read at transfer. */
    sourceOrderNumber: text('source_order_number').notNull(),
    /**
     * The specific order item this physical product IS. UNIQUE — the
     * database itself guarantees one manufactured item can never be
     * transferred twice, however often cancellation is retried or
     * double-clicked.
     */
    sourceOrderLineId: integer('source_order_line_id')
      .notNull()
      .references(() => orderLines.id),
    sourceInvoiceId: integer('source_invoice_id').references(() => finalInvoices.id),
    sourceInvoiceLineId: integer('source_invoice_line_id').references(() => finalInvoiceLines.id),
    /** The manufacturing order that actually produced it, when known. */
    sourceWorkSheetId: integer('source_work_sheet_id').references(() => workSheets.id),
    sourceWorkSheetNumber: text('source_work_sheet_number'),

    // ---- the frozen manufactured specification ----------------------
    name: text('name').notNull(),
    description: text('description'),
    specifications: text('specifications'),
    dimensions: text('dimensions'),
    quantityMicro: integer('quantity_micro').notNull().default(0),

    // ---- what the original customer had been charged ----------------
    originalUnitPriceMinor: integer('original_unit_price_minor').notNull().default(0),
    originalLineTotalMinor: integer('original_line_total_minor').notNull().default(0),

    // ---- internal cost basis carried by the physical asset ----------
    /**
     * The actual cost attributable to THIS physical product, taken from
     * the order's authoritative actual-costing breakdown.
     *
     * `costBasisMethod` records how it was derived so the figure is
     * auditable rather than a guess:
     *   sole_manufactured_item — the order produced exactly one item,
     *       so the whole actual order cost belongs to it;
     *   relative_sales_value  — several items, split by each item's
     *       share of the manufactured items' own selling value (a
     *       deterministic allocation, never an equal division), with
     *       the rounding remainder assigned largest-share-first so the
     *       parts add back to the order total exactly;
     *   unattributable        — the allocation basis was degenerate
     *       (no selling value at all), so nothing is claimed.
     */
    costBasisMinor: integer('cost_basis_minor').notNull().default(0),
    costBasisMethod: text('cost_basis_method').notNull(),
    /** The order-level actual-cost components this basis was drawn from. */
    costBasisOrderTotalMinor: integer('cost_basis_order_total_minor').notNull().default(0),
    costBasisMaterialMinor: integer('cost_basis_material_minor').notNull().default(0),
    costBasisMachineMinor: integer('cost_basis_machine_minor').notNull().default(0),
    costBasisWorkerMinor: integer('cost_basis_worker_minor').notNull().default(0),
    costBasisDeliveryMinor: integer('cost_basis_delivery_minor').notNull().default(0),
    costBasisExpenseMinor: integer('cost_basis_expense_minor').notNull().default(0),

    // ---- resale lifecycle -------------------------------------------
    /** available | reserved | sold | resumed */
    status: text('status').notNull().default('available'),
    resumedAt: text('resumed_at'),
    resumedBy: integer('resumed_by'),
    resumeRequestKey: text('resume_request_key'),
    transferredAt: text('transferred_at').notNull(),
    transferredBy: integer('transferred_by'),
    /** Why the source order was cancelled, frozen for traceability. */
    cancelReason: text('cancel_reason'),
    /** Set while attached to a draft invoice, cleared if detached. */
    reservedInvoiceId: integer('reserved_invoice_id').references(() => finalInvoices.id),
    soldInvoiceId: integer('sold_invoice_id').references(() => finalInvoices.id),
    soldOrderId: integer('sold_order_id').references(() => orders.id),
    soldAt: text('sold_at'),
    soldPriceMinor: integer('sold_price_minor'),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    /** One physical item transfers exactly once — enforced by the DB. */
    resumeRequestUnique: uniqueIndex('uncollected_products_resume_request_uq').on(t.resumeRequestKey),
    sourceLineUnique: uniqueIndex('uncollected_products_source_line_uq').on(t.sourceOrderLineId),
    sourceOrderIdx: index('uncollected_products_source_order_idx').on(t.sourceOrderId),
    statusIdx: index('uncollected_products_status_idx').on(t.status),
    soldInvoiceIdx: index('uncollected_products_sold_invoice_idx').on(t.soldInvoiceId)
  })
)

/**
 * The materials the physical product was actually built from, frozen.
 * Mirrors the `*_line_materials` shape already used by the commercial
 * documents, so the same grouped Material → Colours presentation works
 * unchanged.
 */
export const uncollectedProductMaterials = sqliteTable(
  'uncollected_product_materials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => uncollectedProducts.id, { onDelete: 'cascade' }),
    materialId: integer('material_id').references(() => materials.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    nameSnapshot: text('name_snapshot').notNull()
  },
  (t) => ({
    ownerUnique: uniqueIndex('uncollected_product_materials_owner_uq').on(t.id, t.productId),
    positionUnique: uniqueIndex('uncollected_product_materials_position_uq').on(
      t.productId,
      t.position
    )
  })
)

/** Colours/finishes, grouped under the material selection they belong to. */
export const uncollectedProductColors = sqliteTable(
  'uncollected_product_colors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => uncollectedProducts.id, { onDelete: 'cascade' }),
    materialSelectionId: integer('material_selection_id'),
    colorId: integer('color_id').references(() => colorFinishCatalog.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    codeSnapshot: text('code_snapshot').notNull(),
    nameSnapshot: text('name_snapshot')
  },
  (t) => ({
    materialOwnerFk: foreignKey({
      columns: [t.materialSelectionId, t.productId],
      foreignColumns: [uncollectedProductMaterials.id, uncollectedProductMaterials.productId]
    }).onDelete('cascade'),
    positionUnique: uniqueIndex('uncollected_product_colors_position_uq').on(t.productId, t.position)
  })
)

export const uncollectedProductAccessories = sqliteTable(
  'uncollected_product_accessories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => uncollectedProducts.id, { onDelete: 'cascade' }),
    materialId: integer('material_id').references(() => materials.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    nameSnapshot: text('name_snapshot').notNull()
  },
  (t) => ({
    positionUnique: uniqueIndex('uncollected_product_accessories_position_uq').on(
      t.productId,
      t.position
    )
  })
)
