import { and, desc, eq, like, sql, type SQL } from 'drizzle-orm'
import { keysetBoundary, keysetOrder, keysetPage, normalizedSearch, type KeysetWindow, type PageRequest } from '../base/pagination'
import { getDatabase } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import {
  cashTransactions,
  expenseCategories,
  expenses,
  recurringExpenseAmounts,
  recurringExpenses
} from '../../db/schema/finance.schema'
import { AppError, notFound } from '../../utils/errors'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, today, type ServiceContext } from '../base/service.types'
import { postCashMovement, adjustCashMovementForRef, removeCashMovementForRef } from './cash.service'
// A salary-generated expense is one half of a payroll payment, so
// deleting it from the Expenses screen reuses the payroll service's own
// single reversal path rather than repeating it here. The two modules
// call the payroll owner; salary expense creation is private to payroll.
import { reverseSalaryPayment } from '../hr/employees.service'
import { PERMISSION_KEYS } from '@shared/permissions/permission-keys'
import { requirePermission } from '../../permissions/permission-guard'
import { runOptionalIdempotentFinancialCommand } from './idempotency.service'
import { requireSafePositiveInteger } from '../../utils/numeric'
import { assertPreparationCostEditable } from '../sales/uncollected-products.service'

export function listCategories(activeOnly = false) {
  return getDatabase()
    .select()
    .from(expenseCategories)
    .where(activeOnly ? eq(expenseCategories.active, true) : undefined)
    .all()
}

export function createCategory(
  input: { name: string; kind: 'fixed' | 'variable' },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, PERMISSION_KEYS.expenses.manage)
  return withTransaction(() => {
    const id = Number(
      getDatabase()
        .insert(expenseCategories)
        .values({ name: input.name, kind: input.kind, createdAt: nowIso() })
        .run().lastInsertRowid
    )
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'expenses.category.create',
      entity: 'expense_categories',
      entityId: String(id),
      details: input
    })
    return id
  })
}

export function updateCategory(
  id: number,
  input: { name?: string; kind?: 'fixed' | 'variable'; active?: boolean },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, PERMISSION_KEYS.expenses.manage)
  return withTransaction(() => {
    getDatabase()
      .update(expenseCategories)
      .set({ ...input })
      .where(eq(expenseCategories.id, id))
      .run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'expenses.category.update',
      entity: 'expense_categories',
      entityId: String(id),
      details: input
    })
  })
}

/** Item 8: a category is ordinary master data; blocked once expenses
 *  already reference it (each remains a valid, individually protected
 *  expense record). */
export function deleteCategory(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, PERMISSION_KEYS.expenses.manage)
  return withTransaction(() => {
    if (!getDatabase().select().from(expenseCategories).where(eq(expenseCategories.id, id)).get()) {
      throw notFound('التصنيف غير موجود')
    }
    const usageCount =
      getDatabase().get<{ c: number }>(
        sql`SELECT COUNT(*) AS c FROM expenses WHERE category_id = ${id}`
      )?.c ?? 0
    if (usageCount > 0) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن حذف هذا التصنيف لوجود مصروفات مسجّلة عليه. يمكنك تعطيله بدلاً من ذلك'
      )
    }
    getDatabase().delete(expenseCategories).where(eq(expenseCategories.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'expenses.category.delete',
      entity: 'expense_categories',
      entityId: String(id)
    })
  })
}

// ============================================================
// FIXED / RECURRING EXPENSES
// ============================================================
//
// A Fixed Expense the user sets up once (e.g. "إيجار المصنع") keeps
// affecting every future month automatically, without being
// re-entered — but it is never a second, parallel place money is
// accounted for. The design mirrors two patterns already in this
// codebase:
//
//   • employees / employee_salary_history — a stable definition row
//     plus an append-only amount history, so a later raise can never
//     rewrite what a past month actually cost.
//   • paySalary() → createSalaryExpense() — the ONE authoritative
//     accounting effect of a recurring cost is always a normal,
//     frozen `expenses` row (source='recurring' here, exactly like
//     source='salary' there), so every existing report/dashboard/
//     cash-ledger query that already sums `expenses` needs no change
//     at all to pick it up correctly, and can never double-count it.
//
// `recurring_expenses` is the definition (no amount lives on it). Its
// amount history lives in `recurring_expense_amounts`. The monthly
// occurrence is materialized into `expenses` the first time that
// month is looked at — idempotent, checked by source='recurring' +
// sourceRefId + the occurrence's own canonical spentAt (the 1st of
// its month), so opening the Expenses page or switching months never
// creates a duplicate charge or cash movement.

function monthStart(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`
}

function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const months: string[] = []
  const [fy, fm] = fromMonth.slice(0, 7).split('-').map(Number) as [number, number]
  const [ty, tm] = toMonth.slice(0, 7).split('-').map(Number) as [number, number]
  let y = fy
  let m = fm
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, '0')}-01`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return months
}

/**
 * The amount actually in effect for `periodStart` ('YYYY-MM-01'),
 * resolved from the append-only history — never "whatever the
 * template's latest amount is" — so raising the rent in October can
 * never retroactively change what September resolves to, regardless
 * of which month is materialized first (items 14/15).
 */
