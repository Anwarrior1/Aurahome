import { and, desc, eq, like, sql } from 'drizzle-orm'
import { keysetBoundary, keysetOrder, keysetPage, seekOrder, seekPredicate, type KeysetWindow, type PageRequest, type SeekColumn } from '../base/pagination'
import { PAGE_SIZE } from '@shared/pagination/cursor-page'
import { getDatabase } from '../../db/connection'
import { withTransaction } from '../../db/transactions'
import { employees, employeeSalaryHistory, employeeTransactions } from '../../db/schema/hr.schema'
import { users } from '../../db/schema/users.schema'
import { AppError, notFound } from '../../utils/errors'
import { recordAuditEvent } from '../../audit/audit-log.service'
import { nowIso, today, type ServiceContext } from '../base/service.types'
import {
  postCashMovement,
  adjustCashMovementForRef,
  removeCashMovementForRef
} from '../finance/cash.service'
import { expenses } from '../../db/schema/finance.schema'
import { PERMISSION_KEYS } from '@shared/permissions/permission-keys'
import { requirePermission } from '../../permissions/permission-guard'
import { runOptionalIdempotentFinancialCommand } from '../finance/idempotency.service'
import { requireSafeNonNegativeInteger, requireSafePositiveInteger } from '../../utils/numeric'

/**
 * Which employee_transactions.kind values a user may edit/delete after
 * the fact (Step-4 follow-up, item 7/8). `salary_payment` is a
 * finalized payroll posting tied to a locked Fixed expense (BR-109)
 * and is deliberately excluded — it can never be edited or deleted
 * here, only corrected via a fresh advance/deduction if truly needed.
 */
const EDITABLE_TRANSACTION_KINDS = ['deduction', 'advance', 'repayment'] as const
type EditableTransactionKind = (typeof EDITABLE_TRANSACTION_KINDS)[number]

function assertEditableKind(kind: string): asserts kind is EditableTransactionKind {
  if (!EDITABLE_TRANSACTION_KINDS.includes(kind as EditableTransactionKind)) {
    throw new AppError(
      'FORBIDDEN',
      'هذه حركة راتب نهائية مرتبطة بمصروف مقفل ولا يمكن تعديلها أو حذفها هنا'
    )
  }
}

/** BR-91: salaried employees, never merged with production workers. */
export function listEmployees(filter: { search?: string; activeOnly?: boolean } = {}) {
  const clauses = []
  if (filter.search?.trim()) clauses.push(like(employees.name, `%${filter.search.trim()}%`))
  // This is the current-employees master-data list by default. Historical
  // screens explicitly opt out so a former employee never leaks back into
  // normal payroll work merely because a caller omitted a filter.
  if (filter.activeOnly !== false) clauses.push(eq(employees.active, true))
  const rows = getDatabase()
    .select()
    .from(employees)
    .where(clauses.length ? and(...clauses) : undefined)
    .all()
  return rows.map((employee) => ({ ...employee, balanceMinor: employeeBalance(employee.id) }))
}

/**
 * Total advances issued and total returns/repayments made, optionally
 * excluding one row (used when editing/deleting that very row, to
 * check what the totals would be WITHOUT its current contribution).
 * This is the single source of truth for the outstanding advance
 * figure — it must never include deductions, which are a completely
 * separate salary concept (item 10 of the advance-returns pass).
 */
function totalAdvanceAndRepayment(
  employeeId: number,
  excludeId?: number
): { advances: number; repayments: number } {
  const row = getDatabase().get<{ advances: number; repayments: number }>(sql`
    SELECT
      COALESCE(SUM(CASE WHEN kind = 'advance' THEN amount_minor ELSE 0 END), 0) AS advances,
      COALESCE(SUM(CASE WHEN kind = 'repayment' THEN amount_minor ELSE 0 END), 0) AS repayments
    FROM employee_transactions
    WHERE employee_id = ${employeeId} ${excludeId ? sql`AND id != ${excludeId}` : sql``}
  `)
  return { advances: row?.advances ?? 0, repayments: row?.repayments ?? 0 }
}

/**
 * Outstanding advance balance: total advances issued minus total
 * returns/repayments already made against them (item 6 of the
 * advance-returns pass). This is a PURE advance settlement figure —
 * deductions never affect it.
 *
 * Root-cause note: the previous formula folded deductions into this
 * balance ("advances − repayments − deductions"), which is what
 * produced the reported bug — an employee with only a 200 LYD
 * deduction and NO advance transaction showed an advance balance of
 * -200.00 in the payroll row, while "سجل السلف" (correctly filtering
 * only advance/repayment rows) showed nothing. The deduction record
 * itself was always legitimate; it was simply never an advance and
 * must never be displayed as one.
 */
export function employeeBalance(employeeId: number): number {
  const { advances, repayments } = totalAdvanceAndRepayment(employeeId)
  return advances - repayments
}

/**
 * The former-employee settlement queue. Membership is decided entirely
 * from the persisted employee lifecycle and the authoritative advance
 * ledger; zero-balance former employees never enter this normal queue.
 */
export function listFormerEmployeeSettlements() {
  return getDatabase()
    .select()
    .from(employees)
    .where(eq(employees.active, false))
    .all()
    .map((employee) => ({ ...employee, balanceMinor: employeeBalance(employee.id) }))
    .filter((employee) => employee.balanceMinor > 0)
}

/**
 * A settled former employee is already absent from the outstanding queue.
 * This action dismisses the short UI transition without removing the
 * inactive master/tombstone or any salary, advance, repayment, expense,
 * cash or audit history.
 */
export function dismissFormerEmployeeSettlement(
  id: number,
  ctx: ServiceContext
): {
  removedFromSettlement: true
  historyPreserved: true
} {
  requirePermission(ctx.session, PERMISSION_KEYS.employees.manage)
  return withTransaction(() => {
    const employee = getDatabase().select().from(employees).where(eq(employees.id, id)).get()
    if (!employee) throw notFound('الموظف غير موجود')
    if (employee.active) throw new AppError('CONFLICT', 'الموظف ما زال ضمن قائمة الموظفين الحاليين')
    const outstandingAdvanceMinor = employeeBalance(id)
    if (outstandingAdvanceMinor > 0) {
      throw new AppError('CONFLICT', 'لا يمكن إزالة سجل التسوية قبل سداد السلفة القائمة بالكامل')
    }
    if (outstandingAdvanceMinor < 0) {
      throw new AppError('CONFLICT', 'رصيد السلفة غير متسق ويلزم فحص سجل السلف قبل إزالة التسوية')
    }
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'employees.formerSettlement.dismiss',
      entity: 'employees',
      entityId: String(id),
      details: {
        name: employee.name,
        outstandingAdvanceMinor,
        historyPreserved: true
      }
    })
    return { removedFromSettlement: true, historyPreserved: true }
  })
}

interface PayrollPeriodState {
  employeeId: number
  monthlySalaryMinor: number
  paidMinor: number
  deductionMinor: number
  netEntitlementMinor: number
  remainingSalaryMinor: number
}

/**
 * One authoritative period calculation used by payment validation,
 * deduction validation, the payroll grid and payroll history actions.
 * Advances stay outside this calculation by design.
 *
 * paid_amount_minor is populated by the corrected payment path. For
 * legacy rows, actual cash paid is reconstructed as the old gross
 * amount less only the inline child deduction belonging to that row.
 */
