ALTER TABLE `color_finish_catalog` ADD `related_material_id` integer REFERENCES `materials`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
-- Link only exact, unique master-data names. Preserve all legacy labels,
-- including ambiguous/unmatched text; names are never guessed or invented.
UPDATE color_finish_catalog
SET related_material_id = (SELECT MIN(m.id) FROM materials m WHERE m.name = color_finish_catalog.related_material_type)
WHERE related_material_type IS NOT NULL
  AND (SELECT COUNT(*) FROM materials m WHERE m.name = color_finish_catalog.related_material_type) = 1;
