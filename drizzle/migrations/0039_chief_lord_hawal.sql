CREATE TABLE `customer_payment_refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`cash_account_id` integer NOT NULL,
	`refunded_at` text NOT NULL,
	`reason` text NOT NULL,
	`request_key` text NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `customer_payment_refund_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_id` integer NOT NULL,
	`payment_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	FOREIGN KEY (`refund_id`) REFERENCES `customer_payment_refunds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payment_id`) REFERENCES `customer_payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_payment_refund_allocations_refund_payment_uq` ON `customer_payment_refund_allocations` (`refund_id`,`payment_id`);--> statement-breakpoint
CREATE INDEX `customer_payment_refund_allocations_payment_idx` ON `customer_payment_refund_allocations` (`payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `customer_payment_refunds_request_key_unique` ON `customer_payment_refunds` (`request_key`);--> statement-breakpoint
CREATE INDEX `customer_payment_refunds_order_idx` ON `customer_payment_refunds` (`order_id`);--> statement-breakpoint
CREATE INDEX `customer_payment_refunds_customer_idx` ON `customer_payment_refunds` (`customer_id`);--> statement-breakpoint
CREATE INDEX `customer_payment_refunds_date_idx` ON `customer_payment_refunds` (`refunded_at`);
