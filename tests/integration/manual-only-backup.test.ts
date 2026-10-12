import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureDataDirectories, getBackupsRoot } from '@main/files/paths'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { createBackup, validateBackup } from '@main/backup/backup.service'
import * as backupService from '@main/backup/backup.service'
import { restoreFromBackup } from '@main/restore/restore.service'
import { runPendingMigrations } from '@main/migrations/migration-runner'
import { getAllSettings, setSetting, SETTING_KEYS } from '@main/services/settings.service'
import { pickBackupDestinationFile, pickBackupFileToRestore } from '@main/files/dialogs'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { dialog, type BrowserWindow } from 'electron'
import BetterSqlite3 from 'better-sqlite3'
import { readArchive, sha256, writeArchive } from '@main/backup/archive'
import { DATABASE_ENTRY, MANIFEST_ENTRY, type BackupManifest } from '@main/backup/manifest'
import { CURRENT_MIGRATION_CREATED_AT, CURRENT_MIGRATION_INDEX } from '@main/migrations/migration-history'

let env: TestEnv

beforeEach(() => {
  env = setupTestDatabase()
})

afterEach(() => {
  vi.restoreAllMocks()
  env.cleanup()
})

describe('manual-only backup lifecycle', () => {
  it('uses the native Save dialog and creates exactly one valid backup at the chosen filename', async () => {
    const destination = join(env.dir, 'exports', 'chosen-backup.aurabak')
    const saveSpy = vi.spyOn(dialog, 'showSaveDialog').mockResolvedValue({ canceled: false, filePath: destination } as never)
    const chosen = await pickBackupDestinationFile({} as BrowserWindow)
    const businessCountsBefore = ['customers', 'orders', 'materials', 'cash_transactions'].map((table) =>
      (getRawConnection().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    )

    expect(chosen).toBe(destination)
    expect(saveSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      title: 'حفظ النسخة الاحتياطية',
      filters: [{ name: 'AURA home Backup', extensions: ['aurabak'] }]
    }))
    const result = await createBackup({ destinationFilePath: chosen, includeConfig: false }, env.ctx)
    const files = readdirSync(dirname(destination)).filter((name) => name.endsWith('.aurabak'))

    expect(files).toHaveLength(1)
    expect(result.path).toBe(destination)
    expect(await validateBackup(result.path)).toMatchObject({ valid: true })
    expect(result.manifest.databaseSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.manifest.migration).toMatchObject({
      appliedCount: CURRENT_MIGRATION_INDEX + 1,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    })

    const businessCountsAfter = ['customers', 'orders', 'materials', 'cash_transactions'].map((table) =>
      (getRawConnection().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    )
    expect(businessCountsAfter).toEqual(businessCountsBefore)
  })

  it('validates migration identity inside backups and accepts legacy manifests by inspecting the database', async () => {
    const path = join(env.dir, 'migration-identity.aurabak')
    await createBackup({ destinationFilePath: path, includeConfig: false }, env.ctx)
    const entries = readArchive(path)
    const manifest = JSON.parse(entries.get(MANIFEST_ENTRY)!.toString('utf8')) as BackupManifest

    delete manifest.migration
    writeArchive(path, [
      { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest)) },
      { name: DATABASE_ENTRY, data: entries.get(DATABASE_ENTRY)! }
    ])
    expect(await validateBackup(path)).toMatchObject({ valid: true })

    const staged = join(env.dir, 'future-backup.db')
    writeFileSync(staged, entries.get(DATABASE_ENTRY)!)
    const probe = new BetterSqlite3(staged)
    probe.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
      'future-backup-history',
      CURRENT_MIGRATION_CREATED_AT + 1
    )
    probe.close()
    const futureDatabase = readFileSync(staged)
    manifest.databaseSha256 = sha256(futureDatabase)
    writeArchive(path, [
      { name: MANIFEST_ENTRY, data: Buffer.from(JSON.stringify(manifest)) },
      { name: DATABASE_ENTRY, data: futureDatabase }
    ])
    expect(await validateBackup(path)).toMatchObject({
      valid: false,
      reason: expect.stringContaining('أحدث')
    })
  })

  it('restores a manual backup and retains the pre-restore rollback copy', async () => {
    const backup = await createBackup({ destinationFilePath: join(env.dir, 'restore-source.aurabak'), includeConfig: false }, env.ctx)
    setSetting(SETTING_KEYS.companyName, 'Changed after backup', env.ctx)
    const livePath = getRawConnection().name
    const pathSpy = vi.spyOn(backupService, 'getLiveDatabasePath').mockReturnValue(livePath)

    try {
      const restored = await restoreFromBackup({ backupFilePath: backup.path }, env.ctx)
      expect(existsSync(restored.safetyCopyPath)).toBe(true)
      expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
      rmSync(dirname(restored.safetyCopyPath), { recursive: true, force: true })
    } finally {
      pathSpy.mockRestore()
    }
  })

  it('uses a native file picker for restore and continues rejecting corrupt exports', async () => {
    const path = join(env.dir, 'corrupt.aurabak')
    const backup = await createBackup({ destinationFilePath: path, includeConfig: false }, env.ctx)
    const openSpy = vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({ canceled: false, filePaths: [backup.path] } as never)

    expect(await pickBackupFileToRestore({} as BrowserWindow)).toBe(backup.path)
    expect(openSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      filters: [{ name: 'AURA home Backup', extensions: ['aurabak'] }],
      properties: ['openFile']
    }))

    const damaged = readFileSync(backup.path)
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 0xff
    writeFileSync(backup.path, damaged)
    expect(await validateBackup(backup.path)).toMatchObject({ valid: false })
  })
})

