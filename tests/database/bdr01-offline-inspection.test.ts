import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { createBackup, validateBackup } from '@main/backup/backup.service'
import { readArchive, sha256File, writeArchive } from '@main/backup/archive'
import { reconcileDatabase } from '@main/db/reconciliation'
import { getRawConnection } from '@main/db/connection'
import { inspectLegacyBackup, pinLegacyArchive } from '@main/recovery/offline-inspection'
import { recordLegacyDecision, archiveStillMatchesReceipt, candidateStillMatchesReceipt } from '@main/recovery/offline-decision'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

let env: TestEnv | undefined
afterEach(() => env?.cleanup())

describe('offline legacy archive inspection', () => {
  it('matches the healthy validator and all 73 authoritative reconciliation checks', async () => {
    env = setupTestDatabase()
    const archive = join(env.dir, 'manual.aurabak')
    await createBackup({ destinationFilePath: archive, includeConfig: false }, env.ctx)
    const normal = await validateBackup(archive)
    const candidate = join(env.dir, 'offline-candidate.db')
    const offline = await inspectLegacyBackup(archive, candidate, join(process.cwd(), 'drizzle/migrations'), await sha256File(archive))
    expect(normal.valid).toBe(true)
    expect(offline.valid).toBe(true)
    expect(offline.origin).toBe('UNKNOWN ORIGIN')
    expect(offline.archiveSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(offline.reconciliation).toEqual(reconcileDatabase(getRawConnection()))
    expect(offline.reconciliation?.checksRun).toBe(73)
    expect(await sha256File(candidate)).toBe(offline.manifest?.databaseSha256)
  })

  it('pins, validates, and records a case-specific unknown-origin decision for exact fictional bytes', async () => {
    env = setupTestDatabase()
    const archive = join(env.dir, 'manual.aurabak')
    await createBackup({ destinationFilePath: archive, includeConfig: false }, env.ctx)
    const originalHash = await sha256File(archive)
    const pinned = await pinLegacyArchive(archive, join(env.dir, 'stage'))
    const inspection = await inspectLegacyBackup(pinned.path, join(env.dir, 'candidate.db'),
      join(process.cwd(), 'drizzle/migrations'), pinned.sha256)
    expect(inspection.valid).toBe(true)
    const decision = recordLegacyDecision(inspection, {
      incidentId: 'fictional-case-1', custodyExplanation: 'unknown', decision: 'accept',
      acceptsUnknownOrigin: true, acceptsPossibleNewerTransactionLoss: true
    })
    expect(decision.archive.sha256).toBe(originalHash)
    expect(decision.origin).toBe('UNKNOWN ORIGIN')
    expect(decision.ownerIdentityVerified).toBe(false)
    expect(await archiveStillMatchesReceipt(decision, pinned.path)).toBe(true)
    expect(await candidateStillMatchesReceipt(decision, join(env.dir, 'candidate.db'))).toBe(true)
    writeFileSync(join(env.dir, 'candidate.db'), 'substituted fictional candidate')
    expect(await candidateStillMatchesReceipt(decision, join(env.dir, 'candidate.db'))).toBe(false)
    expect(await sha256File(archive)).toBe(originalHash)
  })

  it('rejects a changed selected archive rather than accepting its former validation', async () => {
    env = setupTestDatabase()
    const archive = join(env.dir, 'manual.aurabak')
    await createBackup({ destinationFilePath: archive, includeConfig: false }, env.ctx)
    const copy = join(env.dir, 'tampered.aurabak')
    const bytes = readFileSync(archive)
    bytes[bytes.length - 1] ^= 1
    writeFileSync(copy, bytes)
    const result = await inspectLegacyBackup(copy, join(env.dir, 'offline-candidate.db'), join(process.cwd(), 'drizzle/migrations'), await sha256File(copy))
    expect(result.valid).toBe(false)
    expect(result.origin).toBe('UNKNOWN ORIGIN')
  })

  it('pins the exact selected archive and refuses a replaced stage', async () => {
    env = setupTestDatabase()
    const archive = join(env.dir, 'manual.aurabak')
    await createBackup({ destinationFilePath: archive, includeConfig: false }, env.ctx)
    const pinned = await pinLegacyArchive(archive, join(env.dir, 'stage'))
    expect(pinned.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(pinned.path)).toEqual(readFileSync(archive))
    const entries = readArchive(archive)
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as Record<string, unknown>
    manifest.createdAt = '2001-01-01T00:00:00.000Z'
    writeArchive(pinned.path, [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      { name: 'erp.db', data: entries.get('erp.db')! }
    ])
    const result = await inspectLegacyBackup(pinned.path, join(env.dir, 'candidate.db'), join(process.cwd(), 'drizzle/migrations'), pinned.sha256)
    expect(result.valid).toBe(false)
    expect(result.archiveSha256).not.toBe(pinned.sha256)
  })

  it('never claims authenticity when unsigned metadata is changed and repacked', async () => {
    env = setupTestDatabase()
    const archive = join(env.dir, 'manual.aurabak')
    await createBackup({ destinationFilePath: archive, includeConfig: false }, env.ctx)
    const entries = readArchive(archive)
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as Record<string, unknown>
    manifest.createdAt = '2001-01-01T00:00:00.000Z'
    const repacked = join(env.dir, 'repacked.aurabak')
    writeArchive(repacked, [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      { name: 'erp.db', data: entries.get('erp.db')! }
    ])
    const result = await inspectLegacyBackup(repacked, join(env.dir, 'repacked-candidate.db'), join(process.cwd(), 'drizzle/migrations'), await sha256File(repacked))
    expect(result.valid).toBe(true)
    expect(result.origin).toBe('UNKNOWN ORIGIN')
    expect(result.manifest?.createdAt).toBe('2001-01-01T00:00:00.000Z')
  })

  it('rejects manifest counts that contradict the extracted database', async () => {
    env = setupTestDatabase()
    const archive = join(env.dir, 'manual.aurabak')
    await createBackup({ destinationFilePath: archive, includeConfig: false }, env.ctx)
    const entries = readArchive(archive)
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as { recordCounts: Record<string, number> }
    manifest.recordCounts.users = 999
    const inconsistent = join(env.dir, 'inconsistent.aurabak')
    writeArchive(inconsistent, [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      { name: 'erp.db', data: entries.get('erp.db')! }
    ])
    const result = await inspectLegacyBackup(inconsistent, join(env.dir, 'inconsistent-candidate.db'), join(process.cwd(), 'drizzle/migrations'), await sha256File(inconsistent))
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/count|عدد/)
  })
})