function payrollPeriodState(
  employeeId: number,
  year: number,
  month: number,
  excludeDeductionId?: number
): PayrollPeriodState {
  const row = getDatabase().get<{
    employeeId: number
    monthlySalaryMinor: number
    paidMinor: number
    deductionMinor: number
  }>(sql`
    SELECT e.id AS employeeId,
      COALESCE((
        SELECT h.monthly_salary_minor FROM employee_salary_history h
        WHERE h.employee_id = e.id
          AND h.effective_from <= date(${`${year}-${String(month).padStart(2, '0')}-01`}, '+1 month', '-1 day')
        ORDER BY h.effective_from DESC, h.id DESC LIMIT 1
      ), e.monthly_salary_minor) AS monthlySalaryMinor,
      COALESCE((SELECT SUM(
        CASE
          WHEN t.paid_amount_minor IS NOT NULL THEN t.paid_amount_minor
          ELSE MAX(t.amount_minor - COALESCE((
            SELECT SUM(child.amount_minor)
            FROM employee_transactions child
            WHERE child.parent_transaction_id = t.id
              AND child.kind = 'deduction'
              AND child.reversed_at IS NULL
          ), 0), 0)
        END
      ) FROM employee_transactions t
        WHERE t.employee_id = e.id AND t.kind = 'salary_payment'
          AND t.period_year = ${year} AND t.period_month = ${month}
          AND t.reversed_at IS NULL), 0) AS paidMinor,
      COALESCE((SELECT SUM(t.amount_minor) FROM employee_transactions t
        WHERE t.employee_id = e.id AND t.kind = 'deduction'
          AND t.period_year = ${year} AND t.period_month = ${month}
          AND t.reversed_at IS NULL
          ${excludeDeductionId ? sql`AND t.id != ${excludeDeductionId}` : sql``}), 0) AS deductionMinor
    FROM employees e WHERE e.id = ${employeeId}
  `)
  if (!row) throw notFound('الموظف غير موجود')
  const netEntitlementMinor = row.monthlySalaryMinor - row.deductionMinor
  return {
    ...row,
    netEntitlementMinor,
    remainingSalaryMinor: Math.max(netEntitlementMinor - row.paidMinor, 0)
  }
}

function assertDeductionFitsPeriod(
  employeeId: number,
  year: number,
  month: number,
  amountMinor: number,
  excludeDeductionId?: number
): void {
  const state = payrollPeriodState(employeeId, year, month, excludeDeductionId)
  if (state.paidMinor + state.deductionMinor + amountMinor > state.monthlySalaryMinor) {
    throw new AppError(
      'CONFLICT',
      'لا يمكن حفظ الخصم لأن الرواتب المصروفة ستتجاوز صافي استحقاق هذه الفترة'
    )
  }
}

export function createEmployee(
  input: {
    name: string
    position?: string
    phone?: string
    monthlySalaryMinor: number
    hiredAt?: string
    notes?: string
  },
  ctx: ServiceContext
): number {
  requireSafeNonNegativeInteger(input.monthlySalaryMinor, 'الراتب الشهري')
  requirePermission(ctx.session, PERMISSION_KEYS.employees.manage)
  return withTransaction(() => {
    const id = Number(
      getDatabase()
        .insert(employees)
        .values({
          name: input.name,
          position: input.position ?? null,
          phone: input.phone ?? null,
          monthlySalaryMinor: input.monthlySalaryMinor,
          hiredAt: input.hiredAt ?? today(),
          notes: input.notes ?? null,
          createdAt: nowIso()
        })
        .run().lastInsertRowid
    )
    getDatabase()
      .insert(employeeSalaryHistory)
      .values({
        employeeId: id,
        monthlySalaryMinor: input.monthlySalaryMinor,
        effectiveFrom: input.hiredAt ?? today(),
        createdBy: ctx.session.user.id,
        createdAt: nowIso()
      })
      .run()
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'employees.create',
      entity: 'employees',
      entityId: String(id),
      details: { name: input.name }
    })
    return id
  })
}

/** BR-92: a salary change is recorded historically, never overwritten. */
export function updateEmployee(
  id: number,
  input: {
    name?: string
    position?: string
    phone?: string
    monthlySalaryMinor?: number
    notes?: string
    effectiveFrom?: string
  },
  ctx: ServiceContext
): void {
  if (input.monthlySalaryMinor !== undefined) {
    requireSafeNonNegativeInteger(input.monthlySalaryMinor, 'الراتب الشهري')
  }
  requirePermission(ctx.session, PERMISSION_KEYS.employees.manage)
  // Defence in depth for direct service calls: lifecycle state is not an
  // editable employee field, even if an untyped caller injects it.
  if (Object.prototype.hasOwnProperty.call(input, 'active')) {
    throw new AppError(
      'FORBIDDEN',
      'لا يمكن تغيير حالة الموظف من التعديل العام؛ استخدم إجراء حذف الموظف'
    )
  }
  const existing = getDatabase().select().from(employees).where(eq(employees.id, id)).get()
  if (!existing) throw notFound('الموظف غير موجود')
  if (
    !existing.active &&
    input.monthlySalaryMinor !== undefined &&
    input.monthlySalaryMinor !== existing.monthlySalaryMinor
  ) {
    throw new AppError('CONFLICT', 'لا يمكن إنشاء استحقاق راتب جديد لموظف سابق')
  }

  withTransaction(() => {
    getDatabase()
      .update(employees)
      .set({
        name: input.name ?? existing.name,
        position: input.position ?? existing.position,
        phone: input.phone ?? existing.phone,
        monthlySalaryMinor: input.monthlySalaryMinor ?? existing.monthlySalaryMinor,
        notes: input.notes ?? existing.notes
      })
      .where(eq(employees.id, id))
      .run()

    if (
      input.monthlySalaryMinor !== undefined &&
      input.monthlySalaryMinor !== existing.monthlySalaryMinor
    ) {
      getDatabase()
        .insert(employeeSalaryHistory)
        .values({
          employeeId: id,
          monthlySalaryMinor: input.monthlySalaryMinor,
          effectiveFrom: input.effectiveFrom ?? today(),
          createdBy: ctx.session.user.id,
          createdAt: nowIso()
        })
        .run()
    }

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'employees.update',
      entity: 'employees',
      entityId: String(id),
      details: input
    })
  })
}

export interface EmployeeRemovalResult {
  removedFromCurrent: true
  physicallyDeleted: boolean
  historyPreserved: boolean
}

/**
 * The one production employee-removal lifecycle.
 *
 * A completely unreferenced employee is physically removed. Once any real
 * business/financial record exists, the stable employee id is retained and
 * only `active` changes to false. No expense, cash, payroll, advance,
 * repayment, salary-history or audit row is reversed or deleted.
 */
export function deleteEmployee(
  input: { id: number; confirmation: string },
  ctx: ServiceContext
): EmployeeRemovalResult {
  requirePermission(ctx.session, PERMISSION_KEYS.employees.manage)

  return withTransaction(() => {
    const existing = getDatabase().select().from(employees).where(eq(employees.id, input.id)).get()
    if (!existing) throw notFound('الموظف غير موجود')
    if (!existing.active)
      throw new AppError('CONFLICT', 'تم حذف الموظف من قائمة الموظفين الحاليين بالفعل')
    if (input.confirmation.trim() !== existing.name.trim()) {
      throw new AppError('VALIDATION_ERROR', `اكتب اسم الموظف "${existing.name}" لتأكيد حذف الموظف`)
    }

    const preview = employeeDeletePreview(input.id)
    const physicallyDeleted = !preview.hasBusinessHistory
    if (physicallyDeleted) {
      // Salary history is owned by the employee master and is the only row
      // created automatically at hiring. The preview has already proved that
      // no external business record references this employee.
      getDatabase()
        .delete(employeeSalaryHistory)
        .where(eq(employeeSalaryHistory.employeeId, input.id))
        .run()
      getDatabase().delete(employees).where(eq(employees.id, input.id)).run()
    } else {
      getDatabase().update(employees).set({ active: false }).where(eq(employees.id, input.id)).run()
    }

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'employees.remove',
      entity: 'employees',
      entityId: String(input.id),
      details: {
        description: `Employee removed from current employment (${existing.name} #${input.id})`,
        name: existing.name,
        physicallyDeleted,
        historyPreserved: !physicallyDeleted,
        dependencies: preview.dependencies
      }
    })
    return {
      removedFromCurrent: true,
      physicallyDeleted,
      historyPreserved: !physicallyDeleted
    }
  })
}

