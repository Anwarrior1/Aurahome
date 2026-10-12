import { sqliteTable, integer, text, index, primaryKey, uniqueIndex, check } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { orders, orderLines, quotations } from './sales.schema'
import { materials } from './catalog.schema'
import { products } from './products.schema'
import { fifoAllocations, fifoLayers, inventoryMovements } from './inventory.schema'

/** BR-36/BR-89: machine register, each with its own user-defined costing unit. */
export const machines = sqliteTable('machines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  costingUnit: text('costing_unit').notNull(), // cut | board | meter | m2 | piece | hour | user-defined
  defaultRateMicro: integer('default_rate_micro').notNull().default(0),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

/**
 * Product Components — "الآلات" tab: the STANDARD machine configuration
 * for manufacturing one unit of a product. Reuses the existing machine
 * register (never a duplicate master) and is planning/template data
 * only — it never deducts from inventory and never itself posts an
 * actual machine cost. Actual cost still comes solely from
 * `order_machine_usage`, recorded during real production.
 */
export const productMachineLines = sqliteTable(
  'product_machine_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    machineId: integer('machine_id')
      .notNull()
      .references(() => machines.id),
    /** Standard usage to produce ONE unit of the product. */
    usageQtyMicro: integer('usage_qty_micro').notNull(),
    /** Overrides the machine's own default rate for this product; falls
     *  back to machines.defaultRateMicro when null. */
    rateMicro: integer('rate_micro'),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ productIdx: index('product_machine_lines_product_idx').on(t.productId) })
)

/**
 * Product Components — "عمولة العامل" tab: the STANDARD worker
 * commission rule for manufacturing one unit of a product. This is a
 * template amount only — saving it creates no payable commission and
 * no financial transaction. A commission becomes real and payable
 * exclusively through the existing `assignWorkerToOrder` action during
 * production, and lands on the worker's balance only at the existing
 * completion/earning event (BR-108) — unchanged by this table.
 */
export const productCommissionLines = sqliteTable(
  'product_commission_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Optional suggested worker for this role; null = not yet assigned
     *  to a specific worker (the amount still stands as the standard). */
    workerId: integer('worker_id').references(() => workers.id),
    /** Standard commission to produce ONE unit of the product. */
    amountMinor: integer('amount_minor').notNull(),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ productIdx: index('product_commission_lines_product_idx').on(t.productId) })
)

/** BR-84: production workers — a separate concept from salaried employees. */
export const workers = sqliteTable('workers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  phone: text('phone'),
  /** BR-86: an optional default/reference rate; always overridable per order. */
  defaultMethod: text('default_method').notNull().default('fixed'), // fixed | percent
  defaultCostingUnit: text('default_costing_unit'),
  defaultRateMicro: integer('default_rate_micro'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

/**
 * Append-only worker ledger (BR-85/BR-108). Balance =
 * earnings from completed orders − withdrawals + repayments.
 */
export const workerTransactions = sqliteTable(
  'worker_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workerId: integer('worker_id')
      .notNull()
      .references(() => workers.id),
    kind: text('kind').notNull(), // earning | adjustment | commission_payment (payable) — withdrawal | repayment (worker debt)
    amountMinor: integer('amount_minor').notNull(),
    orderId: integer('order_id').references(() => orders.id),
    reversalOfTransactionId: integer('reversal_of_transaction_id').references((): AnySQLiteColumn => workerTransactions.id),
    /** CC04: the labour assignment a manufacturing-completion earning recognises (one earning per assignment). */
    assignmentId: integer('assignment_id').references((): AnySQLiteColumn => orderWorkerAssignments.id),
    cashAccountId: integer('cash_account_id'),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ workerIdx: index('worker_transactions_worker_idx').on(t.workerId, t.createdAt), reversalIdx: uniqueIndex('worker_transactions_reversal_unique').on(t.reversalOfTransactionId).where(sql`${t.reversalOfTransactionId} IS NOT NULL`), assignmentEarningIdx: uniqueIndex('worker_transactions_assignment_earning_unique').on(t.assignmentId).where(sql`${t.assignmentId} IS NOT NULL`) })
)

/**
 * BR-90: machine usage on one order. The calculated amount
 * (usage × rate) stays editable, and `finalAmountMinor` — the edited
 * value — is what feeds the order's actual cost.
 */
