import { useEffect, useState, type ReactElement } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Printer, FileDown, Play, CheckCircle2, Plus, Pencil, RotateCcw } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import {
  Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Select, Stat, Textarea
} from '@renderer/components/ui'
import { fmtMoney, fmtQty, fmtDateTime, toMicro } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { ManufacturingReversalButton } from '@renderer/components/orders/ManufacturingReversalButton'

export const PRODUCTION_STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  draft: { label: 'مسودة', tone: 'neutral' },
  ready: { label: 'جاهز للتصنيع', tone: 'info' },
  in_production: { label: 'قيد التصنيع', tone: 'warning' },
  completed: { label: 'مكتمل', tone: 'success' },
  cancelled: { label: 'ملغى', tone: 'danger' },
  reversed: { label: 'تم التراجع', tone: 'neutral' }
}

interface PlannedMaterial {
  id: number; materialId: number | null; materialName: string; qtyMicro: number
  unit: string | null; dimensions: string | null; thickness: string | null
  colorCode: string | null; notes: string | null
}
interface ProductionOrder {
  historicalLines?: OrderLine[]
  sheet: {
    id: number; documentNumber: string; orderId: number | null; productId: number | null
    quantityMicro: number; status: string; statusLabel: string; issuedAt: string
    startedAt: string | null; completedAt: string | null; cancelReason: string | null; notes: string | null
  }
  order: {
    id: number; documentNumber: string; totalMinor: number; address: string | null
    requiresInstallation: boolean; requiresDelivery: boolean; notes: string | null; archivedAt: string | null
  } | null
  customerName: string | null
  product: { id: number; name: string; code: string } | null
  plannedMaterials: PlannedMaterial[]
  workers: Array<{ workerId: number; name: string }>
  materialLines: Array<{
    id: number; materialId: number; materialName: string; unit: string; physicalQtyMicro: number
    actualCostMinor?: number; returnedQtyMicro: number; returnedCostMinor?: number
    netConsumedQtyMicro: number; netCostMinor?: number
    pricingRuleUsed: string; colorCode: string | null; notes: string | null
    status: string; reversalMovementId: number | null; replacementLineId: number | null
  }>
  machineUsage: Array<{ id: number; machineId: number; usageQtyMicro: number; finalAmountMinor?: number }>
  assignments: Array<{ id: number; workerId: number; amountMinor?: number; method: string }>
  /** Authored in تجهيز الإنتاج only (CC04B); cost fields are absent without estimated-cost permission. */
  preparedWorkers: Array<{ id: number; workerId: number | null; workerName: string; commissionMode: string; estimatedCostMinor?: number }>
  preparedMachines: Array<{ id: number; machineId: number | null; machineName: string; usageQtyMicro: number; usageUnit: string | null; estimatedCostMinor?: number }>
  actualCostMinor?: number
}
interface OrderLine {
  id: number; description: string; dimensions: string | null; colorCode: string | null
  accessories: string | null; specifications: string | null; quantityMicro: number
}

type MaterialDraft = {
  materialId: string; materialName: string; qty: string; unit: string
  dimensions: string; thickness: string; colorCode: string; notes: string
}

const emptyDraft: MaterialDraft = {
  materialId: '', materialName: '', qty: '1', unit: '', dimensions: '', thickness: '', colorCode: '', notes: ''
}

/**
 * "أمر تصنيع" — deliberately simple.
 *
 * It exists to show the factory what to build, let production adjust the
 * required materials, and print a clean instruction sheet. It is not a
 * second copy of the customer order: the commercial and financial view
 * stays on "طلبات العملاء", one click away via the linked order number.
 */
/** Actual-execution dialogs, keyed by the production order (work sheet)
 *  itself — this is where actual material/machine/worker postings
 *  belong, never the Customer Order screen. */

