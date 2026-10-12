CREATE TABLE `final_invoice_line_accessories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`line_id` integer NOT NULL,
	`material_id` integer,
	`position` integer NOT NULL,
	`name_snapshot` text NOT NULL,
	FOREIGN KEY (`line_id`) REFERENCES `final_invoice_lines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `final_invoice_line_colors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`line_id` integer NOT NULL,
	`color_id` integer,
	`position` integer NOT NULL,
	`code_snapshot` text NOT NULL,
	`name_snapshot` text,
	FOREIGN KEY (`line_id`) REFERENCES `final_invoice_lines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`color_id`) REFERENCES `color_finish_catalog`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `final_invoice_line_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`line_id` integer NOT NULL,
	`material_id` integer,
	`position` integer NOT NULL,
	`name_snapshot` text NOT NULL,
	FOREIGN KEY (`line_id`) REFERENCES `final_invoice_lines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `order_line_accessories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`line_id` integer NOT NULL,
	`material_id` integer,
	`position` integer NOT NULL,
	`name_snapshot` text NOT NULL,
	FOREIGN KEY (`line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `order_line_colors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`line_id` integer NOT NULL,
	`color_id` integer,
	`position` integer NOT NULL,
	`code_snapshot` text NOT NULL,
	`name_snapshot` text,
	FOREIGN KEY (`line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`color_id`) REFERENCES `color_finish_catalog`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `order_line_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`line_id` integer NOT NULL,
	`material_id` integer,
	`position` integer NOT NULL,
	`name_snapshot` text NOT NULL,
	FOREIGN KEY (`line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `quotation_line_accessories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`line_id` integer NOT NULL,
	`material_id` integer,
	`position` integer NOT NULL,
	`name_snapshot` text NOT NULL,
	FOREIGN KEY (`line_id`) REFERENCES `quotation_lines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `quotation_line_colors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`line_id` integer NOT NULL,
	`color_id` integer,
	`position` integer NOT NULL,
	`code_snapshot` text NOT NULL,
	`name_snapshot` text,
	FOREIGN KEY (`line_id`) REFERENCES `quotation_lines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`color_id`) REFERENCES `color_finish_catalog`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `quotation_line_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`line_id` integer NOT NULL,
	`material_id` integer,
	`position` integer NOT NULL,
	`name_snapshot` text NOT NULL,
	FOREIGN KEY (`line_id`) REFERENCES `quotation_lines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoice_line_accessories_reference_uq` ON `final_invoice_line_accessories` (`line_id`,`material_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoice_line_accessories_position_uq` ON `final_invoice_line_accessories` (`line_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoice_line_colors_reference_uq` ON `final_invoice_line_colors` (`line_id`,`color_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoice_line_colors_position_uq` ON `final_invoice_line_colors` (`line_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoice_line_materials_reference_uq` ON `final_invoice_line_materials` (`line_id`,`material_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoice_line_materials_position_uq` ON `final_invoice_line_materials` (`line_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_line_accessories_reference_uq` ON `order_line_accessories` (`line_id`,`material_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_line_accessories_position_uq` ON `order_line_accessories` (`line_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_line_colors_reference_uq` ON `order_line_colors` (`line_id`,`color_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_line_colors_position_uq` ON `order_line_colors` (`line_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_line_materials_reference_uq` ON `order_line_materials` (`line_id`,`material_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_line_materials_position_uq` ON `order_line_materials` (`line_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `quotation_line_accessories_reference_uq` ON `quotation_line_accessories` (`line_id`,`material_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `quotation_line_accessories_position_uq` ON `quotation_line_accessories` (`line_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `quotation_line_colors_reference_uq` ON `quotation_line_colors` (`line_id`,`color_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `quotation_line_colors_position_uq` ON `quotation_line_colors` (`line_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `quotation_line_materials_reference_uq` ON `quotation_line_materials` (`line_id`,`material_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `quotation_line_materials_position_uq` ON `quotation_line_materials` (`line_id`,`position`);
--> statement-breakpoint
INSERT INTO quotation_line_materials (line_id, material_id, position, name_snapshot)
SELECT l.id, l.material_type_material_id, 0, COALESCE(l.material_type, m.name, '')
FROM quotation_lines l LEFT JOIN materials m ON m.id = l.material_type_material_id
WHERE l.material_type_material_id IS NOT NULL OR COALESCE(l.material_type, '') <> '';

--> statement-breakpoint
INSERT INTO quotation_line_accessories (line_id, material_id, position, name_snapshot)
SELECT l.id, l.accessory_material_id, 0, COALESCE(l.accessories, m.name, '')
FROM quotation_lines l LEFT JOIN materials m ON m.id = l.accessory_material_id
WHERE l.accessory_material_id IS NOT NULL OR COALESCE(l.accessories, '') <> '';

--> statement-breakpoint
-- Legacy invoices recorded only a code. Link exact catalog codes, but do not
-- invent an unrecorded historical name from today's mutable catalog.
INSERT INTO quotation_line_colors (line_id, color_id, position, code_snapshot, name_snapshot)
SELECT l.id, c.id, 0, l.color_code, NULL
FROM quotation_lines l LEFT JOIN color_finish_catalog c ON c.code = l.color_code
WHERE COALESCE(l.color_code, '') <> '';

--> statement-breakpoint
INSERT INTO final_invoice_line_materials (line_id, material_id, position, name_snapshot)
SELECT l.id, l.material_type_material_id, 0, COALESCE(l.material_type, m.name, '')
FROM final_invoice_lines l LEFT JOIN materials m ON m.id = l.material_type_material_id
WHERE l.material_type_material_id IS NOT NULL OR COALESCE(l.material_type, '') <> '';

--> statement-breakpoint
INSERT INTO final_invoice_line_accessories (line_id, material_id, position, name_snapshot)
SELECT l.id, l.accessory_material_id, 0, COALESCE(l.accessories, m.name, '')
FROM final_invoice_lines l LEFT JOIN materials m ON m.id = l.accessory_material_id
WHERE l.accessory_material_id IS NOT NULL OR COALESCE(l.accessories, '') <> '';

--> statement-breakpoint
-- Legacy invoices recorded only a code. Link exact catalog codes, but do not
-- invent an unrecorded historical name from today's mutable catalog.
INSERT INTO final_invoice_line_colors (line_id, color_id, position, code_snapshot, name_snapshot)
SELECT l.id, c.id, 0, l.color_code, NULL
FROM final_invoice_lines l LEFT JOIN color_finish_catalog c ON c.code = l.color_code
WHERE COALESCE(l.color_code, '') <> '';

--> statement-breakpoint
INSERT INTO order_line_materials (line_id, material_id, position, name_snapshot)
SELECT l.id, l.material_type_material_id, 0, COALESCE(l.material_type, m.name, '')
FROM order_lines l LEFT JOIN materials m ON m.id = l.material_type_material_id
WHERE l.material_type_material_id IS NOT NULL OR COALESCE(l.material_type, '') <> '';

--> statement-breakpoint
INSERT INTO order_line_accessories (line_id, material_id, position, name_snapshot)
SELECT l.id, l.accessory_material_id, 0, COALESCE(l.accessories, m.name, '')
FROM order_lines l LEFT JOIN materials m ON m.id = l.accessory_material_id
WHERE l.accessory_material_id IS NOT NULL OR COALESCE(l.accessories, '') <> '';

--> statement-breakpoint
-- Legacy invoices recorded only a code. Link exact catalog codes, but do not
-- invent an unrecorded historical name from today's mutable catalog.
INSERT INTO order_line_colors (line_id, color_id, position, code_snapshot, name_snapshot)
SELECT l.id, c.id, 0, l.color_code, NULL
FROM order_lines l LEFT JOIN color_finish_catalog c ON c.code = l.color_code
WHERE COALESCE(l.color_code, '') <> '';
