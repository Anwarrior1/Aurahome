import { describe, expect, it } from 'vitest'
import { prepareFinancialReview } from '../../src/main/recovery/offline-financial-review'
import type { OfflineInspection } from '../../src/main/recovery/offline-inspection'

const inspection: OfflineInspection = {
  valid: true, archiveSha256: 'a'.repeat(64), archiveBytes: 100,
  origin: 'UNKNOWN ORIGIN',
  reconciliation: { checksRun: 73, errorCount: 0, warningCount: 0, findings: [] }
}
const domains = ['cash', 'customers', 'worker_payable', 'worker_debt', 'stock_quantity',
  'fifo_value', 'invoices', 'recent_transactions'] as const
const comparisons = domains.map((domain) => ({ domain, expected: '50000', actual: '050000',
  independentSource: 'fictional handwritten oracle' }))

describe('fictional financial review contract', () => {
  it('compares exact integer values and keeps startup release unavailable', () => {
    const draft = prepareFinancialReview(inspection, comparisons)
    expect(draft.readyForOwnerReview).toBe(true)
    expect(draft.startupHoldReleaseAllowed).toBe(false)
    expect(draft.domains).toHaveLength(8)
    expect(draft.domains.every((domain) => domain.agrees)).toBe(true)
  })

  it('blocks missing or discrepant oracle domains and failed reconciliation', () => {
    expect(() => prepareFinancialReview(inspection, comparisons.slice(1))).toThrow()
    const mismatch = comparisons.map((value) => value.domain === 'worker_debt' ? { ...value, actual: '49999' } : value)
    expect(prepareFinancialReview(inspection, mismatch).readyForOwnerReview).toBe(false)
    expect(() => prepareFinancialReview({ ...inspection, valid: false }, comparisons)).toThrow()
    expect(() => prepareFinancialReview({ ...inspection, reconciliation: undefined }, comparisons)).toThrow()
  })

  it('rejects floats, unsupported amounts and missing independent source', () => {
    expect(() => prepareFinancialReview(inspection, [{ ...comparisons[0]!, actual: '1.5' }, ...comparisons.slice(1)])).toThrow()
    expect(() => prepareFinancialReview(inspection, [{ ...comparisons[0]!, independentSource: '' }, ...comparisons.slice(1)])).toThrow()
    expect(() => prepareFinancialReview(inspection, [{ ...comparisons[0]!, actual: '9'.repeat(100_000) }, ...comparisons.slice(1)])).toThrow()
  })
})
