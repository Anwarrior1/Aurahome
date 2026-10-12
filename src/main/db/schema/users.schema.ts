import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { roles } from './roles.schema'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Unique among live users only: a tombstoned user releases its username (CC03). */
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  fullName: text('full_name').notNull(),
  /**
   * NULLABLE — but only ever null on a tombstoned row (see `deletedAt`
   * below). Every live user always has a real role: create/update both
   * still require and validate a real roleId; nothing here loosens that.
   * The column itself must accept null so deleting a user can genuinely
   * let go of its role relationship instead of leaving a permanent,
   * FK-enforced link that blocks that role from ever being deleted.
   */
  roleId: integer('role_id')
    .references(() => roles.id),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  /** Per-user UI theme preference (AD-4). Light is the default. */
  theme: text('theme').notNull().default('light'),
  /**
   * Set only when a Delete could not hard-remove the row because
   * historical records (audit log, created_by/issued_by references,
   * etc.) still point at it. Distinct from `active` (Disable): a
   * disabled user stays in the Users list as "معطل"; a tombstoned one
   * is excluded from every active-management listing but the row
   * survives so historical joins keep resolving. Tombstoning also
   * clears `roleId` to null — which role a deleted user once held
   * stays recoverable from the `users.delete` audit_log event's own
   * frozen `roleId` detail, never from this live, FK-enforced column,
   * which must genuinely let go so the role itself can become
   * deletable once truly unused.
   */
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  /**
   * Just the managed filename ("<userId>.<ext>") under
   * files/paths.ts's own getAvatarsRoot() — never the user's original
   * external path, never the image bytes themselves. Null = no custom
   * photo, fall back to the default avatar icon (profile.service.ts).
   */
  avatarFileName: text('avatar_file_name')
}, (t) => ({
  usernameLiveUnique: uniqueIndex('users_username_live_unique').on(t.username).where(sql`${t.deletedAt} IS NULL`)
}))

/**
 * "تذكرني" — Remember Me. Only a SHA-256 hash of a 256-bit random
 * token is ever stored here; the raw token itself is generated once
 * at login, written straight to an OS-keychain-encrypted local file
 * (Electron's `safeStorage` — never localStorage, never plaintext on
 * disk) and never returned to the renderer. A resume attempt re-hashes
 * whatever it read back off disk and looks it up here — nothing in
 * this table, even with full read access to the database file, can be
 * turned back into a working credential. `onDelete: 'cascade'` means a
 * hard-deleted user's remembered logins vanish with the row for free;
 * a tombstoned (soft-deleted) or deactivated one is revoked explicitly
 * wherever its live sessions already are (see auth/remember-token.ts).
 */
export const rememberTokens = sqliteTable('remember_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  /** Sliding expiry — extended on every successful resume, so an
   *  actively-used "remember me" never hits a hard cliff, while one
   *  left untouched for the full window quietly stops working. */
  expiresAt: text('expires_at').notNull(),
  lastUsedAt: text('last_used_at')
})
