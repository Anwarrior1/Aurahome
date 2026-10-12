/** Step 2 §7 backup file structure. */
export interface BackupManifest {
  appVersion: string
  schemaVersion: number
  createdAt: string
  machineName: string
  recordCounts: Record<string, number>
  databaseSha256: string
  /** Added by DB-07. Optional only for validation of backups created by older builds. */
  migration?: {
    appliedCount: number
    headCreatedAt: number | null
    fingerprint: string
  }
}

export const BACKUP_EXTENSION = 'aurabak'
export const MANIFEST_ENTRY = 'manifest.json'
export const DATABASE_ENTRY = 'erp.db'
