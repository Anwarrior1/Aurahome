import { useState, type ReactElement } from 'react'
import { ArrowUpFromLine, Package, PiggyBank, Receipt, TrendingUp, Wallet } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Button, Card, DataTable, Field, Input, PageHeader, Select, Stat, Toolbar } from '@renderer/components/ui'
import { fmtMoney, fmtPercent } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface Summary {
  year: number
  month: number
  revenueMinor: number
  materialCostMinor: number
  machineCostMinor: number
  workerCostMinor: number
  deliveryCostMinor: number
  orderLinkedExpensesMinor: number
  directOrderCostsMinor: number
  grossOrderProfitMinor: number
  generalExpensesMinor: number
  payrollExpenseMinor: number
  wasteLossMinor: number
  netProfitMinor: number
  savingsRateBp: number
  savingsProposedMinor: number
  savingsAllocatedMinor: number
  profitWithdrawalsMinor: number
  remainingProfitMinor: number
  completedOrderCount: number
  allocationConfirmed: boolean
}

export function ProfitPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)

  const summary = useQuery<Summary>('profit', 'monthly', { year, month })
  const data = summary.data

  async function confirmAllocation(): Promise<void> {
    try {
      const result = await financialCall<{ amountMinor: number }>('profit', 'confirmAllocation', { year, month }, `profit.confirmAllocation:${year}:${month}`)
      toast.show(`تم اعتماد مخصص الادخار: ${fmtMoney(result.amountMinor)}`, 'success')
      await summary.reload()
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر الاعتماد', 'error')
    }
  }

  async function printReport(mode: 'printReport' | 'exportReportPdf'): Promise<void> {
    try {
      const result = await call<{ path?: string }>('documents', mode, {
        key: 'monthly_profit',
        year,
        month
      })
      toast.show(mode === 'printReport' ? 'تم إرسال التقرير للطباعة' : `تم حفظ الملف: ${result.path}`, 'success')
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر إخراج التقرير', 'error')
    }
  }

  const rows = data
    ? [
        { label: 'الإيرادات (الطلبات المكتملة)', value: data.revenueMinor, strong: true },
        { label: 'تكلفة المواد الخام الفعلية', value: -data.materialCostMinor },
        { label: 'تكلفة الآلات', value: -data.machineCostMinor },
        { label: 'تكلفة العمالة', value: -data.workerCostMinor },
        { label: 'تكاليف التوصيل والتركيب', value: -data.deliveryCostMinor },
        { label: 'مصروفات مرتبطة بالطلبات', value: -data.orderLinkedExpensesMinor },
        {
          label: 'ربح الطلبات قبل المصروفات العامة',
          value: data.grossOrderProfitMinor,
          strong: true
        },
        { label: 'المصروفات التشغيلية العامة', value: -data.generalExpensesMinor },
        { label: 'الرواتب (الموظفون)', value: -data.payrollExpenseMinor },
        { label: 'خسائر الهالك', value: -data.wasteLossMinor },
        { label: 'صافي الربح', value: data.netProfitMinor, strong: true }
      ]
    : []

  return (
    <>
      <PageHeader
        title="ملخص الأرباح الشهري"
        subtitle="على أساس الطلبات المكتملة — الإيراد وتكلفته يُحتسبان في شهر إتمام الطلب"
        actions={
          <>
            <Button variant="secondary" onClick={() => void printReport('printReport')}>
              طباعة
            </Button>
            <Button variant="secondary" onClick={() => void printReport('exportReportPdf')}>
              PDF
            </Button>
          </>
        }
      />
      <Card>
        <Toolbar>
          <Field label="السنة">
            <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
          <Field label="الشهر">
            <Select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </Toolbar>

        <div className="grid grid--4" style={{ marginBottom: 14 }}>
          <Stat label="الإيرادات" value={fmtMoney(data?.revenueMinor ?? 0)} hint={`${data?.completedOrderCount ?? 0} طلب مكتمل`} icon={<TrendingUp size={20} strokeWidth={2.25} />} />
          <Stat label="إجمالي التكاليف المباشرة" value={fmtMoney(data?.directOrderCostsMinor ?? 0)} icon={<Package size={20} strokeWidth={2.25} />} />
          <Stat
            label="المصروفات العامة + الرواتب + الهالك"
            value={fmtMoney((data?.generalExpensesMinor ?? 0) + (data?.payrollExpenseMinor ?? 0) + (data?.wasteLossMinor ?? 0))}
            icon={<Receipt size={20} strokeWidth={2.25} />}
          />
          <Stat label="صافي الربح" value={fmtMoney(data?.netProfitMinor ?? 0)} tone={(data?.netProfitMinor ?? 0) >= 0 ? 'success' : 'danger'} icon={<Wallet size={20} strokeWidth={2.25} />} />
        </div>

        <DataTable
          loading={summary.loading}
          rows={rows}
          rowKey={(row, index) => index}
          columns={[
            {
              key: 'label',
              header: 'البند',
              render: (row) => (row.strong ? <strong>{row.label}</strong> : row.label)
            },
            {
              key: 'value',
              header: 'القيمة',
              numeric: true,
              render: (row) => (
                <span
                  style={{
                    fontWeight: row.strong ? 600 : 400,
                    color: row.value < 0 ? 'var(--text-secondary)' : undefined
                  }}
                >
                  {fmtMoney(Math.abs(row.value))}
                  {row.value < 0 ? ' −' : ''}
                </span>
              )
            }
          ]}
        />
      </Card>

      <Card title="التوزيع بعد صافي الربح">
        <p className="muted">المصروفات التشغيلية، ومخصص الادخار، ومسحوبات الأرباح — ثلاثة مفاهيم منفصلة لا تختلط ببعضها.</p>
        <div className="grid grid--3">
          <Stat
            label={`مخصص الادخار (${fmtPercent(data?.savingsRateBp ?? 1000)})`}
            value={fmtMoney(data?.allocationConfirmed ? (data?.savingsAllocatedMinor ?? 0) : (data?.savingsProposedMinor ?? 0))}
            hint={data?.allocationConfirmed ? 'معتمد' : 'مقترح — بانتظار اعتماد المالك'}
            icon={<PiggyBank size={20} strokeWidth={2.25} />}
          />
          <Stat label="مسحوبات الأرباح خلال الشهر" value={fmtMoney(data?.profitWithdrawalsMinor ?? 0)} icon={<ArrowUpFromLine size={20} strokeWidth={2.25} />} />
          <Stat label="المتبقي بعد المخصصات والمسحوبات" value={fmtMoney(data?.remainingProfitMinor ?? 0)} tone="brand" />
        </div>
        {can(P.savings.manage) && !data?.allocationConfirmed && (data?.savingsProposedMinor ?? 0) > 0 && (
          <div style={{ marginTop: 12 }}>
            <Button onClick={() => void confirmAllocation()}>اعتماد مخصص هذا الشهر</Button>
          </div>
        )}
        {(data?.netProfitMinor ?? 0) <= 0 && (
          <p className="muted" style={{ marginTop: 10 }}>
            لا يوجد مخصص ادخار لهذا الشهر لأن صافي الربح صفر أو سالب — ورصيد الصندوق يبقى كما هو دون أي خصم.
          </p>
        )}
      </Card>
    </>
  )
}
