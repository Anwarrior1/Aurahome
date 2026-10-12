/*
 WORKFLOW PASS — the Approved Invoice moves to the START of the workflow.

 Before: preliminary invoice --approve--> customer order --...--> delivery
         --> final/approved invoice (billing, issued at the very end).

 After:  approved invoice --approve--> customer order --> production
         planning --> (explicit) manufacturing order.
         The preliminary invoice is an independent customer document.

 This migration is ADDITIVE AND LOSSLESS. Every existing row is copied
 forward, keeps its id, its document number, its frozen snapshot and
 its link to the order it was issued against, so historical documents
 stay readable and traceable in both directions.

 `final_invoices` is rebuilt (rather than ALTERed) because SQLite cannot
 drop NOT NULL from a column: `order_id`, `issued_at` and `snapshot`
 must all become nullable now that an approved invoice exists as a
 DRAFT before any order or approval exists. Same data-preserving
 rebuild pattern migration 0001 already used for `work_sheets`.

 The rebuild runs BEFORE `final_invoice_lines` and `orders.final_invoice_id`
 are created, so nothing references `final_invoices` while it is being
 replaced.
*/

PRAGMA foreign_keys=OFF;--> statement-breakpoint

--> final_invoices: nullable order_id/issued_at/snapshot + its own commercial terms
CREATE TABLE `__new_final_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`customer_id` integer NOT NULL,
	`order_id` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`issued_at` text,
	`issued_by` integer,
	`snapshot` text,
	`subtotal_minor` integer DEFAULT 0 NOT NULL,
	`discount_kind` text DEFAULT 'none' NOT NULL,
	`discount_value` integer DEFAULT 0 NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer DEFAULT 0 NOT NULL,
	`deposit_percent_bp` integer DEFAULT 6000 NOT NULL,
	`deposit_required_minor` integer DEFAULT 0 NOT NULL,
	`requires_installation` integer DEFAULT false NOT NULL,
	`requires_delivery` integer DEFAULT false NOT NULL,
	`address` text,
	`terms_snapshot` text,
	`cancelled_at` text,
	`cancel_reason` text,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
/*
 Backfill: a legacy invoice was billed against an order that had already
 been produced and delivered, so it is by definition an APPROVED invoice
 whose order already exists. Its customer and commercial terms are taken
 from that order — which is where they authoritatively lived under the
 old workflow — and its own `order_id`, snapshot, number and timestamps
 are carried over untouched. A cancelled invoice stays cancelled.

 The join is a LEFT JOIN on purpose: `customer_id` is NOT NULL, so if an
 invoice ever pointed at a missing order the insert fails loudly and the
 whole migration rolls back, instead of silently dropping the row.
*/
INSERT INTO `__new_final_invoices`
	(`id`, `document_number`, `customer_id`, `order_id`, `status`, `issued_at`, `issued_by`,
	 `snapshot`, `subtotal_minor`, `discount_kind`, `discount_value`, `discount_minor`,
	 `total_minor`, `deposit_percent_bp`, `deposit_required_minor`, `requires_installation`,
	 `requires_delivery`, `address`, `terms_snapshot`, `cancelled_at`, `cancel_reason`,
	 `notes`, `created_by`, `created_at`)
SELECT
	fi.`id`, fi.`document_number`, o.`customer_id`, fi.`order_id`,
	CASE WHEN fi.`status` = 'cancelled' THEN 'cancelled' ELSE 'approved' END,
	fi.`issued_at`, fi.`issued_by`, fi.`snapshot`,
	COALESCE(o.`subtotal_minor`, 0), 'none', 0, COALESCE(o.`discount_minor`, 0),
	fi.`total_minor`, COALESCE(o.`deposit_percent_bp`, 6000), COALESCE(o.`deposit_required_minor`, 0),
	COALESCE(o.`requires_installation`, false), COALESCE(o.`requires_delivery`, false),
	o.`address`, o.`terms_snapshot`, fi.`cancelled_at`, fi.`cancel_reason`,
	fi.`notes`, fi.`issued_by`, fi.`created_at`
FROM `final_invoices` fi
LEFT JOIN `orders` o ON o.`id` = fi.`order_id`;--> statement-breakpoint
DROP TABLE `final_invoices`;--> statement-breakpoint
ALTER TABLE `__new_final_invoices` RENAME TO `final_invoices`;--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoices_document_number_unique` ON `final_invoices` (`document_number`);--> statement-breakpoint
CREATE INDEX `final_invoices_order_idx` ON `final_invoices` (`order_id`);--> statement-breakpoint
CREATE INDEX `final_invoices_status_idx` ON `final_invoices` (`status`);--> statement-breakpoint
CREATE INDEX `final_invoices_customer_idx` ON `final_invoices` (`customer_id`);--> statement-breakpoint

--> the approved invoice's own editable lines (legacy rows keep using their frozen snapshot)
CREATE TABLE `final_invoice_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`final_invoice_id` integer NOT NULL,
	`line_kind` text NOT NULL,
	`product_id` integer,
	`material_id` integer,
	`description` text NOT NULL,
	`specifications` text,
	`dimensions` text,
	`material_type` text,
	`color_code` text,
	`accessories` text,
	`quantity_micro` integer NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`line_total_minor` integer NOT NULL,
	`bom_snapshot` text,
	`notes` text,
	FOREIGN KEY (`final_invoice_id`) REFERENCES `final_invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `final_invoice_lines_invoice_idx` ON `final_invoice_lines` (`final_invoice_id`);--> statement-breakpoint

--> orders: the approved invoice that created the order. UNIQUE, so approval can never
--> produce a second order for the same invoice however often it is retried.
ALTER TABLE `orders` ADD `final_invoice_id` integer REFERENCES final_invoices(id);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_final_invoice_unique` ON `orders` (`final_invoice_id`);--> statement-breakpoint
/*
 Backfill the reverse link for history: an order that was billed under
 the old workflow now also points back at that invoice, so the pairing
 is traceable from either side. Deterministic and unique-safe — the
 lowest-numbered non-cancelled invoice of each order, and NULL for an
 order whose only invoices were voided (that invoice still points at
 the order through its own `order_id`, so nothing is lost).
*/
UPDATE `orders` SET `final_invoice_id` = (
	SELECT MIN(fi.`id`) FROM `final_invoices` fi
	WHERE fi.`order_id` = `orders`.`id` AND fi.`status` <> 'cancelled'
);
