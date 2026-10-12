ALTER TABLE `materials` ADD `hierarchy_node_id` integer REFERENCES material_categories(id);--> statement-breakpoint
ALTER TABLE `materials` ADD `creation_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `materials_hierarchy_node_unique` ON `materials` (`hierarchy_node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `materials_creation_key_unique` ON `materials` (`creation_key`);
