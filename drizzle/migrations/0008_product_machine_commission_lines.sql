CREATE TABLE `product_commission_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`worker_id` integer,
	`amount_minor` integer NOT NULL,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `product_machine_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`machine_id` integer NOT NULL,
	`usage_qty_micro` integer NOT NULL,
	`rate_micro` integer,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `planned_workers` ADD `work_sheet_id` integer REFERENCES work_sheets(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `product_commission_lines_product_idx` ON `product_commission_lines` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_machine_lines_product_idx` ON `product_machine_lines` (`product_id`);--> statement-breakpoint
CREATE INDEX `planned_workers_sheet_idx` ON `planned_workers` (`work_sheet_id`);