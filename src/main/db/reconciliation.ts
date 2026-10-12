import type Database from 'better-sqlite3'

/**
 * DB-12 durable business-invariant reconciliation.
 *
 * Read-only and deterministic: every check is one SELECT that yields the ids
 * of violating entities in ascending order. Rows are streamed, so memory and
 * the returned payload are bounded by `sampleLimit` per check regardless of
 * history size; cost is one O(history) statement per check. Nothing is ever
 * repaired here — a finding is evidence for human review.
 *
 * `error`   — authoritative rows contradict each other, or a derived value
 *             shown to users disagrees with its authority.
 * `warning` — legacy/ambiguous provenance that is not provably wrong.
 */
export type ReconciliationSeverity = 'error' | 'warning'

export interface ReconciliationFinding {
  code: string
  domain: string
  severity: ReconciliationSeverity
  /** Table whose ids are sampled (or a logical subject for global checks). */
  entity: string
  count: number
  sampleIds: number[]
}

export interface ReconciliationReport {
  checksRun: number
  errorCount: number
  warningCount: number
  findings: ReconciliationFinding[]
}

interface Check {
  code: string
  domain: string
  severity: ReconciliationSeverity
  entity: string
  sql: string
}

const FG_IN = `('production_in', 'adjustment_in', 'sale_reversal')`
const FG_OUT = `('sale_out', 'adjustment_out')`
const INV_IN = `('purchase', 'opening', 'adjustment_in', 'consumption_reversal', 'material_return')`
const INV_OUT = `('consumption', 'sale', 'waste', 'adjustment_out', 'material_return_reversal')`

/** Expected cash mirror per source row: account NULL means "must have none". */
const MIRROR_SOURCES: Array<{ table: string; select: string }> = [
  { table: 'customer_payments', select: `SELECT id, cash_account_id AS acct, 'in' AS dir, amount_minor AS amt FROM customer_payments` },
  { table: 'customer_payment_refunds', select: `SELECT id, cash_account_id AS acct, 'out' AS dir, amount_minor AS amt FROM customer_payment_refunds` },
  { table: 'supplier_payments', select: `SELECT id, cash_account_id AS acct, 'out' AS dir, amount_minor AS amt FROM supplier_payments` },
  // A salary expense's cash is mirrored on its employee transaction, never on the expense.
  { table: 'expenses', select: `SELECT id, CASE WHEN source = 'salary' THEN NULL ELSE cash_account_id END AS acct, 'out' AS dir, amount_minor AS amt FROM expenses` },
  {
    table: 'employee_transactions',
    // Legacy salary rows (paid_amount_minor NULL) carry no reconstructable net amount.
    select: `SELECT id,
        CASE WHEN kind IN ('advance', 'repayment', 'salary_payment') THEN cash_account_id END AS acct,
        CASE kind WHEN 'repayment' THEN 'in' ELSE 'out' END AS dir,
        CASE kind WHEN 'salary_payment' THEN paid_amount_minor ELSE amount_minor END AS amt
      FROM employee_transactions WHERE NOT (kind = 'salary_payment' AND paid_amount_minor IS NULL)`
  },
  {
    table: 'worker_transactions',
    select: `SELECT id,
        CASE WHEN kind IN ('withdrawal', 'repayment', 'commission_payment') AND order_id IS NULL AND reversal_of_transaction_id IS NULL THEN cash_account_id END AS acct,
        CASE kind WHEN 'repayment' THEN 'in' ELSE 'out' END AS dir, amount_minor AS amt
      FROM worker_transactions`
  },
  { table: 'profit_withdrawals', select: `SELECT id, cash_account_id AS acct, 'out' AS dir, amount_minor AS amt FROM profit_withdrawals` },
  { table: 'savings_transactions', select: `SELECT id, CASE WHEN kind = 'usage' THEN cash_account_id END AS acct, 'in' AS dir, amount_minor AS amt FROM savings_transactions` }
]

const mirrorChecks: Check[] = MIRROR_SOURCES.map(({ table, select }) => ({
  code: 'CASH_SOURCE_MIRROR_MISMATCH',
  domain: 'cash',
  severity: 'error',
  entity: table,
  sql: `WITH m AS (
      SELECT ref_id, COUNT(*) AS n, MIN(account_id) AS a1, MIN(direction) AS d1, MIN(amount_minor) AS x1
      FROM cash_transactions WHERE ref_table = '${table}' AND reversal_of_id IS NULL GROUP BY ref_id)
    SELECT s.id FROM (${select}) s LEFT JOIN m ON m.ref_id = s.id
    WHERE CASE WHEN s.acct IS NULL THEN m.n IS NOT NULL
      ELSE m.n IS NULL OR m.n <> 1 OR m.a1 <> s.acct OR m.d1 <> s.dir
        OR (s.amt IS NOT NULL AND m.x1 <> s.amt) END
    ORDER BY s.id`
}))

const ACCOUNT_REF_COLUMNS: Array<[string, string]> = [
  ['customer_payments', 'cash_account_id'],
  ['customer_payment_refunds', 'cash_account_id'],
  ['supplier_payments', 'cash_account_id'],
  ['expenses', 'cash_account_id'],
  ['employee_transactions', 'cash_account_id'],
  ['worker_transactions', 'cash_account_id'],
  ['final_invoices', 'initial_cash_account_id']
]