export interface SalaryPaymentReversal {
  transactionId: number
  employeeId: number
  employeeName: string
  amountMinor: number
  netPaidMinor: number
  deductionMinor: number
  periodYear: number | null
  periodMonth: number | null
  expenseId: number | null
  cashRows: number
  childRows: number
  reversedAt: string | null
  blockers: string[]
}

/**
 * Describes, without mutating anything, what undoing one salary payment
 * would involve. `expenseId` is the Fixed salary expense the payment
 * created (BR-109), `cashRows` the paired net cash-out, and `childRows`
 * the inline deduction the payment itself recorded.
 */
export function salaryPaymentReversalPreview(
  transactionId: number,
  options: { allowReversedForHardDelete?: boolean } = {}
): SalaryPaymentReversal {
  const row = getDatabase()
    .select()
    .from(employeeTransactions)
    .where(eq(employeeTransactions.id, transactionId))
    .get()
  if (!row) throw notFound('حركة الراتب غير موجودة')
  if (row.kind !== 'salary_payment') {
    throw new AppError('VALIDATION_ERROR', 'هذه الحركة ليست حركة صرف راتب')
  }
  if (row.reversedAt && !options.allowReversedForHardDelete) {
    throw new AppError('CONFLICT', 'تم عكس صرف الراتب هذا بالفعل')
  }
  const employee = getDatabase()
    .select()
    .from(employees)
    .where(eq(employees.id, row.employeeId))
    .get()
  const count = (query: ReturnType<typeof sql>): number =>
    getDatabase().get<{ c: number }>(query)?.c ?? 0

  const children = getDatabase()
    .select()
    .from(employeeTransactions)
    .where(eq(employeeTransactions.parentTransactionId, transactionId))
    .all()
  const deductionMinor = children
    .filter((child) => child.kind === 'deduction')
    .reduce((sum, child) => sum + child.amountMinor, 0)
  const cashRows = count(sql`
    SELECT COUNT(*) AS c FROM cash_transactions
    WHERE ref_table = 'employee_transactions' AND ref_id = ${transactionId}
      AND reversal_of_id IS NULL
  `)

  const blockers: string[] = []
  if (!row.expenseId) {
    blockers.push('حركة صرف الراتب غير مرتبطة بمصروف راتب، ولا يمكن ضمان عكس أثرها المالي')
  } else {
    const expense = getDatabase().get<{
      source: string
      orderId: number | null
      reversedAt: string | null
    }>(sql`
      SELECT source, order_id AS orderId, reversed_at AS reversedAt FROM expenses WHERE id = ${row.expenseId}
    `)
    if (!expense) {
      blockers.push(
        'مصروف الراتب المرتبط بهذه الحركة غير موجود، ولا يمكن ضمان استعادة الأثر المالي'
      )
    } else if (expense.source !== 'salary') {
      blockers.push('المصروف المرتبط بحركة الراتب ليس مصروف راتب، ولا يمكن عكسه من هنا')
    } else if (expense.reversedAt && !row.reversedAt) {
      blockers.push('مصروف الراتب المرتبط معكوس بالفعل بينما حركة الراتب ما زالت نشطة')
    } else if (expense.orderId !== null) {
      blockers.push('مصروف الراتب محمّل على طلب عميل ولا يمكن سحبه دون تغيير تكلفة ذلك الطلب')
    }
  }
  if (
    count(sql`
    SELECT COUNT(*) AS c FROM cash_transactions
    WHERE transfer_group IS NOT NULL
      AND ref_table = 'employee_transactions' AND ref_id = ${transactionId}
  `) > 0
  ) {
    blockers.push('الحركة النقدية المرتبطة جزء من تحويل بين حسابات ولا يمكن عكسها من هنا')
  }
  // A child that is itself referenced by cash would be reversed twice.
  for (const child of children) {
    if (
      count(sql`
      SELECT COUNT(*) AS c FROM cash_transactions
      WHERE ref_table = 'employee_transactions' AND ref_id = ${child.id}
    `) > 0
    ) {
      blockers.push(
        `الحركة المرتبطة #${child.id} تحمل أثراً نقدياً مستقلاً ولا يمكن عكسها ضمن هذه العملية`
      )
    }
  }

  return {
    transactionId,
    employeeId: row.employeeId,
    employeeName: employee?.name ?? '',
    amountMinor: row.amountMinor,
    netPaidMinor: row.paidAmountMinor ?? Math.max(row.amountMinor - deductionMinor, 0),
    deductionMinor,
    periodYear: row.periodYear,
    periodMonth: row.periodMonth,
    expenseId: row.expenseId,
    cashRows,
    childRows: children.length,
    reversedAt: row.reversedAt,
    blockers: [...new Set(blockers)]
  }
}

/**
 * Reverses ONE salary payment without erasing history: the payment and
 * linked expense are marked reversed and an opposite cash movement is
 * appended. All deductions, advances and salary history stay untouched.
 *
 * MUST be called inside an open transaction: the Expenses screen
 * (Part 4) and the Employees screen both reach the same money through
 * this one function, so there is exactly one salary-reversal path in
 * the ERP and no possibility of a duplicate reversal.
 *
 * `hardDelete` exists only for the separately authorized whole-record
 * deletion workflows; the normal payroll/expense reversal never uses it.
 */
export function reverseSalaryPayment(
  transactionId: number,
  ctx: ServiceContext,
  options: { hardDelete?: boolean; origin?: string } = {}
): SalaryPaymentReversal {
  requirePermission(ctx.session, PERMISSION_KEYS.employees.finance)
  return withTransaction(() => {
    const preview = salaryPaymentReversalPreview(transactionId, {
      allowReversedForHardDelete: options.hardDelete
    })
    if (preview.blockers.length) {
      throw new AppError(
        'CONFLICT',
        `تعذر عكس صرف الراتب لأن استعادة أثره المالي بالكامل غير مضمونة: ${preview.blockers.join('، ')}`
      )
    }

    const db = getDatabase()
    if (options.hardDelete) {
      db.delete(employeeTransactions)
        .where(eq(employeeTransactions.parentTransactionId, transactionId))
        .run()
      db.delete(employeeTransactions).where(eq(employeeTransactions.id, transactionId)).run()
      removeCashMovementForRef('employee_transactions', transactionId)
      if (preview.expenseId) {
        db.run(sql`DELETE FROM expenses WHERE id = ${preview.expenseId}`)
        removeCashMovementForRef('expenses', preview.expenseId)
      }
    } else {
      const reversedAt = nowIso()
      db.update(employeeTransactions)
        .set({ reversedAt, reversedBy: ctx.session.user.id })
        .where(eq(employeeTransactions.id, transactionId))
        .run()
      const originalCashRows = db.all<{
        id: number
        accountId: number
        direction: 'in' | 'out'
        amountMinor: number
        occurredAt: string
      }>(sql`
        SELECT id, account_id AS accountId, direction, amount_minor AS amountMinor,
          occurred_at AS occurredAt
        FROM cash_transactions
        WHERE ref_table = 'employee_transactions' AND ref_id = ${transactionId}
          AND reversal_of_id IS NULL
        ORDER BY id
      `)
      for (const movement of originalCashRows) {
        postCashMovement({
          accountId: movement.accountId,
          direction: movement.direction === 'out' ? 'in' : 'out',
          amountMinor: movement.amountMinor,
          kind: 'salary_reversal',
          refTable: 'employee_transactions',
          refId: transactionId,
          reversalOfId: movement.id,
          notes: `عكس صرف راتب #${transactionId}`,
          occurredAt: reversedAt,
          ctx
        })
      }
      if (preview.expenseId) {
        db.run(sql`
          UPDATE expenses SET reversed_at = ${reversedAt}, reversed_by = ${ctx.session.user.id}
          WHERE id = ${preview.expenseId} AND reversed_at IS NULL
        `)
      }
    }

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'employees.salary_payment.reverse',
      entity: 'employee_transactions',
      entityId: String(transactionId),
      details: {
        description: `Salary payment reversal (${preview.employeeName} #${preview.employeeId}, ${preview.periodMonth}/${preview.periodYear})`,
        origin: options.origin ?? 'employees',
        hardDelete: options.hardDelete ?? false,
        amountMinor: preview.amountMinor,
        netPaidMinor: preview.netPaidMinor,
        deductionMinor: preview.deductionMinor,
        expenseId: preview.expenseId,
        cashRowsReversed: preview.cashRows,
        inlineDeductionsPreserved: options.hardDelete ? 0 : preview.childRows
      }
    })
    return preview
  })
}

