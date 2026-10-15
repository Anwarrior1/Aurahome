ALTER TABLE `material_categories` ADD `show_in_raw_materials` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Keep prior direct assignments and the material-type choices available.
-- Linked inventory leaves were stock items, not category choices.
UPDATE `material_categories`
SET `show_in_raw_materials` = 1
WHERE `node_kind` = 'material_type'
   OR EXISTS (
     SELECT 1 FROM `materials`
     WHERE `materials`.`category_id` = `material_categories`.`id`
       AND `materials`.`hierarchy_node_id` IS NULL
   );
