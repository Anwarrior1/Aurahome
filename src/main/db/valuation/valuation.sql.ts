/**
 * Inventory valuation (BR-95): two figures per material/category,
 * always kept separate — actual FIFO cost value, and current market
 * value. Raw SQL placeholder; implemented against the real materials/
 * fifo_layers tables in Step 4.
 */

export const FIFO_VALUE_BY_MATERIAL_SQL = `
  SELECT material_id, SUM(qty_remaining * unit_cost_micro) AS fifo_value_micro
  FROM fifo_layers
  GROUP BY material_id
`

export const MARKET_VALUE_BY_MATERIAL_SQL = `
  SELECT m.id AS material_id,
         SUM(l.qty_remaining) * m.current_market_price_micro AS market_value_micro
  FROM materials m
  JOIN fifo_layers l ON l.material_id = m.id
  GROUP BY m.id
`
