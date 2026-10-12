/*
 Users/Roles independence fix.

 `deleteUser`'s tombstone path (migration 0012) kept a referenced user's
 row for historical/audit attribution but left `role_id` pointing at its
 role unchanged. Since `role_id` was NOT NULL with a real, enforced FK to
 `roles.id`, a tombstoned user permanently blocked deleting that role —
 SQLite refuses the DELETE while any row, tombstoned or not, still
 references it — even though the user is gone from every active listing
 and the role's live "assigned users" is genuinely zero.

 SQLite cannot drop NOT NULL from a column directly, so `users` is
 rebuilt (the same data-preserving pattern migrations 0001/0009 already
 used) with `role_id` nullable. Every existing row is copied forward
 with its id, username, password, name, active flag, theme and
 timestamps untouched — the ONLY thing that changes is `role_id` on a
 row that is ALREADY tombstoned, which is repaired to NULL here as part
 of the same copy: which role a deleted user once held remains fully
 recoverable from that user's own `users.delete` audit_log event (its
 `details.roleId`), never from this live, FK-enforced column. A LIVE
 user's role_id is never touched by this migration.

 Application-level behaviour is unchanged: createUser/updateUser still
 always require and validate a real role for every live user — only a
 tombstoned row's relationship to its old role is ever null.
*/

PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`full_name` text NOT NULL,
	`role_id` integer,
	`active` integer DEFAULT true NOT NULL,
	`theme` text DEFAULT 'light' NOT NULL,
	`created_at` text DEFAULT 'CURRENT_TIMESTAMP' NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_users`
	(`id`, `username`, `password_hash`, `full_name`, `role_id`, `active`, `theme`, `created_at`, `deleted_at`)
SELECT
	`id`, `username`, `password_hash`, `full_name`,
	CASE WHEN `deleted_at` IS NOT NULL THEN NULL ELSE `role_id` END,
	`active`, `theme`, `created_at`, `deleted_at`
FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint

PRAGMA foreign_keys=ON;
