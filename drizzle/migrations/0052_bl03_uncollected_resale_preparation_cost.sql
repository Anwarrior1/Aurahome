-- BL-03: a resale-preparation cost is an ordinary expense that names the Uncollected Product it prepared.
-- Nullable: every existing expense keeps NULL and is never re-linked or reinterpreted.
ALTER TABLE `expenses` ADD `uncollected_product_id` integer REFERENCES uncollected_products(id);--> statement-breakpoint
CREATE INDEX `expenses_uncollected_product_idx` ON `expenses` (`uncollected_product_id`);
