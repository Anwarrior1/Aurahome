import { auditLog } from '../db/schema/audit.schema'
import { getDatabase } from '../db/connection'
import { nowIso } from '../services/base/service.types'

export interface AuditEvent {
  userId?: number
  action: string
  entity: string
  entityId?: string
  details?: unknown
}

/**
 * Append-only (Step 2 §6) — this is the only function permitted to
 * write to audit_log, and it only ever INSERTs.
 */
export function recordAuditEvent(event: AuditEvent): void {
  getDatabase()
    .insert(auditLog)
    .values({
      userId: event.userId,
      action: event.action,
      entity: event.entity,
      entityId: event.entityId,
      details: event.details ? JSON.stringify(event.details) : null,
      createdAt: nowIso()
    })
    .run()
}
