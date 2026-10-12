import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { customers } from './parties.schema'
import { products } from './products.schema'
import { materials } from './catalog.schema'

/**
 * BR-71: the customer-facing Preliminary Invoice.
 *
 * Workflow pass: this document is now COMPLETELY INDEPENDENT. It is a
 * commercial document prepared for and sent to the customer, and it is
 * no longer the start of the operational workflow — it creates no
 * order, no approved invoice, and no production of any kind. Its
 * lifecycle is draft → issued → cancelled.
 *
 * The internal cost-estimate columns below are RETAINED for the rows
 * that were created under the old workflow (they are real history and
 * are still readable), but nothing writes them any more: internal
 * manufacturing costing now belongs to the Customer Order.
 */
export const quotations = sqliteTable(
  'quotations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentNumber: text('document_number').notNull().unique(),
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id),
    /**
     * draft | issued | cancelled.
     *
     * `approved`, `converted` and `expired` are LEGACY values kept on
     * rows created before the workflow pass; they still read correctly
     * everywhere and keep their link to the order they produced.
     */
    status: text('status').notNull().default('draft'),
    issuedAt: text('issued_at'),
    /** Customer identity frozen at issue; legacy issued documents are backfilled once. */
    customerSnapshot: text('customer_snapshot'),
    /** BR-44/BR-75: the validity window shown to the customer. */
    validUntil: text('valid_until'),
    subtotalMinor: integer('subtotal_minor').notNull().default(0),
    discountKind: text('discount_kind').notNull().default('none'), // none|amount|percent
    discountValue: integer('discount_value').notNull().default(0),
    discountMinor: integer('discount_minor').notNull().default(0),
    totalMinor: integer('total_minor').notNull().default(0),
    depositPercentBp: integer('deposit_percent_bp').notNull().default(6000),
    depositRequiredMinor: integer('deposit_required_minor').notNull().default(0),
    remainingMinor: integer('remaining_minor').notNull().default(0),
    requiresInstallation: integer('requires_installation', { mode: 'boolean' })
      .notNull()
      .default(false),
    requiresDelivery: integer('requires_delivery', { mode: 'boolean' }).notNull().default(false),
    /**
     * Commercial rate quoted per metre. Informational: this document
     * has no metre-based quantity model (a line carries a plain
     * `quantityMicro` and free-text `dimensions`), so nothing derives
     * a line price from it and it is NOT part of any total.
     */
    meterPriceMinor: integer('meter_price_minor').notNull().default(0),
    /**
     * Additional CHARGES, distinct from the `requires*` booleans above:
     * those say whether the job includes the service, these say what it
     * costs. Both participate in the document total exactly once, via
     * `computeDocumentTotals`.
     */
    installationPriceMinor: integer('installation_price_minor').notNull().default(0),
    deliveryPriceMinor: integer('delivery_price_minor').notNull().default(0),
    /**
     * Per-field PDF visibility (JSON, see shared/documents/print-visibility).
     * NULL means "never configured" — every document written before the
     * feature existed — and resolves to the defaults, which reproduce
     * the original printed appearance.
     */
    printVisibility: text('print_visibility'),
    /** JSON array of the Terms clauses in force at approval (BR-79). */
    termsSnapshot: text('terms_snapshot'),
    revisionOf: integer('revision_of'),
    /**
     * Item 16: INTERNAL pre-production cost estimate, entered while
     * pricing. Never leaves the internal DTOs — the customer-facing
     * preliminary invoice has no field that can carry these.
     */
    estimatedMaterialMinor: integer('estimated_material_minor').notNull().default(0),
    estimatedWorkerMinor: integer('estimated_worker_minor').notNull().default(0),
    estimatedMachineMinor: integer('estimated_machine_minor').notNull().default(0),
    estimatedOtherMinor: integer('estimated_other_minor').notNull().default(0),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    customerIdx: index('quotations_customer_idx').on(t.customerId),
    statusIdx: index('quotations_status_idx').on(t.status)
  })
)

