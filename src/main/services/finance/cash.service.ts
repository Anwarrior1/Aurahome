import { requirePermission } from '../../permissions/permission-guard'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { getDatabase, getRawConnection } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import { cashAccounts, cashTransactions } from '../../db/schema/finance.schema'
import { AppError, notFound } from '../../utils/errors'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { businessDate } from '@shared/business-date'
import { dayStart, dayEnd, nowIso, type ServiceContext } from '../base/service.types'
import { deleteExpense } from './expenses.service'
import {
  reverseSalaryPayment,
  deleteEmployeeTransaction,
  salaryPaymentReversalPreview
} from '../hr/employees.service'
import { reverseCustomerPayment } from '../sales/orders.service'
import { reverseSupplierPayment } from '../purchasing/purchasing.service'
import { runOptionalIdempotentFinancialCommand } from './idempotency.service'
import { requireSafeInteger, requireSafePositiveInteger } from '../../utils/numeric'
import { keysetBoundary, keysetOrder, keysetPage, type KeysetWindow, type PageRequest } from '../base/pagination'

/** Date-only ledger values are business days; timestamps are actual instants. */
function cashPeriodPredicate(from?: string, to?: string): SQL {
  const occurred = cashTransactions.occurredAt
  const dateOnly = sql`${occurred} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`
  // Stored event instants must have a calendar date and time. Do not let
  // SQLite interpret arbitrary strings such as 'now' as moving timestamps.
  const instantValue = sql`CASE WHEN ${occurred} GLOB '????-??-??[T ]*'
    THEN julianday(${occurred}) END`
  const clauses: SQL[] = []
  if (from) {
    const date = from.length === 10 ? from : businessDate(new Date(from))
    const instant = from.length === 10 ? dayStart(from) : from
    clauses.push(sql`CASE WHEN ${dateOnly} THEN ${occurred} >= ${date}
      ELSE ${instantValue} >= julianday(${instant}) END`)
  }
  if (to) {
    const date = to.length === 10 ? to : businessDate(new Date(to))
    // The next local midnight is exclusive; SQLite compares instants rather
    // than ISO text whose seconds/fractional precision can differ.
    const instant =
      to.length === 10 ? new Date(new Date(dayEnd(to)).getTime() + 1).toISOString() : to
    const instantBound =
      to.length === 10
        ? sql`${instantValue} < julianday(${instant})`
        : sql`${instantValue} <= julianday(${instant})`
    clauses.push(sql`CASE WHEN ${dateOnly} THEN ${occurred} <= ${date}
      ELSE ${instantBound} END`)
  }
  return and(...clauses) ?? sql`1`
}

/**
 * BR-114/BR-24: operational cash tracking only — running balances on
 * named accounts, no general ledger, no journals, no chart of
 * accounts. Transfers between accounts carry a shared transferGroup
 * so they can be excluded from revenue/expense reporting.
 */
/**
 * Account master with ledger-derived balances. Two statements regardless of
 * account count: the accounts themselves and one grouped pass over their
 * movements using the same opening + inflow − outflow rule as accountBalance.
 */
export function listAccounts(filter: { asOf?: string } = {}) {
  const rows = getDatabase().select().from(cashAccounts).all()
  const period = cashPeriodPredicate(undefined, filter.asOf?.slice(0, 10))
  const totals = new Map(
    getDatabase().all<{ accountId: number; asOfNet: number; currentNet: number; transactionCount: number }>(sql`
      SELECT account_id AS accountId,
        COALESCE(SUM(CASE WHEN direction = 'in' AND (${period}) THEN amount_minor END), 0)
          - COALESCE(SUM(CASE WHEN direction = 'out' AND (${period}) THEN amount_minor END), 0) AS asOfNet,
        COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_minor END), 0)
          - COALESCE(SUM(CASE WHEN direction = 'out' THEN amount_minor END), 0) AS currentNet,
        COUNT(*) AS transactionCount
      FROM cash_transactions
      GROUP BY account_id
    `).map((row) => [row.accountId, row])
  )
  return rows.map((account) => {
    const ledger = totals.get(account.id)
    return {
      ...account,
      balanceMinor: account.openingBalanceMinor + (ledger?.asOfNet ?? 0),
      // Always the live figure, so the UI can show what the account holds
      // today even while the user is browsing a historical day.
      currentBalanceMinor: account.openingBalanceMinor + (ledger?.currentNet ?? 0),
      transactionCount: ledger?.transactionCount ?? 0
    }
  })
}

/** Whether any ledger row already exists for this account (item 8's safety gate). */
export function transactionCount(accountId: number): number {
  return (
    getDatabase().get<{ c: number }>(
      sql`SELECT COUNT(*) AS c FROM cash_transactions WHERE account_id = ${accountId}`
    )?.c ?? 0
  )
}

/**
 * Balance = opening + every inflow − every outflow, never a stored
 * figure. With `asOf` it is the balance AS OF the end of that day: the
 * opening balance plus ALL movements up to and including it — not a sum
 * of that single day's activity.
 */
export function accountBalance(accountId: number, asOf?: string): number {
  const period = cashPeriodPredicate(undefined, asOf?.slice(0, 10))
  const row = getDatabase().get<{ opening: number; inflow: number; outflow: number }>(sql`
    SELECT
      (SELECT opening_balance_minor FROM cash_accounts WHERE id = ${accountId}) AS opening,
      COALESCE((SELECT SUM(amount_minor) FROM cash_transactions
                WHERE account_id = ${accountId} AND direction = 'in'
                  AND (${period})), 0) AS inflow,
      COALESCE((SELECT SUM(amount_minor) FROM cash_transactions
                WHERE account_id = ${accountId} AND direction = 'out'
                  AND (${period})), 0) AS outflow
  `)
  return (row?.opening ?? 0) + (row?.inflow ?? 0) - (row?.outflow ?? 0)
}

