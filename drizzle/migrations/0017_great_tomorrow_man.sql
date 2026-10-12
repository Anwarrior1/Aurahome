ALTER TABLE `material_categories` ADD `is_accessory` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `final_invoice_lines` ADD `accessory_material_id` integer REFERENCES materials(id);--> statement-breakpoint
ALTER TABLE `order_lines` ADD `accessory_material_id` integer REFERENCES materials(id);--> statement-breakpoint
ALTER TABLE `quotation_lines` ADD `accessory_material_id` integer REFERENCES materials(id);