export const orderMachineUsage = sqliteTable(
  'order_machine_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Nullable since the production-order pass: a stock production
     *  order has no customer order behind it. Customer production keeps
     *  this set, so order costing/traceability is unchanged. */
    orderId: integer('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    /** The production order the usage was recorded under (BR-90 evolved). */
    workSheetId: integer('work_sheet_id').references(() => workSheets.id),
    machineId: integer('machine_id')
      .notNull()
      .references(() => machines.id),
    usageQtyMicro: integer('usage_qty_micro').notNull(),
    rateMicro: integer('rate_micro').notNull(),
    calculatedMinor: integer('calculated_minor').notNull(),
    finalAmountMinor: integer('final_amount_minor').notNull(),
    reversedAt: text('reversed_at'),
    reversedBy: integer('reversed_by'),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    orderIdx: index('order_machine_usage_order_idx').on(t.orderId),
    sheetIdx: index('order_machine_usage_sheet_idx').on(t.workSheetId)
  })
)

/**
 * BR-86/BR-107: per-worker, per-order compensation. Method is fixed
 * or percent; a percent carries the user-chosen calculation base.
 * `earned` flips true only when the order completes (BR-108).
 */
export const orderWorkerAssignments = sqliteTable(
  'order_worker_assignments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Nullable since the production-order pass — a stock production
     *  order carries labour with no customer order behind it. */
    orderId: integer('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    /** The production order the labour belongs to (item 14). */
    workSheetId: integer('work_sheet_id').references(() => workSheets.id),
    workerId: integer('worker_id')
      .notNull()
      .references(() => workers.id),
    method: text('method').notNull(), // fixed | percent
    percentBp: integer('percent_bp'),
    /** total_after_discount | subtotal_before_discount | manual | line */
    baseKind: text('base_kind'),
    baseAmountMinor: integer('base_amount_minor'),
    orderLineId: integer('order_line_id').references(() => orderLines.id),
    amountMinor: integer('amount_minor').notNull(),
    earned: integer('earned', { mode: 'boolean' }).notNull().default(false),
    earnedAt: text('earned_at'),
    reversedAt: text('reversed_at'),
    reversedBy: integer('reversed_by'),
    notes: text('notes')
  },
  (t) => ({
    orderIdx: index('order_worker_assignments_order_idx').on(t.orderId),
    sheetIdx: index('order_worker_assignments_sheet_idx').on(t.workSheetId)
  })
)

/**
 * BR-12: the three values kept structurally separate — physical
 * quantity consumed, its actual FIFO cost, and the independent
 * commercial quantity/value charged to the customer.
 */
export const orderMaterialLines = sqliteTable(
  'order_material_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Nullable since the production-order pass: stock production
     *  consumes material against a production order with no customer
     *  order. Customer production still always sets it (BR-12/BR-19). */
    orderId: integer('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    /** Item 12: consumption now belongs operationally to the production
     *  order. Existing historical rows keep NULL here and stay valid. */
    workSheetId: integer('work_sheet_id').references(() => workSheets.id),
    materialId: integer('material_id')
      .notNull()
      .references(() => materials.id),
    movementId: integer('movement_id').references(() => inventoryMovements.id),
    physicalQtyMicro: integer('physical_qty_micro').notNull(),
    actualCostMinor: integer('actual_cost_minor').notNull(),
    commercialQtyMicro: integer('commercial_qty_micro').notNull(),
    commercialValueMinor: integer('commercial_value_minor').notNull(),
    pricingRuleUsed: text('pricing_rule_used').notNull(),
    colorCode: text('color_code'),
    notes: text('notes'),
    /** Corrections preserve the original row and post a FIFO reversal. */
    status: text('status').notNull().default('active'), // active | reversed
    reversedAt: text('reversed_at'),
    reversedBy: integer('reversed_by'),
    reversalMovementId: integer('reversal_movement_id').references(() => inventoryMovements.id),
    replacementLineId: integer('replacement_line_id').references(
      (): AnySQLiteColumn => orderMaterialLines.id
    ),
    correctionOfLineId: integer('correction_of_line_id').references(
      (): AnySQLiteColumn => orderMaterialLines.id
    ),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    orderIdx: index('order_material_lines_order_idx').on(t.orderId),
    sheetIdx: index('order_material_lines_sheet_idx').on(t.workSheetId)
  })
)

