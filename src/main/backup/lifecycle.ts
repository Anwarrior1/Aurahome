/**
 * DB-09 artifact lifecycle policy. This application currently creates manual
 * exports only; it has no scheduled-backup feature. Recovery files are owned
 * by their DB-01/DB-07/DB-08 state machines and are outside backup retention.
 */
export const BACKUP_LIFECYCLE_POLICY = Object.freeze({
  manual: {
    owner: 'user',
    purpose: 'user-selected portable backup',
    automaticDeletion: false,
    deletionAuthority: 'explicit-user-action'
  },
  automatic: {
    supported: false,
    automaticDeletion: false,
    deletionAuthority: 'none'
  },
  migrationRecovery: {
    owner: 'migration-recovery-state-machine',
    purpose: 'DB-01/DB-07 rollback',
    automaticDeletion: false,
    activeMarkerProtected: true,
    historicalDisposition: 'retain'
  },
  restoreRecovery: {
    owner: 'restore-recovery-state-machine',
    purpose: 'DB-08 rollback/quarantine',
    automaticDeletion: false,
    activeMarkerProtected: true,
    historicalDisposition: 'retain'
  },
  backupScratch: {
    owner: 'DB-09 backup operation',
    purpose: 'snapshot, validation candidate, or incomplete archive',
    completedOperationDisposition: 'delete',
    staleAfterHours: 24,
    completedBackupSuffix: '.aurabak',
    incompleteBackupSuffix: '.aurabak-incomplete'
  },
  diagnosticRecovery: {
    owner: 'recovery-state-machine',
    automaticDeletion: false,
    deletionAuthority: 'explicit-administrator-action'
  }
})

