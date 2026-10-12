-- DB-06: guard new expense writes without rebuilding tables or modifying historical rows.
CREATE TRIGGER db06_expenses_amount_insert BEFORE INSERT ON expenses
FOR EACH ROW WHEN typeof(NEW.amount_minor) <> 'integer'
  OR NEW.amount_minor < 1 OR NEW.amount_minor > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'DB-06 invalid expense amount'); END;
--> statement-breakpoint
CREATE TRIGGER db06_expenses_amount_update BEFORE UPDATE OF amount_minor ON expenses
FOR EACH ROW WHEN typeof(NEW.amount_minor) <> 'integer'
  OR NEW.amount_minor < 1 OR NEW.amount_minor > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'DB-06 invalid expense amount'); END;
--> statement-breakpoint
CREATE TRIGGER db06_recurring_amount_insert BEFORE INSERT ON recurring_expense_amounts
FOR EACH ROW WHEN typeof(NEW.amount_minor) <> 'integer'
  OR NEW.amount_minor < 1 OR NEW.amount_minor > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'DB-06 invalid recurring expense amount'); END;
--> statement-breakpoint
CREATE TRIGGER db06_recurring_amount_update BEFORE UPDATE OF amount_minor ON recurring_expense_amounts
FOR EACH ROW WHEN typeof(NEW.amount_minor) <> 'integer'
  OR NEW.amount_minor < 1 OR NEW.amount_minor > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'DB-06 invalid recurring expense amount'); END;
