import { previewMultiplyDivideRounded } from '@shared/money/cost'
import { useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, Printer, FileDown, Pencil, Trash2, CheckCircle2, RotateCcw, Archive, ArchiveRestore } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import {
  Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Pager, Select, Stat, Textarea, Toolbar
} from '@renderer/components/ui'
import { SearchableCustomerSelect } from '@renderer/components/customers/SearchableCustomerSelect'
import { InvoiceMaterialMultiSelect, InvoiceMaterialColorGroups } from '@renderer/components/invoices/InvoiceItemMultiSelect'
import { unmappedItemColors, type MaterialColorInput, type ItemSelections, type ItemSelectionInput } from '@shared/documents/item-selections'
import { usePrintVisibility } from '@renderer/components/invoices/usePrintVisibility'
import { PrintOptionsRow } from '@renderer/components/invoices/PrintOptionsRow'
import { depositPreviewPercent, fmtMoney, fmtDateTime, toMicro } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { PAYMENT_STATUS } from '../orders/OrdersPage'

interface FinalInvoice {
  id: number; documentNumber: string; orderId: number | null; orderNumber: string | null
  orderArchivedAt: string | null
  orderStatus: string | null
  /** Lifecycle eligibility computed by main with the same guards the mutations enforce. */
  canUnapprove: boolean; canDelete: boolean; canArchive: boolean
  customerId: number; customerName: string
  approvalRevision: number
  status: string; issuedAt: string | null; totalMinor: number
  /** Live receivable position — omitted by main for a session
   *  without finalInvoices.viewOutstanding. */
  paidMinor?: number; remainingMinor?: number; paymentStatus?: string
  cancelReason: string | null; createdAt: string
}
interface LineDraft extends ItemSelectionInput {
  materialIds: number[]; materialColors: MaterialColorInput[]; retainedUnmappedColorIds: number[]; accessoryIds: number[]; savedSelections: ItemSelections
  lineKind: string; description: string; specifications: string; dimensions: string
  materialType: string; materialTypeMaterialId: string; colorCode: string; accessories: string; accessoryMaterialId: string; qty: string; unitPrice: string
  productId: string
  /** Set when this line SELLS an already-built product from
   *  "المنتجات غير المستلمة" rather than ordering one to be made. */
  uncollectedProductId: string
}
interface UncollectedOption {
  id: number; name: string; sourceOrderNumber: string
  specifications: string | null; dimensions: string | null; quantityMicro: number
}
/**
 * `id` is absent for a term picked before the invoice has been saved
 * at all (create-flow pass) — it exists only in form state until
 * "حفظ كمسودة" persists it, keyed there by `termIndex` instead, which
 * is always unique per invoice whether saved or not.
 */
interface InvoiceTerm { id?: number; termIndex: number; termText: string }
interface InvoiceDetail {
  payment: { paidMinor: number; remainingMinor: number }
  invoice: {
    orderId: number | null
    id: number; customerId: number; status: string; discountKind: string; discountValue: number
    depositPercentBp: number; requiresInstallation: boolean; requiresDelivery: boolean
    meterPriceMinor: number; installationPriceMinor: number; deliveryPriceMinor: number
    paidAmountMinor: number; initialCashAccountId: number | null
    printVisibility: string | null
    address: string | null; notes: string | null
  }
  lines: Array<ItemSelections & {
    id: number
    lineKind: string; productId: number | null; description: string; specifications: string | null
    dimensions: string | null; materialType: string | null; materialTypeMaterialId: number | null; colorCode: string | null
    accessories: string | null; accessoryMaterialId: number | null; quantityMicro: number; unitPriceMinor: number
    uncollectedProductId: number | null
  }>
  terms: InvoiceTerm[]
}

const STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  draft: { label: 'مسودة', tone: 'neutral' },
  approved: { label: 'معتمدة', tone: 'success' },
  cancelled: { label: 'ملغاة', tone: 'danger' }
}

const emptyLine: LineDraft = {
  materialIds: [], materialColors: [], retainedUnmappedColorIds: [], accessoryIds: [], savedSelections: { selectedMaterials: [], selectedColors: [], selectedAccessories: [] },
  lineKind: 'custom', description: '', specifications: '', dimensions: '',
  materialType: '', materialTypeMaterialId: '', colorCode: '', accessories: '', accessoryMaterialId: '', qty: '1', unitPrice: '', productId: '', uncollectedProductId: ''
}

/**
 * "الفواتير المعتمدة" — the authoritative commercial approval point,
 * and the START of the operational workflow.
 *
 * An invoice is prepared here as a draft with its own lines and terms.
 * APPROVING it is what creates the Customer Order — exactly once, no
 * matter how often approval is retried. Production is then planned on
 * that order, and only there.
 */
