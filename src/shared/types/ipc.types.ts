/**
 * Normalized envelope every IPC call resolves to. A service/handler
 * never throws across the main↔renderer boundary — it always resolves
 * one of these two shapes so the renderer has exactly one way to
 * handle failure (Step 2 §3, Step 3 IPC requirements).
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

export interface IpcError {
  code: IpcErrorCode
  /** Arabic, user-safe. Never a raw stack trace, SQL error, or file path. */
  message: string
}

export type IpcErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'INTERNAL_ERROR'