const CHECKS: Check[] = [
  // ---------------------------------------------------------------- cash
  ...mirrorChecks,
  {
    code: 'CASH_ORPHAN_MIRROR', domain: 'cash', severity: 'error', entity: 'cash_transactions',
    sql: `SELECT ct.id FROM cash_transactions ct WHERE ct.ref_table IS NOT NULL AND (ct.ref_id IS NULL OR CASE ct.ref_table
      ${MIRROR_SOURCES.map(({ table }) => `WHEN '${table}' THEN NOT EXISTS (SELECT 1 FROM ${table} s WHERE s.id = ct.ref_id)`).join('\n      ')}
      ELSE 1 END) ORDER BY ct.id`
  },
  {
    code: 'CASH_REVERSAL_MISMATCH', domain: 'cash', severity: 'error', entity: 'cash_transactions',
    sql: `SELECT r.id FROM cash_transactions r LEFT JOIN cash_transactions o ON o.id = r.reversal_of_id
      WHERE r.reversal_of_id IS NOT NULL AND (o.id IS NULL OR o.reversal_of_id IS NOT NULL
        OR o.account_id <> r.account_id OR o.amount_minor <> r.amount_minor OR o.direction = r.direction
        OR o.ref_table IS NOT r.ref_table OR o.ref_id IS NOT r.ref_id)
      ORDER BY r.id`
  },
  {
    code: 'CASH_TRANSFER_LEGS_MISMATCH', domain: 'cash', severity: 'error', entity: 'cash_transactions',
    sql: `SELECT MIN(id) AS id FROM cash_transactions WHERE transfer_group IS NOT NULL GROUP BY transfer_group
      HAVING COUNT(*) <> 2 OR SUM(direction = 'in') <> 1 OR SUM(direction = 'out') <> 1
        OR MIN(amount_minor) <> MAX(amount_minor) OR MIN(account_id) = MAX(account_id)
        OR MIN(occurred_at) <> MAX(occurred_at) OR COUNT(ref_table) > 0
      ORDER BY id`
  },
  ...ACCOUNT_REF_COLUMNS.map(([table, column]): Check => ({
    code: 'SOURCE_CASH_ACCOUNT_MISSING', domain: 'cash', severity: 'error', entity: table,
    sql: `SELECT s.id FROM ${table} s WHERE s.${column} IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM cash_accounts a WHERE a.id = s.${column}) ORDER BY s.id`
  })),

  // ---------------------------------------------------------------- sales
  {
    code: 'ORDER_PAYMENT_CACHE_DRIFT', domain: 'sales', severity: 'error', entity: 'orders',
    sql: `WITH p AS (SELECT order_id, SUM(amount_minor) AS s FROM customer_payments GROUP BY order_id),
      r AS (SELECT order_id, SUM(amount_minor) AS s FROM customer_payment_refunds GROUP BY order_id),
      x AS (SELECT o.*, COALESCE(p.s, 0) - COALESCE(r.s, 0) AS net FROM orders o
        LEFT JOIN p ON p.order_id = o.id LEFT JOIN r ON r.order_id = o.id)
      SELECT id FROM x WHERE paid_minor <> net OR remaining_minor <> total_minor - net
        OR payment_status <> CASE WHEN net <= 0 THEN 'unpaid' WHEN net >= total_minor THEN 'paid'
          WHEN net >= deposit_required_minor THEN 'deposit_met' ELSE 'partial' END
      ORDER BY id`
  },
  {
    code: 'ORDER_NET_PAID_NEGATIVE', domain: 'sales', severity: 'error', entity: 'orders',
    sql: `SELECT o.id FROM orders o
      WHERE COALESCE((SELECT SUM(amount_minor) FROM customer_payments WHERE order_id = o.id), 0)
          < COALESCE((SELECT SUM(amount_minor) FROM customer_payment_refunds WHERE order_id = o.id), 0)
      ORDER BY o.id`
  },
  {
    code: 'REFUND_ALLOCATION_MISMATCH', domain: 'sales', severity: 'error', entity: 'customer_payment_refunds',
    sql: `WITH a AS (SELECT a.refund_id, SUM(a.amount_minor) AS s, SUM(p.order_id IS NOT f.order_id) AS foreign_rows
        FROM customer_payment_refund_allocations a
        JOIN customer_payment_refunds f ON f.id = a.refund_id
        LEFT JOIN customer_payments p ON p.id = a.payment_id GROUP BY a.refund_id)
      SELECT f.id FROM customer_payment_refunds f LEFT JOIN a ON a.refund_id = f.id
      WHERE COALESCE(a.s, 0) <> f.amount_minor OR COALESCE(a.foreign_rows, 0) > 0 ORDER BY f.id`
  },
  {
    code: 'PAYMENT_OVER_REFUNDED', domain: 'sales', severity: 'error', entity: 'customer_payments',
    sql: `SELECT p.id FROM customer_payments p JOIN (SELECT payment_id, SUM(amount_minor) AS s
        FROM customer_payment_refund_allocations GROUP BY payment_id) a ON a.payment_id = p.id
      WHERE a.s > p.amount_minor OR a.s < 0 ORDER BY p.id`
  },
  {
    code: 'PAYMENT_CUSTOMER_MISMATCH', domain: 'sales', severity: 'error', entity: 'customer_payments',
    sql: `SELECT p.id FROM customer_payments p JOIN orders o ON o.id = p.order_id WHERE p.customer_id <> o.customer_id ORDER BY p.id`
  },
  {
    code: 'PAYMENT_CUSTOMER_MISMATCH', domain: 'sales', severity: 'error', entity: 'customer_payment_refunds',
    sql: `SELECT r.id FROM customer_payment_refunds r JOIN orders o ON o.id = r.order_id WHERE r.customer_id <> o.customer_id ORDER BY r.id`
  },
  {
    code: 'ORDER_INVOICE_LINK_MISMATCH', domain: 'sales', severity: 'error', entity: 'orders',
    sql: `SELECT o.id FROM orders o JOIN final_invoices f ON f.id = o.final_invoice_id
      WHERE f.order_id IS NOT o.id OR f.customer_id <> o.customer_id
        OR (f.status = 'draft') <> (o.status = 'awaiting_approval')
      ORDER BY o.id`
  },
  {
    code: 'APPROVED_INVOICE_WITHOUT_ORDER', domain: 'sales', severity: 'error', entity: 'final_invoices',
    sql: `SELECT id FROM final_invoices WHERE status = 'approved' AND order_id IS NULL ORDER BY id`
  },
  {
    code: 'INVOICE_ORDER_BACKLINK_LEGACY', domain: 'sales', severity: 'warning', entity: 'final_invoices',
    sql: `SELECT f.id FROM final_invoices f JOIN orders o ON o.id = f.order_id
      WHERE o.final_invoice_id IS NOT f.id ORDER BY f.id`
  },
  {
    code: 'ORDER_LIFECYCLE_TIMESTAMP_MISMATCH', domain: 'sales', severity: 'error', entity: 'orders',
    sql: `SELECT id FROM orders WHERE (status = 'completed') <> (completed_at IS NOT NULL)
      OR (status = 'cancelled' AND cancelled_at IS NULL) ORDER BY id`
  },
  {
    code: 'ORDER_STATUS_UNKNOWN', domain: 'sales', severity: 'warning', entity: 'orders',
    sql: `SELECT id FROM orders WHERE status NOT IN ('awaiting_approval', 'confirmed', 'completed', 'cancelled') ORDER BY id`
  },
  {
    code: 'UNCOLLECTED_PRODUCT_STATE_MISMATCH', domain: 'sales', severity: 'error', entity: 'uncollected_products',
    sql: `SELECT u.id FROM uncollected_products u LEFT JOIN final_invoices f ON f.id = u.sold_invoice_id
      WHERE CASE u.status
        WHEN 'sold' THEN u.sold_invoice_id IS NULL OR u.sold_order_id IS NULL OR u.reserved_invoice_id IS NOT NULL OR f.status IS NOT 'approved'
        WHEN 'reserved' THEN u.reserved_invoice_id IS NULL OR u.sold_invoice_id IS NOT NULL
        WHEN 'available' THEN u.reserved_invoice_id IS NOT NULL OR u.sold_invoice_id IS NOT NULL
        WHEN 'resumed' THEN u.resumed_at IS NULL OR u.sold_invoice_id IS NOT NULL
        ELSE 1 END
      ORDER BY u.id`
  },

  // ---------------------------------------------------------------- purchasing
  {
    code: 'PURCHASE_PAID_CACHE_DRIFT', domain: 'purchasing', severity: 'error', entity: 'purchases',
    sql: `SELECT p.id FROM purchases p LEFT JOIN (SELECT purchase_id, SUM(amount_minor) AS s FROM supplier_payments
        WHERE purchase_id IS NOT NULL GROUP BY purchase_id) s ON s.purchase_id = p.id
      WHERE p.paid_minor <> COALESCE(s.s, 0) ORDER BY p.id`
  },
  {
    code: 'PURCHASE_TOTAL_MISMATCH', domain: 'purchasing', severity: 'error', entity: 'purchases',
    sql: `SELECT p.id FROM purchases p LEFT JOIN (SELECT purchase_id, SUM(line_total_minor) AS s FROM purchase_lines
        GROUP BY purchase_id) l ON l.purchase_id = p.id
      WHERE p.total_minor <> COALESCE(l.s, 0) ORDER BY p.id`
  },
  {
    code: 'SUPPLIER_PAYMENT_SUPPLIER_MISMATCH', domain: 'purchasing', severity: 'error', entity: 'supplier_payments',
    sql: `SELECT s.id FROM supplier_payments s JOIN purchases p ON p.id = s.purchase_id WHERE s.supplier_id <> p.supplier_id ORDER BY s.id`
  },
  {
    code: 'PURCHASE_RECEIPT_LAYER_MISMATCH', domain: 'purchasing', severity: 'error', entity: 'purchase_lines',
    sql: `WITH l AS (SELECT source_ref_id, COUNT(*) AS n, MIN(material_id) AS mat, MIN(qty_received_micro) AS qty,
        MIN(unit_cost_micro) AS unit FROM fifo_layers WHERE source_kind = 'purchase' GROUP BY source_ref_id)
      SELECT pl.id FROM purchase_lines pl LEFT JOIN l ON l.source_ref_id = pl.id
      WHERE l.n IS NULL OR l.n <> 1 OR l.mat <> pl.material_id OR l.qty <> pl.qty_micro OR l.unit <> pl.unit_cost_micro
      ORDER BY pl.id`
  },
  {
    code: 'PURCHASE_RECEIPT_MOVEMENT_MISMATCH', domain: 'purchasing', severity: 'error', entity: 'purchase_lines',
    sql: `WITH m AS (SELECT source_ref_id, COUNT(*) AS n, MIN(material_id) AS mat, MIN(qty_micro) AS qty, MIN(kind) AS kind
        FROM inventory_movements WHERE source_kind = 'purchase' GROUP BY source_ref_id)
      SELECT pl.id FROM purchase_lines pl JOIN m ON m.source_ref_id = pl.id
      WHERE m.n <> 1 OR m.mat <> pl.material_id OR m.qty <> pl.qty_micro OR m.kind <> 'purchase' ORDER BY pl.id`
  },
  {
    code: 'PURCHASE_RECEIPT_MOVEMENT_UNLINKED', domain: 'purchasing', severity: 'warning', entity: 'purchase_lines',
    sql: `SELECT pl.id FROM purchase_lines pl WHERE NOT EXISTS (SELECT 1 FROM inventory_movements m
      WHERE m.source_kind = 'purchase' AND m.source_ref_id = pl.id) ORDER BY pl.id`
  },
  {
    code: 'PURCHASE_LAYER_ORPHAN', domain: 'purchasing', severity: 'error', entity: 'fifo_layers',
    sql: `SELECT l.id FROM fifo_layers l WHERE l.source_kind = 'purchase'
      AND (l.source_ref_id IS NULL OR NOT EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.id = l.source_ref_id)) ORDER BY l.id`
  },

  // ---------------------------------------------------------------- inventory / FIFO
  {
    code: 'FIFO_LAYER_BOUNDS', domain: 'inventory', severity: 'error', entity: 'fifo_layers',
    sql: `SELECT id FROM fifo_layers WHERE qty_received_micro <= 0 OR qty_remaining_micro < 0
      OR qty_remaining_micro > qty_received_micro OR unit_cost_micro < 0 ORDER BY id`
  },
  {
    code: 'FIFO_LAYER_ALLOCATION_BALANCE', domain: 'inventory', severity: 'error', entity: 'fifo_layers',
    sql: `WITH taken AS (SELECT layer_id, SUM(qty_micro) AS q FROM fifo_allocations GROUP BY layer_id),
      restored AS (SELECT a.layer_id, SUM(a.qty_micro) AS q FROM fifo_allocations a
        JOIN inventory_movements r ON r.reversal_of_movement_id = a.movement_id AND r.kind = 'consumption_reversal'
        GROUP BY a.layer_id)
      SELECT l.id FROM fifo_layers l LEFT JOIN taken t ON t.layer_id = l.id LEFT JOIN restored r ON r.layer_id = l.id
      WHERE l.qty_remaining_micro <> l.qty_received_micro - COALESCE(t.q, 0) + COALESCE(r.q, 0)
      ORDER BY l.id`
  },
  {
    code: 'INVENTORY_LEDGER_LAYER_MISMATCH', domain: 'inventory', severity: 'error', entity: 'materials',
    sql: `WITH mv AS (SELECT material_id, SUM(CASE WHEN kind IN ${INV_IN} THEN qty_micro
          WHEN kind IN ${INV_OUT} THEN -qty_micro ELSE 0 END) AS q FROM inventory_movements GROUP BY material_id),
      ly AS (SELECT material_id, SUM(qty_remaining_micro) AS q FROM fifo_layers GROUP BY material_id),
      ids AS (SELECT material_id FROM mv UNION SELECT material_id FROM ly)
      SELECT ids.material_id AS id FROM ids LEFT JOIN mv ON mv.material_id = ids.material_id
        LEFT JOIN ly ON ly.material_id = ids.material_id
      WHERE COALESCE(mv.q, 0) <> COALESCE(ly.q, 0) ORDER BY id`
  },
  {
    code: 'INVENTORY_MOVEMENT_KIND_UNKNOWN', domain: 'inventory', severity: 'error', entity: 'inventory_movements',
    sql: `SELECT id FROM inventory_movements WHERE (kind NOT IN ${INV_IN} AND kind NOT IN ${INV_OUT})
      OR qty_micro <= 0 ORDER BY id`
  },
  {
    code: 'INVENTORY_ALLOCATION_MISMATCH', domain: 'inventory', severity: 'error', entity: 'inventory_movements',
    sql: `WITH a AS (SELECT a.movement_id, SUM(a.qty_micro) AS q, SUM(a.cost_minor) AS c,
          SUM(l.material_id IS NOT m.material_id OR a.qty_micro <= 0) AS bad
        FROM fifo_allocations a JOIN inventory_movements m ON m.id = a.movement_id
        LEFT JOIN fifo_layers l ON l.id = a.layer_id GROUP BY a.movement_id)
      SELECT m.id FROM inventory_movements m LEFT JOIN a ON a.movement_id = m.id
      WHERE CASE WHEN m.kind IN ${INV_OUT}
        THEN a.q IS NULL OR a.q <> m.qty_micro OR a.c <> m.actual_cost_minor OR a.bad > 0
        ELSE a.q IS NOT NULL END
      ORDER BY m.id`
  },
  {
    code: 'INVENTORY_REVERSAL_MISMATCH', domain: 'inventory', severity: 'error', entity: 'inventory_movements',
    sql: `SELECT r.id FROM inventory_movements r LEFT JOIN inventory_movements s ON s.id = r.reversal_of_movement_id
      WHERE (r.kind = 'consumption_reversal') <> (r.reversal_of_movement_id IS NOT NULL)
        OR (r.reversal_of_movement_id IS NOT NULL AND (s.id IS NULL OR s.kind <> 'consumption'
          OR s.material_id <> r.material_id OR s.qty_micro <> r.qty_micro OR r.actual_cost_minor <> -s.actual_cost_minor
          OR (SELECT COUNT(*) FROM inventory_movements d WHERE d.reversal_of_movement_id = s.id) > 1))
      ORDER BY r.id`
  },
  {
    code: 'MATERIAL_ISSUE_MOVEMENT_MISMATCH', domain: 'production', severity: 'error', entity: 'order_material_lines',
    sql: `WITH d AS (SELECT movement_id, COUNT(*) AS n FROM order_material_lines WHERE movement_id IS NOT NULL GROUP BY movement_id)
      SELECT DISTINCT l.id FROM order_material_lines l
      JOIN d ON d.movement_id = l.movement_id
      LEFT JOIN inventory_movements m ON m.id = l.movement_id
      LEFT JOIN inventory_movements r ON r.reversal_of_movement_id = l.movement_id
      WHERE l.movement_id IS NOT NULL AND (m.id IS NULL OR m.kind <> 'consumption' OR m.material_id <> l.material_id
        OR m.qty_micro <> l.physical_qty_micro OR m.actual_cost_minor <> l.actual_cost_minor OR m.order_id IS NOT l.order_id
        OR l.status NOT IN ('active', 'reversed')
        OR (l.status = 'reversed') <> (r.id IS NOT NULL)
        OR (l.status = 'reversed' AND l.reversal_movement_id IS NOT r.id)
        OR d.n > 1)
      ORDER BY l.id`
  },
  {
    code: 'MATERIAL_ISSUE_UNLINKED', domain: 'production', severity: 'warning', entity: 'order_material_lines',
    sql: `SELECT id FROM order_material_lines WHERE movement_id IS NULL ORDER BY id`
  },
  {
    code: 'MATERIAL_RETURN_BALANCE_MISMATCH', domain: 'production', severity: 'error', entity: 'material_returns',
    sql: `SELECT r.id FROM material_returns r LEFT JOIN (SELECT return_id, SUM(qty_micro) AS q, SUM(cost_minor) AS c
        FROM material_return_allocations GROUP BY return_id) a ON a.return_id = r.id
      WHERE r.quantity_micro <> COALESCE(a.q, 0) OR r.returned_cost_minor <> COALESCE(a.c, 0)
        OR r.status NOT IN ('active', 'voided') OR (r.status = 'voided' AND r.quantity_micro <> 0)
      ORDER BY r.id`
  },
  {
    code: 'MATERIAL_RETURN_EXCEEDS_ISSUE', domain: 'production', severity: 'error', entity: 'fifo_allocations',
    sql: `WITH r AS (SELECT mra.fifo_allocation_id, SUM(mra.qty_micro) AS q,
          SUM(l.id IS NULL OR l.movement_id IS NOT x.movement_id) AS foreign_rows
        FROM material_return_allocations mra JOIN fifo_allocations x ON x.id = mra.fifo_allocation_id
        LEFT JOIN order_material_lines l ON l.id = mra.issue_line_id GROUP BY mra.fifo_allocation_id)
      SELECT fa.id FROM fifo_allocations fa JOIN r ON r.fifo_allocation_id = fa.id
      WHERE r.q > fa.qty_micro OR r.q < 0 OR r.foreign_rows > 0 ORDER BY fa.id`
  },

  // ---------------------------------------------------------------- finished goods (DB-02)
  {
    code: 'FG_CUTOVER_MISSING', domain: 'finished_goods', severity: 'error', entity: 'products',
    sql: `SELECT DISTINCT m.product_id AS id FROM finished_goods_movements m
      WHERE NOT EXISTS (SELECT 1 FROM finished_goods_valuation_cutovers c WHERE c.product_id = m.product_id) ORDER BY id`
  },
  {
    code: 'FG_CUTOVER_BLOCKED', domain: 'finished_goods', severity: 'error', entity: 'products',
    sql: `SELECT product_id AS id FROM finished_goods_valuation_cutovers WHERE status <> 'ready' ORDER BY id`
  },
  {
    code: 'FG_CUTOVER_REVIEW', domain: 'finished_goods', severity: 'warning', entity: 'products',
    sql: `SELECT product_id AS id FROM finished_goods_valuation_cutovers
      WHERE status = 'ready' AND classification <> 'unaffected' ORDER BY id`
  },
  {
    code: 'FG_MOVEMENT_INVALID', domain: 'finished_goods', severity: 'error', entity: 'finished_goods_movements',
    sql: `SELECT id FROM finished_goods_movements WHERE (kind NOT IN ${FG_IN} AND kind NOT IN ${FG_OUT})
      OR qty_micro <= 0 OR total_cost_minor < 0 ORDER BY id`
  },
  {
    code: 'FG_VALUATION_STATE_INVALID', domain: 'finished_goods', severity: 'error', entity: 'products',
    sql: `WITH s AS (SELECT m.product_id,
          c.opening_qty_micro + SUM(CASE WHEN m.kind IN ${FG_IN} THEN m.qty_micro ELSE -m.qty_micro END)
            OVER (PARTITION BY m.product_id ORDER BY m.id) AS q,
          c.opening_value_minor + SUM(CASE WHEN m.kind IN ${FG_IN} THEN m.total_cost_minor ELSE -m.total_cost_minor END)
            OVER (PARTITION BY m.product_id ORDER BY m.id) AS v
        FROM finished_goods_movements m JOIN finished_goods_valuation_cutovers c
          ON c.product_id = m.product_id AND c.status = 'ready' AND m.id > c.movement_id_through)
      SELECT DISTINCT product_id AS id FROM s WHERE q < 0 OR v < 0 OR (q = 0 AND v <> 0) ORDER BY id`
  },
  {
    code: 'FG_REVERSAL_MISMATCH', domain: 'finished_goods', severity: 'error', entity: 'finished_goods_movements',
    sql: `SELECT r.id FROM finished_goods_movements r LEFT JOIN finished_goods_movements s ON s.id = r.reversal_of_movement_id
      WHERE (r.kind = 'sale_reversal') <> (r.reversal_of_movement_id IS NOT NULL)
        OR (r.reversal_of_movement_id IS NOT NULL AND (s.id IS NULL OR s.kind <> 'sale_out' OR s.product_id <> r.product_id
          OR s.qty_micro <> r.qty_micro OR s.total_cost_minor <> r.total_cost_minor OR s.order_id IS NOT r.order_id))
      ORDER BY r.id`
  },
  {
    code: 'FG_PRODUCTION_LINK_MISMATCH', domain: 'finished_goods', severity: 'error', entity: 'work_sheets',
    sql: `SELECT w.id FROM work_sheets w LEFT JOIN (SELECT work_sheet_id, COUNT(*) AS n, MIN(qty_micro) AS q, MIN(product_id) AS p
        FROM finished_goods_movements WHERE kind = 'production_in' AND work_sheet_id IS NOT NULL GROUP BY work_sheet_id) m
        ON m.work_sheet_id = w.id
      WHERE (w.product_id IS NOT NULL AND w.quantity_micro > 0 AND (w.status = 'completed') <> (m.n IS NOT NULL))
        OR (m.n IS NOT NULL AND (m.n > 1 OR m.q <> w.quantity_micro OR m.p IS NOT w.product_id))
      ORDER BY w.id`
  },

  // ---------------------------------------------------------------- payroll / workers
  {
    code: 'SALARY_EXPENSE_LINK_MISMATCH', domain: 'payroll', severity: 'error', entity: 'employee_transactions',
    sql: `WITH d AS (SELECT expense_id, COUNT(*) AS n FROM employee_transactions WHERE expense_id IS NOT NULL GROUP BY expense_id)
      SELECT t.id FROM employee_transactions t JOIN d ON d.expense_id = t.expense_id LEFT JOIN expenses e ON e.id = t.expense_id
      WHERE t.kind = 'salary_payment' AND t.expense_id IS NOT NULL AND (e.id IS NULL OR e.source <> 'salary'
        OR (t.paid_amount_minor IS NOT NULL AND e.amount_minor <> t.paid_amount_minor)
        OR (t.reversed_at IS NULL) <> (e.reversed_at IS NULL) OR e.cash_account_id IS NOT t.cash_account_id
        OR d.n > 1)
      ORDER BY t.id`
  },
  {
    code: 'SALARY_PAYMENT_UNLINKED', domain: 'payroll', severity: 'warning', entity: 'employee_transactions',
    sql: `SELECT id FROM employee_transactions WHERE kind = 'salary_payment' AND expense_id IS NULL ORDER BY id`
  },
  {
    code: 'SALARY_EXPENSE_ORPHAN', domain: 'payroll', severity: 'error', entity: 'expenses',
    sql: `SELECT e.id FROM expenses e WHERE e.source = 'salary' AND NOT EXISTS (SELECT 1 FROM employee_transactions t
      WHERE t.kind = 'salary_payment' AND t.expense_id = e.id) ORDER BY e.id`
  },
  {
    code: 'SALARY_REVERSAL_CASH_MISMATCH', domain: 'payroll', severity: 'error', entity: 'employee_transactions',
    sql: `SELECT t.id FROM employee_transactions t LEFT JOIN (SELECT ref_id, COUNT(*) AS n FROM cash_transactions
        WHERE ref_table = 'employee_transactions' AND reversal_of_id IS NOT NULL GROUP BY ref_id) r ON r.ref_id = t.id
      WHERE t.kind = 'salary_payment' AND t.cash_account_id IS NOT NULL AND t.paid_amount_minor IS NOT NULL
        AND COALESCE(r.n, 0) <> CASE WHEN t.reversed_at IS NULL THEN 0 ELSE 1 END
      ORDER BY t.id`
  },
  {
    code: 'EMPLOYEE_ADVANCE_BALANCE_NEGATIVE', domain: 'payroll', severity: 'error', entity: 'employees',
    sql: `SELECT employee_id AS id FROM employee_transactions GROUP BY employee_id
      HAVING SUM(CASE kind WHEN 'advance' THEN amount_minor WHEN 'repayment' THEN -amount_minor ELSE 0 END) < 0 ORDER BY id`
  },
  {
    code: 'PAYROLL_PERIOD_OVER_ENTITLEMENT', domain: 'payroll', severity: 'warning', entity: 'employees',
    sql: `WITH p AS (SELECT employee_id, period_year AS y, period_month AS mo,
          SUM(CASE WHEN kind = 'deduction' THEN amount_minor WHEN paid_amount_minor IS NOT NULL THEN paid_amount_minor
            ELSE MAX(amount_minor - COALESCE((SELECT SUM(c.amount_minor) FROM employee_transactions c
              WHERE c.parent_transaction_id = t.id AND c.kind = 'deduction' AND c.reversed_at IS NULL), 0), 0) END) AS used
        FROM employee_transactions t WHERE kind IN ('salary_payment', 'deduction') AND reversed_at IS NULL
          AND period_year IS NOT NULL AND period_month IS NOT NULL GROUP BY employee_id, period_year, period_month)
      SELECT DISTINCT p.employee_id AS id FROM p JOIN employees e ON e.id = p.employee_id
      WHERE p.used > COALESCE((SELECT h.monthly_salary_minor FROM employee_salary_history h WHERE h.employee_id = e.id
        AND h.effective_from <= date(printf('%04d-%02d-01', p.y, p.mo), '+1 month', '-1 day')
        ORDER BY h.effective_from DESC, h.id DESC LIMIT 1), e.monthly_salary_minor)
      ORDER BY id`
  },
  {
    code: 'WORKER_EARNINGS_ASSIGNMENT_MISMATCH', domain: 'workers', severity: 'error', entity: 'orders',
    sql: `WITH a AS (SELECT order_id, worker_id, SUM(amount_minor) AS s FROM order_worker_assignments
          WHERE earned = 1 AND reversed_at IS NULL AND order_id IS NOT NULL GROUP BY order_id, worker_id),
        t AS (SELECT order_id, worker_id, SUM(amount_minor) AS s FROM worker_transactions WHERE order_id IS NOT NULL
          AND (kind = 'earning' OR (kind = 'adjustment' AND reversal_of_transaction_id IS NOT NULL)) GROUP BY order_id, worker_id),
        k AS (SELECT order_id, worker_id FROM a UNION SELECT order_id, worker_id FROM t)
      SELECT DISTINCT k.order_id AS id FROM k LEFT JOIN a ON a.order_id = k.order_id AND a.worker_id = k.worker_id
        LEFT JOIN t ON t.order_id = k.order_id AND t.worker_id = k.worker_id
      WHERE COALESCE(a.s, 0) <> COALESCE(t.s, 0) ORDER BY id`
  },
  {
    code: 'WORKER_EARNED_ON_OPEN_ORDER', domain: 'workers', severity: 'error', entity: 'order_worker_assignments',
    // CC04: linked commissions earn at manufacturing completion, including standalone stock.
    // Unlinked historical assignments keep their original order-completion rule.
    sql: `SELECT a.id FROM order_worker_assignments a LEFT JOIN orders o ON o.id = a.order_id
      WHERE (a.earned = 1 OR EXISTS (SELECT 1 FROM worker_transactions t WHERE t.assignment_id = a.id))
        AND (a.earned <> 1 OR a.reversed_at IS NOT NULL OR
        CASE WHEN EXISTS (SELECT 1 FROM worker_transactions t WHERE t.assignment_id = a.id)
          THEN NOT EXISTS (SELECT 1 FROM worker_transactions t JOIN work_sheets w
            ON w.id = a.work_sheet_id OR (a.work_sheet_id IS NULL AND a.order_id IS NOT NULL AND w.order_id = a.order_id)
            WHERE t.assignment_id = a.id AND t.kind = 'earning' AND t.worker_id = a.worker_id
              AND a.amount_minor > 0 AND t.amount_minor = a.amount_minor AND t.order_id IS a.order_id AND w.order_id IS a.order_id
              AND w.status = 'completed' AND w.reversed_at IS NULL
              AND w.completed_at = t.created_at AND w.completed_at = a.earned_at
              AND (a.order_id IS NULL OR o.id IS NOT NULL))
          ELSE o.completed_at IS NULL END) ORDER BY a.id`
  },
  {
    code: 'WORKER_REVERSAL_MISMATCH', domain: 'workers', severity: 'error', entity: 'worker_transactions',
    sql: `SELECT r.id FROM worker_transactions r LEFT JOIN worker_transactions s ON s.id = r.reversal_of_transaction_id
      WHERE r.reversal_of_transaction_id IS NOT NULL AND (s.id IS NULL OR s.kind <> 'earning' OR r.kind <> 'adjustment'
        OR r.amount_minor <> -s.amount_minor OR r.worker_id <> s.worker_id OR r.order_id IS NOT s.order_id)
      ORDER BY r.id`
  },

  // ---------------------------------------------------------------- production lifecycle
  {
    code: 'WORKSHEET_LIFECYCLE_MISMATCH', domain: 'production', severity: 'error', entity: 'work_sheets',
    sql: `SELECT id FROM work_sheets WHERE status NOT IN ('draft', 'ready', 'in_production', 'completed', 'cancelled', 'reversed')
      OR (status = 'completed' AND completed_at IS NULL) OR (status = 'cancelled' AND cancelled_at IS NULL)
      OR (status = 'reversed') <> (reversed_at IS NOT NULL) ORDER BY id`
  },
  {
    code: 'REVERSED_WORKSHEET_ACTIVE_EFFECTS', domain: 'production', severity: 'error', entity: 'work_sheets',
    sql: `SELECT w.id FROM work_sheets w WHERE w.status = 'reversed' AND (
        EXISTS (SELECT 1 FROM order_material_lines l WHERE l.work_sheet_id = w.id AND l.status = 'active')
        OR EXISTS (SELECT 1 FROM order_machine_usage u WHERE u.work_sheet_id = w.id AND u.reversed_at IS NULL)
        OR EXISTS (SELECT 1 FROM order_worker_assignments a WHERE a.work_sheet_id = w.id AND a.reversed_at IS NULL))
      ORDER BY w.id`
  },
  {
    code: 'RELEASE_DELIVERY_LINK_MISMATCH', domain: 'production', severity: 'error', entity: 'deliveries',
    sql: `SELECT d.id FROM deliveries d LEFT JOIN releases r ON r.id = d.release_id
      WHERE d.status NOT IN ('recorded', 'cancelled')
        OR (d.status = 'recorded' AND d.release_id IS NOT NULL AND (r.order_id <> d.order_id OR r.status <> 'active'))
      ORDER BY d.id`
  },
  {
    code: 'RELEASE_LIFECYCLE_MISMATCH', domain: 'production', severity: 'error', entity: 'releases',
    sql: `SELECT id FROM releases WHERE status NOT IN ('active', 'reversed') OR (status = 'reversed') <> (reversed_at IS NOT NULL) ORDER BY id`
  },

  // ---------------------------------------------------------------- recurring expenses
  {
    code: 'RECURRING_OCCURRENCE_DUPLICATE', domain: 'recurring', severity: 'error', entity: 'expenses',
    sql: `SELECT MIN(id) AS id FROM expenses WHERE source = 'recurring' GROUP BY source_ref_id, spent_at HAVING COUNT(*) > 1 ORDER BY id`
  },
  {
    code: 'RECURRING_OCCURRENCE_INVALID', domain: 'recurring', severity: 'error', entity: 'expenses',
    sql: `SELECT e.id FROM expenses e LEFT JOIN recurring_expenses r ON r.id = e.source_ref_id
      WHERE e.source = 'recurring' AND (r.id IS NULL OR e.kind <> 'fixed' OR e.order_id IS NOT NULL
        OR length(e.spent_at) <> 10 OR substr(e.spent_at, 9, 2) <> '01' OR e.spent_at < r.start_date)
      ORDER BY e.id`
  },

  // ---------------------------------------------------------------- savings / profit
  {
    code: 'SAVINGS_ALLOCATION_DUPLICATE_PERIOD', domain: 'savings', severity: 'error', entity: 'savings_allocations',
    sql: `SELECT MIN(id) AS id FROM savings_allocations GROUP BY period_year, period_month HAVING COUNT(*) > 1 ORDER BY id`
  },
  {
    code: 'SAVINGS_ALLOCATION_LEDGER_MISMATCH', domain: 'savings', severity: 'error', entity: 'savings_allocations',
    sql: `SELECT a.id FROM savings_allocations a LEFT JOIN (SELECT allocation_id, COUNT(*) AS n, MIN(amount_minor) AS x
        FROM savings_transactions WHERE kind = 'allocation' GROUP BY allocation_id) t ON t.allocation_id = a.id
      WHERE t.n IS NULL OR t.n <> 1 OR t.x <> a.amount_minor ORDER BY a.id`
  },
  {
    code: 'SAVINGS_TRANSACTION_INVALID', domain: 'savings', severity: 'error', entity: 'savings_transactions',
    sql: `SELECT t.id FROM savings_transactions t WHERE t.kind NOT IN ('allocation', 'usage') OR t.amount_minor < 0
      OR (t.kind = 'allocation' AND NOT EXISTS (SELECT 1 FROM savings_allocations a WHERE a.id = t.allocation_id))
      OR (t.kind = 'usage' AND t.allocation_id IS NOT NULL) ORDER BY t.id`
  },
  {
    code: 'SAVINGS_FUND_BALANCE_NEGATIVE', domain: 'savings', severity: 'error', entity: 'savings_transactions',
    sql: `SELECT 0 AS id WHERE (SELECT COALESCE(SUM(CASE kind WHEN 'allocation' THEN amount_minor
      WHEN 'usage' THEN -amount_minor ELSE 0 END), 0) FROM savings_transactions) < 0`
  }
]

export const RECONCILIATION_CHECK_COUNT = CHECKS.length

export function reconcileDatabase(
  raw: Database.Database,
  options: { sampleLimit?: number } = {}
): ReconciliationReport {
  const sampleLimit = Math.max(0, Math.min(options.sampleLimit ?? 20, 100))
  const run = (): ReconciliationFinding[] => {
    const findings: ReconciliationFinding[] = []
    for (const check of CHECKS) {
      let count = 0
      const sampleIds: number[] = []
      for (const id of raw.prepare(check.sql).pluck().iterate()) {
        if (sampleIds.length < sampleLimit) sampleIds.push(Number(id))
        count += 1
      }
      if (count > 0) {
        findings.push({ code: check.code, domain: check.domain, severity: check.severity, entity: check.entity, count, sampleIds })
      }
    }
    return findings
  }
  // One read transaction gives every check the same snapshot.
  const findings = raw.inTransaction ? run() : raw.transaction(run).deferred()
  return {
    checksRun: CHECKS.length,
    errorCount: findings.filter((f) => f.severity === 'error').length,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
    findings
  }
}
