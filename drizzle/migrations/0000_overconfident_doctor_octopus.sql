CREATE TABLE `role_permissions` (
	`role_id` integer NOT NULL,
	`permission_key` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission_key`),
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`full_name` text NOT NULL,
	`role_id` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`theme` text DEFAULT 'light' NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`details` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_sequences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_type` text NOT NULL,
	`year` integer NOT NULL,
	`last_sequence` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `color_finish_catalog` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`related_material_type` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `material_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`parent_id` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `material_categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`category_id` integer NOT NULL,
	`unit` text NOT NULL,
	`conversion_unit` text,
	`conversion_factor_micro` integer,
	`dimensions` text,
	`thickness` text,
	`current_market_price_micro` integer DEFAULT 0 NOT NULL,
	`pricing_rule` text DEFAULT 'full_unit' NOT NULL,
	`commercial_unit_size_micro` integer,
	`allows_remainder` integer DEFAULT true NOT NULL,
	`track_remainder_pieces` integer DEFAULT false NOT NULL,
	`track_batches` integer DEFAULT false NOT NULL,
	`supports_color` integer DEFAULT false NOT NULL,
	`reorder_level_micro` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `material_categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fifo_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`movement_id` integer NOT NULL,
	`layer_id` integer NOT NULL,
	`qty_micro` integer NOT NULL,
	`unit_cost_micro` integer NOT NULL,
	`cost_minor` integer NOT NULL,
	FOREIGN KEY (`movement_id`) REFERENCES `inventory_movements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`layer_id`) REFERENCES `fifo_layers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fifo_layers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`material_id` integer NOT NULL,
	`source_kind` text NOT NULL,
	`source_ref_id` integer,
	`batch_code` text,
	`qty_received_micro` integer NOT NULL,
	`qty_remaining_micro` integer NOT NULL,
	`unit_cost_micro` integer NOT NULL,
	`received_at` text NOT NULL,
	`seq` integer NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `inventory_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`material_id` integer NOT NULL,
	`kind` text NOT NULL,
	`qty_micro` integer NOT NULL,
	`order_id` integer,
	`actual_cost_minor` integer DEFAULT 0 NOT NULL,
	`reason` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `material_remainders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`material_id` integer NOT NULL,
	`layer_id` integer,
	`size_micro` integer NOT NULL,
	`source_note` text,
	`available` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`layer_id`) REFERENCES `fifo_layers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`address` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `purchase_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`material_id` integer NOT NULL,
	`qty_micro` integer NOT NULL,
	`unit_cost_micro` integer NOT NULL,
	`line_total_minor` integer NOT NULL,
	`batch_code` text,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`supplier_id` integer NOT NULL,
	`purchase_date` text NOT NULL,
	`total_minor` integer NOT NULL,
	`paid_minor` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `supplier_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`supplier_id` integer NOT NULL,
	`purchase_id` integer,
	`amount_minor` integer NOT NULL,
	`cash_account_id` integer,
	`paid_at` text NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`address` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_bom_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`material_id` integer NOT NULL,
	`qty_micro` integer NOT NULL,
	`unit` text NOT NULL,
	`dimensions` text,
	`component_name` text,
	`notes` text,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`default_price_minor` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customer_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`cash_account_id` integer,
	`paid_at` text NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `order_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`line_kind` text NOT NULL,
	`product_id` integer,
	`material_id` integer,
	`description` text NOT NULL,
	`specifications` text,
	`dimensions` text,
	`material_type` text,
	`color_code` text,
	`accessories` text,
	`quantity_micro` integer NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`line_total_minor` integer NOT NULL,
	`bom_snapshot` text,
	`notes` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`quotation_id` integer,
	`customer_id` integer NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`subtotal_minor` integer DEFAULT 0 NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer DEFAULT 0 NOT NULL,
	`deposit_percent_bp` integer DEFAULT 6000 NOT NULL,
	`deposit_required_minor` integer DEFAULT 0 NOT NULL,
	`paid_minor` integer DEFAULT 0 NOT NULL,
	`remaining_minor` integer DEFAULT 0 NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`requires_installation` integer DEFAULT false NOT NULL,
	`requires_delivery` integer DEFAULT false NOT NULL,
	`address` text,
	`completed_at` text,
	`cancelled_at` text,
	`cancel_reason` text,
	`terms_snapshot` text,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`quotation_id`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quotation_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quotation_id` integer NOT NULL,
	`line_kind` text NOT NULL,
	`product_id` integer,
	`material_id` integer,
	`description` text NOT NULL,
	`specifications` text,
	`dimensions` text,
	`material_type` text,
	`color_code` text,
	`accessories` text,
	`quantity_micro` integer NOT NULL,
	`unit_price_minor` integer NOT NULL,
	`line_total_minor` integer NOT NULL,
	`bom_snapshot` text,
	`notes` text,
	FOREIGN KEY (`quotation_id`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quotations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`customer_id` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`issued_at` text,
	`valid_until` text,
	`subtotal_minor` integer DEFAULT 0 NOT NULL,
	`discount_kind` text DEFAULT 'none' NOT NULL,
	`discount_value` integer DEFAULT 0 NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer DEFAULT 0 NOT NULL,
	`deposit_percent_bp` integer DEFAULT 6000 NOT NULL,
	`deposit_required_minor` integer DEFAULT 0 NOT NULL,
	`remaining_minor` integer DEFAULT 0 NOT NULL,
	`requires_installation` integer DEFAULT false NOT NULL,
	`requires_delivery` integer DEFAULT false NOT NULL,
	`terms_snapshot` text,
	`revision_of` integer,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`kind` text NOT NULL,
	`scheduled_at` text,
	`recorded_at` text,
	`address` text,
	`actual_cost_minor` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `machines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`costing_unit` text NOT NULL,
	`default_rate_micro` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_machine_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`machine_id` integer NOT NULL,
	`usage_qty_micro` integer NOT NULL,
	`rate_micro` integer NOT NULL,
	`calculated_minor` integer NOT NULL,
	`final_amount_minor` integer NOT NULL,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `order_material_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`material_id` integer NOT NULL,
	`movement_id` integer,
	`physical_qty_micro` integer NOT NULL,
	`actual_cost_minor` integer NOT NULL,
	`commercial_qty_micro` integer NOT NULL,
	`commercial_value_minor` integer NOT NULL,
	`pricing_rule_used` text NOT NULL,
	`color_code` text,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`movement_id`) REFERENCES `inventory_movements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `order_worker_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`worker_id` integer NOT NULL,
	`method` text NOT NULL,
	`percent_bp` integer,
	`base_kind` text,
	`base_amount_minor` integer,
	`order_line_id` integer,
	`amount_minor` integer NOT NULL,
	`earned` integer DEFAULT false NOT NULL,
	`earned_at` text,
	`notes` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `release_workers` (
	`release_id` integer NOT NULL,
	`worker_id` integer NOT NULL,
	PRIMARY KEY(`release_id`, `worker_id`),
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`order_id` integer NOT NULL,
	`kind` text NOT NULL,
	`authorized_at` text NOT NULL,
	`address` text,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `work_sheet_workers` (
	`work_sheet_id` integer NOT NULL,
	`worker_id` integer NOT NULL,
	PRIMARY KEY(`work_sheet_id`, `worker_id`),
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `work_sheets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`order_id` integer NOT NULL,
	`issued_at` text NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `worker_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worker_id` integer NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`order_id` integer,
	`cash_account_id` integer,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`default_method` text DEFAULT 'fixed' NOT NULL,
	`default_costing_unit` text,
	`default_rate_micro` integer,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `employee_salary_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`monthly_salary_minor` integer NOT NULL,
	`effective_from` text NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `employee_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`period_year` integer,
	`period_month` integer,
	`cash_account_id` integer,
	`expense_id` integer,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`position` text,
	`phone` text,
	`monthly_salary_minor` integer DEFAULT 0 NOT NULL,
	`hired_at` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cash_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'cash' NOT NULL,
	`opening_balance_minor` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cash_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`direction` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`kind` text NOT NULL,
	`ref_table` text,
	`ref_id` integer,
	`transfer_group` text,
	`notes` text,
	`occurred_at` text NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `cash_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `expense_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'variable' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`order_id` integer,
	`cash_account_id` integer,
	`description` text NOT NULL,
	`spent_at` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_ref_id` integer,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `profit_withdrawals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`amount_minor` integer NOT NULL,
	`withdrawn_at` text NOT NULL,
	`person` text,
	`notes` text,
	`cash_account_id` integer,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`cash_account_id`) REFERENCES `cash_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `savings_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`period_year` integer NOT NULL,
	`period_month` integer NOT NULL,
	`net_profit_minor` integer NOT NULL,
	`rate_bp` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`confirmed_at` text NOT NULL,
	`confirmed_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `savings_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`allocation_id` integer,
	`cash_account_id` integer,
	`notes` text,
	`occurred_at` text NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	FOREIGN KEY (`allocation_id`) REFERENCES `savings_allocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_account_id`) REFERENCES `cash_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_sequences_document_type_year_unique` ON `document_sequences` (`document_type`,`year`);--> statement-breakpoint
CREATE UNIQUE INDEX `color_finish_catalog_code_unique` ON `color_finish_catalog` (`code`);--> statement-breakpoint
CREATE INDEX `color_finish_active_idx` ON `color_finish_catalog` (`active`);--> statement-breakpoint
CREATE INDEX `material_categories_parent_idx` ON `material_categories` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `materials_sku_unique` ON `materials` (`sku`);--> statement-breakpoint
CREATE INDEX `materials_category_idx` ON `materials` (`category_id`);--> statement-breakpoint
CREATE INDEX `materials_name_idx` ON `materials` (`name`);--> statement-breakpoint
CREATE INDEX `fifo_allocations_movement_idx` ON `fifo_allocations` (`movement_id`);--> statement-breakpoint
CREATE INDEX `fifo_layers_material_order_idx` ON `fifo_layers` (`material_id`,`received_at`,`seq`);--> statement-breakpoint
CREATE INDEX `inventory_movements_material_idx` ON `inventory_movements` (`material_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_order_idx` ON `inventory_movements` (`order_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_kind_date_idx` ON `inventory_movements` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `material_remainders_material_idx` ON `material_remainders` (`material_id`,`available`);--> statement-breakpoint
CREATE INDEX `customers_name_idx` ON `customers` (`name`);--> statement-breakpoint
CREATE INDEX `purchase_lines_purchase_idx` ON `purchase_lines` (`purchase_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_document_number_unique` ON `purchases` (`document_number`);--> statement-breakpoint
CREATE INDEX `purchases_supplier_idx` ON `purchases` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `purchases_date_idx` ON `purchases` (`purchase_date`);--> statement-breakpoint
CREATE INDEX `supplier_payments_supplier_idx` ON `supplier_payments` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `suppliers_name_idx` ON `suppliers` (`name`);--> statement-breakpoint
CREATE INDEX `product_bom_lines_product_idx` ON `product_bom_lines` (`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_code_unique` ON `products` (`code`);--> statement-breakpoint
CREATE INDEX `products_name_idx` ON `products` (`name`);--> statement-breakpoint
CREATE INDEX `customer_payments_order_idx` ON `customer_payments` (`order_id`);--> statement-breakpoint
CREATE INDEX `customer_payments_date_idx` ON `customer_payments` (`paid_at`);--> statement-breakpoint
CREATE INDEX `order_lines_order_idx` ON `order_lines` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_document_number_unique` ON `orders` (`document_number`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_completed_idx` ON `orders` (`completed_at`);--> statement-breakpoint
CREATE INDEX `quotation_lines_quotation_idx` ON `quotation_lines` (`quotation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `quotations_document_number_unique` ON `quotations` (`document_number`);--> statement-breakpoint
CREATE INDEX `quotations_customer_idx` ON `quotations` (`customer_id`);--> statement-breakpoint
CREATE INDEX `quotations_status_idx` ON `quotations` (`status`);--> statement-breakpoint
CREATE INDEX `deliveries_order_idx` ON `deliveries` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_machine_usage_order_idx` ON `order_machine_usage` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_material_lines_order_idx` ON `order_material_lines` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_worker_assignments_order_idx` ON `order_worker_assignments` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `releases_document_number_unique` ON `releases` (`document_number`);--> statement-breakpoint
CREATE INDEX `releases_order_idx` ON `releases` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_sheets_document_number_unique` ON `work_sheets` (`document_number`);--> statement-breakpoint
CREATE INDEX `work_sheets_order_idx` ON `work_sheets` (`order_id`);--> statement-breakpoint
CREATE INDEX `worker_transactions_worker_idx` ON `worker_transactions` (`worker_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `employee_salary_history_employee_idx` ON `employee_salary_history` (`employee_id`);--> statement-breakpoint
CREATE INDEX `employee_transactions_employee_idx` ON `employee_transactions` (`employee_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `cash_transactions_account_idx` ON `cash_transactions` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `cash_transactions_kind_idx` ON `cash_transactions` (`kind`);--> statement-breakpoint
CREATE INDEX `expenses_date_idx` ON `expenses` (`spent_at`);--> statement-breakpoint
CREATE INDEX `expenses_order_idx` ON `expenses` (`order_id`);--> statement-breakpoint
CREATE INDEX `profit_withdrawals_date_idx` ON `profit_withdrawals` (`withdrawn_at`);--> statement-breakpoint
CREATE INDEX `savings_allocations_period_idx` ON `savings_allocations` (`period_year`,`period_month`);--> statement-breakpoint
CREATE INDEX `savings_transactions_date_idx` ON `savings_transactions` (`occurred_at`);