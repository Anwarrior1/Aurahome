import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * The complete Windows persistent-data tree (Step 2 §5). Business data
 * lives entirely under app.getPath('userData') — never inside the
 * installed application directory — so updating or reinstalling
 * "AURA home" can never touch it, and the NSIS uninstaller (see
 * electron-builder.yml) never references this tree.
 *
 *   data/                erp.db, erp.db-wal, erp.db-shm
 *   documents/<year>/<type>/<number>.pdf
 *   backups/pre-restore/    the live DB set aside before a restore
 *   backups/pre-migration/  validated recovery copies for schema upgrades
 *   logs/                 rolling application + migration logs
 *   config/                config.json (non-secret settings)
 *   tmp/                   scratch space for backup/restore staging
 *   files/avatars/<userId>.<ext>  managed per-user profile photos
 */
export function getDataRoot(): string {
  return join(app.getPath('userData'), 'data')
}

export function getDocumentsRoot(): string {
  return join(app.getPath('userData'), 'documents')
}

export function getBackupsRoot(): string {
  return join(app.getPath('userData'), 'backups')
}

export function getLogsRoot(): string {
  return join(app.getPath('userData'), 'logs')
}

export function getConfigRoot(): string {
  return join(app.getPath('userData'), 'config')
}

export function getTempRoot(): string {
  return join(app.getPath('userData'), 'tmp')
}

/**
 * Managed, user-owned files (starting with profile photos) — under
 * userData like everything else business/user data lives, never a
 * reference to the user's own original external file path. Each
 * filename is server-computed from the numeric user id, never taken
 * from client input (profile.service.ts).
 */
export function getFilesRoot(): string {
  return join(app.getPath('userData'), 'files')
}

export function getAvatarsRoot(): string {
  return join(getFilesRoot(), 'avatars')
}

/**
 * Bundled read-only assets (Cairo fonts, AURA home logo). In
 * development this is the repo's resources/assets folder; in a
 * packaged build it is the extraResources copy next to the executable
 * (see electron-builder.yml) — never a system-installed or downloaded
 * font (Step 2 §10).
 */
export function getAssetsRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'assets')
    : join(app.getAppPath(), 'resources/assets')
}

/**
 * The exact, supplied business-location QR used by customer invoice
 * footers. It remains in references/qr.jpeg in development and is
 * copied to the same relative directory by electron-builder.
 */
export function getInvoiceLocationQrPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'references', 'qr.jpeg')
    : join(app.getAppPath(), 'references', 'qr.jpeg')
}

export function ensureDataDirectories(): void {
  const dirs = [
    getDataRoot(),
    getDocumentsRoot(),
    join(getBackupsRoot(), 'pre-restore'),
    join(getBackupsRoot(), 'pre-migration'),
    getLogsRoot(),
    getConfigRoot(),
    getTempRoot()
  ]
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
  // Avatar storage is created lazily by its containment owner; recursive mkdir
  // here would follow a pre-existing files/avatars symlink before that check.
}
