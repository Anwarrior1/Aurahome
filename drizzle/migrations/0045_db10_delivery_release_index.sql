-- DB-10: set-based exit-permit completion, reversal-token and awaiting-completion reads look up deliveries by permit.
CREATE INDEX `deliveries_release_idx` ON `deliveries` (`release_id`);
