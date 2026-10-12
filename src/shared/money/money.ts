/**
 * AD-1 (Step 2 approval): all money is stored and computed as an
 * integer number of "minor units" — 1 LYD = 1000 minor units, dirham-
 * scale precision — so no money value in this codebase is ever a
 * JavaScript float. Display and printing round to 2 decimals at this
 * single formatting boundary; nowhere else rounds a money value.
 */
const MINOR_UNITS_PER_LYD = 1000

export type Money = number & { readonly __brand: 'MoneyMinorUnits' }

export function money(minorUnits: number): Money {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new TypeError('Money must be a safe integer number of minor units')
  }
  return minorUnits as Money
}

export function moneyFromMajor(amountLYD: number): Money {
  if (!Number.isFinite(amountLYD)) throw new TypeError('Money input must be finite')
  return money(Math.round(amountLYD * MINOR_UNITS_PER_LYD))
}

export function moneyToMajor(amount: Money): number {
  return amount / MINOR_UNITS_PER_LYD
}

export function addMoney(a: Money, b: Money): Money {
  return money(a + b)
}

export function subtractMoney(a: Money, b: Money): Money {
  return money(a - b)
}

export function multiplyMoney(a: Money, factor: number): Money {
  return money(Math.round(a * factor))
}

const displayFormatter = new Intl.NumberFormat('ar-LY-u-nu-latn', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

/**
 * The one place a money value becomes a printable string. The
 * `-u-nu-latn` Unicode extension forces Western digits 0-9 and
 * structurally prevents Arabic-Indic digits from ever appearing
 * (BR-27), regardless of the underlying Arabic locale.
 */
export function formatMoney(amount: Money): string {
  return `${displayFormatter.format(moneyToMajor(amount))} د.ل`
}
