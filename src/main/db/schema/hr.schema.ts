import { sqliteTable, integer, text, index, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/** BR-91: salaried employees — never merged with production workers. */
export const employees = sqliteTable('employees', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  position: text('position'),
  phone: text('phone'),
  monthlySalaryMinor: integer('monthly_salary_minor').notNull().default(0),
  hiredAt: text('hired_at'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

/** Historical record of salary changes (BR-92). */
export const employeeSalaryHistory = sqliteTable(
  'employee_salary_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    monthlySalaryMinor: integer('monthly_salary_minor').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({ employeeIdx: index('employee_salary_history_employee_idx').on(t.employeeId) })
)

/**
 * Append-only employee ledger (BR-92/BR-109). A salary_payment row
 * also creates exactly one Fixed expense row — never two — so the
 * same money can't be counted twice in the monthly summary.
 */
export const employeeTransactions = sqliteTable(
  'employee_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    employeeId: integer('employee_id')
      .notNull()
      .references(() => employees.id),
    kind: text('kind').notNull(), // salary_payment | advance | deduction | repayment
    amountMinor: integer('amount_minor').notNull(),
    /**
     * Actual cash salary paid. Legacy salary rows stored the gross
     * settled amount in amountMinor and represented an inline deduction
     * as a child row; NULL keeps those rows distinguishable so reads can
     * derive their actual paid amount without rewriting history.
     */
    paidAmountMinor: integer('paid_amount_minor'),
    periodYear: integer('period_year'),
    periodMonth: integer('period_month'),
    cashAccountId: integer('cash_account_id'),
    expenseId: integer('expense_id'),
    /**
     * The salary payment that produced this row. paySalary can create a
     * `deduction` alongside its `salary_payment`; that child exists only
     * because of the payment and must be undone with it, while a
     * standalone deduction recorded from the Employees screen has no
     * parent and always survives on its own. Legacy rows are NULL and
     * are therefore treated as standalone — never removed implicitly.
     */
    parentTransactionId: integer('parent_transaction_id').references(
      (): AnySQLiteColumn => employeeTransactions.id
    ),
    reversedAt: text('reversed_at'),
    reversedBy: integer('reversed_by'),
    /**
     * A reversed payment may be removed from the Employees-page history
     * without deleting its financial or audit evidence.
     */
    historyHiddenAt: text('history_hidden_at'),
    historyHiddenBy: integer('history_hidden_by'),
    notes: text('notes'),
    createdBy: integer('created_by'),
    createdAt: text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (t) => ({
    employeeIdx: index('employee_transactions_employee_idx').on(t.employeeId, t.createdAt),
    parentIdx: index('employee_transactions_parent_idx').on(t.parentTransactionId)
  })
)
