/**
 * FIFO consumption (BR-6, BR-10, BR-12) is deliberately written as
 * parameterized raw SQL, not Drizzle's query builder — the layer
 * selection/decrement loop needs precise, auditable control. This
 * file holds the statements only; the transaction orchestration (loop
 * over layers, guard against insufficient stock per BR-5, write the
 * three separate values from BR-12) lives in the Step 4 inventory
 * service, wrapped in withTransaction() from src/main/db/transactions.ts.
 *
 * Placeholder for Step 4 — establishing the boundary now: raw
 * inventory SQL lives here, never inline inside a service file.
 */

export const SELECT_AVAILABLE_LAYERS_SQL = `
  SELECT id, qty_remaining, unit_cost_micro, received_at, seq
  FROM fifo_layers
  WHERE material_id = ? AND qty_remaining > 0
  ORDER BY received_at ASC, seq ASC
`

export const DECREMENT_LAYER_SQL = `
  UPDATE fifo_layers
  SET qty_remaining = qty_remaining - ?
  WHERE id = ? AND qty_remaining >= ?
`
