import { app } from 'electron'
import { ensureDataDirectories } from '@main/files/paths'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDatabase, setDatabasePath, closeDatabase } from '@main/db/connection'
import { runPendingMigrations } from '@main/migrations/migration-runner'
import { performInitialSetup } from '@main/services/admin/bootstrap.service'
import { login } from '@main/auth/auth.service'
import type { ServiceContext } from '@main/services/base/service.types'
import { initializeFinishedGoodsValuationCutovers } from '@main/services/production/finished-goods.service'

/**
 * Spins up a real, throwaway SQLite database with the real migrations
 * applied, then drives the REAL services through it. These tests
 * exercise the actual business rules — no mocks of the rules
 * themselves, only of Electron's shell APIs.
 */
export interface TestEnv {
  ctx: ServiceContext
  dir: string
  cleanup: () => void
}

let counter = 0

export function setupTestDatabase(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'aura-erp-test-'))
  const previousUserData = app.getPath('userData')
  const userData = join(dir, 'userData')
  mkdirSync(userData)
  app.setPath('userData', userData)
  ensureDataDirectories()
  const dbPath = join(dir, `erp-${counter++}.db`)
  setDatabasePath(dbPath)
  runPendingMigrations(getDatabase())
  initializeFinishedGoodsValuationCutovers()

  performInitialSetup({ username: 'owner', password: 'secret123', fullName: 'مالك المصنع' })
  const { session } = login('owner', 'secret123', 1)

  return {
    ctx: { session },
    dir,
    cleanup: () => {
      closeDatabase()
      setDatabasePath(undefined)
      app.setPath('userData', previousUserData)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
