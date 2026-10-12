ALTER TABLE `employee_transactions` ADD `paid_amount_minor` integer;--> statement-breakpoint
ALTER TABLE `employee_transactions` ADD `reversed_at` text;--> statement-breakpoint
ALTER TABLE `employee_transactions` ADD `reversed_by` integer;--> statement-breakpoint
ALTER TABLE `cash_transactions` ADD `reversal_of_id` integer REFERENCES cash_transactions(id);--> statement-breakpoint
ALTER TABLE `expenses` ADD `reversed_at` text;--> statement-breakpoint
ALTER TABLE `expenses` ADD `reversed_by` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `cash_transactions_reversal_of_idx` ON `cash_transactions` (`reversal_of_id`);
