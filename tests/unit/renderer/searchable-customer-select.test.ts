import { describe, expect, it } from 'vitest'
import { filterCustomerOptions, type CustomerOption } from '@renderer/components/customers/SearchableCustomerSelect'

/**
 * `filterCustomerOptions` is the real, executable filtering logic
 * behind the customer search dropdown shared by the Preliminary and
 * Approved Invoice forms — factored out as a pure function so it runs
 * here directly (no jsdom is configured for this renderer; see
 * vitest.config.ts), rather than only being pinned as source text.
 *
 * Because it is a pure narrowing of whatever array is handed to it,
 * these tests also stand in for the RBAC/visibility guarantee: it can
 * never surface a customer that was not already in its input.
 */
const CUSTOMERS: CustomerOption[] = [
  { id: 1, name: 'anwar', phone: '0912345678' },
  { id: 2, name: 'عميل تجريبي - أثاث', phone: '0921112233' },
  { id: 3, name: 'عميل تجريبي - مطبخ', phone: null },
  { id: 4, name: 'Anwar Trading Co.', phone: '0209998877' }
]

describe('filterCustomerOptions — name search', () => {
  it('matches by a partial name (item 3/10)', () => {
    const result = filterCustomerOptions(CUSTOMERS, 'anwar')
    expect(result.map((c) => c.id)).toEqual(expect.arrayContaining([1, 4]))
    expect(result).toHaveLength(2)
  })

  it('is case-insensitive for Latin text', () => {
    expect(filterCustomerOptions(CUSTOMERS, 'ANWAR').map((c) => c.id)).toEqual(
      filterCustomerOptions(CUSTOMERS, 'anwar').map((c) => c.id)
    )
    expect(filterCustomerOptions(CUSTOMERS, 'AnWaR')).toHaveLength(2)
  })

  it('ignores leading/trailing whitespace', () => {
    expect(filterCustomerOptions(CUSTOMERS, '   anwar   ')).toHaveLength(2)
  })

  it('an empty or whitespace-only query returns the full given list unchanged', () => {
    expect(filterCustomerOptions(CUSTOMERS, '')).toEqual(CUSTOMERS)
    expect(filterCustomerOptions(CUSTOMERS, '   ')).toEqual(CUSTOMERS)
  })
})

describe('filterCustomerOptions — Arabic name search (item 4/11)', () => {
  it('matches an Arabic substring correctly', () => {
    const result = filterCustomerOptions(CUSTOMERS, 'مطبخ')
    expect(result.map((c) => c.id)).toEqual([3])
  })

  it('matches a shared Arabic prefix across multiple customers', () => {
    const result = filterCustomerOptions(CUSTOMERS, 'عميل تجريبي')
    expect(result.map((c) => c.id).sort()).toEqual([2, 3])
  })
})

describe('filterCustomerOptions — phone search (item 5/12)', () => {
  it('matches a partial phone number', () => {
    expect(filterCustomerOptions(CUSTOMERS, '91234').map((c) => c.id)).toEqual([1])
  })

  it('never throws for a customer with no phone on file', () => {
    expect(() => filterCustomerOptions(CUSTOMERS, '000')).not.toThrow()
    expect(filterCustomerOptions(CUSTOMERS, '000')).toEqual([])
  })
})

describe('filterCustomerOptions — no match (item 7)', () => {
  it('returns an empty array — never an error, never a fallback list — for text matching nothing', () => {
    expect(filterCustomerOptions(CUSTOMERS, 'xyz-no-such-customer')).toEqual([])
  })
})

describe('filterCustomerOptions — cannot widen visibility (item 16/17)', () => {
  it('is a pure narrowing of its own input: a customer absent from the input can never appear in the output', () => {
    const restricted = CUSTOMERS.filter((c) => c.id !== 2) // as if RBAC/active-only already excluded #2
    const result = filterCustomerOptions(restricted, 'عميل')
    expect(result.map((c) => c.id)).not.toContain(2)
  })

  it('an empty permitted list stays empty regardless of query', () => {
    expect(filterCustomerOptions([], 'anwar')).toEqual([])
  })
})