export const quotationLines = sqliteTable(
  'quotation_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    quotationId: integer('quotation_id')
      .notNull()
      .references(() => quotations.id, { onDelete: 'cascade' }),
    /** BR-58: standard product, custom item, direct material sale, or a service line. */
    lineKind: text('line_kind').notNull(), // standard|custom|material|delivery|installation
    productId: integer('product_id').references(() => products.id),
    materialId: integer('material_id').references(() => materials.id),
    description: text('description').notNull(),
    specifications: text('specifications'),
    dimensions: text('dimensions'),
    materialType: text('material_type'),
    colorCode: text('color_code'),
    /**
     * The accessory as it read on this document when it was written —
     * the frozen snapshot, exactly like `termText` freezes a term and
     * `bomSnapshot` freezes components. Legacy documents hold the text
     * the user typed before accessories were linked, and keep it.
     */
    accessories: text('accessories'),
    /** The stable link to the Raw Material the snapshot came from, when
     *  it was chosen from the accessories catalog. Null for legacy
     *  free-text rows, and intentionally NOT cascading: deleting or
     *  renaming the material must never rewrite or erase document
     *  history — the snapshot above is what the document shows. */
    accessoryMaterialId: integer('accessory_material_id').references(() => materials.id),
    /** The stable link to the Raw Material behind "نوع المادة", when it
     *  was chosen from the materials catalog rather than typed. Same
     *  reference+snapshot shape as accessoryMaterialId above — null for
     *  legacy free-text rows, and NOT cascading: deleting or renaming
     *  the material must never rewrite or erase document history. */
    materialTypeMaterialId: integer('material_type_material_id').references(() => materials.id),
    quantityMicro: integer('quantity_micro').notNull(),
    unitPriceMinor: integer('unit_price_minor').notNull(),
    lineTotalMinor: integer('line_total_minor').notNull(),
    /** BR-46: the product's BOM copied at quotation time, as JSON. */
    bomSnapshot: text('bom_snapshot'),
    notes: text('notes')
  },
  (t) => ({ quotationIdx: index('quotation_lines_quotation_idx').on(t.quotationId) })
)

/**
 * BR-18: the confirmed customer order.
 *
 * Workflow pass: an order is now created by APPROVING an Approved
 * Invoice (`final_invoices`), and it is the authoritative production-
 * planning point — its planned materials/machines/worker commissions
 * are owned and edited here, not on any invoice.
 *
 * `quotationId` is retained for the orders that were converted from a
 * preliminary invoice under the old workflow, so that history stays
 * traceable in both directions. Nothing writes it any more.
 */
export const orders = sqliteTable(
  'orders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentNumber: text('document_number').notNull().unique(),
    quotationId: integer('quotation_id').references(() => quotations.id),
    /**
     * The Approved Invoice this order was created from. UNIQUE, so the
     * database itself guarantees one approved invoice can never produce
     * a second customer order however often approval is retried.
     */
    finalInvoiceId: integer('final_invoice_id').references((): AnySQLiteColumn => finalInvoices.id),
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id),
    status: text('status').notNull().default('confirmed'), // confirmed|completed|cancelled|awaiting_approval
    archivedAt: text('archived_at'),
    archivedBy: integer('archived_by'),
    subtotalMinor: integer('subtotal_minor').notNull().default(0),
    discountMinor: integer('discount_minor').notNull().default(0),
    totalMinor: integer('total_minor').notNull().default(0),
    /** BR-42/BR-65: default 60%, overridable per order, stored here. */
    depositPercentBp: integer('deposit_percent_bp').notNull().default(6000),
    depositRequiredMinor: integer('deposit_required_minor').notNull().default(0),
    paidMinor: integer('paid_minor').notNull().default(0),
    remainingMinor: integer('remaining_minor').notNull().default(0),
    paymentStatus: text('payment_status').notNull().default('unpaid'), // unpaid|partial|deposit_met|paid
    requiresInstallation: integer('requires_installation', { mode: 'boolean' })
      .notNull()
      .default(false),
    requiresDelivery: integer('requires_delivery', { mode: 'boolean' }).notNull().default(false),
    /**
     * Copied from the Approved Invoice at approval, so the order's own
     * `total_minor` stays explainable (goods + charges - discount)
     * instead of looking like an unexplained jump from its subtotal.
     * Carried for history only: they create no stock, cash, purchase or
     * production effect of any kind.
     */
    meterPriceMinor: integer('meter_price_minor').notNull().default(0),
    installationPriceMinor: integer('installation_price_minor').notNull().default(0),
    deliveryPriceMinor: integer('delivery_price_minor').notNull().default(0),
    address: text('address'),
    /** BR-106: set when delivery/installation is recorded, or by handover date. */
    completedAt: text('completed_at'),
    cancelledAt: text('cancelled_at'),
    cancelReason: text('cancel_reason'),
    termsSnapshot: text('terms_snapshot'),
    /** Item 16: the estimate copied from the quotation at conversion,
     *  so estimated-vs-actual can be compared on the order itself. */
    estimatedMaterialMinor: integer('estimated_material_minor').notNull().default(0),
    estimatedWorkerMinor: integer('estimated_worker_minor').notNull().default(0),
    estimatedMachineMinor: integer('estimated_machine_minor').notNull().default(0),
    estimatedOtherMinor: integer('estimated_other_minor').notNull().default(0),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    customerIdx: index('orders_customer_idx').on(t.customerId),
    statusIdx: index('orders_status_idx').on(t.status),
    completedIdx: index('orders_completed_idx').on(t.completedAt),
    archiveIdx: index('orders_archive_list_idx').on(t.archivedAt, t.id),
    /** Idempotent approval, enforced by the database (many NULLs allowed). */
    invoiceIdx: uniqueIndex('orders_final_invoice_unique').on(t.finalInvoiceId)
  })
)