export function createAccount(
  input: {
    name: string
    kind: 'cash' | 'bank'
    openingBalanceMinor?: number
    notes?: string
    requestKey?: string
  },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, P.cash.manage)
  requireSafeInteger(input.openingBalanceMinor ?? 0, 'الرصيد الافتتاحي')
  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'cash.createAccount',
    requestKey,
    payload,
    ctx,
    execute: () => {
      const id = Number(
        getDatabase()
          .insert(cashAccounts)
          .values({
            name: input.name,
            kind: input.kind,
            openingBalanceMinor: input.openingBalanceMinor ?? 0,
            notes: input.notes ?? null,
            createdAt: nowIso()
          })
          .run().lastInsertRowid
      )
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'cash.account.create',
        entity: 'cash_accounts',
        entityId: String(id),
        details: payload
      })
      return id
    }
  })
}

/**
 * Item 8: the opening balance may only be edited directly while the
 * account has zero recorded movements — the moment any transaction
 * exists, changing it would silently shift every historical running
 * balance computed since (accountBalance sums opening + all
 * movements). Once transactions exist, a correction must go through
 * adjustAccountBalance() below instead, which is itself a transaction
 * and never rewrites anything.
 */
export function updateAccount(
  id: number,
  input: {
    name?: string
    kind?: string
    notes?: string
    active?: boolean
    openingBalanceMinor?: number
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.cash.manage)
  return withTransaction(() => {
    if (input.openingBalanceMinor !== undefined) {
      requireSafeInteger(input.openingBalanceMinor, 'الرصيد الافتتاحي')
    }
    if (!getDatabase().select().from(cashAccounts).where(eq(cashAccounts.id, id)).get()) {
      throw notFound('الحساب غير موجود')
    }
    if (input.openingBalanceMinor !== undefined && transactionCount(id) > 0) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن تعديل الرصيد الافتتاحي بعد وجود حركات على الحساب. استخدم "تعديل الرصيد" لتسجيل تسوية بدلاً من ذلك'
      )
    }
    getDatabase()
      .update(cashAccounts)
      .set({ ...input })
      .where(eq(cashAccounts.id, id))
      .run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'cash.account.update',
      entity: 'cash_accounts',
      entityId: String(id),
      details: input
    })
  })
}

/**
 * Item 9: "تعديل الرصيد" — the administrator states the desired
 * current balance; the system computes the difference and posts one
 * ordinary cash_transactions row for it (never touching any prior
 * row), so the adjustment is itself a normal, auditable, dated
 * movement with a reason and the acting user attached — exactly like
 * every other cash movement in the ERP (BR-114).
 */
export function adjustAccountBalance(
  input: {
    accountId: number
    desiredBalanceMinor: number
    reason: string
    occurredAt?: string
    requestKey?: string
  },
  ctx: ServiceContext
): { adjustmentMinor: number; newBalanceMinor: number } {
  requirePermission(ctx.session, P.cash.manage)
  requireSafeInteger(input.desiredBalanceMinor, 'الرصيد المطلوب')
  if (!input.reason?.trim()) {
    throw new AppError('VALIDATION_ERROR', 'سبب تعديل الرصيد مطلوب')
  }
  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'cash.adjustBalance',
    requestKey,
    payload,
    ctx,
    execute: () => {
      if (
        !getDatabase().select().from(cashAccounts).where(eq(cashAccounts.id, input.accountId)).get()
      ) {
        throw notFound('الحساب غير موجود')
      }
      const current = accountBalance(input.accountId)
      requireSafeInteger(current, 'الرصيد الحالي')
      const exactDiff = BigInt(input.desiredBalanceMinor) - BigInt(current)
      const diff = Number(exactDiff)
      requireSafeInteger(diff, 'قيمة تعديل الرصيد')
      if (diff === 0) {
        throw new AppError('VALIDATION_ERROR', 'الرصيد الحالي مطابق للرصيد المطلوب بالفعل')
      }
      const occurredAt = input.occurredAt ?? nowIso()
      writeCashMovement({
        accountId: input.accountId,
        direction: diff > 0 ? 'in' : 'out',
        amountMinor: Math.abs(diff),
        kind: 'balance_adjustment',
        notes: input.reason,
        occurredAt,
        ctx
      })
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'cash.account.adjustBalance',
        entity: 'cash_accounts',
        entityId: String(input.accountId),
        details: {
          previousBalanceMinor: current,
          desiredBalanceMinor: input.desiredBalanceMinor,
          adjustmentMinor: diff,
          reason: input.reason
        }
      })
      return { adjustmentMinor: diff, newBalanceMinor: input.desiredBalanceMinor }
    }
  })
}

/**
 * Item 8: a cash account is ordinary master data, but every money
 * movement in the ERP posts through it (BR-114) — blocked once any
 * cash_transactions row references it, since every such row is a
 * protected financial record. Deactivate instead.
 */
