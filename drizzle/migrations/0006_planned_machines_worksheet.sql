ALTER TABLE `planned_machines` ADD `work_sheet_id` integer REFERENCES work_sheets(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `planned_machines_sheet_idx` ON `planned_machines` (`work_sheet_id`);
