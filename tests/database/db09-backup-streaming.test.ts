import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ARCHIVE_LIMITS, extractArchiveBounded, publishArchive, readArchive, sha256,
  sha256File, writeArchive, writeArchiveStreaming
} from '@main/backup/archive'
import {
  cleanupStaleBackupTemps, cleanupStaleDestinationBackupTemps, createBackup, validateBackup, type BackupHooks
} from '@main/backup/backup.service'
import { DATABASE_ENTRY, MANIFEST_ENTRY } from '@main/backup/manifest'
import { getRawConnection } from '@main/db/connection'
import { getTempRoot } from '@main/files/paths'
import { BACKUP_LIFECYCLE_POLICY } from '@main/backup/lifecycle'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'

let env: TestEnv | undefined
afterEach(() => env?.cleanup())

describe('DB-09 streaming archive primitives', () => {
  it('streams the same SHA-256 and writes an AURABAK1 archive readable by the legacy reader', async () => {
    env = setupTestDatabase()
    const source = join(env.dir, 'payload.db')
    const bytes = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(2 * 1024 ** 2, 0x5a)])
    writeFileSync(source, bytes)
    expect(await sha256File(source)).toBe(sha256(bytes))
    const archive = join(env.dir, 'streamed.aurabak')
    await writeArchiveStreaming(archive, [
      { name: MANIFEST_ENTRY, data: Buffer.from('{}') },
      { name: DATABASE_ENTRY, path: source }
    ])
    expect(readFileSync(archive).subarray(0, 8).toString('ascii')).toBe('AURABAK1')
    expect(readArchive(archive).get(DATABASE_ENTRY)).toEqual(bytes)
  })

  it('rejects count overflow, unknown/duplicate names, truncation, trailing bytes and declared expansion before acceptance', async () => {
    env = setupTestDatabase()
    const candidate = join(env.dir, 'candidate.db')
    const archive = join(env.dir, 'hostile.aurabak')
    const assertRejected = async (): Promise<void> => {
      await expect(extractArchiveBounded(archive, candidate)).rejects.toThrow()
      expect(existsSync(candidate)).toBe(false)
    }
    writeFileSync(archive, Buffer.concat([Buffer.from('AURABAK1'), Buffer.from([4, 0, 0, 0])]))
    await assertRejected()
    writeArchive(archive, [{ name: '../erp.db', data: Buffer.from('x') }]); await assertRejected()
    writeArchive(archive, [
      { name: MANIFEST_ENTRY, data: Buffer.from('{}') }, { name: MANIFEST_ENTRY, data: Buffer.from('{}') }
    ]); await assertRejected()
    writeArchive(archive, [{ name: MANIFEST_ENTRY, data: Buffer.from('{}') }, { name: DATABASE_ENTRY, data: Buffer.from('db') }])
    const valid = readFileSync(archive)
    writeFileSync(archive, valid.subarray(0, valid.length - 1)); await assertRejected()
    writeFileSync(archive, Buffer.concat([valid, Buffer.from('trailing')])); await assertRejected()
    const oversized = Buffer.from(valid)
    // First entry rawLen is after magic/count/nameLen/name.
    const rawOffset = 8 + 4 + 4 + Buffer.byteLength(MANIFEST_ENTRY)
    oversized.writeUInt32LE(ARCHIVE_LIMITS.maxManifestBytes + 1, rawOffset)
    writeFileSync(archive, oversized); await assertRejected()
  })

  it('publishes atomically without replacing an existing backup', async () => {
    env = setupTestDatabase()
    const staging = join(env.dir, '.new.aurabak-incomplete')
    const final = join(env.dir, 'final.aurabak')
    writeFileSync(staging, 'new-valid-bytes')
    writeFileSync(final, 'existing-valid-bytes')
    await expect(publishArchive(staging, final)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(final, 'utf8')).toBe('existing-valid-bytes')
    expect(readFileSync(staging, 'utf8')).toBe('new-valid-bytes')
  })
})

