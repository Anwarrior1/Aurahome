import { useState, type ReactElement } from 'react'
import { Banknote, Pencil, SlidersHorizontal, Trash2, Wallet } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Pager, Select, Stat, Toolbar } from '@renderer/components/ui'
import { fmtMoney, fmtDateTime, fmtDateSlash } from '@renderer/lib/format'
import { useSelectedDate } from '@renderer/state/selected-date.store'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { businessDate } from '@shared/business-date'

interface Account {
  id: number
  name: string
  kind: string
  openingBalanceMinor: number
  active: boolean
  balanceMinor: number
  currentBalanceMinor: number
  transactionCount: number
}
interface Tx {
  id: number
  accountId: number
  direction: string
  amountMinor: number
  kind: string
  notes: string | null
  occurredAt: string
  transferGroup: string | null
  refTable: string | null
  manual: boolean
}
interface FullDeletePreview {
  accountId: number
  name: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}

const KIND_LABELS: Record<string, string> = {
  customer_payment: 'تحصيل من عميل',
  supplier_payment: 'دفع لمورد',
  salary: 'راتب',
  worker_withdrawal: 'سحب عامل',
  worker_repayment: 'إرجاع عامل',
  worker_commission_payment: 'دفعة مستحقات عامل',
  employee_advance: 'سلفة موظف',
  employee_repayment: 'سداد سلفة',
  expense: 'مصروف',
  profit_withdrawal: 'سحب أرباح',
  savings_usage: 'استخدام من الادخار',
  transfer_in: 'تحويل وارد',
  transfer_out: 'تحويل صادر',
  balance_adjustment: 'تسوية رصيد'
}

