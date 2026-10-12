import { money, type Money } from './money'

/**
 * AD-1's "high precision inside". Unit costs are stored as LYD × 10^6
 * (six decimal places); quantities as units × 10^6. Multiplying the
 * two would exceed Number.MAX_SAFE_INTEGER for ordinary factory
 * values, so the arithmetic is done in BigInt and only the final
 * rounded result (money minor units, LYD × 1000) returns to a JS
 * number. No cost is lost to float drift, and none can overflow.
 */
export type UnitCostMicro = number & { readonly __brand: 'UnitCostMicroLyd' }

export function unitCostMicro(value: number): UnitCostMicro {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError('Unit cost must be a safe integer at 10^-6 LYD scale')
  }
  return value as UnitCostMicro
}

export function unitCostFromMajor(lyd: number): UnitCostMicro {
  if (!Number.isFinite(lyd)) throw new TypeError('Unit cost input must be finite')
  return unitCostMicro(Math.round(lyd * 1_000_000))
}

export function unitCostToMajor(value: UnitCostMicro): number {
  return value / 1_000_000
}

function roundedDiv(numerator: bigint, denominator: bigint): bigint {
  const half = denominator / 2n
  return numerator >= 0n ? (numerator + half) / denominator : (numerator - half) / denominator
}

function safeIntegerFromBigInt(value: bigint): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || BigInt(result) !== value) {
    throw new RangeError('Integer result exceeds the JavaScript safe integer range')
  }
  return result
}

/** Exact integer a × b ÷ denominator, rounded half away from zero. */
export function multiplyDivideRounded(a: number, b: number, denominator: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) ||
      !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new TypeError('Scaled arithmetic inputs must be safe integers with a positive denominator')
  }
  return safeIntegerFromBigInt(roundedDiv(BigInt(a) * BigInt(b), BigInt(denominator)))
}

/** Editable previews keep invalid/overflowing input visibly invalid, without throwing during render. */
export function previewMultiplyDivideRounded(a: number, b: number, denominator: number): number {
  try {
    return multiplyDivideRounded(a, b, denominator)
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return NaN
    throw error
  }
}

/** Total money (minor units) for qtyMicro units at the given unit cost. */
export function costOf(qtyMicro: number, unit: UnitCostMicro): Money {
  return money(multiplyDivideRounded(qtyMicro, unit, 1_000_000_000))
}

/** The unit cost implied by paying `total` for `qtyMicro` units. */
export function deriveUnitCost(total: Money, qtyMicro: number): UnitCostMicro {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(qtyMicro) || qtyMicro <= 0) {
    throw new RangeError('Safe positive quantity and safe integer total are required')
  }
  return unitCostMicro(multiplyDivideRounded(total, 1_000_000_000, qtyMicro))
}

/** Basis points: 6000 bp = 60% (the confirmed default deposit, BR-42). */
export function applyPercent(amount: Money, basisPoints: number): Money {
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(basisPoints)) {
    throw new TypeError('Percentage inputs must be safe integers')
  }
  return money(multiplyDivideRounded(amount, basisPoints, 10_000))
}