function amountEffectiveFor(recurringExpenseId: number, periodStart: string): number | undefined {
  return getDatabase()
    .select({ amountMinor: recurringExpenseAmounts.amountMinor })
    .from(recurringExpenseAmounts)
    .where(
      and(
        eq(recurringExpenseAmounts.recurringExpenseId, recurringExpenseId),
        sql`${recurringExpenseAmounts.effectiveFrom} <= ${periodStart}`
      )
    )
    .orderBy(desc(recurringExpenseAmounts.effectiveFrom), desc(recurringExpenseAmounts.id))
    .limit(1)
    .get()?.amountMinor
}

/**
 * One month of one schedule, as the definition + its amount history
 * imply it — whether or not it has been posted to `expenses` yet.
 * DB-15: reads derive these; only an authoritative command posts them.
 */
export interface ScheduledOccurrence {
  recurringExpenseId: number
  categoryId: number | null
  categoryName: string | null
  description: string
  cashAccountId: number | null
  periodStart: string
  amountMinor: number
}

function materializeOccurrence(occurrence: ScheduledOccurrence): void {
  const already = getDatabase()
    .select({ id: expenses.id })
    .from(expenses)
    .where(
      and(
        eq(expenses.source, 'recurring'),
        eq(expenses.sourceRefId, occurrence.recurringExpenseId),
        eq(expenses.spentAt, occurrence.periodStart)
      )
    )
    .get()
  if (already) return // item 12/13: idempotent — never a second charge for the same expense+month

  const { amountMinor, periodStart } = occurrence
  withTransaction(() => {
    const id = Number(
      getDatabase()
        .insert(expenses)
        .values({
          categoryId: occurrence.categoryId,
          kind: 'fixed',
          amountMinor,
          orderId: null,
          cashAccountId: occurrence.cashAccountId,
          description: occurrence.description,
          spentAt: periodStart,
          source: 'recurring',
          sourceRefId: occurrence.recurringExpenseId,
          // Posted by the schedule itself, not by a person acting in the
          // UI — there is no acting user to attribute it to.
          createdBy: null,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    postCashMovement({
      accountId: occurrence.cashAccountId ?? undefined,
      direction: 'out',
      amountMinor,
      kind: 'expense',
      refTable: 'expenses',
      refId: id,
      occurredAt: periodStart
    })
    recordAuditEvent({
      action: 'expenses.recurring.materialize',
      entity: 'expenses',
      entityId: String(id),
      details: { recurringExpenseId: occurrence.recurringExpenseId, period: periodStart, amountMinor }
    })
  })
}

/**
 * The month window a recurring query covers. An explicit month/range is
 * honored exactly as asked, whether before or after today; only a
 * completely unfiltered "all expenses" view is capped at today, so an
 * open-ended schedule can never walk endlessly into the future.
 */
function recurringWindow(fromDate?: string, toDate?: string): { from: string; to: string } | undefined {
  const templateCount =
    getDatabase().get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM recurring_expenses`)?.c ?? 0
  if (templateCount === 0) return undefined
  const to = toDate ? monthStart(toDate) : monthStart(today())
  const earliest = getDatabase().get<{ m: string | null }>(
    sql`SELECT MIN(start_date) AS m FROM recurring_expenses`
  )?.m
  const lowerBound = fromDate ? monthStart(fromDate) : (earliest ?? to)
  return { from: lowerBound < to ? lowerBound : to, to }
}

/**
 * Every occurrence the active schedules imply for [fromDate, toDate]
 * that has NOT been posted to `expenses` yet, with the amount that was
 * actually in effect for each month.
 *
 * DB-15: this is a pure read. Lists, reports, the dashboard and the
 * profit calculation derive the months nobody has posted yet instead of
 * writing them, so browsing a period — including a future one — can
 * never create authoritative financial history or a cash movement.
 * One statement, bounded by the window's months × active schedules.
 */
export function scheduledRecurringOccurrences(
  fromDate?: string,
  toDate?: string
): ScheduledOccurrence[] {
  const window = recurringWindow(fromDate, toDate)
  if (!window) return []
  const periods = monthsBetween(window.from, window.to)
  if (!periods.length) return []
  return getDatabase().all<ScheduledOccurrence>(sql`
    WITH months(period) AS (VALUES ${sql.join(periods.map((period) => sql`(${period})`), sql`, `)})
    SELECT r.id AS recurringExpenseId, r.category_id AS categoryId, c.name AS categoryName,
           r.description AS description, r.cash_account_id AS cashAccountId,
           months.period AS periodStart, a.amount_minor AS amountMinor
    FROM months
    JOIN recurring_expenses r
      ON r.active = 1
     AND months.period >= r.start_date
     AND (r.end_date IS NULL OR months.period <= r.end_date)
    LEFT JOIN expense_categories c ON c.id = r.category_id
    JOIN recurring_expense_amounts a ON a.id = (
      SELECT inner_amount.id FROM recurring_expense_amounts inner_amount
       WHERE inner_amount.recurring_expense_id = r.id
         AND inner_amount.effective_from <= months.period
       ORDER BY inner_amount.effective_from DESC, inner_amount.id DESC
       LIMIT 1
    )
    WHERE NOT EXISTS (
      SELECT 1 FROM expenses e
       WHERE e.source = 'recurring' AND e.source_ref_id = r.id AND e.spent_at = months.period
    )
    ORDER BY months.period, r.id
  `)
}

/**
 * The same filters `expenseFilterClauses` applies in SQL, applied to
 * derived occurrences so a filtered list/summary counts them exactly as
 * it would count the posted rows. A derived occurrence is always a
 * `fixed`, unreversed, order-less expense.
 */
function filterScheduled(
  occurrences: ScheduledOccurrence[],
  filter: ExpenseListFilter
): ScheduledOccurrence[] {
  if (filter.orderId || filter.linkedOnly) return [] // never linked to an order
  if (filter.kind && filter.kind !== 'fixed') return []
  // SQLite LIKE is case-insensitive for ASCII and exact for Arabic text.
  const search = filter.search?.toLowerCase()
  return occurrences.filter(
    (occurrence) =>
      (!filter.categoryId || occurrence.categoryId === filter.categoryId) &&
      (!filter.from || occurrence.periodStart >= filter.from) &&
      (!filter.to || occurrence.periodStart <= filter.to) &&
      (!search || occurrence.description.toLowerCase().includes(search))
  )
}

/**
 * AUTHORITATIVE WRITE PATH — posts every scheduled occurrence in
 * [fromDate, toDate] that is not posted yet, each with its cash
 * movement and audit row, in its own transaction.
 *
 * DB-15: never call this from a list/report/dashboard/profit path. A
 * read derives what it needs with `scheduledRecurringOccurrences`;
 * posting is a command, so browsing can never create financial
 * history. Startup posts what is due (`materializeDueRecurringExpenses`)
 * and the recurring-definition commands post their own due months.
 *
 * Bounded only by each definition's own start/end date (items 17/18)
 * and honored exactly as asked, so an explicit range may deliberately
 * post future months; `materializeDueRecurringExpenses` is the caller
 * that stops at today.
 */
export function ensureRecurringExpensesThrough(fromDate?: string, toDate?: string): void {
  for (const occurrence of scheduledRecurringOccurrences(fromDate, toDate)) {
    materializeOccurrence(occurrence)
  }
}

/**
 * Posts every occurrence already due — start of this month or earlier —
 * and nothing dated in the future. Called at startup and after any
 * change to a recurring definition, so a due month becomes real
 * accounting history from an authoritative action rather than from
 * somebody opening a screen (DB-15).
 */
export function materializeDueRecurringExpenses(): { created: number } {
  const due = scheduledRecurringOccurrences(undefined, today())
  for (const occurrence of due) materializeOccurrence(occurrence)
  return { created: due.length }
}

export interface RecurringExpenseInput {
  categoryId?: number | null
  description: string
  amountMinor: number
  cashAccountId?: number | null
  startDate: string
  notes?: string
  requestKey?: string
}

export function listRecurringExpenses(activeOnly = false) {
  const rows = getDatabase()
    .select({
      id: recurringExpenses.id,
      categoryId: recurringExpenses.categoryId,
      categoryName: expenseCategories.name,
      description: recurringExpenses.description,
      cashAccountId: recurringExpenses.cashAccountId,
      startDate: recurringExpenses.startDate,
      endDate: recurringExpenses.endDate,
      active: recurringExpenses.active
    })
    .from(recurringExpenses)
    .leftJoin(expenseCategories, eq(recurringExpenses.categoryId, expenseCategories.id))
    .where(activeOnly ? eq(recurringExpenses.active, true) : undefined)
    .orderBy(desc(recurringExpenses.id))
    .all()
  const currentPeriod = monthStart(today())
  return rows.map((row) => ({
    ...row,
    currentAmountMinor: amountEffectiveFor(row.id, currentPeriod) ?? 0
  }))
}

export function getRecurringExpense(id: number) {
  const template = getDatabase()
    .select()
    .from(recurringExpenses)
    .where(eq(recurringExpenses.id, id))
    .get()
  if (!template) throw notFound('المصروف الثابت المتكرر غير موجود')
  const amounts = getDatabase()
    .select()
    .from(recurringExpenseAmounts)
    .where(eq(recurringExpenseAmounts.recurringExpenseId, id))
    .orderBy(desc(recurringExpenseAmounts.effectiveFrom))
    .all()
  return { template, amounts }
}

/** BR item 1/2/3: the Fixed Expense DEFINITION — created once, never
 *  re-entered every month. Its first amount is effective from its own
 *  start month. */
export function createRecurringExpense(input: RecurringExpenseInput, ctx: ServiceContext): number {
  requirePermission(ctx.session, PERMISSION_KEYS.expenses.manage)
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')
  if (!input.description?.trim()) throw new AppError('VALIDATION_ERROR', 'وصف المصروف الثابت مطلوب')
  if (!input.startDate) throw new AppError('VALIDATION_ERROR', 'تاريخ البدء مطلوب')
  const startDate = monthStart(input.startDate)

  const { requestKey, ...payload } = input
  const created = runOptionalIdempotentFinancialCommand({
    commandScope: 'expenses.createRecurring',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        const id = Number(
          getDatabase()
            .insert(recurringExpenses)
            .values({
              categoryId: input.categoryId ?? null,
              description: input.description,
              cashAccountId: input.cashAccountId ?? null,
              startDate,
              endDate: null,
              active: true,
              createdBy: ctx.session.user.id,
              createdAt: nowIso()
            })
            .run().lastInsertRowid
        )
        getDatabase()
          .insert(recurringExpenseAmounts)
          .values({
            recurringExpenseId: id,
            amountMinor: input.amountMinor,
            effectiveFrom: startDate,
            notes: input.notes ?? null,
            createdBy: ctx.session.user.id,
            createdAt: nowIso()
          })
          .run()
        recordAuditEvent({
          userId: ctx.session.user.id,
          action: 'expenses.recurring.create',
          entity: 'recurring_expenses',
          entityId: String(id),
          details: { ...input, startDate }
        })
        return id
      })
  })
  return created
}

/**
 * Editing the DEFINITION only — category, description, cash account,
 * end date, active state. Never the amount (use
 * changeRecurringExpenseAmount for that) — so "edit this occurrence
 * vs. the recurring definition" (item 24) is never ambiguous: the
 * definition only ever affects months not yet materialized, and the
 * amount is always effective-dated.
 */
export function updateRecurringExpense(
  id: number,
  input: {
    categoryId?: number | null
    description?: string
    cashAccountId?: number | null
    endDate?: string | null
    active?: boolean
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, PERMISSION_KEYS.expenses.manage)
  return withTransaction(() => {
    const existing = getDatabase()
      .select()
      .from(recurringExpenses)
      .where(eq(recurringExpenses.id, id))
      .get()
    if (!existing) throw notFound('المصروف الثابت المتكرر غير موجود')
    const next = {
      categoryId: input.categoryId === undefined ? existing.categoryId : input.categoryId,
      description: input.description ?? existing.description,
      cashAccountId: input.cashAccountId === undefined ? existing.cashAccountId : input.cashAccountId,
      endDate:
        input.endDate === undefined
          ? existing.endDate
          : input.endDate
            ? monthStart(input.endDate)
            : null,
      active: input.active ?? existing.active
    }
    if (!next.description.trim()) throw new AppError('VALIDATION_ERROR', 'وصف المصروف الثابت مطلوب')
    if (next.endDate && next.endDate < existing.startDate) {
      throw new AppError('VALIDATION_ERROR', 'تاريخ الانتهاء لا يمكن أن يسبق تاريخ البدء')
    }

    getDatabase().update(recurringExpenses).set(next).where(eq(recurringExpenses.id, id)).run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'expenses.recurring.update',
      entity: 'recurring_expenses',
      entityId: String(id),
      details: { before: existing, after: next }
    })
  })
}

/**
 * Items 14/15/26: append (or, only for a month that shares the exact
 * same effectiveFrom, correct in place) one amount-history row —
 * NEVER touches any other row, so a month already materialized (or
 * simply already past) can never be rewritten by a later change.
 */
export function changeRecurringExpenseAmount(
  id: number,
  input: { amountMinor: number; effectiveFrom: string; notes?: string },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, PERMISSION_KEYS.expenses.manage)
  const template = getDatabase()
    .select()
    .from(recurringExpenses)
    .where(eq(recurringExpenses.id, id))
    .get()
  if (!template) throw notFound('المصروف الثابت المتكرر غير موجود')
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')
  const effectiveFrom = monthStart(input.effectiveFrom)
  if (effectiveFrom < template.startDate) {
    throw new AppError(
      'VALIDATION_ERROR',
      'لا يمكن أن يسبق تاريخ سريان المبلغ الجديد تاريخ بدء المصروف الثابت'
    )
  }

  const existingForMonth = getDatabase()
    .select()
    .from(recurringExpenseAmounts)
    .where(
      and(
        eq(recurringExpenseAmounts.recurringExpenseId, id),
        eq(recurringExpenseAmounts.effectiveFrom, effectiveFrom)
      )
    )
    .get()

  withTransaction(() => {
    if (existingForMonth) {
      getDatabase()
        .update(recurringExpenseAmounts)
        .set({ amountMinor: input.amountMinor, notes: input.notes ?? existingForMonth.notes })
        .where(eq(recurringExpenseAmounts.id, existingForMonth.id))
        .run()
    } else {
      getDatabase()
        .insert(recurringExpenseAmounts)
        .values({
          recurringExpenseId: id,
          amountMinor: input.amountMinor,
          effectiveFrom,
          notes: input.notes ?? null,
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run()
    }
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'expenses.recurring.changeAmount',
      entity: 'recurring_expenses',
      entityId: String(id),
      details: {
        effectiveFrom,
        amountMinor: input.amountMinor,
        replaced: Boolean(existingForMonth)
      }
    })
  })
}

/**
 * An unused recurring definition is setup data and may be hard-deleted. Once
 * an occurrence has posted, removing the schedule means ending it: prior
 * expense, cash and amount-history rows remain historically reproducible.
 */
export function deleteRecurringExpense(
  id: number,
  ctx: ServiceContext
): { deleted: boolean; deactivated: boolean } {
  requirePermission(ctx.session, PERMISSION_KEYS.expenses.manage)
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new AppError('VALIDATION_ERROR', 'معرّف المصروف غير صحيح')
  return withTransaction(() => {
    const { template, amounts } = getRecurringExpense(id)
    const owned = and(eq(expenses.source, 'recurring'), eq(expenses.sourceRefId, id))
    const generated = getDatabase().select().from(expenses).where(owned).all()
    if (generated.length > 0) {
      // Retried requests are a no-op: do not create duplicate audit events or
      // reopen a schedule that was already ended successfully.
      if (!template.active) return { deleted: false, deactivated: true }
      const currentMonth = monthStart(today())
      const endDate =
        template.endDate && template.endDate < currentMonth ? template.endDate : currentMonth
      getDatabase()
        .update(recurringExpenses)
        .set({ active: false, endDate })
        .where(eq(recurringExpenses.id, id))
        .run()
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'expenses.recurring.deactivate',
        entity: 'recurring_expenses',
        entityId: String(id),
        details: {
          before: template,
          endDate,
          generatedExpenseCount: generated.length,
          historicalRowsPreserved: true
        }
      })
      return { deleted: false, deactivated: true }
    }
    const ownedIds = sql`(SELECT id FROM expenses WHERE source = 'recurring' AND source_ref_id = ${id})`
    const linkedCash = and(
      eq(cashTransactions.refTable, 'expenses'),
      sql`${cashTransactions.refId} IN ${ownedIds}`
    )
    const movements = getDatabase().select().from(cashTransactions).where(linkedCash).all()
    const byExpense = new Map<number, typeof movements>()
    for (const movement of movements) {
      const rows = byExpense.get(movement.refId!) ?? []
      rows.push(movement)
      byExpense.set(movement.refId!, rows)
    }
    for (const expense of generated) {
      const cash = byExpense.get(expense.id) ?? []
      const matches =
        expense.cashAccountId === null
          ? cash.length === 0
          : cash.length === 1 &&
            cash[0]!.accountId === expense.cashAccountId &&
            cash[0]!.amountMinor === expense.amountMinor &&
            cash[0]!.direction === 'out' &&
            cash[0]!.kind === 'expense' &&
            cash[0]!.transferGroup === null
      if (expense.kind !== 'fixed' || expense.orderId !== null || !matches) {
        throw new AppError(
          'CONFLICT',
          `تعذّر عكس المصروف المولّد #${expense.id}: بيانات المصروف أو حركته النقدية المرتبطة غير متطابقة. راجع السجل المالي قبل الحذف`
        )
      }
    }
    // source_ref_id is polymorphic, so a payroll backlink is unexpected
    // even if a corrupt/legacy row still claims source='recurring'.
    const payrollLink = getDatabase().get<{ id: number }>(sql`
      SELECT id FROM employee_transactions WHERE expense_id IN ${ownedIds} LIMIT 1
    `)
    if (payrollLink)
      throw new AppError(
        'CONFLICT',
        'تعذّر العكس: أحد المصروفات المولّدة مرتبط بحركة رواتب. راجع الرابط المالي قبل الحذف'
      )

    const affectedAccounts = new Map<number, number>()
    for (const movement of movements) {
      affectedAccounts.set(
        movement.accountId,
        (affectedAccounts.get(movement.accountId) ?? 0) + movement.amountMinor
      )
    }
    // Delete only exact expense-reference links, before their source rows.
    // A subquery avoids per-occurrence cash-table scans and parameter limits.
    getDatabase().delete(cashTransactions).where(linkedCash).run()
    getDatabase().delete(expenses).where(owned).run()
    getDatabase().delete(recurringExpenses).where(eq(recurringExpenses.id, id)).run() // cascades owned amount history
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'expenses.recurring.delete',
      entity: 'recurring_expenses',
      entityId: String(id),
      details: {
        reversal: true,
        before: template,
        amounts,
        generatedExpenseCount: generated.length,
        totalReversedMinor: generated.reduce((sum, row) => sum + row.amountMinor, 0),
        affectedAccounts: [...affectedAccounts].map(([accountId, restoredMinor]) => ({
          accountId,
          restoredMinor
        })),
        generatedExpenses: generated,
        cashMovements: movements
      }
    })
    return { deleted: true, deactivated: false }
  })
}

