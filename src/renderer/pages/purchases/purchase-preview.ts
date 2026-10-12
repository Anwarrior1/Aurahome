import { costOf, unitCostMicro } from '@shared/money/cost'
import { toMicro } from '@renderer/lib/format'

/** Use the submitted scales and the purchase owner's per-line rounding. */
export function purchaseLinePreview(quantity: string, unitPrice: string): number {
  const qtyMicro = toMicro(quantity)
  const unitMicro = Math.round(Number(unitPrice) * 1_000_000)
  if (!Number.isSafeInteger(qtyMicro) || qtyMicro < 0 ||
      !Number.isSafeInteger(unitMicro) || unitMicro < 0) return 0
  try {
    return costOf(qtyMicro, unitCostMicro(unitMicro))
  } catch {
    // Incomplete or out-of-range input has no valid financial preview.
    return 0
  }
}
