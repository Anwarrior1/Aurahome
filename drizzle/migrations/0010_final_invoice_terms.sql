CREATE TABLE `final_invoice_terms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`final_invoice_id` integer NOT NULL,
	`term_index` integer NOT NULL,
	`term_text` text NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`final_invoice_id`) REFERENCES `final_invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `final_invoice_terms_invoice_idx` ON `final_invoice_terms` (`final_invoice_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoice_terms_unique` ON `final_invoice_terms` (`final_invoice_id`,`term_index`);