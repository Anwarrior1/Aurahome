CREATE TABLE `financial_command_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`command_scope` text NOT NULL,
	`request_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_by` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`completed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `financial_command_requests_scope_key_uq` ON `financial_command_requests` (`command_scope`,`request_key`);--> statement-breakpoint
CREATE INDEX `financial_command_requests_created_at_idx` ON `financial_command_requests` (`created_at`);--> statement-breakpoint
CREATE TRIGGER `db05_reject_financial_command_request_timestamp_insert`
BEFORE INSERT ON `financial_command_requests`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
  OR NEW.`completed_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-05 invalid literal timestamp');
END;--> statement-breakpoint
CREATE TRIGGER `db05_reject_financial_command_request_timestamp_update`
BEFORE UPDATE OF `created_at`, `completed_at` ON `financial_command_requests`
FOR EACH ROW WHEN NEW.`created_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
  OR NEW.`completed_at` IN ('CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME')
BEGIN
	SELECT RAISE(ABORT, 'DB-05 invalid literal timestamp');
END;
