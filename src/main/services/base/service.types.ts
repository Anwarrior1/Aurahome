import type { AuthSession } from '@shared/types/user.types'
import { businessDate, businessDayBounds } from '@shared/business-date'

/**
 * Passed into service calls that need to know who is acting — for a
 * second, more specific permission check beyond the IPC guard
 * (e.g. overriding the deposit percentage, BR-65) and for audit
 * attribution (BR-54's "created/modified by").
 */
export interface ServiceContext {
  session: AuthSession
}

export function actorId(ctx: ServiceContext | undefined): number | undefined {
  return ctx?.session.user.id
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function today(): string {
  return businessDate()
}

/**
 * Convert a factory-local business day to UTC instants for timestamp
 * columns. Plain YYYY-MM-DD business dates continue to sort within
 * their own day when compared to these inclusive bounds.
 */
export function dayStart(dateIso: string): string {
  return businessDayBounds(dateIso).from
}

export function dayEnd(dateIso: string): string {
  return businessDayBounds(dateIso).to
}
