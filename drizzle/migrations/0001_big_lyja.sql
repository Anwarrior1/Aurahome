/*
 Production-workflow pass.

 Evolves the existing Manufacturing Work Sheet ("أمر تصنيع") into a real
 Production Order, ties material/machine/labour to it, adds finished-goods
 stock for standard products, and makes the Final Invoice a separately
 issued document instead of a live render of the order.

 Four tables need their `order_id` relaxed from NOT NULL to nullable
 (stock production has no customer order). SQLite cannot ALTER that, so
 those four are rebuilt the standard way — create / copy / drop / rename
 — with every existing row carried across unchanged. The migration
 runner takes a full backup before this file runs.
*/

PRAGMA foreign_keys=OFF;--> statement-breakpoint

--> work_sheets: nullable order_id + production lifecycle columns
CREATE TABLE `__new_work_sheets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`order_id` integer,
	`product_id` integer,
	`quantity_micro` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`issued_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`cancelled_at` text,
	`cancel_reason` text,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
/*
 Backfill: an already-issued work sheet describes production that really
 happened, so its lifecycle is derived from the order it belongs to —
 completed orders get a completed production order (with the order's own
 completion timestamp), cancelled orders a cancelled one, everything else
 is treated as in production. This keeps historical orders past the new
 gates instead of stranding them behind a status they never had.
*/
INSERT INTO `__new_work_sheets`
	(`id`, `document_number`, `order_id`, `product_id`, `quantity_micro`, `status`,
	 `issued_at`, `started_at`, `completed_at`, `cancelled_at`, `cancel_reason`,
	 `notes`, `created_by`, `created_at`)
SELECT
	ws.`id`, ws.`document_number`, ws.`order_id`, NULL, 0,
	CASE
		WHEN o.`status` = 'completed' THEN 'completed'
		WHEN o.`status` = 'cancelled' THEN 'cancelled'
		ELSE 'in_production'
	END,
	ws.`issued_at`, ws.`issued_at`,
	CASE WHEN o.`status` = 'completed' THEN COALESCE(o.`completed_at`, ws.`issued_at`) ELSE NULL END,
	CASE WHEN o.`status` = 'cancelled' THEN o.`cancelled_at` ELSE NULL END,
	CASE WHEN o.`status` = 'cancelled' THEN o.`cancel_reason` ELSE NULL END,
	ws.`notes`, ws.`created_by`, ws.`created_at`
FROM `work_sheets` ws
LEFT JOIN `orders` o ON o.`id` = ws.`order_id`;--> statement-breakpoint
DROP TABLE `work_sheets`;--> statement-breakpoint
ALTER TABLE `__new_work_sheets` RENAME TO `work_sheets`;--> statement-breakpoint
CREATE UNIQUE INDEX `work_sheets_document_number_unique` ON `work_sheets` (`document_number`);--> statement-breakpoint
CREATE INDEX `work_sheets_order_idx` ON `work_sheets` (`order_id`);--> statement-breakpoint
CREATE INDEX `work_sheets_status_idx` ON `work_sheets` (`status`);--> statement-breakpoint
CREATE INDEX `work_sheets_product_idx` ON `work_sheets` (`product_id`);--> statement-breakpoint

--> order_material_lines: nullable order_id + work_sheet_id
CREATE TABLE `__new_order_material_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer,
	`work_sheet_id` integer,
	`material_id` integer NOT NULL,
	`movement_id` integer,
	`physical_qty_micro` integer NOT NULL,
	`actual_cost_minor` integer NOT NULL,
	`commercial_qty_micro` integer NOT NULL,
	`commercial_value_minor` integer NOT NULL,
	`pricing_rule_used` text NOT NULL,
	`color_code` text,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`movement_id`) REFERENCES `inventory_movements`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
/*
 Existing consumption rows keep order_id and gain the production order of
 that same order when exactly one exists — so historical FIFO cost stays
 attached to the order AND becomes visible on its production order.
*/
INSERT INTO `__new_order_material_lines`
	(`id`, `order_id`, `work_sheet_id`, `material_id`, `movement_id`, `physical_qty_micro`,
	 `actual_cost_minor`, `commercial_qty_micro`, `commercial_value_minor`,
	 `pricing_rule_used`, `color_code`, `notes`, `created_at`)
SELECT
	ml.`id`, ml.`order_id`,
	(SELECT ws.`id` FROM `work_sheets` ws WHERE ws.`order_id` = ml.`order_id` ORDER BY ws.`id` LIMIT 1),
	ml.`material_id`, ml.`movement_id`, ml.`physical_qty_micro`, ml.`actual_cost_minor`,
	ml.`commercial_qty_micro`, ml.`commercial_value_minor`, ml.`pricing_rule_used`,
	ml.`color_code`, ml.`notes`, ml.`created_at`
FROM `order_material_lines` ml;--> statement-breakpoint
DROP TABLE `order_material_lines`;--> statement-breakpoint
ALTER TABLE `__new_order_material_lines` RENAME TO `order_material_lines`;--> statement-breakpoint
CREATE INDEX `order_material_lines_order_idx` ON `order_material_lines` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_material_lines_sheet_idx` ON `order_material_lines` (`work_sheet_id`);--> statement-breakpoint