export interface ExpenseListFilter {
  search?: string
  categoryId?: number
  kind?: 'fixed' | 'variable'
  orderId?: number
  linkedOnly?: boolean
  from?: string
  to?: string
}

export interface ExpenseSummary {
  totalCount: number
  /** Unreversed expenses linked to an order (direct order cost). */
  linkedMinor: number
  /** Unreversed fixed expenses excluding payroll-generated rows. */
  fixedNonSalaryMinor: number
  /** Unreversed variable expenses. */
  variableMinor: number
}

function expenseFilterClauses(filter: ExpenseListFilter): SQL[] {
  const clauses: SQL[] = []
  if (filter.categoryId) clauses.push(eq(expenses.categoryId, filter.categoryId))
  if (filter.kind) clauses.push(eq(expenses.kind, filter.kind))
  if (filter.orderId) clauses.push(eq(expenses.orderId, filter.orderId))
  if (filter.linkedOnly) clauses.push(sql`${expenses.orderId} IS NOT NULL`)
  if (filter.from) clauses.push(sql`${expenses.spentAt} >= ${filter.from}`)
  if (filter.to) clauses.push(sql`${expenses.spentAt} <= ${filter.to}`)
  if (filter.search) clauses.push(like(expenses.description, `%${filter.search}%`))
  return clauses
}

