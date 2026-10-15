import { previewMultiplyDivideRounded } from '@shared/money/cost'
import { useState, type ReactElement } from 'react'
import { Pencil, Trash2, Ban } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Pager, Select, Textarea, Toolbar } from '@renderer/components/ui'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { SearchableCustomerSelect } from '@renderer/components/customers/SearchableCustomerSelect'
import { InvoiceMaterialMultiSelect, InvoiceMaterialColorGroups } from '@renderer/components/invoices/InvoiceItemMultiSelect'
import { unmappedItemColors, type MaterialColorInput, type ItemSelections, type ItemSelectionInput } from '@shared/documents/item-selections'
import { usePrintVisibility } from '@renderer/components/invoices/usePrintVisibility'
import { PrintOptionsRow } from '@renderer/components/invoices/PrintOptionsRow'
import { depositPreviewPercent, fmtMoney, fmtDateTime, toMicro } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface Quotation {
  id: number; documentNumber: string; customerId: number; customerName: string; status: string
  issuedAt: string | null; validUntil: string | null; totalMinor: number
  depositRequiredMinor: number; remainingMinor: number; createdAt: string
}
interface QuotationDeletePreview {
  quotationId: number
  documentNumber: string
  status: string
  order: { id: number; documentNumber: string } | null
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
  requiresConfirmation: boolean
}
interface LineDraft extends ItemSelectionInput {
  materialIds: number[]; materialColors: MaterialColorInput[]; retainedUnmappedColorIds: number[]; accessoryIds: number[]; savedSelections: ItemSelections
  lineKind: string; description: string; specifications: string; dimensions: string
  materialType: string; materialTypeMaterialId: string; colorCode: string; accessories: string; accessoryMaterialId: string; qty: string; unitPrice: string
  productId: string
}
interface QuotationDetail {
  quotation: {
    id: number; customerId: number; status: string; discountKind: string; discountValue: number
    depositPercentBp: number; requiresInstallation: boolean; requiresDelivery: boolean; notes: string | null
    meterPriceMinor: number; installationPriceMinor: number; deliveryPriceMinor: number
    printVisibility: string | null
  }
  lines: Array<ItemSelections & {
    id: number
    lineKind: string; productId: number | null; description: string; specifications: string | null
    dimensions: string | null; materialType: string | null; materialTypeMaterialId: number | null; colorCode: string | null
    accessories: string | null; accessoryMaterialId: number | null; quantityMicro: number; unitPriceMinor: number
  }>
}

const STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  draft: { label: 'مسودة', tone: 'neutral' },
  issued: { label: 'صادرة للعميل', tone: 'success' },
  expired: { label: 'منتهية الصلاحية', tone: 'warning' },
  // Legacy statuses, kept so documents from the old workflow still read
  // correctly in the list and stay traceable to the order they created.
  approved: { label: 'معتمد (قديم)', tone: 'info' },
  converted: { label: 'محوّل إلى طلب (قديم)', tone: 'info' },
  cancelled: { label: 'ملغاة', tone: 'danger' }
}

const emptyLine: LineDraft = {
  materialIds: [], materialColors: [], retainedUnmappedColorIds: [], accessoryIds: [], savedSelections: { selectedMaterials: [], selectedColors: [], selectedAccessories: [] },
  lineKind: 'custom', description: '', specifications: '', dimensions: '',
  materialType: '', materialTypeMaterialId: '', colorCode: '', accessories: '', accessoryMaterialId: '', qty: '1', unitPrice: '', productId: ''
}