export function deleteAccount(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.cash.manage)
  return withTransaction(() => {
    if (!getDatabase().select().from(cashAccounts).where(eq(cashAccounts.id, id)).get()) {
      throw notFound('الحساب غير موجود')
    }
    const movementCount =
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM cash_transactions WHERE account_id = ${id}`
      )?.c ?? 0
    if (movementCount > 0) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن حذف هذا الحساب لوجود حركات مالية مسجّلة عليه. يمكنك تعطيله بدلاً من ذلك'
      )
    }
    getDatabase().delete(cashAccounts).where(eq(cashAccounts.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'cash.account.delete',
      entity: 'cash_accounts',
      entityId: String(id)
    })
  })
}

export interface CashAccountFullDeletePreview {
  accountId: number
  name: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}

interface CashAccountDeletionPlan extends CashAccountFullDeletePreview {
  transferGroups: string[]
  manualIds: number[]
  expenseIds: number[]
  salaryTransactionIds: number[]
  employeeTransactionIds: number[]
  customerPaymentIds: number[]
  supplierPaymentIds: number[]
  profitWithdrawalIds: number[]
  savingsUsageIds: number[]
  workerTransactionIds: number[]
}

const DEP_LABELS: Record<string, string> = {
  expenses: 'مصروفات',
  salaryPayments: 'رواتب مدفوعة',
  employeeTransactions: 'حركات سلف/استقطاعات موظفين',
  customerPayments: 'دفعات عملاء',
  supplierPayments: 'دفعات موردين',
  profitWithdrawals: 'سحوبات أرباح',
  savingsUsage: 'استخدام من صندوق الادخار',
  workerTransactions: 'حركات عمال (سحب/إرجاع)',
  transfers: 'تحويلات بين حسابات',
  manualMovements: 'حركات نقدية يدوية'
}

/**
 * Classifies every cash_transactions row on this account by its true
 * source — never by assumption — and decides, per BR/item 4, whether
 * that source document can safely be reversed here or must block the
 * whole deletion. Built ONCE and walked identically by the preview and
 * the execution, so they can never diverge (same discipline as
 * `fullDeletePreview`/`performFullDeleteOrder`).
 *
 * Every category below is reversed through the ERP's OWN existing
 * reversal function for that record kind (`deleteExpense`,
 * `reverseSalaryPayment`, `deleteEmployeeTransaction`,
 * `reverseCustomerPayment`, `reverseSupplierPayment`, `deleteTransfer`,
 * `deleteCashMovement`) — never a duplicated accounting formula.
 * Profit withdrawals, savings usage and worker withdrawals/repayments
 * have no other stored aggregate anywhere (their running totals are
 * always derived live via SQL SUM), so removing the row and its own
 * cash effect together IS their complete, safe reversal.
 */
function planCashAccountDeletion(accountId: number): CashAccountDeletionPlan {
  const account = getDatabase()
    .select()
    .from(cashAccounts)
    .where(eq(cashAccounts.id, accountId))
    .get()
  if (!account) throw notFound('الحساب غير موجود')

  const raw = getRawConnection()
  const rows = raw
    .prepare(
      `
    SELECT id, ref_table AS refTable, ref_id AS refId, transfer_group AS transferGroup
    FROM cash_transactions WHERE account_id = ?
  `
    )
    .all(accountId) as Array<{
    id: number
    refTable: string | null
    refId: number | null
    transferGroup: string | null
  }>

  const transferGroups = new Set<string>()
  const manualIds: number[] = []
  const expenseIds: number[] = []
  const salaryTransactionIds: number[] = []
  const employeeTransactionIds: number[] = []
  const customerPaymentIds: number[] = []
  const supplierPaymentIds: number[] = []
  const profitWithdrawalIds: number[] = []
  const savingsUsageIds: number[] = []
  const workerTransactionIds: number[] = []
  const blockers: string[] = []

  for (const row of rows) {
    if (row.transferGroup) {
      transferGroups.add(row.transferGroup)
      continue
    }
    if (row.refId == null) {
      if (row.refTable)
        blockers.push(`الحركة #${row.id} تحمل مرجعاً غير صالح ولا يمكن التعامل معها بأمان`)
      else manualIds.push(row.id)
      continue
    }
    switch (row.refTable) {
      case 'expenses': {
        const expense = raw.prepare('SELECT source FROM expenses WHERE id = ?').get(row.refId) as
          { source: string } | undefined
        if (!expense) {
          blockers.push(`الحركة #${row.id} ترتبط بمصروف غير موجود`)
          break
        }
        if (expense.source === 'recurring') {
          blockers.push(
            `الحركة #${row.id} ترتبط بمصروف ثابت متكرر — أوقف المصروف الثابت نفسه بدلاً من حذف حركة واحدة`
          )
          break
        }
        expenseIds.push(row.refId)
        break
      }
      case 'employee_transactions': {
        const et = raw
          .prepare('SELECT kind, reversed_at AS reversedAt FROM employee_transactions WHERE id = ?')
          .get(row.refId) as { kind: string; reversedAt: string | null } | undefined
        if (!et) {
          blockers.push(`الحركة #${row.id} ترتبط بحركة موظف غير موجودة`)
          break
        }
        if (et.kind === 'salary_payment') {
          const reversal = salaryPaymentReversalPreview(row.refId, {
            allowReversedForHardDelete: true
          })
          if (reversal.blockers.length) blockers.push(...reversal.blockers)
          else salaryTransactionIds.push(row.refId)
        } else {
          employeeTransactionIds.push(row.refId)
        }
        break
      }
      case 'customer_payments': {
        const allocated = raw
          .prepare(
            'SELECT COUNT(*) AS c FROM customer_payment_refund_allocations WHERE payment_id = ?'
          )
          .get(row.refId) as { c: number }
        if (allocated.c > 0)
          blockers.push(
            `الحركة #${row.id} ترتبط بدفعة لها سجل استرداد محفوظ — لا يمكن حذف الحساب قبل معالجة الطلب من مساره`
          )
        else customerPaymentIds.push(row.refId)
        break
      }
      case 'customer_payment_refunds':
        blockers.push(
          `الحركة #${row.id} ترتبط باسترداد دفعة عميل محفوظ — لا يمكن حذف الحساب قبل معالجة الطلب من مساره`
        )
        break
      case 'supplier_payments':
        supplierPaymentIds.push(row.refId)
        break
      case 'profit_withdrawals':
        profitWithdrawalIds.push(row.refId)
        break
      case 'savings_transactions':
        savingsUsageIds.push(row.refId)
        break
      case 'worker_transactions':
        workerTransactionIds.push(row.refId)
        break
      default:
        manualIds.push(row.id)
    }
  }

  const uniqueSalaryTransactionIds = [...new Set(salaryTransactionIds)]
  const counts: Record<string, number> = {
    expenses: expenseIds.length,
    salaryPayments: uniqueSalaryTransactionIds.length,
    employeeTransactions: employeeTransactionIds.length,
    customerPayments: customerPaymentIds.length,
    supplierPayments: supplierPaymentIds.length,
    profitWithdrawals: profitWithdrawalIds.length,
    savingsUsage: savingsUsageIds.length,
    workerTransactions: workerTransactionIds.length,
    transfers: transferGroups.size,
    manualMovements: manualIds.length
  }
  const dependencies = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, label: DEP_LABELS[key] ?? key, count }))

  if (rows.length > 0) {
    blockers.unshift(
      'الحساب مرتبط بحركات مالية مُرحّلة؛ لا يجوز حذف الحساب أو مصادر الحركات التاريخية. عطّل الحساب بدلاً من ذلك'
    )
  }

  return {
    accountId,
    name: account.name,
    dependencies,
    blockers: [...new Set(blockers)],
    transferGroups: [...transferGroups],
    manualIds,
    expenseIds,
    salaryTransactionIds: uniqueSalaryTransactionIds,
    employeeTransactionIds,
    customerPaymentIds,
    supplierPaymentIds,
    profitWithdrawalIds,
    savingsUsageIds,
    workerTransactionIds
  }
}

