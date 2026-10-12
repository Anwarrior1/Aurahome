ALTER TABLE `uncollected_products` ADD `resumed_at` text;--> statement-breakpoint
ALTER TABLE `uncollected_products` ADD `resumed_by` integer;--> statement-breakpoint
ALTER TABLE `uncollected_products` ADD `resume_request_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uncollected_products_resume_request_uq` ON `uncollected_products` (`resume_request_key`);
