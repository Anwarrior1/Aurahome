import { useEffect, useState, type ReactElement } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@renderer/lib/useQuery'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Pager, Select, Toolbar } from '@renderer/components/ui'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { fmtMoney, fmtDate, fmtDateSlash, toMicro, todayIso, fromMicro } from '@renderer/lib/format'
import { useSelectedDate } from '@renderer/state/selected-date.store'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { Pencil, Trash2 } from 'lucide-react'
import { SearchableMaterialSelect } from '@renderer/components/materials/SearchableMaterialSelect'
import { purchaseLinePreview } from './purchase-preview'
import { SearchableOrderSelect } from '@renderer/components/orders/SearchableOrderSelect'

interface Purchase {
  id: number
  documentNumber: string
  supplierId: number
  supplierName: string
  customerOrderId: number | null
  customerOrderNumber: string | null
  customerName: string | null
  purchaseDate: string
  totalMinor: number
  paidMinor: number
  paymentStatus: string
  notes?: string | null
}
interface Material {
  id: number
  sku: string
  name: string
  unit: string
  active: boolean
  purchaseUnit: string | null
  purchaseUnitFactorMicro: number | null
}
interface Line {
  materialId: string
  qty: string
  unitCost: string
  batchCode: string
  byPurchaseUnit: boolean
}
interface SupplierPayment {
  id: number
  amountMinor: number
  cashAccountId: number | null
  paidAt: string
}
interface PurchaseViewLine {
  materialId: number
  qtyMicro: number
  unitCostMicro?: number
  lineTotalMinor?: number
  batchCode: string | null
}
interface FullDeletePreview {
  purchaseId: number
  documentNumber: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}

const emptyLine: Line = {
  materialId: '',
  qty: '',
  unitCost: '',
  batchCode: '',
  byPurchaseUnit: false
}

