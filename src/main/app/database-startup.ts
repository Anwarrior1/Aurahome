import { getDatabase, getDatabasePath } from '../db/connection'
import { runIntegrityCheck } from '../db/integrity'
import { runPendingMigrations } from '../migrations/migration-runner'
import { recoverInterruptedMigration } from '../migrations/migration-recovery'
import { recoverInterruptedRestore } from '../restore/restore-recovery'
import { initializeFinishedGoodsValuationCutovers } from '../services/production/finished-goods.service'
import { materializeDueRecurringExpenses } from '../services/finance/expenses.service'

/**
 * Production startup database gate, before any window appears:
 * recover → open → verify → migrate → verify.
 *
 * runPendingMigrations performs the one full integrity/FK proof of the
 * unchanged database (DB-14); it is repeated only if startup itself then
 * changed the database (a committed migration or new valuation cutovers).
 */
export function openVerifiedDatabase(): void {
  recoverInterruptedRestore(getDatabasePath())
  recoverInterruptedMigration(getDatabasePath())
  const { migrated } = runPendingMigrations(getDatabase())
  const cutovers = initializeFinishedGoodsValuationCutovers()
  // DB-15: the authoritative moment recurring expenses become real
  // accounting history. Reads only ever derive them, so a month that came
  // due while the app was closed is posted here — once, by the schedule
  // itself, never by somebody opening a screen.
  const recurring = materializeDueRecurringExpenses()
  if (migrated || cutovers.initialized > 0 || recurring.created > 0) runIntegrityCheck()
}
