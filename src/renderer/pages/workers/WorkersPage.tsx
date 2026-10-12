import { useState, type ReactElement } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import type { CursorPage } from '@shared/pagination/cursor-page'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, DataTable, ErrorNote, Field, Input, LoadMore, Modal, PageHeader, Select, Textarea, Toolbar } from '@renderer/components/ui'
import { fmtMoney, fmtDateTime } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface Worker {
  id: number
  name: string
  phone: string | null
  defaultMethod: string
  defaultCostingUnit: string | null
  defaultRateMicro: number | null
  active: boolean
  notes: string | null
  /** Recognised production commission the factory still owes (CC04). */
  payableMinor: number
  /** Withdrawals − returns: what the worker owes the factory. Never netted with payableMinor. */
  debtMinor: number
}
interface Statement {
  worker: Worker
  payableMinor: number
  debtMinor: number
  transactions: CursorPage<WorkerTransaction>
}
interface WorkerTransaction {
  id: number
  workerId: number
  kind: string
  amountMinor: number
  orderId: number | null
  reversalOfTransactionId: number | null
  cashAccountId: number | null
  notes: string | null
  createdAt: string
  manual: boolean
}
const TX: Record<string, { label: string; tone: 'success' | 'warning' | 'info' | 'neutral' }> = {
  withdrawal: { label: 'سحب', tone: 'warning' },
  repayment: { label: 'إرجاع', tone: 'info' }
}