export interface EmployeeDeletePreview {
  employeeId: number
  name: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
  /** True when normal removal must retain the stable employee row. */
  hasBusinessHistory: boolean
  /** Legacy internal full-delete preview signal; not exposed as normal UX. */
  requiresFullDelete: boolean
}

/**
 * Everything that actually links to an employee, discovered from the
 * live schema rather than assumed.
 *
 * The salaried-employee graph is deliberately narrow in this ERP:
 * production workers are a separate table (BR-91/BR-84), so an employee
 * is never attached to a production order, a worker-cost posting or an
 * order's actual cost. What does link to them is:
 *   employee_salary_history, employee_transactions (salary_payment /
 *   advance / repayment / deduction), the one Fixed `expenses` row each
 *   salary payment creates (BR-109), and the cash_transactions those
 *   postings paired with. Payroll totals, advance balances, cash
 *   balances, net profit and every report are computed live from those
 *   rows, so removing them is itself the recalculation.
 */
export function employeeDeletePreview(id: number): EmployeeDeletePreview {
  const existing = getDatabase().select().from(employees).where(eq(employees.id, id)).get()
  if (!existing) throw notFound('الموظف غير موجود')
  const count = (query: ReturnType<typeof sql>): number =>
    getDatabase().get<{ c: number }>(query)?.c ?? 0

  const dependencies: Array<{ key: string; label: string; count: number }> = []
  const push = (key: string, label: string, value: number): void => {
    if (value > 0) dependencies.push({ key, label, count: value })
  }
  const byKind = (kind: string): number =>
    count(
      sql`SELECT COUNT(*) AS c FROM employee_transactions WHERE employee_id = ${id} AND kind = ${kind}`
    )

  push('salaryPayments', 'رواتب مدفوعة', byKind('salary_payment'))
  push('advances', 'سلف', byKind('advance'))
  push('repayments', 'مرتجعات سلف', byKind('repayment'))
  push('deductions', 'استقطاعات', byKind('deduction'))
  push(
    'salaryExpenses',
    'مصروفات رواتب مسجّلة',
    count(sql`
    SELECT COUNT(*) AS c FROM expenses WHERE source = 'salary' AND source_ref_id = ${id}
  `)
  )
  push(
    'cashMovements',
    'حركات نقدية مرتبطة',
    count(sql`
    SELECT COUNT(*) AS c FROM cash_transactions
    WHERE ref_table = 'employee_transactions'
      AND ref_id IN (SELECT id FROM employee_transactions WHERE employee_id = ${id})
  `)
  )
  // Everything above is real history. The first salary-history row is
  // created with the employee master and carries no activity by itself;
  // any later salary-history row is a genuine historical salary change.
  const linkedRecords = dependencies.reduce((sum, item) => sum + item.count, 0)
  const salaryHistoryCount = count(sql`
    SELECT COUNT(*) AS c FROM employee_salary_history WHERE employee_id = ${id}
  `)
  push('salaryHistory', 'سجل تغيّر الراتب', salaryHistoryCount)
  // One initial salary row is owned by the master itself and is created for
  // every employee. Additional rows are genuine salary-change history and
  // therefore require retaining the stable employee id.
  const hasBusinessHistory = linkedRecords > 0 || salaryHistoryCount > 1

  const blockers: string[] = []
  if (hasBusinessHistory) {
    blockers.push(
      'للموظف سجل رواتب أو تسويات مُرحّل؛ استخدم حذف الموظف العادي لإزالته من القوائم الحالية مع إبقاء تاريخه'
    )
  }
  // A salary expense posted against a customer order would be part of
  // that order's actual cost; unwinding it here would silently change
  // an unrelated order's profit.
  if (
    count(sql`
    SELECT COUNT(*) AS c FROM expenses
    WHERE source = 'salary' AND source_ref_id = ${id} AND order_id IS NOT NULL
  `) > 0
  ) {
    blockers.push(
      'توجد مصروفات رواتب محمّلة على طلبات عملاء ولا يمكن سحبها دون تغيير تكلفة تلك الطلبات'
    )
  }
  // A cash row that belongs to a transfer pair cannot be removed alone
  // without unbalancing the other account (BR-114).
  if (
    count(sql`
    SELECT COUNT(*) AS c FROM cash_transactions
    WHERE transfer_group IS NOT NULL
      AND ((ref_table = 'employee_transactions'
            AND ref_id IN (SELECT id FROM employee_transactions WHERE employee_id = ${id}))
        OR (ref_table = 'expenses'
            AND ref_id IN (SELECT id FROM expenses WHERE source = 'salary' AND source_ref_id = ${id})))
  `) > 0
  ) {
    blockers.push('توجد حركة نقدية مرتبطة بتحويل بين حسابات ولا يمكن عكسها من هنا')
  }
  // Every salary_payment must still point at its own salary expense,
  // and that expense must still be the salary-sourced one — otherwise
  // the money cannot be restored exactly.
  if (
    count(sql`
    SELECT COUNT(*) AS c FROM employee_transactions t
    WHERE t.employee_id = ${id} AND t.kind = 'salary_payment'
      AND (t.expense_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM expenses e WHERE e.id = t.expense_id AND e.source = 'salary'
      ))
  `) > 0
  ) {
    blockers.push(
      'توجد حركة راتب لا ترتبط بمصروف الراتب الخاص بها، ولا يمكن ضمان استعادة أثرها المالي'
    )
  }

  return {
    employeeId: id,
    name: existing.name,
    dependencies,
    blockers: [...new Set(blockers)],
    hasBusinessHistory,
    requiresFullDelete: hasBusinessHistory
  }
}

/**
 * Level-3 delete is retained for compatibility but can remove only a pristine
 * employee master. Any payroll, settlement or salary-change history adds a
 * blocker; the normal deleteEmployee lifecycle archives that employee.
 *
 * The unwinding order mirrors how the money was posted, so the reversal
 * is exact and nothing is restored twice: the paired cash rows go first
 * (an advance's cash-out, a return's cash-in and a salary's net cash-out
 * each disappear with the posting that created them — a repayment is
 * never "given back" on top of the advance it settled), then the Fixed
 * salary expense rows that carried the payroll cost into net profit,
 * then the ledger itself, the salary history and finally the employee.
 * The append-only audit_log is never touched (item 32).
 */
