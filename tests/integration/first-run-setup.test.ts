import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDatabase, setDatabasePath, closeDatabase } from '@main/db/connection'
import { runPendingMigrations } from '@main/migrations/migration-runner'
import { needsSetup, performInitialSetup } from '@main/services/admin/bootstrap.service'
import { login } from '@main/auth/auth.service'
import { listRoles, listUsers } from '@main/services/admin/users.service'
import { allPermissionKeys } from '@shared/permissions/permission-keys'

/**
 * First-run bootstrap (BR-54/BR-55): with an empty users table the app
 * must offer the setup form, and the very first account created must be
 * the full-access administrator. Once a user exists, setup must never be
 * offered again.
 */
let dir: string | undefined

function freshMigratedDatabase(): void {
  dir = mkdtempSync(join(tmpdir(), 'aura-firstrun-'))
  setDatabasePath(join(dir, 'erp.db'))
  runPendingMigrations(getDatabase())
}

afterEach(() => {
  closeDatabase()
  setDatabasePath(undefined)
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('first-run setup detection', () => {
  it('reports needsSetup on a migrated but empty database', () => {
    freshMigratedDatabase()
    expect(needsSetup()).toBe(true)
  })

  it('creates the first account as the full-access administrator', () => {
    freshMigratedDatabase()
    performInitialSetup({ username: 'owner', password: 'secret123', fullName: 'مالك المصنع' })

    const users = listUsers()
    expect(users).toHaveLength(1)
    expect(users[0]?.username).toBe('owner')
    expect(users[0]?.isAdmin).toBe(true)

    // BR-55: the bootstrap role holds every permission.
    const adminRole = listRoles().find((role) => role.isAdmin)
    expect(adminRole).toBeDefined()
    expect(adminRole?.permissions.length).toBe(allPermissionKeys().length)
  })

  it('stops offering setup once a user exists, and refuses to run twice', () => {
    freshMigratedDatabase()
    performInitialSetup({ username: 'owner', password: 'secret123', fullName: 'مالك المصنع' })

    expect(needsSetup()).toBe(false)
    expect(() =>
      performInitialSetup({ username: 'other', password: 'secret123', fullName: 'آخر' })
    ).toThrowError(/بالفعل/)
  })

  it('lets the newly created administrator log in immediately', () => {
    freshMigratedDatabase()
    performInitialSetup({ username: 'owner', password: 'secret123', fullName: 'مالك المصنع' })

    const { session } = login('owner', 'secret123', 1)
    expect(session.user.username).toBe('owner')
    expect(session.user.isAdmin).toBe(true)
  })

  it('rejects a password shorter than the minimum', () => {
    freshMigratedDatabase()
    expect(() =>
      performInitialSetup({ username: 'owner', password: '123', fullName: 'مالك' })
    ).toThrowError(/6/)
    // A rejected setup must leave the system still awaiting setup.
    expect(needsSetup()).toBe(true)
  })
})