/** Discovers and validates the complete downstream graph without mutating it. */
export function cashAccountFullDeletePreview(accountId: number): CashAccountFullDeletePreview {
  const { accountId: id, name, dependencies, blockers } = planCashAccountDeletion(accountId)
  return { accountId: id, name, dependencies, blockers }
}

/**
 * Permanent deletion is limited to an account with no transactions. The
 * legacy cascade body remains unreachable for real posted accounts because
 * planCashAccountDeletion adds the history blocker for every cash row.
 */
export function fullDeleteCashAccount(
  input: { id: number; confirmation: string },
  ctx: ServiceContext
): { removed: true; summary: Record<string, number> } {
  requirePermission(ctx.session, P.cash.fullDelete)
  const plan = planCashAccountDeletion(input.id)
  if (input.confirmation.trim() !== plan.name.trim()) {
    throw new AppError('VALIDATION_ERROR', `اكتب اسم الحساب "${plan.name}" لتأكيد الحذف النهائي`)
  }
  if (plan.blockers.length) {
    throw new AppError('CONFLICT', `تعذر حذف الحساب بالكامل: ${plan.blockers.join('، ')}`)
  }

  return withTransaction(() => {
    // Re-derive inside the open transaction rather than trusting the
    // plan computed above, matching performFullDeleteOrder's own
    // re-check discipline — a change between preview and execution is
    // caught, never acted on blindly.
    const fresh = planCashAccountDeletion(input.id)
    if (fresh.blockers.length) {
      throw new AppError('CONFLICT', `تعذر حذف الحساب بالكامل: ${fresh.blockers.join('، ')}`)
    }

    for (const group of fresh.transferGroups) deleteTransfer(group, ctx)
    for (const id of fresh.expenseIds) deleteExpense(id, ctx)
    for (const id of [...new Set(fresh.salaryTransactionIds)]) {
      reverseSalaryPayment(id, ctx, { hardDelete: true, origin: 'cash_account_full_delete' })
    }
    for (const id of fresh.employeeTransactionIds) deleteEmployeeTransaction(id, ctx)
    for (const id of fresh.customerPaymentIds) reverseCustomerPayment(id, ctx)
    for (const id of fresh.supplierPaymentIds) reverseSupplierPayment(id, ctx)
    for (const id of fresh.profitWithdrawalIds) {
      getDatabase().run(sql`DELETE FROM profit_withdrawals WHERE id = ${id}`)
      removeCashMovementForRef('profit_withdrawals', id)
    }
    for (const id of fresh.savingsUsageIds) {
      getDatabase().run(sql`DELETE FROM savings_transactions WHERE id = ${id}`)
      removeCashMovementForRef('savings_transactions', id)
    }
    for (const id of fresh.workerTransactionIds) {
      getDatabase().run(sql`DELETE FROM worker_transactions WHERE id = ${id}`)
      removeCashMovementForRef('worker_transactions', id)
    }
    for (const id of fresh.manualIds) deleteCashMovement(id, ctx)

    getDatabase().delete(cashAccounts).where(eq(cashAccounts.id, input.id)).run()

    const summary = Object.fromEntries(
      fresh.dependencies.map((item) => [item.key, item.count])
    ) as Record<string, number>
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'cash.account.full_delete',
      entity: 'cash_accounts',
      entityId: String(input.id),
      details: {
        fullDelete: true,
        description: `Full Cash Account deletion (${fresh.name} #${input.id})`,
        name: fresh.name,
        summary
      }
    })
    return { removed: true, summary }
  })
}

/**
 * The single write path into the append-only cash ledger. Every money
 * movement in the ERP (customer payment, supplier payment, salary,
 * worker withdrawal, expense, profit withdrawal, transfer) routes
 * through here so account balances are always reconstructable.
 */
type CashPosting = {
  accountId?: number | null
  direction: 'in' | 'out'
  amountMinor: number
  kind: string
  refTable?: string
  refId?: number
  transferGroup?: string
  reversalOfId?: number
  notes?: string
  occurredAt?: string
  ctx?: ServiceContext
}

function writeCashMovement(input: CashPosting): number | undefined {
  if (!input.accountId) return undefined
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')
  const account = getDatabase()
    .select()
    .from(cashAccounts)
    .where(eq(cashAccounts.id, input.accountId))
    .get()
  if (!account) throw notFound('الحساب النقدي غير موجود')

  return Number(
    getDatabase()
      .insert(cashTransactions)
      .values({
        accountId: input.accountId,
        direction: input.direction,
        amountMinor: input.amountMinor,
        kind: input.kind,
        refTable: input.refTable ?? null,
        refId: input.refId ?? null,
        transferGroup: input.transferGroup ?? null,
        reversalOfId: input.reversalOfId ?? null,
        notes: input.notes ?? null,
        occurredAt: input.occurredAt ?? nowIso(),
        createdBy: input.ctx?.session.user.id ?? null,
        createdAt: nowIso()
      })
      .run().lastInsertRowid
  )
}

interface CashSource {
  accountId: number | null
  amountMinor: number
  direction: 'in' | 'out'
  kind: string | null
  occurredAt: string | null
  reversedAt?: string | null
}