export function ProductionOrderPage(): ReactElement {
  const { id } = useParams()
  const sheetId = Number(id)
  const navigate = useNavigate()
  const { can } = useSession()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<MaterialDraft[]>([])
  const [error, setError] = useState<string>()
  const [consumptionEdit, setConsumptionEdit] = useState<{
    id: number; materialId: string; qty: string; colorCode: string; notes: string; reason: string
  }>()
  const [consumptionError, setConsumptionError] = useState<string>()
  const [cancelDialog, setCancelDialog] = useState<{ reason: string; error?: string }>()

  const detail = useQuery<ProductionOrder>('production', 'getWorkSheet', { id: sheetId })
  const materials = useQuery<Array<{ id: number; name: string; unit: string; thickness: string | null; dimensions: string | null }>>('materials', 'list', {})

  const sheet = detail.data?.sheet
  const orderId = sheet?.orderId ?? 0
  const orderDetail = useQuery<{ lines: OrderLine[] }>('orders', 'get', { id: orderId }, { enabled: orderId > 0 })

  const isOpen = sheet?.status === 'ready' || sheet?.status === 'in_production'
  const canCorrectConsumption = isOpen && !sheet?.completedAt && Boolean(detail.data?.order) && can(P.inventory.consume)

  useEffect(() => {
    if (!canCorrectConsumption) {
      setConsumptionEdit(undefined)
      setConsumptionError(undefined)
    }
  }, [canCorrectConsumption])

  // Seed the editor from what the production order currently holds.
  useEffect(() => {
    if (!editing && detail.data) {
      setDrafts(detail.data.plannedMaterials.map((line) => ({
        materialId: line.materialId ? String(line.materialId) : '',
        materialName: line.materialName,
        qty: String(line.qtyMicro / 1_000_000),
        unit: line.unit ?? '',
        dimensions: line.dimensions ?? '',
        thickness: line.thickness ?? '',
        colorCode: line.colorCode ?? '',
        notes: line.notes ?? ''
      })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data, editing])

  async function act(fn: () => Promise<unknown>, message: string): Promise<void> {
    try {
      await fn()
      toast.show(message, 'success')
      await detail.reload()
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر التنفيذ', 'error') }
  }


  /**
   * Actual execution — posted against THIS production order (never the
   * customer order) so it always lands against an open, gated work
   * sheet (assertProductionOpen), exactly like the required-materials
   * plan above it. Never touches the plan itself.
   */

  async function saveMaterials(): Promise<void> {
    const valid = drafts.filter((line) => line.materialName.trim() && Number(line.qty) > 0)
    try {
      await call('production', 'updatePlannedMaterials', {
        workSheetId: sheetId,
        lines: valid.map((line) => ({
          materialId: line.materialId ? Number(line.materialId) : null,
          materialName: line.materialName,
          qtyMicro: toMicro(line.qty),
          unit: line.unit || null,
          dimensions: line.dimensions || null,
          thickness: line.thickness || null,
          colorCode: line.colorCode || null,
          notes: line.notes || null
        }))
      })
      toast.show('تم تحديث المواد المطلوبة للتصنيع', 'success')
      setEditing(false); setError(undefined)
      await detail.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  async function printDoc(mode: 'print' | 'exportPdf'): Promise<void> {
    try {
      const result = await call<{ path?: string }>('documents', mode, { kind: 'work_sheet', id: sheetId })
      toast.show(mode === 'print' ? 'تم إرسال أمر التصنيع للطباعة' : `تم حفظ الملف: ${result.path}`, 'success')
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر إخراج المستند', 'error') }
  }

  async function reverseConsumption(id: number): Promise<void> {
    const reason = window.prompt('سبب عكس حركة صرف المادة؟')
    if (!reason?.trim()) return
    if (!window.confirm('سيتم إرجاع الكمية إلى طبقات التكلفة الأصلية وإعادة احتساب التكلفة. هل تريد المتابعة؟')) return
    try {
      await call('production', 'reverseMaterialConsumption', { id, reason })
      toast.show('تم عكس الصرف واستعادة المخزون وطبقات التكلفة', 'success')
      await detail.reload()
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر عكس حركة الصرف', 'error')
    }
  }

  async function correctConsumption(): Promise<void> {
    if (!consumptionEdit || !canCorrectConsumption) return
    try {
      await call('production', 'correctMaterialConsumption', {
        id: consumptionEdit.id,
        materialId: Number(consumptionEdit.materialId),
        physicalQtyMicro: toMicro(consumptionEdit.qty),
        colorCode: consumptionEdit.colorCode || null,
        notes: consumptionEdit.notes || null,
        reason: consumptionEdit.reason
      })
      toast.show('تم عكس الصرف الأصلي وتسجيل التصحيح', 'success')
      setConsumptionEdit(undefined); setConsumptionError(undefined)
      await detail.reload()
    } catch (err) {
      setConsumptionError(err instanceof ApiError ? err.message : 'تعذر تصحيح الصرف')
      if (err instanceof ApiError && err.code === 'CONFLICT') await detail.reload()
    }
  }

  function openCancelDialog(): void {
    setCancelDialog({ reason: '' })
  }

  async function confirmCancelProduction(): Promise<void> {
    if (!cancelDialog) return
    if (!cancelDialog.reason.trim()) {
      setCancelDialog({ ...cancelDialog, error: 'سبب إلغاء أمر التصنيع مطلوب' })
      return
    }
    try {
      await call('production', 'cancelProduction', { id: sheetId, reason: cancelDialog.reason })
      toast.show('تم إلغاء أمر التصنيع', 'success')
      setCancelDialog(undefined)
      await detail.reload()
    } catch (err) {
      setCancelDialog({ ...cancelDialog, error: err instanceof ApiError ? err.message : 'تعذر إلغاء أمر التصنيع' })
    }
  }

  if (detail.loading) return <div className="state">جارٍ التحميل…</div>
  if (!sheet) return <div className="state">{detail.error ?? 'أمر التصنيع غير موجود'}</div>

  const data = detail.data!
  const lines = orderDetail.data?.lines ?? []

  return (
    <>
      <PageHeader
        title={`أمر التصنيع ${sheet.documentNumber}`}
        subtitle={data.order
          ? `${data.customerName ?? ''} — الطلب ${data.order.documentNumber}`
          : `إنتاج مخزون — ${data.product?.name ?? ''}`}
        actions={<>
          <Button variant="ghost" onClick={() => navigate('/worksheets')}>رجوع</Button>
          {data.order && (
            <Button variant="ghost" onClick={() => navigate(`/orders/${data.order!.id}`)}>فتح الطلب</Button>
          )}
          {data.order && can(P.worksheets.issue) && sheet.status === 'ready' && (
            <Button variant="secondary" onClick={() => void act(() => call('production', 'startProduction', { id: sheetId }), 'بدأ التصنيع')}>
              <Play size={15} strokeWidth={2.25} style={{ marginInlineEnd: 6, verticalAlign: '-3px' }} aria-hidden="true" />
              بدء التصنيع
            </Button>
          )}
          {data.order && can(P.worksheets.issue) && isOpen && (
            <Button onClick={() => void act(() => call('production', 'completeProduction', { id: sheetId }), 'اكتمل أمر التصنيع')}>
              <CheckCircle2 size={15} strokeWidth={2.25} style={{ marginInlineEnd: 6, verticalAlign: '-3px' }} aria-hidden="true" />
              إنهاء التصنيع
            </Button>
          )}
          {/* CC04B: workers and machines are authored only in تجهيز الإنتاج; this execution screen
              only displays them (see "الموارد المجهزة" below). */}
          <Button variant="secondary" onClick={() => void printDoc('print')}>
            <Printer size={15} strokeWidth={2.25} style={{ marginInlineEnd: 6, verticalAlign: '-3px' }} aria-hidden="true" />
            طباعة أمر التصنيع
          </Button>
          <Button variant="secondary" onClick={() => void printDoc('exportPdf')}>
            <FileDown size={15} strokeWidth={2.25} style={{ marginInlineEnd: 6, verticalAlign: '-3px' }} aria-hidden="true" />
            PDF
          </Button>
          {data.order && can(P.worksheets.issue) && isOpen && sheet.status === 'ready' && (
            <Button variant="destructive" onClick={openCancelDialog}>إلغاء الأمر</Button>
          )}
          {data.order && sheet.status !== 'reversed' && <ManufacturingReversalButton id={sheetId} sheet={sheet} sourceOrderArchived={Boolean(data.order.archivedAt)} onReversed={async () => { await detail.reload() }} />}
        </>}
      />

      <div className="grid grid--4" style={{ marginBottom: 14 }}>
        <Stat label="الحالة" value={PRODUCTION_STATUS[sheet.status]?.label ?? sheet.status}
          tone={sheet.status === 'completed' ? 'success' : sheet.status === 'cancelled' ? 'danger' : 'brand'} />
        <Stat label="تاريخ الإصدار" value={fmtDateTime(sheet.issuedAt)} />
        <Stat label="بدء التصنيع" value={sheet.startedAt ? fmtDateTime(sheet.startedAt) : '—'} />
        <Stat label="اكتمال التصنيع" value={sheet.completedAt ? fmtDateTime(sheet.completedAt) : '—'} />
      </div>

      {sheet.status === 'cancelled' && (
        <div className="error-note" style={{ marginBottom: 12 }}>ملغى — {sheet.cancelReason}</div>
      )}

      <Card title="المطلوب تصنيعه" actions={
        <div className="row-actions">
          {data.order?.requiresInstallation && <Badge tone="info">يشمل تركيباً</Badge>}
          {data.order?.requiresDelivery && <Badge tone="info">يشمل توصيلاً</Badge>}
          <Badge tone="neutral">العامل المسؤول: {data.workers.map((w) => w.name).join('، ') || '—'}</Badge>
        </div>
      }>
        <DataTable
          rows={data.order ? (data.historicalLines ?? lines) : [{
            id: 0,
            description: data.product?.name ?? '',
            dimensions: null, colorCode: null, accessories: null, specifications: null,
            quantityMicro: sheet.quantityMicro
          }]}
          rowKey={(row) => row.id}
          empty="لا توجد بنود"
          columns={[
            { key: 'desc', header: 'المنتج / البند', render: (row) => row.description },
            { key: 'qty', header: 'الكمية', numeric: true, render: (row) => fmtQty(row.quantityMicro) },
            { key: 'dim', header: 'الأبعاد', render: (row) => row.dimensions ?? '—' },
            { key: 'color', header: 'اللون / التشطيب', render: (row) => row.colorCode ?? '—' },
            { key: 'acc', header: 'الإكسسوارات', render: (row) => row.accessories ?? '—' },
            { key: 'spec', header: 'المواصفات', render: (row) => row.specifications ?? '—' }
          ]}
        />
        {sheet.notes && <p className="muted" style={{ marginTop: 8 }}>ملاحظات التصنيع: {sheet.notes}</p>}
      </Card>

      {/* The key editable part of the production order (items 8/9/10). */}
      <Card title="المواد المطلوبة للتصنيع" actions={
        data.order && can(P.worksheets.issue) && isOpen ? (
          editing ? (
            <div className="row-actions">
              <Button size="sm" onClick={() => void saveMaterials()}>حفظ المواد</Button>
              <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setError(undefined) }}>إلغاء</Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => { setEditing(true); setError(undefined) }}>تعديل المواد</Button>
          )
        ) : undefined
      }>
        <ErrorNote>{error}</ErrorNote>
        {editing ? (
          <>
            <p className="muted">
              تعديل هذه القائمة يخص أمر التصنيع فقط — الفاتورة المبدئية المعتمدة تبقى كما هي.
            </p>
            {drafts.map((line, index) => {
              const update = (patch: Partial<MaterialDraft>): void => {
                const next = [...drafts]; next[index] = { ...line, ...patch }; setDrafts(next)
              }
              return (
                <div key={index} className="subform-row">
                  <div className="grid grid--4">
                    <Field label="المادة">
                      <Select value={line.materialId} onChange={(e) => {
                        const material = materials.data?.find((m) => m.id === Number(e.target.value))
                        update({
                          materialId: e.target.value,
                          materialName: material?.name ?? line.materialName,
                          unit: material?.unit ?? line.unit,
                          thickness: material?.thickness ?? line.thickness,
                          dimensions: material?.dimensions ?? line.dimensions
                        })
                      }}>
                        <option value="">— مادة خارج المخزون —</option>
                        {(materials.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </Select>
                    </Field>
                    <Field label="الاسم" required><Input value={line.materialName} onChange={(e) => update({ materialName: e.target.value })} /></Field>
                    <Field label="الكمية" required><Input type="number" step="0.001" value={line.qty} onChange={(e) => update({ qty: e.target.value })} /></Field>
                    <Field label="الوحدة"><Input value={line.unit} onChange={(e) => update({ unit: e.target.value })} /></Field>
                  </div>
                  <div className="grid grid--4">
                    <Field label="الأبعاد / المقاس"><Input value={line.dimensions} onChange={(e) => update({ dimensions: e.target.value })} /></Field>
                    <Field label="السماكة"><Input value={line.thickness} onChange={(e) => update({ thickness: e.target.value })} /></Field>
                    <Field label="اللون / التشطيب"><Input value={line.colorCode} onChange={(e) => update({ colorCode: e.target.value })} /></Field>
                    <Field label="ملاحظات"><Input value={line.notes} onChange={(e) => update({ notes: e.target.value })} /></Field>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setDrafts(drafts.filter((_, i) => i !== index))}>حذف هذه المادة</Button>
                </div>
              )
            })}
            <Button variant="secondary" size="sm" onClick={() => setDrafts([...drafts, { ...emptyDraft }])}>
              <Plus size={14} strokeWidth={2.5} style={{ marginInlineEnd: 4, verticalAlign: '-2px' }} aria-hidden="true" />
              إضافة مادة
            </Button>
          </>
        ) : (
          <DataTable
            rows={data.plannedMaterials}
            rowKey={(row) => row.id}
            empty="لم تُحدَّد مواد للتصنيع بعد"
            columns={[
              { key: 'material', header: 'المادة', render: (row) => row.materialName },
              { key: 'qty', header: 'الكمية', numeric: true, render: (row) => fmtQty(row.qtyMicro) },
              { key: 'unit', header: 'الوحدة', render: (row) => row.unit ?? '—' },
              { key: 'dim', header: 'الأبعاد / المقاس', render: (row) => row.dimensions ?? '—' },
              { key: 'thick', header: 'السماكة', render: (row) => row.thickness ?? '—' },
              { key: 'color', header: 'اللون / التشطيب', render: (row) => row.colorCode ?? '—' },
              { key: 'notes', header: 'ملاحظات', render: (row) => row.notes ?? '—' }
            ]}
          />
        )}
      </Card>

      <Card title="الموارد المجهزة (من تجهيز الإنتاج)">
        <p className="muted" style={{ marginTop: 0 }}>
          العمال والآلات تُحدَّد في تجهيز الإنتاج فقط. تصبح عمولات العمال مستحقات وتُحتسب تكلفة الآلات فعلياً عند إنهاء التصنيع.
        </p>
        <DataTable
          rows={data.preparedWorkers}
          rowKey={(row) => row.id}
          empty="لا يوجد عمال في تجهيز الإنتاج"
          columns={[
            { key: 'worker', header: 'العامل / الفني', render: (row) => row.workerName },
            ...(can(P.orders.viewEstimatedCost) ? [{ key: 'commission', header: 'العمولة', numeric: true, render: (row: ProductionOrder['preparedWorkers'][number]) => fmtMoney(row.estimatedCostMinor ?? 0) }] : [])
          ]}
        />
        <DataTable
          rows={data.preparedMachines}
          rowKey={(row) => row.id}
          empty="لا توجد آلات في تجهيز الإنتاج"
          columns={[
            { key: 'machine', header: 'الآلة', render: (row) => row.machineName },
            { key: 'usage', header: 'الاستخدام', numeric: true, render: (row) => `${fmtQty(row.usageQtyMicro)} ${row.usageUnit ?? ''}` },
            ...(can(P.orders.viewEstimatedCost) ? [{ key: 'cost', header: 'التكلفة المخططة', numeric: true, render: (row: ProductionOrder['preparedMachines'][number]) => fmtMoney(row.estimatedCostMinor ?? 0) }] : [])
          ]}
        />
      </Card>

      {/* Actual consumption is a separate concept (item 15) — shown here
          for reference, but it never overwrites the plan above. */}
      <Card title="الصرف الفعلي من المخزون">
          <DataTable
            rows={data.materialLines}
            rowKey={(row) => row.id}
            empty="لم يُصرف من المخزون على هذا الأمر بعد"
            columns={[
              { key: 'name', header: 'المادة', render: (row) => row.materialName },
              { key: 'qty', header: 'المصروف', numeric: true, render: (row) => fmtQty(row.physicalQtyMicro, row.unit) },
              { key: 'returned', header: 'المرتجع', numeric: true, render: (row) => fmtQty(row.returnedQtyMicro, row.unit) },
              { key: 'net', header: 'صافي الاستهلاك', numeric: true, render: (row) => fmtQty(row.netConsumedQtyMicro, row.unit) },
              ...(can(P.orders.viewActualCost) ? [{ key: 'cost', header: 'صافي التكلفة', numeric: true, render: (row: ProductionOrder['materialLines'][number]) => fmtMoney(row.netCostMinor ?? 0) }] : []),
              { key: 'color', header: 'اللون', render: (row) => row.colorCode ?? '—' },
              { key: 'status', header: 'الحالة', render: (row) => <Badge tone={row.status === 'reversed' ? 'neutral' : 'success'}>{row.status === 'reversed' ? 'معكوس' : 'فعّال'}</Badge> },
              {
                key: 'actions', header: '', render: (row) => data.order && can(P.inventory.consume) && row.status === 'active' ? (
                  <div className="row-actions">
                    {canCorrectConsumption && <button type="button" className="icon-btn" title="تعديل" aria-label="تعديل" onClick={() => {
                      setConsumptionEdit({ id: row.id, materialId: String(row.materialId), qty: String(row.physicalQtyMicro / 1_000_000), colorCode: row.colorCode ?? '', notes: row.notes ?? '', reason: '' })
                      setConsumptionError(undefined)
                    }}>
                      <Pencil size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>}
                    <button type="button" className="icon-btn icon-btn--danger" title="عكس الحركة" aria-label="عكس الحركة" onClick={() => void reverseConsumption(row.id)}>
                      <RotateCcw size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </div>
                ) : null
              }
            ]}
          />
          <div className="grid grid--2" style={{ marginTop: 10 }}>
            {can(P.orders.viewActualCost) && <Stat label="إجمالي التكلفة الفعلية لأمر التصنيع" value={fmtMoney(data.actualCostMinor ?? 0)} tone="brand" />}
            <Stat label="عدد العمال المكلفين" value={String(data.assignments.length)} />
          </div>
        </Card>

      <Modal open={Boolean(consumptionEdit) && canCorrectConsumption} title="تصحيح صرف مادة" onClose={() => setConsumptionEdit(undefined)}
        footer={<><Button onClick={() => void correctConsumption()}>حفظ التصحيح</Button><Button variant="secondary" onClick={() => setConsumptionEdit(undefined)}>إلغاء</Button></>}>
        <ErrorNote>{consumptionError}</ErrorNote>
        <p className="muted">سيُعكس السجل الأصلي وتُستعاد طبقاته، ثم تُسجّل الكمية الصحيحة كصرف جديد.</p>
        <Field label="المادة" required>
          <Select value={consumptionEdit?.materialId ?? ''} onChange={(e) => setConsumptionEdit({ ...consumptionEdit!, materialId: e.target.value })}>
            {(materials.data ?? []).map((material) => <option key={material.id} value={material.id}>{material.name} ({material.unit})</option>)}
          </Select>
        </Field>
        <Field label="الكمية الصحيحة" required><Input type="number" step="0.001" value={consumptionEdit?.qty ?? ''} onChange={(e) => setConsumptionEdit({ ...consumptionEdit!, qty: e.target.value })} /></Field>
        <Field label="كود اللون (اختياري)"><Input value={consumptionEdit?.colorCode ?? ''} onChange={(e) => setConsumptionEdit({ ...consumptionEdit!, colorCode: e.target.value })} /></Field>
        <Field label="ملاحظات"><Textarea value={consumptionEdit?.notes ?? ''} onChange={(e) => setConsumptionEdit({ ...consumptionEdit!, notes: e.target.value })} /></Field>
        <Field label="سبب التصحيح" required><Input value={consumptionEdit?.reason ?? ''} onChange={(e) => setConsumptionEdit({ ...consumptionEdit!, reason: e.target.value })} /></Field>
      </Modal>

      <Modal open={Boolean(cancelDialog)} title="إلغاء أمر التصنيع" onClose={() => setCancelDialog(undefined)}
        footer={<><Button variant="destructive" onClick={() => void confirmCancelProduction()}>إلغاء الأمر</Button><Button variant="secondary" onClick={() => setCancelDialog(undefined)}>تراجع</Button></>}>
        <ErrorNote>{cancelDialog?.error}</ErrorNote>
        <p className="muted">
          سيتم إلغاء أمر التصنيع هذا نهائياً. ما تم صرفه أو تسجيله عليه فعلياً من مواد أو آلات أو عمالة يبقى كما هو
          — لا شيء منه يُعكس بإلغاء الأمر نفسه.
        </p>
        <Field label="سبب إلغاء أمر التصنيع" required>
          <Input value={cancelDialog?.reason ?? ''} onChange={(e) => setCancelDialog(cancelDialog ? { ...cancelDialog, reason: e.target.value, error: undefined } : undefined)} />
        </Field>
      </Modal>
    </>
  )
}