export function fullDeleteEmployee(
  input: { id: number; confirmation: string },
  ctx: ServiceContext
): { removed: true; summary: Record<string, number> } {
  requirePermission(ctx.session, PERMISSION_KEYS.employees.fullDelete)
  const preview = employeeDeletePreview(input.id)

  if (input.confirmation.trim() !== preview.name.trim()) {
    throw new AppError('VALIDATION_ERROR', `اكتب اسم الموظف "${preview.name}" لتأكيد الحذف النهائي`)
  }
  if (preview.blockers.length) {
    throw new AppError(
      'CONFLICT',
      `تعذر الحذف النهائي للموظف لأن استعادة أثره المالي بالكامل غير مضمونة: ${preview.blockers.join('، ')}. استخدم حذف الموظف العادي لإزالته من القائمة الحالية مع بقاء سجله كما هو`
    )
  }

  const summary = Object.fromEntries(
    preview.dependencies.map((item) => [item.key, item.count])
  ) as Record<string, number>

  return withTransaction(() => {
    const db = getDatabase()
    db.run(sql`
      DELETE FROM cash_transactions
      WHERE ref_table = 'employee_transactions'
        AND ref_id IN (SELECT id FROM employee_transactions WHERE employee_id = ${input.id})
    `)
    db.run(sql`
      DELETE FROM cash_transactions
      WHERE ref_table = 'expenses'
        AND ref_id IN (SELECT id FROM expenses WHERE source = 'salary' AND source_ref_id = ${input.id})
    `)
    db.run(sql`
      DELETE FROM expenses
      WHERE (source = 'salary' AND source_ref_id = ${input.id})
         OR id IN (SELECT expense_id FROM employee_transactions
                   WHERE employee_id = ${input.id} AND expense_id IS NOT NULL)
    `)
    db.delete(employeeTransactions).where(eq(employeeTransactions.employeeId, input.id)).run()
    db.delete(employeeSalaryHistory).where(eq(employeeSalaryHistory.employeeId, input.id)).run()
    db.delete(employees).where(eq(employees.id, input.id)).run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'employees.full_delete',
      entity: 'employees',
      entityId: String(input.id),
      details: {
        fullDelete: true,
        description: `Full Employee deletion (${preview.name} #${input.id})`,
        name: preview.name,
        summary
      }
    })
    return { removed: true, summary }
  })
}

export function salaryHistory(employeeId: number) {
  return getDatabase()
    .select()
    .from(employeeSalaryHistory)
    .where(eq(employeeSalaryHistory.employeeId, employeeId))
    .orderBy(desc(employeeSalaryHistory.id))
    .all()
}

/**
 * BR-109: paying a salary posts EXACTLY ONE Fixed operating expense
 * for the month, created here and locked against manual editing —
 * the same money can never be counted twice.
 */
function createSalaryExpense(
  input: { amountMinor: number; description: string; spentAt: string; cashAccountId?: number; sourceRefId: number },
  ctx: ServiceContext
): number {
  return Number(getDatabase().insert(expenses).values({
    categoryId: null, kind: 'fixed', amountMinor: input.amountMinor, orderId: null,
    cashAccountId: input.cashAccountId ?? null, description: input.description,
    spentAt: input.spentAt, source: 'salary', sourceRefId: input.sourceRefId,
    createdBy: ctx.session.user.id, createdAt: nowIso()
  }).run().lastInsertRowid)
}

export function paySalary(
  input: {
    employeeId: number
    amountMinor: number
    periodYear: number
    periodMonth: number
    deductionMinor?: number
    cashAccountId?: number
    paidAt?: string
    notes?: string
    requestKey?: string
  },
  ctx: ServiceContext
): { transactionId: number; expenseId: number; netPaidMinor: number } {
  requirePermission(ctx.session, PERMISSION_KEYS.employees.finance)
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')

  const deduction = input.deductionMinor ?? 0
  requireSafeNonNegativeInteger(deduction, 'قيمة الخصم')
  if (deduction < 0 || deduction > input.amountMinor) {
    throw new AppError('VALIDATION_ERROR', 'قيمة الخصم غير صحيحة')
  }

  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'employees.paySalary',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        const employee = getDatabase()
          .select()
          .from(employees)
          .where(eq(employees.id, input.employeeId))
          .get()
        if (!employee) throw notFound('الموظف غير موجود')
        if (!employee.active) {
          throw new AppError('CONFLICT', 'لا يمكن صرف راتب جديد لموظف سابق')
        }
        const before = payrollPeriodState(input.employeeId, input.periodYear, input.periodMonth)
        if (before.remainingSalaryMinor <= 0) {
          throw new AppError('CONFLICT', 'لا يوجد راتب متبقٍ قابل للصرف لهذه الفترة')
        }
        // amountMinor remains the gross portion being settled for API and
        // legacy compatibility. The actual payment is that portion less
        // only the optional inline deduction created by this same call.
        if (input.amountMinor > before.remainingSalaryMinor) {
          throw new AppError('CONFLICT', 'مبلغ الصرف يتجاوز الراتب المتبقي لهذه الفترة')
        }
        const paidAt = input.paidAt ?? today()
        const netPaidMinor = input.amountMinor - deduction
        if (netPaidMinor <= 0) {
          throw new AppError(
            'VALIDATION_ERROR',
            'لا يمكن إنشاء حركة صرف راتب بمبلغ فعلي يساوي صفراً'
          )
        }

        // The generated expense is exactly the amount actually paid.
        const expenseId = createSalaryExpense(
          {
            amountMinor: netPaidMinor,
            description: `راتب ${employee.name} - ${input.periodMonth}/${input.periodYear}`,
            spentAt: paidAt,
            cashAccountId: input.cashAccountId,
            sourceRefId: input.employeeId
          },
          ctx
        )

        const transactionId = Number(
          getDatabase()
            .insert(employeeTransactions)
            .values({
              employeeId: input.employeeId,
              kind: 'salary_payment',
              amountMinor: input.amountMinor,
              paidAmountMinor: netPaidMinor,
              periodYear: input.periodYear,
              periodMonth: input.periodMonth,
              cashAccountId: input.cashAccountId ?? null,
              expenseId,
              notes: input.notes ?? null,
              createdBy: ctx.session.user.id,
              createdAt: nowIso()
            })
            .run().lastInsertRowid
        )

        if (deduction > 0) {
          getDatabase()
            .insert(employeeTransactions)
            .values({
              employeeId: input.employeeId,
              kind: 'deduction',
              amountMinor: deduction,
              periodYear: input.periodYear,
              periodMonth: input.periodMonth,
              // Belongs to this payment, not to the employee in general: if
              // the payment is ever reversed this deduction goes with it,
              // so re-paying the month can never apply it a second time.
              parentTransactionId: transactionId,
              notes: 'خصم من الراتب',
              createdBy: ctx.session.user.id,
              createdAt: nowIso()
            })
            .run()
        }

        // Cash out is the NET amount actually handed over.
        if (netPaidMinor > 0) {
          postCashMovement({
            accountId: input.cashAccountId,
            direction: 'out',
            amountMinor: netPaidMinor,
            kind: 'salary',
            refTable: 'employee_transactions',
            refId: transactionId,
            occurredAt: paidAt,
            ctx
          })
        }

        recordAuditEvent({
          userId: ctx.session.user.id,
          action: 'employees.paySalary',
          entity: 'employee_transactions',
          entityId: String(transactionId),
          details: {
            ...input,
            expenseId,
            netPaidMinor,
            authoritativeRemainingBeforeMinor: before.remainingSalaryMinor,
            authoritativeRemainingAfterMinor: before.remainingSalaryMinor - input.amountMinor
          }
        })

        return { transactionId, expenseId, netPaidMinor }
      })
  })
}

/**
 * Advances, repayments and standalone deductions (BR-92). A deduction
 * is always tied to the specific payroll month/year it reduces
 * (item 3/4 of the Step-4 follow-up) — completely independent of
 * `paySalary`'s own optional inline deduction field, and independent
 * of advances (item 5: the two must never be combined or affect one
 * another's totals).
 */