/**
 * One user-facing raw-material return transaction for a customer order.
 *
 * The issued `order_material_lines` row is never rewritten. This row keeps
 * only the current active projection (quantity/cost/version); every change
 * that produced it is preserved append-only in `material_return_events`.
 * Deletion is a void, never a physical delete.
 */
export const materialReturns = sqliteTable(
  'material_returns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id').notNull().references(() => orders.id),
    materialId: integer('material_id').notNull().references(() => materials.id),
    quantityMicro: integer('quantity_micro').notNull(),
    returnedCostMinor: integer('returned_cost_minor').notNull(),
    status: text('status').notNull().default('active'), // active | voided
    notes: text('notes'),
    version: integer('version').notNull().default(1),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedBy: integer('updated_by'),
    updatedAt: text('updated_at'),
    voidedBy: integer('voided_by'),
    voidedAt: text('voided_at')
  },
  (t) => ({
    orderIdx: index('material_returns_order_idx').on(t.orderId, t.status),
    materialIdx: index('material_returns_material_idx').on(t.materialId, t.status)
  })
)

/**
 * Immutable event/version stream for return create, quantity edit and void.
 * `requestKey` is the idempotency boundary for repeated IPC submissions.
 * A positive cost effect reduces order cost; a negative one restores it.
 */
export const materialReturnEvents = sqliteTable(
  'material_return_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    returnId: integer('return_id').notNull().references(() => materialReturns.id),
    kind: text('kind').notNull(), // create | edit | reverse
    beforeQtyMicro: integer('before_qty_micro').notNull(),
    afterQtyMicro: integer('after_qty_micro').notNull(),
    deltaQtyMicro: integer('delta_qty_micro').notNull(),
    costEffectMinor: integer('cost_effect_minor').notNull(),
    movementId: integer('movement_id').references(() => inventoryMovements.id),
    requestKey: text('request_key').notNull().unique(),
    expectedVersion: integer('expected_version').notNull(),
    notesBefore: text('notes_before'),
    notesAfter: text('notes_after'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ returnIdx: index('material_return_events_return_idx').on(t.returnId, t.id) })
)

/**
 * Exact frozen-cost attribution for every return delta. Positive rows restore
 * quantities originally paid for by one FIFO allocation into a dedicated
 * return layer; negative rows remove that same historical cost basis again.
 */
export const materialReturnAllocations = sqliteTable(
  'material_return_allocations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id').notNull().references(() => materialReturnEvents.id),
    returnId: integer('return_id').notNull().references(() => materialReturns.id),
    issueLineId: integer('issue_line_id').notNull().references(() => orderMaterialLines.id),
    fifoAllocationId: integer('fifo_allocation_id').notNull().references(() => fifoAllocations.id),
    returnLayerId: integer('return_layer_id').notNull().references(() => fifoLayers.id),
    qtyMicro: integer('qty_micro').notNull(),
    unitCostMicro: integer('unit_cost_micro').notNull(),
    costMinor: integer('cost_minor').notNull(),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    returnIdx: index('material_return_allocations_return_idx').on(t.returnId, t.id),
    issueIdx: index('material_return_allocations_issue_idx').on(t.issueLineId),
    fifoIdx: index('material_return_allocations_fifo_idx').on(t.fifoAllocationId),
    layerIdx: index('material_return_allocations_layer_idx').on(t.returnLayerId)
  })
)

/**
 * BR-16/BR-64/BR-88 — the Manufacturing Work Sheet, evolved into the
 * real Production Order ("أمر تصنيع") by the production-workflow pass.
 *
 * It is still the same table and still the same UI name, so every
 * existing row, document number and order link stays valid. What it
 * gained is an operational lifecycle (`status` + timestamps), its own
 * stage list (`work_sheet_stages`), and the ability to exist WITHOUT a
 * customer order — a stock production run for a standard product,
 * which sets `productId`/`quantityMicro` instead of `orderId`.
 */
