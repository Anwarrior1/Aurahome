CREATE TABLE `planned_order_expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer,
	`work_sheet_id` integer,
	`expense_name` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `planned_workers` ADD `commission_mode` text DEFAULT 'estimated' NOT NULL;--> statement-breakpoint
ALTER TABLE `planned_workers` ADD `meter_rate_micro` integer;--> statement-breakpoint
ALTER TABLE `planned_workers` ADD `meter_qty_micro` integer;--> statement-breakpoint
CREATE INDEX `planned_order_expenses_order_idx` ON `planned_order_expenses` (`order_id`);--> statement-breakpoint
CREATE INDEX `planned_order_expenses_sheet_idx` ON `planned_order_expenses` (`work_sheet_id`);