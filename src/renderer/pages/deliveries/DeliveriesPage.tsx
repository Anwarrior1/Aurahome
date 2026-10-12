import { useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2 } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { useSelectedDate } from '@renderer/state/selected-date.store'
import {
  Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Pager, Select, Textarea, Toolbar
} from '@renderer/components/ui'
import { fmtDateTime, fmtMoney } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import {
  COMPLETION_COST_LABEL,
  COMPLETION_ACTION_LABEL,
  COMPLETION_LABEL,
  completionKindForPermit,
  EXIT_PERMIT_LABEL,
  type CompletionKind,
  type ExitPermitKind
} from '@shared/production/exit-permit'

interface Delivery {
  id: number; orderId: number; orderNumber: string; customerName: string; kind: CompletionKind
  releaseId: number | null; releaseNumber: string | null; scheduledAt: string | null
  recordedAt: string | null; address: string | null; actualCostMinor?: number
  status: string; cancelReason: string | null; notes: string | null; workers: string[]
}
interface Release {
  id: number; documentNumber: string; orderId: number; orderNumber: string
  kind: ExitPermitKind; address: string | null
  workers: Array<{ workerId: number; name: string }>
  completionKind: CompletionKind | null
  completionRecorded: boolean
  status: string; orderStatus: string; orderArchivedAt: string | null
}

const KIND = COMPLETION_LABEL

/**
 * "التسليم والتركيب" — the real-world fulfilment event authorized by
 * an Exit Permit. The permit type resolves to exactly one completion kind.
 *
 * The ERP cannot know that goods physically reached the customer, so a
 * user records it here. Every gate behind the button (production
 * complete, exit permit issued, order fully paid) is enforced in main —
 * the form only makes the eligible choices easy to find.
 */
