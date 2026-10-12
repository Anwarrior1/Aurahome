ALTER TABLE orders ADD COLUMN archived_at TEXT;
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN archived_by INTEGER;
--> statement-breakpoint
CREATE INDEX orders_archive_list_idx ON orders(archived_at, id);
--> statement-breakpoint
ALTER TABLE order_lines ADD COLUMN superseded_at TEXT;
--> statement-breakpoint
ALTER TABLE final_invoices ADD COLUMN approval_revision INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE invoice_approval_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES final_invoices(id),
  revision INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX invoice_approval_history_revision_unique ON invoice_approval_history(invoice_id, revision);
--> statement-breakpoint
ALTER TABLE work_sheets ADD COLUMN reversed_at TEXT;
--> statement-breakpoint
ALTER TABLE work_sheets ADD COLUMN reversed_by INTEGER;
--> statement-breakpoint
ALTER TABLE work_sheets ADD COLUMN document_snapshot TEXT;
--> statement-breakpoint
ALTER TABLE releases ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE releases ADD COLUMN reversed_at TEXT;
--> statement-breakpoint
ALTER TABLE releases ADD COLUMN reversed_by INTEGER;
--> statement-breakpoint
ALTER TABLE releases ADD COLUMN document_snapshot TEXT;
--> statement-breakpoint
ALTER TABLE order_machine_usage ADD COLUMN reversed_at TEXT;
--> statement-breakpoint
ALTER TABLE order_machine_usage ADD COLUMN reversed_by INTEGER;
--> statement-breakpoint
ALTER TABLE order_worker_assignments ADD COLUMN reversed_at TEXT;
--> statement-breakpoint
ALTER TABLE order_worker_assignments ADD COLUMN reversed_by INTEGER;
--> statement-breakpoint
ALTER TABLE worker_transactions ADD COLUMN reversal_of_transaction_id INTEGER REFERENCES worker_transactions(id);
--> statement-breakpoint
CREATE UNIQUE INDEX worker_transactions_reversal_unique ON worker_transactions(reversal_of_transaction_id) WHERE reversal_of_transaction_id IS NOT NULL;
