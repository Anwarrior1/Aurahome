import { eq, sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { notificationDismissals, notificationReads } from '../../db/schema/notifications.schema'

/**
 * Ends one derived notification occurrence for every user. This only
 * removes notification metadata; the material/order and all of its
 * business history remain untouched. If the condition becomes active
 * later, its deterministic key has no stale read/dismissal state and
 * therefore represents a fresh occurrence again.
 */
export function clearNotificationConditionState(notificationKey: string): void {
  const db = getDatabase()
  db.delete(notificationReads).where(eq(notificationReads.notificationKey, notificationKey)).run()
  db.delete(notificationDismissals).where(eq(notificationDismissals.notificationKey, notificationKey)).run()
}

/**
 * Called after stock/material changes that can resolve a low-stock
 * condition. Querying the same FIFO quantity and reorder fields used
 * by stockLevels() avoids introducing a second stock authority.
 */
export function clearLowStockStateIfResolved(materialId: number): void {
  const row = getDatabase().get<{
    active: number
    qtyMicro: number
    reorderLevelMicro: number
  }>(sql`
    SELECT m.active AS active,
           COALESCE((SELECT SUM(f.qty_remaining_micro) FROM fifo_layers f WHERE f.material_id = m.id), 0) AS qtyMicro,
           m.reorder_level_micro AS reorderLevelMicro
    FROM materials m
    WHERE m.id = ${materialId}
  `)

  if (!row || !row.active || row.reorderLevelMicro <= 0 || row.qtyMicro > row.reorderLevelMicro) {
    clearNotificationConditionState(`low_stock:${materialId}`)
  }
}