export function recordEmployeeTransaction(
  input: {
    employeeId: number
    kind: 'advance' | 'repayment' | 'deduction'
    amountMinor: number
    cashAccountId?: number
    notes?: string
    occurredAt?: string
    periodYear?: number
    periodMonth?: number
    requestKey?: string
  },
  ctx: ServiceContext
): number {
  requirePermission(ctx.session, PERMISSION_KEYS.employees.finance)
  requireSafePositiveInteger(input.amountMinor, 'المبلغ')

  const { requestKey, ...payload } = input
  return runOptionalIdempotentFinancialCommand({
    commandScope: 'employees.transaction',
    requestKey,
    payload,
    ctx,
    execute: () =>
      withTransaction(() => {
        const employee = getDatabase()
          .select()
          .from(employees)
          .where(eq(employees.id, input.employeeId))
          .get()
        if (!employee) throw notFound('الموظف غير موجود')

        // A former employee may close an advance already on their ledger, but
        // can never acquire a new salary deduction or advance. Repayment is
        // attributable to the existing employee advance ledger and is bounded
        // by its current outstanding amount below.
        if (!employee.active && input.kind !== 'repayment') {
          const operation = input.kind === 'advance' ? 'سلفة جديدة' : 'خصم جديد'
          throw new AppError('CONFLICT', `لا يمكن تسجيل ${operation} لموظف سابق`)
        }

        if (input.kind === 'deduction' && (!input.periodYear || !input.periodMonth)) {
          throw new AppError('VALIDATION_ERROR', 'يجب تحديد شهر وسنة الراتب المتأثر بالخصم')
        }
        if (input.kind === 'deduction') {
          assertDeductionFitsPeriod(
            input.employeeId,
            input.periodYear!,
            input.periodMonth!,
            input.amountMinor
          )
        }

        if (input.kind === 'repayment') {
          const outstanding = employeeBalance(input.employeeId)
          if (outstanding <= 0) {
            throw new AppError('VALIDATION_ERROR', 'لا توجد سلفة قائمة على هذا الموظف لتسجيل مرتجع')
          }
          if (input.amountMinor > outstanding) {
            throw new AppError('VALIDATION_ERROR', 'مبلغ المرتجع أكبر من السلفة القائمة على الموظف')
          }
        }

        const id = Number(
          getDatabase()
            .insert(employeeTransactions)
            .values({
              employeeId: input.employeeId,
              kind: input.kind,
              amountMinor: input.amountMinor,
              periodYear: input.kind === 'deduction' ? input.periodYear : null,
              periodMonth: input.kind === 'deduction' ? input.periodMonth : null,
              cashAccountId: input.cashAccountId ?? null,
              notes: input.notes ?? null,
              createdBy: ctx.session.user.id,
              createdAt: input.occurredAt ?? nowIso()
            })
            .run().lastInsertRowid
        )

        // An advance is a settlement movement, not an expense (BR-109).
        // A deduction posts no cash movement of its own — it only reduces
        // the salary payable when that month's salary is later paid.
        if (input.kind === 'advance') {
          postCashMovement({
            accountId: input.cashAccountId,
            direction: 'out',
            amountMinor: input.amountMinor,
            kind: 'employee_advance',
            refTable: 'employee_transactions',
            refId: id,
            occurredAt: input.occurredAt ?? today(),
            ctx
          })
        } else if (input.kind === 'repayment') {
          postCashMovement({
            accountId: input.cashAccountId,
            direction: 'in',
            amountMinor: input.amountMinor,
            kind: 'employee_repayment',
            refTable: 'employee_transactions',
            refId: id,
            occurredAt: input.occurredAt ?? today(),
            ctx
          })
        }

        recordAuditEvent({
          userId: ctx.session.user.id,
          action: `employees.${input.kind}`,
          entity: 'employee_transactions',
          entityId: String(id),
          details: input
        })
        return id
      })
  })
}

/**
 * Edit a deduction/advance/repayment (item 7). The affected payroll
 * month, deduction totals and advance balance are never stored
 * separately — they are always computed live from this table (see
 * monthlyPayroll/employeeBalance) — so correcting the row here is by
 * itself enough to leave no stale totals anywhere.
 */
export function updateEmployeeTransaction(
  id: number,
  input: {
    amountMinor?: number
    notes?: string
    occurredAt?: string
    cashAccountId?: number
    periodYear?: number
    periodMonth?: number
  },
  ctx: ServiceContext
): void {
  requirePermission(ctx.session, PERMISSION_KEYS.employees.finance)
  const existing = getDatabase()
    .select()
    .from(employeeTransactions)
    .where(eq(employeeTransactions.id, id))
    .get()
  if (!existing) throw notFound('الحركة غير موجودة')
  assertEditableKind(existing.kind)

  if (input.amountMinor !== undefined) requireSafePositiveInteger(input.amountMinor, 'المبلغ')
  if (existing.kind === 'deduction') {
    const year = input.periodYear ?? existing.periodYear
    const month = input.periodMonth ?? existing.periodMonth
    if (!year || !month) {
      throw new AppError('VALIDATION_ERROR', 'يجب تحديد شهر وسنة الراتب المتأثر بالخصم')
    }
    if (
      input.amountMinor !== undefined ||
      input.periodYear !== undefined ||
      input.periodMonth !== undefined
    ) {
      assertDeductionFitsPeriod(
        existing.employeeId,
        year,
        month,
        input.amountMinor ?? existing.amountMinor,
        id
      )
    }
  }

  // Item 4/8: an edit to an advance or a return must never leave the
  // outstanding balance negative — e.g. lowering an advance below
  // returns already recorded against it, or raising a return above
  // the advance it settles.
  if (
    (existing.kind === 'advance' || existing.kind === 'repayment') &&
    input.amountMinor !== undefined &&
    input.amountMinor !== existing.amountMinor
  ) {
    const { advances, repayments } = totalAdvanceAndRepayment(existing.employeeId, id)
    const newAdvances = advances + (existing.kind === 'advance' ? input.amountMinor : 0)
    const newRepayments = repayments + (existing.kind === 'repayment' ? input.amountMinor : 0)
    if (newAdvances - newRepayments < 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'لا يمكن أن يتجاوز إجمالي مرتجعات السلف إجمالي السلف المسجّلة لهذا الموظف'
      )
    }
  }

  withTransaction(() => {
    const hasMirror = assertEmployeeCashLink(existing)
    const nextAccountId = input.cashAccountId ?? existing.cashAccountId
    getDatabase()
      .update(employeeTransactions)
      .set({
        amountMinor: input.amountMinor ?? existing.amountMinor,
        notes: input.notes ?? existing.notes,
        createdAt: input.occurredAt ?? existing.createdAt,
        cashAccountId: nextAccountId,
        periodYear:
          existing.kind === 'deduction'
            ? (input.periodYear ?? existing.periodYear)
            : existing.periodYear,
        periodMonth:
          existing.kind === 'deduction'
            ? (input.periodMonth ?? existing.periodMonth)
            : existing.periodMonth
      })
      .where(eq(employeeTransactions.id, id))
      .run()

    // Advances/repayments carry a real cash movement — correct it in
    // lock-step so account balances (computed live via SUM) stay
    // accurate. Deductions never post a cash movement.
    if (hasMirror) {
      adjustCashMovementForRef('employee_transactions', id, {
        amountMinor: input.amountMinor,
        accountId: input.cashAccountId,
        occurredAt: input.occurredAt
      })
    } else if (existing.kind !== 'deduction' && nextAccountId) {
      // Recorded without an account, now assigned one: post its first mirror.
      postCashMovement({
        accountId: nextAccountId,
        direction: existing.kind === 'advance' ? 'out' : 'in',
        amountMinor: input.amountMinor ?? existing.amountMinor,
        kind: existing.kind === 'advance' ? 'employee_advance' : 'employee_repayment',
        refTable: 'employee_transactions',
        refId: id,
        occurredAt: input.occurredAt ?? existing.createdAt,
        ctx
      })
    }

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: `employees.${existing.kind}.update`,
      entity: 'employee_transactions',
      entityId: String(id),
      details: { before: existing, changes: input }
    })
  })
}

/**
 * DB-12: an advance/repayment has exactly one cash mirror when it names an
 * account and none otherwise; a deduction never has one. Returns whether the
 * mirror exists. Contradictory history fails closed instead of drifting further.
 */
function assertEmployeeCashLink(row: typeof employeeTransactions.$inferSelect): boolean {
  const mirrors = getDatabase().all<{ accountId: number; direction: string; amountMinor: number }>(sql`
    SELECT account_id AS accountId, direction, amount_minor AS amountMinor FROM cash_transactions
    WHERE ref_table = 'employee_transactions' AND ref_id = ${row.id}
  `)
  const cashKind = row.kind === 'advance' || row.kind === 'repayment'
  const valid =
    !cashKind || !row.cashAccountId
      ? mirrors.length === 0
      : mirrors.length === 1 &&
        mirrors[0]!.accountId === row.cashAccountId &&
        mirrors[0]!.direction === (row.kind === 'advance' ? 'out' : 'in') &&
        mirrors[0]!.amountMinor === row.amountMinor
  if (!valid) {
    throw new AppError('CONFLICT', 'لا يمكن تصحيح الحركة لأن رابط حركتها النقدية غير مكتمل أو مكرر')
  }
  return mirrors.length === 1
}