export function DeliveriesPage(): ReactElement {
  const navigate = useNavigate()
  const toast = useToast()
  const { can } = useSession()
  const { selectedDateIso } = useSelectedDate()
  const [kind, setKind] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const [reversingId, setReversingId] = useState<number>()
  const [form, setForm] = useState({
    orderId: '', kind: 'delivery', releaseId: '', recordedAt: '', address: '', cost: '', notes: '', workerId: ''
  })
  const [actualWorkerIds, setActualWorkerIds] = useState<number[]>([])

  const [permitSearch, setPermitSearch] = useState('')
  const [selectedPermit, setSelectedPermit] = useState<Release>()
  const list = usePagedQuery<Delivery>('production', 'listDeliveries', {
    kind: kind || undefined, from: from || undefined, to: to || undefined
  })
  // Only permits still awaiting their completion, filtered in main; the
  // dialog searches by permit number instead of loading every permit.
  const releases = usePagedQuery<Release>('production', 'listReleases', {
    awaitingCompletion: true, search: permitSearch || undefined
  }, { limit: 100, enabled: open })
  const workers = useQuery<Array<{ id: number; name: string }>>('workers', 'list', { activeOnly: true })

  const eligibleReleases = releases.items

  async function save(): Promise<void> {
    const permit = selectedPermit?.id === Number(form.releaseId) ? selectedPermit : undefined
    if (!permit) { setError('اختر إذن الخروج'); return }
    const completionKind = completionKindForPermit(permit.kind)
    try {
      await call('production', 'recordDelivery', {
        orderId: permit.orderId,
        kind: completionKind,
        releaseId: permit.id,
        workerIds: actualWorkerIds,
        recordedAt: form.recordedAt || undefined,
        address: form.address || undefined,
        actualCostMinor: form.cost ? Math.round(Number(form.cost) * 1000) : undefined,
        notes: form.notes || undefined
      })
      toast.show(`تم ${COMPLETION_LABEL[completionKind]}`, 'success')
      setOpen(false); setError(undefined)
      await list.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر التسجيل') }
  }

  /** User-facing delete; the backend preserves the row as a safe reversal. */
  async function deleteDelivery(row: Delivery): Promise<void> {
    if (!window.confirm(`هل تريد حذف عملية ${COMPLETION_LABEL[row.kind]}؟`)) return
    setReversingId(row.id)
    try {
      await call('production', 'cancelDelivery', {
        id: row.id,
        reason: `حذف عملية ${COMPLETION_LABEL[row.kind]}`
      })
      toast.show('تم حذف العملية وعكس أثرها بأمان', 'success')
      await Promise.all([list.reload(), releases.reload()])
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر حذف العملية', 'error')
    } finally {
      setReversingId(undefined)
    }
  }

  return (
    <>
      <PageHeader
        title="التسليم والتركيب"
        subtitle="تسجيل عمليات التسليم والتركيب والتوصيل المصرح بها — تُكمل الطلب وتفتح إصدار الفاتورة المعتمدة"
        actions={can(P.deliveries.register) && (
          <Button onClick={() => {
            setForm({ orderId: '', kind: 'delivery', releaseId: '', recordedAt: selectedDateIso, address: '', cost: '', notes: '', workerId: '' })
            setActualWorkerIds([])
            setError(undefined); setOpen(true)
          }}>+ تسجيل عملية مصرح بها</Button>
        )}
      />
      <Card>
        <Toolbar>
          <Field label="النوع">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">الكل</option>
              {Object.entries(KIND).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </Field>
          <Field label="من تاريخ"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="إلى تاريخ"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </Toolbar>
        <ErrorNote>{list.error}</ErrorNote>
        <DataTable
          loading={list.loading}
          rows={list.items}
          rowKey={(row) => row.id}
          empty="لا توجد عمليات تسليم أو تركيب"
          columns={[
            { key: 'order', header: 'الطلب', render: (row) => row.orderNumber },
            { key: 'customer', header: 'العميل', render: (row) => row.customerName },
            { key: 'kind', header: 'النوع', render: (row) => <Badge tone="info">{KIND[row.kind] ?? row.kind}</Badge> },
            { key: 'at', header: 'تاريخ التنفيذ', render: (row) => fmtDateTime(row.recordedAt) },
            { key: 'permit', header: 'إذن الخروج', render: (row) => row.releaseNumber ?? '—' },
            { key: 'crew', header: 'الفريق', render: (row) => (row.workers.length ? row.workers.join('، ') : '—') },
            ...(can(P.orders.viewActualCost) ? [{ key: 'cost', header: 'التكلفة الفعلية', numeric: true, render: (row: Delivery) => fmtMoney(row.actualCostMinor) }] : []),
            {
              key: 'status', header: 'الحالة', render: (row) => (
                <Badge tone={row.status === 'cancelled' ? 'danger' : 'success'}>
                  {row.status === 'cancelled' ? 'ملغى' : 'مسجّل'}
                </Badge>
              )
            },
            {
              key: 'actions', header: '', render: (row) => (
                <div className="row-actions">
                  <Button variant="ghost" size="sm" onClick={() => navigate(`/orders/${row.orderId}`)}>الطلب</Button>
                  {can(P.deliveries.deleteOrReverse) && row.status === 'recorded' && (
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف العملية" aria-label="حذف العملية"
                      disabled={reversingId !== undefined} onClick={() => void deleteDelivery(row)}>
                      <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )
            }
          ]}
        />
        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} />
      </Card>

      <Modal open={open} title={form.releaseId ? COMPLETION_ACTION_LABEL[form.kind as CompletionKind] : 'تسجيل عملية مصرح بها'} onClose={() => setOpen(false)}
        footer={<><Button onClick={() => void save()}>تسجيل</Button><Button variant="secondary" onClick={() => setOpen(false)}>إلغاء</Button></>}>
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">نوع إذن الخروج يحدد العملية الوحيدة التي يمكن تسجيلها، ويُربط السجل بالإذن والطلب مباشرة.</p>
        <Field label="بحث عن إذن الخروج">
          <Input value={permitSearch} placeholder="رقم الإذن" onChange={(e) => setPermitSearch(e.target.value)} />
        </Field>
        <Field label="إذن الخروج" required hint={releases.loading ? 'جارٍ التحميل…' : eligibleReleases.length ? (releases.hasNext ? 'تُعرض أحدث 100 إذن — استخدم البحث للوصول إلى غيرها' : undefined) : 'لا توجد أذونات خروج بانتظار التسجيل'}>
          <Select value={form.releaseId} onChange={(e) => {
            const permit = eligibleReleases.find((release) => release.id === Number(e.target.value))
            setSelectedPermit(permit)
            if (!permit) {
              setForm({ ...form, orderId: '', releaseId: '', kind: 'delivery', address: '' })
              setActualWorkerIds([])
              return
            }
            setForm({
              ...form,
              orderId: String(permit.orderId),
              releaseId: String(permit.id),
              kind: completionKindForPermit(permit.kind),
              address: permit.address ?? ''
            })
            setActualWorkerIds(permit.workers.map((worker) => worker.workerId))
          }}>
            <option value="">— اختر —</option>
            {selectedPermit && !eligibleReleases.some((permit) => permit.id === selectedPermit.id) && (
              <option value={selectedPermit.id}>{selectedPermit.documentNumber} — {selectedPermit.orderNumber} — {EXIT_PERMIT_LABEL[selectedPermit.kind]}</option>
            )}
            {eligibleReleases.map((permit) => (
              <option key={permit.id} value={permit.id}>
                {permit.documentNumber} — {permit.orderNumber} — {EXIT_PERMIT_LABEL[permit.kind]}
              </option>
            ))}
          </Select>
        </Field>
        {form.releaseId && <Field label="نوع العملية"><Input value={COMPLETION_LABEL[form.kind as CompletionKind]} disabled /></Field>}
        <div className="grid grid--2">
          <Field label="تاريخ التنفيذ الفعلي" required><Input type="date" value={form.recordedAt} onChange={(e) => setForm({ ...form, recordedAt: e.target.value })} /></Field>
          <Field label="الفريق الفعلي">
            <Select value="" onChange={(e) => {
              const workerId = Number(e.target.value)
              if (workerId && !actualWorkerIds.includes(workerId)) setActualWorkerIds([...actualWorkerIds, workerId])
            }}>
              <option value="">— إضافة عامل —</option>
              {(workers.data ?? []).filter((worker) => !actualWorkerIds.includes(worker.id))
                .map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}
            </Select>
          </Field>
        </div>
        {actualWorkerIds.length > 0 && (
          <div className="pill-row">
            {actualWorkerIds.map((workerId) => {
              const worker = workers.data?.find((candidate) => candidate.id === workerId)
              return <button key={workerId} type="button" className="badge badge--neutral" onClick={() => setActualWorkerIds(actualWorkerIds.filter((id) => id !== workerId))}>{worker?.name ?? `#${workerId}`} ×</button>
            })}
          </div>
        )}
        {form.kind !== 'handover' && <Field label={form.kind === 'installation' ? 'موقع التركيب' : 'عنوان التوصيل'}><Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>}
        <Field label={COMPLETION_COST_LABEL[form.kind as CompletionKind]} hint="داخلية — منفصلة عمّا يُحاسب عليه العميل">
          <Input type="number" step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
        </Field>
        <Field label="ملاحظات"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      </Modal>
    </>
  )
}