describe('DB-09 backup lifecycle and failure boundaries', () => {
  it('never applies backup retention to manual or recovery artifacts', () => {
    expect(BACKUP_LIFECYCLE_POLICY.manual.automaticDeletion).toBe(false)
    expect(BACKUP_LIFECYCLE_POLICY.automatic.supported).toBe(false)
    expect(BACKUP_LIFECYCLE_POLICY.migrationRecovery.activeMarkerProtected).toBe(true)
    expect(BACKUP_LIFECYCLE_POLICY.restoreRecovery.activeMarkerProtected).toBe(true)
    expect(BACKUP_LIFECYCLE_POLICY.diagnosticRecovery.automaticDeletion).toBe(false)
  })

  it.each([
    'beforeSnapshot', 'duringSnapshot', 'afterSnapshot', 'duringHash',
    'duringArchive', 'duringArchiveHeader', 'duringDatabaseStream', 'duringCompression',
    'duringOutputWrite', 'duringFinalization', 'duringFsync', 'duringValidation', 'beforePublication'
  ] as const)('cleans scratch state and never publishes when %s fails', async (boundary) => {
    env = setupTestDatabase()
    const final = join(env.dir, `${boundary}.aurabak`)
    const hooks = { [boundary]: () => { throw new Error(`injected ${boundary}`) } } as BackupHooks
    await expect(createBackup({ destinationFilePath: final, includeConfig: false }, env.ctx, hooks)).rejects.toThrow('injected')
    expect(existsSync(final)).toBe(false)
    expect(readdirSync(env.dir).some((name) => name.endsWith('.aurabak-incomplete'))).toBe(false)
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })

  it('keeps the prior completed file byte-for-byte when the selected name already exists', async () => {
    env = setupTestDatabase()
    const final = join(env.dir, 'existing.aurabak')
    writeFileSync(final, 'prior completed backup')
    await expect(createBackup({ destinationFilePath: final, includeConfig: false }, env.ctx)).rejects.toThrow(/بالفعل/)
    expect(readFileSync(final, 'utf8')).toBe('prior completed backup')
  })

  it('leaves a fully validated archive after a process boundary immediately following publication', async () => {
    env = setupTestDatabase()
    const final = join(env.dir, 'published.aurabak')
    await expect(createBackup({ destinationFilePath: final, includeConfig: false }, env.ctx, {
      afterPublication: () => { throw new Error('simulated process boundary after publication') }
    })).rejects.toThrow('simulated process boundary')
    expect(existsSync(final)).toBe(true)
    expect((await validateBackup(final)).valid).toBe(true)
  })

  it('removes only proven stale DB-09 scratch files and preserves unrelated/recovery artifacts', () => {
    env = setupTestDatabase()
    mkdirSync(getTempRoot(), { recursive: true })
    const stale = join(getTempRoot(), 'db09-snapshot-00000000-0000-0000-0000-000000000000.db')
    const recent = join(getTempRoot(), 'db09-verify-11111111-1111-1111-1111-111111111111.candidate')
    const recovery = join(getTempRoot(), 'pre-migration-recovery.db')
    for (const path of [stale, recent, recovery]) writeFileSync(path, 'x')
    utimesSync(stale, new Date(0), new Date(0))
    expect(cleanupStaleBackupTemps()).toEqual([stale])
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(recovery)).toBe(true)
  })

  it('removes stale destination staging after restart without touching completed or unrelated files', () => {
    env = setupTestDatabase()
    const stale = join(env.dir, '.manual.12345678-1234-4123-8123-123456789abc.aurabak-incomplete')
    const recent = join(env.dir, '.manual.22345678-1234-4123-8123-123456789abc.aurabak-incomplete')
    const completed = join(env.dir, 'manual.aurabak')
    for (const path of [stale, recent, completed]) writeFileSync(path, 'x')
    utimesSync(stale, new Date(0), new Date(0))
    expect(cleanupStaleDestinationBackupTemps(env.dir)).toEqual([stale])
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(existsSync(completed)).toBe(true)
  })

  it('creates, validates, and publishes only a complete archive with no scratch residue', async () => {
    env = setupTestDatabase()
    const final = join(env.dir, 'complete.aurabak')
    const result = await createBackup({ destinationFilePath: final, includeConfig: false }, env.ctx)
    expect(result.path).toBe(final)
    expect((await validateBackup(final)).valid).toBe(true)
    expect(statSync(final).size).toBeGreaterThan(0)
    expect(readdirSync(env.dir).filter((name) => name.endsWith('.aurabak-incomplete'))).toEqual([])
  })
})