describe('scheduled backup removal and migration-recovery separation', () => {
  it('does not create a user export when there is no pending startup migration', () => {
    const countBackups = (): number => existsSync(getBackupsRoot())
      ? readdirSync(getBackupsRoot(), { recursive: true }).filter((path) => String(path).endsWith('.aurabak')).length
      : 0
    const before = countBackups()

    ensureDataDirectories()
    runPendingMigrations(getDatabase())

    expect(countBackups()).toBe(before)
  })

  it('has no timer/close backup path but keeps the safety-critical migration recovery path', () => {
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const migrationRunner = readFileSync(join(process.cwd(), 'src/main/migrations/migration-runner.ts'), 'utf8')
    const migrationRecovery = readFileSync(join(process.cwd(), 'src/main/migrations/migration-recovery.ts'), 'utf8')
    const backupServiceSource = readFileSync(join(process.cwd(), 'src/main/backup/backup.service.ts'), 'utf8')
    const channels = readFileSync(join(process.cwd(), 'src/shared/constants/channels.ts'), 'utf8')

    expect(existsSync(join(process.cwd(), 'src/main/backup/scheduler.ts'))).toBe(false)
    expect(main).not.toMatch(/BackupScheduler|backup\/scheduler/)
    expect(migrationRunner).toContain('prepareMigrationRecovery')
    expect(migrationRecovery).toContain("raw.prepare('VACUUM INTO ?')")
    expect(migrationRecovery).toContain("phase: 'prepared'")
    expect(migrationRecovery).toContain("phase === 'verified'")
    expect(backupServiceSource).not.toMatch(/createAutomaticBackup|applyRetention/)
    expect(backupServiceSource).not.toContain('rmSync(file.path')
    expect(backupServiceSource).not.toMatch(/listLocalBackups|local-backups\.json/)
    expect(channels).not.toContain("'backup:list'")
  })

  it('removes automatic settings and the complete local-backup history UI', () => {
    const settingsService = readFileSync(join(process.cwd(), 'src/main/services/settings.service.ts'), 'utf8')
    const settingsPage = readFileSync(join(process.cwd(), 'src/renderer/pages/settings/SettingsPage.tsx'), 'utf8')
    const backupPage = readFileSync(join(process.cwd(), 'src/renderer/pages/backup/BackupPage.tsx'), 'utf8')

    for (const source of [settingsService, settingsPage]) {
      expect(source).not.toMatch(/backup\.auto_|backup\.retention_count|نسخة يومية|عدد النسخ التلقائية/)
    }
    expect(backupPage).not.toContain("call<LocalBackup[]>")
    expect(backupPage).not.toContain("'backup', 'list'")
    expect(backupPage).not.toContain('النسخ التلقائية المحلية')
    expect(backupPage).not.toContain('النسخ الاحتياطية المحلية')
    expect(backupPage).not.toContain('<DataTable')
    expect(backupPage).toContain('إنشاء نسخة احتياطية الآن')
    expect(backupPage).toContain('استعادة من ملف…')
    expect(backupPage).toContain("'backup', 'pickSavePath'")
  })

  it('ignores legacy automatic settings and rejects attempts to recreate them through the generic settings service', () => {
    getRawConnection().prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('backup.auto_daily', 'true', ?)")
      .run(new Date().toISOString())

    expect(getAllSettings()).not.toHaveProperty('backup.auto_daily')
    expect(() => setSetting('backup.auto_daily', true, env.ctx)).toThrow(/لم تعد مدعومة/)
  })
})
