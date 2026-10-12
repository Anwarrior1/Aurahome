ALTER TABLE `employee_transactions` ADD `parent_transaction_id` integer REFERENCES employee_transactions(id);--> statement-breakpoint
CREATE INDEX `employee_transactions_parent_idx` ON `employee_transactions` (`parent_transaction_id`);
