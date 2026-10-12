/*
 Sales/production refinement pass.

 1. Adds the PLANNED line tables — the internal costing estimate on a
    preliminary invoice, which then flows forward as a frozen snapshot
    to the customer order and to the production order. These are
    planning figures only: actual consumption stays in
    order_material_lines / the FIFO ledger, untouched.

 2. Drops work_sheet_stages. The eight-stage tracking workflow was
    introduced in 0001 and is being removed as unwanted complexity; the
    table holds only stage progress, never financial or inventory data,
    and every production order keeps its own status/timestamps, so no
    production order is stranded by the drop.
*/

CREATE TABLE `planned_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quotation_id` integer,
	`order_id` integer,
	`work_sheet_id` integer,
	`material_id` integer,
	`material_name` text NOT NULL,
	`qty_micro` integer NOT NULL,
	`unit` text,
	`dimensions` text,
	`thickness` text,
	`color_code` text,
	`notes` text,
	`estimated_unit_cost_micro` integer DEFAULT 0 NOT NULL,
	`estimated_total_minor` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`quotation_id`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `planned_materials_quotation_idx` ON `planned_materials` (`quotation_id`);--> statement-breakpoint
CREATE INDEX `planned_materials_order_idx` ON `planned_materials` (`order_id`);--> statement-breakpoint
CREATE INDEX `planned_materials_sheet_idx` ON `planned_materials` (`work_sheet_id`);--> statement-breakpoint
CREATE TABLE `planned_machines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quotation_id` integer,
	`order_id` integer,
	`machine_id` integer,
	`machine_name` text NOT NULL,
	`usage_qty_micro` integer DEFAULT 0 NOT NULL,
	`usage_unit` text,
	`estimated_cost_minor` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`quotation_id`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `planned_machines_quotation_idx` ON `planned_machines` (`quotation_id`);--> statement-breakpoint
CREATE INDEX `planned_machines_order_idx` ON `planned_machines` (`order_id`);--> statement-breakpoint
CREATE TABLE `planned_workers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quotation_id` integer,
	`order_id` integer,
	`worker_id` integer,
	`worker_name` text NOT NULL,
	`estimated_cost_minor` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`quotation_id`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `planned_workers_quotation_idx` ON `planned_workers` (`quotation_id`);--> statement-breakpoint
CREATE INDEX `planned_workers_order_idx` ON `planned_workers` (`order_id`);--> statement-breakpoint
DROP TABLE IF EXISTS `work_sheet_stages`;
