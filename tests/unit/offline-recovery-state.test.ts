import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateRecoveryAdmission, preserveOriginalTuple, beginRecoveryHold, advanceRecoveryState, hasPreservationCapacity } from '../../src/main/recovery/offline-state'

describe('cold recovery fail-closed state and raw preservation', () => {
  it('allows an ordinary installation only when neither recovery state file exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    expect(evaluateRecoveryAdmission(root).allowed).toBe(true)
  })

  it('blocks an active hold with a missing or malformed journal', () => {
    const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    writeFileSync(join(root, 'hold.json'), JSON.stringify({ operationId: 'case-1' }))
    expect(evaluateRecoveryAdmission(root).allowed).toBe(false)
    writeFileSync(join(root, 'journal.json'), '{')
    expect(evaluateRecoveryAdmission(root).allowed).toBe(false)
  })

  it('treats a dangling marker link as suspicious rather than no recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    symlinkSync(join(root, 'missing-target'), join(root, 'hold.json'))
    expect(evaluateRecoveryAdmission(root).allowed).toBe(false)
  })

  it('blocks a redirected recovery root even when its target is empty', () => {
    const base = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    mkdirSync(join(base, 'empty'))
    symlinkSync(join(base, 'empty'), join(base, 'recovery'))
    expect(evaluateRecoveryAdmission(join(base, 'recovery')).allowed).toBe(false)
  })

  it('refuses linked or oversized journal content even when it says complete', () => {
    const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    writeFileSync(join(root, 'hold.json'), JSON.stringify({ version: 1, operationId: 'case-1' }))
    const apparentCompletion = JSON.stringify({ version: 1, operationId: 'case-1', state: 'complete',
      archiveSha256: 'a'.repeat(64), financialReviewApproved: true })
    writeFileSync(join(root, 'outside.json'), apparentCompletion)
    symlinkSync(join(root, 'outside.json'), join(root, 'journal.json'))
    expect(evaluateRecoveryAdmission(root).allowed).toBe(false)
  })

  it('blocks a journal without its matching hold and any unfinished operation', () => {
    const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    writeFileSync(join(root, 'journal.json'), JSON.stringify({ operationId: 'case-1', state: 'review_pending' }))
    expect(evaluateRecoveryAdmission(root).allowed).toBe(false)
    writeFileSync(join(root, 'hold.json'), JSON.stringify({ operationId: 'case-1' }))
    expect(evaluateRecoveryAdmission(root).allowed).toBe(false)
  })

  it('publishes a hold before work, rejects skipped transitions, and never releases without the qualified review path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    await beginRecoveryHold(root, 'case-1', 'a'.repeat(64))
    expect(evaluateRecoveryAdmission(root).allowed).toBe(false)
    await expect(advanceRecoveryState(root, 'case-1', 'complete')).rejects.toThrow()
    for (const state of [
      'preservation_started', 'preservation_verified', 'replacement_staged',
      'activation_pending', 'activation_in_progress', 'replacement_activated', 'validation_pending',
      'review_pending'
    ] as const) await advanceRecoveryState(root, 'case-1', state)
    expect(evaluateRecoveryAdmission(root).allowed).toBe(false)
    await expect(advanceRecoveryState(root, 'case-1', 'complete')).rejects.toThrow()
    await expect(advanceRecoveryState(root, 'case-1', 'complete')).rejects.toThrow()
    expect(evaluateRecoveryAdmission(root).allowed).toBe(false)
  })

  it('rejects insufficient free space before raw tuple capture', () => {
    expect(hasPreservationCapacity(1024n, 1023n)).toBe(false)
    expect(hasPreservationCapacity(1024n, 1024n)).toBe(true)
  })

  it('keeps failed and rollback-pending incidents held', async () => {
    const failedRoot = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    await beginRecoveryHold(failedRoot, 'failed-case', 'b'.repeat(64))
    await advanceRecoveryState(failedRoot, 'failed-case', 'failed')
    expect(evaluateRecoveryAdmission(failedRoot).allowed).toBe(false)
    await expect(advanceRecoveryState(failedRoot, 'failed-case', 'complete')).rejects.toThrow()

    const rollbackRoot = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    await beginRecoveryHold(rollbackRoot, 'rollback-case', 'c'.repeat(64))
    for (const state of ['preservation_started', 'preservation_verified', 'replacement_staged',
      'activation_pending', 'activation_in_progress', 'rollback_pending', 'failed'] as const) {
      await advanceRecoveryState(rollbackRoot, 'rollback-case', state)
      expect(evaluateRecoveryAdmission(rollbackRoot).allowed).toBe(false)
    }
  })

  it('preserves exact database, WAL and SHM bytes with verified hashes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    const data = join(root, 'data'); const retention = join(root, 'retention')
    mkdirSync(data)
    writeFileSync(join(data, 'erp.db'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(data, 'erp.db-wal'), Buffer.from([5, 6]))
    writeFileSync(join(data, 'erp.db-shm'), Buffer.from([7, 8]))
    const receipt = await preserveOriginalTuple(data, retention)
    expect(receipt.files.map((f) => f.name)).toEqual(['erp.db', 'erp.db-wal', 'erp.db-shm'])
    for (const file of receipt.files) {
      expect(file.present).toBe(true)
      expect(readFileSync(join(retention, file.name))).toEqual(readFileSync(join(data, file.name)))
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('records absent sidecars and refuses to overwrite retained originals', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    const data = join(root, 'data'); const retention = join(root, 'retention')
    mkdirSync(data); writeFileSync(join(data, 'erp.db'), Buffer.from('fictional'))
    const receipt = await preserveOriginalTuple(data, retention)
    expect(receipt.files.map((f) => f.present)).toEqual([true, false, false])
    await expect(preserveOriginalTuple(data, retention)).rejects.toThrow()
  })

  it('aborts when a source changes during preservation and retains the partial evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aura-bdr01-'))
    const data = join(root, 'data'); const retention = join(root, 'retention')
    mkdirSync(data); writeFileSync(join(data, 'erp.db'), Buffer.from('original fictional bytes'))
    await expect(preserveOriginalTuple(data, retention, {
      afterCopy: (name) => { if (name === 'erp.db') writeFileSync(join(data, name), 'changed fictional bytes') }
    })).rejects.toThrow(/changed during preservation/)
    expect(readFileSync(join(retention, 'erp.db'), 'utf8')).toBe('original fictional bytes')
  })
})
