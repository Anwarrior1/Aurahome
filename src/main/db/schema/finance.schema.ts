import { sqliteTable, integer, text, index, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { orders } from './sales.schema'
import { uncollectedProducts } from './uncollected-products.schema'

/** BR-93/BR-94: user-managed categories, each Fixed or Variable. */
export const expenseCategories = sqliteTable('expense_categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('variable'), // fixed | variable
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

/**
 * BR-61/BR-94: an expense linked to an order is a direct order cost;
 * unlinked it is a general operational expense. `source` marks rows
 * the system generated (a salary payment, BR-109) so they can never
 * be duplicated by hand.
 */
export const expenses = sqliteTable(
  'expenses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    categoryId: integer('category_id').references(() => expenseCategories.id),
    kind: text('kind').notNull(), // fixed | variable
    amountMinor: integer('amount_minor').notNull(),
    orderId: integer('order_id').references(() => orders.id),
    /** BL-03: a cost spent preparing this Uncollected Product for resale. */
    uncollectedProductId: integer('uncollected_product_id').references(() => uncollectedProducts.id),
    cashAccountId: integer('cash_account_id'),
    description: text('description').notNull(),
    spentAt: text('spent_at').notNull(),
    source: text('source').notNull().default('manual'), // manual | salary
    sourceRefId: integer('source_ref_id'),
    reversedAt: text('reversed_at'),
    reversedBy: integer('reversed_by'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    dateIdx: index('expenses_date_idx').on(t.spentAt),
    orderIdx: index('expenses_order_idx').on(t.orderId),
    uncollectedProductIdx: index('expenses_uncollected_product_idx').on(t.uncollectedProductId),
    // Drives both the salary-expense lookup (already existing) and the
    // new recurring-occurrence idempotency check (source='recurring' +
    // sourceRefId + spentAt) — one indexed lookup instead of a scan.
    sourceIdx: index('expenses_source_idx').on(t.source, t.sourceRefId)
  })
)

/**
 * The FIXED/RECURRING EXPENSE DEFINITION (e.g. "إيجار المصنع") — kept
 * deliberately separate from the monthly accounting effect. No amount
 * lives here: the amount in effect for any given month is resolved
 * from recurringExpenseAmounts below, so raising the rent in October
 * can never rewrite what September already cost. The monthly
 * occurrence itself is a normal, frozen row in `expenses`
 * (source='recurring', sourceRefId → this row's id) — there is no
 * second, parallel accounting effect anywhere.
 */
export const recurringExpenses = sqliteTable('recurring_expenses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  categoryId: integer('category_id').references(() => expenseCategories.id),
  description: text('description').notNull(),
  cashAccountId: integer('cash_account_id').references(() => cashAccounts.id),
  /** First month this expense applies from, always day 1 ('YYYY-MM-01'). */
  startDate: text('start_date').notNull(),
  /** Last applicable month (inclusive), or NULL = still ongoing. */
  endDate: text('end_date'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdBy: integer('created_by'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

/**
 * Append-only amount history for one recurring expense (mirrors
 * employee_salary_history) — the amount actually in effect for a
 * given month is resolved as the latest row with
 * effectiveFrom <= that month, so an amount change only ever affects
 * the month it was made effective from onward, never a month already
 * materialized or reported on.
 */
export const recurringExpenseAmounts = sqliteTable(
  'recurring_expense_amounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    recurringExpenseId: integer('recurring_expense_id')
      .notNull()
      .references(() => recurringExpenses.id, { onDelete: 'cascade' }),
    amountMinor: integer('amount_minor').notNull(),
    /** 'YYYY-MM-01' — the first month this amount applies to. */
    effectiveFrom: text('effective_from').notNull(),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    seriesIdx: index('recurring_expense_amounts_series_idx').on(t.recurringExpenseId, t.effectiveFrom)
  })
)

/** BR-114: multiple local cash/bank accounts. Operational only. */
export const cashAccounts = sqliteTable('cash_accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('cash'), // cash | bank
  openingBalanceMinor: integer('opening_balance_minor').notNull().default(0),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

/**
 * Append-only cash ledger. Transfers carry a shared `transferGroup`
 * so the pair can be recognised and excluded from revenue/expense
 * reporting (BR-114) — this is operational cash tracking, not a
 * general ledger.
 */
export const cashTransactions = sqliteTable(
  'cash_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => cashAccounts.id),
    direction: text('direction').notNull(), // in | out
    amountMinor: integer('amount_minor').notNull(),
    kind: text('kind').notNull(),
    refTable: text('ref_table'),
    refId: integer('ref_id'),
    transferGroup: text('transfer_group'),
    /** Exact original movement restored by this append-only reversal. */
    reversalOfId: integer('reversal_of_id').references(
      (): AnySQLiteColumn => cashTransactions.id
    ),
    notes: text('notes'),
    occurredAt: text('occurred_at').notNull(),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    // DB-16: listAccounts groups the ledger by account and only needs these
    // four columns, so keep that synchronous Main-process read index-only.
    accountIdx: index('cash_transactions_account_idx').on(
      t.accountId,
      t.occurredAt,
      t.direction,
      t.amountMinor
    ),
    kindIdx: index('cash_transactions_kind_idx').on(t.kind),
    // DB-13: source-mirror lookups (correction, reversal, reconciliation).
    refIdx: index('cash_transactions_ref_idx').on(t.refTable, t.refId),
    reversalIdx: uniqueIndex('cash_transactions_reversal_of_idx').on(t.reversalOfId)
  })
)

/** BR-96/BR-97: owner draws from calculated net profit. Never an expense. */
export const profitWithdrawals = sqliteTable(
  'profit_withdrawals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    amountMinor: integer('amount_minor').notNull(),
    withdrawnAt: text('withdrawn_at').notNull(),
    person: text('person'),
    notes: text('notes'),
    cashAccountId: integer('cash_account_id').references(() => cashAccounts.id),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ dateIdx: index('profit_withdrawals_date_idx').on(t.withdrawnAt) })
)

/**
 * BR-98/BR-110/BR-111: one confirmed allocation per month, storing
 * the rate actually used so a later rate change never rewrites
 * history. A loss month is simply never allocated.
 */
export const savingsAllocations = sqliteTable(
  'savings_allocations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    periodYear: integer('period_year').notNull(),
    periodMonth: integer('period_month').notNull(),
    netProfitMinor: integer('net_profit_minor').notNull(),
    rateBp: integer('rate_bp').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    confirmedAt: text('confirmed_at').notNull(),
    confirmedBy: integer('confirmed_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ periodIdx: index('savings_allocations_period_idx').on(t.periodYear, t.periodMonth) })
)

/** Append-only fund ledger: allocations in, usages out (BR-99). */
export const savingsTransactions = sqliteTable(
  'savings_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(), // allocation | usage
    amountMinor: integer('amount_minor').notNull(),
    allocationId: integer('allocation_id').references(() => savingsAllocations.id),
    cashAccountId: integer('cash_account_id').references(() => cashAccounts.id),
    notes: text('notes'),
    occurredAt: text('occurred_at').notNull(),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ dateIdx: index('savings_transactions_date_idx').on(t.occurredAt) })
)
