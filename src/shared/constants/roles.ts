/**
 * Seed-only. Real roles are fully configurable per BR-55 and live in
 * the `roles` table (src/main/db/schema/roles.schema.ts) — this is
 * just the name of the one bootstrap administrator role that must
 * always exist so the application can never be locked out.
 */
export const BOOTSTRAP_ADMIN_ROLE_NAME = 'مدير النظام'
