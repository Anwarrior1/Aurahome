import { describe, expect, it } from 'vitest'
import { plannedRecoveryTransitions, isPlannedRecoveryTransition, evaluateRecoveryAdmission } from '../../src/main/recovery/offline-state'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const states = [
  'candidate_validated', 'exception_authorized', 'preservation_started',
  'preservation_verified', 'replacement_staged', 'activation_pending',
  'activation_in_progress', 'replacement_activated', 'validation_pending',
  'review_pending', 'complete', 'rollback_pending', 'failed'
] as const

describe('formal recovery transition plan, without production activation', () => {
  it('names every required state and only explicit next states', () => {
    expect(Object.keys(plannedRecoveryTransitions).sort()).toEqual([...states].sort())
    expect(isPlannedRecoveryTransition('candidate_validated', 'exception_authorized')).toBe(true)
    expect(isPlannedRecoveryTransition('review_pending', 'complete')).toBe(true)
    expect(isPlannedRecoveryTransition('candidate_validated', 'activation_in_progress')).toBe(false)
    expect(isPlannedRecoveryTransition('failed', 'complete')).toBe(false)
    expect(isPlannedRecoveryTransition('complete', 'candidate_validated')).toBe(false)
  })

  it.each(states)('blocks normal startup for any %s marker, including claimed completion', (state) => {
    const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-states-'))
    writeFileSync(join(root, 'hold.json'), JSON.stringify({ version: 1, operationId: 'fictional' }))
    writeFileSync(join(root, 'journal.json'), JSON.stringify({ version: 1, operationId: 'fictional', state,
      archiveSha256: 'a'.repeat(64), financialReviewApproved: state === 'complete' }))
    expect(evaluateRecoveryAdmission(root).allowed).toBe(false)
  })
})
