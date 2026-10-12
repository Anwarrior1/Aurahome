-- CC03: a deleted (tombstoned) user no longer reserves its username. Live usernames stay unique.
-- Existing rows are already globally unique, so the partial index always builds on upgrade.
DROP INDEX IF EXISTS `users_username_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_live_unique` ON `users` (`username`) WHERE "users"."deleted_at" IS NULL;