--> order_machine_usage: nullable order_id + work_sheet_id
CREATE TABLE `__new_order_machine_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer,
	`work_sheet_id` integer,
	`machine_id` integer NOT NULL,
	`usage_qty_micro` integer NOT NULL,
	`rate_micro` integer NOT NULL,
	`calculated_minor` integer NOT NULL,
	`final_amount_minor` integer NOT NULL,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_order_machine_usage`
	(`id`, `order_id`, `work_sheet_id`, `machine_id`, `usage_qty_micro`, `rate_micro`,
	 `calculated_minor`, `final_amount_minor`, `notes`, `created_at`)
SELECT
	mu.`id`, mu.`order_id`,
	(SELECT ws.`id` FROM `work_sheets` ws WHERE ws.`order_id` = mu.`order_id` ORDER BY ws.`id` LIMIT 1),
	mu.`machine_id`, mu.`usage_qty_micro`, mu.`rate_micro`, mu.`calculated_minor`,
	mu.`final_amount_minor`, mu.`notes`, mu.`created_at`
FROM `order_machine_usage` mu;--> statement-breakpoint
DROP TABLE `order_machine_usage`;--> statement-breakpoint
ALTER TABLE `__new_order_machine_usage` RENAME TO `order_machine_usage`;--> statement-breakpoint
CREATE INDEX `order_machine_usage_order_idx` ON `order_machine_usage` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_machine_usage_sheet_idx` ON `order_machine_usage` (`work_sheet_id`);--> statement-breakpoint

--> order_worker_assignments: nullable order_id + work_sheet_id
CREATE TABLE `__new_order_worker_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer,
	`work_sheet_id` integer,
	`worker_id` integer NOT NULL,
	`method` text NOT NULL,
	`percent_bp` integer,
	`base_kind` text,
	`base_amount_minor` integer,
	`order_line_id` integer,
	`amount_minor` integer NOT NULL,
	`earned` integer DEFAULT false NOT NULL,
	`earned_at` text,
	`notes` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_order_worker_assignments`
	(`id`, `order_id`, `work_sheet_id`, `worker_id`, `method`, `percent_bp`, `base_kind`,
	 `base_amount_minor`, `order_line_id`, `amount_minor`, `earned`, `earned_at`, `notes`)
SELECT
	wa.`id`, wa.`order_id`,
	(SELECT ws.`id` FROM `work_sheets` ws WHERE ws.`order_id` = wa.`order_id` ORDER BY ws.`id` LIMIT 1),
	wa.`worker_id`, wa.`method`, wa.`percent_bp`, wa.`base_kind`, wa.`base_amount_minor`,
	wa.`order_line_id`, wa.`amount_minor`, wa.`earned`, wa.`earned_at`, wa.`notes`
FROM `order_worker_assignments` wa;--> statement-breakpoint
DROP TABLE `order_worker_assignments`;--> statement-breakpoint
ALTER TABLE `__new_order_worker_assignments` RENAME TO `order_worker_assignments`;--> statement-breakpoint
CREATE INDEX `order_worker_assignments_order_idx` ON `order_worker_assignments` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_worker_assignments_sheet_idx` ON `order_worker_assignments` (`work_sheet_id`);--> statement-breakpoint

PRAGMA foreign_keys=ON;--> statement-breakpoint

--> New tables
CREATE TABLE `work_sheet_stages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`work_sheet_id` integer NOT NULL,
	`sequence` integer NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`worker_id` integer,
	`started_at` text,
	`completed_at` text,
	`notes` text,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `work_sheet_stages_sheet_idx` ON `work_sheet_stages` (`work_sheet_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `finished_goods_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`kind` text NOT NULL,
	`qty_micro` integer NOT NULL,
	`unit_cost_minor` integer DEFAULT 0 NOT NULL,
	`total_cost_minor` integer DEFAULT 0 NOT NULL,
	`work_sheet_id` integer,
	`order_id` integer,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `finished_goods_movements_product_idx` ON `finished_goods_movements` (`product_id`);--> statement-breakpoint
CREATE INDEX `finished_goods_movements_order_idx` ON `finished_goods_movements` (`order_id`);--> statement-breakpoint
CREATE TABLE `final_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`order_id` integer NOT NULL,
	`status` text DEFAULT 'issued' NOT NULL,
	`issued_at` text NOT NULL,
	`issued_by` integer,
	`snapshot` text NOT NULL,
	`total_minor` integer DEFAULT 0 NOT NULL,
	`cancelled_at` text,
	`cancel_reason` text,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoices_document_number_unique` ON `final_invoices` (`document_number`);--> statement-breakpoint
CREATE INDEX `final_invoices_order_idx` ON `final_invoices` (`order_id`);--> statement-breakpoint
CREATE INDEX `final_invoices_status_idx` ON `final_invoices` (`status`);--> statement-breakpoint
CREATE TABLE `delivery_workers` (
	`delivery_id` integer NOT NULL,
	`worker_id` integer NOT NULL,
	PRIMARY KEY(`delivery_id`, `worker_id`),
	FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint

--> Additive columns (existing rows keep working, defaults are inert)
ALTER TABLE `orders` ADD `estimated_material_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `estimated_worker_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `estimated_machine_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `estimated_other_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quotations` ADD `estimated_material_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quotations` ADD `estimated_worker_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quotations` ADD `estimated_machine_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quotations` ADD `estimated_other_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `release_id` integer REFERENCES releases(id);--> statement-breakpoint
ALTER TABLE `deliveries` ADD `status` text DEFAULT 'recorded' NOT NULL;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `cancel_reason` text;
