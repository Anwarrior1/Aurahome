import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { financialCommandRequests } from '../../db/schema/idempotency.schema'
import { withTransaction } from '../../db/transactions'
import { AppError } from '../../utils/errors'
import { nowIso, type ServiceContext } from '../base/service.types'

const REQUEST_KEY_MIN_LENGTH = 8
const REQUEST_KEY_MAX_LENGTH = 100

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    )
  }
  return value
}

export function financialCommandPayloadHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex')
}

function encodeResult(result: unknown): string {
  return JSON.stringify(result === undefined ? null : result)
}

function decodeResult<T>(resultJson: string): T {
  const decoded = JSON.parse(resultJson) as T | null
  return (decoded === null ? undefined : decoded) as T
}

export interface IdempotentFinancialCommand<T> {
  commandScope: string
  requestKey: string
  payload: unknown
  ctx: ServiceContext
  /** Validation that must still run for both first delivery and replay. */
  validate?: () => void
  execute: () => T
  onReplay?: (original: T) => T
}

/**
 * Runs one financial command and its durable request receipt atomically.
 * Authorization and static input validation remain the caller service's job
 * and must run before entering this helper.
 */
export function runIdempotentFinancialCommand<T>(command: IdempotentFinancialCommand<T>): T {
  const requestKey = command.requestKey.trim()
  if (requestKey.length < REQUEST_KEY_MIN_LENGTH || requestKey.length > REQUEST_KEY_MAX_LENGTH) {
    throw new AppError('VALIDATION_ERROR', 'معرّف الطلب غير صالح')
  }
  const payloadHash = financialCommandPayloadHash(command.payload)

  return withTransaction(() => {
    const db = getDatabase()
    command.validate?.()
    const existing = db
      .select()
      .from(financialCommandRequests)
      .where(
        and(
          eq(financialCommandRequests.commandScope, command.commandScope),
          eq(financialCommandRequests.requestKey, requestKey)
        )
      )
      .get()

    if (existing) {
      if (existing.createdBy !== command.ctx.session.user.id) {
        throw new AppError('CONFLICT', 'معرّف الطلب مستخدم من مستخدم آخر')
      }
      if (existing.payloadHash !== payloadHash) {
        throw new AppError('CONFLICT', 'معرّف الطلب مستخدم لعملية مختلفة')
      }
      const original = decodeResult<T>(existing.resultJson)
      return command.onReplay ? command.onReplay(original) : original
    }

    const completedAt = nowIso()
    const requestId = Number(
      db
        .insert(financialCommandRequests)
        .values({
          commandScope: command.commandScope,
          requestKey,
          payloadHash,
          // A placeholder exists only inside this uncommitted transaction.
          // It is replaced before commit; any thrown error rolls it back.
          resultJson: 'null',
          createdBy: command.ctx.session.user.id,
          createdAt: completedAt,
          completedAt
        })
        .run().lastInsertRowid
    )

    const result = command.execute()
    db.update(financialCommandRequests)
      .set({ resultJson: encodeResult(result), completedAt: nowIso() })
      .where(eq(financialCommandRequests.id, requestId))
      .run()
    return result
  })
}

/**
 * Compatibility bridge for trusted/internal callers that predate DB-05.
 * Every external IPC schema requires requestKey; internal child operations
 * keep their existing parent transaction and do not invent a retry identity.
 */
export function runOptionalIdempotentFinancialCommand<T>(
  command: Omit<IdempotentFinancialCommand<T>, 'requestKey'> & { requestKey?: string }
): T {
  if (!command.requestKey) return withTransaction(command.execute)
  return runIdempotentFinancialCommand({ ...command, requestKey: command.requestKey })
}
