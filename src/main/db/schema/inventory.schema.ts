import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { materials } from './catalog.schema'

/**
 * BR-6: FIFO cost layers. One row per receipt of stock, consumed
 * oldest-first. `unitCostMicro` is LYD × 10^6 (AD-1) so a sheet's
 * per-m² cost never loses precision across many partial consumptions.
 */
export const fifoLayers = sqliteTable(
  'fifo_layers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    materialId: integer('material_id')
      .notNull()
      .references(() => materials.id),
    sourceKind: text('source_kind').notNull(), // purchase | adjustment | opening
    sourceRefId: integer('source_ref_id'),
    batchCode: text('batch_code'),
    qtyReceivedMicro: integer('qty_received_micro').notNull(),
    qtyRemainingMicro: integer('qty_remaining_micro').notNull(),
    unitCostMicro: integer('unit_cost_micro').notNull(),
    receivedAt: text('received_at').notNull(),
    seq: integer('seq').notNull(),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    fifoIdx: index('fifo_layers_material_order_idx').on(t.materialId, t.receivedAt, t.seq)
  })
)

/**
 * Append-only inventory ledger (Step 2 §6). Never UPDATEd, never
 * DELETEd — a correction is a new movement, so stock history is always
 * reproducible. `kind` distinguishes the three things BR-14 requires
 * the system to tell apart: consumption, reusable remainder, waste.
 */
export const inventoryMovements = sqliteTable(
  'inventory_movements',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    materialId: integer('material_id')
      .notNull()
      .references(() => materials.id),
    kind: text('kind').notNull(), // purchase | consumption | consumption_reversal | material_return | material_return_reversal | waste | adjustment_in | adjustment_out | sale
    qtyMicro: integer('qty_micro').notNull(),
    orderId: integer('order_id'),
    actualCostMinor: integer('actual_cost_minor').notNull().default(0),
    /** Stable business-source link used by safe correction flows. */
    sourceKind: text('source_kind'),
    sourceRefId: integer('source_ref_id'),
    /** Reversal movements are appended and point at the movement they undo. */
    reversalOfMovementId: integer('reversal_of_movement_id').references(
      (): AnySQLiteColumn => inventoryMovements.id
    ),
    reason: text('reason'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    materialIdx: index('inventory_movements_material_idx').on(t.materialId),
    orderIdx: index('inventory_movements_order_idx').on(t.orderId),
    kindDateIdx: index('inventory_movements_kind_date_idx').on(t.kind, t.createdAt),
    sourceIdx: index('inventory_movements_source_idx').on(t.sourceKind, t.sourceRefId),
    reversalIdx: index('inventory_movements_reversal_idx').on(t.reversalOfMovementId)
  })
)

/**
 * Append-only. Which FIFO layer paid for which part of a movement —
 * the actual cost of a consumption is the SUM of these rows, never a
 * recomputed average (BR-6).
 */
export const fifoAllocations = sqliteTable(
  'fifo_allocations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    movementId: integer('movement_id')
      .notNull()
      .references(() => inventoryMovements.id),
    layerId: integer('layer_id')
      .notNull()
      .references(() => fifoLayers.id),
    qtyMicro: integer('qty_micro').notNull(),
    unitCostMicro: integer('unit_cost_micro').notNull(),
    costMinor: integer('cost_minor').notNull()
  },
  (t) => ({ movementIdx: index('fifo_allocations_movement_idx').on(t.movementId) })
)

/**
 * BR-33: optional per-material tracking of individual reusable
 * remainder pieces. Materials without this enabled simply return
 * their remainder to the quantity pool (the layer's qtyRemaining).
 */
export const materialRemainders = sqliteTable(
  'material_remainders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    materialId: integer('material_id')
      .notNull()
      .references(() => materials.id),
    layerId: integer('layer_id').references(() => fifoLayers.id),
    sizeMicro: integer('size_micro').notNull(),
    sourceNote: text('source_note'),
    available: integer('available', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ materialIdx: index('material_remainders_material_idx').on(t.materialId, t.available) })
)