function normalizeExpenseFilter(filter: ExpenseListFilter): ExpenseListFilter {
  return {
    search: normalizedSearch(filter.search),
    categoryId: filter.categoryId,
    kind: filter.kind,
    orderId: filter.orderId,
    linkedOnly: filter.linkedOnly || undefined,
    from: filter.from,
    to: filter.to
  }
}

/** Authoritative totals for the complete filtered set, independent of any page. */
export function expenseSummary(filter: ExpenseListFilter = {}): ExpenseSummary {
  const normalized = normalizeExpenseFilter(filter)
  // Item 4/6 + DB-15: whatever month(s) this query touches, its active
  // fixed expenses are counted whether or not they have been posted —
  // derived here, never written by a read.
  return summaryOf(
    normalized,
    filterScheduled(scheduledRecurringOccurrences(normalized.from, normalized.to), normalized)
  )
}

function summaryOf(normalized: ExpenseListFilter, scheduled: ScheduledOccurrence[]): ExpenseSummary {
  const clauses = expenseFilterClauses(normalized)
  const row = getDatabase()
    .select({
      totalCount: sql<number>`COUNT(*)`,
      linkedMinor: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.orderId} IS NOT NULL AND ${expenses.reversedAt} IS NULL THEN ${expenses.amountMinor} END), 0)`,
      fixedNonSalaryMinor: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.kind} = 'fixed' AND ${expenses.source} != 'salary' AND ${expenses.reversedAt} IS NULL THEN ${expenses.amountMinor} END), 0)`,
      variableMinor: sql<number>`COALESCE(SUM(CASE WHEN ${expenses.kind} = 'variable' AND ${expenses.reversedAt} IS NULL THEN ${expenses.amountMinor} END), 0)`
    })
    .from(expenses)
    .where(clauses.length ? and(...clauses) : undefined)
    .get()
  const scheduledMinor = scheduled.reduce((sum, occurrence) => sum + occurrence.amountMinor, 0)
  return {
    totalCount: (row?.totalCount ?? 0) + scheduled.length,
    linkedMinor: row?.linkedMinor ?? 0,
    fixedNonSalaryMinor: (row?.fixedNonSalaryMinor ?? 0) + scheduledMinor,
    variableMinor: row?.variableMinor ?? 0
  }
}

