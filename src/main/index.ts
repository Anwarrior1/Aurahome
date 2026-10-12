import { app, dialog } from 'electron'
import { acquireSingleInstanceLock } from './app/single-instance'
import { registerAppProtocol } from './app/protocol'
import { createMainWindow } from './windows/main-window'
import { registerIpcRouter } from './ipc/router'
import { ensureDataDirectories } from './files/paths'
import { getRawConnection } from './db/connection'
import { logger } from './utils/logger'
import { finalizeMigrationRecovery } from './migrations/migration-recovery'
import { cleanupStaleBackupTemps } from './backup/backup.service'
import { openVerifiedDatabase } from './app/database-startup'
import { join } from 'node:path'
import { evaluateRecoveryAdmission } from './recovery/offline-state'

async function bootstrap(): Promise<void> {
  if (!acquireSingleInstanceLock()) {
    app.quit()
    return
  }

  await app.whenReady()
  const recovery = evaluateRecoveryAdmission(join(app.getPath('userData'), 'recovery'))
  if (!recovery.allowed) {
    throw new Error('الاستعادة غير مكتملة. افتح أداة استعادة أورا المستقلة قبل تشغيل البرنامج.')
  }
  registerAppProtocol()
  ensureDataDirectories()
  cleanupStaleBackupTemps()
  openVerifiedDatabase()

  registerIpcRouter()
  await createMainWindow()
  finalizeMigrationRecovery(getRawConnection())

  app.on('activate', () => {
    void createMainWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

bootstrap().catch((error) => {
  logger.error('Fatal error during application bootstrap', error)
  const message = error instanceof Error ? error.message : 'تعذر تشغيل التطبيق'
  if (app.isReady()) {
    dialog.showErrorBox('AURA home', message)
  }
  app.quit()
})
