DROP INDEX IF EXISTS `cash_transactions_account_idx`;--> statement-breakpoint
CREATE INDEX `cash_transactions_account_idx` ON `cash_transactions` (`account_id`,`occurred_at`,`direction`,`amount_minor`);
