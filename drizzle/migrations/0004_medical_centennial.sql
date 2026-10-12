ALTER TABLE `inventory_movements` ADD `source_kind` text;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `source_ref_id` integer;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `reversal_of_movement_id` integer REFERENCES inventory_movements(id);--> statement-breakpoint
ALTER TABLE `order_material_lines` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_material_lines` ADD `reversed_at` text;--> statement-breakpoint
ALTER TABLE `order_material_lines` ADD `reversed_by` integer;--> statement-breakpoint
ALTER TABLE `order_material_lines` ADD `reversal_movement_id` integer REFERENCES inventory_movements(id);--> statement-breakpoint
ALTER TABLE `order_material_lines` ADD `replacement_line_id` integer REFERENCES order_material_lines(id);--> statement-breakpoint
ALTER TABLE `order_material_lines` ADD `correction_of_line_id` integer REFERENCES order_material_lines(id);--> statement-breakpoint
CREATE INDEX `inventory_movements_source_idx` ON `inventory_movements` (`source_kind`,`source_ref_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_reversal_idx` ON `inventory_movements` (`reversal_of_movement_id`);--> statement-breakpoint
/* Link unambiguous legacy purchase receipt movements to their purchase
   lines. Ambiguous historical duplicates remain NULL and are intentionally
   blocked from destructive correction by the backend. */
UPDATE `inventory_movements`
SET `source_kind` = 'purchase',
    `source_ref_id` = (
      SELECT fl.`source_ref_id`
      FROM `fifo_layers` fl
      JOIN `purchase_lines` pl ON pl.`id` = fl.`source_ref_id`
      WHERE fl.`source_kind` = 'purchase'
        AND fl.`material_id` = `inventory_movements`.`material_id`
        AND fl.`qty_received_micro` = `inventory_movements`.`qty_micro`
        AND pl.`line_total_minor` = `inventory_movements`.`actual_cost_minor`
        AND fl.`received_at` = `inventory_movements`.`created_at`
      LIMIT 1
    )
WHERE `kind` = 'purchase'
  AND (
    SELECT COUNT(*)
    FROM `fifo_layers` fl
    JOIN `purchase_lines` pl ON pl.`id` = fl.`source_ref_id`
    WHERE fl.`source_kind` = 'purchase'
      AND fl.`material_id` = `inventory_movements`.`material_id`
      AND fl.`qty_received_micro` = `inventory_movements`.`qty_micro`
      AND pl.`line_total_minor` = `inventory_movements`.`actual_cost_minor`
      AND fl.`received_at` = `inventory_movements`.`created_at`
  ) = 1;