export function FinalInvoicesPage(): ReactElement {
  const navigate = useNavigate()
  const toast = useToast()
  const { can } = useSession()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [archived, setArchived] = useState(false)
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerLabel, setCustomerLabel] = useState<string>()
  const pageSize = 25
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<number>()
  const [editingOrderId, setEditingOrderId] = useState<number | null>(null)
  const [existingPaidMinor, setExistingPaidMinor] = useState(0)
  const [unapprovingId, setUnapprovingId] = useState<number>()
  const [error, setError] = useState<string>()
  const [form, setForm] = useState({
    customerId: '', discountKind: 'none', discountValue: '', depositPercent: '',
    requiresInstallation: true, requiresDelivery: false,
    meterPrice: '', installationPrice: '', deliveryPrice: '', paidAmount: '0', initialCashAccountId: '', address: '', notes: ''
  })
  const print = usePrintVisibility()
  const [lines, setLines] = useState<LineDraft[]>([{ ...emptyLine }])
  // Selected Terms/Conditions for the invoice being edited (item 3/7),
  // technically separate from `lines` (invoice items) throughout.
  const [terms, setTerms] = useState<InvoiceTerm[]>([])
  // The "+ بند" picker: open with the set of catalog indexes checked so
  // far; undefined while closed.
  const [termPicker, setTermPicker] = useState<Set<number>>()

  /**
   * The response carries the rows plus ONLY the company-wide summaries
   * this session is authorised to see — main omits the others entirely
   * (see listFinalInvoices), so an unauthorised user has nothing to
   * render rather than something merely hidden.
   */
  const list = usePagedQuery<FinalInvoice, { totalCount: number; totalApprovedMinor?: number; totalOutstandingMinor?: number }>('finalInvoices', 'list', {
    search: search || undefined,
    status: status || undefined,
    archived
  }, { limit: pageSize })
  const customers = usePagedQuery<{ id: number; name: string; phone: string | null }>('customers', 'list', { activeOnly: true, search: customerSearch || undefined }, { limit: 50, enabled: open })
  const colors = useQuery<Array<{ id: number; code: string; name: string; relatedMaterialId: number | null }>>('colors', 'list', { activeOnly: true })
  /* Raw Materials that are classified as accessories (BR-50) — the same
     master the Raw Materials page shows, never a separate list. */
  const accessories = useQuery<Array<{ id: number; sku: string; name: string }>>('materials', 'accessories')
  /* Every active Raw Material — the source for "نوع المادة", the same
     master the Raw Materials page shows, never a separate list. */
  const materialTypes = useQuery<Array<{ id: number; sku: string; name: string }>>('materials', 'types')
  const accounts = useQuery<Array<{ id: number; name: string; active: boolean }>>('cash', 'accounts', {}, { enabled: can(P.cash.view) && can(P.payments.manage) })
  const products = useQuery<Array<{ id: number; name: string; defaultPriceMinor: number }>>('products', 'list', {})
  // Already-built products available for resale. Only requested when the
  // session may actually sell one — main refuses the channel otherwise.
  const uncollected = useQuery<UncollectedOption[]>(
    'uncollectedProducts',
    'available',
    {},
    { enabled: can(P.uncollectedProducts.sell) }
  )
  // The ONE global Terms/Conditions catalog — same source Settings and
  // the Preliminary Invoice already use, reused here (never duplicated).
  const termsCatalog = useQuery<string[]>('finalInvoices', 'termsCatalog', {})
  const depositDefault = useQuery<{ depositPercentBp: number }>('finalInvoices', 'depositDefault')

  const rows = list.items
  // Presence of the data, not a second opinion about the permission.
  const canSeeReceivables = rows.length === 0 || rows[0]?.remainingMinor !== undefined
  const totalBilled = list.summary?.totalApprovedMinor
  const totalOutstanding = list.summary?.totalOutstandingMinor

  const subtotal = lines.reduce(
    (sum, line) => sum + previewMultiplyDivideRounded(toMicro(line.qty), Math.round(Number(line.unitPrice || 0) * 1000), 1_000_000), 0
  )
  // Installation/delivery are CHARGES: added once, before the discount —
  // the same order computeDocumentTotals uses in main, so this preview
  // can never disagree with what gets saved. سعر المتر is commercial
  // information only and deliberately stays out of the arithmetic.
  const toMinor = (value: string): number => Math.round(Number(value || 0) * 1000)
  const installationPrice = toMinor(form.installationPrice)
  const deliveryPrice = toMinor(form.deliveryPrice)
  const chargedSubtotal = subtotal + installationPrice + deliveryPrice
  const discount = form.discountKind === 'amount'
    ? Math.min(toMinor(form.discountValue), chargedSubtotal)
    : form.discountKind === 'percent'
      ? previewMultiplyDivideRounded(chargedSubtotal, Math.round(Number(form.discountValue || 0) * 100), 10_000)
      : 0
  const total = chargedSubtotal - discount
  const defaultDepositPercentBp = depositDefault.data?.depositPercentBp ?? 6000
  const depositPct = depositPreviewPercent(form.depositPercent, defaultDepositPercentBp)
  const deposit = previewMultiplyDivideRounded(total, Math.round(depositPct * 100), 10_000)

  function resetForm(): void {
    setEditingOrderId(null); setExistingPaidMinor(0)
    setForm({
      customerId: '', discountKind: 'none', discountValue: '', depositPercent: '',
      requiresInstallation: true, requiresDelivery: false,
      meterPrice: '', installationPrice: '', deliveryPrice: '', paidAmount: '0', initialCashAccountId: '', address: '', notes: ''
    })
    print.reset()
    setLines([{ ...emptyLine }])
    setTerms([])
    setEditingId(undefined)
    setCustomerLabel(undefined)
  }

  async function save(): Promise<void> {
    const valid = lines.filter((line) => line.description.trim() && Number(line.qty) > 0)
    if (!form.customerId || !valid.length) { setError('اختر العميل وأضف صنفاً واحداً على الأقل'); return }
    const paid = Number(form.paidAmount)
    if (!Number.isFinite(paid) || paid < 0 || paid > total / 1000) { setError('المدفوع يجب أن يكون بين صفر وإجمالي الفاتورة'); return }
    const payload = {
      discountKind: form.discountKind as 'none',
      discountValue: form.discountKind === 'percent'
        ? Math.round(Number(form.discountValue || 0) * 100)
        : Math.round(Number(form.discountValue || 0) * 1000),
      depositPercentBp: can(P.orders.overrideDeposit) && form.depositPercent !== ''
        ? Math.round(Number(form.depositPercent) * 100) : undefined,
      requiresInstallation: form.requiresInstallation,
      requiresDelivery: form.requiresDelivery,
      meterPriceMinor: toMinor(form.meterPrice),
      installationPriceMinor: installationPrice,
      deliveryPriceMinor: deliveryPrice,
      paidAmountMinor: toMinor(form.paidAmount),
      initialCashAccountId: form.initialCashAccountId ? Number(form.initialCashAccountId) : null,
      printVisibility: print.payload(),
      address: form.address || undefined,
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
        unitPriceMinor: Math.round(Number(line.unitPrice || 0) * 1000),
        // The selling price is whatever was typed — the product's
        // historical build cost never dictates it.
        uncollectedProductId: line.uncollectedProductId ? Number(line.uncollectedProductId) : null
      }))
    }
    try {
      if (editingId) {
        // Terms on an already-saved invoice are persisted independently
        // by addTerms/removeTerm as they happen — this call only ever
        // touches items and header fields, unchanged from before.
        await call('finalInvoices', 'update', { id: editingId, ...payload })
      } else {
        // Item 4: invoice header + items + every term picked so far go
        // in ONE create call, so the backend persists them together in
        // a single transaction — never a sequence of separate requests.
        await call('finalInvoices', 'create', {
          customerId: Number(form.customerId),
          ...payload,
          termIndexes: terms.map((t) => t.termIndex)
        })
      }
      toast.show(editingId ? 'تم تحديث الفاتورة المعتمدة' : 'تم إنشاء الفاتورة المعتمدة', 'success')
      setOpen(false); setError(undefined)
      resetForm()
      await list.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  async function startEdit(row: FinalInvoice): Promise<void> {
    try {
      const detail = await call<InvoiceDetail>('finalInvoices', 'get', { id: row.id })
      setEditingOrderId(detail.invoice.orderId); setExistingPaidMinor(detail.payment.paidMinor)
      setForm({
        customerId: String(detail.invoice.customerId),
        discountKind: detail.invoice.discountKind,
        discountValue: detail.invoice.discountKind === 'percent'
          ? String(detail.invoice.discountValue / 100)
          : String(detail.invoice.discountValue / 1000),
        depositPercent: String(detail.invoice.depositPercentBp / 100),
        requiresInstallation: detail.invoice.requiresInstallation,
        requiresDelivery: detail.invoice.requiresDelivery,
        meterPrice: detail.invoice.meterPriceMinor ? String(detail.invoice.meterPriceMinor / 1000) : '',
        installationPrice: detail.invoice.installationPriceMinor ? String(detail.invoice.installationPriceMinor / 1000) : '',
        deliveryPrice: detail.invoice.deliveryPriceMinor ? String(detail.invoice.deliveryPriceMinor / 1000) : '',
        paidAmount: String(detail.invoice.paidAmountMinor / 1000),
        initialCashAccountId: detail.invoice.initialCashAccountId === null ? '' : String(detail.invoice.initialCashAccountId),
        address: detail.invoice.address ?? '',
        notes: detail.invoice.notes ?? ''
      })
      // Reopening restores the choices the invoice was saved with; a
      // legacy invoice (null) resolves to the defaults.
      print.load(detail.invoice.printVisibility)
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
        unitPrice: String(line.unitPriceMinor / 1000), productId: line.productId ? String(line.productId) : '',
        uncollectedProductId: line.uncollectedProductId ? String(line.uncollectedProductId) : ''
      })))
      setTerms(detail.terms)
      setCustomerLabel(row.customerName)
      setEditingId(row.id); setError(undefined); setOpen(true)
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر جلب البيانات', 'error') }
  }

  /**
   * Item 5/6: one confirmed action adds every checked term at once.
   *
   * On an already-saved invoice this goes straight through the same
   * `addFinalInvoiceTerms` batch call as before. On a brand-new,
   * not-yet-saved invoice there is no id to persist against yet — the
   * picked terms just join form state, exactly as picked items already
   * do, and travel to the backend together with everything else on
   * "حفظ كمسودة" (item 3/4). Either way duplicates are impossible: the
   * picker only ever lists catalog terms not already selected (item 6).
   */
  async function confirmAddTerms(): Promise<void> {
    if (!termPicker?.size) { setTermPicker(undefined); return }
    const picked = [...termPicker]

    if (!editingId) {
      const catalog = termsCatalog.data ?? []
      const added: InvoiceTerm[] = picked.map((index) => ({ termIndex: index, termText: catalog[index] ?? '' }))
      setTerms([...terms, ...added].sort((a, b) => a.termIndex - b.termIndex))
      setTermPicker(undefined)
      return
    }

    try {
      await call('finalInvoices', 'addTerms', { id: editingId, termIndexes: picked })
      const detail = await call<InvoiceDetail>('finalInvoices', 'get', { id: editingId })
      setTerms(detail.terms)
      setTermPicker(undefined)
      toast.show('تمت إضافة البنود المحددة', 'success')
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر إضافة البنود', 'error') }
  }

  /**
   * Item 8: removes the association from THIS invoice only — the
   * global Terms/Conditions catalog is never touched. Before the first
   * save there is nothing persisted yet to remove from — it is a pure
   * form-state edit, mirroring how removing an unsaved item works.
   */
  async function removeTerm(term: InvoiceTerm): Promise<void> {
    if (!editingId || term.id === undefined) {
      setTerms(terms.filter((t) => t.termIndex !== term.termIndex))
      return
    }
    try {
      await call('finalInvoices', 'removeTerm', { id: editingId, termId: term.id })
      setTerms(terms.filter((t) => t.id !== term.id))
      toast.show('تم حذف البند من هذه الفاتورة', 'success')
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر حذف البند', 'error') }
  }

  /** THE approval: it creates the Customer Order, and only once. */
  async function unapprove(row: FinalInvoice): Promise<void> {
    if (!window.confirm(`إلغاء اعتماد الفاتورة ${row.documentNumber}؟ يُسمح بذلك فقط عندما يكون صافي مدفوع العميل صفراً ولم يبدأ التصنيع.`)) return
    setUnapprovingId(row.id)
    try {
      await call('finalInvoices', 'unapprove', { id: row.id, expectedRevision: row.approvalRevision })
      toast.show('تم إلغاء الاعتماد؛ عدّل نفس الفاتورة ثم اعتمدها مجدداً', 'success')
      await list.reload()
      if (can(P.finalInvoices.manage)) await startEdit(row)
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر إلغاء الاعتماد', 'error') }
    finally { setUnapprovingId(undefined) }
  }

  async function approve(row: FinalInvoice): Promise<void> {
    if (!window.confirm(row.orderId ? `إعادة اعتماد الفاتورة ${row.documentNumber} وتحديث نفس طلب العميل دون تكرار دفعاته؟` : `اعتماد الفاتورة ${row.documentNumber} وإنشاء طلب العميل؟`)) return
    try {
      const result = await call<{ orderId: number; orderNumber: string; alreadyApproved: boolean }>(
        'finalInvoices', 'approve', { id: row.id, expectedRevision: row.approvalRevision }
      )
      toast.show(
        result.alreadyApproved
          ? `هذه الفاتورة معتمدة بالفعل — الطلب ${result.orderNumber}`
          : row.orderId ? `تمت إعادة الاعتماد وتحديث نفس الطلب ${result.orderNumber}` : `تم الاعتماد وإنشاء طلب العميل ${result.orderNumber}`,
        'success'
      )
      await list.reload()
      navigate(`/orders/${result.orderId}`)
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر الاعتماد', 'error') }
  }

  async function removeDraft(row: FinalInvoice): Promise<void> {
    if (!window.confirm(row.orderId ? `حذف الفاتورة ${row.documentNumber} نهائياً مع طلبها غير المعتمد؟ لا يمكن التراجع عن الحذف.` : `هل تريد حذف مسودة الفاتورة ${row.documentNumber}؟`)) return
    try {
      await call('finalInvoices', 'remove', { id: row.id })
      toast.show(row.orderId ? 'تم حذف الفاتورة نهائياً' : 'تم حذف المسودة', 'success')
      await list.reload()
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error') }
  }

  async function changeArchive(row: FinalInvoice, archive: boolean): Promise<void> {
    if (!row.orderId) return
    try {
      await call('orders', archive ? 'archive' : 'restore', { id: row.orderId })
      toast.show(archive ? 'تمت أرشفة الفاتورة' : 'تم إلغاء أرشفة الفاتورة', 'success')
      await list.reload()
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر تغيير الأرشفة', 'error') }
  }

  async function printDoc(id: number, mode: 'print' | 'exportPdf'): Promise<void> {
    try {
      const result = await call<{ path?: string; method?: 'printer' | 'pdf' }>('documents', mode, { kind: 'final_invoice', id })
      toast.show(
        mode === 'exportPdf'
          ? `تم حفظ الملف: ${result.path}`
          : result.method === 'pdf'
            ? 'لا توجد طابعة معرّفة؛ تم فتح نسخة PDF للطباعة'
            : 'تم إرسال المستند للطباعة',
        'success'
      )
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر إخراج المستند', 'error') }
  }

  return (
    <>
      <PageHeader
        title="الفواتير المعتمدة"
        subtitle="نقطة الاعتماد التجاري — اعتماد الفاتورة يُنشئ طلب العميل، ومنه يُخطَّط الإنتاج ويُصدر أمر التصنيع"
        actions={can(P.finalInvoices.manage) && (
          <Button onClick={() => { resetForm(); setError(undefined); setOpen(true) }}>+ فاتورة معتمدة</Button>
        )}
      />

      {/* Company-wide financial summaries, each its own permission: a
          sales user may own the documents without seeing the business's
          total approved value or what customers still owe overall. The
          figures are computed and authorised in main — an unauthorised
          session never receives them (see listFinalInvoices). */}
      <div className="grid grid--2" style={{ marginBottom: 14 }}>
        {totalBilled !== undefined && (
          <Stat label="إجمالي المعتمد" value={fmtMoney(totalBilled)} tone="brand" hint="الفواتير المعتمدة غير الملغاة" />
        )}
        {totalOutstanding !== undefined && (
          <Stat label="المتبقي على العملاء" value={fmtMoney(totalOutstanding)}
            tone={totalOutstanding > 0 ? 'danger' : 'success'} hint="من سجل الدفعات مباشرة" />
        )}
      </div>

      <Card>
        <Toolbar>
          <Button
            variant={archived ? 'secondary' : 'primary'}
            onClick={() => setArchived(false)}
          >
            الفواتير المعتمدة النشطة
          </Button>
          <Button
            variant={archived ? 'primary' : 'secondary'}
            onClick={() => setArchived(true)}
          >
            الفواتير المعتمدة المؤرشفة
          </Button>
        </Toolbar>
        <Toolbar>
          <Field label="بحث"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="رقم الفاتورة أو الطلب أو العميل" /></Field>
          <Field label="الحالة">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">الكل</option>
              {Object.entries(STATUS).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}
            </Select>
          </Field>
        </Toolbar>
        <DataTable
          loading={list.loading}
          rows={rows}
          rowKey={(row) => row.id}
          empty="لا توجد فواتير معتمدة"
          columns={[
            { key: 'num', header: 'رقم الفاتورة', render: (row) => row.documentNumber },
            { key: 'customer', header: 'العميل', render: (row) => row.customerName },
            { key: 'order', header: 'طلب العميل', render: (row) => row.orderNumber
              ? <span>{row.orderNumber}{row.orderArchivedAt ? ' — مؤرشف' : ''}</span>
              : '—' },
            { key: 'total', header: 'الإجمالي', numeric: true, render: (row) => fmtMoney(row.totalMinor) },
            // The receivable columns exist only when main actually sent
            // the figures — a column is dropped outright rather than
            // printed empty for an unauthorised session.
            ...(canSeeReceivables
              ? [
                  { key: 'paid', header: 'المدفوع', numeric: true, render: (row: FinalInvoice) => fmtMoney(row.paidMinor ?? 0) },
                  { key: 'remaining', header: 'المتبقي', numeric: true, render: (row: FinalInvoice) => fmtMoney(row.remainingMinor ?? 0) },
                  {
                    key: 'payment', header: 'حالة السداد', render: (row: FinalInvoice) => row.orderId && row.paymentStatus
                      ? <Badge tone={PAYMENT_STATUS[row.paymentStatus]?.tone ?? 'neutral'}>{PAYMENT_STATUS[row.paymentStatus]?.label ?? row.paymentStatus}</Badge>
                      : '—'
                  }
                ]
              : []),
            { key: 'issued', header: 'تاريخ الاعتماد', render: (row) => (row.issuedAt ? fmtDateTime(row.issuedAt) : '—') },
            { key: 'status', header: 'الحالة', render: (row) => <Badge tone={STATUS[row.status]?.tone ?? 'neutral'}>{STATUS[row.status]?.label ?? row.status}</Badge> },
            {
              key: 'actions', header: '', render: (row) => (
                <div className="row-actions">
                  {!row.orderArchivedAt && row.status === 'approved' && can(P.orders.unapproveInvoice) && <Button size="sm" variant="secondary" disabled={unapprovingId !== undefined || !row.canUnapprove} title={row.canUnapprove ? undefined : 'يلزم أن يكون صافي مدفوع العميل صفراً وألا يكون التصنيع قد بدأ'} onClick={() => void unapprove(row)}><RotateCcw size={15} /> إلغاء الاعتماد</Button>}
                  {!row.orderArchivedAt && row.status === 'approved' && row.orderId && can(P.orders.archive) && <Button size="sm" variant="secondary" disabled={!row.canArchive} title={row.canArchive ? undefined : 'يمكن أرشفة فاتورة طلب مكتمل أو ملغى فقط'} onClick={() => void changeArchive(row, true)}><Archive size={15} /> أرشفة</Button>}
                  {row.orderArchivedAt && can(P.orders.archive) && <Button size="sm" variant="secondary" onClick={() => void changeArchive(row, false)}><ArchiveRestore size={15} /> إلغاء الأرشفة</Button>}
                  {!row.orderArchivedAt && row.status === 'draft' && can(P.finalInvoices.approve) && (
                    <Button size="sm" onClick={() => void approve(row)}>
                      <CheckCircle2 size={14} strokeWidth={2.25} aria-hidden="true" /> {row.orderId ? 'إعادة الاعتماد وتحديث نفس الطلب' : 'اعتماد وإنشاء طلب'}
                    </Button>
                  )}
                  {row.orderId && (
                    <button type="button" className="icon-btn" title="فتح الطلب" aria-label="فتح الطلب" onClick={() => navigate(`/orders/${row.orderId}`)}>
                      <Eye size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                  {!row.orderArchivedAt && row.status === 'draft' && can(P.finalInvoices.manage) && (
                    <button type="button" className="icon-btn" title="تعديل" aria-label="تعديل" onClick={() => void startEdit(row)}>
                      <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                  <button type="button" className="icon-btn" title="طباعة" aria-label="طباعة" onClick={() => void printDoc(row.id, 'print')}>
                    <Printer size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-btn" title="تصدير PDF" aria-label="تصدير PDF" onClick={() => void printDoc(row.id, 'exportPdf')}>
                    <FileDown size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                  {!row.orderArchivedAt && row.status === 'draft' && row.canDelete && can(P.finalInvoices.remove) && (
                    <button type="button" className="icon-btn icon-btn--danger" title={row.orderId ? 'حذف نهائي' : 'حذف المسودة'} aria-label={row.orderId ? 'حذف نهائي' : 'حذف المسودة'} onClick={() => void removeDraft(row)}>
                      <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )
            }
          ]}
        />
        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} totalCount={list.summary?.totalCount ?? 0} pageSize={pageSize} noun="فاتورة" />
      </Card>

      <Modal open={open} wide title={editingId ? 'تعديل فاتورة معتمدة' : 'فاتورة معتمدة جديدة'} onClose={() => setOpen(false)}
        footer={<><Button onClick={() => void save()}>حفظ كمسودة</Button><Button variant="secondary" onClick={() => setOpen(false)}>إلغاء</Button></>}>
        <ErrorNote>{error}</ErrorNote>
        <p className="muted" style={{ marginTop: 0 }}>
          تُحفظ كمسودة أولاً. الاعتماد لاحقاً هو ما يُنشئ طلب العميل — ولا يُنشئ أي حركة مخزون أو عمولة أو قيد نقدي.
        </p>
        <div className="grid grid--3">
          <Field label="العميل" required>
            <SearchableCustomerSelect
              customers={customers.items}
              value={form.customerId}
              onChange={(id, customer) => { setForm({ ...form, customerId: id }); setCustomerLabel(customer?.name) }}
              onSearchChange={setCustomerSearch}
              selectedLabel={customerLabel}
              disabled={Boolean(editingId)}
            />
          </Field>
          <Field label="نسبة الدفعة المقدمة (%)">
            <Input type="number" step="1" value={can(P.orders.overrideDeposit) || editingId ? form.depositPercent : String(defaultDepositPercentBp / 100)} onChange={(e) => setForm({ ...form, depositPercent: e.target.value })} placeholder={String(defaultDepositPercentBp / 100)} disabled={!can(P.orders.overrideDeposit)} />
          </Field>
          <Field label="عنوان التسليم">
            <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
        </div>
        {/* Printable details this form does not itself edit (they come
            from the customer card), plus the terms block. */}
        <PrintOptionsRow
          title="إظهار في PDF"
          options={[
            { label: 'هاتف العميل', ...print.toggle('customerPhone') },
            { label: 'عنوان العميل', ...print.toggle('customerAddress') },
            { label: 'البنود والشروط', ...print.toggle('termsAndConditions') }
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
        {/* Document-level, not per-row: hiding "الأبعاد" hides it for
            every item, so the choice is stated once here. */}
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
            <div key={index} style={{ borderTop: '1px solid var(--border-default)', paddingTop: 10, marginTop: 10 }}>
              <div className="grid grid--4">
                <Field label="النوع">
                  <Select value={line.lineKind} onChange={(e) => update({ lineKind: e.target.value, productId: '' })}>
                    <option value="custom">تفصيل خاص</option>
                    <option value="standard">منتج قياسي</option>
                    <option value="delivery">توصيل</option>
                    <option value="installation">تركيب</option>
                  </Select>
                </Field>
                {line.lineKind === 'standard' ? (
                  <Field label="المنتج">
                    <Select value={line.productId} onChange={(e) => {
                      const product = products.data?.find((p) => p.id === Number(e.target.value))
                      update({
                        productId: e.target.value,
                        description: product?.name ?? line.description,
                        unitPrice: product ? String(product.defaultPriceMinor / 1000) : line.unitPrice
                      })
                    }}>
                      <option value="">— اختر —</option>
                      {(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select>
                  </Field>
                ) : (
                  <Field label="الوصف" required>
                    <Input value={line.description} onChange={(e) => update({ description: e.target.value })} />
                  </Field>
                )}
                <Field label="الكمية" required>
                  <Input type="number" step="0.001" value={line.qty} onChange={(e) => update({ qty: e.target.value })} />
                </Field>
                <Field label="سعر الوحدة (د.ل)" required>
                  <Input type="number" step="0.01" value={line.unitPrice} onChange={(e) => update({ unitPrice: e.target.value })} />
                </Field>
              </div>
              {/*
                Selling an EXISTING physical product. Picking one copies
                its frozen manufactured specification onto the line so
                the customer document describes what will actually be
                delivered; the price stays the user's to set. Nothing is
                manufactured and no raw material is consumed again — the
                product was built once, for the order that was cancelled.
              */}
              {can(P.uncollectedProducts.sell) && (
                <div className="grid grid--2">
                  <Field label="بيع منتج جاهز (من المنتجات غير المستلمة)">
                    <Select
                      value={line.uncollectedProductId}
                      onChange={(e) => {
                        const picked = uncollected.data?.find((p) => p.id === Number(e.target.value))
                        if (!picked) {
                          update({ uncollectedProductId: '' })
                          return
                        }
                        update({
                          uncollectedProductId: e.target.value,
                          description: picked.name,
                          specifications: picked.specifications ?? '',
                          dimensions: picked.dimensions ?? '',
                          qty: String(picked.quantityMicro / 1_000_000)
                        })
                      }}
                    >
                      <option value="">— صنف جديد يُصنَّع —</option>
                      {(uncollected.data ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — من الطلب {p.sourceOrderNumber}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {line.uncollectedProductId && (
                    <Field label="ملاحظة">
                      <div className="muted">
                        هذا البند يبيع منتجاً مصنّعاً بالفعل — لن يُستهلك أي خامات ولن يُنشأ له أمر تصنيع.
                      </div>
                    </Field>
                  )}
                </div>
              )}
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
              {lines.length > 1 && (
                <Button variant="ghost" size="sm" onClick={() => setLines(lines.filter((_, i) => i !== index))}>حذف الصنف</Button>
              )}
            </div>
          )
        })}
        <div className="row-actions" style={{ marginTop: 8 }}>
          <Button variant="secondary" size="sm" onClick={() => setLines([...lines, { ...emptyLine }])}>+ صنف</Button>
        </div>

        {/*
          Item 3/7/13: "البنود والشروط" — a technically and visually
          separate section from the invoice items above. Available
          immediately, whether the invoice has been saved yet or not
          (create-flow pass) — a brand-new invoice keeps picked terms in
          this same form state, exactly as it already does for items,
          and they travel to the backend together on "حفظ كمسودة".
        */}
        <div style={{ borderTop: '1px solid var(--border-default)', paddingTop: 10, marginTop: 10 }}>
          <div className="row-actions" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h3 style={{ fontSize: 13, margin: 0 }}>البنود والشروط</h3>
            <Button variant="secondary" size="sm" onClick={() => setTermPicker(new Set())}>+ بند</Button>
          </div>
          {terms.length === 0 ? (
            <p className="muted" style={{ marginTop: 0 }}>لا توجد بنود مضافة لهذه الفاتورة.</p>
          ) : (
            terms.map((term, index) => (
              <div key={term.termIndex} className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'flex-start', padding: '4px 0' }}>
                <span style={{ fontSize: 13 }}>{index + 1}. {term.termText}</span>
                <button type="button" className="icon-btn icon-btn--danger" title="حذف البند" aria-label="حذف البند" onClick={() => void removeTerm(term)}>
                  <Trash2 size={14} strokeWidth={2.25} aria-hidden="true" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="grid grid--3" style={{ marginTop: 12 }}>
          <Field label="نوع الخصم">
            <Select value={form.discountKind} onChange={(e) => setForm({ ...form, discountKind: e.target.value })}>
              <option value="none">بدون</option>
              <option value="amount">مبلغ</option>
              <option value="percent">نسبة %</option>
            </Select>
          </Field>
          <Field label="قيمة الخصم">
            <Input type="number" step="0.01" value={form.discountValue} disabled={form.discountKind === 'none'}
              onChange={(e) => setForm({ ...form, discountValue: e.target.value })} />
          </Field>
          <Field label="ملاحظات" print={print.toggle('notes')}><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
        <div className="grid grid--4">
          <Field label="إجمالي المنتجات" print={print.toggle('subtotal')}><Input value={fmtMoney(subtotal)} disabled /></Field>
          <Field label="الخصم" print={print.toggle('discount')}><Input value={fmtMoney(discount)} disabled /></Field>
          {/* The final amount always prints: it is what the customer
              owes, and already includes every charge exactly once even
              when an individual charge row is hidden. */}
          <Field label="الإجمالي" hint="يشمل التركيب والتوصيل"><Input value={fmtMoney(total)} disabled /></Field>
          <Field label={`الدفعة المقدمة (${depositPct}%)`} print={print.toggle('depositRequired')}><Input value={fmtMoney(deposit)} disabled /></Field>
        </div>
        <div className="grid grid--4">
          <Field label={editingOrderId ? 'الدفعة الأولية المسجّلة سابقاً' : 'المدفوع'} hint={editingOrderId ? 'لا تُكرّر عند إعادة الاعتماد؛ تصحيح المال من دفعات العميل' : 'يُسجّل كدفعة فعلية عند اعتماد الفاتورة'}>
            <Input type="number" step="0.001" min="0" max={editingOrderId ? undefined : total / 1000} disabled={Boolean(editingOrderId) || !can(P.payments.manage)} value={form.paidAmount} onChange={(e) => setForm({ ...form, paidAmount: e.target.value })} />
          </Field>
          {can(P.payments.manage) && can(P.cash.view) && <Field label="الحساب النقدي">
            <Select disabled={Boolean(editingOrderId)} value={form.initialCashAccountId} onChange={(e) => setForm({ ...form, initialCashAccountId: e.target.value })}>
              <option value="">— بدون —</option>
              {(accounts.data ?? []).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </Select>
          </Field>}
          {editingOrderId && <Field label="إجمالي دفعات العميل المحفوظة"><Input value={fmtMoney(existingPaidMinor)} disabled /></Field>}
          <Field label="المتبقي" print={print.toggle('remainingBalance')}><Input value={fmtMoney(total - (editingOrderId ? existingPaidMinor : toMinor(form.paidAmount)))} disabled /></Field>
        </div>
        {editingOrderId && total < existingPaidMinor && <p className="error-note">مدفوع زائد: {fmtMoney(existingPaidMinor - total)}. ستبقى الدفعات كاملة دون ردّ تلقائي؛ راجع مسار دفعات العميل.</p>}
      </Modal>

      {/*
        Item 4/5/6: pick one or more terms from the SAME global catalog
        Settings/the Preliminary Invoice already use (never a duplicate
        list). Terms already on this invoice are excluded outright, so
        a duplicate add is not just rejected — it is not even offered.
      */}
      <Modal open={Boolean(termPicker)} title="إضافة بنود وشروط" onClose={() => setTermPicker(undefined)}
        footer={<><Button onClick={() => void confirmAddTerms()}>إضافة</Button><Button variant="secondary" onClick={() => setTermPicker(undefined)}>إلغاء</Button></>}>
        {(() => {
          const selectedIndexes = new Set(terms.map((t) => t.termIndex))
          const available = (termsCatalog.data ?? [])
            .map((text, index) => ({ index, text }))
            .filter(({ index }) => !selectedIndexes.has(index))
          if (!available.length) {
            return <p className="muted">تمت إضافة جميع البنود المتاحة إلى هذه الفاتورة بالفعل.</p>
          }
          return available.map(({ index, text }) => (
            <label key={index} className="checkbox-row" style={{ marginBottom: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={termPicker?.has(index) ?? false}
                onChange={(e) => {
                  const next = new Set(termPicker)
                  if (e.target.checked) next.add(index); else next.delete(index)
                  setTermPicker(next)
                }}
              />
              <span>{text}</span>
            </label>
          ))
        })()}
      </Modal>
    </>
  )
}
