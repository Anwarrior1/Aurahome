/** The offline factory machine's local calendar is AURA's business calendar. */
export function businessDate(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** UTC instants bounding a local business day; explicit YYYY-MM-DD is never shifted. */
export function businessDayBounds(date: string): { from: string; to: string } {
  const [year, month, day] = date.slice(0, 10).split('-').map(Number) as [number, number, number]
  return {
    from: new Date(year, month - 1, day).toISOString(),
    to: new Date(new Date(year, month - 1, day + 1).getTime() - 1).toISOString()
  }
}

export function businessMonthBounds(year: number, month: number): {
  from: string; to: string; fromDate: string; toDate: string
} {
  const start = new Date(year, month - 1, 1)
  const end = new Date(new Date(year, month, 1).getTime() - 1)
  return { from: start.toISOString(), to: end.toISOString(), fromDate: businessDate(start), toDate: businessDate(end) }
}
