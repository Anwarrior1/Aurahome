-- Preserve the effective access of roles created before the section/action
-- RBAC normalization. New roles remain least-privilege because these rows are
-- copied only once, while this migration is applied to existing data.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT id, 'dashboard.view' FROM roles;
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'dashboard.viewOrders' FROM role_permissions WHERE permission_key = 'orders.view';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'dashboard.viewSales' FROM role_permissions WHERE permission_key = 'orders.view';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'dashboard.viewCosts' FROM role_permissions WHERE permission_key = 'costing.view';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'dashboard.viewProfits' FROM role_permissions WHERE permission_key = 'profit.view';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'dashboard.viewFinancialAlerts' FROM role_permissions WHERE permission_key = 'cash.view';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'orders.viewEstimatedCost' FROM role_permissions WHERE permission_key = 'costing.view';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'orders.viewExpectedProfit' FROM role_permissions WHERE permission_key = 'costing.view';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'orders.viewActualCost' FROM role_permissions WHERE permission_key = 'costing.view';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'orders.viewActualProfit' FROM role_permissions WHERE permission_key = 'costing.view';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'purchases.paySupplier' FROM role_permissions WHERE permission_key = 'purchases.manage';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'purchases.editSupplierPayment' FROM role_permissions WHERE permission_key = 'purchases.manage';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'purchases.deleteSupplierPayment' FROM role_permissions WHERE permission_key = 'purchases.manage';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'deliveries.view' FROM role_permissions WHERE permission_key = 'orders.view';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'deliveries.register' FROM role_permissions WHERE permission_key = 'orders.manage';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'deliveries.deleteOrReverse' FROM role_permissions WHERE permission_key = 'orders.manage';
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission_key)
SELECT role_id, 'reports.export' FROM role_permissions WHERE permission_key = 'reports.view';