/** Delete a deduction/advance/repayment (item 7) — the same live-computed
 *  totals guarantee applies as in updateEmployeeTransaction above. */
export function deleteEmployeeTransaction(id: number, ctx: ServiceContext): void {
  requirePermission(ctx.session, PERMISSION_KEYS.employees.finance)
  const existing = getDatabase()
    .select()
    .from(employeeTransactions)
    .where(eq(employeeTransactions.id, id))
    .get()
  if (!existing) throw notFound('الحركة غير موجودة')
  assertEditableKind(existing.kind)

  // Item 4/8: deleting an advance that returns were already recorded
  // against would leave a negative outstanding balance — refused.
  // Deleting a return is always safe: it can only raise the balance.
  if (existing.kind === 'advance') {
    const { advances, repayments } = totalAdvanceAndRepayment(existing.employeeId, id)
    if (advances - repayments < 0) {
      throw new AppError(
        'CONFLICT',
        'لا يمكن حذف هذه السلفة لوجود مرتجعات مسجّلة عليها تتجاوز باقي السلف — عدّل أو احذف المرتجعات المرتبطة أولاً'
      )
    }
  }

  withTransaction(() => {
    const hasMirror = assertEmployeeCashLink(existing)
    getDatabase().delete(employeeTransactions).where(eq(employeeTransactions.id, id)).run()
    if (hasMirror) removeCashMovementForRef('employee_transactions', id)
    recordAuditEvent({
      userId: ctx.session.user.id,
      action: `employees.${existing.kind}.delete`,
      entity: 'employee_transactions',
      entityId: String(id),
      details: existing
    })
  })
}

/** سجل الخصومات — every deduction across all employees (item 6). */
export function listDeductions(
  filter: { employeeId?: number; year?: number; month?: number } = {},
  request: PageRequest = {}
) {
  const clauses = [eq(employeeTransactions.kind, 'deduction')]
  if (filter.employeeId) clauses.push(eq(employeeTransactions.employeeId, filter.employeeId))
  if (filter.year) clauses.push(eq(employeeTransactions.periodYear, filter.year))
  if (filter.month) clauses.push(eq(employeeTransactions.periodMonth, filter.month))
  return keysetPage({
    scope: 'employees.listDeductions',
    filters: { employeeId: filter.employeeId, year: filter.year, month: filter.month },
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => getDatabase()
      .select({
        id: employeeTransactions.id,
        employeeId: employeeTransactions.employeeId,
        employeeName: employees.name,
        amountMinor: employeeTransactions.amountMinor,
        periodYear: employeeTransactions.periodYear,
        periodMonth: employeeTransactions.periodMonth,
        notes: employeeTransactions.notes,
        createdAt: employeeTransactions.createdAt
      })
      .from(employeeTransactions)
      .innerJoin(employees, eq(employeeTransactions.employeeId, employees.id))
      .where(and(...clauses, keysetBoundary([sql`${employeeTransactions.id}`], window)))
      .orderBy(keysetOrder([sql`${employeeTransactions.id}`], window))
      .limit(window.take)
      .all(),
    summary: () => undefined
  })
}

export interface SalaryPaymentHistoryRow {
  id: number
  employeeId: number
  employeeName: string
  amountMinor: number
  periodYear: number
  periodMonth: number
  paidAt: string
  cashAccountId: number | null
  cashAccountName: string | null
  expenseId: number | null
  status: 'posted' | 'reversed'
  reversedAt: string | null
  createdByName: string | null
  reversedByName: string | null
}

/**
 * Removes an already-reversed payment from the visible payroll history only.
 * The payment, expense, cash reversal and append-only audit trail remain intact.
 */
export function deleteSalaryPaymentFromHistory(
  transactionId: number,
  ctx: ServiceContext
): { ok: true } {
  requirePermission(ctx.session, PERMISSION_KEYS.employees.finance)
  return withTransaction(() => {
    const db = getDatabase()
    const payment = db
      .select({
        id: employeeTransactions.id,
        employeeId: employeeTransactions.employeeId,
        employeeName: employees.name,
        kind: employeeTransactions.kind,
        amountMinor: employeeTransactions.amountMinor,
        paidAmountMinor: employeeTransactions.paidAmountMinor,
        periodYear: employeeTransactions.periodYear,
        periodMonth: employeeTransactions.periodMonth,
        expenseId: employeeTransactions.expenseId,
        reversedAt: employeeTransactions.reversedAt,
        historyHiddenAt: employeeTransactions.historyHiddenAt
      })
      .from(employeeTransactions)
      .innerJoin(employees, eq(employees.id, employeeTransactions.employeeId))
      .where(eq(employeeTransactions.id, transactionId))
      .get()
    if (!payment || payment.kind !== 'salary_payment') throw notFound('سجل صرف الراتب غير موجود')
    if (!payment.reversedAt) {
      throw new AppError('CONFLICT', 'لا يمكن حذف صرف راتب نشط من السجل؛ يجب عكسه أولاً')
    }
    if (payment.historyHiddenAt) {
      throw new AppError('CONFLICT', 'تم حذف صرف الراتب من السجل بالفعل')
    }

    const hiddenAt = nowIso()
    db.update(employeeTransactions)
      .set({ historyHiddenAt: hiddenAt, historyHiddenBy: ctx.session.user.id })
      .where(
        and(
          eq(employeeTransactions.id, transactionId),
          sql`${employeeTransactions.reversedAt} IS NOT NULL`,
          sql`${employeeTransactions.historyHiddenAt} IS NULL`
        )
      )
      .run()

    recordAuditEvent({
      userId: ctx.session.user.id,
      action: 'employees.salary_payment.history_hide',
      entity: 'employee_transactions',
      entityId: String(transactionId),
      details: {
        description: `Salary payment hidden from payroll history (${payment.employeeName} #${payment.employeeId}, ${payment.periodMonth}/${payment.periodYear})`,
        amountMinor: payment.paidAmountMinor ?? payment.amountMinor,
        expenseId: payment.expenseId,
        reversedAt: payment.reversedAt,
        financialEffect: false
      }
    })
    return { ok: true }
  })
}

/** Bounded, newest-first payroll payment history for the Employees page. */
export function listSalaryPayments(
  filter: {
    employeeId?: number
    year?: number
    month?: number
  } = {},
  request: PageRequest = {}
) {
  const normalized = { employeeId: filter.employeeId, year: filter.year, month: filter.month }
  const columns: SeekColumn[] = [[sql`t.created_at`, 'desc'], [sql`t.id`, 'desc']]
  return keysetPage({
    scope: 'employees.listSalaryPayments',
    filters: normalized,
    request,
    keyTypes: ['text', 'int'],
    order: 'desc',
    keyOf: (row) => [row.createdAt, row.id],
    fetch: (window: KeysetWindow) => getDatabase().all<SalaryPaymentHistoryRow & { createdAt: string }>(sql`
      SELECT t.id, t.employee_id AS employeeId, e.name AS employeeName,
        CASE
          WHEN t.paid_amount_minor IS NOT NULL THEN t.paid_amount_minor
          ELSE MAX(t.amount_minor - COALESCE((
            SELECT SUM(child.amount_minor) FROM employee_transactions child
            WHERE child.parent_transaction_id = t.id
              AND child.kind = 'deduction' AND child.reversed_at IS NULL
          ), 0), 0)
        END AS amountMinor,
        t.period_year AS periodYear, t.period_month AS periodMonth,
        COALESCE(x.spent_at, t.created_at) AS paidAt,
        t.cash_account_id AS cashAccountId, a.name AS cashAccountName,
        t.expense_id AS expenseId,
        CASE WHEN t.reversed_at IS NULL THEN 'posted' ELSE 'reversed' END AS status,
        t.reversed_at AS reversedAt,
        creator.full_name AS createdByName,
        reverser.full_name AS reversedByName,
        t.created_at AS createdAt
      FROM employee_transactions t
      INNER JOIN employees e ON e.id = t.employee_id
      LEFT JOIN expenses x ON x.id = t.expense_id
      LEFT JOIN cash_accounts a ON a.id = t.cash_account_id
      LEFT JOIN users creator ON creator.id = t.created_by
      LEFT JOIN users reverser ON reverser.id = t.reversed_by
      WHERE t.kind = 'salary_payment'
        AND t.history_hidden_at IS NULL
        ${normalized.employeeId ? sql`AND t.employee_id = ${normalized.employeeId}` : sql``}
        ${normalized.year ? sql`AND t.period_year = ${normalized.year}` : sql``}
        ${normalized.month ? sql`AND t.period_month = ${normalized.month}` : sql``}
        ${window.after ? sql`AND ${seekPredicate(columns, window)}` : sql``}
      ORDER BY ${seekOrder(columns, window)}
      LIMIT ${window.take}
    `),
    summary: () => undefined
  })
}

