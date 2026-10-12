import { describe, expect, it } from 'vitest'
import { filterOrderOptions } from '@renderer/components/orders/SearchableOrderSelect'

const orders = [
  { id: 8, documentNumber: 'SO-2026-0008', customerName: 'عميل تجريبي' },
  { id: 9, documentNumber: 'SO-2026-0009', customerName: 'أحمد محمد' }
]

describe('SearchableOrderSelect', () => {
  it('searches by customer-order number', () => {
    expect(filterOrderOptions(orders, '0008')).toEqual([orders[0]])
  })

  it('searches by customer name', () => {
    expect(filterOrderOptions(orders, 'أحمد')).toEqual([orders[1]])
  })
})
