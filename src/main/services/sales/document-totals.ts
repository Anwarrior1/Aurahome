import { applyPercent, multiplyDivideRounded } from '@shared/money/cost'
import { money } from '@shared/money/money'
import { requireSafeInteger, requireSafeNonNegativeInteger, requireSafePositiveInteger } from '../../utils/numeric'

/**
 * Additional document-level charges. Separate from the `requires*`
 * booleans on the documents: those state whether the job INCLUDES the
 * service, these state what it COSTS. Either can be set without the
 * other.
 */
export interface DocumentCharges {
  installationPriceMinor?: number
  deliveryPriceMinor?: number
}

/**
 * The one commercial totals calculation shared by the two customer
 * documents that own lines and prices — the Preliminary Invoice and the
 * Approved Invoice. Extracted so both can never drift apart on
 * rounding, on BR-41 (exactly one document-level discount) or on BR-42
 * (deposit is a percentage of the total AFTER discount).
 *
 * Calculation order:
 *
 *   goods subtotal   = Σ (unit price × quantity), rounded once per line
 *   charges          = installation + delivery      (each counted ONCE)
 *   discount base    = goods subtotal + charges
 *   total            = goods subtotal + charges - discount
 *   deposit required = total × deposit%             (BR-42, after discount)
 *   remaining        = total - deposit required
 *
 * The charges are added BEFORE the discount so that a percentage
 * discount applies to the whole agreed amount rather than to the goods
 * alone, and an amount discount can never exceed what is actually owed.
 * Documents with no charges — every document written before they
 * existed — are arithmetically unchanged by this, since both extra
 * terms are zero.
 *
 * `subtotalMinor` deliberately keeps its original meaning (goods only):
 * it is what the printed "الإجمالي قبل الخصم" row and every existing
 * consumer already read, and the charges are shown as their own rows
 * beneath it rather than silently folded into it.
 *
 * سعر المتر is NOT an input here: this document model has no
 * metre-based quantity to multiply it by (a line carries a plain
 * quantity and free-text dimensions), so it is carried as commercial
 * information only and never alters a total.
 */
export function computeDocumentTotals(
  lines: Array<{ quantityMicro: number; unitPriceMinor: number }>,
  discountKind: 'none' | 'amount' | 'percent',
  discountValue: number,
  depositPercentBp: number,
  charges: DocumentCharges = {}
) {
  for (const line of lines) {
    requireSafePositiveInteger(line.quantityMicro, 'الكمية')
    requireSafeNonNegativeInteger(line.unitPriceMinor, 'سعر الوحدة')
  }
  requireSafeNonNegativeInteger(discountValue, 'قيمة الخصم')
  if (discountKind === 'percent') requireSafeInteger(discountValue, 'نسبة الخصم', { min: 0, max: 10_000 })
  requireSafeInteger(depositPercentBp, 'نسبة العربون', { min: 0, max: 10_000 })
  requireSafeNonNegativeInteger(charges.installationPriceMinor ?? 0, 'سعر التركيب')
  requireSafeNonNegativeInteger(charges.deliveryPriceMinor ?? 0, 'سعر التوصيل')
  // Line total = unit price × quantity, rounded once at the line (AD-1).
  const lineTotals = lines.map((line) =>
    multiplyDivideRounded(line.unitPriceMinor, line.quantityMicro, 1_000_000)
  )
  const subtotalMinor = money(lineTotals.reduce((sum, total) => sum + total, 0))

  const installationPriceMinor = charges.installationPriceMinor ?? 0
  const deliveryPriceMinor = charges.deliveryPriceMinor ?? 0
  const chargesMinor = money(installationPriceMinor + deliveryPriceMinor)
  const chargedSubtotalMinor = money(subtotalMinor + chargesMinor)

  // BR-41: exactly one document-level discount.
  let discountMinor = 0
  if (discountKind === 'amount') discountMinor = Math.min(discountValue, chargedSubtotalMinor)
  else if (discountKind === 'percent') discountMinor = applyPercent(money(chargedSubtotalMinor), discountValue)

  const totalMinor = chargedSubtotalMinor - discountMinor
  // BR-42: deposit is a percentage of the total AFTER discount.
  const depositRequiredMinor = applyPercent(money(totalMinor), depositPercentBp)
  return {
    lineTotals,
    /** Goods only — charges are reported separately, never folded in. */
    subtotalMinor,
    installationPriceMinor,
    deliveryPriceMinor,
    chargesMinor,
    discountMinor,
    totalMinor,
    depositRequiredMinor,
    remainingMinor: totalMinor - depositRequiredMinor
  }
}