export const workSheets = sqliteTable(
  'work_sheets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentNumber: text('document_number').notNull().unique(),
    /** Customer production sets this; stock production leaves it NULL. */
    orderId: integer('order_id').references(() => orders.id),
    /** Stock production sets these two instead (item 18). */
    productId: integer('product_id').references(() => products.id),
    quantityMicro: integer('quantity_micro').notNull().default(0),
    /** draft | ready | in_production | completed | cancelled (item 9). */
    status: text('status').notNull().default('draft'),
    issuedAt: text('issued_at').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    cancelledAt: text('cancelled_at'),
    cancelReason: text('cancel_reason'),
    reversedAt: text('reversed_at'),
    reversedBy: integer('reversed_by'),
    documentSnapshot: text('document_snapshot'),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    orderIdx: index('work_sheets_order_idx').on(t.orderId),
    statusIdx: index('work_sheets_status_idx').on(t.status),
    productIdx: index('work_sheets_product_idx').on(t.productId)
  })
)

/**
 * The PLANNED material requirement — what we expect the factory to use.
 *
 * Deliberately distinct from actual consumption (`order_material_lines`,
 * which is FIFO-costed and leaves real stock). A planned row is a
 * frozen snapshot that flows forward and is re-frozen at each step:
 *
 *   quotation (internal costing) → order (at conversion)
 *                               → work sheet (at issuance)
 *
 * Exactly one of the three parents is set. Copying rather than
 * re-pointing is what lets the factory adjust 12 boards to 13 without
 * ever rewriting the approved preliminary invoice.
 *
 * `estimatedUnitCostMicro`/`estimatedTotalMinor` are INTERNAL: they
 * feed the quotation's operating-cost estimate and never appear on a
 * customer document or on the factory print.
 */
export const plannedMaterials = sqliteTable(
  'planned_materials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    quotationId: integer('quotation_id').references(() => quotations.id, { onDelete: 'cascade' }),
    orderId: integer('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    workSheetId: integer('work_sheet_id').references(() => workSheets.id, { onDelete: 'cascade' }),
    /** Links to the raw-material master when chosen from it (never a copy of it). */
    materialId: integer('material_id').references(() => materials.id),
    /** Snapshot of the name, so a later master rename cannot rewrite history. */
    materialName: text('material_name').notNull(),
    qtyMicro: integer('qty_micro').notNull(),
    unit: text('unit'),
    dimensions: text('dimensions'),
    thickness: text('thickness'),
    colorCode: text('color_code'),
    notes: text('notes'),
    estimatedUnitCostMicro: integer('estimated_unit_cost_micro').notNull().default(0),
    estimatedTotalMinor: integer('estimated_total_minor').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    quotationIdx: index('planned_materials_quotation_idx').on(t.quotationId),
    orderIdx: index('planned_materials_order_idx').on(t.orderId),
    sheetIdx: index('planned_materials_sheet_idx').on(t.workSheetId)
  })
)

/** Expected machine usage, priced at quotation time (internal only). */
export const plannedMachines = sqliteTable(
  'planned_machines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    quotationId: integer('quotation_id').references(() => quotations.id, { onDelete: 'cascade' }),
    orderId: integer('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    /**
     * The production order this planned machine was snapshotted onto.
     * planned_materials has carried this since 0002; machines did not,
     * which is why the factory print had no way to list them. Same
     * three-scope shape now: quotation → order → work sheet.
     */
    workSheetId: integer('work_sheet_id').references(() => workSheets.id, { onDelete: 'cascade' }),
    machineId: integer('machine_id').references(() => machines.id),
    machineName: text('machine_name').notNull(),
    usageQtyMicro: integer('usage_qty_micro').notNull().default(0),
    usageUnit: text('usage_unit'),
    /** Frozen unit rate used to calculate this planning line. Null is
     *  reserved for legacy rows whose historical manual total cannot be
     *  reconstructed safely. */
    rateMicro: integer('rate_micro'),
    estimatedCostMinor: integer('estimated_cost_minor').notNull().default(0),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    quotationIdx: index('planned_machines_quotation_idx').on(t.quotationId),
    orderIdx: index('planned_machines_order_idx').on(t.orderId),
    sheetIdx: index('planned_machines_sheet_idx').on(t.workSheetId)
  })
)

