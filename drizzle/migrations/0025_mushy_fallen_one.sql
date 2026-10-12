ALTER TABLE `purchases` ADD `customer_order_id` integer REFERENCES orders(id);--> statement-breakpoint
CREATE INDEX `purchases_customer_order_idx` ON `purchases` (`customer_order_id`);
