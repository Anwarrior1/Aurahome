import { sqliteTable, integer, text, primaryKey } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/**
 * Foundation-only tables for BR-54/BR-55 (configurable roles and
 * per-module permissions). Step 4 populates role_permissions with the
 * real key set as each module is built; this shape does not change.
 */
export const roles = sqliteTable('roles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

export const rolePermissions = sqliteTable(
  'role_permissions',
  {
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key').notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.permissionKey] })
  })
)