/** Expected worker entitlement, estimated at quotation time (internal only). */
export const plannedWorkers = sqliteTable(
  'planned_workers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    quotationId: integer('quotation_id').references(() => quotations.id, { onDelete: 'cascade' }),
    orderId: integer('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    /** The production order this planned commission was snapshotted
     *  onto — the same three-scope shape planned_materials/
     *  planned_machines already carry (quotation → order → work sheet). */
    workSheetId: integer('work_sheet_id').references(() => workSheets.id, { onDelete: 'cascade' }),
    workerId: integer('worker_id').references(() => workers.id),
    workerName: text('worker_name').notNull(),
    /** Legacy rows default to estimated. Meter mode derives the stored
     *  line total from meterRateMicro × meterQtyMicro server-side. */
    commissionMode: text('commission_mode').notNull().default('estimated'), // estimated | meter
    meterRateMicro: integer('meter_rate_micro'),
    meterQtyMicro: integer('meter_qty_micro'),
    estimatedCostMinor: integer('estimated_cost_minor').notNull().default(0),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    quotationIdx: index('planned_workers_quotation_idx').on(t.quotationId),
    orderIdx: index('planned_workers_order_idx').on(t.orderId),
    sheetIdx: index('planned_workers_sheet_idx').on(t.workSheetId)
  })
)

/**
 * Internal order-costing lines. They are planning data only: inserting
 * one never creates an expense-ledger row, cash movement, supplier
 * payable, or inventory movement. The work-sheet parent carries the
 * same frozen-at-issuance snapshot pattern as the other planned lines.
 */
export const plannedOrderExpenses = sqliteTable(
  'planned_order_expenses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    workSheetId: integer('work_sheet_id').references(() => workSheets.id, { onDelete: 'cascade' }),
    expenseName: text('expense_name').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    orderIdx: index('planned_order_expenses_order_idx').on(t.orderId),
    sheetIdx: index('planned_order_expenses_sheet_idx').on(t.workSheetId)
  })
)

/**
 * Item 18/19: append-only finished-goods ledger for standard products.
 * A completed stock production order posts `production_in`; fulfilling a
 * customer order from stock posts `sale_out`. On-hand = SUM(in) − SUM(out),
 * derived, never a stored mutable counter.
 */
export const finishedGoodsMovements = sqliteTable(
  'finished_goods_movements',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    kind: text('kind').notNull(), // production_in | sale_out | adjustment_in | adjustment_out | sale_reversal
    qtyMicro: integer('qty_micro').notNull(),
    /** Unit and total ACTUAL production cost carried with the goods. */
    unitCostMinor: integer('unit_cost_minor').notNull().default(0),
    totalCostMinor: integer('total_cost_minor').notNull().default(0),
    workSheetId: integer('work_sheet_id').references(() => workSheets.id),
    orderId: integer('order_id').references(() => orders.id),
    reversalOfMovementId: integer('reversal_of_movement_id').references(
      (): AnySQLiteColumn => finishedGoodsMovements.id
    ),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    productIdx: index('finished_goods_movements_product_idx').on(t.productId),
    orderIdx: index('finished_goods_movements_order_idx').on(t.orderId),
    reversalIdx: uniqueIndex('finished_goods_movements_reversal_unique')
      .on(t.reversalOfMovementId)
      .where(sql`${t.reversalOfMovementId} IS NOT NULL`)
  })
)

/**
 * DB-02 prospective valuation boundary. Historical issue rows remain immutable;
 * this records the quantity/value reconstructed under moving weighted average
 * through a fixed movement id. Later movements carry authoritative posted cost.
 */
export const finishedGoodsValuationCutovers = sqliteTable(
  'finished_goods_valuation_cutovers',
  {
    productId: integer('product_id')
      .primaryKey()
      .references(() => products.id),
    movementIdThrough: integer('movement_id_through').notNull(),
    openingQtyMicro: integer('opening_qty_micro').notNull(),
    openingValueMinor: integer('opening_value_minor').notNull(),
    status: text('status').notNull(), // ready | blocked
    classification: text('classification').notNull(), // unaffected | provably_affected | potentially_affected
    affectedMovementCount: integer('affected_movement_count').notNull().default(0),
    historicalCogsDeltaMinor: integer('historical_cogs_delta_minor').notNull().default(0),
    evidence: text('evidence').notNull(),
    createdAt: text('created_at').notNull()
  },
  (t) => ({
    statusCheck: check(
      'finished_goods_valuation_cutovers_status_check',
      sql`${t.status} IN ('ready', 'blocked')`
    ),
    classificationCheck: check(
      'finished_goods_valuation_cutovers_classification_check',
      sql`${t.classification} IN ('unaffected', 'provably_affected', 'potentially_affected')`
    ),
    quantityCheck: check(
      'finished_goods_valuation_cutovers_quantity_check',
      sql`${t.openingQtyMicro} >= 0`
    ),
    valueCheck: check(
      'finished_goods_valuation_cutovers_value_check',
      sql`${t.openingValueMinor} >= 0`
    )
  })
)

