CREATE TABLE `finished_goods_valuation_cutovers` (
	`product_id` integer PRIMARY KEY NOT NULL,
	`movement_id_through` integer NOT NULL,
	`opening_qty_micro` integer NOT NULL,
	`opening_value_minor` integer NOT NULL,
	`status` text NOT NULL,
	`classification` text NOT NULL,
	`affected_movement_count` integer DEFAULT 0 NOT NULL,
	`historical_cogs_delta_minor` integer DEFAULT 0 NOT NULL,
	`evidence` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `finished_goods_valuation_cutovers_status_check` CHECK (`status` IN ('ready', 'blocked')),
	CONSTRAINT `finished_goods_valuation_cutovers_classification_check` CHECK (`classification` IN ('unaffected', 'provably_affected', 'potentially_affected')),
	CONSTRAINT `finished_goods_valuation_cutovers_quantity_check` CHECK (`opening_qty_micro` >= 0),
	CONSTRAINT `finished_goods_valuation_cutovers_value_check` CHECK (`opening_value_minor` >= 0)
);
--> statement-breakpoint
ALTER TABLE `finished_goods_movements` ADD `reversal_of_movement_id` integer REFERENCES finished_goods_movements(id);--> statement-breakpoint
CREATE UNIQUE INDEX `finished_goods_movements_reversal_unique` ON `finished_goods_movements` (`reversal_of_movement_id`) WHERE "finished_goods_movements"."reversal_of_movement_id" IS NOT NULL;