export function listExpenses(filter: ExpenseListFilter = {}, request: PageRequest = {}) {
  const normalized = normalizeExpenseFilter(filter)
  const clauses = expenseFilterClauses(normalized)
  // DB-15: derived once for both the page and its summary — a scheduled
  // month that nobody has posted yet is shown, never written.
  const scheduled = filterScheduled(
    scheduledRecurringOccurrences(normalized.from, normalized.to),
    normalized
  )
  const page = keysetPage({
    scope: 'expenses.list',
    filters: normalized,
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => getDatabase()
      .select({
        id: expenses.id,
        categoryId: expenses.categoryId,
        categoryName: expenseCategories.name,
        kind: expenses.kind,
        amountMinor: expenses.amountMinor,
        orderId: expenses.orderId,
        description: expenses.description,
        spentAt: expenses.spentAt,
        source: expenses.source,
        cashAccountId: expenses.cashAccountId,
        reversedAt: expenses.reversedAt
      })
      .from(expenses)
      .leftJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
      .where(and(...clauses, keysetBoundary([sql`${expenses.id}`], window)))
      .orderBy(keysetOrder([sql`${expenses.id}`], window))
      .limit(window.take)
      .all(),
    summary: () => summaryOf(normalized, scheduled)
  })
  // Scheduled-but-unposted occurrences belong to the filtered set, not to
  // the posted-row keyset, so they ride on the first page only and never
  // take part in cursor arithmetic.
  if (!request.cursor && scheduled.length) {
    // The endpoint lists newest first; a posted occurrence sorts that way by
    // id, so a derived one is shown by its own period, newest first.
    const newestFirst = [...scheduled].sort((left, right) =>
      right.periodStart.localeCompare(left.periodStart) || right.recurringExpenseId - left.recurringExpenseId
    )
    page.items = [...newestFirst.map(scheduledRow), ...page.items]
  }
  return page
}

