import { describe, it, expect } from 'vitest'
import { moneyFromMajor, moneyToMajor, addMoney, formatMoney } from '@shared/money/money'
import { multiplyDivideRounded } from '@shared/money/cost'

describe('money (AD-1: integer minor units, no floats)', () => {
  it('round-trips major/minor conversion exactly', () => {
    const m = moneyFromMajor(187.5)
    expect(moneyToMajor(m)).toBe(187.5)
  })

  it('never loses precision the way plain float addition would', () => {
    const a = moneyFromMajor(0.1)
    const b = moneyFromMajor(0.2)
    expect(moneyToMajor(addMoney(a, b))).toBeCloseTo(0.3, 5)
  })

  it('formats with Western digits and the LYD symbol (BR-27/BR-28)', () => {
    // BR-27 requires Western digit GLYPHS (0-9), never Arabic-Indic
    // (٠١٢٣٤٥٦٧٨٩). It does not mandate a specific grouping/decimal
    // separator convention — ar-LY's own convention (period as
    // thousands separator, comma as decimal separator) is acceptable;
    // only the digit glyphs themselves are asserted here.
    const text = formatMoney(moneyFromMajor(1234.5))
    expect(text).not.toMatch(/[٠-٩]/) // no Arabic-Indic digits
    expect(text).toContain('1')
    expect(text).toContain('234')
    expect(text).toContain('50')
    expect(text).toContain('د.ل')
  })

  it('scales large safe integers exactly before returning to Number', () => {
    expect(multiplyDivideRounded(9_007_199_254_740_000, 123_456, 1_000_000))
      .toBe(1_111_992_791_193_181)
    expect(() => multiplyDivideRounded(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1))
      .toThrow(/safe integer/i)
  })
})
