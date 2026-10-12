/**
 * Quantities are stored as integers at 10^-6 scale so fractional
 * physical consumption (e.g. 0.10 m cut from a 1.50 m board, BR-10) is
 * always exact — never a JavaScript float accumulating drift across
 * many small consumptions of the same material.
 */
const QUANTITY_SCALE = 1_000_000

export type Quantity = number & { readonly __brand: 'QuantityMicroUnits' }

export function quantity(microUnits: number): Quantity {
  if (!Number.isSafeInteger(microUnits)) {
    throw new TypeError('Quantity must be a safe integer number of micro-units')
  }
  return microUnits as Quantity
}

export function quantityFromDisplay(value: number): Quantity {
  if (!Number.isFinite(value)) throw new TypeError('Quantity input must be finite')
  return quantity(Math.round(value * QUANTITY_SCALE))
}

export function quantityToDisplay(value: Quantity): number {
  return value / QUANTITY_SCALE
}

export function addQuantity(a: Quantity, b: Quantity): Quantity {
  return quantity(a + b)
}

export function subtractQuantity(a: Quantity, b: Quantity): Quantity {
  return quantity(a - b)
}

const displayFormatter = new Intl.NumberFormat('ar-LY-u-nu-latn', {
  maximumFractionDigits: 3
})

export function formatQuantity(value: Quantity, unit?: string): string {
  const text = displayFormatter.format(quantityToDisplay(value))
  return unit ? `${text} ${unit}` : text
}
