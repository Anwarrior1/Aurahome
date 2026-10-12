ALTER TABLE `material_categories` ADD `node_kind` text DEFAULT 'legacy_ambiguous' NOT NULL;--> statement-breakpoint
ALTER TABLE `materials` ADD `color_id` integer REFERENCES color_finish_catalog(id);--> statement-breakpoint
CREATE INDEX `material_categories_node_kind_idx` ON `material_categories` (`node_kind`);--> statement-breakpoint
CREATE INDEX `materials_color_idx` ON `materials` (`color_id`);--> statement-breakpoint
/*
  Deterministic legacy classification, using stable relationships only:
  - an existing hierarchy-linked material with no children is certainly an
    inventory item, at whatever historical depth it was created;
  - unlinked roots and their first two descendant levels are safely
    organizational;
  - linked parents, deeper unlinked nodes, and unusual shapes remain
    legacy_ambiguous for explicit review. No material/history row is changed.
*/
WITH RECURSIVE category_depth(id, depth) AS (
  SELECT id, 0 FROM material_categories WHERE parent_id IS NULL
  UNION ALL
  SELECT child.id, category_depth.depth + 1
  FROM material_categories child
  JOIN category_depth ON child.parent_id = category_depth.id
)
UPDATE material_categories
SET node_kind = CASE
  WHEN EXISTS (
    SELECT 1 FROM materials m WHERE m.hierarchy_node_id = material_categories.id
  ) AND NOT EXISTS (
    SELECT 1 FROM material_categories child WHERE child.parent_id = material_categories.id
  ) THEN 'inventory_leaf'
  WHEN parent_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM materials m WHERE m.hierarchy_node_id = material_categories.id
  ) THEN 'main_category'
  WHEN COALESCE((SELECT depth FROM category_depth WHERE id = material_categories.id), -1) = 1
    AND NOT EXISTS (
      SELECT 1 FROM materials m WHERE m.hierarchy_node_id = material_categories.id
    ) AND EXISTS (
      SELECT 1
      FROM material_categories root
      WHERE root.id = material_categories.parent_id
        AND root.parent_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM materials m WHERE m.hierarchy_node_id = root.id
        )
    ) THEN 'material_family'
  WHEN COALESCE((SELECT depth FROM category_depth WHERE id = material_categories.id), -1) = 2
    AND NOT EXISTS (
      SELECT 1 FROM materials m WHERE m.hierarchy_node_id = material_categories.id
    ) AND EXISTS (
      SELECT 1
      FROM material_categories parent
      JOIN material_categories root ON root.id = parent.parent_id
      WHERE parent.id = material_categories.parent_id
        AND root.parent_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM materials m WHERE m.hierarchy_node_id IN (parent.id, root.id)
        )
    ) THEN 'material_type'
  ELSE 'legacy_ambiguous'
END;
