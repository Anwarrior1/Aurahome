ALTER TABLE `releases` ADD `authorization_type` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `order_total_minor_at_issue` integer;--> statement-breakpoint
ALTER TABLE `releases` ADD `paid_minor_at_issue` integer;--> statement-breakpoint
ALTER TABLE `releases` ADD `remaining_minor_at_issue` integer;--> statement-breakpoint
ALTER TABLE `releases` ADD `unpaid_override_reason` text;