import { sql } from 'drizzle-orm'
import { getDatabase } from '../../db/connection'
import { formatMoney, money } from '@shared/money/money'
import { formatQuantity, quantity } from '@shared/quantity/quantity'
import { materialValuation } from '../inventory/valuation.service'
import { orderProfitabilityReport } from '../costing/costing.service'
import { monthlyProfitSummary } from '../finance/profit.service'
import { scheduledRecurringOccurrences } from '../finance/expenses.service'
import { customerBalances, supplierBalances } from '../parties/parties.service'
import { monthlyPayroll } from '../hr/employees.service'
import type { ReportDTO } from '../../reports/dto/report.dto'
import type { AuthSession } from '@shared/types/user.types'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { hasPermission } from '../../permissions/permission-guard'
import { AppError, forbidden } from '../../utils/errors'
import { dayStart, dayEnd } from '../base/service.types'
import { businessDate } from '@shared/business-date'

const m = (minor: number): string => formatMoney(money(minor))
const q = (micro: number, unit?: string): string => formatQuantity(quantity(micro), unit)

export type ReportKey =
  | 'sales'
  | 'orders'
  | 'customer_balances'
  | 'supplier_balances'
  | 'purchases'
  | 'inventory'
  | 'inventory_valuation'
  | 'material_consumption'
  | 'waste'
  | 'expenses'
  | 'order_costs'
  | 'order_profitability'
  | 'monthly_profit'
  | 'cancelled_orders'
  | 'worker_balances'
  | 'payroll'

export interface ReportRequest {
  key: ReportKey
  from?: string
  to?: string
  year?: number
  month?: number
}

function canAccessReport(session: AuthSession, key: ReportKey): boolean {
  const can = (permission: string): boolean => hasPermission(session, permission)
  switch (key) {
    case 'sales':
    case 'orders':
    case 'cancelled_orders': return can(P.orders.view)
    case 'customer_balances': return can(P.customers.view)
    case 'supplier_balances': return can(P.suppliers.view)
    case 'purchases': return can(P.purchases.view)
    case 'inventory': return can(P.inventory.view)
    case 'inventory_valuation':
    case 'material_consumption':
    case 'waste': return can(P.inventory.valuation)
    case 'expenses': return can(P.expenses.view)
    case 'order_costs': return can(P.orders.viewActualCost)
    case 'order_profitability':
      return can(P.orders.viewActualCost) && can(P.orders.viewActualProfit)
    case 'monthly_profit': return can(P.profit.view)
    case 'worker_balances': return can(P.workers.finance)
    case 'payroll': return can(P.employees.finance)
  }
}

export function availableReportsForSession(session: AuthSession) {
  return AVAILABLE_REPORTS.filter((report) => canAccessReport(session, report.key))
}

export function buildAuthorizedReport(request: ReportRequest, session: AuthSession) {
  if (!canAccessReport(session, request.key)) throw forbidden()
  return buildReport(request)
}