/**
 * The APPROVED INVOICE ("الفاتورة المعتمدة") — the authoritative
 * commercial approval point that starts the operational workflow.
 *
 * Workflow pass: this document used to be issued at the END of the
 * workflow (billing an order that had already been produced and
 * delivered). It now sits at the START: it is prepared directly for a
 * customer with its own lines and commercial terms, and APPROVING it
 * is what creates the Customer Order — exactly once, guaranteed by the
 * UNIQUE `orders.final_invoice_id`.
 *
 * Lifecycle: draft → approved → cancelled.
 *
 * `orderId` is therefore NULL while the invoice is still a draft, and
 * is set at approval. Rows created under the old workflow keep the
 * order they were billed against and read back exactly as before, so
 * historical invoices stay valid and traceable.
 *
 * Approval freezes an immutable commercial snapshot (`snapshot`, JSON:
 * customer, lines, subtotal/discount/total). Payment figures are
 * deliberately NOT frozen into it: they are always rendered from the
 * authoritative customer_payments ledger, so a later payment updates
 * the payment block without ever rewriting the agreed commercial
 * terms (item 35).
 */
export const finalInvoices = sqliteTable(
  'final_invoices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentNumber: text('document_number').notNull().unique(),
    /** Owned directly now — a draft invoice exists before any order. */
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id),
    /** NULL until approval creates the order (set for legacy rows). */
    orderId: integer('order_id').references(() => orders.id),
    status: text('status').notNull().default('draft'), // draft | approved | cancelled
    approvalRevision: integer('approval_revision').notNull().default(0),
    /** When the invoice was approved; NULL while it is a draft. */
    issuedAt: text('issued_at'),
    issuedBy: integer('issued_by'),
    /** Immutable commercial snapshot, frozen at approval (JSON). */
    snapshot: text('snapshot'),
    subtotalMinor: integer('subtotal_minor').notNull().default(0),
    discountKind: text('discount_kind').notNull().default('none'), // none|amount|percent
    discountValue: integer('discount_value').notNull().default(0),
    discountMinor: integer('discount_minor').notNull().default(0),
    totalMinor: integer('total_minor').notNull().default(0),
    /** Actual payment instruction, posted only at approval (1 LYD = 1000 minor units). */
    paidAmountMinor: integer('paid_amount_minor').notNull().default(0),
    initialCashAccountId: integer('initial_cash_account_id'),
    /** BR-42/BR-65: carried onto the order it creates. */
    depositPercentBp: integer('deposit_percent_bp').notNull().default(6000),
    depositRequiredMinor: integer('deposit_required_minor').notNull().default(0),
    requiresInstallation: integer('requires_installation', { mode: 'boolean' }).notNull().default(false),
    requiresDelivery: integer('requires_delivery', { mode: 'boolean' }).notNull().default(false),
    /** Quoted per-metre rate — informational, never part of a total.
     *  Same reasoning as on `quotations` above. */
    meterPriceMinor: integer('meter_price_minor').notNull().default(0),
    /** Additional charges, counted exactly once in the total. Separate
     *  from the `requires*` booleans, which only state inclusion. */
    installationPriceMinor: integer('installation_price_minor').notNull().default(0),
    deliveryPriceMinor: integer('delivery_price_minor').notNull().default(0),
    /** Per-field PDF visibility (JSON); NULL = legacy defaults. */
    printVisibility: text('print_visibility'),
    address: text('address'),
    /** BR-79: the Terms text in force, frozen at approval. */
    termsSnapshot: text('terms_snapshot'),
    cancelledAt: text('cancelled_at'),
    cancelReason: text('cancel_reason'),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    orderIdx: index('final_invoices_order_idx').on(t.orderId),
    statusIdx: index('final_invoices_status_idx').on(t.status),
    customerIdx: index('final_invoices_customer_idx').on(t.customerId)
  })
)

