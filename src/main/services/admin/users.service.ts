import { eq, sql } from 'drizzle-orm'
import { keysetBoundary, keysetOrder, keysetPage, normalizedSearch, type KeysetWindow, type PageRequest } from '../base/pagination'
import { getDatabase } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import { users } from '../../db/schema/users.schema'
import { roles, rolePermissions } from '../../db/schema/roles.schema'
import { auditLog } from '../../db/schema/audit.schema'
import { AppError, notFound } from '../../utils/errors'
import { hashPassword } from '../../auth/password'
import { usersRepository } from '../../repositories/users/users.repository'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { dayStart, dayEnd, nowIso, type ServiceContext } from '../base/service.types'
import { allPermissionKeys, PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { requirePermission } from '../../permissions/permission-guard'
import { getPermissionsForRole } from '../../permissions/permission.service'
import { destroySessionsForRole, destroySessionsForUser } from '../../auth/session'
import { revokeRememberTokensForUser } from '../../auth/remember-token'
import { clearFailedAttempts } from '../../auth/lockout'

export function listUsers() {
  return usersRepository.list()
}

export function listRoles() {
  const rows = getDatabase().select().from(roles).all()
  return rows.map((role) => ({
    ...role,
    permissions: getDatabase()
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, role.id))
      .all()
      .map((row) => row.permissionKey),
    // A plain count of role_id is now accurate by construction: a
    // tombstoned user's role_id is released to null the moment it is
    // deleted (users.schema.ts), so it never inflates this number, and
    // it never leaves a row still holding an FK-enforced link that
    // would block deleting the role once every real assignment is gone.
    userCount: Number(
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM users WHERE role_id = ${role.id}`
      )?.c ?? 0
    )
  }))
}

export function availablePermissions() {
  return allPermissionKeys()
}

export function createUser(
  input: { username: string; password: string; fullName: string; roleId: number },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.users.manage)
  return withTransaction(() => {
    if (input.password.length < 6) {
      throw new AppError('VALIDATION_ERROR', 'كلمة المرور يجب أن تكون 6 أحرف على الأقل')
    }
    if (usersRepository.findByUsername(input.username)) {
      throw new AppError('CONFLICT', 'اسم المستخدم مستخدم بالفعل')
    }
    if (!getDatabase().select().from(roles).where(eq(roles.id, input.roleId)).get()) {
      throw notFound('الدور غير موجود')
    }

    const id = Number(
      getDatabase()
        .insert(users)
        .values({
          username: input.username,
          passwordHash: hashPassword(input.password),
          fullName: input.fullName,
          roleId: input.roleId,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'users.create',
      entity: 'users',
      entityId: String(id),
      details: { username: input.username, roleId: input.roleId }
    })
    return id
  })
}

export function updateUser(
  id: number,
  input: { fullName?: string; roleId?: number; active?: boolean; password?: string },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.users.manage)
  const existing = getDatabase().select().from(users).where(eq(users.id, id)).get()
  if (!existing || existing.deletedAt) throw notFound('المستخدم غير موجود')
  // A live (non-tombstoned) user always has a real role — only a
  // tombstoned row's role_id is ever null (see users.schema.ts) — this
  // just gives TypeScript that same guarantee for the rest of the function.
  if (existing.roleId === null) throw notFound('المستخدم غير موجود')

  if (input.roleId !== undefined && !getDatabase().select().from(roles).where(eq(roles.id, input.roleId)).get()) {
    throw notFound('الدور غير موجود')
  }

  if (input.active === false && id === ctx.session.user.id) {
    throw new AppError('CONFLICT', 'لا يمكنك تعطيل حسابك المستخدم حالياً')
  }

  // BR-55: neither deactivation nor a role change may remove the final active administrator.
  const currentRole = getDatabase().select().from(roles).where(eq(roles.id, existing.roleId)).get()
  const nextRole = input.roleId === undefined
    ? currentRole
    : getDatabase().select().from(roles).where(eq(roles.id, input.roleId)).get()
  const removesActiveAdmin = existing.active && currentRole?.isAdmin &&
    (input.active === false || !nextRole?.isAdmin)
  if (removesActiveAdmin && countActiveAdmins() <= 1) {
      throw new AppError('CONFLICT', 'لا يمكن تعطيل آخر حساب مدير نظام')
  }

  const values: Record<string, unknown> = {}
  if (input.fullName !== undefined) values.fullName = input.fullName
  if (input.roleId !== undefined) values.roleId = input.roleId
  if (input.active !== undefined) values.active = input.active
  if (input.password) {
    if (input.password.length < 6) {
      throw new AppError('VALIDATION_ERROR', 'كلمة المرور يجب أن تكون 6 أحرف على الأقل')
    }
    values.passwordHash = hashPassword(input.password)
  }

  withTransaction(() => {
    getDatabase().update(users).set(values as never).where(eq(users.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: input.active === false && existing.active
        ? 'users.deactivate'
        : input.active === true && !existing.active
          ? 'users.reactivate'
          : input.roleId !== undefined && input.roleId !== existing.roleId
            ? 'users.role_change'
            : 'users.update',
      entity: 'users',
      entityId: String(id),
      details: {
        before: { fullName: existing.fullName, roleId: existing.roleId, active: existing.active },
        after: {
          fullName: input.fullName ?? existing.fullName,
          roleId: input.roleId ?? existing.roleId,
          active: input.active ?? existing.active
        },
        passwordChanged: Boolean(input.password)
      }
    })
  })
  if (input.active === false || input.roleId !== undefined || Boolean(input.password)) {
    destroySessionsForUser(id)
    // A "remember me" login must never survive what already force-ends
    // a live session — deactivation, a role change, or a new password.
    revokeRememberTokensForUser(id)
  }
}

const USER_ATTRIBUTION_COLUMNS = ['user_id', 'created_by', 'issued_by', 'confirmed_by', 'reversed_by']

function userHistoricalReferenceCount(userId: number, username: string): number {
  const sqlite = getDatabase()
  const raw = sqlite.all<{ name: string }>(sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `)
  let count = 0
  for (const { name } of raw) {
    if (name === 'users') continue
    const quotedTable = `"${name.replaceAll('"', '""')}"`
    const columns = getDatabase().all<{ name: string }>(sql.raw(`PRAGMA table_info(${quotedTable})`))
    for (const column of USER_ATTRIBUTION_COLUMNS) {
      if (!columns.some((item) => item.name === column)) continue
      const quotedColumn = `"${column}"`
      const row = getDatabase().get<{ c: number }>(sql.raw(
        `SELECT COUNT(*) AS c FROM ${quotedTable} WHERE ${quotedColumn} = ${Number(userId)}`
      ))
      count += Number(row?.c ?? 0)
    }
    if (columns.some((item) => item.name === 'updated_by')) {
      const row = getDatabase().get<{ c: number }>(sql.raw(
        `SELECT COUNT(*) AS c FROM ${quotedTable} WHERE "updated_by" = '${username.replaceAll("'", "''")}'`
      ))
      count += Number(row?.c ?? 0)
    }
  }
  return count
}

/**
 * Delete is a real, permanent removal — never a disguised Disable. A
 * user with no historical footprint is hard-deleted outright. One with
 * business/audit history attached (BR: never cascade-delete history)
 * is tombstoned instead: `deletedAt` is stamped and the row survives
 * only so historical joins keep resolving, but it disappears from
 * every active-management listing exactly like a hard delete does —
 * it must never surface as "معطل" (that stays Disable's own, separate
 * outcome, driven by `active` alone via updateUser).
 */
export function deleteUser(id: number, ctx: ServiceContext): { mode: 'deleted' | 'tombstoned' } {
  requirePermission(ctx.session, P.users.manage)
  const existing = getDatabase().select().from(users).where(eq(users.id, id)).get()
  if (!existing || existing.deletedAt) throw notFound('المستخدم غير موجود')
  // A live user always has a real role — only a tombstoned row's
  // role_id is ever null (see users.schema.ts).
  if (existing.roleId === null) throw notFound('المستخدم غير موجود')
  if (id === ctx.session.user.id) {
    throw new AppError('CONFLICT', 'لا يمكنك حذف حسابك المستخدم حالياً')
  }
  const role = getDatabase().select().from(roles).where(eq(roles.id, existing.roleId)).get()
  if (existing.active && role?.isAdmin && countActiveAdmins() <= 1) {
    throw new AppError('CONFLICT', 'لا يمكن حذف آخر حساب مدير نظام')
  }

  // A "remember me" token is a purely operational, trivially-revocable
  // artifact — never real business/audit history — so it must not be
  // the reason a user gets tombstoned instead of truly hard-deleted.
  // Cleared before the reference scan below (which generically checks
  // every table for a user_id column, remember_tokens included) rather
  // than after, so it can never tip that decision.
  revokeRememberTokensForUser(id)

  const referenced = userHistoricalReferenceCount(id, existing.username) > 0
  const mode = withTransaction<'deleted' | 'tombstoned'>(() => {
    if (referenced) {
      // Letting go of the role relationship here — never left pointing
      // at it — is what lets that role become genuinely deletable once
      // every user on it (tombstoned or not) is gone. Which role this
      // was is preserved below, in the audit event's own details, not
      // on this live, FK-enforced column.
      getDatabase().update(users).set({ active: false, deletedAt: nowIso(), roleId: null }).where(eq(users.id, id)).run()
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'users.delete',
        entity: 'users',
        entityId: String(id),
        details: { username: existing.username, roleId: existing.roleId, hardDeleted: false }
      })
      return 'tombstoned'
    }
    getDatabase().delete(users).where(eq(users.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'users.delete',
      entity: 'users',
      entityId: String(id),
      details: { username: existing.username, roleId: existing.roleId, hardDeleted: true }
    })
    return 'deleted'
  })
  destroySessionsForUser(id)
  // The username may now be reused; the deleted identity's lockout state must not carry over.
  clearFailedAttempts(existing.username)
  return { mode }
}

