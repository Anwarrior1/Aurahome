import { businessDate } from '@shared/business-date'

/**
 * Display-only formatting. Authoritative money/quantity values are
 * computed in main (src/shared/money, src/shared/quantity); the
 * renderer only converts them for display and parses user input back
 * into the same integer units before sending it.
 *
 * `-u-nu-latn` forces Western digits 0-9 everywhere (BR-27).
 */
const MINOR_PER_LYD = 1000
const QTY_SCALE = 1_000_000

const moneyFmt = new Intl.NumberFormat('ar-LY-u-nu-latn', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})
const qtyFmt = new Intl.NumberFormat('ar-LY-u-nu-latn', { maximumFractionDigits: 3 })
const intFmt = new Intl.NumberFormat('ar-LY-u-nu-latn', { maximumFractionDigits: 0 })

export function fmtMoney(minor: number | null | undefined): string {
  return `${moneyFmt.format((minor ?? 0) / MINOR_PER_LYD)} د.ل`
}

export function fmtMoneyPlain(minor: number | null | undefined): string {
  return moneyFmt.format((minor ?? 0) / MINOR_PER_LYD)
}

export function fmtQty(micro: number | null | undefined, unit?: string | null): string {
  const text = qtyFmt.format((micro ?? 0) / QTY_SCALE)
  return unit ? `${text} ${unit}` : text
}

export function fmtNumber(value: number | null | undefined): string {
  return intFmt.format(value ?? 0)
}

export function fmtPercent(basisPoints: number | null | undefined): string {
  return `${intFmt.format((basisPoints ?? 0) / 100)}%`
}

export function depositPreviewPercent(value: string, defaultBasisPoints: number): number {
  return value === '' ? defaultBasisPoints / 100 : Number(value)
}

export function toMinor(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value.replace(/,/g, ''))
  return Number.isFinite(parsed) ? Math.round(parsed * MINOR_PER_LYD) : 0
}

export function toMicro(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value.replace(/,/g, ''))
  return Number.isFinite(parsed) ? Math.round(parsed * QTY_SCALE) : 0
}

export function fromMinor(minor: number | null | undefined): string {
  return String((minor ?? 0) / MINOR_PER_LYD)
}

export function fromMicro(micro: number | null | undefined): string {
  return String((micro ?? 0) / QTY_SCALE)
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('ar-LY-u-nu-latn', { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('ar-LY-u-nu-latn', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(date)
}

export function todayIso(): string {
  return businessDate()
}

/**
 * dd/mm/yyyy, always Western digits, constructed manually rather than
 * via Intl — guarantees the exact numeric format the headbar's date
 * navigator needs (BR-27), independent of any locale's separator/
 * month-name conventions.
 */
export function fmtDateSlash(iso: string): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  const day = String(date.getUTCDate()).padStart(2, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const year = date.getUTCFullYear()
  return `${day}/${month}/${year}`
}

/** "10 سبتمبر 2026" — the headbar date navigator's own main display,
 *  same UTC-anchored parsing as fmtDate/fmtDateSlash (BR-27's Western
 *  digits, no timezone drift — this is presentation only, never the
 *  authoritative selected-date value itself). */
export function fmtDateLong(iso: string): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  return new Intl.DateTimeFormat('ar-LY-u-nu-latn', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  }).format(date)
}

/** "الخميس" — the weekday for the same date, secondary to fmtDateLong. */
export function fmtWeekday(iso: string): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  return new Intl.DateTimeFormat('ar-LY-u-nu-latn', { weekday: 'long', timeZone: 'UTC' }).format(date)
}

export function shiftDateIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