export function PurchasesPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const { selectedDateIso } = useSelectedDate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [orderFilter, setOrderFilter] = useState('all')
  // Purchases are a day journal, so they follow the global operational
  // date by default; "كل الفواتير" lifts the scope.
  const [dayScope, setDayScope] = useState(true)
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<number>()
  const [deleteDialog, setDeleteDialog] = useState<{
    row: Purchase
    preview: FullDeletePreview
    confirmation: string
    error?: string
  }>()
  // The supplier payment(s) already recorded against the invoice being
  // edited — loaded once, alongside the invoice itself, so the Cash
  // Account field can show/preselect the account actually used and
  // only be editable in the one safe, unambiguous case (item 14).
  const [editPayments, setEditPayments] = useState<SupplierPayment[]>([])
  const [viewing, setViewing] = useState<{
    purchase: Purchase
    lines: PurchaseViewLine[]
  }>()
  const [error, setError] = useState<string>()
  const [form, setForm] = useState({
    supplierId: '',
    customerOrderId: '',
    purchaseDate: todayIso(),
    notes: '',
    paidNow: '',
    cashAccountId: ''
  })
  const [lines, setLines] = useState<Line[]>([{ ...emptyLine }])

  const list = usePagedQuery<Purchase>('purchases', 'list', {
    search,
    supplierId: supplierId ? Number(supplierId) : undefined,
    customerOrderId: /^\d+$/.test(orderFilter) ? Number(orderFilter) : undefined,
    unassignedOnly: orderFilter === 'general' || undefined,
    from: dayScope ? selectedDateIso : undefined,
    to: dayScope ? selectedDateIso : undefined
  })
  const suppliers = useQuery<Array<{ id: number; name: string }>>('suppliers', 'list', {})
  const materials = useQuery<Material[]>('materials', 'list', {})
  const accounts = useQuery<Array<{ id: number; name: string }>>('cash', 'accounts')
  const materialById = new Map(materials.data?.map((m) => [String(m.id), m]))

  useEffect(() => {
    const id = Number(searchParams.get('open'))
    if (!Number.isInteger(id) || id <= 0) return
    void call<{
      purchase: Purchase
      lines: PurchaseViewLine[]
    }>('purchases', 'get', { id })
      .then((detail) => setViewing(detail))
      .catch((err) => toast.show(err instanceof ApiError ? err.message : 'تعذر تحميل فاتورة الشراء', 'error'))
    // Opening by URL is intentionally keyed only by the URL value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('open')])

  const total = lines.reduce((sum, line) => sum + purchaseLinePreview(line.qty, line.unitCost), 0)
  // Item 14: the Cash Account field is only safely editable at
  // invoice level when there is exactly ONE payment to attribute it
  // to — with zero payments there is nothing to move, and with more
  // than one the account must be corrected per-payment instead.
  const canEditAccount = Boolean(editId) && editPayments.length === 1

  function newPurchase(): void {
    setEditId(undefined)
    setEditPayments([])
    setForm({
      supplierId: '',
      customerOrderId: '',
      purchaseDate: selectedDateIso,
      notes: '',
      paidNow: '',
      cashAccountId: ''
    })
    setLines([{ ...emptyLine }])
    setError(undefined)
    setOpen(true)
  }

  async function editPurchase(row: Purchase): Promise<void> {
    try {
      const detail = await call<{
        purchase: Purchase
        lines: Array<{
          materialId: number
          qtyMicro: number
          unitCostMicro: number
          batchCode: string | null
        }>
        payments: SupplierPayment[]
      }>('purchases', 'get', { id: row.id })
      const payments = detail.payments ?? []
      setEditId(row.id)
      setEditPayments(payments)
      setForm({
        supplierId: String(detail.purchase.supplierId),
        customerOrderId: detail.purchase.customerOrderId == null ? '' : String(detail.purchase.customerOrderId),
        purchaseDate: detail.purchase.purchaseDate,
        notes: detail.purchase.notes ?? '',
        paidNow: '',
        // Preselect the account that actually paid for it (item 3) —
        // only meaningful when exactly one payment exists.
        cashAccountId: payments.length === 1 ? String(payments[0]?.cashAccountId ?? '') : ''
      })
      setLines(
        detail.lines.map((line) => ({
          materialId: String(line.materialId),
          qty: fromMicro(line.qtyMicro),
          unitCost: String(line.unitCostMicro / 1_000_000),
          batchCode: line.batchCode ?? '',
          byPurchaseUnit: false
        }))
      )
      setError(undefined)
      setOpen(true)
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر تحميل فاتورة الشراء', 'error')
    }
  }

  /**
   * The plain, safe delete stays the default path — it only ever
   * removes an invoice with nothing attached to it. Only when it is
   * blocked (a payment, or already-consumed stock) does this offer the
   * explicit, permanent cascade delete, and only to someone who
   * actually holds that separate high-level permission.
   */
  async function removePurchase(row: Purchase): Promise<void> {
    if (!window.confirm(`هل تريد حذف فاتورة الشراء ${row.documentNumber}؟`)) return
    try {
      await call('purchases', 'remove', { id: row.id })
      toast.show('تم حذف فاتورة الشراء وإيصال المخزون غير المستخدم', 'success')
      await list.reload()
    } catch (err) {
      if (err instanceof ApiError && can(P.purchases.fullDelete)) {
        try {
          const preview = await call<FullDeletePreview>('purchases', 'fullDeletePreview', {
            id: row.id
          })
          setDeleteDialog({ row, preview, confirmation: '' })
          return
        } catch (previewErr) {
          toast.show(previewErr instanceof ApiError ? previewErr.message : 'تعذر فحص فاتورة الشراء', 'error')
          return
        }
      }
      toast.show(err instanceof ApiError ? err.message : 'تعذر حذف فاتورة الشراء', 'error')
    }
  }

  async function fullDeleteFromDialog(): Promise<void> {
    if (!deleteDialog) return
    if (deleteDialog.confirmation.trim() !== deleteDialog.row.documentNumber) {
      setDeleteDialog({
        ...deleteDialog,
        error: `اكتب رقم الفاتورة ${deleteDialog.row.documentNumber} للتأكيد النهائي`
      })
      return
    }
    try {
      await call('purchases', 'fullDelete', {
        id: deleteDialog.row.id,
        confirmation: deleteDialog.confirmation
      })
      toast.show('تم حذف فاتورة الشراء بالكامل مع كل سجلاتها المرتبطة', 'success')
      setDeleteDialog(undefined)
      await list.reload()
    } catch (err) {
      setDeleteDialog({
        ...deleteDialog,
        error: err instanceof ApiError ? err.message : 'تعذر حذف فاتورة الشراء بالكامل'
      })
    }
  }

  async function save(): Promise<void> {
    const valid = lines.filter((line) => line.materialId && Number(line.qty) > 0)
    if (!form.supplierId || !valid.length) {
      setError('اختر المورد وأضف صنفاً واحداً على الأقل')
      return
    }
    try {
      const payload = {
        supplierId: Number(form.supplierId),
        customerOrderId: can(P.orders.view) ? (form.customerOrderId ? Number(form.customerOrderId) : null) : undefined,
        purchaseDate: form.purchaseDate,
        notes: form.notes || undefined,
        paidNowMinor: form.paidNow ? Math.round(Number(form.paidNow) * 1000) : undefined,
        // Create mode: the account paired with "مدفوع الآن", unchanged.
        // Edit mode: only sent when there is exactly one payment to
        // move (canEditAccount) — otherwise omitted entirely so the
        // server never even considers touching the payment/ledger.
        cashAccountId: editId ? (canEditAccount ? (form.cashAccountId ? Number(form.cashAccountId) : null) : undefined) : form.cashAccountId ? Number(form.cashAccountId) : undefined,
        // Item 7/16: when a line is entered "بوحدة الشراء", the server
        // converts it to the material's base stock unit and derives the
        // correct per-base-unit FIFO cost — this screen never computes
        // that conversion itself.
        lines: valid.map((line) =>
          line.byPurchaseUnit
            ? {
                materialId: Number(line.materialId),
                purchaseQtyMicro: toMicro(line.qty),
                purchaseUnitCostMicro: Math.round(Number(line.unitCost) * 1_000_000),
                batchCode: line.batchCode || null
              }
            : {
                materialId: Number(line.materialId),
                qtyMicro: toMicro(line.qty),
                unitCostMicro: Math.round(Number(line.unitCost) * 1_000_000),
                batchCode: line.batchCode || null
              }
        )
      }
      if (editId) await call('purchases', 'update', { id: editId, ...payload })
      else await financialCall('purchases', 'create', payload, 'purchases.create')
      toast.show(editId ? 'تم تصحيح فاتورة الشراء والمخزون بأمان' : 'تم تسجيل فاتورة الشراء وإضافة الكميات للمخزون', 'success')
      setOpen(false)
      setError(undefined)
      setEditId(undefined)
      setEditPayments([])
      setForm({
        supplierId: '',
        customerOrderId: '',
        purchaseDate: selectedDateIso,
        notes: '',
        paidNow: '',
        cashAccountId: ''
      })
      setLines([{ ...emptyLine }])
      await list.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  return (
    <>
      <PageHeader title="المشتريات" subtitle="كل فاتورة شراء تُنشئ طبقة تكلفة جديدة (الأقدم فالأحدث) وتحفظ سعر الشراء التاريخي" actions={can(P.purchases.manage) && <Button onClick={newPurchase}>+ فاتورة شراء</Button>} />
      <Card>
        <Toolbar>
          <Field label="بحث">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="رقم الفاتورة" />
          </Field>
          <Field label="النطاق">
            <Select value={dayScope ? 'day' : 'all'} onChange={(e) => setDayScope(e.target.value === 'day')}>
              <option value="day">مشتريات {fmtDateSlash(selectedDateIso)}</option>
              <option value="all">كل الفواتير</option>
            </Select>
          </Field>
          <Field label="المورد">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">كل الموردين</option>
              {(suppliers.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          {can(P.orders.view) && (
            <Field label="الطلب المرتبط">
              <SearchableOrderSelect mode="filter" orders={[]} serverSearch value={orderFilter} onChange={setOrderFilter} />
            </Field>
          )}
        </Toolbar>
        <ErrorNote>{list.error}</ErrorNote>
        <DataTable
          loading={list.loading}
          rows={list.items}
          rowKey={(row) => row.id}
          empty="لا توجد فواتير شراء"
          columns={[
            { key: 'num', header: 'رقم الفاتورة', render: (row) => row.documentNumber },
            { key: 'supplier', header: 'المورد', render: (row) => row.supplierName },
            {
              key: 'order', header: 'الطلب المرتبط',
              render: (row) => (row.customerOrderNumber ? <span title={row.customerName ?? undefined}>{row.customerOrderNumber}</span> : 'شراء عام')
            },
            { key: 'date', header: 'التاريخ', render: (row) => fmtDate(row.purchaseDate) },
            {
              key: 'total',
              header: 'الإجمالي',
              numeric: true,
              render: (row) => fmtMoney(row.totalMinor)
            },
            {
              key: 'paid',
              header: 'المدفوع',
              numeric: true,
              render: (row) => fmtMoney(row.paidMinor)
            },
            {
              key: 'due',
              header: 'المتبقي',
              numeric: true,
              render: (row) => fmtMoney(row.totalMinor - row.paidMinor)
            },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                can(P.purchases.manage) ? (
                  <div className="row-actions">
                    {can(P.purchases.prices) && (
                      <button type="button" className="icon-btn" title="تعديل" aria-label="تعديل" onClick={() => void editPurchase(row)}>
                        <Pencil size={16} strokeWidth={2.25} aria-hidden="true" />
                      </button>
                    )}
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void removePurchase(row)}>
                      <Trash2 size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </div>
                ) : null
            }
          ]}
        />
        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} />
      </Card>

      <Modal
        open={open}
        wide
        title={editId ? 'تعديل فاتورة شراء' : 'فاتورة شراء جديدة'}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => void save()}>{editId ? 'حفظ التصحيح' : 'حفظ الفاتورة'}</Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <div className="grid grid--4">
          <Field label="المورد" required>
            <Select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
              <option value="">— اختر —</option>
              {(suppliers.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="الطلب المرتبط">
            <SearchableOrderSelect
              orders={[]}
              serverSearch
              value={form.customerOrderId}
              onChange={(customerOrderId) => setForm({ ...form, customerOrderId })}
              disabled={!can(P.orders.view)}
              selectedLabel={!can(P.orders.view) && form.customerOrderId ? 'طلب مرتبط' : undefined}
            />
          </Field>
          <Field label="تاريخ الشراء">
            <Input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} />
          </Field>
          <Field label="ملاحظات">
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
        </div>

        <h3 style={{ fontSize: 13, margin: '10px 0 6px' }}>الأصناف</h3>
        {lines.map((line, index) => {
          const material = materialById.get(line.materialId)
          const hasPurchaseUnit = Boolean(material?.purchaseUnit && material.purchaseUnitFactorMicro)
          const update = (patch: Partial<Line>): void => {
            const next = [...lines]
            next[index] = { ...line, ...patch }
            setLines(next)
          }
          const equivalentStock = hasPurchaseUnit && line.byPurchaseUnit && Number(line.qty) > 0 ? Number(line.qty) * Number(fromMicro(material!.purchaseUnitFactorMicro!)) : null
          return (
            <div key={index} className="subform-row">
              <div className="grid grid--4" style={{ alignItems: 'end' }}>
                <Field label="المادة">
                  <SearchableMaterialSelect
                    materials={(materials.data ?? []).filter((material) => material.active || String(material.id) === line.materialId)}
                    value={line.materialId}
                    noneLabel="— اختر —"
                    onChange={(materialId) => {
                      if (materialId !== line.materialId) update({ materialId, byPurchaseUnit: false })
                    }}
                  />
                </Field>
                <Field label={hasPurchaseUnit && line.byPurchaseUnit ? `الكمية (${material!.purchaseUnit})` : `الكمية (${material?.unit ?? ''})`}>
                  <Input type="number" step="0.001" value={line.qty} onChange={(e) => update({ qty: e.target.value })} />
                </Field>
                <Field label={hasPurchaseUnit && line.byPurchaseUnit ? `سعر ${material!.purchaseUnit} الواحد (د.ل)` : 'سعر الوحدة (د.ل)'}>
                  <Input type="number" step="0.000001" value={line.unitCost} onChange={(e) => update({ unitCost: e.target.value })} />
                </Field>
                <Field label="رقم الدفعة (اختياري)">
                  <Input value={line.batchCode} onChange={(e) => update({ batchCode: e.target.value })} />
                </Field>
              </div>
              {hasPurchaseUnit && (
                <div className="row-actions" style={{ marginTop: 6 }}>
                  <label className="checkbox-row" style={{ marginBottom: 0 }}>
                    <input type="checkbox" checked={line.byPurchaseUnit} onChange={(e) => update({ byPurchaseUnit: e.target.checked })} />
                    <span>
                      الشراء بوحدة &quot;{material!.purchaseUnit}&quot; — كل {material!.purchaseUnit} يحتوي على {fromMicro(material!.purchaseUnitFactorMicro!)} {material!.unit}
                    </span>
                  </label>
                  {equivalentStock !== null && (
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      = {equivalentStock} {material!.unit} في المخزون
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        })}
        <div className="row-actions" style={{ marginBottom: 10 }}>
          <Button variant="secondary" size="sm" onClick={() => setLines([...lines, { ...emptyLine }])}>
            + صنف
          </Button>
          {lines.length > 1 && (
            <Button variant="ghost" size="sm" onClick={() => setLines(lines.slice(0, -1))}>
              حذف الأخير
            </Button>
          )}
        </div>

        <div className="grid grid--3">
          <Field label="إجمالي الفاتورة">
            <Input value={fmtMoney(total)} disabled />
          </Field>
          {!editId && (
            <Field label="مدفوع الآن (د.ل)">
              <Input type="number" step="0.01" value={form.paidNow} onChange={(e) => setForm({ ...form, paidNow: e.target.value })} />
            </Field>
          )}
          {/* Item 1/3/4: also available while editing — preselected
              with the account that actually paid for it, and only
              editable while the invoice has exactly one payment to
              attribute the change to (item 14). */}
          <Field label="الحساب النقدي">
            <Select value={form.cashAccountId} disabled={editId ? !canEditAccount : false} onChange={(e) => setForm({ ...form, cashAccountId: e.target.value })}>
              <option value="">— بدون —</option>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            {editId && editPayments.length === 0 && (
              <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                لا توجد دفعة مسجّلة على هذه الفاتورة بعد.
              </p>
            )}
            {editId && editPayments.length > 1 && (
              <p className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                توجد أكثر من دفعة مسجّلة على هذه الفاتورة — صحّح حساب كل دفعة على حدة من سجل الدفعات.
              </p>
            )}
          </Field>
        </div>
      </Modal>

      <Modal
        open={Boolean(viewing)}
        wide
        title={`عرض فاتورة الشراء ${viewing?.purchase.documentNumber ?? ''}`}
        onClose={() => {
          setViewing(undefined)
          searchParams.delete('open')
          setSearchParams(searchParams, { replace: true })
        }}
        footer={
          <Button
            variant="secondary"
            onClick={() => {
              setViewing(undefined)
              searchParams.delete('open')
              setSearchParams(searchParams, { replace: true })
            }}
          >
            إغلاق
          </Button>
        }
      >
        {viewing && (
          <>
            <div className="grid grid--4" style={{ marginBottom: 12 }}>
              <Field label="المورد">
                <Input value={viewing.purchase.supplierName} disabled />
              </Field>
              <Field label="الطلب المرتبط">
                <Input value={viewing.purchase.customerOrderNumber ? `${viewing.purchase.customerOrderNumber} — ${viewing.purchase.customerName ?? ''}` : 'شراء عام'} disabled />
              </Field>
              <Field label="تاريخ الشراء">
                <Input value={fmtDate(viewing.purchase.purchaseDate)} disabled />
              </Field>
              <Field label="إجمالي الفاتورة">
                <Input value={fmtMoney(viewing.purchase.totalMinor)} disabled />
              </Field>
            </div>
            <DataTable
              rows={viewing.lines}
              rowKey={(_, index) => index}
              empty="لا توجد أصناف"
              columns={[
                {
                  key: 'material',
                  header: 'المادة',
                  render: (line) => materialById.get(String(line.materialId))?.name ?? `#${line.materialId}`
                },
                {
                  key: 'qty',
                  header: 'الكمية',
                  numeric: true,
                  render: (line) => fromMicro(line.qtyMicro)
                },
                ...(can(P.purchases.prices)
                  ? [
                      {
                        key: 'price',
                        header: 'سعر الوحدة',
                        numeric: true,
                        render: (line: PurchaseViewLine) => fmtMoney(Math.round((line.unitCostMicro ?? 0) / 1000))
                      },
                      {
                        key: 'total',
                        header: 'الإجمالي',
                        numeric: true,
                        render: (line: PurchaseViewLine) => fmtMoney(line.lineTotalMinor ?? 0)
                      }
                    ]
                  : [])
              ]}
            />
          </>
        )}
      </Modal>

      <Modal
        open={Boolean(deleteDialog)}
        wide
        title="تأكيد حذف فاتورة الشراء بالكامل"
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
        <p>هذه الفاتورة مرتبطة بسجلات أخرى. سيؤدي الحذف إلى حذف الفاتورة وجميع الدفعات والحركات المالية وحركات المخزون المرتبطة بها نهائيًا. هل تريد المتابعة؟</p>
        <p style={{ fontWeight: 600, fontSize: 12.5 }}>سيتم حذف:</p>
        <ul>
          <li>فاتورة الشراء: 1</li>
          {(deleteDialog?.preview.dependencies ?? []).map((item) => (
            <li key={item.key}>
              {item.label}: {item.count}
            </li>
          ))}
        </ul>
        {(deleteDialog?.preview.blockers.length ?? 0) > 0 && <div className="error-note">لا يمكن تنفيذ الحذف الكامل حالياً: {deleteDialog!.preview.blockers.join('، ')}</div>}
        <p className="muted">هذا الإجراء نهائي ولا يمكن التراجع عنه.</p>
        <Field label={`اكتب رقم الفاتورة ${deleteDialog?.row.documentNumber ?? ''} للتأكيد`} required>
          <Input value={deleteDialog?.confirmation ?? ''} onChange={(e) => setDeleteDialog(deleteDialog ? { ...deleteDialog, confirmation: e.target.value, error: undefined } : undefined)} />
        </Field>
      </Modal>
    </>
  )
}
