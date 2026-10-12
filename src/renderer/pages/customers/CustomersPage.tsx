import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { Archive, ArchiveRestore, Eye, Trash2 } from 'lucide-react'
import { usePagedQuery, type PagedQuery } from '@renderer/lib/usePagedQuery'
import { SEARCH_MAX_LENGTH, type CursorPage } from '@shared/pagination/cursor-page'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Button, Card, DataTable, ErrorNote, Field, Input, LoadMore, Modal, PageHeader, Pager, Textarea, Toolbar, Select, Badge } from '@renderer/components/ui'
import { fmtMoney, fmtDate, fmtDateTime } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface Customer {
  id: number; name: string; phone: string | null; address: string | null; notes: string | null; active: boolean; hasHistory: boolean
  /** Authoritative order balance for this customer, computed in main. */
  orderCount: number; totalMinor: number; paidMinor: number; remainingMinor: number
}
interface Balance { customerId: number; name: string; phone: string | null; orderCount: number; totalMinor: number; paidMinor: number; remainingMinor: number }

interface HistoryDocument { id: number; documentNumber: string; status: string; totalMinor: number }
interface PaymentEntry { rowKey: string; id: number; entryType: 'payment' | 'refund'; amountMinor: number; paidAt: string; effectiveBusinessDay: string; executionAt: string }
interface Statement {
  customer: Customer
  balance: Balance
  orders: CursorPage<HistoryDocument>
  payments: CursorPage<PaymentEntry>
  preliminaryInvoices: CursorPage<HistoryDocument>
  approvedInvoices: CursorPage<HistoryDocument>
}

// Customer-local coalescing; other paged-query consumers remain immediate.
const CUSTOMER_SEARCH_DEBOUNCE_MS = 150

type CustomerQueryState = PagedQuery<Customer, { totalCount: number }>

/** Keyed by the settled filters: late responses belong to the old instance. */
function CustomerQuery({ search, state, onQuery, children }: {
  search: string
  state: 'active' | 'archived'
  onQuery: (identity: string, summary: CustomerQueryState['summary'], reload: CustomerQueryState['reload']) => void
  children: (query: CustomerQueryState) => ReactElement
}): ReactElement {
  const list = usePagedQuery<Customer, { totalCount: number }>('customers', 'list', { search, state })
  const { summary, reload } = list
  useLayoutEffect(() => onQuery(JSON.stringify({ search, state }), summary, reload), [search, state, summary, reload, onQuery])
  return children(list)
}

export function CustomerCountBadge({ count }: { count: number }): ReactElement {
  return <span className="customer-count-badge" dir="ltr" aria-label={`عدد العملاء المطابقين: ${count}`}>{count}</span>
}

/** One independently paged section of the customer statement. */
function useStatementSection<T>(customerId: number | undefined, section: 'orders' | 'payments' | 'preliminaryInvoices' | 'approvedInvoices', rowKey?: (row: T) => string | number) {
  return usePagedQuery<T, undefined, Statement>('customers', 'statement', { id: customerId ?? 0, sections: [section] }, {
    mode: 'append',
    enabled: customerId !== undefined,
    rowKey,
    pageOf: (response) => response[section] as unknown as CursorPage<T>
  })
}

