import { useState, type ReactElement } from 'react'
import { Eye, Pencil, Trash2 } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import type { CursorPage } from '@shared/pagination/cursor-page'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Button, Card, DataTable, ErrorNote, Field, Input, LoadMore, Modal, PageHeader, Textarea, Toolbar } from '@renderer/components/ui'
import { fmtDate, fmtMoney, toMinor, todayIso } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface Supplier {
  id: number
  name: string
  phone: string | null
  address: string | null
  notes: string | null
}
interface Balance {
  supplierId: number
  name: string
  purchasedMinor: number
  paidMinor: number
  remainingMinor: number
}
interface FullDeletePreview {
  supplierId: number
  name: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}
interface SupplierPayment {
  id: number
  supplierId: number
  purchaseId: number | null
  amountMinor: number
  cashAccountId: number | null
  paidAt: string
  notes: string | null
  purchaseDocumentNumber: string | null
}
interface SupplierStatement {
  supplier: Supplier
  payments: CursorPage<SupplierPayment>
}

export function SuppliersPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Partial<Supplier> | undefined>()
  const [paying, setPaying] = useState<Balance | undefined>()
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string>()
  const [deleteDialog, setDeleteDialog] = useState<{
    row: Supplier
    preview: FullDeletePreview
    confirmation: string
    error?: string
  }>()
  const [statementFor, setStatementFor] = useState<Supplier>()
  const [editingPayment, setEditingPayment] = useState<SupplierPayment>()
  const [paymentForm, setPaymentForm] = useState({
    amount: '',
    paidAt: todayIso(),
    cashAccountId: '',
    notes: ''
  })
  const [paymentBusyId, setPaymentBusyId] = useState<number>()

  const list = useQuery<Supplier[]>('suppliers', 'list', { search })
  const balances = useQuery<Balance[]>('suppliers', 'balances', { search })
  const accounts = useQuery<Array<{ id: number; name: string }>>('cash', 'accounts')
  const [accountId, setAccountId] = useState('')
  const byId = new Map(balances.data?.map((row) => [row.supplierId, row]))
  const accountById = new Map(accounts.data?.map((account) => [account.id, account.name]))

  // Only the payments section is shown; each payment carries its own
  // purchase document number, so no purchase history is loaded for lookup.
  const statementPayments = usePagedQuery<SupplierPayment, undefined, SupplierStatement>('suppliers', 'statement', {
    id: statementFor?.id ?? 0, sections: ['payments']
  }, { mode: 'append', enabled: Boolean(statementFor), pageOf: (response) => response.payments })

  function openStatement(row: Supplier): void {
    setStatementFor(row)
  }

  async function refreshStatement(): Promise<void> {
    await statementPayments.reload()
  }

  function editPayment(payment: SupplierPayment): void {
    setEditingPayment(payment)
    setPaymentForm({
      amount: String(payment.amountMinor / 1000),
      paidAt: payment.paidAt.slice(0, 10),
      cashAccountId: payment.cashAccountId ? String(payment.cashAccountId) : '',
      notes: payment.notes ?? ''
    })
    setError(undefined)
  }

  async function savePaymentEdit(): Promise<void> {
    if (!editingPayment) return
    setPaymentBusyId(editingPayment.id)
    try {
      await call('purchases', 'updateSupplierPayment', {
        id: editingPayment.id,
        amountMinor: toMinor(paymentForm.amount),
        paidAt: paymentForm.paidAt,
        cashAccountId: paymentForm.cashAccountId ? Number(paymentForm.cashAccountId) : null,
        notes: paymentForm.notes || null
      })
      toast.show('تم تعديل الدفعة وتصحيح أثرها المالي', 'success')
      setEditingPayment(undefined)
      setError(undefined)
      await Promise.all([balances.reload(), refreshStatement()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تعديل الدفعة')
    } finally {
      setPaymentBusyId(undefined)
    }
  }

  async function deletePayment(payment: SupplierPayment): Promise<void> {
    const supplierName = statementFor?.name ?? ''
    if (!window.confirm(`هل تريد حذف هذه الدفعة؟\nالمورد: ${supplierName}\nالمبلغ: ${fmtMoney(payment.amountMinor)}\nالتاريخ: ${fmtDate(payment.paidAt)}`)) return
    setPaymentBusyId(payment.id)
    try {
      await call('purchases', 'deleteSupplierPayment', { id: payment.id })
      toast.show('تم حذف الدفعة وعكس أثرها المالي', 'success')
      await Promise.all([balances.reload(), refreshStatement()])
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر حذف الدفعة', 'error')
    } finally {
      setPaymentBusyId(undefined)
    }
  }

  async function save(): Promise<void> {
    if (!editing?.name?.trim()) {
      setError('اسم المورد مطلوب')
      return
    }
    try {
      const payload = {
        name: editing.name,
        phone: editing.phone ?? null,
        address: editing.address ?? null,
        notes: editing.notes ?? null
      }
      if (editing.id) await call('suppliers', 'update', { id: editing.id, ...payload })
      else await call('suppliers', 'create', payload)
      toast.show('تم حفظ بيانات المورد', 'success')
      setEditing(undefined)
      setError(undefined)
      await Promise.all([list.reload(), balances.reload()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  /**
   * The plain, safe delete stays the default — it only ever removes a
   * supplier with nothing attached to it. Only when it is blocked (a
   * purchase invoice already exists) does this offer the explicit,
   * permanent cascade delete, and only to someone who actually holds
   * that separate high-level permission.
   */
  async function remove(row: Supplier): Promise<void> {
    if (!window.confirm(`هل تريد حذف المورد "${row.name}"؟`)) return
    try {
      await call('suppliers', 'remove', { id: row.id })
      toast.show('تم حذف المورد', 'success')
      await Promise.all([list.reload(), balances.reload()])
    } catch (err) {
      if (err instanceof ApiError && can(P.suppliers.fullDelete)) {
        try {
          const preview = await call<FullDeletePreview>('suppliers', 'fullDeletePreview', {
            id: row.id
          })
          setDeleteDialog({ row, preview, confirmation: '' })
          return
        } catch (previewErr) {
          toast.show(previewErr instanceof ApiError ? previewErr.message : 'تعذر فحص المورد', 'error')
          return
        }
      }
      toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error')
    }
  }

  async function fullDeleteFromDialog(): Promise<void> {
    if (!deleteDialog) return
    if (deleteDialog.confirmation.trim() !== deleteDialog.row.name.trim()) {
      setDeleteDialog({
        ...deleteDialog,
        error: `اكتب اسم المورد "${deleteDialog.row.name}" للتأكيد النهائي`
      })
      return
    }
    try {
      await call('suppliers', 'fullDelete', {
        id: deleteDialog.row.id,
        confirmation: deleteDialog.confirmation
      })
      toast.show('تم حذف المورد بالكامل مع كل بياناته المرتبطة', 'success')
      setDeleteDialog(undefined)
      await Promise.all([list.reload(), balances.reload()])
    } catch (err) {
      setDeleteDialog({
        ...deleteDialog,
        error: err instanceof ApiError ? err.message : 'تعذر حذف المورد بالكامل'
      })
    }
  }

  async function pay(): Promise<void> {
    if (!paying) return
    try {
      await financialCall(
        'purchases',
        'pay',
        {
          supplierId: paying.supplierId,
          amountMinor: toMinor(amount),
          cashAccountId: accountId ? Number(accountId) : undefined
        },
        `purchases.pay:${paying.supplierId}`
      )
      toast.show('تم تسجيل دفعة المورد', 'success')
      setPaying(undefined)
      setAmount('')
      setError(undefined)
      await balances.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تسجيل الدفعة')
    }
  }

  return (
    <>
      <PageHeader
        title="الموردون"
        subtitle="بيانات الموردين وأرصدتهم المستحقة"
        actions={
          can(P.suppliers.manage) && (
            <Button
              onClick={() => {
                setEditing({})
                setError(undefined)
              }}
            >
              + مورد جديد
            </Button>
          )
        }
      />
      <Card>
        <Toolbar>
          <Field label="بحث">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="اسم المورد" />
          </Field>
        </Toolbar>
        <DataTable
          loading={list.loading}
          rows={list.data ?? []}
          rowKey={(row) => row.id}
          empty="لا يوجد موردون"
          columns={[
            { key: 'name', header: 'المورد', render: (row) => row.name },
            { key: 'phone', header: 'الهاتف', render: (row) => row.phone ?? '—' },
            {
              key: 'purchased',
              header: 'إجمالي المشتريات',
              numeric: true,
              render: (row) => fmtMoney(byId.get(row.id)?.purchasedMinor ?? 0)
            },
            {
              key: 'paid',
              header: 'المدفوع',
              numeric: true,
              render: (row) => fmtMoney(byId.get(row.id)?.paidMinor ?? 0)
            },
            {
              key: 'due',
              header: 'المستحق',
              numeric: true,
              render: (row) => fmtMoney(byId.get(row.id)?.remainingMinor ?? 0)
            },
            {
              key: 'actions',
              header: '',
              render: (row) => (
                <div className="row-actions">
                  {can(P.suppliers.view) && (
                    <button type="button" className="icon-btn" title="عرض دفعات المورد" aria-label="عرض دفعات المورد" onClick={() => openStatement(row)}>
                      <Eye size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                  {can(P.suppliers.manage) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(row)
                        setError(undefined)
                      }}
                    >
                      تعديل
                    </Button>
                  )}
                  {can(P.purchases.paySupplier) && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setPaying(byId.get(row.id))
                        setError(undefined)
                      }}
                    >
                      دفعة
                    </Button>
                  )}
                  {can(P.suppliers.manage) && (
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
        title={editing?.id ? 'تعديل مورد' : 'مورد جديد'}
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
        <Field label="اسم المورد" required>
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

      <Modal
        open={Boolean(paying)}
        title={`دفعة للمورد: ${paying?.name ?? ''}`}
        onClose={() => setPaying(undefined)}
        footer={
          <>
            <Button onClick={() => void pay()}>تسجيل الدفعة</Button>
            <Button variant="secondary" onClick={() => setPaying(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">المستحق حالياً: {fmtMoney(paying?.remainingMinor ?? 0)}</p>
        <Field label="المبلغ (د.ل)" required>
          <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="الحساب النقدي">
          <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">— بدون —</option>
            {(accounts.data ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
      </Modal>

      <Modal
        open={Boolean(statementFor)}
        wide
        title={`دفعات المورد: ${statementFor?.name ?? ''}`}
        onClose={() => setStatementFor(undefined)}
        footer={
          <Button variant="secondary" onClick={() => setStatementFor(undefined)}>
            إغلاق
          </Button>
        }
      >
        <DataTable
          loading={statementPayments.loading && statementPayments.items.length === 0}
          rows={statementPayments.items}
          rowKey={(payment) => payment.id}
          empty="لا توجد دفعات مسجّلة"
          columns={[
            {
              key: 'invoice',
              header: 'فاتورة الشراء',
              render: (payment) => payment.purchaseDocumentNumber ?? 'دفعة عامة'
            },
            {
              key: 'amount',
              header: 'المبلغ',
              numeric: true,
              render: (payment) => fmtMoney(payment.amountMinor)
            },
            { key: 'date', header: 'التاريخ', render: (payment) => fmtDate(payment.paidAt) },
            {
              key: 'account',
              header: 'الحساب',
              render: (payment) => (payment.cashAccountId ? (accountById.get(payment.cashAccountId) ?? `#${payment.cashAccountId}`) : '—')
            },
            { key: 'notes', header: 'ملاحظات', render: (payment) => payment.notes ?? '—' },
            {
              key: 'actions',
              header: '',
              render: (payment) => (
                <div className="row-actions">
                  {can(P.purchases.editSupplierPayment) && (
                    <button type="button" className="icon-btn" title="تعديل الدفعة" aria-label="تعديل الدفعة" disabled={paymentBusyId !== undefined} onClick={() => editPayment(payment)}>
                      <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                  {can(P.purchases.deleteSupplierPayment) && (
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف الدفعة" aria-label="حذف الدفعة" disabled={paymentBusyId !== undefined} onClick={() => void deletePayment(payment)}>
                      <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )
            }
          ]}
        />
        <ErrorNote>{statementPayments.error}</ErrorNote>
        <LoadMore hasNext={statementPayments.hasNext} loading={statementPayments.loading} onClick={() => void statementPayments.next()} />
      </Modal>

      <Modal
        open={Boolean(editingPayment)}
        title="تعديل الدفعة"
        onClose={() => {
          if (!paymentBusyId) setEditingPayment(undefined)
        }}
        footer={
          <>
            <Button disabled={paymentBusyId !== undefined} onClick={() => void savePaymentEdit()}>
              حفظ التعديل
            </Button>
            <Button variant="secondary" disabled={paymentBusyId !== undefined} onClick={() => setEditingPayment(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <Field label="المبلغ (د.ل)" required>
          <Input type="number" step="0.01" value={paymentForm.amount} onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })} />
        </Field>
        <Field label="تاريخ الدفعة" required>
          <Input type="date" value={paymentForm.paidAt} onChange={(e) => setPaymentForm({ ...paymentForm, paidAt: e.target.value })} />
        </Field>
        <Field label="الحساب النقدي">
          <select className="input" value={paymentForm.cashAccountId} onChange={(e) => setPaymentForm({ ...paymentForm, cashAccountId: e.target.value })}>
            <option value="">— بدون —</option>
            {(accounts.data ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ملاحظات">
          <Textarea value={paymentForm.notes} onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={Boolean(deleteDialog)}
        wide
        title="تأكيد حذف المورد بالكامل"
        onClose={() => setDeleteDialog(undefined)}
        footer={
          <>
            <Button variant="destructive" disabled={Boolean(deleteDialog?.preview.blockers.length)} onClick={() => void fullDeleteFromDialog()}>
              حذف نهائي
            </Button>
            <Button variant="secondary" onClick={() => setDeleteDialog(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{deleteDialog?.error}</ErrorNote>
        <p>هذا المورد مرتبط بفواتير شراء ودفعات وحركات مالية/مخزنية. سيؤدي حذف المورد إلى حذف جميع البيانات المرتبطة به نهائيًا. هل تريد المتابعة؟</p>
        <p style={{ fontWeight: 600, fontSize: 12.5 }}>سيتم حذف:</p>
        <ul>
          <li>المورد: 1</li>
          {(deleteDialog?.preview.dependencies ?? []).map((item) => (
            <li key={item.key}>
              {item.label}: {item.count}
            </li>
          ))}
        </ul>
        {(deleteDialog?.preview.blockers.length ?? 0) > 0 && <div className="error-note">لا يمكن تنفيذ الحذف الكامل حالياً: {deleteDialog!.preview.blockers.join('، ')}</div>}
        <p className="muted">هذا الإجراء نهائي ولا يمكن التراجع عنه.</p>
        <Field label={`اكتب اسم المورد "${deleteDialog?.row.name ?? ''}" للتأكيد`} required>
          <Input value={deleteDialog?.confirmation ?? ''} onChange={(e) => setDeleteDialog(deleteDialog ? { ...deleteDialog, confirmation: e.target.value, error: undefined } : undefined)} />
        </Field>
      </Modal>
    </>
  )
}
