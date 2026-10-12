CREATE TABLE `material_return_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`return_id` integer NOT NULL,
	`issue_line_id` integer NOT NULL,
	`fifo_allocation_id` integer NOT NULL,
	`return_layer_id` integer NOT NULL,
	`qty_micro` integer NOT NULL,
	`unit_cost_micro` integer NOT NULL,
	`cost_minor` integer NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `material_return_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`return_id`) REFERENCES `material_returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issue_line_id`) REFERENCES `order_material_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fifo_allocation_id`) REFERENCES `fifo_allocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`return_layer_id`) REFERENCES `fifo_layers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `material_return_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`return_id` integer NOT NULL,
	`kind` text NOT NULL,
	`before_qty_micro` integer NOT NULL,
	`after_qty_micro` integer NOT NULL,
	`delta_qty_micro` integer NOT NULL,
	`cost_effect_minor` integer NOT NULL,
	`movement_id` integer,
	`request_key` text NOT NULL,
	`expected_version` integer NOT NULL,
	`notes_before` text,
	`notes_after` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`return_id`) REFERENCES `material_returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`movement_id`) REFERENCES `inventory_movements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `material_returns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`material_id` integer NOT NULL,
	`quantity_micro` integer NOT NULL,
	`returned_cost_minor` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	`updated_by` integer,
	`updated_at` text,
	`voided_by` integer,
	`voided_at` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `material_return_allocations_return_idx` ON `material_return_allocations` (`return_id`,`id`);--> statement-breakpoint
CREATE INDEX `material_return_allocations_issue_idx` ON `material_return_allocations` (`issue_line_id`);--> statement-breakpoint
CREATE INDEX `material_return_allocations_fifo_idx` ON `material_return_allocations` (`fifo_allocation_id`);--> statement-breakpoint
CREATE INDEX `material_return_allocations_layer_idx` ON `material_return_allocations` (`return_layer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `material_return_events_request_key_unique` ON `material_return_events` (`request_key`);--> statement-breakpoint
CREATE INDEX `material_return_events_return_idx` ON `material_return_events` (`return_id`,`id`);--> statement-breakpoint
CREATE INDEX `material_returns_order_idx` ON `material_returns` (`order_id`,`status`);--> statement-breakpoint
CREATE INDEX `material_returns_material_idx` ON `material_returns` (`material_id`,`status`);