// Only persisted business sources can authorize a projection. A transaction
// alone is insufficient; no caller-provided ownership flag is accepted.
function cashSource(refTable: string, refId: number): CashSource | undefined {
  const queries: Record<string, string> = {
    customer_payments: `SELECT cash_account_id AS accountId, amount_minor AS amountMinor,
      'in' AS direction, 'customer_payment' AS kind, paid_at AS occurredAt FROM customer_payments WHERE id = ?`,
    customer_payment_refunds: `SELECT cash_account_id AS accountId, amount_minor AS amountMinor,
      'out' AS direction, 'customer_payment_refund' AS kind, refunded_at AS occurredAt FROM customer_payment_refunds WHERE id = ?`,
    supplier_payments: `SELECT cash_account_id AS accountId, amount_minor AS amountMinor,
      'out' AS direction, 'supplier_payment' AS kind, paid_at AS occurredAt FROM supplier_payments WHERE id = ?`,
    expenses: `SELECT CASE WHEN source = 'salary' THEN NULL ELSE cash_account_id END AS accountId,
      amount_minor AS amountMinor, 'out' AS direction, 'expense' AS kind, spent_at AS occurredAt FROM expenses WHERE id = ?`,
    employee_transactions: `SELECT CASE WHEN kind IN ('advance', 'repayment', 'salary_payment') THEN cash_account_id END AS accountId,
      CASE WHEN kind = 'salary_payment' THEN COALESCE(paid_amount_minor, amount_minor -
        COALESCE((SELECT SUM(amount_minor) FROM employee_transactions c WHERE c.parent_transaction_id = t.id AND c.kind = 'deduction'), 0)) ELSE amount_minor END AS amountMinor,
      CASE WHEN kind = 'repayment' THEN 'in' ELSE 'out' END AS direction,
      CASE kind WHEN 'salary_payment' THEN 'salary' WHEN 'advance' THEN 'employee_advance' WHEN 'repayment' THEN 'employee_repayment' END AS kind,
      CASE WHEN kind = 'salary_payment' THEN (SELECT spent_at FROM expenses WHERE id = t.expense_id) ELSE created_at END AS occurredAt,
      reversed_at AS reversedAt FROM employee_transactions t WHERE id = ?`,
    worker_transactions: `SELECT CASE WHEN kind IN ('withdrawal', 'repayment', 'commission_payment') THEN cash_account_id END AS accountId,
      amount_minor AS amountMinor, CASE WHEN kind = 'repayment' THEN 'in' ELSE 'out' END AS direction,
      CASE kind WHEN 'withdrawal' THEN 'worker_withdrawal' WHEN 'repayment' THEN 'worker_repayment' WHEN 'commission_payment' THEN 'worker_commission_payment' END AS kind,
      created_at AS occurredAt FROM worker_transactions WHERE id = ?`,
    savings_transactions: `SELECT CASE WHEN kind = 'usage' THEN cash_account_id END AS accountId,
      amount_minor AS amountMinor, 'in' AS direction, 'savings_usage' AS kind, occurred_at AS occurredAt FROM savings_transactions WHERE id = ?`,
    profit_withdrawals: `SELECT cash_account_id AS accountId, amount_minor AS amountMinor,
      'out' AS direction, 'profit_withdrawal' AS kind, withdrawn_at AS occurredAt FROM profit_withdrawals WHERE id = ?`
  }
  const query = queries[refTable]
  if (!query || !Number.isSafeInteger(refId) || refId <= 0) throw projectionConflict()
  return getRawConnection().prepare(query).get(refId) as CashSource | undefined
}

function projectionConflict(): AppError {
  return new AppError('CONFLICT', 'الحركة المالية مملوكة للعملية الأصلية؛ لا يمكن تغييرها بشكل مستقل')
}

function requireProjectionTransaction(): void {
  if (!getRawConnection().inTransaction) throw projectionConflict()
}

function matchesSource(row: { accountId?: number | null; amountMinor: number; direction: string; kind: string; transferGroup?: string | null; occurredAt?: string }, source: CashSource): boolean {
  return row.accountId === source.accountId && row.amountMinor === source.amountMinor &&
    row.direction === source.direction && row.kind === source.kind && !row.transferGroup &&
    (!source.occurredAt || row.occurredAt === source.occurredAt ||
      (source.occurredAt.length > 10 && row.occurredAt === businessDate(new Date(source.occurredAt))))
}

/** Source-backed posting only. Standalone Cash commands use the private writer. */
export function postCashMovement(input: CashPosting): number | undefined {
  requireProjectionTransaction()
  const source = cashSource(input.refTable ?? '', input.refId ?? 0)
  if (!source) throw projectionConflict()
  if (!input.accountId && !source.accountId) return undefined
  if (input.reversalOfId !== undefined) {
    // The payroll owner first marks its salary source reversed in this same
    // transaction. Only then can one equal/opposite reversal be projected.
    const original = getDatabase().select().from(cashTransactions)
      .where(eq(cashTransactions.id, input.reversalOfId)).get()
    const duplicate = getDatabase().get(sql`SELECT 1 FROM cash_transactions WHERE reversal_of_id = ${input.reversalOfId}`)
    if (input.refTable !== 'employee_transactions' || !source.reversedAt || source.kind !== 'salary' ||
      !original || original.reversalOfId || duplicate || original.refTable !== input.refTable ||
      original.refId !== input.refId || original.accountId !== input.accountId ||
      original.amountMinor !== input.amountMinor || original.direction === input.direction ||
      input.direction !== 'in' || input.kind !== 'salary_reversal' || input.transferGroup ||
      input.occurredAt !== source.reversedAt) throw projectionConflict()
  } else {
    if (source.reversedAt || !matchesSource(input, source)) throw projectionConflict()
    if (getDatabase().get(sql`SELECT 1 FROM cash_transactions
      WHERE ref_table = ${input.refTable} AND ref_id = ${input.refId} LIMIT 1`)) throw projectionConflict()
  }
  return writeCashMovement(input)
}

