import type { IpcErrorCode } from '@shared/types/ipc.types'

/**
 * The only kind of error a service should throw. The message is
 * Arabic and safe to show a user; a driver error, constraint
 * violation, or unexpected exception must be caught and re-thrown as
 * an AppError (or allowed to fall through to the IPC guard's generic
 * INTERNAL_ERROR handling) before it can leak past the service layer.
 */
export class AppError extends Error {
  readonly code: IpcErrorCode
  constructor(code: IpcErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'AppError'
  }
}

export function forbidden(message = 'لا تملك صلاحية القيام بهذا الإجراء'): AppError {
  return new AppError('FORBIDDEN', message)
}

export function notFound(message = 'العنصر المطلوب غير موجود'): AppError {
  return new AppError('NOT_FOUND', message)
}

export function insufficientStock(message = 'الكمية المتوفرة في المخزون غير كافية'): AppError {
  return new AppError('INSUFFICIENT_STOCK', message)
}
