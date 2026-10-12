import { useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { RotateCcw } from 'lucide-react'
import { Badge, Button, Card, DataTable, ErrorNote, Field, PageHeader, Pager, Select, Toolbar } from '@renderer/components/ui'
import { fmtDateTime } from '@renderer/lib/format'
import {
  EXIT_PERMIT_KINDS,
  EXIT_PERMIT_LABEL,
  permitIncludesInstallation,
  type ExitPermitKind
} from '@shared/production/exit-permit'

interface Release {
  id: number; documentNumber: string; orderId: number; orderNumber: string; kind: ExitPermitKind
  authorizedAt: string; address: string | null; workers: Array<{ workerId: number; name: string }>
  status: string; reversalToken: string
}

export function ReleasesPage(): ReactElement {
  const toast = useToast()
  const { can } = useSession()
  const [reversingId, setReversingId] = useState<number>()
  const [includeReversed, setIncludeReversed] = useState(false)
  const navigate = useNavigate()
  const [kind, setKind] = useState('')
  const list = usePagedQuery<Release>('production', 'listReleases', { kind: kind || undefined, includeReversed })

  async function reversePermit(row: Release): Promise<void> {
    if (!window.confirm(`التراجع عن إذن الخروج ${row.documentNumber}؟ سيبقى التصنيع ودفعات العميل وفواتير الشراء دون تغيير.`)) return
    setReversingId(row.id)
    try {
      await call('production', 'reverseRelease', { id: row.id, expectedToken: row.reversalToken })
      toast.show('تم التراجع عن الإذن؛ يمكن إصداره مجدداً من الطلب', 'success')
      await list.reload()
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر التراجع', 'error') }
    finally { setReversingId(undefined) }
  }

  async function printDoc(row: Release, mode: 'print' | 'exportPdf'): Promise<void> {
    try {
      const docKind = permitIncludesInstallation(row.kind) ? 'installation_release' : 'delivery_release'
      const result = await call<{ path?: string }>('documents', mode, { kind: docKind, id: row.id })
      toast.show(mode === 'print' ? 'تم إرسال الإذن للطباعة' : `تم حفظ الملف: ${result.path}`, 'success')
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر إخراج المستند', 'error') }
  }

  return (
    <>
      <PageHeader title="أذونات الخروج" subtitle="أذونات التسليم والتركيب والتوصيل — تخضع لقواعد السداد والتصريح المعتمدة" />
      <Card>
        <Toolbar>
          <Field label="المستندات"><Select value={includeReversed ? 'history' : 'active'} onChange={(e) => setIncludeReversed(e.target.value === 'history')}><option value="active">الأذونات الفعّالة</option><option value="history">بما فيها المعكوسة</option></Select></Field>
          <Field label="النوع">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">الكل</option>
              {EXIT_PERMIT_KINDS.map((value) => (
                <option key={value} value={value}>{EXIT_PERMIT_LABEL[value]}</option>
              ))}
            </Select>
          </Field>
        </Toolbar>
        <ErrorNote>{list.error}</ErrorNote>
        <DataTable
          loading={list.loading}
          rows={list.items}
          rowKey={(row) => row.id}
          empty="لا توجد أذونات خروج"
          columns={[
            { key: 'num', header: 'رقم الإذن', render: (row) => row.documentNumber },
            { key: 'kind', header: 'النوع', render: (row) => <Badge tone={permitIncludesInstallation(row.kind) ? 'info' : 'success'}>{EXIT_PERMIT_LABEL[row.kind]}</Badge> },
            { key: 'state', header: 'الحالة', render: (row) => row.status === 'reversed' ? 'تم التراجع' : 'صادر' },
            { key: 'order', header: 'الطلب', render: (row) => row.orderNumber },
            { key: 'at', header: 'تاريخ الاعتماد', render: (row) => fmtDateTime(row.authorizedAt) },
            { key: 'addr', header: 'الموقع', render: (row) => row.address ?? '—' },
            { key: 'team', header: 'الفريق المكلّف', render: (row) => row.workers.map((w) => w.name).join('، ') || '—' },
            {
              key: 'actions', header: '', render: (row) => (
                <div className="row-actions">
                  {can(P.releases.reverse) && row.status === 'active' && <Button variant="secondary" size="sm" disabled={reversingId !== undefined} onClick={() => void reversePermit(row)}><RotateCcw size={15} /> تراجع</Button>}
                  <Button variant="ghost" size="sm" onClick={() => navigate(`/orders/${row.orderId}`)}>الطلب</Button>
                  <Button variant="ghost" size="sm" onClick={() => void printDoc(row, 'print')}>طباعة</Button>
                  <Button variant="ghost" size="sm" onClick={() => void printDoc(row, 'exportPdf')}>PDF</Button>
                </div>
              )
            }
          ]}
        />
        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} />
      </Card>
    </>
  )
}
