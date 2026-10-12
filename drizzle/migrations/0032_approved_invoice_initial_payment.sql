ALTER TABLE `customer_payments` ADD `approved_invoice_id` integer REFERENCES final_invoices(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `final_invoices` ADD `paid_amount_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `final_invoices` ADD `initial_cash_account_id` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `customer_payments_approved_invoice_unique` ON `customer_payments` (`approved_invoice_id`);
