import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordAuditEvent } from '@main/audit/audit-log.service'
import { getRawConnection } from '@main/db/connection'
import { listAuditLog } from '@main/services/admin/users.service'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

describe('DB-03 audit timestamp integrity', () => {
  it('closes the original real-service reproduction and preserves sortable/filterable chronology', () => {
    recordAuditEvent({ action: 'db03.first', entity: 'audit_log' })
    const first = getRawConnection().prepare("SELECT id, created_at AS createdAt FROM audit_log WHERE action = 'db03.first'").get() as { id: number; createdAt: string }
    const until = Date.now() + 3
    while (Date.now() < until) { /* ensure distinct millisecond stamps */ }
    recordAuditEvent({ action: 'db03.second', entity: 'audit_log' })
    const second = getRawConnection().prepare("SELECT id, created_at AS createdAt FROM audit_log WHERE action = 'db03.second'").get() as { id: number; createdAt: string }

    expect(first.createdAt).toMatch(isoPattern)
    expect(second.createdAt).toMatch(isoPattern)
    expect(first.createdAt).not.toBe('CURRENT_TIMESTAMP')
    expect(second.createdAt > first.createdAt).toBe(true)
    expect(getRawConnection().prepare("SELECT action FROM audit_log WHERE action LIKE 'db03.%' ORDER BY created_at, id").pluck().all())
      .toEqual(['db03.first', 'db03.second'])

    const filtered = listAuditLog({
      action: 'db03.',
      from: first.createdAt,
      to: second.createdAt
    }).items as Array<{ action: string }>
    expect(filtered.map((row) => row.action)).toEqual(['db03.second', 'db03.first'])
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })

  it('uses the same canonical timestamp for a direct database default insert', () => {
    getRawConnection().prepare("INSERT INTO audit_log(action, entity) VALUES ('db03.direct', 'audit_log')").run()
    const value = getRawConnection().prepare("SELECT created_at FROM audit_log WHERE action = 'db03.direct'").pluck().get() as string
    expect(value).toMatch(isoPattern)
    expect(['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME']).not.toContain(value)
  })
})
