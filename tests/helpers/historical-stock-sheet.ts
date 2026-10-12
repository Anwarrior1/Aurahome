import { getRawConnection } from '@main/db/connection'
import { costOf, multiplyDivideRounded, unitCostMicro } from '@shared/money/cost'

let sequence = 0

/** Test-only fixture for rows written by the retired stock-MO workflow. */
export function insertHistoricalStockSheet(
  productId: number,
  quantityMicro: number
): { id: number; documentNumber: string } {
  const documentNumber = `MO-HIST-${++sequence}`
  const id = Number(
    getRawConnection()
      .prepare(
        "INSERT INTO work_sheets (document_number, product_id, quantity_micro, status, issued_at) VALUES (?, ?, ?, 'ready', '2026-01-01T00:00:00.000Z')"
      )
      .run(documentNumber, productId, quantityMicro).lastInsertRowid
  )
  // Historical fixtures seed stored snapshots directly, not a live lifecycle primitive.
  const db = getRawConnection()
  const materialRows = db
    .prepare(
      'SELECT pbl.*, m.name, m.unit FROM product_bom_lines pbl JOIN materials m ON m.id=pbl.material_id WHERE pbl.product_id=?'
    )
    .all(productId) as {
    material_id: number
    name: string
    unit: string
    qty_micro: number
    dimensions: string | null
  }[]
  for (const [index, row] of materialRows.entries())
    db.prepare(
      'INSERT INTO planned_materials (work_sheet_id, material_id, material_name, qty_micro, unit, dimensions, estimated_unit_cost_micro, estimated_total_minor, sort_order) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)'
    ).run(
      id,
      row.material_id,
      row.name,
      multiplyDivideRounded(row.qty_micro, quantityMicro, 1_000_000),
      row.unit,
      row.dimensions,
      index
    )
  const machineRows = db
    .prepare(
      'SELECT pml.*, m.name, m.costing_unit, m.default_rate_micro FROM product_machine_lines pml JOIN machines m ON m.id=pml.machine_id WHERE pml.product_id=?'
    )
    .all(productId) as {
    machine_id: number
    name: string
    costing_unit: string
    usage_qty_micro: number
    rate_micro: number | null
    default_rate_micro: number
    notes: string | null
  }[]
  for (const row of machineRows) {
    const qty = multiplyDivideRounded(row.usage_qty_micro, quantityMicro, 1_000_000)
    const rate = row.rate_micro ?? row.default_rate_micro
    db.prepare(
      'INSERT INTO planned_machines (work_sheet_id, machine_id, machine_name, usage_qty_micro, usage_unit, rate_micro, estimated_cost_minor, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id,
      row.machine_id,
      row.name,
      qty,
      row.costing_unit,
      rate,
      costOf(qty, unitCostMicro(rate)),
      row.notes
    )
  }
  const workerRows = db
    .prepare(
      'SELECT pcl.*, w.name FROM product_commission_lines pcl LEFT JOIN workers w ON w.id=pcl.worker_id WHERE pcl.product_id=?'
    )
    .all(productId) as {
    worker_id: number | null
    name: string | null
    amount_minor: number
    notes: string | null
  }[]
  for (const row of workerRows)
    db.prepare(
      "INSERT INTO planned_workers (work_sheet_id, worker_id, worker_name, commission_mode, estimated_cost_minor, notes) VALUES (?, ?, ?, 'estimated', ?, ?)"
    ).run(
      id,
      row.worker_id,
      row.name ?? 'عمولة تصنيع قياسية',
      multiplyDivideRounded(row.amount_minor, quantityMicro, 1_000_000),
      row.notes
    )
  return { id, documentNumber }
}
