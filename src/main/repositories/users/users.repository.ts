import { and, eq, isNull } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { users } from '../../db/schema/users.schema'
import { roles } from '../../db/schema/roles.schema'

export interface UserRecord {
  id: number
  username: string
  passwordHash: string
  fullName: string
  /** Null only for a tombstoned row (its role relationship is
   *  deliberately released on delete — see users.schema.ts). A live
   *  user, the only kind login/session code ever legitimately reaches,
   *  always has a real role. */
  roleId: number | null
  roleName: string | null
  isAdmin: boolean | null
  active: boolean
  theme: string
}

export const usersRepository = {
  /**
   * LEFT JOIN deliberately: a tombstoned user's `role_id` is now null,
   * and this must still find that row (so createUser's duplicate-
   * username check keeps refusing a name already used by a deleted
   * account, exactly as before) — an INNER JOIN would silently miss it
   * the moment its role link is released.
   */
  findByUsername(username: string): UserRecord | undefined {
    return getDatabase()
      .select({
        id: users.id,
        username: users.username,
        passwordHash: users.passwordHash,
        fullName: users.fullName,
        roleId: users.roleId,
        active: users.active,
        theme: users.theme,
        roleName: roles.name,
        isAdmin: roles.isAdmin
      })
      .from(users)
      .leftJoin(roles, eq(users.roleId, roles.id))
      .where(and(eq(users.username, username), isNull(users.deletedAt)))
      .get()
  },

  /** Same shape/join as findByUsername — used to re-resolve the live
   *  user behind a "remember me" token on app resume. */
  findById(id: number): UserRecord | undefined {
    return getDatabase()
      .select({
        id: users.id,
        username: users.username,
        passwordHash: users.passwordHash,
        fullName: users.fullName,
        roleId: users.roleId,
        active: users.active,
        theme: users.theme,
        roleName: roles.name,
        isAdmin: roles.isAdmin
      })
      .from(users)
      .leftJoin(roles, eq(users.roleId, roles.id))
      .where(eq(users.id, id))
      .get()
  },

  /** Active user management only — a tombstoned (hard-deleted but
   *  historically-referenced) account never appears here, and never as
   *  "معطل" either; it is gone from every active listing while its row
   *  survives for audit/attribution joins alone. */
  list() {
    return getDatabase()
      .select({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        roleId: users.roleId,
        roleName: roles.name,
        isAdmin: roles.isAdmin,
        active: users.active,
        createdAt: users.createdAt
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(isNull(users.deletedAt))
      .all()
  },

  setTheme(userId: number, theme: string): void {
    getDatabase().update(users).set({ theme }).where(eq(users.id, userId)).run()
  },

  countAll(): number {
    return getDatabase().select().from(users).all().length
  }
}

export function findUserByUsername(username: string): UserRecord | undefined {
  return usersRepository.findByUsername(username)
}

export function findUserById(id: number): UserRecord | undefined {
  return usersRepository.findById(id)
}