export function QuotationsPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<number>()
  const [error, setError] = useState<string>()
  const [deleteDialog, setDeleteDialog] = useState<{
    row: Quotation
    preview: QuotationDeletePreview
    confirmation: string
    error?: string
  }>()
  const [form, setForm] = useState({ customerId: '', discountKind: 'none', discountValue: '', depositPercent: '', requiresInstallation: true, requiresDelivery: false, meterPrice: '', installationPrice: '', deliveryPrice: '', notes: '' })
  const print = usePrintVisibility()
  const [lines, setLines] = useState<LineDraft[]>([{ ...emptyLine }])

  function resetForm(): void {
    setForm({ customerId: '', discountKind: 'none', discountValue: '', depositPercent: '', requiresInstallation: true, requiresDelivery: false, meterPrice: '', installationPrice: '', deliveryPrice: '', notes: '' })
    print.reset()
    setLines([{ ...emptyLine }])
    setEditingId(undefined)
    setCustomerLabel(undefined)
  }

  const [customerSearch, setCustomerSearch] = useState('')
  const [customerLabel, setCustomerLabel] = useState<string>()
  const list = usePagedQuery<Quotation>('quotations', 'list', { search, status: status || undefined })
  const customers = usePagedQuery<{ id: number; name: string; phone: string | null }>('customers', 'list', { activeOnly: true, search: customerSearch || undefined }, { limit: 50, enabled: open })
  const colors = useQuery<Array<{ id: number; code: string; name: string; associatedMaterials: Array<{ id: number }> }>>('colors', 'list', { activeOnly: true })
  /* Raw Materials that are classified as accessories (BR-50) — the same
     master the Raw Materials page shows, never a separate list. */
  const accessories = useQuery<Array<{ id: number; sku: string; name: string }>>('materials', 'accessories')
  /* Every active Raw Material — the source for "نوع المادة", the same
     master the Raw Materials page shows, never a separate list. */
  const materialTypes = useQuery<Array<{ id: number; sku: string; name: string }>>('materials', 'types')
  const products = useQuery<Array<{ id: number; name: string; defaultPriceMinor: number }>>('products', 'list', {})

  const toMinor = (value: string): number => Math.round(Number(value || 0) * 1000)
  const subtotal = lines.reduce((sum, line) => sum + previewMultiplyDivideRounded(toMicro(line.qty), Math.round(Number(line.unitPrice || 0) * 1000), 1_000_000), 0)
  // Installation/delivery are CHARGES and join the total exactly once,
  // before the discount — the same order computeDocumentTotals uses in
  // main, so this preview can never disagree with what gets saved.
  // سعر المتر is deliberately absent: it is commercial information, not
  // a charge, and nothing derives a line price from it.
  const installationPrice = toMinor(form.installationPrice)
  const deliveryPrice = toMinor(form.deliveryPrice)
  const chargedSubtotal = subtotal + installationPrice + deliveryPrice
  const discount = form.discountKind === 'amount'
    ? Math.min(toMinor(form.discountValue), chargedSubtotal)
    : form.discountKind === 'percent'
      ? previewMultiplyDivideRounded(chargedSubtotal, Math.round(Number(form.discountValue || 0) * 100), 10_000)
      : 0
  const total = chargedSubtotal - discount
  const depositPct = depositPreviewPercent(form.depositPercent, 6000)
  const deposit = previewMultiplyDivideRounded(total, Math.round(depositPct * 100), 10_000)

  async function save(): Promise<void> {
    const valid = lines.filter((line) => line.description.trim() && Number(line.qty) > 0)
    if (!form.customerId || !valid.length) { setError('اختر العميل وأضف صنفاً واحداً على الأقل'); return }
    const payload = {
      discountKind: form.discountKind as 'none',
      discountValue: form.discountKind === 'percent'
        ? Math.round(Number(form.discountValue || 0) * 100)
        : Math.round(Number(form.discountValue || 0) * 1000),
      depositPercentBp: form.depositPercent ? Math.round(Number(form.depositPercent) * 100) : undefined,
      requiresInstallation: form.requiresInstallation,
      requiresDelivery: form.requiresDelivery,
      meterPriceMinor: toMinor(form.meterPrice),
      installationPriceMinor: installationPrice,
      deliveryPriceMinor: deliveryPrice,
      printVisibility: print.payload(),
      notes: form.notes || undefined,
      lines: valid.map((line) => ({
        sourceLineId: line.sourceLineId,
        materialIds: line.materialIds, materialColors: line.materialColors, retainedUnmappedColorIds: line.retainedUnmappedColorIds, accessoryIds: line.accessoryIds,
        discardLegacyMaterials: line.discardLegacyMaterials, discardLegacyColors: line.discardLegacyColors, discardLegacyAccessories: line.discardLegacyAccessories,
        lineKind: line.lineKind as 'custom',
        productId: line.productId ? Number(line.productId) : null,
        description: line.description,
        specifications: line.specifications || null,
        dimensions: line.dimensions || null,
        materialTypeMaterialId: line.materialTypeMaterialId ? Number(line.materialTypeMaterialId) : null,
        materialType: line.materialTypeMaterialId ? null : line.materialType || null,
        colorCode: line.colorCode || null,
        accessoryMaterialId: line.accessoryMaterialId ? Number(line.accessoryMaterialId) : null,
        accessories: line.accessoryMaterialId ? null : line.accessories || null,
        quantityMicro: toMicro(line.qty),
        unitPriceMinor: Math.round(Number(line.unitPrice || 0) * 1000)
      }))
    }
    try {
      if (editingId) {
        await call('quotations', 'update', { id: editingId, ...payload })
      } else {
        await call('quotations', 'create', { customerId: Number(form.customerId), ...payload })
      }
      toast.show(editingId ? 'تم تحديث الفاتورة المبدئية' : 'تم إنشاء الفاتورة المبدئية', 'success')
      setOpen(false); setError(undefined)
      resetForm()
      await list.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  /** Item 5: edit is only ever possible for a draft (assertDraft on the
   *  server) — an approved quotation is frozen and corrected via a
   *  revision instead (BR-45), so the row action is hidden otherwise. */
  async function startEdit(row: Quotation): Promise<void> {
    try {
      const detail = await call<QuotationDetail>('quotations', 'get', { id: row.id })
      setForm({
        customerId: String(detail.quotation.customerId),
        discountKind: detail.quotation.discountKind,
        discountValue: detail.quotation.discountKind === 'percent'
          ? String(detail.quotation.discountValue / 100)
          : String(detail.quotation.discountValue / 1000),
        depositPercent: String(detail.quotation.depositPercentBp / 100),
        requiresInstallation: detail.quotation.requiresInstallation,
        requiresDelivery: detail.quotation.requiresDelivery,
        meterPrice: detail.quotation.meterPriceMinor ? String(detail.quotation.meterPriceMinor / 1000) : '',
        installationPrice: detail.quotation.installationPriceMinor ? String(detail.quotation.installationPriceMinor / 1000) : '',
        deliveryPrice: detail.quotation.deliveryPriceMinor ? String(detail.quotation.deliveryPriceMinor / 1000) : '',
        notes: detail.quotation.notes ?? ''
      })
      // A reopened document shows the print choices it was saved with;
      // a legacy one (null) resolves to the defaults.
      print.load(detail.quotation.printVisibility)
      setLines(detail.lines.map((line) => ({
        sourceLineId: line.id,
        materialIds: line.selectedMaterials.flatMap(m => m.materialId === null ? [] : [m.materialId]),
        materialColors: line.selectedMaterials.flatMap(m => m.materialId === null ? [] : [{ materialId: m.materialId, colorIds: (m.colors ?? []).flatMap(c => c.colorId === null ? [] : [c.colorId]) }]),
        retainedUnmappedColorIds: unmappedItemColors(line).flatMap(c => c.colorId === null ? [] : [c.colorId]),
        accessoryIds: line.selectedAccessories.flatMap(a => a.materialId === null ? [] : [a.materialId]),
        savedSelections: { selectedMaterials: line.selectedMaterials, selectedColors: line.selectedColors, selectedAccessories: line.selectedAccessories },
        lineKind: line.lineKind, description: line.description,
        specifications: line.specifications ?? '', dimensions: line.dimensions ?? '',
        materialType: line.materialType ?? '',
        materialTypeMaterialId: line.materialTypeMaterialId ? String(line.materialTypeMaterialId) : '', colorCode: line.colorCode ?? '',
        accessories: line.accessories ?? '',
        accessoryMaterialId: line.accessoryMaterialId ? String(line.accessoryMaterialId) : '', qty: String(line.quantityMicro / 1_000_000),
        unitPrice: String(line.unitPriceMinor / 1000), productId: line.productId ? String(line.productId) : ''
      })))
      setCustomerLabel(row.customerName)
      setEditingId(row.id); setError(undefined); setOpen(true)
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر جلب البيانات', 'error') }
  }

  async function act(action: string, id: number, message: string): Promise<void> {
    try {
      await call('quotations', action, { id })
      toast.show(message, 'success')
      await list.reload()
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر التنفيذ', 'error') }
  }

  /**
   * The Trash icon always attempts a real deletion. A preliminary
   * invoice with nothing behind it goes after one plain confirmation;
   * one that was converted into a customer order opens the dependency
   * dialog, which unwinds that order through the order service's own
   * full-delete path once the invoice number is typed. A reason is
   * never asked for.
   */
  async function removeQuotation(row: Quotation): Promise<void> {
    try {
      const preview = await call<QuotationDeletePreview>('quotations', 'deletePreview', { id: row.id })
      if (preview.blockers.length || preview.requiresConfirmation || preview.dependencies.length > 1) {
        setDeleteDialog({ row, preview, confirmation: '' })
        return
      }
      if (!window.confirm(`هل أنت متأكد من حذف الفاتورة المبدئية ${row.documentNumber}؟`)) return
      await call('quotations', 'remove', { id: row.id })
      toast.show('تم حذف الفاتورة المبدئية', 'success')
      await list.reload()
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error')
    }
  }

  async function confirmDeleteQuotation(): Promise<void> {
    if (!deleteDialog) return
    try {
      await call('quotations', 'remove', {
        id: deleteDialog.row.id,
        confirmation: deleteDialog.confirmation || undefined
      })
      toast.show(
        deleteDialog.preview.order
          ? `تم حذف الفاتورة المبدئية وطلب العميل ${deleteDialog.preview.order.documentNumber} وإرجاع آثارهما`
          : 'تم حذف الفاتورة المبدئية',
        'success'
      )
      setDeleteDialog(undefined)
      await list.reload()
    } catch (err) {
      setDeleteDialog({ ...deleteDialog, error: err instanceof ApiError ? err.message : 'تعذر الحذف' })
    }
  }

  async function cancelQuotationRow(id: number): Promise<void> {
    if (!window.confirm('هل تريد إلغاء هذه الفاتورة المبدئية؟')) return
    await act('cancel', id, 'تم إلغاء الفاتورة المبدئية')
  }

  async function printDoc(id: number, mode: 'print' | 'exportPdf'): Promise<void> {
    try {
      const result = await call<{ path?: string }>('documents', mode, { kind: 'preliminary_invoice', id })
      toast.show(mode === 'print' ? 'تم إرسال المستند للطباعة' : `تم حفظ الملف: ${result.path}`, 'success')
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر إخراج المستند', 'error') }
  }

  return (
    <>
      <PageHeader
        title="الفواتير المبدئية"
        subtitle="مستند تجاري للعميل فقط — لا يُنشئ طلباً ولا أمر تصنيع. طلبات العملاء تبدأ من الفاتورة المعتمدة"
        actions={can(P.quotations.manage) && <Button onClick={() => { resetForm(); setError(undefined); setOpen(true) }}>+ فاتورة مبدئية</Button>}
      />
      <Card>
        <Toolbar>
          <Field label="بحث"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="رقم المستند أو العميل" /></Field>
          <Field label="الحالة">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">الكل</option>
              {Object.entries(STATUS).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}
            </Select>
          </Field>
        </Toolbar>
        <ErrorNote>{list.error}</ErrorNote>
        <DataTable
          loading={list.loading}
          rows={list.items}
          rowKey={(row) => row.id}
          empty="لا توجد فواتير مبدئية"
          columns={[
            { key: 'num', header: 'رقم المستند', render: (row) => row.documentNumber },
            { key: 'customer', header: 'العميل', render: (row) => row.customerName },
            { key: 'total', header: 'الإجمالي', numeric: true, render: (row) => fmtMoney(row.totalMinor) },
            { key: 'deposit', header: 'الدفعة المقدمة', numeric: true, render: (row) => fmtMoney(row.depositRequiredMinor) },
            { key: 'valid', header: 'صالح حتى', render: (row) => (row.validUntil ? fmtDateTime(row.validUntil) : '—') },
            { key: 'status', header: 'الحالة', render: (row) => <Badge tone={STATUS[row.status]?.tone ?? 'neutral'}>{STATUS[row.status]?.label ?? row.status}</Badge> },
            {
              key: 'actions', header: '', render: (row) => (
                <div className="row-actions">
                  <Button variant="ghost" size="sm" onClick={() => void printDoc(row.id, 'print')}>طباعة</Button>
                  <Button variant="ghost" size="sm" onClick={() => void printDoc(row.id, 'exportPdf')}>PDF</Button>
                  {row.status === 'draft' && can(P.quotations.issue) && (
                    <Button variant="secondary" size="sm" onClick={() => void act('issue', row.id, 'تم إصدار الفاتورة المبدئية للعميل')}>إصدار للعميل</Button>
                  )}
                  {(row.status === 'issued' || row.status === 'approved' || row.status === 'expired') && can(P.quotations.manage) && (
                    <Button variant="ghost" size="sm" onClick={() => void act('revise', row.id, 'تم إنشاء نسخة معدّلة')}>نسخة معدّلة</Button>
                  )}
                  {row.status === 'draft' && can(P.quotations.manage) && (
                    <button type="button" className="icon-btn" title="تعديل" aria-label="تعديل" onClick={() => void startEdit(row)}>
                      <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                  {(row.status === 'draft' || row.status === 'issued' || row.status === 'approved' || row.status === 'expired') && can(P.quotations.manage) && (
                    <button type="button" className="icon-btn" title="إلغاء" aria-label="إلغاء" onClick={() => void cancelQuotationRow(row.id)}>
                      <Ban size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                  {can(P.quotations.remove) && (
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void removeQuotation(row)}>
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

      <Modal
        open={Boolean(deleteDialog)}
        wide
        title={`حذف الفاتورة المبدئية ${deleteDialog?.row.documentNumber ?? ''}`}
        onClose={() => setDeleteDialog(undefined)}
        footer={<>
          <Button
            variant="destructive"
            disabled={Boolean(deleteDialog?.preview.blockers.length)}
            onClick={() => void confirmDeleteQuotation()}
          >
            حذف الفاتورة المبدئية
          </Button>
          <Button variant="secondary" onClick={() => setDeleteDialog(undefined)}>إغلاق</Button>
        </>}
      >
        <ErrorNote>{deleteDialog?.error}</ErrorNote>
        <p>
          {deleteDialog?.preview.order
            ? `هذه الفاتورة المبدئية حُوّلت إلى طلب العميل ${deleteDialog.preview.order.documentNumber}. حذفها يحذف الطلب بالكامل ويعيد آثاره المالية والمخزنية، ولا يمكن التراجع عن ذلك.`
            : 'هل أنت متأكد من حذف هذا السجل؟ سيتم إزالة السجلات التالية المرتبطة به.'}
        </p>
        <ul>
          {(deleteDialog?.preview.dependencies ?? []).map((item) => <li key={item.key}>{item.label}: {item.count}</li>)}
        </ul>
        {(deleteDialog?.preview.blockers.length ?? 0) > 0 && (
          <div className="error-note">تعذر الحذف لأن استعادة الآثار بالكامل غير مضمونة: {deleteDialog!.preview.blockers.join('، ')}</div>
        )}
        {deleteDialog?.preview.requiresConfirmation && (
          <Field label={`اكتب رقم الفاتورة المبدئية ${deleteDialog.preview.documentNumber} للتأكيد`} required>
            <Input
              value={deleteDialog.confirmation}
              onChange={(e) => setDeleteDialog({ ...deleteDialog, confirmation: e.target.value, error: undefined })}
            />
          </Field>
        )}
      </Modal>

      <Modal open={open} wide title={editingId ? 'تعديل الفاتورة المبدئية' : 'فاتورة مبدئية جديدة'} onClose={() => { setOpen(false); resetForm() }}
        footer={<><Button onClick={() => void save()}>{editingId ? 'حفظ التعديلات' : 'حفظ كمسودة'}</Button><Button variant="secondary" onClick={() => { setOpen(false); resetForm() }}>إلغاء</Button></>}>
        <ErrorNote>{error}</ErrorNote>
        <div className="grid grid--3">
          <Field label="العميل" required hint={editingId ? 'لا يمكن تغيير العميل بعد الإنشاء' : undefined}>
            <SearchableCustomerSelect
              customers={customers.items}
              value={form.customerId}
              onChange={(id, customer) => { setForm({ ...form, customerId: id }); setCustomerLabel(customer?.name) }}
              onSearchChange={setCustomerSearch}
              selectedLabel={customerLabel}
              disabled={Boolean(editingId)}
            />
          </Field>
          <Field label="نسبة الدفعة المقدمة %" hint="الافتراضي 60%">
            <Input type="number" step="1" placeholder="60" value={form.depositPercent} onChange={(e) => setForm({ ...form, depositPercent: e.target.value })} />
          </Field>
          <Field label="ملاحظات" print={print.toggle('notes')}><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
        {/* Printable details this form does not itself edit (they come
            from the customer card, or are set at issuing). They still
            need a print choice, so they get one here as a compact
            strip rather than as fake disabled inputs. */}
        <PrintOptionsRow
          title="إظهار في PDF"
          options={[
            { label: 'هاتف العميل', ...print.toggle('customerPhone') },
            { label: 'عنوان العميل', ...print.toggle('customerAddress') },
            { label: 'صالح حتى', ...print.toggle('validUntil') },
            { label: 'الشروط والأحكام', ...print.toggle('termsAndConditions') }
          ]}
        />
        {/* "يشمل تركيباً/توصيلاً" state WHETHER the job includes the
            service; "سعر التركيب/التوصيل" below state what it costs.
            This single checkbox is the only control for each — its own
            checked state already decides whether the PDF prints the
            matching statement, so no separate print-visibility toggle
            sits beside it (unlike the fields below, which have their
            value and their PDF appearance as genuinely separate
            choices). */}
        <div className="row-actions" style={{ marginBottom: 8 }}>
          <label className="checkbox-row"><input type="checkbox" checked={form.requiresInstallation} onChange={(e) => setForm({ ...form, requiresInstallation: e.target.checked })} /><span>يشمل تركيباً</span></label>
          <label className="checkbox-row"><input type="checkbox" checked={form.requiresDelivery} onChange={(e) => setForm({ ...form, requiresDelivery: e.target.checked })} /><span>يشمل توصيلاً</span></label>
        </div>
        <div className="grid grid--3">
          <Field label="سعر المتر" hint="معلومة تجارية — لا تدخل في الإجمالي" print={print.toggle('meterPrice')}>
            <Input type="number" step="0.01" min="0" value={form.meterPrice} onChange={(e) => setForm({ ...form, meterPrice: e.target.value })} />
          </Field>
          <Field label="سعر التركيب" hint="يُضاف إلى الإجمالي" print={print.toggle('installationPrice')}>
            <Input type="number" step="0.01" min="0" value={form.installationPrice} onChange={(e) => setForm({ ...form, installationPrice: e.target.value })} />
          </Field>
          <Field label="سعر التوصيل" hint="يُضاف إلى الإجمالي" print={print.toggle('deliveryPrice')}>
            <Input type="number" step="0.01" min="0" value={form.deliveryPrice} onChange={(e) => setForm({ ...form, deliveryPrice: e.target.value })} />
          </Field>
        </div>

        <h3 style={{ fontSize: 13, margin: '10px 0 6px' }}>الأصناف</h3>
        {/* Print visibility is a DOCUMENT-level choice per field, not a
            per-row one: hiding "الأبعاد" hides that detail for every
            item. One strip therefore states the choice once, instead of
            repeating the same switch on every item row. */}
        <PrintOptionsRow
          title="إظهار بنود الأصناف في PDF"
          options={[
            { label: 'البيان', ...print.toggle('description') },
            { label: 'الكمية', ...print.toggle('quantity') },
            { label: 'سعر الوحدة', ...print.toggle('unitPrice') },
            { label: 'إجمالي الصنف', ...print.toggle('lineTotal') },
            { label: 'المواصفات وملاحظات التصنيع', ...print.toggle('specifications') },
            { label: 'الأبعاد', ...print.toggle('dimensions') },
            { label: 'نوع المادة', ...print.toggle('materialType') },
            { label: 'اللون/التشطيب', ...print.toggle('colorCode') },
            { label: 'الإكسسوارات', ...print.toggle('accessories') }
          ]}
        />
        {lines.map((line, index) => {
          const update = (patch: Partial<LineDraft>): void => {
            const next = [...lines]; next[index] = { ...line, ...patch }; setLines(next)
          }
          return (
            <div key={index} className="subform-row">
              <div className="grid grid--4">
                <Field label="النوع">
                  <Select value={line.lineKind} onChange={(e) => update({ lineKind: e.target.value })}>
                    <option value="custom">صنف حسب الطلب</option>
                    <option value="standard">منتج قياسي</option>
                    <option value="material">بيع مادة مباشرة</option>
                    <option value="delivery">توصيل</option>
                    <option value="installation">تركيب</option>
                  </Select>
                </Field>
                {line.lineKind === 'standard' ? (
                  <Field label="المنتج">
                    <Select value={line.productId} onChange={(e) => {
                      const product = products.data?.find((p) => p.id === Number(e.target.value))
                      update({ productId: e.target.value, description: product?.name ?? line.description, unitPrice: product ? String(product.defaultPriceMinor / 1000) : line.unitPrice })
                    }}>
                      <option value="">— اختر —</option>
                      {(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select>
                  </Field>
                ) : (
                  <Field label="البيان"><Input value={line.description} onChange={(e) => update({ description: e.target.value })} /></Field>
                )}
                <Field label="الكمية"><Input type="number" step="0.001" value={line.qty} onChange={(e) => update({ qty: e.target.value })} /></Field>
                <Field label="سعر الوحدة (د.ل)"><Input type="number" step="0.01" value={line.unitPrice} onChange={(e) => update({ unitPrice: e.target.value })} /></Field>
              </div>
              <div className="grid grid--4">
                <Field label="الأبعاد"><Input value={line.dimensions} onChange={(e) => update({ dimensions: e.target.value })} /></Field>
                <div className="invoice-material-color-field">
                  <Field label="نوع المادة">
                    <InvoiceMaterialColorGroups
                      materials={materialTypes.data ?? []} colors={colors.data ?? []} ids={line.materialIds} groups={line.materialColors} saved={line.savedSelections}
                      onMaterialsChange={(ids, groups) => update({ materialIds: ids, materialColors: groups })}
                      onColorsChange={(groups) => update({ materialColors: groups, retainedUnmappedColorIds: line.retainedUnmappedColorIds.filter(id => !groups.some(g => g.colorIds.includes(id))) })}
                      discardLegacyMaterials={line.discardLegacyMaterials} onDiscardLegacyMaterials={() => update({ discardLegacyMaterials: true })}
                      retainedUnmappedColorIds={line.retainedUnmappedColorIds} onRetainedUnmappedColorsChange={(ids) => update({ retainedUnmappedColorIds: ids })}
                      discardLegacyColors={line.discardLegacyColors} onDiscardLegacyColors={() => update({ discardLegacyColors: true })}
                    />
                  </Field>
                </div>
                <Field label="الإكسسوارات">
                  <InvoiceMaterialMultiSelect
                    materials={accessories.data ?? []} ids={line.accessoryIds} saved={line.savedSelections.selectedAccessories}
                    onChange={(ids) => update({ accessoryIds: ids })} searchPlaceholder="بحث عن إكسسوار..."
                    discardLegacy={line.discardLegacyAccessories} onDiscardLegacy={() => update({ discardLegacyAccessories: true })}
                  />
                </Field>
              </div>
              <Field label="المواصفات وملاحظات التصنيع">
                <Textarea value={line.specifications} onChange={(e) => update({ specifications: e.target.value })} />
              </Field>
            </div>
          )
        })}
        <div className="row-actions" style={{ marginBottom: 10 }}>
          <Button variant="secondary" size="sm" onClick={() => setLines([...lines, { ...emptyLine }])}>+ صنف</Button>
          {lines.length > 1 && <Button variant="ghost" size="sm" onClick={() => setLines(lines.slice(0, -1))}>حذف الأخير</Button>}
        </div>

        <div className="grid grid--3">
          <Field label="نوع الخصم">
            <Select value={form.discountKind} onChange={(e) => setForm({ ...form, discountKind: e.target.value })}>
              <option value="none">بدون خصم</option>
              <option value="amount">مبلغ (د.ل)</option>
              <option value="percent">نسبة %</option>
            </Select>
          </Field>
          <Field label="قيمة الخصم">
            <Input type="number" step="0.01" disabled={form.discountKind === 'none'} value={form.discountValue} onChange={(e) => setForm({ ...form, discountValue: e.target.value })} />
          </Field>
          <div />
        </div>
        <div className="grid grid--4">
          <Field label="إجمالي المنتجات" print={print.toggle('subtotal')}><Input value={fmtMoney(subtotal)} disabled /></Field>
          <Field label="الخصم" print={print.toggle('discount')}><Input value={fmtMoney(discount)} disabled /></Field>
          {/* The final amount always prints: it is what the customer
              owes, and it already includes every charge exactly once
              even when an individual charge row is hidden. */}
          <Field label="سعر البيع النهائي" hint="يشمل التركيب والتوصيل"><Input value={fmtMoney(total)} disabled /></Field>
          <Field label={`الدفعة المقدمة (${depositPct}%)`} print={print.toggle('depositRequired')}><Input value={fmtMoney(deposit)} disabled /></Field>
        </div>
        <div className="grid grid--4">
          <Field label="المبلغ المتبقي" print={print.toggle('remainingBalance')}><Input value={fmtMoney(total - deposit)} disabled /></Field>
        </div>

      </Modal>
    </>
  )
}