export function CustomersPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [composing, setComposing] = useState(false)
  // Main trims only after enforcing the raw length bound. Do not deduplicate
  // over-limit input into a valid query and conceal its validation error.
  const inputKey = searchInput.length <= SEARCH_MAX_LENGTH ? searchInput.trim() : searchInput
  const queryKey = search.length <= SEARCH_MAX_LENGTH ? search.trim() : search
  const searchPending = composing || inputKey !== queryKey
  useEffect(() => {
    if (composing) return
    if (searchInput.length <= SEARCH_MAX_LENGTH && !searchInput.trim()) {
      setSearch(searchInput)
      return
    }
    if (!searchPending) return
    const timer = setTimeout(() => setSearch(searchInput), CUSTOMER_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, searchPending, composing])
  const [editing, setEditing] = useState<Partial<Customer> | undefined>()
  const [error, setError] = useState<string>()

  const [state, setState] = useState<'active' | 'archived'>('active')
  const [action, setAction] = useState<{ customer: Customer; kind: 'archive' | 'restore' | 'remove' }>()
  const [confirmation, setConfirmation] = useState('')
  const [processing, setProcessing] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const [historyFor, setHistoryFor] = useState<Customer>()

  const queryIdentity = JSON.stringify({ search, state })
  const [publishedSummary, setPublishedSummary] = useState<{ identity: string; summary: CustomerQueryState['summary'] }>({ identity: '', summary: undefined })
  const reloadQuery = useRef<CustomerQueryState['reload']>()
  const publishQuery = useCallback((identity: string, summary: CustomerQueryState['summary'], reload: CustomerQueryState['reload']) => {
    reloadQuery.current = reload
    setPublishedSummary({ identity, summary })
  }, [])
  const list = {
    summary: publishedSummary.identity === queryIdentity ? publishedSummary.summary : undefined,
    reload: async () => { await reloadQuery.current?.() }
  }
  const historyOrders = useStatementSection<HistoryDocument>(historyFor?.id, 'orders')
  const historyPayments = useStatementSection<PaymentEntry>(historyFor?.id, 'payments', (row) => row.rowKey)
  const historyPreliminary = useStatementSection<HistoryDocument>(historyFor?.id, 'preliminaryInvoices')
  const historyApproved = useStatementSection<HistoryDocument>(historyFor?.id, 'approvedInvoices')
  const history = historyOrders.response

  async function save(): Promise<void> {
    if (!editing?.name?.trim()) { setError('اسم العميل مطلوب'); return }
    try {
      const payload = { name: editing.name, phone: editing.phone ?? null, address: editing.address ?? null, notes: editing.notes ?? null }
      if (editing.id) await call('customers', 'update', { id: editing.id, ...payload })
      else await call('customers', 'create', payload)
      toast.show('تم حفظ بيانات العميل', 'success')
      setEditing(undefined)
      setError(undefined)
      await list.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  async function changeLifecycle(): Promise<void> {
    if (!action || processing) return
    setProcessing(true); setActionError(undefined)
    try {
      await call('customers', action.kind, { id: action.customer.id, ...(action.kind === 'remove' ? { confirmation } : {}) })
      toast.show(action.kind === 'archive' ? 'تمت أرشفة العميل' : action.kind === 'restore' ? 'تمت استعادة العميل' : 'تم حذف العميل نهائياً', 'success')
      setAction(undefined)
      window.dispatchEvent(new Event('customer-lifecycle-changed'))
      await list.reload()
    } catch (err) { setActionError(err instanceof ApiError ? err.message : 'تعذر تنفيذ الإجراء') }
    finally { setProcessing(false) }
  }
  function openAction(customer: Customer, kind: 'archive' | 'restore' | 'remove'): void {
    setAction({ customer, kind }); setConfirmation(''); setActionError(undefined)
  }
  function openHistory(customer: Customer): void {
    setHistoryFor(customer)
  }

  return (
    <>
      <PageHeader
        title={<span className="customer-title"><span>العملاء</span>{!searchPending && publishedSummary.identity === queryIdentity && <CustomerCountBadge count={list.summary?.totalCount ?? 0} />}</span>}
        subtitle="بيانات العملاء وأرصدتهم المستحقة"
        actions={can(P.customers.manage) && <Button onClick={() => { setEditing({}); setError(undefined) }}>+ عميل جديد</Button>}
      />

      <Card>
        <Toolbar>
          <Field label="حالة العملاء"><Select value={state} onChange={(e) => setState(e.target.value as 'active' | 'archived')}>
            <option value="active">العملاء النشطون</option>
            <option value="archived">العملاء المؤرشفون</option>
          </Select></Field>
          <Field label="بحث">
            <Input placeholder="الاسم أو رقم الهاتف" value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={(e) => { setSearchInput(e.currentTarget.value); setComposing(false) }} />
          </Field>
        </Toolbar>

        <CustomerQuery key={queryIdentity} search={search} state={state} onQuery={publishQuery}>
        {(list) => <>
        <ErrorNote>{searchPending ? undefined : list.error}</ErrorNote>
        <DataTable
          loading={searchPending || list.loading}
          rows={list.items}
          rowKey={(row) => row.id}
          empty="لا يوجد عملاء"
          columns={[
            { key: 'name', header: 'العميل', render: (row) => <>{row.name} {!row.active && <Badge tone="neutral">مؤرشف</Badge>}</> },
            { key: 'phone', header: 'الهاتف', render: (row) => row.phone ?? '—' },
            { key: 'address', header: 'العنوان', render: (row) => row.address ?? '—' },
            { key: 'orders', header: 'الطلبات', numeric: true, render: (row) => String(row.orderCount) },
            { key: 'total', header: 'إجمالي الطلبات', numeric: true, render: (row) => fmtMoney(row.totalMinor) },
            { key: 'due', header: 'المتبقي', numeric: true, render: (row) => fmtMoney(row.remainingMinor) },
            {
              key: 'actions', header: '', render: (row) => (
                <div className="row-actions">
                  <button type="button" className="icon-btn" title="سجل العميل" aria-label="سجل العميل" onClick={() => openHistory(row)}><Eye size={15} aria-hidden="true" /></button>
                  {can(P.customers.manage) && (
                    <Button variant="ghost" size="sm" onClick={() => { setEditing(row); setError(undefined) }}>تعديل</Button>
                  )}
                  {/* Archiving is its own decision, and permanent
                      deletion its own again — neither rides along with
                      "may correct a customer's details". */}
                  {can(P.customers.archive) && (
                    <button type="button" className="icon-btn" title={row.active ? 'أرشفة العميل' : 'استعادة العميل'} aria-label={row.active ? 'أرشفة العميل' : 'استعادة العميل'} onClick={() => openAction(row, row.active ? 'archive' : 'restore')}>
                      {row.active ? <Archive size={15} aria-hidden="true" /> : <ArchiveRestore size={15} aria-hidden="true" />}
                    </button>
                  )}
                  {can(P.customers.manage) && !row.hasHistory && (
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف نهائي" aria-label="حذف نهائي" onClick={() => openAction(row, 'remove')}><Trash2 size={15} aria-hidden="true" /></button>
                  )}
                </div>
              )
            }
          ]}
        />
        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={searchPending || list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} />
        </>}
        </CustomerQuery>
      </Card>

      <Modal open={Boolean(action)} title={action?.kind === 'archive' ? 'أرشفة العميل' : action?.kind === 'restore' ? 'استعادة العميل' : 'حذف نهائي'}
        onClose={() => { if (!processing) setAction(undefined) }}
        footer={<><Button disabled={processing || (action?.kind === 'remove' && confirmation.trim() !== action.customer.name.trim())} onClick={() => void changeLifecycle()}>{processing ? 'جارٍ التنفيذ…' : action?.kind === 'archive' ? 'أرشفة العميل' : action?.kind === 'restore' ? 'استعادة العميل' : 'حذف نهائي'}</Button><Button variant="secondary" disabled={processing} onClick={() => setAction(undefined)}>إلغاء</Button></>}>
        <ErrorNote>{actionError}</ErrorNote>
        {action?.kind === 'archive' ? <p>هل تريد أرشفة العميل «{action.customer.name}»؟ ستبقى الطلبات والفواتير والمدفوعات السابقة محفوظة، ولن يكون العميل متاحًا للمعاملات الجديدة.</p>
          : action?.kind === 'restore' ? <p>هل تريد استعادة العميل «{action.customer.name}»؟ سيصبح متاحًا للمعاملات الجديدة مرة أخرى.</p>
          : <><p>سيُحذف العميل «{action?.customer.name}» نهائياً. يسمح بذلك فقط عند عدم وجود معاملات مرتبطة به.</p><Field label="اكتب اسم العميل للتأكيد"><Input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></Field></>}
      </Modal>
      <Modal open={Boolean(historyFor)} wide title={`سجل العميل — ${historyFor?.name ?? ''}`} onClose={() => setHistoryFor(undefined)}>
        {historyFor && !historyFor.active && <Badge tone="neutral">مؤرشف</Badge>}
        <ErrorNote>{historyOrders.error ?? historyPayments.error ?? historyPreliminary.error ?? historyApproved.error}</ErrorNote>
        <p>المتبقي: {fmtMoney(history?.balance?.remainingMinor ?? 0)}</p>
        {historyFor && <>
          <h3>طلبات العملاء</h3>
          <DataTable loading={historyOrders.loading && historyOrders.items.length === 0} rows={historyOrders.items} rowKey={(row) => row.id} columns={[{ key: 'number', header: 'الطلب', render: (row) => row.documentNumber }, { key: 'status', header: 'الحالة', render: (row) => ({ confirmed: 'مؤكد', cancelled: 'ملغى', completed: 'مكتمل' }[row.status] ?? row.status) }, { key: 'total', header: 'الإجمالي', render: (row) => fmtMoney(row.totalMinor) }]} />
          <LoadMore hasNext={historyOrders.hasNext} loading={historyOrders.loading} onClick={() => void historyOrders.next()} />
          <h3>الفواتير المبدئية</h3>
          <DataTable loading={historyPreliminary.loading && historyPreliminary.items.length === 0} rows={historyPreliminary.items} rowKey={(row) => row.id} columns={[{ key: 'number', header: 'الفاتورة', render: (row) => row.documentNumber }, { key: 'total', header: 'الإجمالي', render: (row) => fmtMoney(row.totalMinor) }]} />
          <LoadMore hasNext={historyPreliminary.hasNext} loading={historyPreliminary.loading} onClick={() => void historyPreliminary.next()} />
          <h3>الفواتير المعتمدة</h3>
          <DataTable loading={historyApproved.loading && historyApproved.items.length === 0} rows={historyApproved.items} rowKey={(row) => row.id} columns={[{ key: 'number', header: 'الفاتورة', render: (row) => row.documentNumber }, { key: 'total', header: 'الإجمالي', render: (row) => fmtMoney(row.totalMinor) }]} />
          <LoadMore hasNext={historyApproved.hasNext} loading={historyApproved.loading} onClick={() => void historyApproved.next()} />
          <h3>المدفوعات</h3>
          <DataTable loading={historyPayments.loading && historyPayments.items.length === 0} rows={historyPayments.items} rowKey={(row) => row.rowKey} columns={[{ key: 'type', header: 'النوع', render: (row) => row.entryType === 'refund' ? 'استرداد دفعة' : 'دفعة عميل' }, { key: 'date', header: 'اليوم الفعلي', render: (row) => fmtDate(row.effectiveBusinessDay) }, { key: 'execution', header: 'وقت التسجيل (UTC)', render: (row) => fmtDateTime(row.executionAt) }, { key: 'amount', header: 'المبلغ', render: (row) => fmtMoney(row.amountMinor) }]} />
          <LoadMore hasNext={historyPayments.hasNext} loading={historyPayments.loading} onClick={() => void historyPayments.next()} />
        </>}
      </Modal>

      <Modal
        open={Boolean(editing)}
        title={editing?.id ? 'تعديل عميل' : 'عميل جديد'}
        onClose={() => setEditing(undefined)}
        footer={<>
          <Button onClick={() => void save()}>حفظ</Button>
          <Button variant="secondary" onClick={() => setEditing(undefined)}>إلغاء</Button>
        </>}
      >
        <ErrorNote>{error}</ErrorNote>
        <Field label="اسم العميل" required>
          <Input value={editing?.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
        </Field>
        <Field label="رقم الهاتف">
          <Input value={editing?.phone ?? ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
        </Field>
        <Field label="العنوان">
          <Input value={editing?.address ?? ''} onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
        </Field>
        <Field label="ملاحظات">
          <Textarea value={editing?.notes ?? ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
        </Field>
      </Modal>
    </>
  )
}
