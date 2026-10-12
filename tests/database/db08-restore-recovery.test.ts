import { describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import BetterSqlite3 from 'better-sqlite3'
import { closeDatabase, getDatabase, getRawConnection } from '@main/db/connection'
import { createBackup, validateBackup } from '@main/backup/backup.service'
import { readArchive, sha256, writeArchive } from '@main/backup/archive'
import { DATABASE_ENTRY, MANIFEST_ENTRY, type BackupManifest } from '@main/backup/manifest'
import {
  restoreFromBackup, SimulatedRestoreInterruption, type RestoreHooks
} from '@main/restore/restore.service'
import { getRestoreRecoveryPaths, readRestoreMarker, recoverInterruptedRestore } from '@main/restore/restore-recovery'
import { recoverInterruptedMigration } from '@main/migrations/migration-recovery'
import { runMigrationsFromFolder, runPendingMigrations } from '@main/migrations/migration-runner'
import { inspectDatabaseMigrationState, loadMigrationBundle } from '@main/migrations/compatibility'
import { destroyAllSessions, getSessionForWebContents } from '@main/auth/session'
import { login, tryResumeSession } from '@main/auth/auth.service'
import { clearRememberTokenFromDisk, readRememberTokenFromDisk } from '@main/auth/remember-file'
import { createHandler } from '@main/ipc/guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { createCustomer } from '@main/services/parties/parties.service'
import { setupTestDatabase } from '../helpers/test-db'
import { openVerifiedDatabase } from '@main/app/database-startup'

function customerNames(): string[] {
  return (getRawConnection().prepare('SELECT name FROM customers ORDER BY name').all() as Array<{ name: string }>).map((row) => row.name)
}

function health(): void {
  expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
}

describe('DB-08 general restore', () => {
  it('returns a successful guarded restore response while revoking its initiating session', async () => {
    const env = setupTestDatabase()
    try {
      createCustomer({ name: 'B-only customer' }, env.ctx)
      const backup = await createBackup({
        destinationFilePath: join(env.dir, 'guarded-restore.aurabak'), includeConfig: false
      }, env.ctx)
      getRawConnection().prepare("DELETE FROM customers WHERE name = 'B-only customer'").run()
      createCustomer({ name: 'A-only customer' }, env.ctx)
      const guarded = createHandler(
        { permission: P.backup.restore, restoreExclusive: true },
        (request: { backupFilePath: string }, ctx) => restoreFromBackup(request, ctx)
      )

      const result = await guarded(
        { sender: { id: 1 } } as never,
        { backupFilePath: backup.path }
      )

      expect(result).toMatchObject({ ok: true })
      expect(customerNames()).toEqual(['B-only customer'])
      expect(getSessionForWebContents(1)).toBeUndefined()
      expect(getRawConnection().prepare(
        "SELECT user_id FROM audit_log WHERE action = 'backup.restore' ORDER BY id DESC LIMIT 1"
      ).get()).toEqual({ user_id: null })
      health()
    } finally { env.cleanup() }
  })

  it('admits only one of two restore requests that overlap during candidate validation', async () => {
    const env = setupTestDatabase()
    try {
      createCustomer({ name: 'B1-only customer' }, env.ctx)
      const first = await createBackup({
        destinationFilePath: join(env.dir, 'concurrent-b1.aurabak'), includeConfig: false
      }, env.ctx)
      getRawConnection().prepare('DELETE FROM customers').run()
      createCustomer({ name: 'B2-only customer' }, env.ctx)
      const second = await createBackup({
        destinationFilePath: join(env.dir, 'concurrent-b2.aurabak'), includeConfig: false
      }, env.ctx)
      getRawConnection().prepare('DELETE FROM customers').run()
      createCustomer({ name: 'A-only customer' }, env.ctx)

      const results = await Promise.allSettled([
        restoreFromBackup({ backupFilePath: first.path }, env.ctx),
        restoreFromBackup({ backupFilePath: second.path }, env.ctx)
      ])

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      expect(customerNames()).toEqual(expect.arrayContaining([
        expect.stringMatching(/^B[12]-only customer$/)
      ]))
      expect(customerNames()).toHaveLength(1)
      health()
    } finally { env.cleanup() }
  })

  it('does not return a pending privileged IPC result under a revoked A session', async () => {
    const env = setupTestDatabase()
    try {
      let complete!: (value: string) => void
      const pending = new Promise<string>((resolve) => { complete = resolve })
      const guarded = createHandler({ permission: P.backup.restore }, () => pending)
      const invocation = guarded({ sender: { id: 1 } } as never, {})
      destroyAllSessions()
      complete('A-epoch privileged result')
      expect(await invocation).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
    } finally { env.cleanup() }
  })

  it('revokes in-memory and persisted remember-me credentials from both DB epochs', async () => {
    const env = setupTestDatabase()
    try {
      login('owner', 'secret123', 3, true)
      expect(readRememberTokenFromDisk()).toBeDefined()
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'remember.aurabak'), includeConfig: false }, env.ctx)
      expect(Number(getRawConnection().prepare('SELECT COUNT(*) FROM remember_tokens').pluck().get())).toBe(1)
      login('owner', 'secret123', 4, true)
      expect(Number(getRawConnection().prepare('SELECT COUNT(*) FROM remember_tokens').pluck().get())).toBe(2)
      await restoreFromBackup({ backupFilePath: backup.path }, env.ctx)
      expect(getSessionForWebContents(1)).toBeUndefined()
      expect(getSessionForWebContents(3)).toBeUndefined()
      expect(getSessionForWebContents(4)).toBeUndefined()
      expect(readRememberTokenFromDisk()).toBeUndefined()
      expect(Number(getRawConnection().prepare('SELECT COUNT(*) FROM remember_tokens').pluck().get())).toBe(0)
      expect(tryResumeSession(5)).toBeUndefined()
    } finally { clearRememberTokenFromDisk(); env.cleanup() }
  })

  it('restores B business/auth state, rejects A sessions, and reopens on restart', async () => {
    const env = setupTestDatabase()
    try {
      const bCustomer = createCustomer({ name: 'B-only customer' }, env.ctx)
      getRawConnection().prepare('INSERT INTO orders (document_number, customer_id, total_minor, remaining_minor) VALUES (?, ?, ?, ?)')
        .run('B-ORDER', bCustomer, 77700, 77700)
      getRawConnection().prepare('INSERT INTO cash_transactions (account_id, direction, amount_minor, kind, occurred_at) VALUES (1, ?, ?, ?, ?)')
        .run('in', 777, 'B-sentinel', '2026-09-15T00:00:00.000Z')
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'b.aurabak'), includeConfig: false }, env.ctx)
      getRawConnection().prepare("DELETE FROM orders WHERE document_number = 'B-ORDER'").run()
      getRawConnection().prepare("DELETE FROM cash_transactions WHERE kind = 'B-sentinel'").run()
      getRawConnection().prepare("DELETE FROM customers WHERE name = 'B-only customer'").run()
      const aCustomer = createCustomer({ name: 'A-only customer' }, env.ctx)
      getRawConnection().prepare('INSERT INTO orders (document_number, customer_id, total_minor, remaining_minor) VALUES (?, ?, ?, ?)')
        .run('A-ORDER', aCustomer, 88800, 88800)
      getRawConnection().prepare('INSERT INTO cash_transactions (account_id, direction, amount_minor, kind, occurred_at) VALUES (1, ?, ?, ?, ?)')
        .run('in', 888, 'A-sentinel', '2026-09-15T00:00:00.000Z')
      getRawConnection().prepare("UPDATE users SET active = 0 WHERE username = 'owner'").run()
      const livePath = getRawConnection().name
      expect(getSessionForWebContents(1)).toBeDefined()
      const result = await restoreFromBackup({ backupFilePath: backup.path }, env.ctx)
      expect(existsSync(result.safetyCopyPath)).toBe(true)
      expect(customerNames()).toEqual(['B-only customer'])
      expect(getRawConnection().prepare('SELECT document_number, total_minor FROM orders').all()).toEqual([
        { document_number: 'B-ORDER', total_minor: 77700 }
      ])
      expect(getRawConnection().prepare('SELECT kind, amount_minor FROM cash_transactions').all()).toEqual([
        { kind: 'B-sentinel', amount_minor: 777 }
      ])
      health()
      expect(getSessionForWebContents(1)).toBeUndefined()
      const guarded = createHandler({ permission: P.backup.restore }, () => true)
      expect(await guarded({ sender: { id: 1 } } as never, {})).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
      expect(login('owner', 'secret123', 2).session.user.username).toBe('owner')
      closeDatabase()
      expect(recoverInterruptedRestore(livePath)).toEqual({ action: 'none' })
      recoverInterruptedMigration(livePath)
      runPendingMigrations(getDatabase())
      expect(customerNames()).toEqual(['B-only customer'])
      health()
    } finally { env.cleanup() }
  })

  it.each([
    ['afterCandidateValidated', 'none', 'A-only customer'],
    ['afterSafetySnapshotPublished', 'none', 'A-only customer'],
    ['afterProtectedMarker', 'restored', 'A-only customer'],
    ['afterInstallingMarker', 'restored', 'A-only customer'],
    ['afterDatabaseClose', 'restored', 'A-only customer'],
    ['afterSidecarQuarantine', 'restored', 'A-only customer'],
    ['afterAtomicInstall', 'restored', 'A-only customer'],
    ['afterInstalledMarker', 'restored', 'A-only customer'],
    ['afterPostInstallVerification', 'restored', 'A-only customer'],
    ['afterSessionInvalidation', 'restored', 'A-only customer'],
    ['afterVerifiedMarker', 'verified', 'B-only customer']
  ] as const)('recovers process interruption at %s', async (boundary, expectedAction, expectedCustomer) => {
    const env = setupTestDatabase()
    try {
      createCustomer({ name: 'B-only customer' }, env.ctx)
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'b.aurabak'), includeConfig: false }, env.ctx)
      getRawConnection().prepare("DELETE FROM customers WHERE name = 'B-only customer'").run()
      createCustomer({ name: 'A-only customer' }, env.ctx)
      const livePath = getRawConnection().name
      const hooks = { [boundary]: () => { throw new SimulatedRestoreInterruption(boundary) } } as RestoreHooks
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx, hooks)).rejects.toThrow(SimulatedRestoreInterruption)
      closeDatabase()
      const marker = readRestoreMarker(livePath)
      if (expectedAction === 'none') expect(marker).toBeUndefined()
      else expect(marker).toBeDefined()
      const recovery = recoverInterruptedRestore(livePath)
      expect(recovery.action).toBe(expectedAction)
      expect(readRestoreMarker(livePath)).toBeUndefined()
      recoverInterruptedMigration(livePath)
      runPendingMigrations(getDatabase())
      expect(customerNames()).toEqual([expectedCustomer])
      health()
      for (const suffix of ['-wal', '-shm']) {
        // Any sidecar present now belongs to the newly opened recovered epoch.
        expect(existsSync(`${livePath}${suffix}`)).toBe(true)
      }
    } finally { env.cleanup() }
  })

  it('quarantines stale sidecars and rolls back A after candidate publication', async () => {
    const env = setupTestDatabase()
    try {
      createCustomer({ name: 'B-only customer' }, env.ctx)
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'stale-sidecar.aurabak'), includeConfig: false }, env.ctx)
      getRawConnection().prepare('DELETE FROM customers').run()
      createCustomer({ name: 'A-only customer' }, env.ctx)
      const livePath = getRawConnection().name

      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx, {
        afterAtomicInstall: () => {
          writeFileSync(`${livePath}-wal`, Buffer.from('stale WAL from another epoch'))
          writeFileSync(`${livePath}-shm`, Buffer.from('stale SHM from another epoch'))
          throw new SimulatedRestoreInterruption('stale sidecars after publication')
        }
      })).rejects.toThrow(SimulatedRestoreInterruption)

      closeDatabase()
      expect(recoverInterruptedRestore(livePath).action).toBe('restored')
      expect(readRestoreMarker(livePath)).toBeUndefined()
      runPendingMigrations(getDatabase())
      expect(customerNames()).toEqual(['A-only customer'])
      health()
    } finally { env.cleanup() }
  })

  it('recovers A through real startup after hard process termination following candidate publication', async () => {
    const env = setupTestDatabase()
    try {
      createCustomer({ name: 'B-only customer' }, env.ctx)
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'hard-kill.aurabak'), includeConfig: false }, env.ctx)
      getRawConnection().prepare('DELETE FROM customers').run()
      createCustomer({ name: 'A-only customer' }, env.ctx)
      const livePath = getRawConnection().name
      closeDatabase()

      const worker = spawnSync(process.execPath, [
        join(process.cwd(), 'node_modules/vite-node/vite-node.mjs'),
        '--config',
        join(process.cwd(), 'vitest.config.ts'),
        join(process.cwd(), 'tests/helpers/db08-crash-worker.ts'),
        livePath,
        backup.path
      ], { encoding: 'utf8', timeout: 30_000 })
      expect(worker.status, worker.stderr).toBe(86)
      expect(readRestoreMarker(livePath)?.phase).toBe('installing')

      openVerifiedDatabase()
      expect(readRestoreMarker(livePath)).toBeUndefined()
      expect(customerNames()).toEqual(['A-only customer'])
      health()
    } finally { env.cleanup() }
  }, 60_000)

  it('fails closed on a contradictory marker or damaged safety copy', async () => {
    const env = setupTestDatabase()
    try {
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'b.aurabak'), includeConfig: false }, env.ctx)
      const livePath = getRawConnection().name
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx, {
        afterProtectedMarker: () => { throw new SimulatedRestoreInterruption() }
      })).rejects.toThrow(SimulatedRestoreInterruption)
      const marker = readRestoreMarker(livePath)!
      writeFileSync(marker.safetyPath, Buffer.from('damaged'))
      closeDatabase()
      expect(() => recoverInterruptedRestore(livePath)).toThrow(/checksum/)
      expect(existsSync(getRestoreRecoveryPaths(livePath).marker)).toBe(true)
      const guarded = createHandler({ permission: P.backup.restore }, () => true)
      expect(await guarded({ sender: { id: 1 } } as never, {})).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    } finally { env.cleanup() }
  })

  it('rejects malformed durable marker metadata without guessing from filenames', async () => {
    const env = setupTestDatabase()
    try {
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'b.aurabak'), includeConfig: false }, env.ctx)
      const livePath = getRawConnection().name
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx, {
        afterProtectedMarker: () => { throw new SimulatedRestoreInterruption() }
      })).rejects.toThrow(SimulatedRestoreInterruption)
      const paths = getRestoreRecoveryPaths(livePath)
      const marker = JSON.parse(readFileSync(paths.marker, 'utf8')) as Record<string, unknown>
      marker.candidateSha256 = '0'.repeat(64)
      writeFileSync(paths.marker, JSON.stringify(marker))
      closeDatabase()
      expect(() => recoverInterruptedRestore(livePath)).toThrow(/checksum/)
      expect(existsSync(paths.marker)).toBe(true)
    } finally { env.cleanup() }
  })

  it('recovers ordinary post-install verification failure and permits a safe retry', async () => {
    const env = setupTestDatabase()
    try {
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'b.aurabak'), includeConfig: false }, env.ctx)
      createCustomer({ name: 'A-only customer' }, env.ctx)
      const livePath = getRawConnection().name
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx, {
        afterInstalledMarker: () => { throw new Error('injected verification failure') }
      })).rejects.toThrow(/أعيدت قاعدة البيانات السابقة/)
      expect(readRestoreMarker(livePath)).toBeUndefined()
      expect(customerNames()).toEqual(['A-only customer'])
      health()
      await restoreFromBackup({ backupFilePath: backup.path }, env.ctx)
      expect(customerNames()).toEqual([])
      health()
    } finally { env.cleanup() }
  })

  it('rejects representative corrupt, newer, unknown, and hostile inputs before live replacement', async () => {
    const env = setupTestDatabase()
    try {
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'b.aurabak'), includeConfig: false }, env.ctx)
      const baseline = readArchive(backup.path)
      const manifest = JSON.parse(baseline.get(MANIFEST_ENTRY)!.toString()) as BackupManifest
      const original = baseline.get(DATABASE_ENTRY)!
      const livePath = getRawConnection().name
      const publish = (bytes: Buffer, changed: Partial<BackupManifest> = {}) => writeArchive(backup.path, [
        { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify({ ...manifest, databaseSha256: sha256(bytes), ...changed })) },
        { name: DATABASE_ENTRY, data: bytes }
      ])
      const originalArchive = readFileSync(backup.path)
      writeFileSync(backup.path, originalArchive.subarray(0, Math.floor(originalArchive.length / 2)))
      expect((await validateBackup(backup.path)).valid).toBe(false)
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx)).rejects.toThrow()
      publish(original, { recordCounts: null as never })
      expect((await validateBackup(backup.path)).valid).toBe(false)
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx)).rejects.toThrow()
      publish(Buffer.alloc(4096))
      expect((await validateBackup(backup.path)).valid).toBe(false)
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx)).rejects.toThrow()
      const fkPath = join(env.dir, 'fk.db')
      writeFileSync(fkPath, original)
      const fkProbe = new BetterSqlite3(fkPath)
      fkProbe.pragma('foreign_keys = OFF')
      fkProbe.prepare('INSERT INTO remember_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
        .run(999999, 'f'.repeat(64), '2027-01-01T00:00:00.000Z')
      fkProbe.close()
      publish(readFileSync(fkPath))
      expect((await validateBackup(backup.path)).valid).toBe(false)
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx)).rejects.toThrow()
      const damagedManifest = { ...manifest, databaseSha256: '0'.repeat(64) }
      writeArchive(backup.path, [
        { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(damagedManifest)) },
        { name: DATABASE_ENTRY, data: original }
      ])
      expect((await validateBackup(backup.path)).valid).toBe(false)
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx)).rejects.toThrow()
      expect(readRestoreMarker(livePath)).toBeUndefined()

      const staging = join(env.dir, 'unknown.db')
      writeFileSync(staging, original)
      const futureProbe = new BetterSqlite3(staging)
      futureProbe.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('future', 1_792_428_800_001)
      futureProbe.close()
      publish(readFileSync(staging))
      expect((await validateBackup(backup.path)).valid).toBe(false)
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx)).rejects.toThrow()
      publish(original, { migration: { ...manifest.migration!, fingerprint: '0'.repeat(64) } })
      expect((await validateBackup(backup.path)).valid).toBe(false)
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx)).rejects.toThrow()

      writeFileSync(staging, original)
      const probe = new BetterSqlite3(staging)
      probe.prepare('UPDATE __drizzle_migrations SET hash = ? WHERE rowid = (SELECT MAX(rowid) FROM __drizzle_migrations)').run('unknown')
      probe.close()
      const unknown = readFileSync(staging)
      writeArchive(backup.path, [
        { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify({ ...manifest, databaseSha256: sha256(unknown) })) },
        { name: DATABASE_ENTRY, data: unknown }
      ])
      expect((await validateBackup(backup.path)).valid).toBe(false)
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx)).rejects.toThrow()
      expect(readRestoreMarker(livePath)).toBeUndefined()

      writeArchive(backup.path, [
        { name: MANIFEST_ENTRY, data: baseline.get(MANIFEST_ENTRY)! },
        { name: DATABASE_ENTRY, data: original },
        { name: '../erp.db', data: Buffer.from('hostile') }
      ])
      expect((await validateBackup(backup.path)).valid).toBe(false)
      await expect(restoreFromBackup({ backupFilePath: backup.path }, env.ctx)).rejects.toThrow()
      expect(readRestoreMarker(livePath)).toBeUndefined()
      health()
    } finally { env.cleanup() }
  })

  it('migrates a supported historical backup under DB-07 protection and resolves interrupted subordinate migration', async () => {
    const env = setupTestDatabase()
    try {
      const full = resolve('drizzle/migrations')
      const journal = JSON.parse(readFileSync(join(full, 'meta/_journal.json'), 'utf8')) as {
        version: string; dialect: string; entries: Array<{ idx: number; tag: string }>
      }
      const prefix = join(env.dir, 'prefix-43')
      mkdirSync(join(prefix, 'meta'), { recursive: true })
      const entries = journal.entries.filter((entry) => entry.idx <= 43)
      writeFileSync(join(prefix, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
      for (const entry of entries) copyFileSync(join(full, `${entry.tag}.sql`), join(prefix, `${entry.tag}.sql`))
      const olderPath = join(env.dir, 'older.db')
      const older = new BetterSqlite3(olderPath)
      runMigrationsFromFolder(older, prefix)
      older.prepare("INSERT INTO customers (name) VALUES ('older B customer')").run()
      const migration = inspectDatabaseMigrationState(older, loadMigrationBundle(full, true))
      expect(migration.status).toBe('historical')
      older.close()
      const bytes = readFileSync(olderPath)
      const backupPath = join(env.dir, 'older.aurabak')
      const manifest: BackupManifest = {
        appVersion: 'historical', schemaVersion: 7, createdAt: new Date().toISOString(),
        machineName: 'test', recordCounts: {}, databaseSha256: sha256(bytes),
        migration: { appliedCount: migration.appliedCount, headCreatedAt: migration.headCreatedAt, fingerprint: migration.fingerprint }
      }
      writeArchive(backupPath, [
        { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest)) },
        { name: DATABASE_ENTRY, data: bytes }
      ])
      expect((await validateBackup(backupPath)).valid).toBe(true)
      createCustomer({ name: 'current A customer' }, env.ctx)
      const livePath = getRawConnection().name
      await expect(restoreFromBackup({ backupFilePath: backupPath }, env.ctx, {
        migration: { afterRecoveryPrepared: () => { throw new SimulatedRestoreInterruption('DB-07 subordinate interruption') } }
      })).rejects.toThrow(SimulatedRestoreInterruption)
      closeDatabase()
      expect(recoverInterruptedRestore(livePath).action).toBe('restored')
      expect(recoverInterruptedMigration(livePath).action).toBe('none')
      runPendingMigrations(getDatabase())
      expect(customerNames()).toEqual(['current A customer'])
      health()
      const restored = await restoreFromBackup({ backupFilePath: backupPath }, env.ctx)
      expect(existsSync(restored.safetyCopyPath)).toBe(true)
      expect(customerNames()).toEqual(['older B customer'])
      expect(inspectDatabaseMigrationState(getRawConnection(), loadMigrationBundle(full, true)).status).toBe('current')
      health()
      closeDatabase()
      recoverInterruptedRestore(livePath)
      recoverInterruptedMigration(livePath)
      runPendingMigrations(getDatabase())
      expect(customerNames()).toEqual(['older B customer'])
    } finally { env.cleanup() }
  })

  it('measures a representative larger isolated restore without DB-09 optimization', async () => {
    const env = setupTestDatabase()
    try {
      const raw = getRawConnection()
      const insert = raw.prepare('INSERT INTO customers (name) VALUES (?)')
      raw.transaction(() => {
        for (let i = 0; i < 50_000; i += 1) insert.run(`B-volume-${String(i).padStart(6, '0')}`)
      })()
      const backup = await createBackup({ destinationFilePath: join(env.dir, 'large.aurabak'), includeConfig: false }, env.ctx)
      const livePath = raw.name
      const databaseBytes = statSync(livePath).size
      raw.prepare('DELETE FROM customers').run()
      createCustomer({ name: 'A-only customer' }, env.ctx)
      const times: Record<string, number> = {}
      const start = performance.now()
      const rssBefore = process.memoryUsage().rss
      await restoreFromBackup({ backupFilePath: backup.path }, env.ctx, {
        afterCandidateValidated: () => { times.candidateValidated = performance.now() },
        afterSafetySnapshotPublished: () => { times.safetyPublished = performance.now() },
        afterAtomicInstall: () => { times.installed = performance.now() },
        afterPostInstallVerification: () => { times.postVerified = performance.now() }
      })
      const end = performance.now()
      const rssAfter = process.memoryUsage().rss
      expect(Number(getRawConnection().prepare('SELECT COUNT(*) FROM customers').pluck().get())).toBe(50_000)
      health()
      console.log(JSON.stringify({
        dbBytes: databaseBytes, candidateValidationMs: Math.round(times.candidateValidated - start),
        safetySnapshotMs: Math.round(times.safetyPublished - times.candidateValidated),
        installationMs: Math.round(times.installed - times.safetyPublished),
        postVerificationMs: Math.round(times.postVerified - times.installed),
        totalRestoreMs: Math.round(end - start), rssBefore, rssAfter,
        peakRssMeasured: false
      }))
    } finally { env.cleanup() }
  })
})