/** BR-25/BR-48/BR-100: the confirmed operational report set. */
export function buildReport(request: ReportRequest): ReportDTO<Record<string, string>> {
  const from = request.from ?? '1900-01-01'
  const to = request.to ?? '2999-12-31'
  // Periods are factory-local calendar days (the renderer's date inputs).
  if (![from, to].every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) {
    throw new AppError('VALIDATION_ERROR', 'فترة التقرير يجب أن تكون تاريخاً بصيغة YYYY-MM-DD')
  }
  const period = { from, to }

  switch (request.key) {
    case 'sales': {
      const rows = getDatabase().all<{
        documentNumber: string
        customerName: string
        createdAt: string
        totalMinor: number
        paidMinor: number
        status: string
      }>(sql`
        SELECT o.document_number AS documentNumber, c.name AS customerName,
               o.created_at AS createdAt, o.total_minor AS totalMinor,
               o.paid_minor AS paidMinor, o.status
        FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.status != 'cancelled' AND o.created_at >= ${dayStart(from)} AND o.created_at <= ${dayEnd(to)}
        ORDER BY o.id DESC
      `)
      return {
        title: 'تقرير المبيعات',
        period,
        columns: ['رقم الطلب', 'العميل', 'التاريخ', 'الإجمالي', 'المدفوع', 'الحالة'],
        rows: rows.map((row) => ({
          'رقم الطلب': row.documentNumber,
          العميل: row.customerName,
          التاريخ: businessDate(new Date(row.createdAt)),
          الإجمالي: m(row.totalMinor),
          المدفوع: m(row.paidMinor),
          الحالة: statusLabel(row.status)
        })),
        totals: {
          'إجمالي المبيعات': m(rows.reduce((sum, row) => sum + row.totalMinor, 0)),
          'إجمالي المحصل': m(rows.reduce((sum, row) => sum + row.paidMinor, 0))
        }
      }
    }

    case 'orders':
    case 'cancelled_orders': {
      const cancelled = request.key === 'cancelled_orders'
      const rows = getDatabase().all<{
        documentNumber: string
        customerName: string
        createdAt: string
        totalMinor: number
        paidMinor: number
        status: string
        cancelReason: string | null
      }>(sql`
        SELECT o.document_number AS documentNumber, c.name AS customerName,
               o.created_at AS createdAt, o.total_minor AS totalMinor,
               o.paid_minor AS paidMinor, o.status, o.cancel_reason AS cancelReason
        FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE ${cancelled ? sql`o.status = 'cancelled'` : sql`1 = 1`}
          AND o.created_at >= ${dayStart(from)} AND o.created_at <= ${dayEnd(to)}
        ORDER BY o.id DESC
      `)
      return {
        title: cancelled ? 'تقرير الطلبات الملغاة' : 'تقرير طلبات العملاء',
        period,
        columns: cancelled
          ? ['رقم الطلب', 'العميل', 'التاريخ', 'الإجمالي', 'المحصل (غير مسترد)', 'سبب الإلغاء']
          : ['رقم الطلب', 'العميل', 'التاريخ', 'الإجمالي', 'المدفوع', 'الحالة'],
        rows: rows.map((row): Record<string, string> =>
          cancelled
            ? {
                'رقم الطلب': row.documentNumber,
                العميل: row.customerName,
                التاريخ: businessDate(new Date(row.createdAt)),
                الإجمالي: m(row.totalMinor),
                'المحصل (غير مسترد)': m(row.paidMinor),
                'سبب الإلغاء': row.cancelReason ?? ''
              }
            : {
                'رقم الطلب': row.documentNumber,
                العميل: row.customerName,
                التاريخ: businessDate(new Date(row.createdAt)),
                الإجمالي: m(row.totalMinor),
                المدفوع: m(row.paidMinor),
                الحالة: statusLabel(row.status)
              }
        ),
        totals: {
          'عدد الطلبات': String(rows.length),
          الإجمالي: m(rows.reduce((sum, row) => sum + row.totalMinor, 0))
        }
      }
    }

    case 'customer_balances': {
      const rows = customerBalances()
      return {
        title: 'أرصدة ومديونية العملاء',
        columns: ['العميل', 'الهاتف', 'عدد الطلبات', 'الإجمالي', 'المدفوع', 'المتبقي'],
        rows: rows.map((row) => ({
          العميل: row.name,
          الهاتف: row.phone ?? '',
          'عدد الطلبات': String(row.orderCount),
          الإجمالي: m(row.totalMinor),
          المدفوع: m(row.paidMinor),
          المتبقي: m(row.remainingMinor)
        })),
        totals: { 'إجمالي المديونية': m(rows.reduce((sum, row) => sum + row.remainingMinor, 0)) }
      }
    }

    case 'supplier_balances': {
      const rows = supplierBalances()
      return {
        title: 'أرصدة ومديونية الموردين',
        columns: ['المورد', 'إجمالي المشتريات', 'المدفوع', 'المتبقي'],
        rows: rows.map((row) => ({
          المورد: row.name,
          'إجمالي المشتريات': m(row.purchasedMinor),
          المدفوع: m(row.paidMinor),
          المتبقي: m(row.remainingMinor)
        })),
        totals: { 'إجمالي المستحق للموردين': m(rows.reduce((sum, row) => sum + row.remainingMinor, 0)) }
      }
    }

    case 'purchases': {
      const rows = getDatabase().all<{
        documentNumber: string
        supplierName: string
        purchaseDate: string
        totalMinor: number
        paidMinor: number
      }>(sql`
        SELECT p.document_number AS documentNumber, s.name AS supplierName,
               p.purchase_date AS purchaseDate, p.total_minor AS totalMinor, p.paid_minor AS paidMinor
        FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.purchase_date BETWEEN ${from} AND ${to}
        ORDER BY p.id DESC
      `)
      return {
        title: 'تقرير المشتريات',
        period,
        columns: ['رقم الفاتورة', 'المورد', 'التاريخ', 'الإجمالي', 'المدفوع'],
        rows: rows.map((row) => ({
          'رقم الفاتورة': row.documentNumber,
          المورد: row.supplierName,
          التاريخ: row.purchaseDate,
          الإجمالي: m(row.totalMinor),
          المدفوع: m(row.paidMinor)
        })),
        totals: { 'إجمالي المشتريات': m(rows.reduce((sum, row) => sum + row.totalMinor, 0)) }
      }
    }

    case 'inventory': {
      const valuation = materialValuation()
      return {
        title: 'تقرير المخزون',
        columns: ['الكود', 'المادة', 'التصنيف', 'الكمية'],
        rows: valuation.materials.map((row) => ({
          الكود: row.sku,
          المادة: row.name,
          التصنيف: row.categoryName,
          الكمية: q(row.qtyMicro, row.unit)
        })),
        totals: { 'عدد المواد': String(valuation.materials.length) }
      }
    }

    case 'inventory_valuation': {
      const valuation = materialValuation()
      return {
        title: 'تقييم رأس مال المخزون',
        columns: ['الكود', 'المادة', 'التصنيف', 'الكمية', 'قيمة التكلفة الفعلية', 'القيمة السوقية الحالية'],
        rows: valuation.materials.map((row) => ({
          الكود: row.sku,
          المادة: row.name,
          التصنيف: row.categoryName,
          الكمية: q(row.qtyMicro, row.unit),
          'قيمة التكلفة الفعلية': m(row.fifoValueMinor),
          'القيمة السوقية الحالية': m(row.marketValueMinor)
        })),
        totals: {
          'إجمالي قيمة التكلفة الفعلية': m(valuation.totals.fifoValueMinor),
          'إجمالي القيمة السوقية الحالية': m(valuation.totals.marketValueMinor)
        }
      }
    }

    case 'material_consumption': {
      const nextStart = new Date(new Date(dayEnd(to)).getTime() + 1).toISOString()
      // Two candidate days cover UTC/space, business dates and offsets up to 14 hours.
      // Retain the kind/date index; only the CASE below decides period membership.
      const rows = getDatabase().all<{
        name: string
        unit: string
        qtyMicro: number
        costMinor: number
      }>(sql`
        WITH report_period AS (SELECT ${dayStart(from)} AS start_at, ${nextStart} AS next_at)
        SELECT mat.name, mat.unit,
               SUM(CASE WHEN mv.kind IN ('consumption_reversal', 'material_return') THEN -mv.qty_micro ELSE mv.qty_micro END) AS qtyMicro,
               SUM(mv.actual_cost_minor) AS costMinor
        FROM report_period p CROSS JOIN inventory_movements mv JOIN materials mat ON mat.id = mv.material_id
        WHERE mv.kind IN ('consumption', 'consumption_reversal', 'sale', 'material_return', 'material_return_reversal')
          AND mv.created_at >= date(p.start_at, '-2 days') AND mv.created_at < date(p.next_at, '+2 days')
          AND CASE
            WHEN mv.created_at GLOB '????-??-??' THEN
              date(mv.created_at) = mv.created_at
              AND mv.created_at >= date(p.start_at, 'localtime')
              AND mv.created_at < date(p.next_at, 'localtime')
            WHEN mv.created_at GLOB '????-??-??[T ]*' THEN
              julianday(mv.created_at) >= julianday(p.start_at)
              AND julianday(mv.created_at) < julianday(p.next_at)
            ELSE 0
          END
        GROUP BY mat.id ORDER BY costMinor DESC
      `)
      return {
        title: 'تقرير استهلاك المواد',
        period,
        columns: ['المادة', 'الكمية المستهلكة فعلياً', 'التكلفة الفعلية'],
        rows: rows.map((row) => ({
          المادة: row.name,
          'الكمية المستهلكة فعلياً': q(row.qtyMicro, row.unit),
          'التكلفة الفعلية': m(row.costMinor)
        })),
        totals: { 'إجمالي تكلفة الاستهلاك': m(rows.reduce((sum, row) => sum + row.costMinor, 0)) }
      }
    }

    case 'waste': {
      const nextStart = new Date(new Date(dayEnd(to)).getTime() + 1).toISOString()
      // Candidate days retain index filtering for UTC/space, business dates and offsets.
      // The representation-aware CASE alone decides historical membership.
      const rows = getDatabase().all<{
        name: string
        unit: string
        qtyMicro: number
        costMinor: number
        reason: string | null
        createdAt: string
      }>(sql`
        WITH report_period AS (SELECT ${dayStart(from)} AS start_at, ${nextStart} AS next_at)
        SELECT mat.name, mat.unit, mv.qty_micro AS qtyMicro,
               mv.actual_cost_minor AS costMinor, mv.reason, mv.created_at AS createdAt
        FROM report_period p CROSS JOIN inventory_movements mv JOIN materials mat ON mat.id = mv.material_id
        WHERE mv.kind = 'waste'
          AND mv.created_at >= date(p.start_at, '-2 days') AND mv.created_at < date(p.next_at, '+2 days')
          AND CASE
            WHEN mv.created_at GLOB '????-??-??' THEN
              date(mv.created_at) = mv.created_at
              AND mv.created_at >= date(p.start_at, 'localtime')
              AND mv.created_at < date(p.next_at, 'localtime')
            WHEN mv.created_at GLOB '????-??-??[T ]*' THEN
              julianday(mv.created_at) >= julianday(p.start_at)
              AND julianday(mv.created_at) < julianday(p.next_at)
            ELSE 0
          END
        ORDER BY mv.id DESC
      `)
      return {
        title: 'تقرير الهالك',
        period,
        columns: ['التاريخ', 'المادة', 'الكمية', 'التكلفة', 'السبب'],
        rows: rows.map((row) => ({
          التاريخ: businessDate(new Date(row.createdAt)),
          المادة: row.name,
          الكمية: q(row.qtyMicro, row.unit),
          التكلفة: m(row.costMinor),
          السبب: row.reason ?? ''
        })),
        totals: { 'إجمالي خسائر الهالك': m(rows.reduce((sum, row) => sum + row.costMinor, 0)) }
      }
    }

    case 'expenses': {
      // Item 9/10 + DB-15: same authoritative source as the Expenses screen,
      // including the months whose scheduled fixed expenses are not posted
      // yet — derived, never written by producing a report.
      const scheduled = scheduledRecurringOccurrences(
        from === '1900-01-01' ? undefined : from,
        to === '2999-12-31' ? undefined : to
      ).filter((occurrence) => occurrence.periodStart >= from && occurrence.periodStart <= to)
      const rows = getDatabase().all<{
        spentAt: string
        description: string
        kind: string
        categoryName: string | null
        amountMinor: number
        orderNumber: string | null
      }>(sql`
        SELECT e.spent_at AS spentAt, e.description, e.kind, c.name AS categoryName,
               e.amount_minor AS amountMinor, o.document_number AS orderNumber
        FROM expenses e
        LEFT JOIN expense_categories c ON c.id = e.category_id
        LEFT JOIN orders o ON o.id = e.order_id
        WHERE e.spent_at BETWEEN ${from} AND ${to} AND e.reversed_at IS NULL
        ORDER BY e.id DESC
      `)
      const allRows = [
        // Posted rows come back newest first; derived ones follow the same
        // order by their own period.
        ...[...scheduled]
          .sort((left, right) =>
            right.periodStart.localeCompare(left.periodStart) || right.recurringExpenseId - left.recurringExpenseId
          )
          .map((occurrence) => ({
          spentAt: occurrence.periodStart,
          description: occurrence.description,
          kind: 'fixed',
          categoryName: occurrence.categoryName,
          amountMinor: occurrence.amountMinor,
          orderNumber: null as string | null
        })),
        ...rows
      ]
      return {
        title: 'تقرير المصروفات',
        period,
        columns: ['التاريخ', 'البيان', 'النوع', 'التصنيف', 'مرتبط بطلب', 'المبلغ'],
        rows: allRows.map((row) => ({
          التاريخ: row.spentAt,
          البيان: row.description,
          النوع: row.kind === 'fixed' ? 'ثابت' : 'متغير',
          التصنيف: row.categoryName ?? '',
          'مرتبط بطلب': row.orderNumber ?? '—',
          المبلغ: m(row.amountMinor)
        })),
        totals: { 'إجمالي المصروفات': m(allRows.reduce((sum, row) => sum + row.amountMinor, 0)) }
      }
    }

    case 'order_costs':
    case 'order_profitability': {
      const rows = orderProfitabilityReport({
        from: from === '1900-01-01' ? undefined : from,
        to: to === '2999-12-31' ? undefined : to,
        completedOnly: request.key === 'order_profitability'
      })
      return {
        title: request.key === 'order_costs' ? 'تقرير تكاليف الطلبات' : 'تقرير ربحية الطلبات',
        period,
        columns: [
          'رقم الطلب',
          'سعر البيع',
          'تكلفة المواد',
          'تكلفة الآلات',
          'تكلفة العمالة',
          'التوصيل/التركيب',
          'مصروفات مرتبطة',
          'إجمالي التكلفة الفعلية',
          'الربح الفعلي'
        ],
        rows: rows.map((row) => ({
          'رقم الطلب': row.documentNumber,
          'سعر البيع': m(row.sellingPriceMinor),
          'تكلفة المواد': m(row.materialCostMinor),
          'تكلفة الآلات': m(row.machineCostMinor),
          'تكلفة العمالة': m(row.workerCostMinor),
          'التوصيل/التركيب': m(row.deliveryCostMinor),
          'مصروفات مرتبطة': m(row.linkedExpensesMinor),
          'إجمالي التكلفة الفعلية': m(row.totalActualCostMinor),
          'الربح الفعلي': m(row.actualProfitMinor)
        })),
        totals: {
          'إجمالي المبيعات': m(rows.reduce((sum, row) => sum + row.sellingPriceMinor, 0)),
          'إجمالي التكلفة الفعلية': m(rows.reduce((sum, row) => sum + row.totalActualCostMinor, 0)),
          'إجمالي الربح الفعلي': m(rows.reduce((sum, row) => sum + row.actualProfitMinor, 0))
        }
      }
    }

    case 'monthly_profit': {
      const now = new Date()
      const year = request.year ?? now.getFullYear()
      const month = request.month ?? now.getMonth() + 1
      const summary = monthlyProfitSummary(year, month)
      return {
        title: `ملخص الأرباح الشهري - ${month}/${year}`,
        columns: ['البند', 'القيمة'],
        rows: [
          { البند: 'الإيرادات (الطلبات المكتملة)', القيمة: m(summary.revenueMinor) },
          { البند: 'تكلفة المواد الخام', القيمة: m(summary.materialCostMinor) },
          { البند: 'تكلفة الآلات', القيمة: m(summary.machineCostMinor) },
          { البند: 'تكلفة العمالة', القيمة: m(summary.workerCostMinor) },
          { البند: 'تكاليف التوصيل/التركيب', القيمة: m(summary.deliveryCostMinor) },
          { البند: 'مصروفات مرتبطة بالطلبات', القيمة: m(summary.orderLinkedExpensesMinor) },
          { البند: 'إجمالي التكاليف المباشرة', القيمة: m(summary.directOrderCostsMinor) },
          { البند: 'ربح الطلبات', القيمة: m(summary.grossOrderProfitMinor) },
          { البند: 'المصروفات التشغيلية العامة', القيمة: m(summary.generalExpensesMinor) },
          { البند: 'الرواتب (الموظفون)', القيمة: m(summary.payrollExpenseMinor) },
          { البند: 'خسائر الهالك', القيمة: m(summary.wasteLossMinor) },
          { البند: 'صافي الربح', القيمة: m(summary.netProfitMinor) },
          {
            البند: `مخصص الادخار (${(summary.savingsRateBp / 100).toFixed(0)}%)`,
            القيمة: m(summary.savingsAllocatedMinor || summary.savingsProposedMinor)
          },
          { البند: 'مسحوبات الأرباح', القيمة: m(summary.profitWithdrawalsMinor) },
          { البند: 'المتبقي بعد المخصصات والمسحوبات', القيمة: m(summary.remainingProfitMinor) }
        ],
        totals: { 'عدد الطلبات المكتملة': String(summary.completedOrderCount) }
      }
    }

    case 'worker_balances': {
      // CC04/BL-17: the same two separate ledgers as workerBalances — reversal adjustments included,
      // commission payable and withdrawal debt never netted.
      const rows = getDatabase().all<{ name: string; recognized: number; paid: number; withdrawn: number; repaid: number }>(sql`
        SELECT w.name,
          COALESCE(SUM(CASE WHEN t.kind IN ('earning', 'adjustment') THEN t.amount_minor ELSE 0 END), 0) AS recognized,
          COALESCE(SUM(CASE WHEN t.kind = 'commission_payment' THEN t.amount_minor ELSE 0 END), 0) AS paid,
          COALESCE(SUM(CASE WHEN t.kind = 'withdrawal' THEN t.amount_minor ELSE 0 END), 0) AS withdrawn,
          COALESCE(SUM(CASE WHEN t.kind = 'repayment' THEN t.amount_minor ELSE 0 END), 0) AS repaid
        FROM workers w LEFT JOIN worker_transactions t ON t.worker_id = w.id
        GROUP BY w.id ORDER BY w.name
      `)
      return {
        title: 'أرصدة العمال',
        columns: ['العامل', 'المستحقات المحتسبة', 'المدفوع من المستحقات', 'المستحقات الحالية', 'المسحوبات', 'المرتجعات', 'المسحوبات والمرتجعات المستحقة'],
        rows: rows.map((row) => ({
          العامل: row.name,
          'المستحقات المحتسبة': m(row.recognized),
          'المدفوع من المستحقات': m(row.paid),
          'المستحقات الحالية': m(row.recognized - row.paid),
          المسحوبات: m(row.withdrawn),
          المرتجعات: m(row.repaid),
          'المسحوبات والمرتجعات المستحقة': m(row.withdrawn - row.repaid)
        }))
      }
    }

    case 'payroll': {
      const now = new Date()
      const year = request.year ?? now.getFullYear()
      const month = request.month ?? now.getMonth() + 1
      const rows = monthlyPayroll(year, month)
      return {
        title: `كشف الرواتب - ${month}/${year}`,
        columns: ['الموظف', 'الراتب الشهري', 'المدفوع', 'الخصومات', 'صافي المستحق', 'المتبقي'],
        rows: rows.map((row) => ({
          الموظف: row.name,
          'الراتب الشهري': m(row.monthlySalaryMinor),
          المدفوع: m(row.paidMinor),
          الخصومات: m(row.deductionMinor),
          'صافي المستحق': m(row.monthlySalaryMinor - row.deductionMinor),
          المتبقي: m(row.remainingSalaryMinor)
        })),
        totals: { 'إجمالي الرواتب المدفوعة': m(rows.reduce((sum, row) => sum + row.paidMinor, 0)) }
      }
    }

    default:
      return { title: 'تقرير', columns: [], rows: [] }
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: 'مسودة',
    approved: 'معتمد',
    expired: 'منتهي',
    converted: 'محوّل',
    cancelled: 'ملغى',
    confirmed: 'مؤكد',
    completed: 'مكتمل'
  }
  return labels[status] ?? status
}

