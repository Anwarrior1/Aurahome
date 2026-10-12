import type { OfflineInspection } from './offline-inspection'

const REQUIRED = [
  'cash', 'customers', 'worker_payable', 'worker_debt', 'stock_quantity',
  'fifo_value', 'invoices', 'recent_transactions'
] as const
export type ReviewDomain = typeof REQUIRED[number]
export interface OracleComparison {
  domain: ReviewDomain
  expected: string
  actual: string
  independentSource: string
}

/** Presentation contract only: callers must obtain real facts and independent records separately. */
export function prepareFinancialReview(inspection: OfflineInspection, comparisons: readonly OracleComparison[]) {
  const reconciliation = inspection.reconciliation
  if (!inspection.valid || reconciliation?.checksRun !== 73 || reconciliation.errorCount !== 0 ||
      reconciliation.warningCount !== 0) throw new Error('Candidate financial validation has not passed')
  if (comparisons.length !== REQUIRED.length || new Set(comparisons.map((entry) => entry.domain)).size !== REQUIRED.length ||
      REQUIRED.some((domain) => !comparisons.some((entry) => entry.domain === domain))) {
    throw new Error('All financial review domains require an independent comparison')
  }
  const parseAmount = (value: string): bigint => {
    if (!/^-?\d{1,19}$/.test(value)) throw new Error('Invalid integer comparison amount')
    const amount = BigInt(value)
    if (amount < -(1n << 63n) || amount > (1n << 63n) - 1n) throw new Error('Comparison amount exceeds SQLite integer range')
    return amount
  }
  const domains = comparisons.map((entry) => {
    if (!entry.independentSource.trim()) throw new Error(`Missing independent source for ${entry.domain}`)
    return { ...entry, agrees: parseAmount(entry.expected) === parseAmount(entry.actual) }
  })
  return { status: 'PREVIEW_ONLY' as const, domains,
    readyForOwnerReview: domains.every((entry) => entry.agrees),
    startupHoldReleaseAllowed: false as const }
}
