-- CC04: a production commission earning names the exact labour assignment it recognises.
-- Nullable: historical earnings keep NULL and are never re-linked or reinterpreted.
ALTER TABLE `worker_transactions` ADD `assignment_id` integer REFERENCES order_worker_assignments(id);--> statement-breakpoint
CREATE UNIQUE INDEX `worker_transactions_assignment_earning_unique` ON `worker_transactions` (`assignment_id`) WHERE "worker_transactions"."assignment_id" IS NOT NULL;