function countActiveAdmins(): number {
  return Number(
    getDatabase().get<{ c: number }>(sql`
      SELECT COUNT(*) AS c FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE r.is_admin = 1 AND u.active = 1
    `)?.c ?? 0
  )
}

export function setTheme(userId: number, theme: 'light' | 'dark'): void {
  usersRepository.setTheme(userId, theme)
}

/** BR-55: roles are created freely with any subset of permission keys. */
export function createRole(
  input: { name: string; permissions: string[] },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.roles.manage)
  return withTransaction(() => {
    const id = Number(
      getDatabase().insert(roles).values({ name: input.name, createdAt: nowIso() }).run()
        .lastInsertRowid
    )
    setRolePermissionsInternal(id, input.permissions)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'roles.create',
      entity: 'roles',
      entityId: String(id),
      details: input
    })
    return id
  })
}

export function updateRole(
  id: number,
  input: { name?: string; permissions?: string[] },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.roles.manage)
  if (input.permissions !== undefined) {
    const current = getPermissionsForRole(id)
    const valid = new Set(allPermissionKeys().map((permission) => permission.key))
    const next = new Set(input.permissions.filter((key) => valid.has(key)))
    if (current.length !== next.size || current.some((key) => !next.has(key))) {
      requirePermission(ctx.session, P.users.manage)
    }
  }
  const role = getDatabase().select().from(roles).where(eq(roles.id, id)).get()
  if (!role) throw notFound('الدور غير موجود')
  if (role.isAdmin && input.permissions) {
    throw new AppError('CONFLICT', 'دور مدير النظام يملك كامل الصلاحيات ولا يمكن تقييده')
  }

  withTransaction(() => {
    if (input.name) getDatabase().update(roles).set({ name: input.name }).where(eq(roles.id, id)).run()
    if (input.permissions) setRolePermissionsInternal(id, input.permissions)

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: input.permissions ? 'roles.permissions.update' : 'roles.update',
      entity: 'roles',
      entityId: String(id),
      details: input
    })
  })
  destroySessionsForRole(id)
}

