-- DB-03: quoted SQL-keyword defaults stored literal text. Rebuild only affected tables
-- with a UTC ISO-8601 millisecond database default. Existing malformed historical values
-- are deliberately preserved because their exact chronology is not authoritatively recoverable.
-- DB-03: rebuild app_settings without changing historical timestamp values.
CREATE TABLE `__db03_new_app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
INSERT INTO `__db03_new_app_settings` (`key`, `value`, `updated_at`, `updated_by`) SELECT `key`, `value`, `updated_at`, `updated_by` FROM `app_settings`;
--> statement-breakpoint
DROP TABLE `app_settings`;
--> statement-breakpoint
ALTER TABLE `__db03_new_app_settings` RENAME TO `app_settings`;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_app_settings_updated_at_insert` BEFORE INSERT ON `app_settings`
FOR EACH ROW WHEN NEW.`updated_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_app_settings_updated_at_update` BEFORE UPDATE OF `updated_at` ON `app_settings`
FOR EACH ROW WHEN NEW.`updated_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild audit_log without changing historical timestamp values.
CREATE TABLE `__db03_new_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text,
	`details` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__db03_new_audit_log` (`id`, `user_id`, `action`, `entity`, `entity_id`, `details`, `created_at`) SELECT `id`, `user_id`, `action`, `entity`, `entity_id`, `details`, `created_at` FROM `audit_log`;
--> statement-breakpoint
DROP TABLE `audit_log`;
--> statement-breakpoint
ALTER TABLE `__db03_new_audit_log` RENAME TO `audit_log`;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_audit_log_created_at_insert` BEFORE INSERT ON `audit_log`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_audit_log_created_at_update` BEFORE UPDATE OF `created_at` ON `audit_log`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild cash_accounts without changing historical timestamp values.
CREATE TABLE `__db03_new_cash_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'cash' NOT NULL,
	`opening_balance_minor` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__db03_new_cash_accounts` (`id`, `name`, `kind`, `opening_balance_minor`, `active`, `notes`, `created_at`) SELECT `id`, `name`, `kind`, `opening_balance_minor`, `active`, `notes`, `created_at` FROM `cash_accounts`;
--> statement-breakpoint
DROP TABLE `cash_accounts`;
--> statement-breakpoint
ALTER TABLE `__db03_new_cash_accounts` RENAME TO `cash_accounts`;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_cash_accounts_created_at_insert` BEFORE INSERT ON `cash_accounts`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_cash_accounts_created_at_update` BEFORE UPDATE OF `created_at` ON `cash_accounts`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild cash_transactions without changing historical timestamp values.
CREATE TABLE `__db03_new_cash_transactions` (
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
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `reversal_of_id` integer REFERENCES cash_transactions(id),
	FOREIGN KEY (`account_id`) REFERENCES `cash_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_cash_transactions` (`id`, `account_id`, `direction`, `amount_minor`, `kind`, `ref_table`, `ref_id`, `transfer_group`, `notes`, `occurred_at`, `created_by`, `created_at`, `reversal_of_id`) SELECT `id`, `account_id`, `direction`, `amount_minor`, `kind`, `ref_table`, `ref_id`, `transfer_group`, `notes`, `occurred_at`, `created_by`, `created_at`, `reversal_of_id` FROM `cash_transactions`;
--> statement-breakpoint
DROP TABLE `cash_transactions`;
--> statement-breakpoint
ALTER TABLE `__db03_new_cash_transactions` RENAME TO `cash_transactions`;
--> statement-breakpoint
CREATE INDEX `cash_transactions_account_idx` ON `cash_transactions` (`account_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `cash_transactions_kind_idx` ON `cash_transactions` (`kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_transactions_reversal_of_idx` ON `cash_transactions` (`reversal_of_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_cash_transactions_created_at_insert` BEFORE INSERT ON `cash_transactions`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_cash_transactions_created_at_update` BEFORE UPDATE OF `created_at` ON `cash_transactions`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild color_finish_catalog without changing historical timestamp values.
CREATE TABLE `__db03_new_color_finish_catalog` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`related_material_type` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
, `related_material_id` integer REFERENCES `materials`(`id`) ON DELETE SET NULL);
--> statement-breakpoint
INSERT INTO `__db03_new_color_finish_catalog` (`id`, `code`, `name`, `related_material_type`, `notes`, `active`, `created_at`, `related_material_id`) SELECT `id`, `code`, `name`, `related_material_type`, `notes`, `active`, `created_at`, `related_material_id` FROM `color_finish_catalog`;
--> statement-breakpoint
DROP TABLE `color_finish_catalog`;
--> statement-breakpoint
ALTER TABLE `__db03_new_color_finish_catalog` RENAME TO `color_finish_catalog`;
--> statement-breakpoint
CREATE INDEX `color_finish_active_idx` ON `color_finish_catalog` (`active`);
--> statement-breakpoint
CREATE UNIQUE INDEX `color_finish_catalog_code_unique` ON `color_finish_catalog` (`code`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_color_finish_catalog_created_at_insert` BEFORE INSERT ON `color_finish_catalog`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_color_finish_catalog_created_at_update` BEFORE UPDATE OF `created_at` ON `color_finish_catalog`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild customer_payment_refunds without changing historical timestamp values.
CREATE TABLE `__db03_new_customer_payment_refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`cash_account_id` integer NOT NULL,
	`refunded_at` text NOT NULL,
	`reason` text NOT NULL,
	`request_key` text NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_customer_payment_refunds` (`id`, `order_id`, `customer_id`, `amount_minor`, `cash_account_id`, `refunded_at`, `reason`, `request_key`, `created_by`, `created_at`) SELECT `id`, `order_id`, `customer_id`, `amount_minor`, `cash_account_id`, `refunded_at`, `reason`, `request_key`, `created_by`, `created_at` FROM `customer_payment_refunds`;
--> statement-breakpoint
DROP TABLE `customer_payment_refunds`;
--> statement-breakpoint
ALTER TABLE `__db03_new_customer_payment_refunds` RENAME TO `customer_payment_refunds`;
--> statement-breakpoint
CREATE INDEX `customer_payment_refunds_customer_idx` ON `customer_payment_refunds` (`customer_id`);
--> statement-breakpoint
CREATE INDEX `customer_payment_refunds_date_idx` ON `customer_payment_refunds` (`refunded_at`);
--> statement-breakpoint
CREATE INDEX `customer_payment_refunds_order_idx` ON `customer_payment_refunds` (`order_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_payment_refunds_request_key_unique` ON `customer_payment_refunds` (`request_key`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_customer_payment_refunds_created_at_insert` BEFORE INSERT ON `customer_payment_refunds`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_customer_payment_refunds_created_at_update` BEFORE UPDATE OF `created_at` ON `customer_payment_refunds`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild customer_payments without changing historical timestamp values.
CREATE TABLE `__db03_new_customer_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`cash_account_id` integer,
	`paid_at` text NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `approved_invoice_id` integer REFERENCES final_invoices(id) ON DELETE SET NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_customer_payments` (`id`, `order_id`, `customer_id`, `amount_minor`, `cash_account_id`, `paid_at`, `notes`, `created_by`, `created_at`, `approved_invoice_id`) SELECT `id`, `order_id`, `customer_id`, `amount_minor`, `cash_account_id`, `paid_at`, `notes`, `created_by`, `created_at`, `approved_invoice_id` FROM `customer_payments`;
--> statement-breakpoint
DROP TABLE `customer_payments`;
--> statement-breakpoint
ALTER TABLE `__db03_new_customer_payments` RENAME TO `customer_payments`;
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_payments_approved_invoice_unique` ON `customer_payments` (`approved_invoice_id`);
--> statement-breakpoint
CREATE INDEX `customer_payments_date_idx` ON `customer_payments` (`paid_at`);
--> statement-breakpoint
CREATE INDEX `customer_payments_order_idx` ON `customer_payments` (`order_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_customer_payments_created_at_insert` BEFORE INSERT ON `customer_payments`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_customer_payments_created_at_update` BEFORE UPDATE OF `created_at` ON `customer_payments`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild customers without changing historical timestamp values.
CREATE TABLE `__db03_new_customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`address` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__db03_new_customers` (`id`, `name`, `phone`, `address`, `notes`, `active`, `created_at`) SELECT `id`, `name`, `phone`, `address`, `notes`, `active`, `created_at` FROM `customers`;
--> statement-breakpoint
DROP TABLE `customers`;
--> statement-breakpoint
ALTER TABLE `__db03_new_customers` RENAME TO `customers`;
--> statement-breakpoint
CREATE INDEX `customers_lifecycle_name_idx` ON `customers` (`active`,`name`);
--> statement-breakpoint
CREATE INDEX `customers_name_idx` ON `customers` (`name`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_customers_created_at_insert` BEFORE INSERT ON `customers`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_customers_created_at_update` BEFORE UPDATE OF `created_at` ON `customers`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild deliveries without changing historical timestamp values.
CREATE TABLE `__db03_new_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`kind` text NOT NULL,
	`scheduled_at` text,
	`recorded_at` text,
	`address` text,
	`actual_cost_minor` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `release_id` integer REFERENCES releases(id), `status` text DEFAULT 'recorded' NOT NULL, `cancelled_at` text, `cancel_reason` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_deliveries` (`id`, `order_id`, `kind`, `scheduled_at`, `recorded_at`, `address`, `actual_cost_minor`, `notes`, `created_by`, `created_at`, `release_id`, `status`, `cancelled_at`, `cancel_reason`) SELECT `id`, `order_id`, `kind`, `scheduled_at`, `recorded_at`, `address`, `actual_cost_minor`, `notes`, `created_by`, `created_at`, `release_id`, `status`, `cancelled_at`, `cancel_reason` FROM `deliveries`;
--> statement-breakpoint
DROP TABLE `deliveries`;
--> statement-breakpoint
ALTER TABLE `__db03_new_deliveries` RENAME TO `deliveries`;
--> statement-breakpoint
CREATE INDEX `deliveries_order_idx` ON `deliveries` (`order_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_deliveries_created_at_insert` BEFORE INSERT ON `deliveries`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_deliveries_created_at_update` BEFORE UPDATE OF `created_at` ON `deliveries`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild employee_salary_history without changing historical timestamp values.
CREATE TABLE `__db03_new_employee_salary_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`employee_id` integer NOT NULL,
	`monthly_salary_minor` integer NOT NULL,
	`effective_from` text NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__db03_new_employee_salary_history` (`id`, `employee_id`, `monthly_salary_minor`, `effective_from`, `notes`, `created_by`, `created_at`) SELECT `id`, `employee_id`, `monthly_salary_minor`, `effective_from`, `notes`, `created_by`, `created_at` FROM `employee_salary_history`;
--> statement-breakpoint
DROP TABLE `employee_salary_history`;
--> statement-breakpoint
ALTER TABLE `__db03_new_employee_salary_history` RENAME TO `employee_salary_history`;
--> statement-breakpoint
CREATE INDEX `employee_salary_history_employee_idx` ON `employee_salary_history` (`employee_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_employee_salary_history_created_at_insert` BEFORE INSERT ON `employee_salary_history`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_employee_salary_history_created_at_update` BEFORE UPDATE OF `created_at` ON `employee_salary_history`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild employee_transactions without changing historical timestamp values.
CREATE TABLE `__db03_new_employee_transactions` (
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
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `parent_transaction_id` integer REFERENCES employee_transactions(id), `paid_amount_minor` integer, `reversed_at` text, `reversed_by` integer, `history_hidden_at` text, `history_hidden_by` integer,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_employee_transactions` (`id`, `employee_id`, `kind`, `amount_minor`, `period_year`, `period_month`, `cash_account_id`, `expense_id`, `notes`, `created_by`, `created_at`, `parent_transaction_id`, `paid_amount_minor`, `reversed_at`, `reversed_by`, `history_hidden_at`, `history_hidden_by`) SELECT `id`, `employee_id`, `kind`, `amount_minor`, `period_year`, `period_month`, `cash_account_id`, `expense_id`, `notes`, `created_by`, `created_at`, `parent_transaction_id`, `paid_amount_minor`, `reversed_at`, `reversed_by`, `history_hidden_at`, `history_hidden_by` FROM `employee_transactions`;
--> statement-breakpoint
DROP TABLE `employee_transactions`;
--> statement-breakpoint
ALTER TABLE `__db03_new_employee_transactions` RENAME TO `employee_transactions`;
--> statement-breakpoint
CREATE INDEX `employee_transactions_employee_idx` ON `employee_transactions` (`employee_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `employee_transactions_parent_idx` ON `employee_transactions` (`parent_transaction_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_employee_transactions_created_at_insert` BEFORE INSERT ON `employee_transactions`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_employee_transactions_created_at_update` BEFORE UPDATE OF `created_at` ON `employee_transactions`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild employees without changing historical timestamp values.
CREATE TABLE `__db03_new_employees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`position` text,
	`phone` text,
	`monthly_salary_minor` integer DEFAULT 0 NOT NULL,
	`hired_at` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__db03_new_employees` (`id`, `name`, `position`, `phone`, `monthly_salary_minor`, `hired_at`, `active`, `notes`, `created_at`) SELECT `id`, `name`, `position`, `phone`, `monthly_salary_minor`, `hired_at`, `active`, `notes`, `created_at` FROM `employees`;
--> statement-breakpoint
DROP TABLE `employees`;
--> statement-breakpoint
ALTER TABLE `__db03_new_employees` RENAME TO `employees`;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_employees_created_at_insert` BEFORE INSERT ON `employees`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_employees_created_at_update` BEFORE UPDATE OF `created_at` ON `employees`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild expense_categories without changing historical timestamp values.
CREATE TABLE `__db03_new_expense_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'variable' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__db03_new_expense_categories` (`id`, `name`, `kind`, `active`, `created_at`) SELECT `id`, `name`, `kind`, `active`, `created_at` FROM `expense_categories`;
--> statement-breakpoint
DROP TABLE `expense_categories`;
--> statement-breakpoint
ALTER TABLE `__db03_new_expense_categories` RENAME TO `expense_categories`;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_expense_categories_created_at_insert` BEFORE INSERT ON `expense_categories`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_expense_categories_created_at_update` BEFORE UPDATE OF `created_at` ON `expense_categories`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild expenses without changing historical timestamp values.
CREATE TABLE `__db03_new_expenses` (
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
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `reversed_at` text, `reversed_by` integer,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_expenses` (`id`, `category_id`, `kind`, `amount_minor`, `order_id`, `cash_account_id`, `description`, `spent_at`, `source`, `source_ref_id`, `created_by`, `created_at`, `reversed_at`, `reversed_by`) SELECT `id`, `category_id`, `kind`, `amount_minor`, `order_id`, `cash_account_id`, `description`, `spent_at`, `source`, `source_ref_id`, `created_by`, `created_at`, `reversed_at`, `reversed_by` FROM `expenses`;
--> statement-breakpoint
DROP TABLE `expenses`;
--> statement-breakpoint
ALTER TABLE `__db03_new_expenses` RENAME TO `expenses`;
--> statement-breakpoint
CREATE INDEX `expenses_date_idx` ON `expenses` (`spent_at`);
--> statement-breakpoint
CREATE INDEX `expenses_order_idx` ON `expenses` (`order_id`);
--> statement-breakpoint
CREATE INDEX `expenses_source_idx` ON `expenses` (`source`,`source_ref_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_expenses_created_at_insert` BEFORE INSERT ON `expenses`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_expenses_created_at_update` BEFORE UPDATE OF `created_at` ON `expenses`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild fifo_layers without changing historical timestamp values.
CREATE TABLE `__db03_new_fifo_layers` (
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
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_fifo_layers` (`id`, `material_id`, `source_kind`, `source_ref_id`, `batch_code`, `qty_received_micro`, `qty_remaining_micro`, `unit_cost_micro`, `received_at`, `seq`, `created_at`) SELECT `id`, `material_id`, `source_kind`, `source_ref_id`, `batch_code`, `qty_received_micro`, `qty_remaining_micro`, `unit_cost_micro`, `received_at`, `seq`, `created_at` FROM `fifo_layers`;
--> statement-breakpoint
DROP TABLE `fifo_layers`;
--> statement-breakpoint
ALTER TABLE `__db03_new_fifo_layers` RENAME TO `fifo_layers`;
--> statement-breakpoint
CREATE INDEX `fifo_layers_material_order_idx` ON `fifo_layers` (`material_id`,`received_at`,`seq`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_fifo_layers_created_at_insert` BEFORE INSERT ON `fifo_layers`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_fifo_layers_created_at_update` BEFORE UPDATE OF `created_at` ON `fifo_layers`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild final_invoice_terms without changing historical timestamp values.
CREATE TABLE `__db03_new_final_invoice_terms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`final_invoice_id` integer NOT NULL,
	`term_index` integer NOT NULL,
	`term_text` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`final_invoice_id`) REFERENCES `final_invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__db03_new_final_invoice_terms` (`id`, `final_invoice_id`, `term_index`, `term_text`, `created_at`) SELECT `id`, `final_invoice_id`, `term_index`, `term_text`, `created_at` FROM `final_invoice_terms`;
--> statement-breakpoint
DROP TABLE `final_invoice_terms`;
--> statement-breakpoint
ALTER TABLE `__db03_new_final_invoice_terms` RENAME TO `final_invoice_terms`;
--> statement-breakpoint
CREATE INDEX `final_invoice_terms_invoice_idx` ON `final_invoice_terms` (`final_invoice_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoice_terms_unique` ON `final_invoice_terms` (`final_invoice_id`,`term_index`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_final_invoice_terms_created_at_insert` BEFORE INSERT ON `final_invoice_terms`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_final_invoice_terms_created_at_update` BEFORE UPDATE OF `created_at` ON `final_invoice_terms`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild final_invoices without changing historical timestamp values.
CREATE TABLE `__db03_new_final_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`customer_id` integer NOT NULL,
	`order_id` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`issued_at` text,
	`issued_by` integer,
	`snapshot` text,
	`subtotal_minor` integer DEFAULT 0 NOT NULL,
	`discount_kind` text DEFAULT 'none' NOT NULL,
	`discount_value` integer DEFAULT 0 NOT NULL,
	`discount_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer DEFAULT 0 NOT NULL,
	`deposit_percent_bp` integer DEFAULT 6000 NOT NULL,
	`deposit_required_minor` integer DEFAULT 0 NOT NULL,
	`requires_installation` integer DEFAULT false NOT NULL,
	`requires_delivery` integer DEFAULT false NOT NULL,
	`address` text,
	`terms_snapshot` text,
	`cancelled_at` text,
	`cancel_reason` text,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `meter_price_minor` integer DEFAULT 0 NOT NULL, `installation_price_minor` integer DEFAULT 0 NOT NULL, `delivery_price_minor` integer DEFAULT 0 NOT NULL, `print_visibility` text, `paid_amount_minor` integer DEFAULT 0 NOT NULL, `initial_cash_account_id` integer, approval_revision INTEGER NOT NULL DEFAULT 0,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_final_invoices` (`id`, `document_number`, `customer_id`, `order_id`, `status`, `issued_at`, `issued_by`, `snapshot`, `subtotal_minor`, `discount_kind`, `discount_value`, `discount_minor`, `total_minor`, `deposit_percent_bp`, `deposit_required_minor`, `requires_installation`, `requires_delivery`, `address`, `terms_snapshot`, `cancelled_at`, `cancel_reason`, `notes`, `created_by`, `created_at`, `meter_price_minor`, `installation_price_minor`, `delivery_price_minor`, `print_visibility`, `paid_amount_minor`, `initial_cash_account_id`, `approval_revision`) SELECT `id`, `document_number`, `customer_id`, `order_id`, `status`, `issued_at`, `issued_by`, `snapshot`, `subtotal_minor`, `discount_kind`, `discount_value`, `discount_minor`, `total_minor`, `deposit_percent_bp`, `deposit_required_minor`, `requires_installation`, `requires_delivery`, `address`, `terms_snapshot`, `cancelled_at`, `cancel_reason`, `notes`, `created_by`, `created_at`, `meter_price_minor`, `installation_price_minor`, `delivery_price_minor`, `print_visibility`, `paid_amount_minor`, `initial_cash_account_id`, `approval_revision` FROM `final_invoices`;
--> statement-breakpoint
DROP TABLE `final_invoices`;
--> statement-breakpoint
ALTER TABLE `__db03_new_final_invoices` RENAME TO `final_invoices`;
--> statement-breakpoint
CREATE INDEX `final_invoices_customer_idx` ON `final_invoices` (`customer_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `final_invoices_document_number_unique` ON `final_invoices` (`document_number`);
--> statement-breakpoint
CREATE INDEX `final_invoices_order_idx` ON `final_invoices` (`order_id`);
--> statement-breakpoint
CREATE INDEX `final_invoices_status_idx` ON `final_invoices` (`status`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_final_invoices_created_at_insert` BEFORE INSERT ON `final_invoices`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_final_invoices_created_at_update` BEFORE UPDATE OF `created_at` ON `final_invoices`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild finished_goods_movements without changing historical timestamp values.
CREATE TABLE `__db03_new_finished_goods_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`kind` text NOT NULL,
	`qty_micro` integer NOT NULL,
	`unit_cost_minor` integer DEFAULT 0 NOT NULL,
	`total_cost_minor` integer DEFAULT 0 NOT NULL,
	`work_sheet_id` integer,
	`order_id` integer,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `reversal_of_movement_id` integer REFERENCES finished_goods_movements(id),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_finished_goods_movements` (`id`, `product_id`, `kind`, `qty_micro`, `unit_cost_minor`, `total_cost_minor`, `work_sheet_id`, `order_id`, `notes`, `created_by`, `created_at`, `reversal_of_movement_id`) SELECT `id`, `product_id`, `kind`, `qty_micro`, `unit_cost_minor`, `total_cost_minor`, `work_sheet_id`, `order_id`, `notes`, `created_by`, `created_at`, `reversal_of_movement_id` FROM `finished_goods_movements`;
--> statement-breakpoint
DROP TABLE `finished_goods_movements`;
--> statement-breakpoint
ALTER TABLE `__db03_new_finished_goods_movements` RENAME TO `finished_goods_movements`;
--> statement-breakpoint
CREATE INDEX `finished_goods_movements_order_idx` ON `finished_goods_movements` (`order_id`);
--> statement-breakpoint
CREATE INDEX `finished_goods_movements_product_idx` ON `finished_goods_movements` (`product_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `finished_goods_movements_reversal_unique` ON `finished_goods_movements` (`reversal_of_movement_id`) WHERE "finished_goods_movements"."reversal_of_movement_id" IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_finished_goods_movements_created_at_insert` BEFORE INSERT ON `finished_goods_movements`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_finished_goods_movements_created_at_update` BEFORE UPDATE OF `created_at` ON `finished_goods_movements`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild inventory_movements without changing historical timestamp values.
CREATE TABLE `__db03_new_inventory_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`material_id` integer NOT NULL,
	`kind` text NOT NULL,
	`qty_micro` integer NOT NULL,
	`order_id` integer,
	`actual_cost_minor` integer DEFAULT 0 NOT NULL,
	`reason` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `source_kind` text, `source_ref_id` integer, `reversal_of_movement_id` integer REFERENCES inventory_movements(id),
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_inventory_movements` (`id`, `material_id`, `kind`, `qty_micro`, `order_id`, `actual_cost_minor`, `reason`, `created_by`, `created_at`, `source_kind`, `source_ref_id`, `reversal_of_movement_id`) SELECT `id`, `material_id`, `kind`, `qty_micro`, `order_id`, `actual_cost_minor`, `reason`, `created_by`, `created_at`, `source_kind`, `source_ref_id`, `reversal_of_movement_id` FROM `inventory_movements`;
--> statement-breakpoint
DROP TABLE `inventory_movements`;
--> statement-breakpoint
ALTER TABLE `__db03_new_inventory_movements` RENAME TO `inventory_movements`;
--> statement-breakpoint
CREATE INDEX `inventory_movements_kind_date_idx` ON `inventory_movements` (`kind`,`created_at`);
--> statement-breakpoint
CREATE INDEX `inventory_movements_material_idx` ON `inventory_movements` (`material_id`);
--> statement-breakpoint
CREATE INDEX `inventory_movements_order_idx` ON `inventory_movements` (`order_id`);
--> statement-breakpoint
CREATE INDEX `inventory_movements_reversal_idx` ON `inventory_movements` (`reversal_of_movement_id`);
--> statement-breakpoint
CREATE INDEX `inventory_movements_source_idx` ON `inventory_movements` (`source_kind`,`source_ref_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_inventory_movements_created_at_insert` BEFORE INSERT ON `inventory_movements`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_inventory_movements_created_at_update` BEFORE UPDATE OF `created_at` ON `inventory_movements`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild machines without changing historical timestamp values.
CREATE TABLE `__db03_new_machines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`costing_unit` text NOT NULL,
	`default_rate_micro` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__db03_new_machines` (`id`, `name`, `costing_unit`, `default_rate_micro`, `active`, `notes`, `created_at`) SELECT `id`, `name`, `costing_unit`, `default_rate_micro`, `active`, `notes`, `created_at` FROM `machines`;
--> statement-breakpoint
DROP TABLE `machines`;
--> statement-breakpoint
ALTER TABLE `__db03_new_machines` RENAME TO `machines`;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_machines_created_at_insert` BEFORE INSERT ON `machines`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_machines_created_at_update` BEFORE UPDATE OF `created_at` ON `machines`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild material_categories without changing historical timestamp values.
CREATE TABLE `__db03_new_material_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`parent_id` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `is_accessory` integer DEFAULT false NOT NULL, `node_kind` text DEFAULT 'legacy_ambiguous' NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `material_categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__db03_new_material_categories` (`id`, `name`, `parent_id`, `sort_order`, `active`, `created_at`, `is_accessory`, `node_kind`) SELECT `id`, `name`, `parent_id`, `sort_order`, `active`, `created_at`, `is_accessory`, `node_kind` FROM `material_categories`;
--> statement-breakpoint
DROP TABLE `material_categories`;
--> statement-breakpoint
ALTER TABLE `__db03_new_material_categories` RENAME TO `material_categories`;
--> statement-breakpoint
CREATE INDEX `material_categories_node_kind_idx` ON `material_categories` (`node_kind`);
--> statement-breakpoint
CREATE INDEX `material_categories_parent_idx` ON `material_categories` (`parent_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_material_categories_created_at_insert` BEFORE INSERT ON `material_categories`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_material_categories_created_at_update` BEFORE UPDATE OF `created_at` ON `material_categories`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild material_remainders without changing historical timestamp values.
CREATE TABLE `__db03_new_material_remainders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`material_id` integer NOT NULL,
	`layer_id` integer,
	`size_micro` integer NOT NULL,
	`source_note` text,
	`available` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`layer_id`) REFERENCES `fifo_layers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_material_remainders` (`id`, `material_id`, `layer_id`, `size_micro`, `source_note`, `available`, `created_at`) SELECT `id`, `material_id`, `layer_id`, `size_micro`, `source_note`, `available`, `created_at` FROM `material_remainders`;
--> statement-breakpoint
DROP TABLE `material_remainders`;
--> statement-breakpoint
ALTER TABLE `__db03_new_material_remainders` RENAME TO `material_remainders`;
--> statement-breakpoint
CREATE INDEX `material_remainders_material_idx` ON `material_remainders` (`material_id`,`available`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_material_remainders_created_at_insert` BEFORE INSERT ON `material_remainders`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_material_remainders_created_at_update` BEFORE UPDATE OF `created_at` ON `material_remainders`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild material_return_allocations without changing historical timestamp values.
CREATE TABLE `__db03_new_material_return_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`return_id` integer NOT NULL,
	`issue_line_id` integer NOT NULL,
	`fifo_allocation_id` integer NOT NULL,
	`return_layer_id` integer NOT NULL,
	`qty_micro` integer NOT NULL,
	`unit_cost_micro` integer NOT NULL,
	`cost_minor` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `material_return_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`return_id`) REFERENCES `material_returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issue_line_id`) REFERENCES `order_material_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fifo_allocation_id`) REFERENCES `fifo_allocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`return_layer_id`) REFERENCES `fifo_layers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_material_return_allocations` (`id`, `event_id`, `return_id`, `issue_line_id`, `fifo_allocation_id`, `return_layer_id`, `qty_micro`, `unit_cost_micro`, `cost_minor`, `created_at`) SELECT `id`, `event_id`, `return_id`, `issue_line_id`, `fifo_allocation_id`, `return_layer_id`, `qty_micro`, `unit_cost_micro`, `cost_minor`, `created_at` FROM `material_return_allocations`;
--> statement-breakpoint
DROP TABLE `material_return_allocations`;
--> statement-breakpoint
ALTER TABLE `__db03_new_material_return_allocations` RENAME TO `material_return_allocations`;
--> statement-breakpoint
CREATE INDEX `material_return_allocations_fifo_idx` ON `material_return_allocations` (`fifo_allocation_id`);
--> statement-breakpoint
CREATE INDEX `material_return_allocations_issue_idx` ON `material_return_allocations` (`issue_line_id`);
--> statement-breakpoint
CREATE INDEX `material_return_allocations_layer_idx` ON `material_return_allocations` (`return_layer_id`);
--> statement-breakpoint
CREATE INDEX `material_return_allocations_return_idx` ON `material_return_allocations` (`return_id`,`id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_material_return_allocations_created_at_insert` BEFORE INSERT ON `material_return_allocations`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_material_return_allocations_created_at_update` BEFORE UPDATE OF `created_at` ON `material_return_allocations`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild material_return_events without changing historical timestamp values.
CREATE TABLE `__db03_new_material_return_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`return_id` integer NOT NULL,
	`kind` text NOT NULL,
	`before_qty_micro` integer NOT NULL,
	`after_qty_micro` integer NOT NULL,
	`delta_qty_micro` integer NOT NULL,
	`cost_effect_minor` integer NOT NULL,
	`movement_id` integer,
	`request_key` text NOT NULL,
	`expected_version` integer NOT NULL,
	`notes_before` text,
	`notes_after` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`return_id`) REFERENCES `material_returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`movement_id`) REFERENCES `inventory_movements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_material_return_events` (`id`, `return_id`, `kind`, `before_qty_micro`, `after_qty_micro`, `delta_qty_micro`, `cost_effect_minor`, `movement_id`, `request_key`, `expected_version`, `notes_before`, `notes_after`, `created_by`, `created_at`) SELECT `id`, `return_id`, `kind`, `before_qty_micro`, `after_qty_micro`, `delta_qty_micro`, `cost_effect_minor`, `movement_id`, `request_key`, `expected_version`, `notes_before`, `notes_after`, `created_by`, `created_at` FROM `material_return_events`;
--> statement-breakpoint
DROP TABLE `material_return_events`;
--> statement-breakpoint
ALTER TABLE `__db03_new_material_return_events` RENAME TO `material_return_events`;
--> statement-breakpoint
CREATE UNIQUE INDEX `material_return_events_request_key_unique` ON `material_return_events` (`request_key`);
--> statement-breakpoint
CREATE INDEX `material_return_events_return_idx` ON `material_return_events` (`return_id`,`id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_material_return_events_created_at_insert` BEFORE INSERT ON `material_return_events`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_material_return_events_created_at_update` BEFORE UPDATE OF `created_at` ON `material_return_events`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild material_returns without changing historical timestamp values.
CREATE TABLE `__db03_new_material_returns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`material_id` integer NOT NULL,
	`quantity_micro` integer NOT NULL,
	`returned_cost_minor` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` integer,
	`updated_at` text,
	`voided_by` integer,
	`voided_at` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_material_returns` (`id`, `order_id`, `material_id`, `quantity_micro`, `returned_cost_minor`, `status`, `notes`, `version`, `created_by`, `created_at`, `updated_by`, `updated_at`, `voided_by`, `voided_at`) SELECT `id`, `order_id`, `material_id`, `quantity_micro`, `returned_cost_minor`, `status`, `notes`, `version`, `created_by`, `created_at`, `updated_by`, `updated_at`, `voided_by`, `voided_at` FROM `material_returns`;
--> statement-breakpoint
DROP TABLE `material_returns`;
--> statement-breakpoint
ALTER TABLE `__db03_new_material_returns` RENAME TO `material_returns`;
--> statement-breakpoint
CREATE INDEX `material_returns_material_idx` ON `material_returns` (`material_id`,`status`);
--> statement-breakpoint
CREATE INDEX `material_returns_order_idx` ON `material_returns` (`order_id`,`status`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_material_returns_created_at_insert` BEFORE INSERT ON `material_returns`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_material_returns_created_at_update` BEFORE UPDATE OF `created_at` ON `material_returns`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild materials without changing historical timestamp values.
CREATE TABLE `__db03_new_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`category_id` integer NOT NULL,
	`unit` text NOT NULL,
	"purchase_unit" text,
	"purchase_unit_factor_micro" integer,
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
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `tracks_dimensions` integer DEFAULT false NOT NULL, `hierarchy_node_id` integer REFERENCES material_categories(id), `creation_key` text, `color_id` integer REFERENCES color_finish_catalog(id),
	FOREIGN KEY (`category_id`) REFERENCES `material_categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_materials` (`id`, `sku`, `name`, `category_id`, `unit`, `purchase_unit`, `purchase_unit_factor_micro`, `dimensions`, `thickness`, `current_market_price_micro`, `pricing_rule`, `commercial_unit_size_micro`, `allows_remainder`, `track_remainder_pieces`, `track_batches`, `supports_color`, `reorder_level_micro`, `notes`, `active`, `created_at`, `tracks_dimensions`, `hierarchy_node_id`, `creation_key`, `color_id`) SELECT `id`, `sku`, `name`, `category_id`, `unit`, `purchase_unit`, `purchase_unit_factor_micro`, `dimensions`, `thickness`, `current_market_price_micro`, `pricing_rule`, `commercial_unit_size_micro`, `allows_remainder`, `track_remainder_pieces`, `track_batches`, `supports_color`, `reorder_level_micro`, `notes`, `active`, `created_at`, `tracks_dimensions`, `hierarchy_node_id`, `creation_key`, `color_id` FROM `materials`;
--> statement-breakpoint
DROP TABLE `materials`;
--> statement-breakpoint
ALTER TABLE `__db03_new_materials` RENAME TO `materials`;
--> statement-breakpoint
CREATE INDEX `materials_category_idx` ON `materials` (`category_id`);
--> statement-breakpoint
CREATE INDEX `materials_color_idx` ON `materials` (`color_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `materials_creation_key_unique` ON `materials` (`creation_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `materials_hierarchy_node_unique` ON `materials` (`hierarchy_node_id`);
--> statement-breakpoint
CREATE INDEX `materials_name_idx` ON `materials` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `materials_sku_unique` ON `materials` (`sku`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_materials_created_at_insert` BEFORE INSERT ON `materials`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_materials_created_at_update` BEFORE UPDATE OF `created_at` ON `materials`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild notification_dismissals without changing historical timestamp values.
CREATE TABLE `__db03_new_notification_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`notification_key` text NOT NULL,
	`dismissed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__db03_new_notification_dismissals` (`id`, `user_id`, `notification_key`, `dismissed_at`) SELECT `id`, `user_id`, `notification_key`, `dismissed_at` FROM `notification_dismissals`;
--> statement-breakpoint
DROP TABLE `notification_dismissals`;
--> statement-breakpoint
ALTER TABLE `__db03_new_notification_dismissals` RENAME TO `notification_dismissals`;
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_dismissals_unique` ON `notification_dismissals` (`user_id`,`notification_key`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_notification_dismissals_dismissed_at_insert` BEFORE INSERT ON `notification_dismissals`
FOR EACH ROW WHEN NEW.`dismissed_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_notification_dismissals_dismissed_at_update` BEFORE UPDATE OF `dismissed_at` ON `notification_dismissals`
FOR EACH ROW WHEN NEW.`dismissed_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild notification_reads without changing historical timestamp values.
CREATE TABLE `__db03_new_notification_reads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`notification_key` text NOT NULL,
	`read_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__db03_new_notification_reads` (`id`, `user_id`, `notification_key`, `read_at`) SELECT `id`, `user_id`, `notification_key`, `read_at` FROM `notification_reads`;
--> statement-breakpoint
DROP TABLE `notification_reads`;
--> statement-breakpoint
ALTER TABLE `__db03_new_notification_reads` RENAME TO `notification_reads`;
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_reads_unique` ON `notification_reads` (`user_id`,`notification_key`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_notification_reads_read_at_insert` BEFORE INSERT ON `notification_reads`
FOR EACH ROW WHEN NEW.`read_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_notification_reads_read_at_update` BEFORE UPDATE OF `read_at` ON `notification_reads`
FOR EACH ROW WHEN NEW.`read_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild order_machine_usage without changing historical timestamp values.
CREATE TABLE `__db03_new_order_machine_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer,
	`work_sheet_id` integer,
	`machine_id` integer NOT NULL,
	`usage_qty_micro` integer NOT NULL,
	`rate_micro` integer NOT NULL,
	`calculated_minor` integer NOT NULL,
	`final_amount_minor` integer NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, reversed_at TEXT, reversed_by INTEGER,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_order_machine_usage` (`id`, `order_id`, `work_sheet_id`, `machine_id`, `usage_qty_micro`, `rate_micro`, `calculated_minor`, `final_amount_minor`, `notes`, `created_at`, `reversed_at`, `reversed_by`) SELECT `id`, `order_id`, `work_sheet_id`, `machine_id`, `usage_qty_micro`, `rate_micro`, `calculated_minor`, `final_amount_minor`, `notes`, `created_at`, `reversed_at`, `reversed_by` FROM `order_machine_usage`;
--> statement-breakpoint
DROP TABLE `order_machine_usage`;
--> statement-breakpoint
ALTER TABLE `__db03_new_order_machine_usage` RENAME TO `order_machine_usage`;
--> statement-breakpoint
CREATE INDEX `order_machine_usage_order_idx` ON `order_machine_usage` (`order_id`);
--> statement-breakpoint
CREATE INDEX `order_machine_usage_sheet_idx` ON `order_machine_usage` (`work_sheet_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_order_machine_usage_created_at_insert` BEFORE INSERT ON `order_machine_usage`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_order_machine_usage_created_at_update` BEFORE UPDATE OF `created_at` ON `order_machine_usage`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild order_material_lines without changing historical timestamp values.
CREATE TABLE `__db03_new_order_material_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer,
	`work_sheet_id` integer,
	`material_id` integer NOT NULL,
	`movement_id` integer,
	`physical_qty_micro` integer NOT NULL,
	`actual_cost_minor` integer NOT NULL,
	`commercial_qty_micro` integer NOT NULL,
	`commercial_value_minor` integer NOT NULL,
	`pricing_rule_used` text NOT NULL,
	`color_code` text,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `status` text DEFAULT 'active' NOT NULL, `reversed_at` text, `reversed_by` integer, `reversal_movement_id` integer REFERENCES inventory_movements(id), `replacement_line_id` integer REFERENCES order_material_lines(id), `correction_of_line_id` integer REFERENCES order_material_lines(id),
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`movement_id`) REFERENCES `inventory_movements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_order_material_lines` (`id`, `order_id`, `work_sheet_id`, `material_id`, `movement_id`, `physical_qty_micro`, `actual_cost_minor`, `commercial_qty_micro`, `commercial_value_minor`, `pricing_rule_used`, `color_code`, `notes`, `created_at`, `status`, `reversed_at`, `reversed_by`, `reversal_movement_id`, `replacement_line_id`, `correction_of_line_id`) SELECT `id`, `order_id`, `work_sheet_id`, `material_id`, `movement_id`, `physical_qty_micro`, `actual_cost_minor`, `commercial_qty_micro`, `commercial_value_minor`, `pricing_rule_used`, `color_code`, `notes`, `created_at`, `status`, `reversed_at`, `reversed_by`, `reversal_movement_id`, `replacement_line_id`, `correction_of_line_id` FROM `order_material_lines`;
--> statement-breakpoint
DROP TABLE `order_material_lines`;
--> statement-breakpoint
ALTER TABLE `__db03_new_order_material_lines` RENAME TO `order_material_lines`;
--> statement-breakpoint
CREATE INDEX `order_material_lines_order_idx` ON `order_material_lines` (`order_id`);
--> statement-breakpoint
CREATE INDEX `order_material_lines_sheet_idx` ON `order_material_lines` (`work_sheet_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_order_material_lines_created_at_insert` BEFORE INSERT ON `order_material_lines`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_order_material_lines_created_at_update` BEFORE UPDATE OF `created_at` ON `order_material_lines`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild orders without changing historical timestamp values.
CREATE TABLE `__db03_new_orders` (
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
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `estimated_material_minor` integer DEFAULT 0 NOT NULL, `estimated_worker_minor` integer DEFAULT 0 NOT NULL, `estimated_machine_minor` integer DEFAULT 0 NOT NULL, `estimated_other_minor` integer DEFAULT 0 NOT NULL, `final_invoice_id` integer REFERENCES final_invoices(id), `meter_price_minor` integer DEFAULT 0 NOT NULL, `installation_price_minor` integer DEFAULT 0 NOT NULL, `delivery_price_minor` integer DEFAULT 0 NOT NULL, archived_at TEXT, archived_by INTEGER,
	FOREIGN KEY (`quotation_id`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_orders` (`id`, `document_number`, `quotation_id`, `customer_id`, `status`, `subtotal_minor`, `discount_minor`, `total_minor`, `deposit_percent_bp`, `deposit_required_minor`, `paid_minor`, `remaining_minor`, `payment_status`, `requires_installation`, `requires_delivery`, `address`, `completed_at`, `cancelled_at`, `cancel_reason`, `terms_snapshot`, `notes`, `created_by`, `created_at`, `estimated_material_minor`, `estimated_worker_minor`, `estimated_machine_minor`, `estimated_other_minor`, `final_invoice_id`, `meter_price_minor`, `installation_price_minor`, `delivery_price_minor`, `archived_at`, `archived_by`) SELECT `id`, `document_number`, `quotation_id`, `customer_id`, `status`, `subtotal_minor`, `discount_minor`, `total_minor`, `deposit_percent_bp`, `deposit_required_minor`, `paid_minor`, `remaining_minor`, `payment_status`, `requires_installation`, `requires_delivery`, `address`, `completed_at`, `cancelled_at`, `cancel_reason`, `terms_snapshot`, `notes`, `created_by`, `created_at`, `estimated_material_minor`, `estimated_worker_minor`, `estimated_machine_minor`, `estimated_other_minor`, `final_invoice_id`, `meter_price_minor`, `installation_price_minor`, `delivery_price_minor`, `archived_at`, `archived_by` FROM `orders`;
--> statement-breakpoint
DROP TABLE `orders`;
--> statement-breakpoint
ALTER TABLE `__db03_new_orders` RENAME TO `orders`;
--> statement-breakpoint
CREATE INDEX orders_archive_list_idx ON orders(archived_at, id);
--> statement-breakpoint
CREATE INDEX `orders_completed_idx` ON `orders` (`completed_at`);
--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_document_number_unique` ON `orders` (`document_number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_final_invoice_unique` ON `orders` (`final_invoice_id`);
--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_orders_created_at_insert` BEFORE INSERT ON `orders`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_orders_created_at_update` BEFORE UPDATE OF `created_at` ON `orders`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild planned_machines without changing historical timestamp values.
CREATE TABLE `__db03_new_planned_machines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quotation_id` integer,
	`order_id` integer,
	`machine_id` integer,
	`machine_name` text NOT NULL,
	`usage_qty_micro` integer DEFAULT 0 NOT NULL,
	`usage_unit` text,
	`estimated_cost_minor` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `work_sheet_id` integer REFERENCES work_sheets(id) ON DELETE cascade, `rate_micro` integer,
	FOREIGN KEY (`quotation_id`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_planned_machines` (`id`, `quotation_id`, `order_id`, `machine_id`, `machine_name`, `usage_qty_micro`, `usage_unit`, `estimated_cost_minor`, `notes`, `created_at`, `work_sheet_id`, `rate_micro`) SELECT `id`, `quotation_id`, `order_id`, `machine_id`, `machine_name`, `usage_qty_micro`, `usage_unit`, `estimated_cost_minor`, `notes`, `created_at`, `work_sheet_id`, `rate_micro` FROM `planned_machines`;
--> statement-breakpoint
DROP TABLE `planned_machines`;
--> statement-breakpoint
ALTER TABLE `__db03_new_planned_machines` RENAME TO `planned_machines`;
--> statement-breakpoint
CREATE INDEX `planned_machines_order_idx` ON `planned_machines` (`order_id`);
--> statement-breakpoint
CREATE INDEX `planned_machines_quotation_idx` ON `planned_machines` (`quotation_id`);
--> statement-breakpoint
CREATE INDEX `planned_machines_sheet_idx` ON `planned_machines` (`work_sheet_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_planned_machines_created_at_insert` BEFORE INSERT ON `planned_machines`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_planned_machines_created_at_update` BEFORE UPDATE OF `created_at` ON `planned_machines`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild planned_materials without changing historical timestamp values.
CREATE TABLE `__db03_new_planned_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quotation_id` integer,
	`order_id` integer,
	`work_sheet_id` integer,
	`material_id` integer,
	`material_name` text NOT NULL,
	`qty_micro` integer NOT NULL,
	`unit` text,
	`dimensions` text,
	`thickness` text,
	`color_code` text,
	`notes` text,
	`estimated_unit_cost_micro` integer DEFAULT 0 NOT NULL,
	`estimated_total_minor` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`quotation_id`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_planned_materials` (`id`, `quotation_id`, `order_id`, `work_sheet_id`, `material_id`, `material_name`, `qty_micro`, `unit`, `dimensions`, `thickness`, `color_code`, `notes`, `estimated_unit_cost_micro`, `estimated_total_minor`, `sort_order`, `created_at`) SELECT `id`, `quotation_id`, `order_id`, `work_sheet_id`, `material_id`, `material_name`, `qty_micro`, `unit`, `dimensions`, `thickness`, `color_code`, `notes`, `estimated_unit_cost_micro`, `estimated_total_minor`, `sort_order`, `created_at` FROM `planned_materials`;
--> statement-breakpoint
DROP TABLE `planned_materials`;
--> statement-breakpoint
ALTER TABLE `__db03_new_planned_materials` RENAME TO `planned_materials`;
--> statement-breakpoint
CREATE INDEX `planned_materials_order_idx` ON `planned_materials` (`order_id`);
--> statement-breakpoint
CREATE INDEX `planned_materials_quotation_idx` ON `planned_materials` (`quotation_id`);
--> statement-breakpoint
CREATE INDEX `planned_materials_sheet_idx` ON `planned_materials` (`work_sheet_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_planned_materials_created_at_insert` BEFORE INSERT ON `planned_materials`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_planned_materials_created_at_update` BEFORE UPDATE OF `created_at` ON `planned_materials`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild planned_order_expenses without changing historical timestamp values.
CREATE TABLE `__db03_new_planned_order_expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer,
	`work_sheet_id` integer,
	`expense_name` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_sheet_id`) REFERENCES `work_sheets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__db03_new_planned_order_expenses` (`id`, `order_id`, `work_sheet_id`, `expense_name`, `amount_minor`, `sort_order`, `created_at`) SELECT `id`, `order_id`, `work_sheet_id`, `expense_name`, `amount_minor`, `sort_order`, `created_at` FROM `planned_order_expenses`;
--> statement-breakpoint
DROP TABLE `planned_order_expenses`;
--> statement-breakpoint
ALTER TABLE `__db03_new_planned_order_expenses` RENAME TO `planned_order_expenses`;
--> statement-breakpoint
CREATE INDEX `planned_order_expenses_order_idx` ON `planned_order_expenses` (`order_id`);
--> statement-breakpoint
CREATE INDEX `planned_order_expenses_sheet_idx` ON `planned_order_expenses` (`work_sheet_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_planned_order_expenses_created_at_insert` BEFORE INSERT ON `planned_order_expenses`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_planned_order_expenses_created_at_update` BEFORE UPDATE OF `created_at` ON `planned_order_expenses`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild planned_workers without changing historical timestamp values.
CREATE TABLE `__db03_new_planned_workers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quotation_id` integer,
	`order_id` integer,
	`worker_id` integer,
	`worker_name` text NOT NULL,
	`estimated_cost_minor` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `work_sheet_id` integer REFERENCES work_sheets(id) ON DELETE cascade, `commission_mode` text DEFAULT 'estimated' NOT NULL, `meter_rate_micro` integer, `meter_qty_micro` integer,
	FOREIGN KEY (`quotation_id`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_planned_workers` (`id`, `quotation_id`, `order_id`, `worker_id`, `worker_name`, `estimated_cost_minor`, `notes`, `created_at`, `work_sheet_id`, `commission_mode`, `meter_rate_micro`, `meter_qty_micro`) SELECT `id`, `quotation_id`, `order_id`, `worker_id`, `worker_name`, `estimated_cost_minor`, `notes`, `created_at`, `work_sheet_id`, `commission_mode`, `meter_rate_micro`, `meter_qty_micro` FROM `planned_workers`;
--> statement-breakpoint
DROP TABLE `planned_workers`;
--> statement-breakpoint
ALTER TABLE `__db03_new_planned_workers` RENAME TO `planned_workers`;
--> statement-breakpoint
CREATE INDEX `planned_workers_order_idx` ON `planned_workers` (`order_id`);
--> statement-breakpoint
CREATE INDEX `planned_workers_quotation_idx` ON `planned_workers` (`quotation_id`);
--> statement-breakpoint
CREATE INDEX `planned_workers_sheet_idx` ON `planned_workers` (`work_sheet_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_planned_workers_created_at_insert` BEFORE INSERT ON `planned_workers`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_planned_workers_created_at_update` BEFORE UPDATE OF `created_at` ON `planned_workers`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild product_commission_lines without changing historical timestamp values.
CREATE TABLE `__db03_new_product_commission_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`worker_id` integer,
	`amount_minor` integer NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_product_commission_lines` (`id`, `product_id`, `worker_id`, `amount_minor`, `notes`, `created_at`) SELECT `id`, `product_id`, `worker_id`, `amount_minor`, `notes`, `created_at` FROM `product_commission_lines`;
--> statement-breakpoint
DROP TABLE `product_commission_lines`;
--> statement-breakpoint
ALTER TABLE `__db03_new_product_commission_lines` RENAME TO `product_commission_lines`;
--> statement-breakpoint
CREATE INDEX `product_commission_lines_product_idx` ON `product_commission_lines` (`product_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_product_commission_lines_created_at_insert` BEFORE INSERT ON `product_commission_lines`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_product_commission_lines_created_at_update` BEFORE UPDATE OF `created_at` ON `product_commission_lines`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild product_machine_lines without changing historical timestamp values.
CREATE TABLE `__db03_new_product_machine_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`machine_id` integer NOT NULL,
	`usage_qty_micro` integer NOT NULL,
	`rate_micro` integer,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_product_machine_lines` (`id`, `product_id`, `machine_id`, `usage_qty_micro`, `rate_micro`, `notes`, `created_at`) SELECT `id`, `product_id`, `machine_id`, `usage_qty_micro`, `rate_micro`, `notes`, `created_at` FROM `product_machine_lines`;
--> statement-breakpoint
DROP TABLE `product_machine_lines`;
--> statement-breakpoint
ALTER TABLE `__db03_new_product_machine_lines` RENAME TO `product_machine_lines`;
--> statement-breakpoint
CREATE INDEX `product_machine_lines_product_idx` ON `product_machine_lines` (`product_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_product_machine_lines_created_at_insert` BEFORE INSERT ON `product_machine_lines`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_product_machine_lines_created_at_update` BEFORE UPDATE OF `created_at` ON `product_machine_lines`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild products without changing historical timestamp values.
CREATE TABLE `__db03_new_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`default_price_minor` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__db03_new_products` (`id`, `code`, `name`, `description`, `default_price_minor`, `active`, `created_at`) SELECT `id`, `code`, `name`, `description`, `default_price_minor`, `active`, `created_at` FROM `products`;
--> statement-breakpoint
DROP TABLE `products`;
--> statement-breakpoint
ALTER TABLE `__db03_new_products` RENAME TO `products`;
--> statement-breakpoint
CREATE UNIQUE INDEX `products_code_unique` ON `products` (`code`);
--> statement-breakpoint
CREATE INDEX `products_name_idx` ON `products` (`name`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_products_created_at_insert` BEFORE INSERT ON `products`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_products_created_at_update` BEFORE UPDATE OF `created_at` ON `products`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild profit_withdrawals without changing historical timestamp values.
CREATE TABLE `__db03_new_profit_withdrawals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`amount_minor` integer NOT NULL,
	`withdrawn_at` text NOT NULL,
	`person` text,
	`notes` text,
	`cash_account_id` integer,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`cash_account_id`) REFERENCES `cash_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_profit_withdrawals` (`id`, `amount_minor`, `withdrawn_at`, `person`, `notes`, `cash_account_id`, `created_by`, `created_at`) SELECT `id`, `amount_minor`, `withdrawn_at`, `person`, `notes`, `cash_account_id`, `created_by`, `created_at` FROM `profit_withdrawals`;
--> statement-breakpoint
DROP TABLE `profit_withdrawals`;
--> statement-breakpoint
ALTER TABLE `__db03_new_profit_withdrawals` RENAME TO `profit_withdrawals`;
--> statement-breakpoint
CREATE INDEX `profit_withdrawals_date_idx` ON `profit_withdrawals` (`withdrawn_at`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_profit_withdrawals_created_at_insert` BEFORE INSERT ON `profit_withdrawals`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_profit_withdrawals_created_at_update` BEFORE UPDATE OF `created_at` ON `profit_withdrawals`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild purchases without changing historical timestamp values.
CREATE TABLE `__db03_new_purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`supplier_id` integer NOT NULL,
	`purchase_date` text NOT NULL,
	`total_minor` integer NOT NULL,
	`paid_minor` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `customer_order_id` integer REFERENCES orders(id),
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_purchases` (`id`, `document_number`, `supplier_id`, `purchase_date`, `total_minor`, `paid_minor`, `notes`, `created_by`, `created_at`, `customer_order_id`) SELECT `id`, `document_number`, `supplier_id`, `purchase_date`, `total_minor`, `paid_minor`, `notes`, `created_by`, `created_at`, `customer_order_id` FROM `purchases`;
--> statement-breakpoint
DROP TABLE `purchases`;
--> statement-breakpoint
ALTER TABLE `__db03_new_purchases` RENAME TO `purchases`;
--> statement-breakpoint
CREATE INDEX `purchases_customer_order_idx` ON `purchases` (`customer_order_id`);
--> statement-breakpoint
CREATE INDEX `purchases_date_idx` ON `purchases` (`purchase_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_document_number_unique` ON `purchases` (`document_number`);
--> statement-breakpoint
CREATE INDEX `purchases_supplier_idx` ON `purchases` (`supplier_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_purchases_created_at_insert` BEFORE INSERT ON `purchases`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_purchases_created_at_update` BEFORE UPDATE OF `created_at` ON `purchases`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild quotations without changing historical timestamp values.
CREATE TABLE `__db03_new_quotations` (
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
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `estimated_material_minor` integer DEFAULT 0 NOT NULL, `estimated_worker_minor` integer DEFAULT 0 NOT NULL, `estimated_machine_minor` integer DEFAULT 0 NOT NULL, `estimated_other_minor` integer DEFAULT 0 NOT NULL, `meter_price_minor` integer DEFAULT 0 NOT NULL, `installation_price_minor` integer DEFAULT 0 NOT NULL, `delivery_price_minor` integer DEFAULT 0 NOT NULL, `print_visibility` text, `customer_snapshot` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_quotations` (`id`, `document_number`, `customer_id`, `status`, `issued_at`, `valid_until`, `subtotal_minor`, `discount_kind`, `discount_value`, `discount_minor`, `total_minor`, `deposit_percent_bp`, `deposit_required_minor`, `remaining_minor`, `requires_installation`, `requires_delivery`, `terms_snapshot`, `revision_of`, `notes`, `created_by`, `created_at`, `estimated_material_minor`, `estimated_worker_minor`, `estimated_machine_minor`, `estimated_other_minor`, `meter_price_minor`, `installation_price_minor`, `delivery_price_minor`, `print_visibility`, `customer_snapshot`) SELECT `id`, `document_number`, `customer_id`, `status`, `issued_at`, `valid_until`, `subtotal_minor`, `discount_kind`, `discount_value`, `discount_minor`, `total_minor`, `deposit_percent_bp`, `deposit_required_minor`, `remaining_minor`, `requires_installation`, `requires_delivery`, `terms_snapshot`, `revision_of`, `notes`, `created_by`, `created_at`, `estimated_material_minor`, `estimated_worker_minor`, `estimated_machine_minor`, `estimated_other_minor`, `meter_price_minor`, `installation_price_minor`, `delivery_price_minor`, `print_visibility`, `customer_snapshot` FROM `quotations`;
--> statement-breakpoint
DROP TABLE `quotations`;
--> statement-breakpoint
ALTER TABLE `__db03_new_quotations` RENAME TO `quotations`;
--> statement-breakpoint
CREATE INDEX `quotations_customer_idx` ON `quotations` (`customer_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `quotations_document_number_unique` ON `quotations` (`document_number`);
--> statement-breakpoint
CREATE INDEX `quotations_status_idx` ON `quotations` (`status`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_quotations_created_at_insert` BEFORE INSERT ON `quotations`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_quotations_created_at_update` BEFORE UPDATE OF `created_at` ON `quotations`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild recurring_expense_amounts without changing historical timestamp values.
CREATE TABLE `__db03_new_recurring_expense_amounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recurring_expense_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`effective_from` text NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`recurring_expense_id`) REFERENCES `recurring_expenses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__db03_new_recurring_expense_amounts` (`id`, `recurring_expense_id`, `amount_minor`, `effective_from`, `notes`, `created_by`, `created_at`) SELECT `id`, `recurring_expense_id`, `amount_minor`, `effective_from`, `notes`, `created_by`, `created_at` FROM `recurring_expense_amounts`;
--> statement-breakpoint
DROP TABLE `recurring_expense_amounts`;
--> statement-breakpoint
ALTER TABLE `__db03_new_recurring_expense_amounts` RENAME TO `recurring_expense_amounts`;
--> statement-breakpoint
CREATE INDEX `recurring_expense_amounts_series_idx` ON `recurring_expense_amounts` (`recurring_expense_id`,`effective_from`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_recurring_expense_amounts_created_at_insert` BEFORE INSERT ON `recurring_expense_amounts`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_recurring_expense_amounts_created_at_update` BEFORE UPDATE OF `created_at` ON `recurring_expense_amounts`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild recurring_expenses without changing historical timestamp values.
CREATE TABLE `__db03_new_recurring_expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer,
	`description` text NOT NULL,
	`cash_account_id` integer,
	`start_date` text NOT NULL,
	`end_date` text,
	`active` integer DEFAULT true NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_account_id`) REFERENCES `cash_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_recurring_expenses` (`id`, `category_id`, `description`, `cash_account_id`, `start_date`, `end_date`, `active`, `created_by`, `created_at`) SELECT `id`, `category_id`, `description`, `cash_account_id`, `start_date`, `end_date`, `active`, `created_by`, `created_at` FROM `recurring_expenses`;
--> statement-breakpoint
DROP TABLE `recurring_expenses`;
--> statement-breakpoint
ALTER TABLE `__db03_new_recurring_expenses` RENAME TO `recurring_expenses`;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_recurring_expenses_created_at_insert` BEFORE INSERT ON `recurring_expenses`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_recurring_expenses_created_at_update` BEFORE UPDATE OF `created_at` ON `recurring_expenses`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild releases without changing historical timestamp values.
CREATE TABLE `__db03_new_releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`order_id` integer NOT NULL,
	`kind` text NOT NULL,
	`authorized_at` text NOT NULL,
	`address` text,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, `show_paid_exit_sentence` integer DEFAULT true, `authorization_type` text, `order_total_minor_at_issue` integer, `paid_minor_at_issue` integer, `remaining_minor_at_issue` integer, `unpaid_override_reason` text, status TEXT NOT NULL DEFAULT 'active', reversed_at TEXT, reversed_by INTEGER, document_snapshot TEXT,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_releases` (`id`, `document_number`, `order_id`, `kind`, `authorized_at`, `address`, `notes`, `created_by`, `created_at`, `show_paid_exit_sentence`, `authorization_type`, `order_total_minor_at_issue`, `paid_minor_at_issue`, `remaining_minor_at_issue`, `unpaid_override_reason`, `status`, `reversed_at`, `reversed_by`, `document_snapshot`) SELECT `id`, `document_number`, `order_id`, `kind`, `authorized_at`, `address`, `notes`, `created_by`, `created_at`, `show_paid_exit_sentence`, `authorization_type`, `order_total_minor_at_issue`, `paid_minor_at_issue`, `remaining_minor_at_issue`, `unpaid_override_reason`, `status`, `reversed_at`, `reversed_by`, `document_snapshot` FROM `releases`;
--> statement-breakpoint
DROP TABLE `releases`;
--> statement-breakpoint
ALTER TABLE `__db03_new_releases` RENAME TO `releases`;
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_document_number_unique` ON `releases` (`document_number`);
--> statement-breakpoint
CREATE INDEX `releases_order_idx` ON `releases` (`order_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_releases_created_at_insert` BEFORE INSERT ON `releases`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_releases_created_at_update` BEFORE UPDATE OF `created_at` ON `releases`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild remember_tokens without changing historical timestamp values.
CREATE TABLE `__db03_new_remember_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__db03_new_remember_tokens` (`id`, `user_id`, `token_hash`, `created_at`, `expires_at`, `last_used_at`) SELECT `id`, `user_id`, `token_hash`, `created_at`, `expires_at`, `last_used_at` FROM `remember_tokens`;
--> statement-breakpoint
DROP TABLE `remember_tokens`;
--> statement-breakpoint
ALTER TABLE `__db03_new_remember_tokens` RENAME TO `remember_tokens`;
--> statement-breakpoint
CREATE UNIQUE INDEX `remember_tokens_token_hash_unique` ON `remember_tokens` (`token_hash`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_remember_tokens_created_at_insert` BEFORE INSERT ON `remember_tokens`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_remember_tokens_created_at_update` BEFORE UPDATE OF `created_at` ON `remember_tokens`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild roles without changing historical timestamp values.
CREATE TABLE `__db03_new_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__db03_new_roles` (`id`, `name`, `is_admin`, `created_at`) SELECT `id`, `name`, `is_admin`, `created_at` FROM `roles`;
--> statement-breakpoint
DROP TABLE `roles`;
--> statement-breakpoint
ALTER TABLE `__db03_new_roles` RENAME TO `roles`;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_roles_created_at_insert` BEFORE INSERT ON `roles`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_roles_created_at_update` BEFORE UPDATE OF `created_at` ON `roles`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild savings_allocations without changing historical timestamp values.
CREATE TABLE `__db03_new_savings_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`period_year` integer NOT NULL,
	`period_month` integer NOT NULL,
	`net_profit_minor` integer NOT NULL,
	`rate_bp` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`confirmed_at` text NOT NULL,
	`confirmed_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__db03_new_savings_allocations` (`id`, `period_year`, `period_month`, `net_profit_minor`, `rate_bp`, `amount_minor`, `confirmed_at`, `confirmed_by`, `created_at`) SELECT `id`, `period_year`, `period_month`, `net_profit_minor`, `rate_bp`, `amount_minor`, `confirmed_at`, `confirmed_by`, `created_at` FROM `savings_allocations`;
--> statement-breakpoint
DROP TABLE `savings_allocations`;
--> statement-breakpoint
ALTER TABLE `__db03_new_savings_allocations` RENAME TO `savings_allocations`;
--> statement-breakpoint
CREATE INDEX `savings_allocations_period_idx` ON `savings_allocations` (`period_year`,`period_month`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_savings_allocations_created_at_insert` BEFORE INSERT ON `savings_allocations`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_savings_allocations_created_at_update` BEFORE UPDATE OF `created_at` ON `savings_allocations`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild savings_transactions without changing historical timestamp values.
CREATE TABLE `__db03_new_savings_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`allocation_id` integer,
	`cash_account_id` integer,
	`notes` text,
	`occurred_at` text NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`allocation_id`) REFERENCES `savings_allocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_account_id`) REFERENCES `cash_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_savings_transactions` (`id`, `kind`, `amount_minor`, `allocation_id`, `cash_account_id`, `notes`, `occurred_at`, `created_by`, `created_at`) SELECT `id`, `kind`, `amount_minor`, `allocation_id`, `cash_account_id`, `notes`, `occurred_at`, `created_by`, `created_at` FROM `savings_transactions`;
--> statement-breakpoint
DROP TABLE `savings_transactions`;
--> statement-breakpoint
ALTER TABLE `__db03_new_savings_transactions` RENAME TO `savings_transactions`;
--> statement-breakpoint
CREATE INDEX `savings_transactions_date_idx` ON `savings_transactions` (`occurred_at`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_savings_transactions_created_at_insert` BEFORE INSERT ON `savings_transactions`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_savings_transactions_created_at_update` BEFORE UPDATE OF `created_at` ON `savings_transactions`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild supplier_payments without changing historical timestamp values.
CREATE TABLE `__db03_new_supplier_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`supplier_id` integer NOT NULL,
	`purchase_id` integer,
	`amount_minor` integer NOT NULL,
	`cash_account_id` integer,
	`paid_at` text NOT NULL,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_supplier_payments` (`id`, `supplier_id`, `purchase_id`, `amount_minor`, `cash_account_id`, `paid_at`, `notes`, `created_by`, `created_at`) SELECT `id`, `supplier_id`, `purchase_id`, `amount_minor`, `cash_account_id`, `paid_at`, `notes`, `created_by`, `created_at` FROM `supplier_payments`;
--> statement-breakpoint
DROP TABLE `supplier_payments`;
--> statement-breakpoint
ALTER TABLE `__db03_new_supplier_payments` RENAME TO `supplier_payments`;
--> statement-breakpoint
CREATE INDEX `supplier_payments_supplier_idx` ON `supplier_payments` (`supplier_id`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_supplier_payments_created_at_insert` BEFORE INSERT ON `supplier_payments`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_supplier_payments_created_at_update` BEFORE UPDATE OF `created_at` ON `supplier_payments`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild suppliers without changing historical timestamp values.
CREATE TABLE `__db03_new_suppliers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`address` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__db03_new_suppliers` (`id`, `name`, `phone`, `address`, `notes`, `active`, `created_at`) SELECT `id`, `name`, `phone`, `address`, `notes`, `active`, `created_at` FROM `suppliers`;
--> statement-breakpoint
DROP TABLE `suppliers`;
--> statement-breakpoint
ALTER TABLE `__db03_new_suppliers` RENAME TO `suppliers`;
--> statement-breakpoint
CREATE INDEX `suppliers_name_idx` ON `suppliers` (`name`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_suppliers_created_at_insert` BEFORE INSERT ON `suppliers`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_suppliers_created_at_update` BEFORE UPDATE OF `created_at` ON `suppliers`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild uncollected_products without changing historical timestamp values.
CREATE TABLE `__db03_new_uncollected_products` (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_order_id INTEGER NOT NULL REFERENCES orders(id),
  source_order_number TEXT NOT NULL,
  source_order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  source_invoice_id INTEGER REFERENCES final_invoices(id),
  source_invoice_line_id INTEGER REFERENCES final_invoice_lines(id),
  source_work_sheet_id INTEGER REFERENCES work_sheets(id),
  source_work_sheet_number TEXT,
  name TEXT NOT NULL,
  description TEXT,
  specifications TEXT,
  dimensions TEXT,
  quantity_micro INTEGER NOT NULL DEFAULT 0,
  original_unit_price_minor INTEGER NOT NULL DEFAULT 0,
  original_line_total_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_method TEXT NOT NULL,
  cost_basis_order_total_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_material_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_machine_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_worker_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_delivery_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_expense_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',
  transferred_at TEXT NOT NULL,
  transferred_by INTEGER,
  cancel_reason TEXT,
  reserved_invoice_id INTEGER REFERENCES final_invoices(id),
  sold_invoice_id INTEGER REFERENCES final_invoices(id),
  sold_order_id INTEGER REFERENCES orders(id),
  sold_at TEXT,
  sold_price_minor INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
, `resumed_at` text, `resumed_by` integer, `resume_request_key` text);
--> statement-breakpoint
INSERT INTO `__db03_new_uncollected_products` (`id`, `source_order_id`, `source_order_number`, `source_order_line_id`, `source_invoice_id`, `source_invoice_line_id`, `source_work_sheet_id`, `source_work_sheet_number`, `name`, `description`, `specifications`, `dimensions`, `quantity_micro`, `original_unit_price_minor`, `original_line_total_minor`, `cost_basis_minor`, `cost_basis_method`, `cost_basis_order_total_minor`, `cost_basis_material_minor`, `cost_basis_machine_minor`, `cost_basis_worker_minor`, `cost_basis_delivery_minor`, `cost_basis_expense_minor`, `status`, `transferred_at`, `transferred_by`, `cancel_reason`, `reserved_invoice_id`, `sold_invoice_id`, `sold_order_id`, `sold_at`, `sold_price_minor`, `notes`, `created_at`, `resumed_at`, `resumed_by`, `resume_request_key`) SELECT `id`, `source_order_id`, `source_order_number`, `source_order_line_id`, `source_invoice_id`, `source_invoice_line_id`, `source_work_sheet_id`, `source_work_sheet_number`, `name`, `description`, `specifications`, `dimensions`, `quantity_micro`, `original_unit_price_minor`, `original_line_total_minor`, `cost_basis_minor`, `cost_basis_method`, `cost_basis_order_total_minor`, `cost_basis_material_minor`, `cost_basis_machine_minor`, `cost_basis_worker_minor`, `cost_basis_delivery_minor`, `cost_basis_expense_minor`, `status`, `transferred_at`, `transferred_by`, `cancel_reason`, `reserved_invoice_id`, `sold_invoice_id`, `sold_order_id`, `sold_at`, `sold_price_minor`, `notes`, `created_at`, `resumed_at`, `resumed_by`, `resume_request_key` FROM `uncollected_products`;
--> statement-breakpoint
DROP TABLE `uncollected_products`;
--> statement-breakpoint
ALTER TABLE `__db03_new_uncollected_products` RENAME TO `uncollected_products`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uncollected_products_resume_request_uq` ON `uncollected_products` (`resume_request_key`);
--> statement-breakpoint
CREATE INDEX uncollected_products_sold_invoice_idx ON uncollected_products(sold_invoice_id);
--> statement-breakpoint
CREATE UNIQUE INDEX uncollected_products_source_line_uq ON uncollected_products(source_order_line_id);
--> statement-breakpoint
CREATE INDEX uncollected_products_source_order_idx ON uncollected_products(source_order_id);
--> statement-breakpoint
CREATE INDEX uncollected_products_status_idx ON uncollected_products(status);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_uncollected_products_created_at_insert` BEFORE INSERT ON `uncollected_products`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_uncollected_products_created_at_update` BEFORE UPDATE OF `created_at` ON `uncollected_products`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild users without changing historical timestamp values.
CREATE TABLE `__db03_new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`full_name` text NOT NULL,
	`role_id` integer,
	`active` integer DEFAULT true NOT NULL,
	`theme` text DEFAULT 'light' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text, `avatar_file_name` text,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_users` (`id`, `username`, `password_hash`, `full_name`, `role_id`, `active`, `theme`, `created_at`, `deleted_at`, `avatar_file_name`) SELECT `id`, `username`, `password_hash`, `full_name`, `role_id`, `active`, `theme`, `created_at`, `deleted_at`, `avatar_file_name` FROM `users`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `__db03_new_users` RENAME TO `users`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_users_created_at_insert` BEFORE INSERT ON `users`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_users_created_at_update` BEFORE UPDATE OF `created_at` ON `users`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild work_sheets without changing historical timestamp values.
CREATE TABLE `__db03_new_work_sheets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_number` text NOT NULL,
	`order_id` integer,
	`product_id` integer,
	`quantity_micro` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`issued_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`cancelled_at` text,
	`cancel_reason` text,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, reversed_at TEXT, reversed_by INTEGER, document_snapshot TEXT,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_work_sheets` (`id`, `document_number`, `order_id`, `product_id`, `quantity_micro`, `status`, `issued_at`, `started_at`, `completed_at`, `cancelled_at`, `cancel_reason`, `notes`, `created_by`, `created_at`, `reversed_at`, `reversed_by`, `document_snapshot`) SELECT `id`, `document_number`, `order_id`, `product_id`, `quantity_micro`, `status`, `issued_at`, `started_at`, `completed_at`, `cancelled_at`, `cancel_reason`, `notes`, `created_by`, `created_at`, `reversed_at`, `reversed_by`, `document_snapshot` FROM `work_sheets`;
--> statement-breakpoint
DROP TABLE `work_sheets`;
--> statement-breakpoint
ALTER TABLE `__db03_new_work_sheets` RENAME TO `work_sheets`;
--> statement-breakpoint
CREATE UNIQUE INDEX `work_sheets_document_number_unique` ON `work_sheets` (`document_number`);
--> statement-breakpoint
CREATE INDEX `work_sheets_order_idx` ON `work_sheets` (`order_id`);
--> statement-breakpoint
CREATE INDEX `work_sheets_product_idx` ON `work_sheets` (`product_id`);
--> statement-breakpoint
CREATE INDEX `work_sheets_status_idx` ON `work_sheets` (`status`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_work_sheets_created_at_insert` BEFORE INSERT ON `work_sheets`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_work_sheets_created_at_update` BEFORE UPDATE OF `created_at` ON `work_sheets`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild worker_transactions without changing historical timestamp values.
CREATE TABLE `__db03_new_worker_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worker_id` integer NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`order_id` integer,
	`cash_account_id` integer,
	`notes` text,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL, reversal_of_transaction_id INTEGER REFERENCES worker_transactions(id),
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__db03_new_worker_transactions` (`id`, `worker_id`, `kind`, `amount_minor`, `order_id`, `cash_account_id`, `notes`, `created_by`, `created_at`, `reversal_of_transaction_id`) SELECT `id`, `worker_id`, `kind`, `amount_minor`, `order_id`, `cash_account_id`, `notes`, `created_by`, `created_at`, `reversal_of_transaction_id` FROM `worker_transactions`;
--> statement-breakpoint
DROP TABLE `worker_transactions`;
--> statement-breakpoint
ALTER TABLE `__db03_new_worker_transactions` RENAME TO `worker_transactions`;
--> statement-breakpoint
CREATE UNIQUE INDEX worker_transactions_reversal_unique ON worker_transactions(reversal_of_transaction_id) WHERE reversal_of_transaction_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `worker_transactions_worker_idx` ON `worker_transactions` (`worker_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `db03_reject_worker_transactions_created_at_insert` BEFORE INSERT ON `worker_transactions`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_worker_transactions_created_at_update` BEFORE UPDATE OF `created_at` ON `worker_transactions`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
-- DB-03: rebuild workers without changing historical timestamp values.
CREATE TABLE `__db03_new_workers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`default_method` text DEFAULT 'fixed' NOT NULL,
	`default_costing_unit` text,
	`default_rate_micro` integer,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__db03_new_workers` (`id`, `name`, `phone`, `default_method`, `default_costing_unit`, `default_rate_micro`, `active`, `notes`, `created_at`) SELECT `id`, `name`, `phone`, `default_method`, `default_costing_unit`, `default_rate_micro`, `active`, `notes`, `created_at` FROM `workers`;
--> statement-breakpoint
DROP TABLE `workers`;
--> statement-breakpoint
ALTER TABLE `__db03_new_workers` RENAME TO `workers`;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_workers_created_at_insert` BEFORE INSERT ON `workers`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END;
--> statement-breakpoint
CREATE TRIGGER `db03_reject_workers_created_at_update` BEFORE UPDATE OF `created_at` ON `workers`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-03 invalid literal timestamp');
END