export const AVAILABLE_REPORTS: Array<{ key: ReportKey; label: string; needsPeriod: boolean; needsMonth?: boolean }> = [
  { key: 'sales', label: 'المبيعات', needsPeriod: true },
  { key: 'orders', label: 'طلبات العملاء', needsPeriod: true },
  { key: 'customer_balances', label: 'أرصدة العملاء', needsPeriod: false },
  { key: 'supplier_balances', label: 'أرصدة الموردين', needsPeriod: false },
  { key: 'purchases', label: 'المشتريات', needsPeriod: true },
  { key: 'inventory', label: 'المخزون', needsPeriod: false },
  { key: 'inventory_valuation', label: 'تقييم رأس مال المخزون', needsPeriod: false },
  { key: 'material_consumption', label: 'استهلاك المواد', needsPeriod: true },
  { key: 'waste', label: 'الهالك', needsPeriod: true },
  { key: 'expenses', label: 'المصروفات', needsPeriod: true },
  { key: 'order_costs', label: 'تكاليف الطلبات', needsPeriod: true },
  { key: 'order_profitability', label: 'ربحية الطلبات', needsPeriod: true },
  { key: 'monthly_profit', label: 'ملخص الأرباح الشهري', needsPeriod: false, needsMonth: true },
  { key: 'cancelled_orders', label: 'الطلبات الملغاة', needsPeriod: true },
  { key: 'worker_balances', label: 'أرصدة العمال', needsPeriod: false },
  { key: 'payroll', label: 'كشف الرواتب', needsPeriod: false, needsMonth: true }
]
