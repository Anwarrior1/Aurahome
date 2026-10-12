import { describe, it, expect } from 'vitest'
import { quantityFromDisplay, quantityToDisplay, subtractQuantity } from '@shared/quantity/quantity'

describe('quantity (BR-10: partial consumption, reusable remainder)', () => {
  it('represents a 10cm consumption from a 1.5m board exactly', () => {
    const board = quantityFromDisplay(1.5)
    const consumed = quantityFromDisplay(0.1)
    const remainder = subtractQuantity(board, consumed)
    expect(quantityToDisplay(remainder)).toBeCloseTo(1.4, 6)
  })
})
