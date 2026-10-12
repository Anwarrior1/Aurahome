-- Refine the existing 0030 tables; preserve every color snapshot.
CREATE UNIQUE INDEX `quotation_line_materials_owner_uq` ON `quotation_line_materials` (`id`, `line_id`);
--> statement-breakpoint
CREATE TABLE `__new_quotation_line_colors` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `line_id` integer NOT NULL,
  `material_selection_id` integer,
  `color_id` integer,
  `position` integer NOT NULL,
  `code_snapshot` text NOT NULL,
  `name_snapshot` text,
  FOREIGN KEY (`line_id`) REFERENCES `quotation_lines` (`id`) ON DELETE cascade,
  FOREIGN KEY (`color_id`) REFERENCES `color_finish_catalog` (`id`) ON DELETE set null,
  FOREIGN KEY (`material_selection_id`, `line_id`) REFERENCES `quotation_line_materials` (`id`, `line_id`) ON DELETE cascade
);
--> statement-breakpoint
-- No text/code matching and no inferred assignment when the catalog relation
-- is missing or the corresponding material is absent from this invoice item.
INSERT INTO `__new_quotation_line_colors` (id, line_id, material_selection_id, color_id, position, code_snapshot, name_snapshot)
SELECT old.id, old.line_id,
  (SELECT MIN(m.id) FROM `quotation_line_materials` m JOIN color_finish_catalog c ON c.related_material_id = m.material_id
   WHERE c.id = old.color_id AND m.line_id = old.line_id HAVING COUNT(*) = 1),
  old.color_id, old.position, old.code_snapshot, old.name_snapshot
FROM `quotation_line_colors` old;
--> statement-breakpoint
DROP TABLE `quotation_line_colors`;
--> statement-breakpoint
ALTER TABLE `__new_quotation_line_colors` RENAME TO `quotation_line_colors`;
--> statement-breakpoint
CREATE UNIQUE INDEX `quotation_line_colors_reference_uq` ON `quotation_line_colors` (`line_id`, `color_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `quotation_line_colors_position_uq` ON `quotation_line_colors` (`line_id`, `position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoice_line_materials_owner_uq` ON `final_invoice_line_materials` (`id`, `line_id`);
--> statement-breakpoint
CREATE TABLE `__new_final_invoice_line_colors` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `line_id` integer NOT NULL,
  `material_selection_id` integer,
  `color_id` integer,
  `position` integer NOT NULL,
  `code_snapshot` text NOT NULL,
  `name_snapshot` text,
  FOREIGN KEY (`line_id`) REFERENCES `final_invoice_lines` (`id`) ON DELETE cascade,
  FOREIGN KEY (`color_id`) REFERENCES `color_finish_catalog` (`id`) ON DELETE set null,
  FOREIGN KEY (`material_selection_id`, `line_id`) REFERENCES `final_invoice_line_materials` (`id`, `line_id`) ON DELETE cascade
);
--> statement-breakpoint
-- No text/code matching and no inferred assignment when the catalog relation
-- is missing or the corresponding material is absent from this invoice item.
INSERT INTO `__new_final_invoice_line_colors` (id, line_id, material_selection_id, color_id, position, code_snapshot, name_snapshot)
SELECT old.id, old.line_id,
  (SELECT MIN(m.id) FROM `final_invoice_line_materials` m JOIN color_finish_catalog c ON c.related_material_id = m.material_id
   WHERE c.id = old.color_id AND m.line_id = old.line_id HAVING COUNT(*) = 1),
  old.color_id, old.position, old.code_snapshot, old.name_snapshot
FROM `final_invoice_line_colors` old;
--> statement-breakpoint
DROP TABLE `final_invoice_line_colors`;
--> statement-breakpoint
ALTER TABLE `__new_final_invoice_line_colors` RENAME TO `final_invoice_line_colors`;
--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoice_line_colors_reference_uq` ON `final_invoice_line_colors` (`line_id`, `color_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoice_line_colors_position_uq` ON `final_invoice_line_colors` (`line_id`, `position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_line_materials_owner_uq` ON `order_line_materials` (`id`, `line_id`);
--> statement-breakpoint
CREATE TABLE `__new_order_line_colors` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `line_id` integer NOT NULL,
  `material_selection_id` integer,
  `color_id` integer,
  `position` integer NOT NULL,
  `code_snapshot` text NOT NULL,
  `name_snapshot` text,
  FOREIGN KEY (`line_id`) REFERENCES `order_lines` (`id`) ON DELETE cascade,
  FOREIGN KEY (`color_id`) REFERENCES `color_finish_catalog` (`id`) ON DELETE set null,
  FOREIGN KEY (`material_selection_id`, `line_id`) REFERENCES `order_line_materials` (`id`, `line_id`) ON DELETE cascade
);
--> statement-breakpoint
-- No text/code matching and no inferred assignment when the catalog relation
-- is missing or the corresponding material is absent from this invoice item.
INSERT INTO `__new_order_line_colors` (id, line_id, material_selection_id, color_id, position, code_snapshot, name_snapshot)
SELECT old.id, old.line_id,
  (SELECT MIN(m.id) FROM `order_line_materials` m JOIN color_finish_catalog c ON c.related_material_id = m.material_id
   WHERE c.id = old.color_id AND m.line_id = old.line_id HAVING COUNT(*) = 1),
  old.color_id, old.position, old.code_snapshot, old.name_snapshot
FROM `order_line_colors` old;
--> statement-breakpoint
DROP TABLE `order_line_colors`;
--> statement-breakpoint
ALTER TABLE `__new_order_line_colors` RENAME TO `order_line_colors`;
--> statement-breakpoint
CREATE UNIQUE INDEX `order_line_colors_reference_uq` ON `order_line_colors` (`line_id`, `color_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_line_colors_position_uq` ON `order_line_colors` (`line_id`, `position`);