export const workSheetWorkers = sqliteTable(
  'work_sheet_workers',
  {
    workSheetId: integer('work_sheet_id')
      .notNull()
      .references(() => workSheets.id, { onDelete: 'cascade' }),
    workerId: integer('worker_id')
      .notNull()
      .references(() => workers.id)
  },
  (t) => ({ pk: primaryKey({ columns: [t.workSheetId, t.workerId] }) })
)

/**
 * BR-83/BR-112: Exit Permits for handover, installation, transport and
 * combined transport/installation. Normal issuance is gated at 100%
 * payment. Installation-bearing permits may carry an explicit,
 * permission-controlled unpaid override.
 */
export const releases = sqliteTable(
  'releases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentNumber: text('document_number').notNull().unique(),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id),
    // `delivery` remains the historical handover value. `transport` and
    // the combined kind complete the four Exit Permit business operations.
    kind: text('kind').notNull(), // delivery | installation | transport | delivery_installation
    authorizedAt: text('authorized_at').notNull(),
    status: text('status').notNull().default('active'),
    reversedAt: text('reversed_at'),
    reversedBy: integer('reversed_by'),
    documentSnapshot: text('document_snapshot'),
    address: text('address'),
    notes: text('notes'),
    // Print-only option. A missing/null value on a legacy row keeps the
    // historical behaviour (the paid notice is visible).
    showPaidExitSentence: integer('show_paid_exit_sentence', { mode: 'boolean' }).default(true),
    // Immutable issuance snapshot. Null means a legacy permit created
    // before authorised-unpaid releases existed; never infer override
    // status for such a row.
    authorizationType: text('authorization_type'), // fully_paid | unpaid | historical unpaid_override
    orderTotalMinorAtIssue: integer('order_total_minor_at_issue'),
    paidMinorAtIssue: integer('paid_minor_at_issue'),
    remainingMinorAtIssue: integer('remaining_minor_at_issue'),
    unpaidOverrideReason: text('unpaid_override_reason'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ orderIdx: index('releases_order_idx').on(t.orderId) })
)

export const releaseWorkers = sqliteTable(
  'release_workers',
  {
    releaseId: integer('release_id')
      .notNull()
      .references(() => releases.id, { onDelete: 'cascade' }),
    workerId: integer('worker_id')
      .notNull()
      .references(() => workers.id)
  },
  (t) => ({ pk: primaryKey({ columns: [t.releaseId, t.workerId] }) })
)

/**
 * BR-60/BR-106: delivery and installation records. Recording one is
 * what completes an order for profit-recognition purposes.
 */
export const deliveries = sqliteTable(
  'deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id),
    kind: text('kind').notNull(), // delivery | installation | delivery_installation | handover
    /** Item 23/27: which exit permit authorised this movement. */
    releaseId: integer('release_id').references(() => releases.id),
    scheduledAt: text('scheduled_at'),
    recordedAt: text('recorded_at'),
    address: text('address'),
    /** BR-60: the internal actual cost, separate from any charged line. */
    actualCostMinor: integer('actual_cost_minor').notNull().default(0),
    /** Item 37: real-world events are never deleted, only voided. */
    status: text('status').notNull().default('recorded'), // recorded | cancelled
    cancelledAt: text('cancelled_at'),
    cancelReason: text('cancel_reason'),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    orderIdx: index('deliveries_order_idx').on(t.orderId),
    releaseIdx: index('deliveries_release_idx').on(t.releaseId)
  })
)

/** Item 26: the crew that carried out a delivery/installation event. */
export const deliveryWorkers = sqliteTable(
  'delivery_workers',
  {
    deliveryId: integer('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    workerId: integer('worker_id')
      .notNull()
      .references(() => workers.id)
  },
  (t) => ({ pk: primaryKey({ columns: [t.deliveryId, t.workerId] }) })
)