/**
 * The Approved Invoice's own editable lines. Legacy invoices have none
 * — their lines live in the frozen `snapshot` JSON and are still read
 * from there, so old documents render exactly as they always did.
 */
export const finalInvoiceLines = sqliteTable(
  'final_invoice_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    finalInvoiceId: integer('final_invoice_id')
      .notNull()
      .references(() => finalInvoices.id, { onDelete: 'cascade' }),
    lineKind: text('line_kind').notNull(), // standard|custom|material|delivery|installation
    productId: integer('product_id').references(() => products.id),
    materialId: integer('material_id').references(() => materials.id),
    description: text('description').notNull(),
    specifications: text('specifications'),
    dimensions: text('dimensions'),
    materialType: text('material_type'),
    colorCode: text('color_code'),
    /**
     * The accessory as it read on this document when it was written —
     * the frozen snapshot, exactly like `termText` freezes a term and
     * `bomSnapshot` freezes components. Legacy documents hold the text
     * the user typed before accessories were linked, and keep it.
     */
    accessories: text('accessories'),
    /** The stable link to the Raw Material the snapshot came from, when
     *  it was chosen from the accessories catalog. Null for legacy
     *  free-text rows, and intentionally NOT cascading: deleting or
     *  renaming the material must never rewrite or erase document
     *  history — the snapshot above is what the document shows. */
    accessoryMaterialId: integer('accessory_material_id').references(() => materials.id),
    /** The stable link to the Raw Material behind "نوع المادة", when it
     *  was chosen from the materials catalog rather than typed. Same
     *  reference+snapshot shape as accessoryMaterialId above — null for
     *  legacy free-text rows, and NOT cascading: deleting or renaming
     *  the material must never rewrite or erase document history. */
    materialTypeMaterialId: integer('material_type_material_id').references(() => materials.id),
    quantityMicro: integer('quantity_micro').notNull(),
    unitPriceMinor: integer('unit_price_minor').notNull(),
    lineTotalMinor: integer('line_total_minor').notNull(),
    /**
     * When this line SELLS an already-manufactured uncollected product
     * rather than something to be built. Declared here as a plain
     * integer (not a Drizzle reference) to avoid a circular import with
     * the uncollected-products schema; the real FOREIGN KEY and the
     * UNIQUE constraint that stops the same physical product appearing
     * on two invoice lines are both created by migration 0038.
     */
    uncollectedProductId: integer('uncollected_product_id'),
    /** BR-46: the product's components copied at invoice time. */
    bomSnapshot: text('bom_snapshot'),
    notes: text('notes')
  },
  (t) => ({ invoiceIdx: index('final_invoice_lines_invoice_idx').on(t.finalInvoiceId) })
)

/**
 * The Approved Invoice's SELECTED Terms/Conditions ("البنود والشروط").
 *
 * A term here is a snapshot reference into the one authoritative global
 * catalog (`app_settings` → `documents.terms`, `getTerms()`) — never a
 * duplicate catalog, never hardcoded. `termIndex` is the term's position
 * in that catalog at the moment it was picked (used to keep this
 * invoice's terms in catalog order, and to stop the same term being
 * added twice — enforced again at the database level below).
 * `termText` freezes the wording as it read at that moment, so a later
 * edit to the global catalog can never rewrite what an already-selected
 * invoice shows or prints — the same snapshot principle `bomSnapshot`
 * already applies to product components on `final_invoice_lines`.
 *
 * Deliberately a separate table from `final_invoice_lines`: a term has
 * no quantity, no price, no inventory or manufacturing effect — it is
 * customer-facing document content only, never a fake product line.
 */
export const finalInvoiceTerms = sqliteTable(
  'final_invoice_terms',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    finalInvoiceId: integer('final_invoice_id')
      .notNull()
      .references(() => finalInvoices.id, { onDelete: 'cascade' }),
    termIndex: integer('term_index').notNull(),
    termText: text('term_text').notNull(),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    // DB-17: final_invoice_terms_unique already serves the finalInvoiceId prefix.
    /** The same term can never be added twice to the same invoice. */
    uniquePerInvoice: uniqueIndex('final_invoice_terms_unique').on(t.finalInvoiceId, t.termIndex)
  })
)

