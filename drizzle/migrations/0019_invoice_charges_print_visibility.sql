ALTER TABLE `quotations` ADD `meter_price_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quotations` ADD `installation_price_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quotations` ADD `delivery_price_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quotations` ADD `print_visibility` text;--> statement-breakpoint
ALTER TABLE `final_invoices` ADD `meter_price_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `final_invoices` ADD `installation_price_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `final_invoices` ADD `delivery_price_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `final_invoices` ADD `print_visibility` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `meter_price_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `installation_price_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `delivery_price_minor` integer DEFAULT 0 NOT NULL;
