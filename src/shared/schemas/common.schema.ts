import { z } from 'zod'

/**
 * Reusable Zod primitives shared across future IPC contracts. Money
 * and quantity values are validated as the same integer minor/micro
 * units used internally (see src/shared/money, src/shared/quantity) —
 * never as raw floats — so a bad payload can never introduce a
 * fractional cent/unit into a financial or inventory calculation.
 */
/** A JSON number that can round-trip through JavaScript and SQLite exactly. */
export const safeIntegerSchema = z.number().int().safe()
export const safePositiveIntegerSchema = safeIntegerSchema.positive()
export const safeNonNegativeIntegerSchema = safeIntegerSchema.nonnegative()

/** Domain aliases keep IPC schemas explicit without allowing policy drift. */
export const integerIdSchema = safePositiveIntegerSchema
export const moneyMinorSchema = safeIntegerSchema
export const positiveMoneyMinorSchema = safePositiveIntegerSchema
export const nonNegativeMoneyMinorSchema = safeNonNegativeIntegerSchema
export const quantityMicroSchema = safeIntegerSchema
export const positiveQuantityMicroSchema = safePositiveIntegerSchema
export const nonNegativeQuantityMicroSchema = safeNonNegativeIntegerSchema
export const basisPointsSchema = safeIntegerSchema.min(0).max(10_000)

/** Backward-compatible names used by existing shared contracts. */
export const nonNegativeIntegerSchema = safeNonNegativeIntegerSchema
/** A display-only percentage may intentionally contain a fraction. */
export const percentageSchema = z.number().finite().min(0).max(100)
export const nonEmptyStringSchema = z.string().trim().min(1)