export function WorkersPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{ id?: number; name: string; phone: string; notes: string; active: boolean } | undefined>()
  const [statementFor, setStatementFor] = useState<Worker | undefined>()
  const [tx, setTx] = useState<
    | {
        id?: number
        expected?: WorkerTransaction
        workerId: number
        kind: string
        amount: string
        accountId: string
        notes: string
      }
    | undefined
  >()
  const [payment, setPayment] = useState<{ worker: Worker; amount: string; accountId: string; notes: string } | undefined>()
  const [error, setError] = useState<string>()
  const [busyTransactionId, setBusyTransactionId] = useState<number | 'new' | undefined>()

  const list = useQuery<Worker[]>('workers', 'list', { search, activeOnly: true })
  const accounts = useQuery<Array<{ id: number; name: string }>>('cash', 'accounts')
  const commissionAccounts = useQuery<Array<{ id: number; name: string }>>('workers', 'commissionAccounts', undefined, { enabled: can(P.workers.finance) })
  const statement = usePagedQuery<WorkerTransaction, undefined, Statement>('workers', 'statement', { id: statementFor?.id ?? 0 }, { mode: 'append', enabled: Boolean(statementFor), pageOf: (response) => response.transactions })

  async function save(): Promise<void> {
    if (!editing?.name.trim()) {
      setError('اسم العامل مطلوب')
      return
    }
    try {
      const payload = {
        name: editing.name,
        phone: editing.phone || undefined,
        notes: editing.notes || undefined
      }
      if (editing.id) await call('workers', 'update', { id: editing.id, ...payload, active: editing.active })
      else await call('workers', 'create', payload)
      toast.show('تم حفظ بيانات العامل', 'success')
      setEditing(undefined)
      setError(undefined)
      await list.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  /**
   * Deleting a worker never touches money or history: it only removes
   * them from this active list and from every future assignment
   * selector. A worker with no history anywhere is dropped for good;
   * one with assignments or financial transactions behind them is kept
   * (archived — `active=false`) purely so those historical records keep
   * resolving their name, but either way they vanish from this page and
   * from new-assignment pickers immediately (see `deleteWorker`).
   */
  async function remove(row: Worker): Promise<void> {
    if (!window.confirm(`حذف العامل «${row.name}»؟\n\nسيتم حذف العامل من قائمة العمال الحالية ومنعه من التعيينات الجديدة، ` + 'مع الاحتفاظ بسجلاته ومستحقاته السابقة.')) return
    try {
      await call('workers', 'remove', { id: row.id })
      toast.show('تم حذف العامل من قائمة العمال الحالية', 'success')
      await list.reload()
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error')
    }
  }

  async function saveTx(): Promise<void> {
    if (!tx || busyTransactionId !== undefined) return
    setBusyTransactionId(tx.id ?? 'new')
    try {
      const amountMinor = Math.round(Number(tx.amount || 0) * 1000)
      if (tx.id && tx.expected) {
        await call('workers', 'updateTransaction', {
          id: tx.id,
          expected: transactionSnapshot(tx.expected),
          amountMinor,
          cashAccountId: tx.accountId ? Number(tx.accountId) : null,
          notes: tx.notes || null
        })
      } else {
        await financialCall(
          'workers',
          'transaction',
          {
            workerId: tx.workerId,
            kind: tx.kind,
            amountMinor,
            cashAccountId: tx.accountId ? Number(tx.accountId) : undefined,
            notes: tx.notes || undefined
          },
          `workers.${tx.kind}:${tx.workerId}`
        )
      }
      toast.show(tx.id ? 'تم تعديل الحركة' : 'تم تسجيل الحركة', 'success')
      setTx(undefined)
      setError(undefined)
      await Promise.all([list.reload(), statement.reload()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ الحركة')
    } finally {
      setBusyTransactionId(undefined)
    }
  }

  async function payCommission(): Promise<void> {
    if (!payment || busyTransactionId !== undefined || commissionAccounts.loading || commissionAccounts.error) return
    if (!payment.accountId) {
      setError('اختر الخزينة أو الحساب المصرفي')
      return
    }
    setBusyTransactionId('new')
    try {
      await financialCall(
        'workers',
        'payCommission',
        {
          workerId: payment.worker.id,
          amountMinor: Math.round(Number(payment.amount || 0) * 1000),
          cashAccountId: Number(payment.accountId),
          notes: payment.notes || undefined
        },
        `workers.payCommission:${payment.worker.id}`
      )
      toast.show('تم تسجيل دفعة المستحقات', 'success')
      setPayment(undefined)
      setError(undefined)
      await Promise.all([list.reload(), commissionAccounts.reload()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تسجيل الدفعة')
    } finally {
      setBusyTransactionId(undefined)
    }
  }

  function transactionSnapshot(row: WorkerTransaction) {
    return {
      workerId: row.workerId,
      kind: row.kind,
      amountMinor: row.amountMinor,
      orderId: row.orderId,
      reversalOfTransactionId: row.reversalOfTransactionId,
      cashAccountId: row.cashAccountId,
      notes: row.notes,
      createdAt: row.createdAt
    }
  }

  function editTransaction(row: WorkerTransaction): void {
    setTx({
      id: row.id,
      expected: row,
      workerId: row.workerId,
      kind: row.kind,
      amount: String(row.amountMinor / 1000),
      accountId: row.cashAccountId ? String(row.cashAccountId) : '',
      notes: row.notes ?? ''
    })
    setError(undefined)
  }

  async function removeTransaction(row: WorkerTransaction): Promise<void> {
    if (busyTransactionId !== undefined || !window.confirm(`هل تريد حذف حركة ${TX[row.kind]?.label ?? row.kind} بقيمة ${fmtMoney(row.amountMinor)}؟`)) return
    setBusyTransactionId(row.id)
    try {
      await call('workers', 'deleteTransaction', { id: row.id, expected: transactionSnapshot(row) })
      toast.show('تم حذف الحركة وتصحيح الرصيد', 'success')
      await Promise.all([list.reload(), statement.reload()])
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر حذف الحركة', 'error')
    } finally {
      setBusyTransactionId(undefined)
    }
  }

  return (
    <>
      <PageHeader
        title="العمال"
        subtitle="عمال الإنتاج — منفصلون عن الموظفين بالراتب. تُحتسب عمولاتهم مستحقات عند إنهاء التصنيع، ومسحوباتهم دين منفصل لا يُخصم تلقائياً"
        actions={
          can(P.workers.manage) && (
            <Button
              onClick={() => {
                setEditing({ name: '', phone: '', notes: '', active: true })
                setError(undefined)
              }}
            >
              + عامل جديد
            </Button>
          )
        }
      />
      <Card>
        <Toolbar>
          <Field label="بحث">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
        </Toolbar>
        <DataTable
          loading={list.loading}
          rows={list.data ?? []}
          rowKey={(row) => row.id}
          empty="لا يوجد عمال"
          columns={[
            { key: 'name', header: 'العامل', render: (row) => row.name },
            { key: 'phone', header: 'الهاتف', render: (row) => row.phone ?? '—' },
            {
              key: 'payable',
              header: 'المستحقات',
              render: (row) => (
                <div className="row-actions">
                  <span>{fmtMoney(row.payableMinor)}</span>
                  {can(P.workers.finance) && (
                    <Button
                      size="sm"
                      disabled={row.payableMinor <= 0}
                      title={row.payableMinor > 0 ? undefined : 'لا توجد مستحقات لدفعها'}
                      onClick={() => {
                        setPayment({ worker: row, amount: '', accountId: '', notes: '' })
                        setError(undefined)
                      }}
                    >
                      دفعة
                    </Button>
                  )}
                </div>
              )
            },
            {
              key: 'debt',
              header: 'المسحوبات والمرتجعات',
              numeric: true,
              render: (row) => fmtMoney(row.debtMinor)
            },
            {
              key: 'actions',
              header: '',
              render: (row) => (
                <div className="row-actions">
                  {can(P.workers.finance) && (
                    <Button variant="secondary" size="sm" onClick={() => setStatementFor(row)}>
                      سجل المسحوبات والمرتجعات
                    </Button>
                  )}
                  {can(P.workers.finance) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setTx({
                          workerId: row.id,
                          kind: 'withdrawal',
                          amount: '',
                          accountId: '',
                          notes: ''
                        })
                        setError(undefined)
                      }}
                    >
                      حركة
                    </Button>
                  )}
                  {can(P.workers.manage) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing({
                          id: row.id,
                          name: row.name,
                          phone: row.phone ?? '',
                          notes: row.notes ?? '',
                          active: row.active
                        })
                        setError(undefined)
                      }}
                    >
                      تعديل
                    </Button>
                  )}
                  {can(P.workers.manage) && (
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void remove(row)}>
                      <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )
            }
          ]}
        />
      </Card>

      <Modal
        open={Boolean(editing)}
        title={editing?.id ? 'تعديل عامل' : 'عامل جديد'}
        onClose={() => setEditing(undefined)}
        footer={
          <>
            <Button onClick={() => void save()}>حفظ</Button>
            <Button variant="secondary" onClick={() => setEditing(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <Field label="اسم العامل" required>
          <Input value={editing?.name ?? ''} onChange={(e) => setEditing({ ...editing!, name: e.target.value })} />
        </Field>
        <Field label="رقم الهاتف">
          <Input value={editing?.phone ?? ''} onChange={(e) => setEditing({ ...editing!, phone: e.target.value })} />
        </Field>
        <Field label="ملاحظات">
          <Textarea value={editing?.notes ?? ''} onChange={(e) => setEditing({ ...editing!, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={Boolean(tx)}
        title="حركة مالية للعامل"
        onClose={() => setTx(undefined)}
        footer={
          <>
            <Button disabled={busyTransactionId !== undefined} onClick={() => void saveTx()}>
              {tx?.id ? 'حفظ' : 'تسجيل'}
            </Button>
            <Button variant="secondary" disabled={busyTransactionId !== undefined} onClick={() => setTx(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <Field label="نوع الحركة" required>
          <Select disabled={Boolean(tx?.id)} value={tx?.kind ?? 'withdrawal'} onChange={(e) => setTx({ ...tx!, kind: e.target.value })}>
            <option value="withdrawal">سحب</option>
            <option value="repayment">إرجاع</option>
          </Select>
        </Field>
        <Field label="المبلغ (د.ل)" required>
          <Input type="number" step="0.01" value={tx?.amount ?? ''} onChange={(e) => setTx({ ...tx!, amount: e.target.value })} />
        </Field>
        <Field label="الحساب النقدي">
          <Select value={tx?.accountId ?? ''} onChange={(e) => setTx({ ...tx!, accountId: e.target.value })}>
            <option value="">— بدون —</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ملاحظات">
          <Input value={tx?.notes ?? ''} onChange={(e) => setTx({ ...tx!, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={Boolean(payment)}
        title={`دفعة مستحقات: ${payment?.worker.name ?? ''}`}
        onClose={() => setPayment(undefined)}
        footer={
          <>
            <Button disabled={busyTransactionId !== undefined || commissionAccounts.loading || Boolean(commissionAccounts.error)} onClick={() => void payCommission()}>
              تأكيد الدفعة
            </Button>
            <Button variant="secondary" disabled={busyTransactionId !== undefined} onClick={() => setPayment(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <ErrorNote>{commissionAccounts.error}</ErrorNote>
        {commissionAccounts.error && <Button variant="secondary" onClick={() => void commissionAccounts.reload()}>إعادة تحميل الحسابات</Button>}
        <p>
          <strong>المستحقات الحالية: {fmtMoney(payment?.worker.payableMinor ?? 0)}</strong>
        </p>
        <p className="muted">دفعة المستحقات تخفّض ما يستحقه العامل من عمولات التصنيع فقط، ولا تغيّر المسحوبات والمرتجعات.</p>
        <Field label="مبلغ الدفعة (د.ل)" required>
          <Input type="number" step="0.01" value={payment?.amount ?? ''} onChange={(e) => setPayment({ ...payment!, amount: e.target.value })} />
        </Field>
        <Field label="الخزينة / الحساب المصرفي" required>
          <Select value={payment?.accountId ?? ''} onChange={(e) => setPayment({ ...payment!, accountId: e.target.value })}>
            <option value="">— اختر —</option>
            {(commissionAccounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ملاحظات">
          <Input value={payment?.notes ?? ''} onChange={(e) => setPayment({ ...payment!, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={Boolean(statementFor)}
        wide
        title={`سجل المسحوبات والمرتجعات: ${statementFor?.name ?? ''}`}
        onClose={() => setStatementFor(undefined)}
        footer={
          <Button variant="secondary" onClick={() => setStatementFor(undefined)}>
            إغلاق
          </Button>
        }
      >
        <p>
          <strong>المسحوبات والمرتجعات المستحقة على العامل: {fmtMoney(statement.response?.debtMinor ?? 0)}</strong>
        </p>
        <p className="muted">= المسحوبات − المرتجعات. منفصل عن مستحقات العامل ({fmtMoney(statement.response?.payableMinor ?? 0)}) ولا يُخصم منها تلقائياً.</p>
        <DataTable
          loading={statement.loading && statement.items.length === 0}
          rows={statement.items}
          rowKey={(row) => row.id}
          empty="لا توجد حركات"
          columns={[
            { key: 'date', header: 'التاريخ', render: (row) => fmtDateTime(row.createdAt) },
            {
              key: 'kind',
              header: 'النوع',
              render: (row) => <Badge tone={TX[row.kind]?.tone ?? 'neutral'}>{TX[row.kind]?.label ?? row.kind}</Badge>
            },
            {
              key: 'amount',
              header: 'المبلغ',
              numeric: true,
              render: (row) => fmtMoney(row.amountMinor)
            },
            { key: 'notes', header: 'ملاحظات', render: (row) => row.notes ?? '—' },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                row.manual && can(P.workers.finance) ? (
                  <div className="row-actions">
                    <button type="button" className="icon-btn" title="تعديل" aria-label="تعديل" disabled={busyTransactionId !== undefined} onClick={() => editTransaction(row)}>
                      <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" disabled={busyTransactionId !== undefined} onClick={() => void removeTransaction(row)}>
                      <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </div>
                ) : null
            }
          ]}
        />
        <LoadMore hasNext={statement.hasNext} loading={statement.loading} onClick={() => void statement.next()} />
      </Modal>
    </>
  )
}
