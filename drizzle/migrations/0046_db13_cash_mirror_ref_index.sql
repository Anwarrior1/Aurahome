-- DB-13: every source correction locates its cash mirror by (ref_table, ref_id); without this the lookup scans the whole cash ledger.
CREATE INDEX `cash_transactions_ref_idx` ON `cash_transactions` (`ref_table`,`ref_id`);