export const orderLines = sqliteTable(
  'order_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    lineKind: text('line_kind').notNull(),
    productId: integer('product_id').references(() => products.id),
    materialId: integer('material_id').references(() => materials.id),
    description: text('description').notNull(),
    specifications: text('specifications'),
    dimensions: text('dimensions'),
    materialType: text('material_type'),
    colorCode: text('color_code'),
    /**
     * The accessory as it read on this document when it was written —
     * the frozen snapshot, exactly like `termText` freezes a term and
     * `bomSnapshot` freezes components. Legacy documents hold the text
     * the user typed before accessories were linked, and keep it.
     */
    accessories: text('accessories'),
    /** The stable link to the Raw Material the snapshot came from, when
     *  it was chosen from the accessories catalog. Null for legacy
     *  free-text rows, and intentionally NOT cascading: deleting or
     *  renaming the material must never rewrite or erase document
     *  history — the snapshot above is what the document shows. */
    accessoryMaterialId: integer('accessory_material_id').references(() => materials.id),
    /** The stable link to the Raw Material behind "نوع المادة", when it
     *  was chosen from the materials catalog rather than typed. Same
     *  reference+snapshot shape as accessoryMaterialId above — null for
     *  legacy free-text rows, and NOT cascading: deleting or renaming
     *  the material must never rewrite or erase document history. */
    materialTypeMaterialId: integer('material_type_material_id').references(() => materials.id),
    quantityMicro: integer('quantity_micro').notNull(),
    unitPriceMinor: integer('unit_price_minor').notNull(),
    lineTotalMinor: integer('line_total_minor').notNull(),
    /** Carried from the invoice line when this order sells an
     *  already-manufactured uncollected product (see migration 0038). */
    uncollectedProductId: integer('uncollected_product_id'),
    bomSnapshot: text('bom_snapshot'),
    supersededAt: text('superseded_at'),
    notes: text('notes')
  },
  (t) => ({ orderIdx: index('order_lines_order_idx').on(t.orderId) })
)

/** Immutable commercial revisions retained when approval is cancelled. */
export const invoiceApprovalHistory = sqliteTable('invoice_approval_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  invoiceId: integer('invoice_id').notNull().references(() => finalInvoices.id),
  revision: integer('revision').notNull(),
  snapshot: text('snapshot').notNull(),
  createdBy: integer('created_by').notNull(),
  createdAt: text('created_at').notNull()
}, (t) => ({ revisionIdx: uniqueIndex('invoice_approval_history_revision_unique').on(t.invoiceId, t.revision) }))

/** Append-only customer payment ledger (BR-42/BR-43/BR-81). */
export const customerPayments = sqliteTable(
  'customer_payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id),
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id),
    /** Unique approval source; null for manually registered payments. */
    approvedInvoiceId: integer('approved_invoice_id').references(() => finalInvoices.id, { onDelete: 'set null' }),
    amountMinor: integer('amount_minor').notNull(),
    cashAccountId: integer('cash_account_id'),
    paidAt: text('paid_at').notNull(),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    approvedInvoiceUnique: uniqueIndex('customer_payments_approved_invoice_unique').on(t.approvedInvoiceId),
    orderIdx: index('customer_payments_order_idx').on(t.orderId),
    dateIdx: index('customer_payments_date_idx').on(t.paidAt)
  })
)

/**
 * Append-only customer refunds. The original receipt remains in
 * `customer_payments`; this row is the equal and opposite business
 * event and owns one outward cash movement.
 */
export const customerPaymentRefunds = sqliteTable(
  'customer_payment_refunds',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id').notNull().references(() => orders.id),
    customerId: integer('customer_id').notNull().references(() => customers.id),
    amountMinor: integer('amount_minor').notNull(),
    cashAccountId: integer('cash_account_id').notNull(),
    refundedAt: text('refunded_at').notNull(),
    /** Legacy-compatible storage column; new refunds store an empty value. */
    reason: text('reason').notNull(),
    requestKey: text('request_key').notNull().unique(),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    orderIdx: index('customer_payment_refunds_order_idx').on(t.orderId),
    customerIdx: index('customer_payment_refunds_customer_idx').on(t.customerId),
    dateIdx: index('customer_payment_refunds_date_idx').on(t.refundedAt)
  })
)

/** Exact original receipt IDs and amounts consumed by one refund. */
export const customerPaymentRefundAllocations = sqliteTable(
  'customer_payment_refund_allocations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    refundId: integer('refund_id').notNull().references(() => customerPaymentRefunds.id, { onDelete: 'cascade' }),
    paymentId: integer('payment_id').notNull().references(() => customerPayments.id),
    amountMinor: integer('amount_minor').notNull()
  },
  (t) => ({
    refundPaymentUnique: uniqueIndex('customer_payment_refund_allocations_refund_payment_uq').on(t.refundId, t.paymentId),
    paymentIdx: index('customer_payment_refund_allocations_payment_idx').on(t.paymentId)
  })
)