/**
 * سجل السلف — every advance/return across all employees (items 2/7 of
 * the advance-returns pass: الموظف/النوع/المبلغ/التاريخ/الشهر-السنة/
 * الملاحظات/المستخدم are all sourced from this one authoritative
 * query, the same query the outstanding balance above is derived
 * from — so the two can never disagree the way they did before the
 * fix (item 1's bug).
 */
export function listAdvances(filter: { employeeId?: number } = {}, request: PageRequest = {}) {
  const clauses = [sql`${employeeTransactions.kind} IN ('advance', 'repayment')`]
  if (filter.employeeId) clauses.push(eq(employeeTransactions.employeeId, filter.employeeId))
  return keysetPage({
    scope: 'employees.listAdvances',
    filters: { employeeId: filter.employeeId },
    request,
    keyTypes: ['int'],
    order: 'desc',
    keyOf: (row) => [row.id],
    fetch: (window: KeysetWindow) => getDatabase()
      .select({
        id: employeeTransactions.id,
        employeeId: employeeTransactions.employeeId,
        employeeName: employees.name,
        kind: employeeTransactions.kind,
        amountMinor: employeeTransactions.amountMinor,
        periodYear: employeeTransactions.periodYear,
        periodMonth: employeeTransactions.periodMonth,
        notes: employeeTransactions.notes,
        createdAt: employeeTransactions.createdAt,
        recordedByName: users.fullName
      })
      .from(employeeTransactions)
      .innerJoin(employees, eq(employeeTransactions.employeeId, employees.id))
      .leftJoin(users, eq(employeeTransactions.createdBy, users.id))
      .where(and(...clauses, keysetBoundary([sql`${employeeTransactions.id}`], window)))
      .orderBy(keysetOrder([sql`${employeeTransactions.id}`], window))
      .limit(window.take)
      .all(),
    summary: () => undefined
  })
}

export function employeeStatement(employeeId: number, request: PageRequest = {}) {
  const employee = getDatabase().select().from(employees).where(eq(employees.id, employeeId)).get()
  if (!employee) throw notFound('الموظف غير موجود')
  return {
    employee,
    balanceMinor: employeeBalance(employeeId),
    salaryHistory: salaryHistory(employeeId),
    transactions: keysetPage({
      scope: 'employees.statement.transactions',
      filters: { employeeId },
      request,
      defaultLimit: PAGE_SIZE.statement,
      keyTypes: ['int'],
      order: 'desc',
      keyOf: (row) => [row.id],
      fetch: (window: KeysetWindow) => getDatabase()
        .select()
        .from(employeeTransactions)
        .where(and(eq(employeeTransactions.employeeId, employeeId), keysetBoundary([sql`${employeeTransactions.id}`], window)))
        .orderBy(keysetOrder([sql`${employeeTransactions.id}`], window))
        .limit(window.take)
        .all(),
      summary: () => undefined
    })
  }
}

/**
 * Authoritative payroll projection. Current employees are always present.
 * Former employees are present only when the selected period has an actual
 * salary-payment or deduction ledger row, so present-day lifecycle state
 * cannot erase a historical month and inactive masters are not blindly
 * copied into every period.
 */
function payrollForPeriod(year: number, month: number, currentOnly: boolean) {
  const periodStart = `${year}-${String(month).padStart(2, '0')}-01`
  const rows = getDatabase().all<{
    employeeId: number
    name: string
    monthlySalaryMinor: number
    paidMinor: number
    deductionMinor: number
    advanceMinor: number
  }>(sql`
    SELECT e.id AS employeeId, e.name,
      COALESCE((
        SELECT h.monthly_salary_minor FROM employee_salary_history h
        WHERE h.employee_id = e.id
          AND h.effective_from <= date(${periodStart}, '+1 month', '-1 day')
        ORDER BY h.effective_from DESC, h.id DESC LIMIT 1
      ), e.monthly_salary_minor) AS monthlySalaryMinor,
      COALESCE((SELECT SUM(
        CASE
          WHEN t.paid_amount_minor IS NOT NULL THEN t.paid_amount_minor
          ELSE MAX(t.amount_minor - COALESCE((
            SELECT SUM(child.amount_minor) FROM employee_transactions child
            WHERE child.parent_transaction_id = t.id
              AND child.kind = 'deduction' AND child.reversed_at IS NULL
          ), 0), 0)
        END
      ) FROM employee_transactions t
        WHERE t.employee_id = e.id AND t.kind = 'salary_payment'
          AND t.period_year = ${year} AND t.period_month = ${month}
          AND t.reversed_at IS NULL), 0) AS paidMinor,
      COALESCE((SELECT SUM(amount_minor) FROM employee_transactions t
        WHERE t.employee_id = e.id AND t.kind = 'deduction'
          AND t.period_year = ${year} AND t.period_month = ${month}
          AND t.reversed_at IS NULL), 0) AS deductionMinor,
      COALESCE((SELECT SUM(amount_minor) FROM employee_transactions t
        WHERE t.employee_id = e.id AND t.kind = 'advance'), 0)
      - COALESCE((SELECT SUM(amount_minor) FROM employee_transactions t
        WHERE t.employee_id = e.id AND t.kind = 'repayment'), 0) AS advanceMinor
    FROM employees e
    WHERE e.active = 1
      ${
        currentOnly
          ? sql``
          : sql`
        OR EXISTS (
          SELECT 1 FROM employee_transactions period_tx
          WHERE period_tx.employee_id = e.id
            AND period_tx.kind IN ('salary_payment', 'deduction')
            AND period_tx.period_year = ${year}
            AND period_tx.period_month = ${month}
        )
      `
      }
    ORDER BY e.name
  `)
  return rows.map((row) => ({
    ...row,
    // الراتب المتبقي: monthly salary − discounts − amount already paid this
    // month. Advances are deliberately excluded — they are a running,
    // independent settlement balance (employeeBalance), never mixed into
    // a specific month's salary arithmetic.
    remainingSalaryMinor: Math.max(row.monthlySalaryMinor - row.deductionMinor - row.paidMinor, 0),
    status:
      row.monthlySalaryMinor - row.deductionMinor - row.paidMinor <= 0
        ? ('paid' as const)
        : row.paidMinor > 0
          ? ('partial' as const)
          : ('unpaid' as const)
  }))
}

/** Historical/reporting semantics for the selected period. */
export function monthlyPayroll(year: number, month: number) {
  return payrollForPeriod(year, month, false)
}

/** Current payroll working-list semantics: active employees only. */
export function currentMonthlyPayroll(year: number, month: number) {
  return payrollForPeriod(year, month, true)
}