/**
 * Presentation shape of a derived occurrence, identical to a posted one
 * except for a stable synthetic negative id: a real `expenses.id` is a
 * positive autoincrement, so the two can never collide, and the UI
 * offers no row action on a recurring occurrence anyway.
 */
function scheduledRow(occurrence: ScheduledOccurrence) {
  const period = Number(occurrence.periodStart.slice(0, 4) + occurrence.periodStart.slice(5, 7))
  return {
    id: -(occurrence.recurringExpenseId * 1_000_000 + period),
    categoryId: occurrence.categoryId,
    categoryName: occurrence.categoryName,
    kind: 'fixed' as const,
    amountMinor: occurrence.amountMinor,
    orderId: null as number | null,
    description: occurrence.description,
    spentAt: occurrence.periodStart,
    source: 'recurring' as const,
    cashAccountId: occurrence.cashAccountId,
    reversedAt: null as string | null
  }
}

/**
 * BR-61/BR-93/BR-94: an expense is Fixed or Variable, uses a
 * user-managed category, and may optionally be linked to an order —
 * in which case it becomes a direct order cost rather than a general
 * operational expense.
 */
/**
 * "مصروف جديد" — the standard New Expense workflow. Always creates a
 * VARIABLE, one-time transaction (item 10/11 of the final spec): a
 * recurring FIXED cost is only ever defined through
 * createRecurringExpense, so this function no longer accepts a `kind`
 * from the caller at all — the client cannot request 'fixed' here even
 * by bypassing the UI, since the field isn't part of the contract.
 */
