ALTER TABLE `final_invoice_lines` ADD `material_type_material_id` integer REFERENCES materials(id);--> statement-breakpoint
ALTER TABLE `order_lines` ADD `material_type_material_id` integer REFERENCES materials(id);--> statement-breakpoint
ALTER TABLE `quotation_lines` ADD `material_type_material_id` integer REFERENCES materials(id);
