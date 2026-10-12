import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { materials } from './catalog.schema'
import { orders } from './sales.schema'

export const customers = sqliteTable(
  'customers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    phone: text('phone'),
    address: text('address'),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ nameIdx: index('customers_name_idx').on(t.name), lifecycleIdx: index('customers_lifecycle_name_idx').on(t.active, t.name) })
)

export const suppliers = sqliteTable(
  'suppliers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    phone: text('phone'),
    address: text('address'),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ nameIdx: index('suppliers_name_idx').on(t.name) })
)

/** BR-22: purchases raise stock and preserve historical cost forever. */
export const purchases = sqliteTable(
  'purchases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentNumber: text('document_number').notNull().unique(),
    supplierId: integer('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    /** Optional job attribution only. Purchases still enter raw stock;
     *  they never create or satisfy production-planning rows. */
    customerOrderId: integer('customer_order_id').references(() => orders.id),
    purchaseDate: text('purchase_date').notNull(),
    totalMinor: integer('total_minor').notNull(),
    paidMinor: integer('paid_minor').notNull().default(0),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    supplierIdx: index('purchases_supplier_idx').on(t.supplierId),
    customerOrderIdx: index('purchases_customer_order_idx').on(t.customerOrderId),
    dateIdx: index('purchases_date_idx').on(t.purchaseDate)
  })
)

export const purchaseLines = sqliteTable(
  'purchase_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    purchaseId: integer('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'cascade' }),
    materialId: integer('material_id')
      .notNull()
      .references(() => materials.id),
    qtyMicro: integer('qty_micro').notNull(),
    unitCostMicro: integer('unit_cost_micro').notNull(),
    lineTotalMinor: integer('line_total_minor').notNull(),
    batchCode: text('batch_code')
  },
  (t) => ({ purchaseIdx: index('purchase_lines_purchase_idx').on(t.purchaseId) })
)

/**
 * Supplier payment source rows (BR-22). Explicit payment correction may
 * update/delete one row together with its paired cash movement, atomically
 * and with immutable audit events; ordinary workflows never rewrite it.
 */
export const supplierPayments = sqliteTable(
  'supplier_payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    supplierId: integer('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    purchaseId: integer('purchase_id').references(() => purchases.id),
    amountMinor: integer('amount_minor').notNull(),
    cashAccountId: integer('cash_account_id'),
    paidAt: text('paid_at').notNull(),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ supplierIdx: index('supplier_payments_supplier_idx').on(t.supplierId) })
)