export function createExpense(
  input: {
    categoryId?: number
    amountMinor: number
    orderId?: number
    /** BL-03: prepares this Uncollected Product for resale. */
    uncollectedProductId?: number
    cashAccountId?: number
    description: string
    spentAt?: string
    requestKey?: string
  },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, PERMISSION_KEYS.expenses.manage)
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')
  if (!input.description?.trim()) throw new AppError('VALIDATION_ERROR', 'وصف المصروف مطلوب')
  if (input.orderId && input.uncollectedProductId)
    throw new AppError('VALIDATION_ERROR', 'المصروف يرتبط بطلب أو بمنتج غير مستلم، وليس بالاثنين')

  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'expenses.create',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        if (input.uncollectedProductId) assertPreparationCostEditable(input.uncollectedProductId)
        const id = Number(
          getDatabase()
            .insert(expenses)
            .values({
              categoryId: input.categoryId ?? null,
              kind: 'variable',
              amountMinor: input.amountMinor,
              orderId: input.orderId ?? null,
              uncollectedProductId: input.uncollectedProductId ?? null,
              cashAccountId: input.cashAccountId ?? null,
              description: input.description,
              spentAt: input.spentAt ?? today(),
              source: 'manual',
              createdBy: ctx.session.user.id,
              createdAt: nowIso()
            })
            .run().lastInsertRowid
        )
        postCashMovement({
          accountId: input.cashAccountId,
          direction: 'out',
          amountMinor: input.amountMinor,
          kind: 'expense',
          refTable: 'expenses',
          refId: id,
          occurredAt: input.spentAt ?? today(),
          ctx
        })
        recordAuditEvent({
          userId: ctx.session.user.id,
          action: 'expenses.create',
          entity: 'expenses',
          entityId: String(id),
          details: input
        })
        return id
      })
  })
}

/**
 * BR-109: salary expenses are created by the payroll path and can
 * never be edited or duplicated by hand — that is what guarantees a
 * salary is counted exactly once in the monthly summary.
 */
export function updateExpense(
  id: number,
  input: {
    categoryId?: number | null
    kind?: 'fixed' | 'variable'
    amountMinor?: number
    cashAccountId?: number | null
    description?: string
    spentAt?: string
    orderId?: number | null
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, PERMISSION_KEYS.expenses.manage)
  const existing = getDatabase().select().from(expenses).where(eq(expenses.id, id)).get()
  if (!existing) throw notFound('المصروف غير موجود')
  if (existing.source === 'salary') {
    throw new AppError('CONFLICT', 'مصروفات الرواتب تُدار من قسم الموظفين ولا يمكن تعديلها هنا')
  }
  if (existing.source === 'recurring') {
    throw new AppError(
      'CONFLICT',
      'هذا مصروف ثابت متكرر يُولَّد تلقائياً — لتغيير المبلغ استخدم "تعديل المبلغ" على المصروف الثابت نفسه، فيسري من الشهر الذي تحدده دون التأثير على الأشهر السابقة'
    )
  }
  if (existing.uncollectedProductId) {
    assertPreparationCostEditable(existing.uncollectedProductId)
    if (input.orderId) throw new AppError('VALIDATION_ERROR', 'المصروف يرتبط بطلب أو بمنتج غير مستلم، وليس بالاثنين')
  }
  const next = {
    categoryId: input.categoryId === undefined ? existing.categoryId : input.categoryId,
    kind: input.kind ?? existing.kind,
    amountMinor: input.amountMinor ?? existing.amountMinor,
    cashAccountId: input.cashAccountId === undefined ? existing.cashAccountId : input.cashAccountId,
    description: input.description ?? existing.description,
    spentAt: input.spentAt ?? existing.spentAt,
    orderId: input.orderId === undefined ? existing.orderId : input.orderId
  }
  requireSafePositiveInteger(next.amountMinor, 'المبلغ')
  if (!next.description.trim()) throw new AppError('VALIDATION_ERROR', 'وصف المصروف مطلوب')

  withTransaction(() => {
    // Manual expenses are a safely-correctable source record. Correct
    // its one paired cash row inside the same transaction so amount,
    // account and date can never diverge or duplicate a cash effect.
    getDatabase().update(expenses).set(next).where(eq(expenses.id, id)).run()
    if (existing.cashAccountId && next.cashAccountId) {
      adjustCashMovementForRef('expenses', id, {
        accountId: next.cashAccountId, amountMinor: next.amountMinor, occurredAt: next.spentAt
      })
    } else if (existing.cashAccountId) {
      removeCashMovementForRef('expenses', id)
    } else postCashMovement({
      accountId: next.cashAccountId,
      direction: 'out',
      amountMinor: next.amountMinor,
      kind: 'expense',
      refTable: 'expenses',
      refId: id,
      occurredAt: next.spentAt,
      ctx
    })
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: `expenses.${existing.kind}.update`,
      entity: 'expenses',
      entityId: String(id),
      details: { before: existing, after: next }
    })
  })
}

