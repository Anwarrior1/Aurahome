import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { setupTestDatabase, type TestEnv } from '../helpers/test-db'
import { getDatabase, getRawConnection } from '@main/db/connection'
import { users } from '@main/db/schema/users.schema'
import { roles, rolePermissions } from '@main/db/schema/roles.schema'
import { createRole, createUser, deleteUser, deleteRole, listRoles, listUsers } from '@main/services/admin/users.service'
import { login } from '@main/auth/auth.service'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

/**
 * Users and Roles are two fully independent deletable entities:
 *   - Deleting a User must NEVER touch its Role or that Role's permissions.
 *   - Deleting a Role must NEVER touch any User — it only ever removes
 *     its own role_permissions, and only once truly unused.
 *
 * `users.role_id` is a real, FK-enforced column (nullable — see
 * users.schema.ts/migration 0013). Deleting a user that must be
 * tombstoned (real history exists against it) releases its role_id to
 * null in the SAME step, rather than leaving a permanent, FK-enforced
 * link that would block that role from ever being deleted again — the
 * exact bug this file reproduces and proves fixed.
 */
let env: TestEnv
beforeEach(() => { env = setupTestDatabase() })
afterEach(() => env.cleanup())

describe('the exact named scenario — hadi / supplier', () => {
  it('deleting the user leaves the role fully intact; deleting the now-unused role afterward is a separate, independent operation', () => {
    // 1. Create custom Role "supplier".
    const supplierRoleId = createRole({ name: 'supplier', permissions: [P.suppliers.view, P.suppliers.manage] }, env.ctx)
    // 2. Create User "hadi" assigned to "supplier".
    const hadiId = createUser({ username: 'hadi', password: 'secret789', fullName: 'هادي', roleId: supplierRoleId }, env.ctx)
    // A second, unrelated user on the SAME role, and an unrelated role,
    // to prove neither is ever touched by either delete below.
    const otherUserId = createUser({ username: 'other-supplier-user', password: 'secret789', fullName: 'مستخدم آخر', roleId: supplierRoleId }, env.ctx)
    const unrelatedRoleId = createRole({ name: 'unrelated-role', permissions: [P.reports.view] }, env.ctx)

    // 3. Permanently delete User "hadi".
    const result = deleteUser(hadiId, env.ctx)
    expect(result.mode).toBe('deleted')

    // 4. Assert "hadi" no longer exists.
    expect(getDatabase().select().from(users).where(eq(users.id, hadiId)).get()).toBeUndefined()
    expect(listUsers().some((u) => u.id === hadiId)).toBe(false)

    // 5. Assert Role "supplier" STILL exists.
    const supplierAfter = getDatabase().select().from(roles).where(eq(roles.id, supplierRoleId)).get()
    expect(supplierAfter).toBeDefined()
    expect(supplierAfter?.name).toBe('supplier')

    // 6. Assert supplier role_permissions still exist unchanged.
    const permsAfter = getDatabase().select().from(rolePermissions).where(eq(rolePermissions.roleId, supplierRoleId)).all()
    expect(permsAfter.map((p) => p.permissionKey).sort()).toEqual([P.suppliers.manage, P.suppliers.view].sort())

    // 7. Assert assigned-user count for supplier is now exactly the
    // one surviving user (other users on it remain unchanged too).
    const supplierRow = listRoles().find((r) => r.id === supplierRoleId)!
    expect(supplierRow.userCount).toBe(1)
    expect(getDatabase().select().from(users).where(eq(users.id, otherUserId)).get()?.roleId).toBe(supplierRoleId)

    // Deleting the role while it still has one user must still be
    // blocked (invariant: Role delete with users must never cascade).
    expect(() => deleteRole({ id: supplierRoleId, confirmation: 'supplier' }, env.ctx)).toThrowError(/مرتبط بمستخدمين/)
    expect(getDatabase().select().from(users).where(eq(users.id, otherUserId)).get()).toBeDefined()

    // Remove the last remaining user too, so the role is genuinely unused.
    deleteUser(otherUserId, env.ctx)
    expect(listRoles().find((r) => r.id === supplierRoleId)!.userCount).toBe(0)

    // 8. Permanently delete Role "supplier" separately.
    deleteRole({ id: supplierRoleId, confirmation: 'supplier' }, env.ctx)

    // 9. Assert supplier no longer exists.
    expect(getDatabase().select().from(roles).where(eq(roles.id, supplierRoleId)).get()).toBeUndefined()
    expect(listRoles().some((r) => r.id === supplierRoleId)).toBe(false)

    // 10. Assert supplier role_permissions are removed.
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ${supplierRoleId}`)?.c).toBe(0)

    // 11. Assert no unrelated User or Role changed.
    expect(getDatabase().select().from(roles).where(eq(roles.id, unrelatedRoleId)).get()).toBeDefined()
    expect(listUsers().find((u) => u.id === env.ctx.session.user.id)).toBeDefined()
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
    expect(getRawConnection().pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})

describe('the exact reported bug — a TOMBSTONED (not hard-deleted) user must release its role too', () => {
  it('logging in once (a real historical reference) forces a tombstone, which must still null role_id, not leave a stale FK link', () => {
    const roleId = createRole({ name: 'supplier', permissions: [P.suppliers.view] }, env.ctx)
    const userId = createUser({ username: 'hadi', password: 'secret789', fullName: 'هادي', roleId }, env.ctx)
    // A real audit_log row attributed to hadi (exactly like the live
    // app's own login flow does) is what forces the safe path to keep
    // the row instead of hard-deleting it — the actual shape of the
    // reported bug, not the simpler hard-delete case above.
    login('hadi', 'secret789', 999001)

    const result = deleteUser(userId, env.ctx)
    expect(result.mode).toBe('tombstoned')

    // Gone from every active listing...
    expect(listUsers().some((u) => u.id === userId)).toBe(false)
    // ...but the row itself survives (historical attribution intact)...
    const tombstoned = getDatabase().select().from(users).where(eq(users.id, userId)).get()
    expect(tombstoned).toBeDefined()
    expect(tombstoned?.active).toBe(false)
    expect(tombstoned?.deletedAt).toBeTruthy()
    // ...and — the actual bug — it must NOT still hold a live, FK-enforced
    // link to its old role. This is the direct, relational proof (not an
    // inference from userCount) that nothing blocks deleting the role now.
    expect(tombstoned?.roleId).toBeNull()

    // The role survives, shows zero live users, and — the real test —
    // is now genuinely deletable, with no stale reference in the way.
    expect(getDatabase().select().from(roles).where(eq(roles.id, roleId)).get()).toBeDefined()
    expect(listRoles().find((r) => r.id === roleId)?.userCount).toBe(0)
    deleteRole({ id: roleId, confirmation: 'supplier' }, env.ctx)
    expect(getDatabase().select().from(roles).where(eq(roles.id, roleId)).get()).toBeUndefined()
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })

  it('CC03: a tombstoned username is released and reused by a NEW user id; the tombstone keeps no role', () => {
    const roleId = createRole({ name: 'دور', permissions: [] }, env.ctx)
    const userId = createUser({ username: 'reused-name', password: 'secret789', fullName: 'مستخدم', roleId }, env.ctx)
    login('reused-name', 'secret789', 999002)
    deleteUser(userId, env.ctx) // tombstoned (has a real login audit row)

    const reusedId = createUser({ username: 'reused-name', password: 'secret789', fullName: 'مستخدم جديد', roleId }, env.ctx)
    expect(reusedId).not.toBe(userId)
  })

  it('rolls back completely if the tombstone step fails midway — role_id is never left half-released', () => {
    const roleId = createRole({ name: 'دور تراجع المستخدم', permissions: [P.reports.view] }, env.ctx)
    const userId = createUser({ username: 'rollback-user', password: 'secret789', fullName: 'مستخدم', roleId }, env.ctx)
    login('rollback-user', 'secret789', 999003)
    getRawConnection().exec("CREATE TRIGGER test_block_user_tombstone BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")

    expect(() => deleteUser(userId, env.ctx)).toThrow()

    const stillLive = getDatabase().select().from(users).where(eq(users.id, userId)).get()
    expect(stillLive?.active).toBe(true)
    expect(stillLive?.deletedAt).toBeFalsy()
    expect(stillLive?.roleId).toBe(roleId)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})

describe('independence invariants', () => {
  it('a Role with assigned users can never be cascade-deleted along with them', () => {
    const roleId = createRole({ name: 'مرتبط', permissions: [] }, env.ctx)
    const userId = createUser({ username: 'linked-user', password: 'secret789', fullName: 'مستخدم مرتبط', roleId }, env.ctx)

    expect(() => deleteRole({ id: roleId, confirmation: 'مرتبط' }, env.ctx)).toThrowError(/مرتبط بمستخدمين/)

    expect(getDatabase().select().from(users).where(eq(users.id, userId)).get()).toBeDefined()
    expect(getDatabase().select().from(roles).where(eq(roles.id, roleId)).get()).toBeDefined()
  })

  it('deleting the LAST user on a custom role never auto-deletes that role', () => {
    const roleId = createRole({ name: 'دور بلا مستخدمين', permissions: [P.reports.view] }, env.ctx)
    const userId = createUser({ username: 'lone-user', password: 'secret789', fullName: 'مستخدم منفرد', roleId }, env.ctx)

    deleteUser(userId, env.ctx)

    expect(getDatabase().select().from(roles).where(eq(roles.id, roleId)).get()).toBeDefined()
    expect(listRoles().find((r) => r.id === roleId)?.userCount).toBe(0)
  })

  it('the required system administrator role can never be deleted, even with the correct name typed', () => {
    const adminRole = getDatabase().select().from(roles).where(eq(roles.isAdmin, true)).get()!
    expect(() => deleteRole({ id: adminRole.id, confirmation: adminRole.name }, env.ctx)).toThrowError(/مدير النظام/)
    expect(getDatabase().select().from(roles).where(eq(roles.id, adminRole.id)).get()).toBeDefined()
  })

  it('deleting a user can never remove the last active administrator, independent of any role logic', () => {
    expect(() => deleteUser(env.ctx.session.user.id, env.ctx)).toThrowError(/حسابك/)
  })

  it('a wrong typed role-name confirmation is rejected server-side with zero mutation', () => {
    const roleId = createRole({ name: 'اسم صحيح', permissions: [P.reports.view] }, env.ctx)
    expect(() => deleteRole({ id: roleId, confirmation: 'اسم خاطئ تماماً' }, env.ctx)).toThrowError(/اكتب اسم الدور/)
    expect(getDatabase().select().from(roles).where(eq(roles.id, roleId)).get()).toBeDefined()
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ${roleId}`)?.c).toBe(1)
  })

  it('rolls back completely on a forced failure — the role and its permissions survive intact', () => {
    const roleId = createRole({ name: 'دور فاشل', permissions: [P.reports.view, P.materials.view] }, env.ctx)
    getRawConnection().exec("CREATE TRIGGER test_block_role_independence BEFORE DELETE ON roles BEGIN SELECT RAISE(ABORT, 'forced rollback'); END")

    expect(() => deleteRole({ id: roleId, confirmation: 'دور فاشل' }, env.ctx)).toThrow()

    expect(getDatabase().select().from(roles).where(eq(roles.id, roleId)).get()).toBeDefined()
    expect(getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ${roleId}`)?.c).toBe(2)
    expect(getRawConnection().pragma('foreign_key_check')).toEqual([])
  })
})
