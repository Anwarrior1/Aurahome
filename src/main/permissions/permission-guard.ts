import type { AuthSession } from '@shared/types/user.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { forbidden } from '../utils/errors'

/**
 * Narrow compatibility bridge for capabilities that used to live
 * under a broad permission. New roles can grant the normalized key,
 * while databases created by an older build retain their effective
 * authority until the data migration has copied the grant.
 */
const LEGACY_FALLBACKS: Record<string, readonly string[]> = {
  [P.purchases.paySupplier]: [P.purchases.manage],
  [P.purchases.editSupplierPayment]: [P.purchases.manage],
  [P.purchases.deleteSupplierPayment]: [P.purchases.manage],
  [P.deliveries.view]: [P.orders.view],
  [P.deliveries.register]: [P.orders.manage],
  [P.deliveries.deleteOrReverse]: [P.orders.manage],
  [P.orders.viewEstimatedCost]: [P.costing.view],
  [P.orders.viewExpectedProfit]: [P.costing.view],
  [P.orders.viewActualCost]: [P.costing.view],
  [P.orders.viewActualProfit]: [P.costing.view],
  // The Approved Invoice used to have no identity of its own: every one
  // of its actions was authorised by the Customer Order's permissions,
  // so a role that can edit orders could already do all of this. These
  // bridges keep that role working EXACTLY as before while new roles
  // grant the precise key — nothing is broadened, because each fallback
  // is the permission that already allowed the action.
  [P.finalInvoices.view]: [P.orders.view],
  [P.finalInvoices.manage]: [P.orders.manage],
  [P.finalInvoices.approve]: [P.orders.manage],
  [P.finalInvoices.cancel]: [P.orders.cancel],
  [P.finalInvoices.remove]: [P.orders.manage],
  [P.finalInvoices.viewApprovedTotal]: [P.orders.view],
  [P.finalInvoices.viewOutstanding]: [P.orders.view],
  // `quotations.approve` was a misnomer for "issue to the customer".
  // The key is retired from the editor; roles still holding it keep the
  // capability under the correctly-named key.
  [P.quotations.issue]: ['quotations.approve']
  // DELIBERATELY NOT BRIDGED — a bridge is only correct when the legacy
  // key is one a restricted role would never hold anyway. These three
  // would instead re-create the very bundling this pass removed,
  // because `quotations.manage` and `customers.manage` are exactly the
  // keys a sales role IS given:
  //
  //   quotations.remove   ← quotations.manage
  //   customers.archive   ← customers.manage
  //   worksheets.reverse  ← worksheets.issue
  //
  // Each is a tightening: a role that relied on the old bundling must
  // be granted the precise key explicitly. That is the safe direction,
  // and it is what keeps "create/edit" from implying "delete",
  // "archive" or "reverse" (and what an existing security test already
  // pins for worksheets.reverse).
}

function granted(session: AuthSession, permissionKey: string): boolean {
  if (session.user.isAdmin || session.permissions.includes(permissionKey)) return true
  return (LEGACY_FALLBACKS[permissionKey] ?? []).some((legacy) => session.permissions.includes(legacy))
}

/**
 * The real permission check — this is what makes BR-104 enforcement
 * live outside the UI rather than depend on the renderer hiding a
 * button. Called from the IPC guard, and may be called a second time
 * inside a service for an action that needs a more specific check.
 */
export function requirePermission(session: AuthSession, permissionKey: string): void {
  if (!granted(session, permissionKey)) {
    throw forbidden()
  }
}

/** Same rule as requirePermission, as a plain boolean — for a caller
 *  that needs to silently include/exclude something (e.g. one
 *  notification category) rather than refuse the whole request. */
export function hasPermission(session: AuthSession, permissionKey: string): boolean {
  return granted(session, permissionKey)
}
