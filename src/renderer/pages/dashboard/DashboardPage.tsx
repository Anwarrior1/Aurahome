import type { ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardList, Wallet, Banknote, TrendingUp, Receipt, PiggyBank, CircleDollarSign } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { useSession } from '@renderer/state/session.store'
import { Card, DataTable, PageHeader, Stat, Badge } from '@renderer/components/ui'
import { fmtMoney, fmtDate, fmtDateSlash } from '@renderer/lib/format'
import { useSelectedDate } from '@renderer/state/selected-date.store'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface OrderRow {
  id: number
  documentNumber: string
  customerName: string
  totalMinor?: number
  paidMinor?: number
  remainingMinor?: number
  paymentStatus: string
  status: string
  createdAt: string
}

interface DashboardSummary {
  orders?: { openCount: number; dayCount: number; recent: OrderRow[] }
  sales?: { customerReceivablesMinor: number }
  financialAlerts?: { cashBalanceMinor: number }
  costs?: { dayExpensesMinor: number }
  profits?: { netProfitMinor: number; completedOrderCount: number; remainingProfitMinor?: number }
  savings?: { allocatedMinor: number; savingsRateBp: number }
}

const PAYMENT_LABELS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  unpaid: { label: 'غير مدفوع', tone: 'danger' },
  partial: { label: 'دفعة جزئية', tone: 'warning' },
  deposit_met: { label: 'المقدمة مكتملة', tone: 'info' as never },
  paid: { label: 'مدفوع بالكامل', tone: 'success' }
}

export function DashboardPage(): ReactElement {
  const navigate = useNavigate()
  const { can } = useSession()
  const { selectedDateIso, isToday } = useSelectedDate()
  // Everything on this page is read for the globally selected
  // operational day: its month for the profit figures, its end for the
  // as-of cash balance, and the day itself for the activity list.
  const year = Number(selectedDateIso.slice(0, 4))
  const month = Number(selectedDateIso.slice(5, 7))

  const summary = useQuery<DashboardSummary>('dashboard', 'summary', {
    date: selectedDateIso,
    year,
    month,
    currentDay: isToday
  }, { enabled: can(P.dashboard.view) })
  const rows = summary.data?.orders?.recent ?? []

  return (
    <>
      <PageHeader
        title="لوحة المعلومات"
        subtitle={isToday
          ? 'نظرة عامة على نشاط المصنع'
          : `عرض تاريخي — الأرقام كما في ${fmtDateSlash(selectedDateIso)}`}
      />

      <div className="grid grid--4 dash-kpis">
        {summary.data?.orders && <Stat
          label="طلبات قيد التنفيذ"
          value={String(summary.data.orders.openCount)}
          tone="brand"
          icon={<ClipboardList size={20} strokeWidth={2.25} />}
        />}
        {summary.data?.sales && <Stat
          label="مستحقات على العملاء"
          value={fmtMoney(summary.data.sales.customerReceivablesMinor)}
          icon={<Wallet size={20} strokeWidth={2.25} />}
        />}
        {summary.data?.financialAlerts && (
          <Stat
            label="الرصيد النقدي"
            value={fmtMoney(summary.data.financialAlerts.cashBalanceMinor)}
            hint={isToday ? undefined : `كما في ${fmtDateSlash(selectedDateIso)}`}
            icon={<Banknote size={20} strokeWidth={2.25} />}
          />
        )}
        {summary.data?.profits && (
          <Stat
            label={`صافي ربح ${month}/${year}`}
            value={fmtMoney(summary.data.profits.netProfitMinor)}
            tone={summary.data.profits.netProfitMinor >= 0 ? 'success' : 'danger'}
            hint={`${summary.data.profits.completedOrderCount} طلب مكتمل`}
            icon={<TrendingUp size={20} strokeWidth={2.25} />}
          />
        )}
      </div>

      {/* What actually happened on the selected day. */}
      <div className="grid grid--3 dash-kpis">
        {summary.data?.orders && (
          <Stat
            label={`طلبات ${fmtDateSlash(selectedDateIso)}`}
            value={String(summary.data.orders.dayCount)}
            icon={<ClipboardList size={20} strokeWidth={2.25} />}
          />
        )}
        {summary.data?.costs && (
          <Stat
            label={`مصروفات ${fmtDateSlash(selectedDateIso)}`}
            value={fmtMoney(summary.data.costs.dayExpensesMinor)}
            icon={<Receipt size={20} strokeWidth={2.25} />}
          />
        )}
        {summary.data?.savings && (
          <Stat
            label="المخصص للادخار"
            value={fmtMoney(summary.data.savings.allocatedMinor)}
            icon={<PiggyBank size={20} strokeWidth={2.25} />}
          />
        )}
        {summary.data?.profits?.remainingProfitMinor !== undefined && (
          <Stat
            label="المتبقي بعد الخصومات والمسحوبات"
            value={fmtMoney(summary.data.profits.remainingProfitMinor)}
            tone="brand"
            icon={<CircleDollarSign size={20} strokeWidth={2.25} />}
          />
        )}
      </div>

      {summary.data?.orders && (
        <Card title="أحدث الطلبات">
          <DataTable
            loading={summary.loading}
            rows={rows.slice(0, 10)}
            rowKey={(row) => row.id}
            onRowClick={(row) => navigate(`/orders/${row.id}`)}
            columns={[
              { key: 'num', header: 'رقم الطلب', render: (row) => row.documentNumber },
              { key: 'customer', header: 'العميل', render: (row) => row.customerName },
              { key: 'date', header: 'التاريخ', render: (row) => fmtDate(row.createdAt) },
              ...(can(P.dashboard.viewSales) ? [
                { key: 'total', header: 'الإجمالي', numeric: true, render: (row: OrderRow) => fmtMoney(row.totalMinor ?? 0) },
                { key: 'paid', header: 'المدفوع', numeric: true, render: (row: OrderRow) => fmtMoney(row.paidMinor ?? 0) }
              ] : []),
              {
                key: 'status',
                header: 'حالة السداد',
                render: (row) => {
                  const info = PAYMENT_LABELS[row.paymentStatus] ?? { label: row.paymentStatus, tone: 'neutral' as const }
                  return <Badge tone={info.tone}>{info.label}</Badge>
                }
              }
            ]}
          />
        </Card>
      )}
    </>
  )
}
