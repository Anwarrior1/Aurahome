import { useEffect, useState, type ReactElement } from 'react'
import { useQuery } from '@renderer/lib/useQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { Button, Card, DataTable, Field, Input, PageHeader, Pager, Select, Toolbar } from '@renderer/components/ui'
import { useSession } from '@renderer/state/session.store'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface ReportMeta { key: string; label: string; needsPeriod: boolean; needsMonth?: boolean }
interface Report { title: string; period?: { from: string; to: string }; columns: string[]; rows: Array<Record<string, string>>; totals?: Record<string, string> }

const REPORT_PAGE_SIZE = 50

function ReportRows({ report, loading }: { report?: Report; loading: boolean }): ReactElement {
  const [pageIndex, setPageIndex] = useState(0)
  const rows = report?.rows ?? []
  const lastPage = Math.max(0, Math.ceil(rows.length / REPORT_PAGE_SIZE) - 1)
  const page = Math.min(pageIndex, lastPage)
  const offset = page * REPORT_PAGE_SIZE
  return <>
    <DataTable
      loading={loading}
      rows={rows.slice(offset, offset + REPORT_PAGE_SIZE)}
      rowKey={(_row, index) => offset + index}
      empty="لا توجد بيانات لهذا التقرير"
      columns={(report?.columns ?? []).map((column) => ({
        key: column,
        header: column,
        numeric: /الإجمالي|المبلغ|القيمة|التكلفة|الربح|المدفوع|المتبقي|الكمية|الرصيد|الصافي|سعر/.test(column),
        render: (row: Record<string, string>) => row[column] ?? ''
      }))}
    />
    {!loading && rows.length > 0 && <nav aria-label="صفحات التقرير">
      <Toolbar>
        <Button variant="secondary" disabled={page === 0} onClick={() => setPageIndex(0)}>الأولى</Button>
        <Pager pageIndex={page} hasPrev={page > 0} hasNext={page < lastPage}
          onPrev={() => setPageIndex(page - 1)} onNext={() => setPageIndex(page + 1)}
          totalCount={rows.length} pageSize={REPORT_PAGE_SIZE} noun="صف" />
        <Button variant="secondary" disabled={page === lastPage} onClick={() => setPageIndex(lastPage)}>الأخيرة</Button>
      </Toolbar>
    </nav>}
  </>
}

export function ReportsPage(): ReactElement {
  const toast = useToast()
  const { can } = useSession()
  const now = new Date()
  const [key, setKey] = useState('sales')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)

  const available = useQuery<ReportMeta[]>('reports', 'available')
  const meta = available.data?.find((row) => row.key === key)
  useEffect(() => {
    if (available.data?.length && !available.data.some((reportMeta) => reportMeta.key === key)) {
      setKey(available.data[0]!.key)
    }
  }, [available.data, key])
  const payload = { key, from: from || undefined, to: to || undefined, year, month }
  const report = useQuery<Report>('reports', 'build', payload, {
    enabled: Boolean(available.data?.some((reportMeta) => reportMeta.key === key))
  })

  async function output(mode: 'printReport' | 'exportReportPdf'): Promise<void> {
    try {
      const result = await call<{ path?: string }>('documents', mode, payload)
      toast.show(mode === 'printReport' ? 'تم إرسال التقرير للطباعة' : `تم حفظ الملف: ${result.path}`, 'success')
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر إخراج التقرير', 'error') }
  }

  return (
    <>
      <PageHeader
        title="التقارير"
        subtitle="تقارير تشغيلية قابلة للطباعة والتصدير بصيغة PDF"
        actions={can(P.reports.export) ? <>
          <Button variant="secondary" onClick={() => void output('printReport')}>طباعة</Button>
          <Button variant="secondary" onClick={() => void output('exportReportPdf')}>تصدير PDF</Button>
        </> : undefined}
      />
      <Card>
        <Toolbar>
          <Field label="التقرير">
            <Select value={key} onChange={(e) => setKey(e.target.value)}>
              {(available.data ?? []).map((row) => <option key={row.key} value={row.key}>{row.label}</option>)}
            </Select>
          </Field>
          {meta?.needsPeriod && (
            <>
              <Field label="من تاريخ"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="إلى تاريخ"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            </>
          )}
          {meta?.needsMonth && (
            <>
              <Field label="السنة"><Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} /></Field>
              <Field label="الشهر">
                <Select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
              </Field>
            </>
          )}
        </Toolbar>

        <h2 style={{ marginBottom: 10 }}>{report.data?.title ?? ''}</h2>
        <ReportRows key={JSON.stringify(payload)} report={report.data} loading={report.loading} />
        {report.data?.totals && (
          <div className="grid grid--3" style={{ marginTop: 12 }}>
            {Object.entries(report.data.totals).map(([label, value]) => (
              <div key={label} className="stat">
                <div className="stat__label">{label}</div>
                <div className="stat__value money">{value}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
