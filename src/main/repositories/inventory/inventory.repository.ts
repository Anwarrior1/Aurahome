import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import {
  fifoAllocations,
  fifoLayers,
  inventoryMovements,
  materialRemainders
} from '../../db/schema/inventory.schema'

export interface FifoLayerRow {
  id: number
  materialId: number
  qtyRemainingMicro: number
  unitCostMicro: number
  receivedAt: string
  seq: number
  batchCode: string | null
}

/**
 * Persistence only — no business rule lives here. The FIFO ordering
 * (oldest received_at, then seq) is a query concern; the decision of
 * how much to take from each layer, and whether the consumption is
 * allowed at all, belongs to InventoryService.
 */
export const inventoryRepository = {
  /** BR-6: oldest layer first, ties broken by insertion sequence. */
  layersForConsumption(materialId: number): FifoLayerRow[] {
    return getDatabase()
      .select({
        id: fifoLayers.id,
        materialId: fifoLayers.materialId,
        qtyRemainingMicro: fifoLayers.qtyRemainingMicro,
        unitCostMicro: fifoLayers.unitCostMicro,
        receivedAt: fifoLayers.receivedAt,
        seq: fifoLayers.seq,
        batchCode: fifoLayers.batchCode
      })
      .from(fifoLayers)
      .where(and(eq(fifoLayers.materialId, materialId), gt(fifoLayers.qtyRemainingMicro, 0)))
      .orderBy(asc(fifoLayers.receivedAt), asc(fifoLayers.seq))
      .all()
  },

  availableQtyMicro(materialId: number): number {
    const row = getDatabase()
      .get<{ total: number | null }>(
        sql`SELECT COALESCE(SUM(qty_remaining_micro), 0) AS total
            FROM fifo_layers WHERE material_id = ${materialId}`
      )
    return row?.total ?? 0
  },

  nextSeq(materialId: number): number {
    const row = getDatabase()
      .get<{ maxSeq: number | null }>(
        sql`SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM fifo_layers WHERE material_id = ${materialId}`
      )
    return (row?.maxSeq ?? 0) + 1
  },

  insertLayer(values: {
    materialId: number
    sourceKind: string
    sourceRefId?: number | null
    batchCode?: string | null
    qtyMicro: number
    unitCostMicro: number
    receivedAt: string
    seq: number
  }): number {
    const result = getDatabase()
      .insert(fifoLayers)
      .values({
        materialId: values.materialId,
        sourceKind: values.sourceKind,
        sourceRefId: values.sourceRefId ?? null,
        batchCode: values.batchCode ?? null,
        qtyReceivedMicro: values.qtyMicro,
        qtyRemainingMicro: values.qtyMicro,
        unitCostMicro: values.unitCostMicro,
        receivedAt: values.receivedAt,
        seq: values.seq
      })
      .run()
    return Number(result.lastInsertRowid)
  },

  /** Guarded decrement — the WHERE clause makes over-consumption impossible
   *  even if two code paths raced (they cannot: writes are synchronous). */
  decrementLayer(layerId: number, qtyMicro: number): boolean {
    const result = getDatabase()
      .run(
        sql`UPDATE fifo_layers SET qty_remaining_micro = qty_remaining_micro - ${qtyMicro}
            WHERE id = ${layerId} AND qty_remaining_micro >= ${qtyMicro}`
      )
    return result.changes === 1
  },

  insertMovement(values: {
    materialId: number
    kind: string
    qtyMicro: number
    orderId?: number | null
    actualCostMinor?: number
    sourceKind?: string | null
    sourceRefId?: number | null
    reversalOfMovementId?: number | null
    reason?: string | null
    createdBy?: number | null
    createdAt: string
  }): number {
    const result = getDatabase()
      .insert(inventoryMovements)
      .values({
        materialId: values.materialId,
        kind: values.kind,
        qtyMicro: values.qtyMicro,
        orderId: values.orderId ?? null,
        actualCostMinor: values.actualCostMinor ?? 0,
        sourceKind: values.sourceKind ?? null,
        sourceRefId: values.sourceRefId ?? null,
        reversalOfMovementId: values.reversalOfMovementId ?? null,
        reason: values.reason ?? null,
        createdBy: values.createdBy ?? null,
        createdAt: values.createdAt
      })
      .run()
    return Number(result.lastInsertRowid)
  },

  setMovementCost(movementId: number, actualCostMinor: number): void {
    getDatabase()
      .update(inventoryMovements)
      .set({ actualCostMinor })
      .where(eq(inventoryMovements.id, movementId))
      .run()
  },

  insertAllocation(values: {
    movementId: number
    layerId: number
    qtyMicro: number
    unitCostMicro: number
    costMinor: number
  }): void {
    getDatabase().insert(fifoAllocations).values(values).run()
  },

  allocationsForMovement(movementId: number) {
    return getDatabase()
      .select()
      .from(fifoAllocations)
      .where(eq(fifoAllocations.movementId, movementId))
      .all()
  },

  restoreLayer(layerId: number, qtyMicro: number): boolean {
    const result = getDatabase().run(sql`
      UPDATE fifo_layers
      SET qty_remaining_micro = qty_remaining_micro + ${qtyMicro}
      WHERE id = ${layerId}
        AND qty_remaining_micro + ${qtyMicro} <= qty_received_micro
    `)
    return result.changes === 1
  },

  insertRemainder(values: {
    materialId: number
    layerId?: number | null
    sizeMicro: number
    sourceNote?: string | null
    createdAt: string
  }): void {
    getDatabase()
      .insert(materialRemainders)
      .values({
        materialId: values.materialId,
        layerId: values.layerId ?? null,
        sizeMicro: values.sizeMicro,
        sourceNote: values.sourceNote ?? null,
        createdAt: values.createdAt
      })
      .run()
  },

  /** BR-95: stock and FIFO value per material, computed from live layers. */
  stockByMaterial(): Array<{ materialId: number; qtyMicro: number; fifoValueMinor: number }> {
    return getDatabase()
      .all<{ materialId: number; qtyMicro: number; fifoValueMinor: number }>(
        sql`SELECT material_id AS materialId,
                   COALESCE(SUM(qty_remaining_micro), 0) AS qtyMicro,
                   CAST(ROUND(COALESCE(SUM(
                     (CAST(qty_remaining_micro AS REAL) / 1000000.0) * (CAST(unit_cost_micro AS REAL) / 1000.0)
                   ), 0)) AS INTEGER) AS fifoValueMinor
            FROM fifo_layers
            GROUP BY material_id`
      )
  },

  wasteTotalMinor(from: string, to: string): number {
    const row = getDatabase()
      .get<{ total: number | null }>(
        sql`SELECT COALESCE(SUM(actual_cost_minor), 0) AS total
            FROM inventory_movements
            WHERE kind = 'waste' AND created_at >= ${from} AND created_at <= ${to}`
      )
    return row?.total ?? 0
  }
}
