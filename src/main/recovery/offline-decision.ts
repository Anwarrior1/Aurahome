import { lstat } from 'node:fs/promises'
import { sha256File } from '../backup/archive'
import type { OfflineInspection } from './offline-inspection'

export interface LegacyDecisionInput {
  incidentId: string
  custodyExplanation: string
  reportedProvenanceEvidence?: string[]
  acceptsUnknownOrigin: boolean
  acceptsPossibleNewerTransactionLoss: boolean
  decision: 'accept' | 'reject'
}

/** A macOS development receipt records intent, not identity, authenticity, or protected storage. */
export interface LegacyDecisionReceipt {
  version: 1
  incidentId: string
  archive: { sha256: string; bytes: number; unverifiedDate: string }
  validation: { candidateSha256: string; checksRun: 73; errors: 0; warnings: 0 }
  origin: 'UNKNOWN ORIGIN'
  custodyExplanation: string
  reportedProvenanceEvidence: string[]
  acceptsUnknownOrigin: boolean
  acceptsPossibleNewerTransactionLoss: boolean
  decision: 'accept' | 'reject'
  ownerIdentityVerified: false
  protectedStorageVerified: false
  recordedAt: string
}

function technicallyValid(inspection: OfflineInspection): boolean {
  return inspection.valid && /^[a-f0-9]{64}$/.test(inspection.archiveSha256) &&
    Number.isSafeInteger(inspection.archiveBytes) && inspection.archiveBytes > 0 &&
    inspection.origin === 'UNKNOWN ORIGIN' && !!inspection.manifest &&
    typeof inspection.manifest.createdAt === 'string' &&
    /^[a-f0-9]{64}$/.test(inspection.manifest.databaseSha256) &&
    inspection.reconciliation?.checksRun === 73 &&
    inspection.reconciliation.errorCount === 0 && inspection.reconciliation.warningCount === 0 &&
    inspection.reconciliation.findings.length === 0
}

export function recordLegacyDecision(
  inspection: OfflineInspection, input: LegacyDecisionInput
): LegacyDecisionReceipt {
  if (!technicallyValid(inspection)) throw new Error('Technical validation has not passed')
  const incidentId = input.incidentId.trim()
  const custodyExplanation = input.custodyExplanation.trim()
  if (!incidentId || incidentId.length > 128 || !custodyExplanation || custodyExplanation.length > 1000) {
    throw new Error('An incident ID and custody explanation are required')
  }
  if (input.decision !== 'accept' && input.decision !== 'reject') throw new Error('Invalid decision')
  if (input.decision === 'accept' && (!input.acceptsUnknownOrigin || !input.acceptsPossibleNewerTransactionLoss)) {
    throw new Error('Both residual risks require explicit acceptance')
  }
  const reportedProvenanceEvidence = input.reportedProvenanceEvidence ?? []
  if (!Array.isArray(reportedProvenanceEvidence) || reportedProvenanceEvidence.length > 8 ||
      reportedProvenanceEvidence.some((value) =>
    typeof value !== 'string' || value.length > 500)) throw new Error('Invalid provenance note')
  return {
    version: 1,
    incidentId,
    archive: { sha256: inspection.archiveSha256, bytes: inspection.archiveBytes,
      unverifiedDate: inspection.manifest!.createdAt },
    validation: { candidateSha256: inspection.manifest!.databaseSha256, checksRun: 73, errors: 0, warnings: 0 },
    origin: 'UNKNOWN ORIGIN', custodyExplanation, reportedProvenanceEvidence: [...reportedProvenanceEvidence],
    acceptsUnknownOrigin: input.acceptsUnknownOrigin,
    acceptsPossibleNewerTransactionLoss: input.acceptsPossibleNewerTransactionLoss,
    decision: input.decision, ownerIdentityVerified: false, protectedStorageVerified: false,
    recordedAt: new Date().toISOString()
  }
}

/** Identity check for a future protected handoff; this receipt never grants activation. */
export function decisionMatchesInspection(receipt: LegacyDecisionReceipt, inspection: OfflineInspection): boolean {
  return receipt.version === 1 && receipt.decision === 'accept' && receipt.acceptsUnknownOrigin &&
    receipt.acceptsPossibleNewerTransactionLoss && !receipt.ownerIdentityVerified &&
    !receipt.protectedStorageVerified && technicallyValid(inspection) &&
    receipt.archive.sha256 === inspection.archiveSha256 &&
    receipt.archive.bytes === inspection.archiveBytes &&
    receipt.archive.unverifiedDate === inspection.manifest!.createdAt &&
    receipt.validation.candidateSha256 === inspection.manifest!.databaseSha256 &&
    receipt.validation.checksRun === 73 && receipt.validation.errors === 0 && receipt.validation.warnings === 0 &&
    receipt.origin === 'UNKNOWN ORIGIN'
}

async function fileStillMatches(path: string, expectedSha256: string, expectedBytes?: number): Promise<boolean> {
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() ||
        (expectedBytes !== undefined && before.size !== expectedBytes)) return false
    const sha256 = await sha256File(path)
    const after = await lstat(path)
    return sha256 === expectedSha256 && before.dev === after.dev && before.ino === after.ino &&
      before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
  } catch { return false }
}

/** Recheck bytes only. A matching unprotected receipt is not authority to activate. */
export async function archiveStillMatchesReceipt(receipt: LegacyDecisionReceipt, path: string): Promise<boolean> {
  return receipt.decision === 'accept' && fileStillMatches(path, receipt.archive.sha256, receipt.archive.bytes)
}

/** The extracted SQLite candidate is bound separately from the selected archive. */
export async function candidateStillMatchesReceipt(receipt: LegacyDecisionReceipt, path: string): Promise<boolean> {
  return receipt.decision === 'accept' && fileStillMatches(path, receipt.validation.candidateSha256)
}
