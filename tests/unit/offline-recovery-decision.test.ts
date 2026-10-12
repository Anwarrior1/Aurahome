import { describe, expect, it } from 'vitest'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { recordLegacyDecision, decisionMatchesInspection, archiveStillMatchesReceipt } from '../../src/main/recovery/offline-decision'
import type { OfflineInspection } from '../../src/main/recovery/offline-inspection'

const HASH = 'a'.repeat(64)
const DATE = '2026-01-01T00:00:00.000Z'
const inspected: OfflineInspection = {
  valid: true, archiveSha256: HASH, archiveBytes: 1024, origin: 'UNKNOWN ORIGIN',
  manifest: { appVersion: '0.1', schemaVersion: 53, createdAt: DATE, machineName: 'fictional',
    recordCounts: {}, databaseSha256: 'b'.repeat(64) },
  reconciliation: { checksRun: 73, errorCount: 0, warningCount: 0, findings: [] }
}
const input = { incidentId: 'fictional-incident-1', custodyExplanation: 'unknown',
  acceptsUnknownOrigin: true, acceptsPossibleNewerTransactionLoss: true, decision: 'accept' as const }

describe('exact unsigned-archive incident decision', () => {
  it('records exact bytes, unverified date, validation facts and explicit unknown origin', () => {
    const receipt = recordLegacyDecision(inspected, input)
    expect(receipt.archive).toEqual({ sha256: HASH, bytes: 1024, unverifiedDate: DATE })
    expect(receipt.origin).toBe('UNKNOWN ORIGIN')
    expect(receipt.custodyExplanation).toBe('unknown')
    expect(receipt.ownerIdentityVerified).toBe(false)
    expect(receipt.protectedStorageVerified).toBe(false)
    expect(decisionMatchesInspection(receipt, inspected)).toBe(true)
  })

  it('never lets an owner decision override failed technical validation', () => {
    expect(() => recordLegacyDecision({ ...inspected, valid: false }, input)).toThrow()
    expect(() => recordLegacyDecision({ ...inspected, reconciliation: undefined }, input)).toThrow()
    expect(() => recordLegacyDecision({ ...inspected, reconciliation: { checksRun: 73, errorCount: 1, warningCount: 0, findings: [] } }, input)).toThrow()
    expect(() => recordLegacyDecision({ ...inspected, reconciliation: { checksRun: 73, errorCount: 0, warningCount: 0, findings: [{ code: 'F', domain: 'fictional', severity: 'error', entity: 'x', count: 1, sampleIds: [1] }] } }, input)).toThrow()
  })

  it('requires separate explicit acceptance of origin uncertainty and newer-transaction loss', () => {
    expect(() => recordLegacyDecision(inspected, { ...input, acceptsUnknownOrigin: false })).toThrow()
    expect(() => recordLegacyDecision(inspected, { ...input, acceptsPossibleNewerTransactionLoss: false })).toThrow()
    expect(() => recordLegacyDecision(inspected, { ...input, custodyExplanation: '  ' })).toThrow()
    expect(() => recordLegacyDecision(inspected, { ...input, reportedProvenanceEvidence: 'fake' as unknown as string[] })).toThrow()
  })

  it('rechecks the exact archive bytes after a decision without granting activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-decision-'))
    const path = join(root, 'fictional.aurabak')
    writeFileSync(path, Buffer.from('fictional archive bytes'))
    const bytes = 23
    const sha256 = createHash('sha256').update(Buffer.from('fictional archive bytes')).digest('hex')
    const actual = { ...inspected, archiveSha256: sha256, archiveBytes: bytes }
    const receipt = recordLegacyDecision(actual, input)
    expect(await archiveStillMatchesReceipt(receipt, path)).toBe(true)
    symlinkSync(path, join(root, 'link.aurabak'))
    expect(await archiveStillMatchesReceipt(receipt, join(root, 'link.aurabak'))).toBe(false)
    writeFileSync(path, Buffer.from('changed fictional data'))
    expect(await archiveStillMatchesReceipt(receipt, path)).toBe(false)
    expect(receipt.ownerIdentityVerified).toBe(false)
  })

  it('records rejection and rejects substitution of any bound archive fact', () => {
    const rejection = recordLegacyDecision(inspected, { ...input, decision: 'reject' })
    expect(rejection.decision).toBe('reject')
    expect(decisionMatchesInspection(rejection, inspected)).toBe(false)
    const approval = recordLegacyDecision(inspected, input)
    expect(decisionMatchesInspection(approval, { ...inspected, archiveSha256: 'c'.repeat(64) })).toBe(false)
    expect(decisionMatchesInspection(approval, { ...inspected, archiveBytes: 1025 })).toBe(false)
    expect(decisionMatchesInspection(approval, { ...inspected, manifest: { ...inspected.manifest!, createdAt: '2000-01-01' } })).toBe(false)
  })
})