/**
 * Ordinary expenses may be deleted here. Salary-generated expenses are
 * read-only in the Expenses UI; a direct/backend request still delegates
 * to the canonical payroll reversal so the two records cannot diverge.
 *
 * An ordinary Fixed/Variable expense is a self-contained record: it and
 * its one paired cash row go together, which by itself restores the
 * account balance and re-derives every total (they are all computed
 * live from these rows).
 *
 * A salary-generated expense is NOT self-contained — deleting the row
 * alone would leave the payroll ledger still claiming the money was
 * paid. So it delegates to the payroll service's own
 * reverseSalaryPayment, which marks the payment/expense reversed and
 * appends the opposite cash movement while preserving deductions. There
 * is exactly one salary-reversal implementation and it is not
 * duplicated here. The employee itself is never touched.
 */
export function deleteExpense(id: number, ctx: ServiceContext): { salaryPaymentReversed: boolean } {
  requirePermission(ctx.session, PERMISSION_KEYS.expenses.manage)
  const existing = getDatabase().select().from(expenses).where(eq(expenses.id, id)).get()
  if (!existing) throw notFound('المصروف غير موجود')

  // Item 24: deleting one month's generated occurrence on its own
  // would just be silently regenerated the next time that month is
  // viewed (ensureRecurringExpensesThrough is idempotent by design) —
  // "stop it" only ever means deactivating/ending the recurring
  // definition, never deleting a single materialized row.
  if (existing.source === 'recurring') {
    throw new AppError(
      'CONFLICT',
      'هذا مصروف ثابت متكرر يُولَّد تلقائياً كل شهر — لإيقافه أوقف (عطّل) المصروف الثابت نفسه بدلاً من حذف شهر واحد بمفرده'
    )
  }

  if (existing.source === 'salary') {
    // Undoing a payroll payment stays a payroll action even when it is
    // reached from Expenses, so it keeps its own permission.
    requirePermission(ctx.session, PERMISSION_KEYS.employees.finance)
    const link = getDatabase().get<{ id: number }>(sql`
      SELECT id FROM employee_transactions
      WHERE kind = 'salary_payment' AND expense_id = ${id}
    `)
    if (!link) {
      throw new AppError(
        'CONFLICT',
        'مصروف الراتب هذا غير مرتبط بحركة صرف راتب، ولا يمكن ضمان استعادة أثره المالي. راجع سجل الموظف'
      )
    }
    return withTransaction(() => {
      // The salary expense stays historically visible with reversed state.
      const reversal = reverseSalaryPayment(link.id, ctx, { origin: 'expenses' })
      recordAuditEvent({
        userId: ctx.session.user.id,
        action: 'expenses.salary.reverse',
        entity: 'expenses',
        entityId: String(id),
        details: {
          auditDescription: `Salary Expense reversal (#${id}) — reversed salary payment #${link.id}`,
          employeeId: reversal.employeeId,
          employeeName: reversal.employeeName,
          amountMinor: reversal.amountMinor,
          netPaidMinor: reversal.netPaidMinor,
          period: `${reversal.periodMonth}/${reversal.periodYear}`
        }
      })
      return { salaryPaymentReversed: true }
    })
  }

  if (existing.uncollectedProductId) assertPreparationCostEditable(existing.uncollectedProductId)
  return withTransaction(() => {
    // Removing the expense and its one paired cash row together restores
    // the account balance exactly, and every daily/period total, the
    // fixed-vs-variable split and net profit are computed live from these
    // rows — so this is itself the recalculation.
    getDatabase().delete(expenses).where(eq(expenses.id, id)).run()
    removeCashMovementForRef('expenses', id)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: `expenses.${existing.kind}.delete`,
      entity: 'expenses',
      entityId: String(id),
      // Auto-generated description — the user is never asked for a reason.
      // `existing` carries the expense's own `description` column, so the
      // audit sentence lives under its own key.
      details: {
        auditDescription:
          existing.kind === 'fixed'
            ? `Fixed Expense deletion (#${id})`
            : `Variable Expense deletion (#${id})`,
        cashReversed: existing.cashAccountId !== null,
        ...existing
      }
    })
    return { salaryPaymentReversed: false }
  })
}
