import { AppError } from './errors'

/** Runtime guard for service callers that do not pass through IPC/Zod. */
export function requireSafeInteger(
  value: number,
  label: string,
  options: { min?: number; max?: number } = {}
): number {
  if (!Number.isSafeInteger(value)) {
    throw new AppError('VALIDATION_ERROR', `${label} يجب أن يكون عدداً صحيحاً آمناً`)
  }
  if (options.min !== undefined && value < options.min) {
    throw new AppError('VALIDATION_ERROR', options.min === 1
      ? `${label} يجب أن يكون أكبر من صفر`
      : options.min === 0
        ? `${label} لا يمكن أن يكون سالباً`
        : `${label} أقل من الحد الأدنى`)
  }
  if (options.max !== undefined && value > options.max) {
    throw new AppError('VALIDATION_ERROR', `${label} أكبر من الحد الأعلى`)
  }
  return value
}

export function requireSafePositiveInteger(value: number, label: string): number {
  return requireSafeInteger(value, label, { min: 1 })
}

export function requireSafeNonNegativeInteger(value: number, label: string): number {
  return requireSafeInteger(value, label, { min: 0 })
}
