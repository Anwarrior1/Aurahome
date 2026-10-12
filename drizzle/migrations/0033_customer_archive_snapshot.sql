ALTER TABLE `quotations` ADD `customer_snapshot` text;--> statement-breakpoint
CREATE INDEX `customers_lifecycle_name_idx` ON `customers` (`active`,`name`);
--> statement-breakpoint
UPDATE quotations SET customer_snapshot = (SELECT json_object('name', c.name, 'phone', c.phone, 'address', c.address) FROM customers c WHERE c.id = quotations.customer_id) WHERE status <> 'draft' AND customer_snapshot IS NULL;