export function CashPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [accountId, setAccountId] = useState('')
  const [editing, setEditing] = useState<{ id?: number; name: string; kind: string; opening: string; locked: boolean } | undefined>()
  // transferGroup present ⇒ editing an existing Cash-module transfer
  // (both legs together); absent ⇒ creating a new one. Same form either way.
  const [transfer, setTransfer] = useState<
    | {
        transferGroup?: string
        from: string
        to: string
        amount: string
        notes: string
        occurredAt: string
        initialDate?: string
      }
    | undefined
  >()
  const [adjust, setAdjust] = useState<{ accountId: number; name: string; current: number; desired: string; reason: string } | undefined>()
  const [movement, setMovement] = useState<
    | {
        id: number
        accountId: string
        direction: string
        amount: string
        notes: string
        occurredAt: string
      }
    | undefined
  >()
  const [error, setError] = useState<string>()
  const [deleteDialog, setDeleteDialog] = useState<{
    row: Account
    preview: FullDeletePreview
    confirmation: string
    error?: string
  }>()
  const { selectedDateIso, isToday } = useSelectedDate()
  // The day journal follows the global operational date; "كل الحركات"
  // lifts it when the user wants the whole ledger.
  const [dayScope, setDayScope] = useState(true)

  // Balances are AS OF the end of the selected day — opening plus every
  // movement up to it, computed in main, never by summing this page's rows.
  const accounts = useQuery<Account[]>('cash', 'accounts', {
    asOf: isToday ? undefined : selectedDateIso
  })
  const transactions = usePagedQuery<Tx>('cash', 'transactions', {
    accountId: accountId ? Number(accountId) : undefined,
    from: dayScope ? selectedDateIso : undefined,
    to: dayScope ? selectedDateIso : undefined
  })
  const total = (accounts.data ?? []).reduce((sum, a) => sum + a.balanceMinor, 0)
  const nameById = new Map(accounts.data?.map((a) => [a.id, a.name]))

  async function save(): Promise<void> {
    if (!editing?.name.trim()) {
      setError('اسم الحساب مطلوب')
      return
    }
    try {
      if (editing.id) {
        await call('cash', 'updateAccount', {
          id: editing.id,
          name: editing.name,
          kind: editing.kind,
          // الرصيد الافتتاحي (item 8): يُرسَل فقط إن كان الحقل غير مقفول (لا توجد
          // حركات على الحساب بعد) — بعد أول حركة يُمنع تعديله من الخادم أساساً.
          openingBalanceMinor: editing.locked ? undefined : Math.round(Number(editing.opening || 0) * 1000)
        })
      } else {
        await financialCall(
          'cash',
          'createAccount',
          {
            name: editing.name,
            kind: editing.kind as 'cash',
            openingBalanceMinor: Math.round(Number(editing.opening || 0) * 1000)
          },
          'cash.createAccount'
        )
      }
      toast.show('تم حفظ الحساب', 'success')
      setEditing(undefined)
      setError(undefined)
      await accounts.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  /** Item 9: never overwrite the computed balance directly — the server turns
   *  the difference into one auditable balance_adjustment cash transaction. */
  async function submitAdjust(): Promise<void> {
    if (!adjust) return
    if (!adjust.reason.trim()) {
      setError('سبب تعديل الرصيد مطلوب')
      return
    }
    const desiredMinor = Math.round(Number(adjust.desired || 0) * 1000)
    try {
      await financialCall('cash', 'adjustBalance', { accountId: adjust.accountId, desiredBalanceMinor: desiredMinor, reason: adjust.reason }, `cash.adjustBalance:${adjust.accountId}`)
      toast.show('تم تسجيل تسوية الرصيد', 'success')
      setAdjust(undefined)
      setError(undefined)
      await Promise.all([accounts.reload(), transactions.reload()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تسجيل التسوية')
    }
  }

  /**
   * The plain, safe delete stays the default — it only ever removes an
   * account with no cash movement on it at all. Only when it is
   * blocked (movements exist) does this offer the explicit, permanent
   * cascade delete, and only to someone who actually holds that
   * separate high-level permission.
   */
  async function removeAccount(row: Account): Promise<void> {
    if (!window.confirm(`هل تريد حذف الحساب "${row.name}"؟`)) return
    try {
      await call('cash', 'removeAccount', { id: row.id })
      toast.show('تم حذف الحساب', 'success')
      await accounts.reload()
    } catch (err) {
      if (err instanceof ApiError && can(P.cash.fullDelete)) {
        try {
          const preview = await call<FullDeletePreview>('cash', 'fullDeleteAccountPreview', {
            id: row.id
          })
          setDeleteDialog({ row, preview, confirmation: '' })
          return
        } catch (previewErr) {
          toast.show(previewErr instanceof ApiError ? previewErr.message : 'تعذر فحص الحساب', 'error')
          return
        }
      }
      toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error')
    }
  }

  async function fullDeleteAccountFromDialog(): Promise<void> {
    if (!deleteDialog) return
    if (deleteDialog.confirmation.trim() !== deleteDialog.row.name.trim()) {
      setDeleteDialog({
        ...deleteDialog,
        error: `اكتب اسم الحساب "${deleteDialog.row.name}" للتأكيد النهائي`
      })
      return
    }
    try {
      await call('cash', 'fullDeleteAccount', {
        id: deleteDialog.row.id,
        confirmation: deleteDialog.confirmation
      })
      toast.show('تم حذف الحساب بالكامل مع كل حركاته المرتبطة', 'success')
      setDeleteDialog(undefined)
      await Promise.all([accounts.reload(), transactions.reload()])
    } catch (err) {
      setDeleteDialog({
        ...deleteDialog,
        error: err instanceof ApiError ? err.message : 'تعذر حذف الحساب بالكامل'
      })
    }
  }

  /**
   * Part 2: a standalone movement is corrected in place and the real
   * balance follows, because the balance is always recomputed from these
   * rows. Movements generated by another transaction are refused by the
   * server, which names the screen that owns them.
   */
  async function saveMovement(): Promise<void> {
    if (!movement) return
    const amountMinor = Math.round(Number(movement.amount || 0) * 1000)
    if (amountMinor <= 0) {
      setError('المبلغ يجب أن يكون أكبر من صفر')
      return
    }
    try {
      await call('cash', 'updateTransaction', {
        id: movement.id,
        accountId: Number(movement.accountId),
        direction: movement.direction as 'in' | 'out',
        amountMinor,
        notes: movement.notes || undefined,
        occurredAt: movement.occurredAt || undefined
      })
      toast.show('تم تعديل الحركة وتحديث رصيد الحساب', 'success')
      setMovement(undefined)
      setError(undefined)
      await Promise.all([accounts.reload(), transactions.reload()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تعديل الحركة')
    }
  }

  /** One confirmation, no reason, no typed identifier. */
  async function removeMovement(row: Tx): Promise<void> {
    if (!window.confirm(`هل أنت متأكد من حذف هذه الحركة؟\n\n${KIND_LABELS[row.kind] ?? row.kind} — ${fmtMoney(row.amountMinor)}`)) return
    try {
      await call('cash', 'removeTransaction', { id: row.id })
      toast.show('تم حذف الحركة وتحديث رصيد الحساب', 'success')
      await Promise.all([accounts.reload(), transactions.reload()])
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر حذف الحركة', 'error')
    }
  }

  async function doTransfer(): Promise<void> {
    if (!transfer) return
    try {
      const payload = {
        fromAccountId: Number(transfer.from),
        toAccountId: Number(transfer.to),
        amountMinor: Math.round(Number(transfer.amount || 0) * 1000),
        notes: transfer.notes || undefined,
        // An untouched date leaves the owner's original instant/date intact.
        occurredAt: transfer.transferGroup && transfer.occurredAt === transfer.initialDate
          ? undefined
          : transfer.occurredAt || undefined
      }
      if (transfer.transferGroup) {
        // Item — both legs move together, atomically, on the server;
        // never a per-leg edit from this form.
        await call('cash', 'updateTransfer', { transferGroup: transfer.transferGroup, ...payload })
      } else {
        await financialCall('cash', 'transfer', payload, `cash.transfer:${payload.fromAccountId}:${payload.toAccountId}`)
      }
      toast.show(transfer.transferGroup ? 'تم تعديل التحويل وتحديث رصيد الحسابين' : 'تم التحويل بين الحسابين', 'success')
      setTransfer(undefined)
      setError(undefined)
      await Promise.all([accounts.reload(), transactions.reload()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر التحويل')
    }
  }

  /** Loads the authoritative, complete pair for this transfer — never
   *  guessed from the (possibly account/date-filtered) rows currently
   *  on screen — so editing from either leg shows the real other side. */
  async function openTransferEdit(row: Tx): Promise<void> {
    try {
      const t = await call<{
        transferGroup: string
        fromAccountId: number
        toAccountId: number
        amountMinor: number
        notes: string | null
        occurredAt: string
      }>('cash', 'getTransfer', { transferGroup: row.transferGroup })
      const date = t.occurredAt.length === 10 ? t.occurredAt : businessDate(new Date(t.occurredAt))
      setTransfer({
        transferGroup: t.transferGroup,
        from: String(t.fromAccountId),
        to: String(t.toAccountId),
        amount: String(t.amountMinor / 1000),
        notes: t.notes ?? '',
        occurredAt: date,
        initialDate: date
      })
      setError(undefined)
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر تحميل التحويل', 'error')
    }
  }

  /** One confirmation naming the COMPLETE transfer, then both legs are
   *  removed/voided together server-side — never one side alone. */
  async function removeTransfer(row: Tx): Promise<void> {
    try {
      const t = await call<{ fromAccountId: number; toAccountId: number; amountMinor: number }>('cash', 'getTransfer', { transferGroup: row.transferGroup })
      const fromName = nameById.get(t.fromAccountId) ?? '—'
      const toName = nameById.get(t.toAccountId) ?? '—'
      if (!window.confirm(`هل تريد حذف التحويل بمبلغ ${fmtMoney(t.amountMinor)} من "${fromName}" إلى "${toName}"؟`)) return
      await call('cash', 'removeTransfer', { transferGroup: row.transferGroup })
      toast.show('تم حذف التحويل وإرجاع أثره على الحسابين', 'success')
      await Promise.all([accounts.reload(), transactions.reload()])
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر حذف التحويل', 'error')
    }
  }

  return (
    <>
      <PageHeader
        title="الحسابات النقدية"
        subtitle="تتبّع تشغيلي للنقد فقط — التحويلات بين الحسابات ليست إيراداً ولا مصروفاً"
        actions={
          <>
            {can(P.cash.transfer) && (accounts.data?.length ?? 0) > 1 && (
              <Button
                variant="secondary"
                onClick={() => {
                  setTransfer({ from: '', to: '', amount: '', notes: '', occurredAt: '' })
                  setError(undefined)
                }}
              >
                تحويل بين حسابين
              </Button>
            )}
            {can(P.cash.manage) && (
              <Button
                onClick={() => {
                  setEditing({ name: '', kind: 'cash', opening: '', locked: false })
                  setError(undefined)
                }}
              >
                + حساب جديد
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid--4" style={{ marginBottom: 14 }}>
        <Stat label="إجمالي النقد" value={fmtMoney(total)} tone="brand" hint={isToday ? undefined : `الرصيد كما في ${fmtDateSlash(selectedDateIso)}`} icon={<Banknote size={20} strokeWidth={2.25} />} />
        {(accounts.data ?? []).slice(0, 3).map((a) => (
          <Stat key={a.id} label={a.name} value={fmtMoney(a.balanceMinor)} icon={<Wallet size={20} strokeWidth={2.25} />} />
        ))}
      </div>

      <Card title="الحسابات">
        <DataTable
          loading={accounts.loading}
          rows={accounts.data ?? []}
          rowKey={(row) => row.id}
          empty="لا توجد حسابات"
          columns={[
            { key: 'name', header: 'الحساب', render: (row) => row.name },
            {
              key: 'kind',
              header: 'النوع',
              render: (row) => <Badge tone="info">{row.kind === 'bank' ? 'بنك' : 'نقدي'}</Badge>
            },
            {
              key: 'opening',
              header: 'الرصيد الافتتاحي',
              numeric: true,
              render: (row) => fmtMoney(row.openingBalanceMinor)
            },
            {
              key: 'balance',
              header: 'الرصيد الحالي',
              numeric: true,
              render: (row) => fmtMoney(row.balanceMinor)
            },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                can(P.cash.manage) ? (
                  <div className="row-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing({
                          id: row.id,
                          name: row.name,
                          kind: row.kind,
                          opening: String(row.openingBalanceMinor / 1000),
                          locked: row.transactionCount > 0
                        })
                        setError(undefined)
                      }}
                    >
                      تعديل
                    </Button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="تعديل الرصيد"
                      aria-label="تعديل الرصيد"
                      onClick={() => {
                        setAdjust({
                          accountId: row.id,
                          name: row.name,
                          current: row.currentBalanceMinor,
                          desired: String(row.currentBalanceMinor / 1000),
                          reason: ''
                        })
                        setError(undefined)
                      }}
                    >
                      <SlidersHorizontal size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void removeAccount(row)}>
                      <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </div>
                ) : null
            }
          ]}
        />
      </Card>

      <Card title="حركة النقد">
        <Toolbar>
          <Field label="الحساب">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">كل الحسابات</option>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="النطاق">
            <Select value={dayScope ? 'day' : 'all'} onChange={(e) => setDayScope(e.target.value === 'day')}>
              <option value="day">حركات {fmtDateSlash(selectedDateIso)}</option>
              <option value="all">كل الحركات</option>
            </Select>
          </Field>
        </Toolbar>
        <DataTable
          loading={transactions.loading}
          rows={transactions.items}
          rowKey={(row) => row.id}
          empty="لا توجد حركات"
          columns={[
            { key: 'date', header: 'التاريخ', render: (row) => fmtDateTime(row.occurredAt) },
            {
              key: 'account',
              header: 'الحساب',
              render: (row) => nameById.get(row.accountId) ?? '—'
            },
            { key: 'kind', header: 'البيان', render: (row) => KIND_LABELS[row.kind] ?? row.kind },
            {
              key: 'dir',
              header: 'الاتجاه',
              render: (row) => <Badge tone={row.direction === 'in' ? 'success' : 'warning'}>{row.direction === 'in' ? 'وارد' : 'صادر'}</Badge>
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
              render: (row) => {
                // A movement generated by another module (expense, payroll,
                // purchase, payment, …) is only half of that record's
                // financial effect — it is corrected where it was created,
                // never here, regardless of any transferGroup it might
                // otherwise carry (ownership by source always wins first).
                if (row.refTable) {
                  return can(P.cash.manage) || can(P.cash.transfer) ? <span className="muted">من عملية مرتبطة</span> : null
                }
                // A transfer is fully owned by this Cash module — both legs
                // are edited/deleted together, from either leg's icons.
                if (row.transferGroup) {
                  if (!can(P.cash.transfer)) return null
                  return (
                    <div className="row-actions">
                      <button type="button" className="icon-btn" title="تعديل التحويل" aria-label="تعديل التحويل" onClick={() => void openTransferEdit(row)}>
                        <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                      </button>
                      <button type="button" className="icon-btn icon-btn--danger" title="حذف التحويل" aria-label="حذف التحويل" onClick={() => void removeTransfer(row)}>
                        <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                      </button>
                    </div>
                  )
                }
                if (!can(P.cash.manage)) return null
                return (
                  <div className="row-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="تعديل"
                      aria-label="تعديل"
                      onClick={() => {
                        setMovement({
                          id: row.id,
                          accountId: String(row.accountId),
                          direction: row.direction,
                          amount: String(row.amountMinor / 1000),
                          notes: row.notes ?? '',
                          occurredAt: row.occurredAt.slice(0, 10)
                        })
                        setError(undefined)
                      }}
                    >
                      <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void removeMovement(row)}>
                      <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </div>
                )
              }
            }
          ]}
        />
        <Pager pageIndex={transactions.pageIndex} hasPrev={transactions.hasPrev} hasNext={transactions.hasNext} loading={transactions.loading} onPrev={() => void transactions.prev()} onNext={() => void transactions.next()} />
      </Card>

      <Modal
        open={Boolean(movement)}
        title="تعديل حركة نقدية"
        onClose={() => setMovement(undefined)}
        footer={
          <>
            <Button onClick={() => void saveMovement()}>حفظ التعديل</Button>
            <Button variant="secondary" onClick={() => setMovement(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">تعديل المبلغ أو الاتجاه أو الحساب يغيّر الأثر المالي الحقيقي — يُعاد احتساب رصيد الحساب فوراً.</p>
        <Field label="الحساب" required>
          <Select value={movement?.accountId ?? ''} onChange={(e) => setMovement({ ...movement!, accountId: e.target.value })}>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="الاتجاه" required>
          <Select value={movement?.direction ?? 'in'} onChange={(e) => setMovement({ ...movement!, direction: e.target.value })}>
            <option value="in">وارد</option>
            <option value="out">صادر</option>
          </Select>
        </Field>
        <Field label="المبلغ (د.ل)" required>
          <Input type="number" step="0.01" value={movement?.amount ?? ''} onChange={(e) => setMovement({ ...movement!, amount: e.target.value })} />
        </Field>
        <Field label="التاريخ">
          <Input type="date" lang="en-GB" value={movement?.occurredAt ?? ''} onChange={(e) => setMovement({ ...movement!, occurredAt: e.target.value })} />
        </Field>
        <Field label="ملاحظات">
          <Input value={movement?.notes ?? ''} onChange={(e) => setMovement({ ...movement!, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={Boolean(editing)}
        title={editing?.id ? 'تعديل حساب' : 'حساب نقدي جديد'}
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
        <Field label="اسم الحساب" required>
          <Input value={editing?.name ?? ''} onChange={(e) => setEditing({ ...editing!, name: e.target.value })} />
        </Field>
        <Field label="النوع" required>
          <Select value={editing?.kind ?? 'cash'} onChange={(e) => setEditing({ ...editing!, kind: e.target.value })}>
            <option value="cash">صندوق نقدي</option>
            <option value="bank">حساب بنكي</option>
          </Select>
        </Field>
        {!editing?.id || !editing.locked ? (
          <Field label="الرصيد الافتتاحي (د.ل)">
            <Input type="number" step="0.01" value={editing?.opening ?? ''} onChange={(e) => setEditing({ ...editing!, opening: e.target.value })} />
          </Field>
        ) : (
          <Field label="الرصيد الافتتاحي (د.ل)" hint="تم إجراء حركات على هذا الحساب — لا يمكن تعديل الرصيد الافتتاحي بعد الآن. استخدم زر «تعديل الرصيد» لتسجيل تسوية">
            <Input type="number" step="0.01" value={editing?.opening ?? ''} disabled />
          </Field>
        )}
      </Modal>

      <Modal
        open={Boolean(transfer)}
        title={transfer?.transferGroup ? 'تعديل التحويل' : 'تحويل بين حسابين'}
        onClose={() => setTransfer(undefined)}
        footer={
          <>
            <Button onClick={() => void doTransfer()}>{transfer?.transferGroup ? 'حفظ التعديل' : 'تنفيذ التحويل'}</Button>
            <Button variant="secondary" onClick={() => setTransfer(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">{transfer?.transferGroup ? 'تعديل أي حقل يُحدَّث في طرفي التحويل معاً — لا يمكن تعديل جانب واحد بمفرده.' : 'التحويل حركة نقدية فقط ولا يُحتسب إيراداً ولا مصروفاً.'}</p>
        <Field label="من حساب" required>
          <Select value={transfer?.from ?? ''} onChange={(e) => setTransfer({ ...transfer!, from: e.target.value })}>
            <option value="">— اختر —</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({fmtMoney(a.balanceMinor)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="إلى حساب" required>
          <Select value={transfer?.to ?? ''} onChange={(e) => setTransfer({ ...transfer!, to: e.target.value })}>
            <option value="">— اختر —</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid--2">
          <Field label="المبلغ (د.ل)" required>
            <Input type="number" step="0.01" value={transfer?.amount ?? ''} onChange={(e) => setTransfer({ ...transfer!, amount: e.target.value })} />
          </Field>
          <Field label="التاريخ">
            <Input type="date" lang="en-GB" value={transfer?.occurredAt ?? ''} onChange={(e) => setTransfer({ ...transfer!, occurredAt: e.target.value })} />
          </Field>
        </div>
        <Field label="ملاحظات">
          <Input value={transfer?.notes ?? ''} onChange={(e) => setTransfer({ ...transfer!, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={Boolean(adjust)}
        title={`تعديل الرصيد: ${adjust?.name ?? ''}`}
        onClose={() => setAdjust(undefined)}
        footer={
          <>
            <Button onClick={() => void submitAdjust()}>تسجيل التسوية</Button>
            <Button variant="secondary" onClick={() => setAdjust(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">التسوية تخص الرصيد الحالي للحساب وتُسجّل الآن، حتى عند عرض تاريخ سابق. يُحسب الفرق تلقائياً ويُسجَّل كحركة تسوية جديدة، مع الاحتفاظ بكل الحركات السابقة كما هي.</p>
        <Field label="الرصيد الحالي الفعلي (د.ل)">
          <Input type="number" value={((adjust?.current ?? 0) / 1000).toFixed(2)} disabled />
        </Field>
        <Field label="الرصيد المطلوب (د.ل)" required>
          <Input type="number" step="0.01" value={adjust?.desired ?? ''} onChange={(e) => setAdjust({ ...adjust!, desired: e.target.value })} />
        </Field>
        {adjust && <p className="muted">الفرق: {fmtMoney(Math.round(Number(adjust.desired || 0) * 1000) - adjust.current)}</p>}
        <Field label="السبب / ملاحظات" required>
          <Input value={adjust?.reason ?? ''} onChange={(e) => setAdjust({ ...adjust!, reason: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={Boolean(deleteDialog)}
        wide
        title="تأكيد حذف الحساب بالكامل"
        onClose={() => setDeleteDialog(undefined)}
        footer={
          <>
            <Button variant="destructive" disabled={Boolean(deleteDialog?.preview.blockers.length)} onClick={() => void fullDeleteAccountFromDialog()}>
              حذف نهائي
            </Button>
            <Button variant="secondary" onClick={() => setDeleteDialog(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{deleteDialog?.error}</ErrorNote>
        <p>
          هذا الحساب يحتوي على حركات مالية مسجّلة. سيؤدي الحذف إلى حذف الحساب والحركات التابعة له نهائيًا، وقد يشمل ذلك حذف المستندات المصدر لتلك الحركات (مثل دفعة عميل أو مورد أو مصروف) — موضّحة أدناه. هل تريد المتابعة؟
        </p>
        <p style={{ fontWeight: 600, fontSize: 12.5 }}>سيتم حذف:</p>
        <ul>
          <li>الحساب: 1</li>
          {(deleteDialog?.preview.dependencies ?? []).map((item) => (
            <li key={item.key}>
              {item.label}: {item.count}
            </li>
          ))}
        </ul>
        {(deleteDialog?.preview.blockers.length ?? 0) > 0 && <div className="error-note">لا يمكن تنفيذ الحذف الكامل حالياً: {deleteDialog!.preview.blockers.join('، ')}</div>}
        <p className="muted">هذا الإجراء نهائي ولا يمكن التراجع عنه.</p>
        <Field label={`اكتب اسم الحساب "${deleteDialog?.row.name ?? ''}" للتأكيد`} required>
          <Input value={deleteDialog?.confirmation ?? ''} onChange={(e) => setDeleteDialog(deleteDialog ? { ...deleteDialog, confirmation: e.target.value, error: undefined } : undefined)} />
        </Field>
      </Modal>
    </>
  )
}
