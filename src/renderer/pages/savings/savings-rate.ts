/** Existing presets; arbitrary valid stored rates are not a new preset policy. */
export const RATE_OPTIONS = [0, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000]

export function isSavingsRateBp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10000
}

export function savingsRateOptions(currentRateBp: unknown, draftRateBp?: unknown): number[] {
  return [...new Set([...RATE_OPTIONS, 10000, ...[currentRateBp, draftRateBp].filter(isSavingsRateBp)])].sort((a, b) => a - b)
}

export function parseSavingsRateDraft(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return undefined
  const rate = Number(value)
  return isSavingsRateBp(rate) ? rate : undefined
}

const rateFormat = new Intl.NumberFormat('ar-LY-u-nu-latn', { maximumFractionDigits: 2 })
export function savingsRateLabel(rateBp: number): string {
  return `${rateFormat.format(rateBp / 100)}%`
}