/** BR-114: a transfer is two rows, never revenue and never an expense. */
export function transfer(
  input: {
    fromAccountId: number
    toAccountId: number
    amountMinor: number
    notes?: string
    occurredAt?: string
    requestKey?: string
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.cash.transfer)
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')
  if (input.fromAccountId === input.toAccountId) {
    throw new AppError('VALIDATION_ERROR', 'لا يمكن التحويل إلى نفس الحساب')
  }
  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'cash.transfer',
    requestKey,
    payload,
    ctx,
    execute: () => {
      if (accountBalance(input.fromAccountId) < input.amountMinor) {
        throw new AppError('CONFLICT', 'الرصيد المتوفر في الحساب غير كافٍ')
      }
      const group = randomUUID()
      const occurredAt = input.occurredAt ?? nowIso()
      writeCashMovement({
        accountId: input.fromAccountId,
        direction: 'out',
        amountMinor: input.amountMinor,
        kind: 'transfer_out',
        transferGroup: group,
        notes: input.notes,
        occurredAt,
        ctx
      })
      writeCashMovement({
        accountId: input.toAccountId,
        direction: 'in',
        amountMinor: input.amountMinor,
        kind: 'transfer_in',
        transferGroup: group,
        notes: input.notes,
        occurredAt,
        ctx
      })
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'cash.transfer',
        entity: 'cash_transactions',
        entityId: group,
        details: payload
      })
    }
  })
}

/**
 * The same accountBalance() formula, with two specific rows excluded
 * from both sums — used only to re-check "can this account support
 * this transfer" WHILE EDITING that same transfer, so a same-account
 * edit is never checked against a balance that still includes the
 * very leg about to be replaced.
 */
function accountBalanceExcludingRows(accountId: number, excludeIds: [number, number]): number {
  const [a, b] = excludeIds
  const row = getDatabase().get<{ opening: number; inflow: number; outflow: number }>(sql`
    SELECT
      (SELECT opening_balance_minor FROM cash_accounts WHERE id = ${accountId}) AS opening,
      COALESCE((SELECT SUM(amount_minor) FROM cash_transactions
                WHERE account_id = ${accountId} AND direction = 'in' AND id NOT IN (${a}, ${b})), 0) AS inflow,
      COALESCE((SELECT SUM(amount_minor) FROM cash_transactions
                WHERE account_id = ${accountId} AND direction = 'out' AND id NOT IN (${a}, ${b})), 0) AS outflow
  `)
  return (row?.opening ?? 0) + (row?.inflow ?? 0) - (row?.outflow ?? 0)
}

/**
 * Loads a transfer's two legs and confirms it is a genuine Cash-module
 * transfer (item — ownership priority): a row generated by another
 * module always wins even if it somehow also carried a transferGroup,
 * so this can never become a backdoor around source-document
 * protection.
 */
function loadTransferLegs(transferGroup: string): {
  outLeg: typeof cashTransactions.$inferSelect
  inLeg: typeof cashTransactions.$inferSelect
} {
  const legs = getDatabase()
    .select()
    .from(cashTransactions)
    .where(eq(cashTransactions.transferGroup, transferGroup))
    .all()
  const outLeg = legs.find((l) => l.direction === 'out')
  const inLeg = legs.find((l) => l.direction === 'in')
  if (legs.length !== 2 || !outLeg || !inLeg) {
    throw new AppError('CONFLICT', 'بيانات هذا التحويل غير مكتملة ولا يمكن التعامل معه بأمان')
  }
  if (outLeg.refTable || inLeg.refTable) {
    throw new AppError(
      'CONFLICT',
      'هذه الحركة مرتبطة بعملية أخرى في النظام ولا يمكن التعامل معها كتحويل عادي'
    )
  }
  return { outLeg, inLeg }
}

export interface TransferDetail {
  transferGroup: string
  fromAccountId: number
  toAccountId: number
  amountMinor: number
  notes: string | null
  occurredAt: string
}

/**
 * The authoritative, complete pair for one transfer — read straight
 * from the database, never derived from whatever the caller's own
 * (possibly account- or date-filtered) transaction list happens to
 * hold, so opening the edit/delete flow from either leg always shows
 * the real other side.
 */
export function getTransfer(transferGroup: string): TransferDetail {
  const { outLeg, inLeg } = loadTransferLegs(transferGroup)
  return {
    transferGroup,
    fromAccountId: outLeg.accountId,
    toAccountId: inLeg.accountId,
    amountMinor: outLeg.amountMinor,
    notes: outLeg.notes,
    occurredAt: outLeg.occurredAt
  }
}

/**
 * Corrects a Cash-module transfer AS ONE GROUPED OPERATION — both legs
 * always move together, so there is never a stale original leg, a
 * duplicated effect, or a mismatched amount between the two sides.
 * Both rows keep their id and their shared transferGroup; only the
 * account/amount/date/notes change — the same in-place-correction
 * philosophy as updateCashMovement, applied to the pair atomically.
 */
export function updateTransfer(
  input: {
    transferGroup: string
    fromAccountId: number
    toAccountId: number
    amountMinor: number
    notes?: string
    occurredAt?: string
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.cash.transfer)
  if (input.fromAccountId === input.toAccountId) {
    throw new AppError('VALIDATION_ERROR', 'لا يمكن التحويل إلى نفس الحساب')
  }
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')
  if (
    !getDatabase().select().from(cashAccounts).where(eq(cashAccounts.id, input.fromAccountId)).get()
  ) {
    throw notFound('حساب المصدر غير موجود')
  }
  if (
    !getDatabase().select().from(cashAccounts).where(eq(cashAccounts.id, input.toAccountId)).get()
  ) {
    throw notFound('حساب الوجهة غير موجود')
  }

  const { outLeg, inLeg } = loadTransferLegs(input.transferGroup)
  const available = accountBalanceExcludingRows(input.fromAccountId, [outLeg.id, inLeg.id])
  if (available < input.amountMinor) {
    throw new AppError(
      'CONFLICT',
      'الرصيد المتوفر في حساب المصدر غير كافٍ لهذا التحويل بعد التعديل'
    )
  }

  const before = {
    fromAccountId: outLeg.accountId,
    toAccountId: inLeg.accountId,
    amountMinor: outLeg.amountMinor,
    occurredAt: outLeg.occurredAt,
    notes: outLeg.notes
  }
  const occurredAt = input.occurredAt ?? outLeg.occurredAt
  const notes = input.notes !== undefined ? input.notes : outLeg.notes

  withTransaction(() => {
    getDatabase()
      .update(cashTransactions)
      .set({ accountId: input.fromAccountId, amountMinor: input.amountMinor, occurredAt, notes })
      .where(eq(cashTransactions.id, outLeg.id))
      .run()
    getDatabase()
      .update(cashTransactions)
      .set({ accountId: input.toAccountId, amountMinor: input.amountMinor, occurredAt, notes })
      .where(eq(cashTransactions.id, inLeg.id))
      .run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'cash.transfer.update',
      entity: 'cash_transactions',
      entityId: input.transferGroup,
      details: {
        description: `Transfer correction (${input.transferGroup})`,
        before,
        after: {
          fromAccountId: input.fromAccountId,
          toAccountId: input.toAccountId,
          amountMinor: input.amountMinor,
          occurredAt,
          notes
        }
      }
    })
  })
}

