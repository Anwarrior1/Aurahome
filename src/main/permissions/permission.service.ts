import { eq } from 'drizzle-orm'
import { getDatabase } from '../db/connection'
import { rolePermissions } from '../db/schema/roles.schema'

/**
 * Resolves the permission keys granted to a role (BR-55). Foundation
 * implementation only — the full per-module permission matrix (view/
 * create/edit/delete per module) is populated as each module is built
 * in Step 4; this function's shape does not change.
 */
export function getPermissionsForRole(roleId: number): string[] {
  const rows = getDatabase()
    .select()
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId))
    .all()
  return rows.map((row) => row.permissionKey)
}
