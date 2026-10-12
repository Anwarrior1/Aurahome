CREATE TABLE `recurring_expense_amounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recurring_expense_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`effective_from` text NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`recurring_expense_id`) REFERENCES `recurring_expenses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recurring_expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer,
	`description` text NOT NULL,
	`cash_account_id` integer,
	`start_date` text NOT NULL,
	`end_date` text,
	`active` integer DEFAULT true NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_account_id`) REFERENCES `cash_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recurring_expense_amounts_series_idx` ON `recurring_expense_amounts` (`recurring_expense_id`,`effective_from`);--> statement-breakpoint
CREATE INDEX `expenses_source_idx` ON `expenses` (`source`,`source_ref_id`);