/**
 * Removes/voids BOTH legs of a Cash-module transfer together — never
 * one side alone, so each account's balance is restored exactly once
 * and no orphaned leg can remain.
 */
export function deleteTransfer(transferGroup: string, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.cash.transfer)
  const { outLeg, inLeg } = loadTransferLegs(transferGroup)

  withTransaction(() => {
    getDatabase().delete(cashTransactions).where(eq(cashTransactions.id, outLeg.id)).run()
    getDatabase().delete(cashTransactions).where(eq(cashTransactions.id, inLeg.id)).run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'cash.transfer.delete',
      entity: 'cash_transactions',
      entityId: transferGroup,
      details: {
        description: `Transfer deletion (${transferGroup})`,
        fromAccountId: outLeg.accountId,
        toAccountId: inLeg.accountId,
        amountMinor: outLeg.amountMinor,
        occurredAt: outLeg.occurredAt
      }
    })
  })
}

/**
 * Narrow, scoped exceptions to the append-only cash ledger, used only
 * when a service explicitly allows editing/deleting the user-entered
 * record that originated a cash movement (e.g. an employee advance, a
 * manually entered expense, or moving a supplier payment to a
 * different cash/bank account). The source service must update/delete
 * its business row and this paired cash row in one transaction and
 * audit the correction. System-generated salary, ordinary customer
 * payments, profit withdrawals and transfers remain append-only outside
 * their explicit correction/full-operation cleanup workflows.
 *
 * Since an account balance is always derived live (opening + Σin −
 * Σout, never a stored figure), re-pointing this one row's accountId
 * IS the complete "reverse from A, apply to B" operation: A's sum
 * drops by amountMinor and B's sum gains it, in a single row, so the
 * purchase/expense/etc. can never appear as an active deduction on
 * two accounts at once (there is only ever the one row).
 */
export function adjustCashMovementForRef(
  refTable: string,
  refId: number,
  updates: { amountMinor?: number; accountId?: number; occurredAt?: string }
): void {
  requireProjectionTransaction()
  const source = cashSource(refTable, refId)
  const rows = getDatabase().select().from(cashTransactions)
    .where(and(eq(cashTransactions.refTable, refTable), eq(cashTransactions.refId, refId))).all()
  if (rows.length !== 1) {
    throw new AppError('CONFLICT', 'رابط الحركة النقدية لهذه العملية غير مكتمل أو مكرر؛ لم يتم تغيير أي بيانات')
  }
  if (!source || source.reversedAt || rows[0]!.reversalOfId ||
    !matchesSource({ ...rows[0]!, accountId: updates.accountId ?? rows[0]!.accountId,
      amountMinor: updates.amountMinor ?? rows[0]!.amountMinor,
      occurredAt: updates.occurredAt ?? rows[0]!.occurredAt }, source) ||
    (updates.occurredAt !== undefined && updates.occurredAt !== rows[0]!.occurredAt && updates.occurredAt !== source.occurredAt)) {
    throw projectionConflict()
  }
  if (updates.accountId !== undefined) {
    const account = getDatabase()
      .select()
      .from(cashAccounts)
      .where(eq(cashAccounts.id, updates.accountId))
      .get()
    if (!account) throw notFound('الحساب النقدي غير موجود')
  }
  const set: { amountMinor?: number; accountId?: number; occurredAt?: string } = {}
  if (updates.amountMinor !== undefined) set.amountMinor = updates.amountMinor
  if (updates.accountId !== undefined) set.accountId = updates.accountId
  if (updates.occurredAt !== undefined) set.occurredAt = updates.occurredAt
  if (Object.keys(set).length === 0) return
  // DB-12: a source correction must move exactly its one mirror. Zero rows
  // would leave the source claiming money that never moved; several would
  // re-point duplicates. Either way the caller's transaction rolls back.
  const changed = getDatabase()
    .update(cashTransactions)
    .set(set)
    .where(
      and(
        eq(cashTransactions.refTable, refTable),
        eq(cashTransactions.refId, refId),
        sql`${cashTransactions.reversalOfId} IS NULL`
      )
    )
    .run().changes
  if (changed !== 1) {
    throw new AppError('CONFLICT', 'رابط الحركة النقدية لهذه العملية غير مكتمل أو مكرر؛ لم يتم تغيير أي بيانات')
  }
}

export function removeCashMovementForRef(refTable: string, refId: number): void {
  requireProjectionTransaction()
  const source = cashSource(refTable, refId)
  if (source?.accountId) throw projectionConflict()
  getDatabase()
    .delete(cashTransactions)
    .where(and(eq(cashTransactions.refTable, refTable), eq(cashTransactions.refId, refId)))
    .run()
}