/**
 * Custom roles only. The built-in administrator role (`isAdmin`) is
 * required by the app (BR-55: it always exists) and is never
 * deletable. A role still assigned to any LIVE user is blocked rather
 * than orphaning that user; reassign roles first. A tombstoned user
 * never counts here — deleting one already releases its role_id to
 * null (users.schema.ts) — so a role whose only users have all been
 * deleted genuinely becomes deletable, not just displayed as unused.
 *
 * Deleting a role NEVER deletes or otherwise touches a user — the
 * `inUse` check above only ever refuses this delete when a user still
 * exists on it; it never becomes a reason to also remove that user.
 * The typed name is verified here, server-side, exactly like every
 * other permanent-delete in this ERP — never trusted from the UI alone.
 */
export function deleteRole(input: { id: number; confirmation: string }, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.roles.manage)
  const role = getDatabase().select().from(roles).where(eq(roles.id, input.id)).get()
  if (!role) throw notFound('الدور غير موجود')
  if (input.confirmation.trim() !== role.name.trim()) {
    throw new AppError('VALIDATION_ERROR', `اكتب اسم الدور "${role.name}" لتأكيد الحذف النهائي`)
  }
  if (role.isAdmin) throw new AppError('CONFLICT', 'لا يمكن حذف دور مدير النظام لأنه مطلوب لعمل النظام')
  const inUse = Number(
    getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM users WHERE role_id = ${input.id}`)?.c ?? 0
  )
  if (inUse > 0) {
    throw new AppError('CONFLICT', 'لا يمكن حذف هذا الدور لأنه مرتبط بمستخدمين. غيّر أدوار المستخدمين أولاً.')
  }
  withTransaction(() => {
    getDatabase().delete(rolePermissions).where(eq(rolePermissions.roleId, input.id)).run()
    getDatabase().delete(roles).where(eq(roles.id, input.id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'roles.delete',
      entity: 'roles',
      entityId: String(input.id),
      details: { name: role.name }
    })
  })
}

function setRolePermissionsInternal(roleId: number, permissions: string[]): void {
  const db = getDatabase()
  db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId)).run()
  const valid = new Set(allPermissionKeys().map((permission) => permission.key))
  for (const key of new Set(permissions)) {
    if (!valid.has(key)) continue
    db.insert(rolePermissions).values({ roleId, permissionKey: key }).run()
  }
}

export function listAuditLog(filter: { action?: string; from?: string; to?: string } = {}, request: PageRequest = {}) {
  const normalized = { action: normalizedSearch(filter.action), from: filter.from, to: filter.to }
  return keysetPage({
    scope: 'admin.audit',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => getDatabase().all<{
      id: number; userId: number | null; userName: string | null; action: string; entity: string
      entityId: string | null; details: string | null; createdAt: string
    }>(sql`
      SELECT a.id, a.user_id AS userId, u.full_name AS userName, a.action, a.entity,
             a.entity_id AS entityId, a.details, a.created_at AS createdAt
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE 1 = 1
        ${normalized.action ? sql`AND a.action LIKE ${'%' + normalized.action + '%'}` : sql``}
        ${normalized.from ? sql`AND a.created_at >= ${normalized.from.length === 10 ? dayStart(normalized.from) : normalized.from}` : sql``}
        ${normalized.to ? sql`AND a.created_at <= ${normalized.to.length === 10 ? dayEnd(normalized.to) : normalized.to}` : sql``}
        ${window.after ? sql`AND ${keysetBoundary([sql`a.id`], window)}` : sql``}
      ORDER BY ${keysetOrder([sql`a.id`], window)}
      LIMIT ${window.take}
    `),
    summary: () => undefined
  })
}

export { auditLog }
