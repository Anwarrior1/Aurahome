/*
 Material-master refinement pass.

 conversion_unit / conversion_factor_micro were captured on the Add
 Material form and round-tripped back to it, but no purchasing,
 inventory or costing code ever read them — confirmed by inspection and
 by the single existing material row, which has both columns empty.
 Renaming them is therefore a safe rename, not a reinterpretation of
 live data: it gives the same two columns their first REAL meaning
 (purchase-unit conversion), which purchasing.service.ts now implements.

 tracks_dimensions is new and additive. Existing rows are backfilled to
 true wherever they already carry a dimension or thickness value, so
 the one existing MDF row keeps showing its dimensions with no action
 needed; every other (hypothetical) row defaults to false, matching the
 "optional, explicit, never inferred from the name" rule.
*/

ALTER TABLE `materials` RENAME COLUMN `conversion_unit` TO `purchase_unit`;--> statement-breakpoint
ALTER TABLE `materials` RENAME COLUMN `conversion_factor_micro` TO `purchase_unit_factor_micro`;--> statement-breakpoint
ALTER TABLE `materials` ADD `tracks_dimensions` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `materials` SET `tracks_dimensions` = 1
  WHERE (`dimensions` IS NOT NULL AND trim(`dimensions`) != '')
     OR (`thickness` IS NOT NULL AND trim(`thickness`) != '');
