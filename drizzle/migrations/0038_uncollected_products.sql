CREATE TABLE uncollected_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_order_id INTEGER NOT NULL REFERENCES orders(id),
  source_order_number TEXT NOT NULL,
  source_order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  source_invoice_id INTEGER REFERENCES final_invoices(id),
  source_invoice_line_id INTEGER REFERENCES final_invoice_lines(id),
  source_work_sheet_id INTEGER REFERENCES work_sheets(id),
  source_work_sheet_number TEXT,
  name TEXT NOT NULL,
  description TEXT,
  specifications TEXT,
  dimensions TEXT,
  quantity_micro INTEGER NOT NULL DEFAULT 0,
  original_unit_price_minor INTEGER NOT NULL DEFAULT 0,
  original_line_total_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_method TEXT NOT NULL,
  cost_basis_order_total_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_material_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_machine_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_worker_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_delivery_minor INTEGER NOT NULL DEFAULT 0,
  cost_basis_expense_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',
  transferred_at TEXT NOT NULL,
  transferred_by INTEGER,
  cancel_reason TEXT,
  reserved_invoice_id INTEGER REFERENCES final_invoices(id),
  sold_invoice_id INTEGER REFERENCES final_invoices(id),
  sold_order_id INTEGER REFERENCES orders(id),
  sold_at TEXT,
  sold_price_minor INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT 'CURRENT_TIMESTAMP'
);
--> statement-breakpoint
CREATE UNIQUE INDEX uncollected_products_source_line_uq ON uncollected_products(source_order_line_id);
--> statement-breakpoint
CREATE INDEX uncollected_products_source_order_idx ON uncollected_products(source_order_id);
--> statement-breakpoint
CREATE INDEX uncollected_products_status_idx ON uncollected_products(status);
--> statement-breakpoint
CREATE INDEX uncollected_products_sold_invoice_idx ON uncollected_products(sold_invoice_id);
--> statement-breakpoint
CREATE TABLE uncollected_product_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES uncollected_products(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  position INTEGER NOT NULL,
  name_snapshot TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX uncollected_product_materials_owner_uq ON uncollected_product_materials(id, product_id);
--> statement-breakpoint
CREATE UNIQUE INDEX uncollected_product_materials_position_uq ON uncollected_product_materials(product_id, position);
--> statement-breakpoint
CREATE TABLE uncollected_product_colors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES uncollected_products(id) ON DELETE CASCADE,
  material_selection_id INTEGER,
  color_id INTEGER REFERENCES color_finish_catalog(id) ON DELETE SET NULL,
  position INTEGER NOT NULL,
  code_snapshot TEXT NOT NULL,
  name_snapshot TEXT,
  FOREIGN KEY (material_selection_id, product_id)
    REFERENCES uncollected_product_materials(id, product_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX uncollected_product_colors_position_uq ON uncollected_product_colors(product_id, position);
--> statement-breakpoint
CREATE TABLE uncollected_product_accessories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES uncollected_products(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  position INTEGER NOT NULL,
  name_snapshot TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX uncollected_product_accessories_position_uq ON uncollected_product_accessories(product_id, position);
--> statement-breakpoint
ALTER TABLE final_invoice_lines ADD COLUMN uncollected_product_id INTEGER REFERENCES uncollected_products(id);
--> statement-breakpoint
CREATE UNIQUE INDEX final_invoice_lines_uncollected_product_uq ON final_invoice_lines(uncollected_product_id) WHERE uncollected_product_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE order_lines ADD COLUMN uncollected_product_id INTEGER REFERENCES uncollected_products(id);
--> statement-breakpoint
CREATE INDEX order_lines_uncollected_product_idx ON order_lines(uncollected_product_id) WHERE uncollected_product_id IS NOT NULL;