/**
 * Where a cash row came from, and therefore whether it may be corrected
 * in place. A row is MANUAL when nothing else in the ERP owns it: no
 * source record (`refTable`) and not one half of a transfer pair. Today
 * that is the balance adjustment posted from "تعديل الرصيد" — a real,
 * standalone, user-entered movement.
 *
 * Everything else was generated BY another transaction and is only one
 * half of that record's financial effect. Editing or deleting such a row
 * on its own would leave its source claiming money that no longer moved,
 * so it is refused here and named, pointing at the authoritative screen
 * where the whole operation can be corrected or reversed instead.
 *
 * A transfer leg is refused here too — SINGLE-ROW correction would let
 * one side of a transfer drift from the other — but a transfer, unlike
 * a linked module's record, IS fully owned by this Cash module, so
 * updateTransfer()/deleteTransfer() below give it its own group-level
 * edit/delete path instead of leaving it permanently locked.
 */
const LINKED_SOURCE_SCREENS: Record<string, string> = {
  customer_payments: 'صفحة الطلب — سجل الدفعات',
  customer_payment_refunds: 'صفحة الطلب — سجل الدفعات',
  supplier_payments: 'صفحة المشتريات',
  purchases: 'صفحة المشتريات',
  expenses: 'صفحة المصروفات',
  employee_transactions: 'صفحة الموظفين والرواتب',
  worker_transactions: 'صفحة العمال',
  savings_transactions: 'صفحة الادخار',
  profit_withdrawals: 'صفحة مسحوبات الأرباح'
}

export interface CashMovementEditability {
  id: number
  manual: boolean
  refTable: string | null
  refId: number | null
  blockers: string[]
}

export function cashMovementEditability(id: number): CashMovementEditability {
  const row = getDatabase().select().from(cashTransactions).where(eq(cashTransactions.id, id)).get()
  if (!row) throw notFound('الحركة النقدية غير موجودة')
  const blockers: string[] = []
  if (row.transferGroup) {
    blockers.push(
      'هذه الحركة أحد طرفي تحويل بين حسابين — عدّل التحويل نفسه حتى يبقى الطرفان متطابقين'
    )
  }
  if (row.refTable) {
    const screen = LINKED_SOURCE_SCREENS[row.refTable] ?? 'العملية الأصلية'
    blockers.push(
      `هذه الحركة ناتجة عن عملية أخرى في النظام — نفّذ التعديل أو الحذف من ${screen} حتى تبقى العملية الأصلية متطابقة`
    )
  }
  return {
    id,
    manual: blockers.length === 0,
    refTable: row.refTable,
    refId: row.refId,
    blockers
  }
}

function assertManualMovement(id: number): CashMovementEditability {
  const check = cashMovementEditability(id)
  if (!check.manual) throw new AppError('CONFLICT', check.blockers.join('، '))
  return check
}

/**
 * Corrects a standalone cash movement. The account balance is always
 * `opening + Σin − Σout`, never a stored figure, so changing the amount,
 * direction, account or date here changes the REAL balance immediately —
 * an 18,000 inflow corrected to 15,000 lowers the account by 3,000.
 */
export function updateCashMovement(
  input: {
    id: number
    accountId?: number
    direction?: 'in' | 'out'
    amountMinor?: number
    notes?: string
    occurredAt?: string
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, P.cash.manage)
  assertManualMovement(input.id)
  const existing = getDatabase()
    .select()
    .from(cashTransactions)
    .where(eq(cashTransactions.id, input.id))
    .get()!

  const next = {
    accountId: input.accountId ?? existing.accountId,
    direction: input.direction ?? existing.direction,
    amountMinor: input.amountMinor ?? existing.amountMinor,
    notes: input.notes ?? existing.notes,
    occurredAt: input.occurredAt ?? existing.occurredAt
  }
  requireSafePositiveInteger(next.amountMinor, 'المبلغ')
  if (!getDatabase().select().from(cashAccounts).where(eq(cashAccounts.id, next.accountId)).get()) {
    throw notFound('الحساب النقدي غير موجود')
  }

  withTransaction(() => {
    getDatabase().update(cashTransactions).set(next).where(eq(cashTransactions.id, input.id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'cash.movement.update',
      entity: 'cash_transactions',
      entityId: String(input.id),
      details: {
        description: `Manual cash movement correction (#${input.id})`,
        before: {
          accountId: existing.accountId,
          direction: existing.direction,
          amountMinor: existing.amountMinor,
          occurredAt: existing.occurredAt
        },
        after: next
      }
    })
  })
}

/** Removes a standalone cash movement; no reason, no typed identifier. */
export function deleteCashMovement(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, P.cash.manage)
  assertManualMovement(id)
  const existing = getDatabase()
    .select()
    .from(cashTransactions)
    .where(eq(cashTransactions.id, id))
    .get()!

  withTransaction(() => {
    getDatabase().delete(cashTransactions).where(eq(cashTransactions.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'cash.movement.delete',
      entity: 'cash_transactions',
      entityId: String(id),
      details: {
        description: `Manual cash movement deletion (#${id})`,
        accountId: existing.accountId,
        direction: existing.direction,
        amountMinor: existing.amountMinor,
        kind: existing.kind,
        occurredAt: existing.occurredAt
      }
    })
  })
}

export function listTransactions(
  filter: { accountId?: number; kind?: string; from?: string; to?: string } = {},
  request: PageRequest = {}
) {
  const normalized = { accountId: filter.accountId, kind: filter.kind, from: filter.from, to: filter.to }
  const clauses: SQL[] = []
  if (normalized.accountId) clauses.push(eq(cashTransactions.accountId, normalized.accountId))
  if (normalized.kind) clauses.push(eq(cashTransactions.kind, normalized.kind))
  clauses.push(cashPeriodPredicate(normalized.from, normalized.to))
  return keysetPage({
    scope: 'cash.transactions',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => getDatabase()
      .select()
      .from(cashTransactions)
      .where(and(...clauses, keysetBoundary([sql`${cashTransactions.id}`], window)))
      .orderBy(keysetOrder([sql`${cashTransactions.id}`], window))
      .limit(window.take)
      .all()
      // One flag so the list can show the edit/delete icons only where
      // they can actually succeed; the server enforces it regardless.
      .map((row) => ({ ...row, manual: !row.refTable && !row.transferGroup })),
    summary: () => undefined
  })
}
