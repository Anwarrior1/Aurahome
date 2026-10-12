import { useRef, useState, type ReactElement } from 'react'
import { ArrowUpFromLine, Pencil, Trash2, Wallet } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Pager, Select, Stat } from '@renderer/components/ui'
import { fmtMoney, fmtDate, fromMinor, toMinor } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface Withdrawal {
  id: number
  amountMinor: number
  withdrawnAt: string
  person: string | null
  notes: string | null
  cashAccountId: number | null
  createdAt: string
}

function snapshot(row: Withdrawal) {
  const { amountMinor, person, notes, withdrawnAt, cashAccountId, createdAt } = row
  return { amountMinor, person, notes, withdrawnAt, cashAccountId, createdAt }
}

/** Company-wide figures from main, independent of the visible page. */
interface WithdrawalSummary {
  availableMinor: number
  totalWithdrawnMinor: number
}

export function WithdrawalsPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [form, setForm] = useState<{ amount: string; person: string; notes: string; accountId: string } | undefined>()
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<{
    row: Withdrawal
    amount: string
    person: string
    notes: string
  }>()
  const [deleting, setDeleting] = useState<Withdrawal>()
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)

  const list = usePagedQuery<Withdrawal, WithdrawalSummary>('profit', 'withdrawals', {})
  const accounts = useQuery<Array<{ id: number; name: string }>>('cash', 'accounts')

  async function submit(): Promise<void> {
    if (!form) return
    try {
      await financialCall(
        'profit',
        'recordWithdrawal',
        {
          amountMinor: Math.round(Number(form.amount || 0) * 1000),
          person: form.person || undefined,
          notes: form.notes || undefined,
          cashAccountId: form.accountId ? Number(form.accountId) : undefined
        },
        'profit.recordWithdrawal'
      )
      toast.show('تم تسجيل سحب الأرباح', 'success')
      setForm(undefined)
      setError(undefined)
      await list.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر التسجيل')
    }
  }

  async function correctWithdrawal(mode: 'edit' | 'delete'): Promise<void> {
    const row = mode === 'edit' ? editing?.row : deleting
    if (!row || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(undefined)
    try {
      await call('profit', mode === 'edit' ? 'updateWithdrawal' : 'removeWithdrawal', {
        id: row.id,
        expected: snapshot(row),
        ...(mode === 'edit' && editing
          ? {
              amountMinor: toMinor(editing.amount),
              person: editing.person || null,
              notes: editing.notes || null
            }
          : {})
      })
      setEditing(undefined)
      setDeleting(undefined)
      toast.show(mode === 'edit' ? 'تم تعديل سحب الأرباح' : 'تم حذف سحب الأرباح', 'success')
      // Query hooks read authoritative persisted data again, including any
      // mounted Dashboard/profit/cash widgets. No displayed total is patched.
      window.dispatchEvent(new Event('profit-withdrawals-changed'))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ العملية')
      if (err instanceof ApiError && (err.code === 'CONFLICT' || err.code === 'NOT_FOUND')) await list.reload()
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="مسحوبات الأرباح"
        subtitle="سحب المالك من صافي الربح المحتسب — لا تُعامل كمصروف تشغيلي ولا تُخفّض ربحية التشغيل"
        actions={
          can(P.withdrawals.manage) && (
            <Button
              onClick={() => {
                setForm({ amount: '', person: '', notes: '', accountId: '' })
                setError(undefined)
              }}
            >
              + سحب أرباح
            </Button>
          )
        }
      />
      <div className="grid grid--2" style={{ marginBottom: 14 }}>
        <Stat label="الأرباح المتاحة للسحب" value={fmtMoney(list.summary?.availableMinor ?? 0)} tone="brand" hint="صافي الربح التراكمي − مخصصات الادخار − المسحوبات السابقة" icon={<Wallet size={20} strokeWidth={2.25} />} />
        <Stat label="إجمالي المسحوب" value={fmtMoney(list.summary?.totalWithdrawnMinor ?? 0)} icon={<ArrowUpFromLine size={20} strokeWidth={2.25} />} />
      </div>
      <Card>
        <DataTable
          loading={list.loading}
          rows={list.items}
          rowKey={(row) => row.id}
          empty="لا توجد مسحوبات"
          columns={[
            { key: 'date', header: 'التاريخ', render: (row) => fmtDate(row.withdrawnAt) },
            {
              key: 'amount',
              header: 'المبلغ',
              numeric: true,
              render: (row) => fmtMoney(row.amountMinor)
            },
            { key: 'person', header: 'المستلم', render: (row) => row.person ?? '—' },
            { key: 'notes', header: 'ملاحظات', render: (row) => row.notes ?? '—' },
            ...(can(P.withdrawals.manage)
              ? [
                  {
                    key: 'actions',
                    header: '',
                    render: (row: Withdrawal) => (
                      <div className="row-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="تعديل"
                          aria-label="تعديل"
                          disabled={busy}
                          onClick={() => {
                            setEditing({
                              row,
                              amount: fromMinor(row.amountMinor),
                              person: row.person ?? '',
                              notes: row.notes ?? ''
                            })
                            setError(undefined)
                          }}
                        >
                          <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="icon-btn icon-btn--danger"
                          title="حذف"
                          aria-label="حذف"
                          disabled={busy}
                          onClick={() => {
                            setDeleting(row)
                            setError(undefined)
                          }}
                        >
                          <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                        </button>
                      </div>
                    )
                  }
                ]
              : [])
          ]}
        />
        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} />
      </Card>

      <Modal
        open={Boolean(editing)}
        title="تعديل سحب الأرباح"
        onClose={() => {
          if (!busy) setEditing(undefined)
        }}
        footer={
          <>
            <Button disabled={busy} onClick={() => void correctWithdrawal('edit')}>
              حفظ
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">
          سحب #{editing?.row.id} — {fmtDate(editing?.row.withdrawnAt)}
        </p>
        <Field label="المبلغ (د.ل)" required>
          <Input type="number" step="0.001" disabled={busy} value={editing?.amount ?? ''} onChange={(e) => setEditing({ ...editing!, amount: e.target.value })} />
        </Field>
        <Field label="المستلم">
          <Input disabled={busy} value={editing?.person ?? ''} onChange={(e) => setEditing({ ...editing!, person: e.target.value })} />
        </Field>
        <Field label="ملاحظات">
          <Input disabled={busy} value={editing?.notes ?? ''} onChange={(e) => setEditing({ ...editing!, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={Boolean(deleting)}
        title="حذف سحب الأرباح"
        onClose={() => {
          if (!busy) setDeleting(undefined)
        }}
        footer={
          <>
            <Button variant="destructive" disabled={busy} onClick={() => void correctWithdrawal('delete')}>
              تأكيد الحذف
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setDeleting(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p>
          هل تريد حذف سحب #{deleting?.id} بقيمة {fmtMoney(deleting?.amountMinor)} للمستلم {deleting?.person ?? '—'} بتاريخ {fmtDate(deleting?.withdrawnAt)}؟
        </p>
        <p className="muted">سيُعاد المبلغ إلى الأرباح المتاحة ورصيد الحساب المرتبط، مع الاحتفاظ بسجل التدقيق.</p>
      </Modal>

      <Modal
        open={Boolean(form)}
        title="سحب من الأرباح"
        onClose={() => setForm(undefined)}
        footer={
          <>
            <Button onClick={() => void submit()}>تسجيل السحب</Button>
            <Button variant="secondary" onClick={() => setForm(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">لا يمكن سحب مبلغ يتجاوز الأرباح المتاحة ({fmtMoney(list.summary?.availableMinor ?? 0)}).</p>
        <Field label="المبلغ (د.ل)" required>
          <Input type="number" step="0.01" value={form?.amount ?? ''} onChange={(e) => setForm({ ...form!, amount: e.target.value })} />
        </Field>
        <Field label="المستلم">
          <Input value={form?.person ?? ''} onChange={(e) => setForm({ ...form!, person: e.target.value })} />
        </Field>
        <Field label="الحساب النقدي">
          <Select value={form?.accountId ?? ''} onChange={(e) => setForm({ ...form!, accountId: e.target.value })}>
            <option value="">— بدون —</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ملاحظات">
          <Input value={form?.notes ?? ''} onChange={(e) => setForm({ ...form!, notes: e.target.value })} />
        </Field>
      </Modal>
    </>
  )
}
