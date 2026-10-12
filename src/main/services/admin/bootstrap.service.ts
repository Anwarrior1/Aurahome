import { sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import { roles, rolePermissions } from '../../db/schema/roles.schema'
import { users } from '../../db/schema/users.schema'
import { cashAccounts, expenseCategories } from '../../db/schema/finance.schema'
import { hashPassword } from '../../auth/password'
import { BOOTSTRAP_ADMIN_ROLE_NAME } from '@shared/constants/roles'
import { allPermissionKeys } from '@shared/permissions/permission-keys'
import { nowIso } from '../base/service.types'
import { AppError } from '../../utils/errors'

export function needsSetup(): boolean {
  const row = getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM users`)
  return (row?.c ?? 0) === 0
}

/**
 * First-run setup. Creates the full-access administrator role and
 * account that BR-55 guarantees always exists, plus a couple of
 * sensible starting rows (a cash box, basic expense categories) so
 * the ERP is usable immediately. Refuses to run if any user exists.
 */
export function performInitialSetup(input: {
  username: string
  password: string
  fullName: string
}): { userId: number; roleId: number } {
  if (!needsSetup()) {
    throw new AppError('CONFLICT', 'تم إعداد النظام بالفعل')
  }
  if (input.password.length < 6) {
    throw new AppError('VALIDATION_ERROR', 'كلمة المرور يجب أن تكون 6 أحرف على الأقل')
  }

  return withTransaction(() => {
    const db = getDatabase()
    const roleId = Number(
      db
        .insert(roles)
        .values({ name: BOOTSTRAP_ADMIN_ROLE_NAME, isAdmin: true, createdAt: nowIso() })
        .run().lastInsertRowid
    )
    for (const permission of allPermissionKeys()) {
      db.insert(rolePermissions).values({ roleId, permissionKey: permission.key }).run()
    }

    const userId = Number(
      db
        .insert(users)
        .values({
          username: input.username,
          passwordHash: hashPassword(input.password),
          fullName: input.fullName,
          roleId,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )

    db.insert(cashAccounts)
      .values({ name: 'الصندوق النقدي', kind: 'cash', openingBalanceMinor: 0, createdAt: nowIso() })
      .run()

    for (const category of [
      { name: 'إيجار', kind: 'fixed' },
      { name: 'رواتب', kind: 'fixed' },
      { name: 'كهرباء', kind: 'variable' },
      { name: 'نقل', kind: 'variable' },
      { name: 'صيانة', kind: 'variable' }
    ]) {
      db.insert(expenseCategories)
        .values({ name: category.name, kind: category.kind, createdAt: nowIso() })
        .run()
    }

    return { userId, roleId }
  })
}
