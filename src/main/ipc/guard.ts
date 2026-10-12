import type { IpcMainInvokeEvent } from 'electron'
import { ZodError, type ZodType } from 'zod'
import type { IpcResult } from '@shared/types/ipc.types'
import type { AuthSession } from '@shared/types/user.types'
import { getSessionForWebContents } from '../auth/session'
import { requirePermission } from '../permissions/permission-guard'
import { logger } from '../utils/logger'
import { AppError } from '../utils/errors'
import { getDatabasePath } from '../db/connection'
import { restoreRecoveryPending } from '../restore/restore-recovery'
import { admitRestoreProtectedOperation } from '../restore/restore-lifecycle'

export interface HandlerContext {
  session: AuthSession
  webContentsId: number
}

interface GuardOptions<TReq> {
  schema?: ZodType<TReq>
  /** Omit for the few public channels (login, app info). */
  permission?: string
  /** Require a live session without a specific permission key. */
  requireAuth?: boolean
  /** The restore handler acquires exclusive lifecycle ownership itself. */
  restoreExclusive?: boolean
}

/**
 * Wraps every IPC handler with the same steps, in the same order,
 * every time (Step 2 §3/§4):
 *   1. validate the payload shape (Zod)
 *   2. resolve the caller's session from its webContents
 *   3. check the required permission against that session's role
 *   4. run the handler
 * and always resolve a normalized IpcResult — never throw across the
 * main↔renderer boundary, never leak a stack trace or SQL error.
 */
export function createHandler<TReq, TRes>(
  options: GuardOptions<TReq>,
  handler: (request: TReq, ctx: HandlerContext) => Promise<TRes> | TRes
) {
  return async (event: IpcMainInvokeEvent, rawRequest: unknown): Promise<IpcResult<TRes>> => {
    try {
      const request = options.schema ? options.schema.parse(rawRequest ?? {}) : (rawRequest as TReq)

      // A failed in-process restore may leave a durable marker. No IPC may
      // operate on an installed-but-unverified or uncertain database epoch.
      if (restoreRecoveryPending(getDatabasePath())) {
        throw new AppError('CONFLICT', 'الاستعادة غير مكتملة. أعد تشغيل التطبيق لاستعادة حالة قاعدة البيانات')
      }

      const webContentsId = event?.sender?.id ?? 0
      let session: AuthSession | undefined
      if (options.permission || options.requireAuth) {
        session = getSessionForWebContents(webContentsId)
        if (!session) {
          return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'يجب تسجيل الدخول' } }
        }
        if (options.permission) requirePermission(session, options.permission)
      }

      const release = options.restoreExclusive ? undefined : admitRestoreProtectedOperation()
      try {
        const outcome = handler(request, {
          session: session as AuthSession,
          webContentsId
        })
        const asynchronous = outcome instanceof Promise
        const data = await outcome
        // A successful restore intentionally revokes its initiating session.
        if (!options.restoreExclusive && asynchronous && session &&
          getSessionForWebContents(webContentsId)?.sessionId !== session.sessionId) {
          return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'يجب تسجيل الدخول' } }
        }
        return { ok: true, data }
      } finally {
        release?.()
      }
    } catch (error) {
      return toIpcError(error)
    }
  }
}

function toIpcError(error: unknown): IpcResult<never> {
  if (error instanceof AppError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  if (error instanceof ZodError) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'البيانات المُدخلة غير صحيحة' } }
  }
  logger.error('Unhandled error in IPC handler', error)
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'حدث خطأ غير متوقع' } }
}
