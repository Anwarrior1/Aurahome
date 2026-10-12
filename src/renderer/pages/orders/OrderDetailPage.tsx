import { useState, type ReactElement } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Pencil, Trash2 } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, DataTable, ErrorNote, Field, Input, LoadMore, Modal, PageHeader, Select, Stat, Textarea } from '@renderer/components/ui'
import { fmtMoney, fmtQty, fmtDate, fmtDateTime, toMinor, toMicro } from '@renderer/lib/format'
import { costOf, unitCostMicro } from '@shared/money/cost'
import { SearchableMaterialSelect } from '@renderer/components/materials/SearchableMaterialSelect'
import { SearchableColorSelect } from '@renderer/components/materials/SearchableColorSelect'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { PRODUCTION_PREP_LOCKED_MESSAGE } from '@shared/production/manufacturing-lifecycle'
import { PAYMENT_STATUS, ORDER_STATUS } from './OrdersPage'
import {
  COMPLETION_ACTION_LABEL,
  COMPLETION_COST_LABEL,
  COMPLETION_LABEL,
  EXIT_PERMIT_KINDS,
  EXIT_PERMIT_LABEL,
  permitIncludesInstallation,
  type CompletionKind,
  type ExitPermitKind
} from '@shared/production/exit-permit'

interface OrderDetail {
  actions: {
    canCancel: boolean
    canDeleteCancel: boolean
    canArchive: boolean
    canRefundPayment: boolean
    refundableMinor: number
  }
  order: {
    id: number
    documentNumber: string
    customerId: number
    status: string
    archivedAt: string | null
    subtotalMinor: number
    discountMinor: number
    totalMinor: number
    depositPercentBp: number
    depositRequiredMinor: number
    paidMinor: number
    remainingMinor: number
    paymentStatus: string
    requiresInstallation: boolean
    requiresDelivery: boolean
    address: string | null
    completedAt: string | null
    cancelReason: string | null
    notes: string | null
    createdAt: string
  }
  customer: { name: string; phone: string | null; address: string | null } | undefined
  workflow: {
    manufacturingIssued: boolean
    manufacturingInProduction: boolean
    /** BL-04: only custom lines are manufactured; standard lines come from ready stock. */
    needsManufacturing: boolean
    standardStockPending: boolean
    releaseIssued: boolean
    resumeFulfilmentBlocked?: boolean
    activeCompletion: boolean
    deliveryDone: boolean
    installationDone: boolean
    requiredCompletion: null | {
      releaseId: number
      permitKind: ExitPermitKind
      completionKind: CompletionKind
      address: string | null
      workers: Array<{ workerId: number; name: string }>
    }
  }
  lines: Array<{
    id: number
    description: string
    dimensions: string | null
    colorCode: string | null
    quantityMicro: number
    unitPriceMinor: number
    lineTotalMinor: number
  }>
  payments: Array<{
    rowKey: string
    id: number
    entryType: 'payment' | 'refund'
    amountMinor: number
    paidAt: string
    effectiveBusinessDay: string
    executionAt: string
    notes: string | null
  }>
}
/**
 * The Customer Order's OWN production configuration (workflow pass).
 *
 * The order is the authoritative planning point: these
 * planned_materials/planned_machines/planned_workers rows are seeded
 * from the product master when the approved invoice is approved, and
 * are then owned and edited HERE. They are planning only — not
 * order_material_lines, not inventory_movements, not fifo_allocations,
 * and never re-derived from the live product master afterwards. Actual
 * execution and its real cost live on the Production Order screen.
 */
interface PlanningSnapshot {
  materials?: Array<{
    id: number
    materialId: number | null
    materialName: string
    qtyMicro: number
    unit: string | null
    dimensions: string | null
    thickness: string | null
    colorCode: string | null
    notes: string | null
    estimatedUnitCostMicro: number
    estimatedTotalMinor: number
  }>
  machines?: Array<{
    id: number
    machineId: number | null
    machineName: string
    usageQtyMicro: number
    usageUnit: string | null
    rateMicro: number | null
    notes: string | null
    estimatedCostMinor: number
  }>
  workers?: Array<{
    id: number
    workerId: number | null
    workerName: string
    commissionMode: 'estimated' | 'meter'
    meterRateMicro: number | null
    meterQtyMicro: number | null
    estimatedCostMinor: number
    notes: string | null
  }>
  expenses?: Array<{ id: number; expenseName: string; amountMinor: number }>
  estimatedMaterialMinor?: number
  estimatedMachineMinor?: number
  estimatedWorkerMinor?: number
  estimatedOtherMinor?: number
  estimatedOrderExpenseMinor?: number
  totalEstimatedCostMinor?: number
  sellingPriceMinor: number
  expectedProfitMinor?: number
}
interface Fulfillment {
  status: string
  deliveries: Array<{ id: number; kind: string; status: string }>
}
interface OrderPurchases {
  orderId: number
  totalMinor: number
  purchases: Array<{
    id: number
    documentNumber: string
    supplierName: string
    purchaseDate: string
    totalMinor: number
    paidMinor: number
    paymentStatus: string
  }>
}
interface MaterialReturnSummary {
  materialId: number
  materialName: string
  unit: string
  issuedQtyMicro: number
  issuedCostMinor?: number
  returnedQtyMicro: number
  returnedCostMinor?: number
  returnableQtyMicro: number
  netConsumedQtyMicro: number
  netCostMinor?: number
}
interface MaterialReturnRow {
  id: number
  orderId: number
  materialId: number
  materialName: string
  unit: string
  quantityMicro: number
  returnedCostMinor?: number
  notes: string | null
  status: string
  version: number
  username: string | null
  createdAt: string
  updatedAt: string | null
}
interface MaterialReturnsOverview {
  materials: MaterialReturnSummary[]
  returns: MaterialReturnRow[]
}
interface MaterialDraft {
  id?: number
  materialId: string
  materialName: string
  qty: string
  unit: string
  dimensions: string
  thickness: string
  colorCode: string
  unitCost: string
  notes: string
}
interface MachineDraft {
  id?: number
  machineId: string
  machineName: string
  usageQty: string
  usageUnit: string
  rateMicro: number | null
  legacyCostMinor: number
}
interface WorkerDraft {
  workerId: string
  workerName: string
  commissionMode: 'estimated' | 'meter'
  cost: string
  meterRate: string
  meterQty: string
}
interface ExpenseDraft {
  expenseName: string
  amount: string
}

const emptyMaterial: MaterialDraft = {
  materialId: '',
  materialName: '',
  qty: '1',
  unit: '',
  dimensions: '',
  thickness: '',
  colorCode: '',
  unitCost: '',
  notes: ''
}
const emptyMachine: MachineDraft = {
  machineId: '',
  machineName: '',
  usageQty: '',
  usageUnit: '',
  rateMicro: null,
  legacyCostMinor: 0
}
const emptyWorker: WorkerDraft = {
  workerId: '',
  workerName: '',
  commissionMode: 'estimated',
  cost: '',
  meterRate: '',
  meterQty: ''
}
const emptyExpense: ExpenseDraft = { expenseName: '', amount: '' }

type ConfigTab = 'materials' | 'machines' | 'workers' | 'expenses'

function meterCommissionMinor(line: WorkerDraft): number {
  return costOf(toMicro(line.meterQty), unitCostMicro(toMicro(line.meterRate)))
}

function machineEstimateMinor(line: MachineDraft): number {
  if (line.rateMicro === null) return line.legacyCostMinor
  if (!Number.isInteger(line.rateMicro) || line.rateMicro <= 0) return 0
  return costOf(toMicro(line.usageQty), unitCostMicro(line.rateMicro))
}

const FULFILLMENT_LABEL: Record<string, string> = {
  not_delivered: 'لم يُسلَّم بعد',
  delivered: 'تم التوصيل',
  installed: 'تم التركيب',
  delivered_installed: 'تم التوصيل والتركيب',
  handed_over: 'تم التسليم'
}

const UNCOLLECTED_STATUS: Record<string, string> = {
  available: 'متاح للبيع',
  reserved: 'محجوز على فاتورة',
  sold: 'تم البيع',
  resumed: 'استؤنف إلى الطلب الأصلي'
}

type Dialog = 'payment' | 'refund' | 'worksheet' | 'release' | 'delivery' | 'cancel' | 'editOrder' | 'production' | undefined

export function OrderDetailPage(): ReactElement {
  const { id } = useParams()
  const orderId = Number(id)
  const navigate = useNavigate()
  const { can } = useSession()
  const toast = useToast()
  const [dialog, setDialog] = useState<Dialog>()
  const [error, setError] = useState<string>()
  const [form, setForm] = useState<Record<string, string>>({})
  // The exit permit's installation/delivery team (release_workers, item
  // 3) — a proper many-to-many, so it lives as its own array rather
  // than squeezed into the shared string-only `form` above.
  const [releaseWorkerIds, setReleaseWorkerIds] = useState<number[]>([])
  const [completionWorkerIds, setCompletionWorkerIds] = useState<number[]>([])
  // The order's own production configuration (Part 4), edited here.
  const [tab, setTab] = useState<ConfigTab>('materials')
  const [planMaterials, setPlanMaterials] = useState<MaterialDraft[]>([])
  const [planMachines, setPlanMachines] = useState<MachineDraft[]>([])
  const [planWorkers, setPlanWorkers] = useState<WorkerDraft[]>([])
  const [planExpenses, setPlanExpenses] = useState<ExpenseDraft[]>([])
  const [returnDialog, setReturnDialog] = useState<{
    mode: 'create' | 'edit'
    id?: number
    materialId: string
    quantity: string
    notes: string
    version?: number
    requestKey: string
  }>()
  const [deleteReturn, setDeleteReturn] = useState<MaterialReturnRow>()
  const [deleteReturnRequestKey, setDeleteReturnRequestKey] = useState('')
  const [returnError, setReturnError] = useState<string>()
  const [returnBusy, setReturnBusy] = useState(false)
  const [processing, setProcessing] = useState(false)

  const detail = useQuery<OrderDetail>('orders', 'get', { id: orderId })
  // Traceability only — what a cancelled order physically left behind.
  // Read straight from the DTO rather than the derived `order` below,
  // because hooks must run before this component's early returns.
  const transferred = useQuery<Array<{ id: number; name: string; status: string }>>(
    'uncollectedProducts',
    'forOrder',
    { id: orderId },
    {
      enabled: can(P.uncollectedProducts.view) && detail.data?.order?.status === 'cancelled'
    }
  )
  // The frozen commercial + planning snapshot — materials, machines,
  // workers and the estimate, all inherited from the preliminary
  // invoice at conversion. Never actual execution data.
  const planningSnapshot = useQuery<PlanningSnapshot>('orders', 'planningSnapshot', { id: orderId }, { enabled: can(P.productionPrep.view) })
  const workers = useQuery<Array<{ id: number; name: string }>>('workers', 'list', {
    activeOnly: true
  })
  const accounts = useQuery<Array<{ id: number; name: string; active: boolean }>>('cash', 'accounts')
  const worksheets = usePagedQuery<{ id: number; documentNumber: string; issuedAt: string; status: string }>('production', 'listWorkSheets', { orderId, includeReversed: true }, { mode: 'append', limit: 100 })
  const releases = usePagedQuery<{
      id: number
      documentNumber: string
      kind: ExitPermitKind
      authorizedAt: string
      status: string
      workers: Array<{ workerId: number; name: string }>
    }>('production', 'listReleases', { orderId, includeReversed: true }, { mode: 'append', limit: 100 })
  const fulfillment = useQuery<Fulfillment>('orders', 'fulfillment', { id: orderId })
  const finalInvoice = useQuery<{
    invoice: { id: number; documentNumber: string; status: string } | null
  }>('finalInvoices', 'forOrder', { orderId })
  const orderPurchases = useQuery<OrderPurchases>('purchases', 'forOrder', { orderId }, { enabled: can(P.purchases.view) })
  const materialReturns = useQuery<MaterialReturnsOverview>('production', 'materialReturns', { orderId })
  // The production-configuration editors reuse the existing masters.
  const rawMaterials = useQuery<Array<{ id: number; sku: string; name: string; unit: string;
      thickness: string | null
      dimensions: string | null
      currentMarketPriceMicro: number
    }>
  >('materials', 'list', {}, { enabled: can(P.orders.viewEstimatedCost) })
  const colors = useQuery<Array<{ id: number; code: string; name: string }>>('colors', 'list', { activeOnly: true }, { enabled: can(P.colors.view) })
  const machineList = useQuery<Array<{ id: number; name: string; costingUnit: string; defaultRateMicro: number }>>('machines', 'list', { activeOnly: true }, { enabled: can(P.orders.viewEstimatedCost) })
  const workerList = useQuery<Array<{ id: number; name: string }>>('workers', 'list', { activeOnly: true }, { enabled: can(P.orders.viewEstimatedCost) })

  const order = detail.data?.order
  const openDialog = (kind: Dialog, initial: Record<string, string> = {}): void => {
    setForm(initial)
    setError(undefined)
    setDialog(kind)
    setReleaseWorkerIds([])
  }

  const openCompletionDialog = (): void => {
    const required = detail.data?.workflow.requiredCompletion
    if (!required) return
    setCompletionWorkerIds(required.workers.map((worker) => worker.workerId))
    openDialog('delivery', {
      kind: required.completionKind,
      releaseId: String(required.releaseId),
      address: required.address ?? '',
      cost: '',
      notes: ''
    })
  }
  const reloadAll = async (): Promise<void> => {
    await Promise.all([
      detail.reload(),
      worksheets.reload(),
      releases.reload(),
      fulfillment.reload(),
      finalInvoice.reload(),
      planningSnapshot.reload(),
      orderPurchases.reload(),
      materialReturns.reload(),
      accounts.reload()
    ])
  }

  function openCreateReturn(): void {
    const first = materialReturns.data?.materials.find((item) => item.returnableQtyMicro > 0)
    setReturnDialog({
      mode: 'create',
      materialId: first ? String(first.materialId) : '',
      quantity: '',
      notes: '',
      requestKey: crypto.randomUUID()
    })
    setReturnError(undefined)
  }

  function openEditReturn(row: MaterialReturnRow): void {
    setReturnDialog({
      mode: 'edit',
      id: row.id,
      materialId: String(row.materialId),
      quantity: String(row.quantityMicro / 1_000_000),
      notes: row.notes ?? '',
      version: row.version,
      requestKey: crypto.randomUUID()
    })
    setReturnError(undefined)
  }

  async function saveMaterialReturn(): Promise<void> {
    if (!returnDialog || returnBusy) return
    const quantityMicro = toMicro(returnDialog.quantity)
    if (quantityMicro <= 0) {
      setReturnError('الكمية المراد إرجاعها يجب أن تكون أكبر من صفر')
      return
    }
    setReturnBusy(true)
    setReturnError(undefined)
    try {
      if (returnDialog.mode === 'create') {
        await call('production', 'createMaterialReturn', {
          orderId,
          materialId: Number(returnDialog.materialId),
          quantityMicro,
          notes: returnDialog.notes || null,
          requestKey: returnDialog.requestKey
        })
      } else {
        await call('production', 'editMaterialReturn', {
          id: returnDialog.id,
          quantityMicro,
          notes: returnDialog.notes || null,
          expectedVersion: returnDialog.version,
          requestKey: returnDialog.requestKey
        })
      }
      toast.show(returnDialog.mode === 'create' ? 'تم إرجاع المادة إلى المخزون' : 'تم تعديل المرتجع وتطبيق الفرق فقط', 'success')
      setReturnDialog(undefined)
      await reloadAll()
    } catch (err) {
      setReturnError(err instanceof ApiError ? err.message : 'تعذر حفظ مرتجع المادة')
    } finally {
      setReturnBusy(false)
    }
  }

  async function confirmDeleteReturn(): Promise<void> {
    if (!deleteReturn || returnBusy) return
    setReturnBusy(true)
    setReturnError(undefined)
    try {
      await call('production', 'reverseMaterialReturn', {
        id: deleteReturn.id,
        expectedVersion: deleteReturn.version,
        requestKey: deleteReturnRequestKey
      })
      toast.show('تم عكس مرتجع المادة بأمان', 'success')
      setDeleteReturn(undefined)
      await reloadAll()
    } catch (err) {
      setReturnError(err instanceof ApiError ? err.message : 'تعذر حذف المرتجع')
    } finally {
      setReturnBusy(false)
    }
  }

  async function run(fn: () => Promise<unknown>, message: string): Promise<void> {
    if (processing) return
    setProcessing(true)
    setError(undefined)
    try {
      await fn()
      toast.show(message, 'success')
      setDialog(undefined)
      await reloadAll()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر التنفيذ')
    } finally {
      setProcessing(false)
    }
  }

  /**
   * Hydrates the three editors from the order's saved configuration.
   * `loadedFor` keys the hydration to the snapshot actually fetched, so
   * an edit in progress is never overwritten by a re-render, and a
   * reload after saving picks the new rows up.
   */
  const snapshot = planningSnapshot.data
  const [loadedFor, setLoadedFor] = useState<PlanningSnapshot>()
  if (snapshot && snapshot !== loadedFor) {
    setLoadedFor(snapshot)
    setPlanMaterials(
      (snapshot.materials ?? []).map((line) => ({
        id: line.id,
        materialId: line.materialId ? String(line.materialId) : '',
        materialName: line.materialName,
        qty: String(line.qtyMicro / 1_000_000),
        unit: line.unit ?? '',
        dimensions: line.dimensions ?? '',
        thickness: line.thickness ?? '',
        colorCode: line.colorCode ?? '',
        notes: line.notes ?? '',
        unitCost: String((line.estimatedUnitCostMicro ?? 0) / 1_000_000)
      }))
    )
    setPlanMachines(
      (snapshot.machines ?? []).map((line) => ({
        id: line.id,
        machineId: line.machineId ? String(line.machineId) : '',
        machineName: line.machineName,
        usageQty: line.usageQtyMicro ? String(line.usageQtyMicro / 1_000_000) : '',
        usageUnit: line.usageUnit ?? '',
        rateMicro: line.rateMicro,
        legacyCostMinor: line.estimatedCostMinor ?? 0
      }))
    )
    setPlanWorkers(
      (snapshot.workers ?? []).map((line) => ({
        workerId: line.workerId ? String(line.workerId) : '',
        workerName: line.workerName,
        commissionMode: line.commissionMode ?? 'estimated',
        cost: String(line.estimatedCostMinor / 1000),
        meterRate: line.meterRateMicro === null ? '' : String(line.meterRateMicro / 1_000_000),
        meterQty: line.meterQtyMicro === null ? '' : String(line.meterQtyMicro / 1_000_000)
      }))
    )
    setPlanExpenses(
      (snapshot.expenses ?? []).map((line) => ({
        expenseName: line.expenseName,
        amount: String(line.amountMinor / 1000)
      }))
    )
  }

  /** Planning only — no stock, no payroll, no cash (Parts 11/12/13). */
  async function saveConfig(which: ConfigTab): Promise<void> {
    try {
      if (which === 'materials') {
        await call('orders', 'savePlannedMaterials', {
          orderId,
          lines: planMaterials
            .filter((line) => line.materialName.trim() && Number(line.qty) > 0)
            .map((line) => ({
              id: line.id,
              materialId: line.materialId ? Number(line.materialId) : null,
              materialName: line.materialName,
              qtyMicro: Math.round(Number(line.qty) * 1_000_000),
              unit: line.unit || null,
              dimensions: line.dimensions || null,
              thickness: line.thickness || null,
              colorCode: line.colorCode || null,
              notes: line.notes || null,
              estimatedUnitCostMicro: Math.round(Number(line.unitCost || 0) * 1_000_000)
            }))
        })
      } else if (which === 'machines') {
        await call('orders', 'savePlannedMachines', {
          orderId,
          lines: planMachines
            .filter((line) => line.machineName.trim())
            .map((line) => ({
              id: line.id,
              machineId: line.machineId ? Number(line.machineId) : null,
              machineName: line.machineName,
              usageQtyMicro: line.usageQty ? Math.round(Number(line.usageQty) * 1_000_000) : 0,
              usageUnit: line.usageUnit || null
            }))
        })
      } else if (which === 'workers') {
        await call('orders', 'savePlannedWorkers', {
          orderId,
          lines: planWorkers
            .filter((line) => line.workerName.trim())
            .map((line) => ({
              workerId: line.workerId ? Number(line.workerId) : null,
              workerName: line.workerName,
              commissionMode: line.commissionMode,
              estimatedCostMinor: line.commissionMode === 'estimated' ? toMinor(line.cost) : undefined,
              meterRateMicro: line.commissionMode === 'meter' ? toMicro(line.meterRate) : null,
              meterQtyMicro: line.commissionMode === 'meter' ? toMicro(line.meterQty) : null
            }))
        })
      } else {
        await call('orders', 'savePlannedExpenses', {
          orderId,
          lines: planExpenses
            .filter((line) => line.expenseName.trim())
            .map((line) => ({
              expenseName: line.expenseName,
              amountMinor: toMinor(line.amount)
            }))
        })
      }
      toast.show('تم حفظ تجهيز الإنتاج', 'success')
      setLoadedFor(undefined)
      await planningSnapshot.reload()
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر الحفظ', 'error')
    }
  }

  async function printDoc(kind: string, docId: number, mode: 'print' | 'exportPdf'): Promise<void> {
    try {
      const result = await call<{ path?: string }>('documents', mode, { kind, id: docId })
      toast.show(mode === 'print' ? 'تم إرسال المستند للطباعة' : `تم حفظ الملف: ${result.path}`, 'success')
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر إخراج المستند', 'error')
    }
  }

  if (detail.loading) return <div className="state">جارٍ التحميل…</div>
  if (!order) return <div className="state">{detail.error ?? 'الطلب غير موجود'}</div>

  const depositMet = order.paidMinor >= order.depositRequiredMinor
  const fullyPaid = order.paidMinor >= order.totalMinor
  // The order owns its production configuration while it is open; once
  // completed or cancelled it is frozen exactly as it stood (the server
  // enforces the same rule — this only mirrors it in the UI).
  const manufacturingCompleted = worksheets.items.some((sheet) => sheet.status === 'completed')
  const configEditable = can(P.productionPrep.manage) && order.status !== 'cancelled' && order.status !== 'awaiting_approval' && !order.archivedAt && !order.completedAt && !manufacturingCompleted
  const selectedReturnMaterial = materialReturns.data?.materials.find((item) => item.materialId === Number(returnDialog?.materialId))
  const editedReturn = returnDialog?.mode === 'edit' ? materialReturns.data?.returns.find((item) => item.id === returnDialog.id) : undefined
  const maxReturnQtyMicro = selectedReturnMaterial ? selectedReturnMaterial.returnableQtyMicro + (editedReturn?.quantityMicro ?? 0) : 0
  const returnAvailable = materialReturns.data?.materials.some((item) => item.returnableQtyMicro > 0) === true
  const manufacturingIssued = detail.data!.workflow.manufacturingIssued
  const releaseIssued = detail.data!.workflow.releaseIssued
  const requiredCompletion = detail.data!.workflow.requiredCompletion
  const workflowApproved = order.status !== 'awaiting_approval' && !order.archivedAt
  const resumeFulfilmentBlocked = detail.data!.workflow.resumeFulfilmentBlocked === true
  const { needsManufacturing, standardStockPending } = detail.data!.workflow

  return (
    <>
      <PageHeader
        title={`الطلب ${order.documentNumber}`}
        subtitle={`${detail.data?.customer?.name ?? ''} — ${fmtDate(order.createdAt)}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate('/orders')}>
              رجوع
            </Button>
            {can(P.orders.manage) && order.status !== 'cancelled' && !order.archivedAt && (
              <Button
                variant="secondary"
                onClick={() =>
                  openDialog('editOrder', {
                    address: order.address ?? '',
                    notes: order.notes ?? ''
                  })
                }
              >
                تعديل الطلب
              </Button>
            )}
            {order.archivedAt && can(P.orders.archive) && (
              <Button variant="secondary" disabled={processing} onClick={() => void run(() => call('orders', 'restore', { id: orderId }), 'تمت استعادة نفس الطلب')}>
                استعادة الطلب
              </Button>
            )}
            {order.completedAt && workflowApproved && !detail.data!.workflow.activeCompletion && can(P.orders.complete) && (
              <Button
                variant="secondary"
                disabled={processing}
                onClick={() => {
                  if (window.confirm('التراجع عن إكمال الطلب اليدوي مع الحفاظ على الدفعات والتصنيع؟')) void run(() => call('orders', 'reverseCompletion', { id: orderId }), 'تم التراجع عن إكمال الطلب')
                }}
              >
                تراجع عن إكمال الطلب
              </Button>
            )}
            {/* Workflow pass: the approved invoice is the SOURCE of this
              order, not something issued from it. The order screen
              reprints it; its commercial terms were frozen at approval. */}
            {finalInvoice.data?.invoice && (
              <>
                <Button variant="secondary" onClick={() => void printDoc('final_invoice', finalInvoice.data!.invoice!.id, 'print')}>
                  طباعة الفاتورة {finalInvoice.data.invoice.documentNumber}
                </Button>
                <Button variant="secondary" onClick={() => void printDoc('final_invoice', finalInvoice.data!.invoice!.id, 'exportPdf')}>
                  PDF
                </Button>
              </>
            )}
          </>
        }
      />
      {order.status === 'awaiting_approval' && <p className="muted">بانتظار إعادة اعتماد نفس الفاتورة. العمليات الإنتاجية متوقفة حتى اعتماد التصحيح. دفعات العميل وفواتير الشراء محفوظة.</p>}
      {standardStockPending && order.status === 'confirmed' && <p className="muted">المنتجات القياسية تُسلَّم من الكمية الجاهزة تلقائياً عند إصدار إذن الخروج أو إكمال الطلب، ويُرفض ذلك إذا لم تكفِ الكمية الجاهزة.</p>}
      {resumeFulfilmentBlocked && <p className="error-note">حالة منتجات الطلب الأصلي غير مكتملة. لا يمكن إصدار إذن الخروج أو التسليم؛ يلزم مراجعة روابط المنتجات. الدفعات السابقة محفوظة.</p>}
      {order.remainingMinor < 0 && <p className="error-note">رصيد مدفوع زائد لصالح العميل: {fmtMoney(-order.remainingMinor)}. لم تُنشأ أي عملية ردّ تلقائية.</p>}

      <div className="grid grid--4" style={{ marginBottom: 14 }}>
        <Stat label="إجمالي الطلب" value={fmtMoney(order.totalMinor)} />
        <Stat
          label={`الدفعة المقدمة (${order.depositPercentBp / 100}%)`}
          value={fmtMoney(order.depositRequiredMinor)}
          tone={depositMet ? 'success' : 'danger'}
          hint={depositMet ? 'مستوفاة' : 'غير مستوفاة — تبقى ذمة العميل مستحقة'}
        />
        <Stat label="المدفوع" value={fmtMoney(order.paidMinor)} />
        <Stat label="المتبقي" value={fmtMoney(order.remainingMinor)} tone={fullyPaid ? 'success' : undefined} />
      </div>

      <Card
        title="حالة الطلب"
        actions={
          <div className="row-actions">
            <Badge tone={ORDER_STATUS[order.status]?.tone ?? 'neutral'}>{ORDER_STATUS[order.status]?.label ?? order.status}</Badge>
            <Badge tone={PAYMENT_STATUS[order.paymentStatus]?.tone ?? 'neutral'}>{PAYMENT_STATUS[order.paymentStatus]?.label ?? order.paymentStatus}</Badge>
            {order.requiresInstallation && <Badge tone="info">يشمل تركيباً</Badge>}
          </div>
        }
      >
        {order.status === 'cancelled' && <div className="error-note">ملغى — {order.cancelReason}. الدفعة المقدمة غير مستردة وتبقى مسجّلة.</div>}
        {/* The order itself never moves: it stays a cancelled order with
            its whole history. Only the PHYSICAL products it produced were
            transferred, and each is now independently sellable. */}
        {order.status === 'cancelled' && (transferred.data?.length ?? 0) > 0 && (
          <div className="notice-ok">
            تم تحويل المنتج إلى المنتجات غير المستلمة:
            <div className="row-actions" style={{ marginTop: 6 }}>
              {(transferred.data ?? []).map((product) => (
                <Button key={product.id} variant="secondary" size="sm" onClick={() => navigate('/uncollected-products')}>
                  {product.name} — {UNCOLLECTED_STATUS[product.status] ?? product.status}
                </Button>
              ))}
            </div>
          </div>
        )}
        {order.completedAt && <div className="notice-ok">مكتمل بتاريخ {fmtDateTime(order.completedAt)} — تم احتساب مستحقات العمال.</div>}
        <div className="row-actions" style={{ marginBottom: 8 }}>
          <Badge tone={fulfillment.data?.status === 'not_delivered' ? 'warning' : 'success'}>{FULFILLMENT_LABEL[fulfillment.data?.status ?? 'not_delivered']}</Badge>
        </div>
        <div className="row-actions">
          {can(P.payments.manage) && order.status !== 'cancelled' && !fullyPaid && <Button onClick={() => openDialog('payment', { amount: '', accountId: '' })}>تسجيل دفعة</Button>}
          {can(P.payments.refund) && detail.data!.actions.canRefundPayment && (
            <Button
              variant="secondary"
              onClick={() =>
                openDialog('refund', {
                  amount: '',
                  accountId: ''
                })
              }
            >
              استرداد دفعة
            </Button>
          )}
          {can(P.production.returnMaterial) && (order.status !== 'cancelled' || detail.data!.workflow.manufacturingInProduction) && returnAvailable && (
            <Button variant="secondary" disabled={returnBusy || processing} onClick={openCreateReturn}>
              مرتجع مادة خام
            </Button>
          )}
          {/* Issuance is now the atomic transition from the frozen plan
              to a Manufacturing Order plus actual FIFO stock issues. */}
          {can(P.worksheets.issue) && can(P.inventory.consume) && order.status === 'confirmed' && needsManufacturing && !manufacturingIssued && (
            <Button variant="secondary" disabled={processing} onClick={() => openDialog('worksheet', { workerId: '', notes: '' })}>
              إصدار أمر تصنيع
            </Button>
          )}
          {can(P.releases.issue) && order.status !== 'cancelled' && workflowApproved && !resumeFulfilmentBlocked && !releaseIssued && (
            <Button
              variant="secondary"
              disabled={processing}
              onClick={() =>
                openDialog('release', {
                  kind: order.requiresInstallation && order.requiresDelivery ? 'delivery_installation' : order.requiresInstallation ? 'installation' : order.requiresDelivery ? 'transport' : 'delivery',
                  showPaidExitSentence: 'true'
                })
              }
            >
              إصدار إذن خروج
            </Button>
          )}
          {can(P.deliveries.register) && order.status === 'confirmed' && !resumeFulfilmentBlocked && requiredCompletion && (
            <Button variant="secondary" disabled={processing} onClick={openCompletionDialog}>
              {COMPLETION_ACTION_LABEL[requiredCompletion.completionKind]}
            </Button>
          )}
          {can(P.orders.cancel) && detail.data!.actions.canCancel && (
            <Button variant="destructive" onClick={() => openDialog('cancel', { reason: '' })}>إلغاء الطلب</Button>
          )}
        </div>
      </Card>

      <Card title="بنود الطلب">
        <DataTable
          rows={detail.data?.lines ?? []}
          rowKey={(row) => row.id}
          columns={[
            { key: 'desc', header: 'البيان', render: (row) => row.description },
            { key: 'dim', header: 'الأبعاد', render: (row) => row.dimensions ?? '—' },
            { key: 'color', header: 'كود اللون', render: (row) => row.colorCode ?? '—' },
            {
              key: 'qty',
              header: 'الكمية',
              numeric: true,
              render: (row) => fmtQty(row.quantityMicro)
            },
            {
              key: 'price',
              header: 'سعر الوحدة',
              numeric: true,
              render: (row) => fmtMoney(row.unitPriceMinor)
            },
            {
              key: 'total',
              header: 'الإجمالي',
              numeric: true,
              render: (row) => fmtMoney(row.lineTotalMinor)
            }
          ]}
        />
      </Card>

      {/*
        Everything below is the frozen COMMERCIAL + PLANNING snapshot
        copied from the preliminary invoice at conversion (BR-18) — an
        estimate and a plan, never actual production execution. Actual
        material consumption, machine usage, worker assignment and their
        real cost live on the Production Order screen instead, one click
        away via "فتح أمر التصنيع" in the documents card below.
      */}
      {(can(P.orders.viewEstimatedCost) || can(P.orders.viewExpectedProfit)) && planningSnapshot.data && (
        <Card title="التكلفة التقديرية والربح المتوقع">
          {can(P.orders.viewEstimatedCost) && (
            <div className="grid grid--4" style={{ marginBottom: 12 }}>
              <Stat label="تكلفة المواد" value={fmtMoney(planningSnapshot.data.estimatedMaterialMinor ?? 0)} />
              <Stat label="تكلفة الآلات" value={fmtMoney(planningSnapshot.data.estimatedMachineMinor ?? 0)} />
              <Stat label="عمولات العمال" value={fmtMoney(planningSnapshot.data.estimatedWorkerMinor ?? 0)} />
              <Stat label="مصروفات الطلب" value={fmtMoney(planningSnapshot.data.estimatedOrderExpenseMinor ?? 0)} />
            </div>
          )}
          <div className="grid grid--3">
            {can(P.orders.viewEstimatedCost) && <Stat label="إجمالي التكلفة التقديرية" value={fmtMoney(planningSnapshot.data.totalEstimatedCostMinor ?? 0)} />}
            <Stat label="سعر البيع" value={fmtMoney(planningSnapshot.data.sellingPriceMinor)} />
            {can(P.orders.viewExpectedProfit) && (
              <Stat label="الربح المتوقع" value={fmtMoney(planningSnapshot.data.expectedProfitMinor ?? 0)} tone={(planningSnapshot.data.expectedProfitMinor ?? 0) >= 0 ? 'success' : 'danger'} />
            )}
          </div>
        </Card>
      )}

      {/*
        PART 3/4 — the order IS the production-planning point. Three
        clearly separated categories, stored separately: materials are
        inventory components; machines are never inventory; worker
        commission is never a material. Saving any of them is PLANNING
        ONLY — it deducts no stock, posts no commission and moves no
        cash. Execution happens later, on the Production Order.
      */}
      {needsManufacturing && can(P.productionPrep.view) && (
        <Card
          title="تجهيز الإنتاج"
          actions={
            (
              <div className="tabs">
                <Button variant={tab === 'materials' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('materials')}>
                  المواد
                </Button>
                <Button variant={tab === 'machines' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('machines')}>
                  الآلات
                </Button>
                <Button variant={tab === 'workers' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('workers')}>
                  عمولات العمال
                </Button>
                <Button variant={tab === 'expenses' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('expenses')}>مصروفات الطلب</Button>
              </div>
            )
          }
        >
          {!configEditable && (
            <p className="muted" style={{ marginTop: 0 }}>
              {order.status === 'cancelled'
                ? 'الطلب ملغى — تجهيز الإنتاج للعرض فقط.'
                : order.archivedAt
                  ? 'الطلب مؤرشف — استعد الطلب قبل أي تصحيح.'
                  : order.status === 'awaiting_approval'
                    ? 'أعد اعتماد الفاتورة المصحّحة قبل تعديل تجهيز الإنتاج.'
                    : manufacturingCompleted && !order.completedAt
                      ? PRODUCTION_PREP_LOCKED_MESSAGE
                      : 'الطلب مكتمل — تجهيز الإنتاج مجمّد كما كان وقت التنفيذ.'}
            </p>
          )}
          {configEditable && (
            <p className="muted" style={{ marginTop: 0 }}>
              تخطيط فقط: الحفظ هنا لا يخصم مخزوناً ولا يُنشئ عمولة مستحقة ولا حركة نقدية. التنفيذ الفعلي يتم في أمر التصنيع.
            </p>
          )}

          {tab === 'materials' && (
            <>
              {planMaterials.map((line, index) => {
                const update = (patch: Partial<MaterialDraft>): void => {
                  const next = [...planMaterials]
                  next[index] = { ...line, ...patch }
                  setPlanMaterials(next)
                }
                return (
                  <div key={index} className="grid grid--4" style={{ alignItems: 'end' }}>
                    <Field label="المادة">
                      <SearchableMaterialSelect
                        materials={rawMaterials.data ?? []}
                        value={line.materialId}
                        disabled={!configEditable}
                        onChange={(materialId) => {
                          const material = rawMaterials.data?.find((m) => m.id === Number(materialId))
                          update({
                            materialId,
                            materialName: material?.name ?? line.materialName,
                            unit: material?.unit ?? line.unit,
                            thickness: material?.thickness ?? line.thickness,
                            dimensions: material?.dimensions ?? line.dimensions,
                            unitCost: material ? String(material.currentMarketPriceMicro / 1_000_000) : line.unitCost
                          })
                        }}
                      />
                    </Field>
                    <Field label="الكمية المطلوبة">
                      <Input type="number" step="0.001" value={line.qty} disabled={!configEditable} onChange={(e) => update({ qty: e.target.value })} />
                    </Field>
                    <Field label="الوحدة">
                      <Input value={line.unit} disabled={!configEditable} onChange={(e) => update({ unit: e.target.value })} />
                    </Field>
                    <Field label="تكلفة الوحدة التقديرية (د.ل)">
                      <Input type="number" step="0.000001" value={line.unitCost} disabled={!configEditable} onChange={(e) => update({ unitCost: e.target.value })} />
                    </Field>
                    <Field label="الأبعاد / المقاس">
                      <Input value={line.dimensions} disabled={!configEditable} onChange={(e) => update({ dimensions: e.target.value })} />
                    </Field>
                    <Field label="اللون / التشطيب">
                      <SearchableColorSelect
                        colors={colors.data ?? []}
                        value={line.colorCode}
                        onChange={(colorCode) => update({ colorCode })}
                        disabled={!configEditable || !can(P.colors.view)}
                        noneLabel="— بدون —"
                        historicalValueLabel={line.colorCode ? `${line.colorCode} — محفوظ تاريخياً` : undefined}
                      />
                    </Field>
                    <Field label="ملاحظات">
                      <Input value={line.notes} disabled={!configEditable} onChange={(e) => update({ notes: e.target.value })} />
                    </Field>
                    {configEditable && (
                      <Button variant="ghost" size="sm" onClick={() => setPlanMaterials(planMaterials.filter((_, i) => i !== index))}>
                        حذف
                      </Button>
                    )}
                  </div>
                )
              })}
              {!planMaterials.length && <div className="state">لم تُحدد مواد مطلوبة للتصنيع</div>}
              {configEditable && (
                <div className="row-actions" style={{ marginTop: 8 }}>
                  <Button variant="secondary" size="sm" onClick={() => setPlanMaterials([...planMaterials, { ...emptyMaterial }])}>
                    + مادة
                  </Button>
                  <Button onClick={() => void saveConfig('materials')}>حفظ المواد</Button>
                </div>
              )}
              <h3 style={{ marginTop: 18, marginBottom: 8 }}>الاستهلاك الفعلي المشتق من حركات المخزون</h3>
              <DataTable
                rows={materialReturns.data?.materials ?? []}
                rowKey={(row) => row.materialId}
                empty="لم تُصرف مواد فعلية لهذا الطلب بعد"
                columns={[
                  { key: 'material', header: 'المادة', render: (row) => row.materialName },
                  {
                    key: 'issued',
                    header: 'المصروف',
                    numeric: true,
                    render: (row) => fmtQty(row.issuedQtyMicro, row.unit)
                  },
                  {
                    key: 'returned',
                    header: 'المرتجع',
                    numeric: true,
                    render: (row) => fmtQty(row.returnedQtyMicro, row.unit)
                  },
                  {
                    key: 'net',
                    header: 'صافي الاستهلاك',
                    numeric: true,
                    render: (row) => fmtQty(row.netConsumedQtyMicro, row.unit)
                  },
                  ...(can(P.orders.viewActualCost)
                    ? [
                        {
                          key: 'cost',
                          header: 'صافي التكلفة',
                          numeric: true,
                          render: (row: MaterialReturnSummary) => fmtMoney(row.netCostMinor ?? 0)
                        }
                      ]
                    : [])
                ]}
              />
            </>
          )}

          {tab === 'machines' && (
            <>
              {planMachines.map((line, index) => {
                const update = (patch: Partial<MachineDraft>): void => {
                  const next = [...planMachines]
                  next[index] = { ...line, ...patch }
                  setPlanMachines(next)
                }
                const selectedMachine = machineList.data?.find((machine) => machine.id === Number(line.machineId))
                const estimatedCostMinor = machineEstimateMinor(line)
                const missingCostConfiguration = line.rateMicro !== null && line.rateMicro <= 0
                const rateHint =
                  line.rateMicro === null
                    ? line.id
                      ? 'تكلفة تاريخية محفوظة لعدم توفر أساس السعر القديم'
                      : undefined
                    : line.rateMicro > 0
                      ? `سعر الوحدة المحفوظ: ${fmtMoney(Math.round(line.rateMicro / 1000))} لكل ${line.usageUnit || 'وحدة'}`
                      : 'سعر تكلفة الآلة غير مضبوط في سجل الآلات'
                return (
                  <div key={index} className="grid grid--4" style={{ alignItems: 'end' }}>
                    <Field label="الآلة">
                      <Select
                        value={line.machineId}
                        disabled={!configEditable}
                        onChange={(e) => {
                          const machine = machineList.data?.find((m) => m.id === Number(e.target.value))
                          const rateMicro = machine?.defaultRateMicro ?? null
                          update({
                            machineId: e.target.value,
                            machineName: machine?.name ?? '',
                            usageUnit: machine?.costingUnit ?? '',
                            rateMicro,
                            legacyCostMinor: 0
                          })
                        }}
                      >
                        <option value="">— اختر —</option>
                        {line.machineId && !selectedMachine && <option value={line.machineId}>{line.machineName} — محفوظ تاريخياً</option>}
                        {(machineList.data ?? []).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="الاستخدام المتوقع">
                      <Input
                        type="number"
                        min="0"
                        step="0.001"
                        value={line.usageQty}
                        disabled={!configEditable}
                        onChange={(e) => {
                          const rateMicro = line.rateMicro ?? selectedMachine?.defaultRateMicro ?? null
                          update({ usageQty: e.target.value, rateMicro, legacyCostMinor: 0 })
                        }}
                      />
                    </Field>
                    <Field label="وحدة الاحتساب">
                      <Input value={line.usageUnit} readOnly aria-readonly="true" />
                    </Field>
                    <Field label="التكلفة التقديرية (د.ل)" hint={rateHint}>
                      <Input value={missingCostConfiguration ? 'غير متاح' : fmtMoney(estimatedCostMinor)} readOnly aria-readonly="true" aria-invalid={missingCostConfiguration || undefined} />
                    </Field>
                    {missingCostConfiguration && <ErrorNote>اضبط تكلفة الوحدة للآلة المحددة قبل حفظ تجهيز الإنتاج.</ErrorNote>}
                    {configEditable && (
                      <Button variant="ghost" size="sm" onClick={() => setPlanMachines(planMachines.filter((_, i) => i !== index))}>
                        حذف
                      </Button>
                    )}
                  </div>
                )
              })}
              {!planMachines.length && <div className="state">لم تُحدَّد آلات مطلوبة للتصنيع</div>}
              {configEditable && (
                <div className="row-actions" style={{ marginTop: 8 }}>
                  <Button variant="secondary" size="sm" onClick={() => setPlanMachines([...planMachines, { ...emptyMachine }])}>
                    + آلة
                  </Button>
                  <Button onClick={() => void saveConfig('machines')}>حفظ الآلات</Button>
                </div>
              )}
            </>
          )}

          {tab === 'workers' && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                عمولة مخططة فقط — لا تُدفع ولا تُقيَّد على حساب العامل بمجرد إدخالها هنا.
              </p>
              {planWorkers.map((line, index) => {
                const update = (patch: Partial<WorkerDraft>): void => {
                  const next = [...planWorkers]
                  next[index] = { ...line, ...patch }
                  setPlanWorkers(next)
                }
                const calculatedMinor = meterCommissionMinor(line)
                return (
                  <div key={index} className="grid grid--4" style={{ alignItems: 'end' }}>
                    <Field label="العامل">
                      <Select
                        value={line.workerId}
                        disabled={!configEditable}
                        onChange={(e) => {
                          const worker = workerList.data?.find((w) => w.id === Number(e.target.value))
                          update({
                            workerId: e.target.value,
                            workerName: worker?.name ?? line.workerName
                          })
                        }}
                      >
                        <option value="">— غير محدد —</option>
                        {(workerList.data ?? []).map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="طريقة العمولة">
                      <Select
                        value={line.commissionMode}
                        disabled={!configEditable}
                        onChange={(e) =>
                          update({
                            commissionMode: e.target.value as WorkerDraft['commissionMode']
                          })
                        }
                      >
                        <option value="estimated">تقديرية / يدوية</option>
                        <option value="meter">حسب المتر</option>
                      </Select>
                    </Field>
                    {line.commissionMode === 'estimated' ? (
                      <Field label="العمولة التقديرية (د.ل)">
                        <Input type="number" min="0" step="0.001" value={line.cost} disabled={!configEditable} onChange={(e) => update({ cost: e.target.value })} />
                      </Field>
                    ) : (
                      <>
                        <Field label="سعر المتر (د.ل)">
                          <Input type="number" min="0" step="0.000001" value={line.meterRate} disabled={!configEditable} onChange={(e) => update({ meterRate: e.target.value })} />
                        </Field>
                        <Field label="عدد الأمتار">
                          <Input type="number" min="0" step="0.000001" value={line.meterQty} disabled={!configEditable} onChange={(e) => update({ meterQty: e.target.value })} />
                        </Field>
                        <Field label="الإجمالي">
                          <Input value={fmtMoney(calculatedMinor)} readOnly aria-readonly="true" />
                        </Field>
                      </>
                    )}
                    {configEditable && (
                      <Button variant="ghost" size="sm" onClick={() => setPlanWorkers(planWorkers.filter((_, i) => i !== index))}>
                        حذف
                      </Button>
                    )}
                  </div>
                )
              })}
              {!planWorkers.length && <div className="state">لم تُحدَّد عمولات عمال لهذا الطلب</div>}
              {configEditable && (
                <div className="row-actions" style={{ marginTop: 8 }}>
                  <Button variant="secondary" size="sm" onClick={() => setPlanWorkers([...planWorkers, { ...emptyWorker }])}>
                    + عمولة عامل
                  </Button>
                  <Button onClick={() => void saveConfig('workers')}>حفظ العمولات</Button>
                </div>
              )}
            </>
          )}

          {tab === 'expenses' && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                مصروفات تقديرية خاصة بتكلفة الطلب فقط — لا تُنشئ حركة نقدية أو قيد مصروف تلقائياً.
              </p>
              {planExpenses.map((line, index) => {
                const update = (patch: Partial<ExpenseDraft>): void => {
                  const next = [...planExpenses]
                  next[index] = { ...line, ...patch }
                  setPlanExpenses(next)
                }
                return (
                  <div key={index} className="grid grid--3" style={{ alignItems: 'end' }}>
                    <Field label="اسم المصروف" required>
                      <Input value={line.expenseName} disabled={!configEditable} onChange={(e) => update({ expenseName: e.target.value })} />
                    </Field>
                    <Field label="السعر (د.ل)">
                      <Input type="number" min="0" step="0.001" value={line.amount} disabled={!configEditable} onChange={(e) => update({ amount: e.target.value })} />
                    </Field>
                    {configEditable && (
                      <Button variant="ghost" size="sm" onClick={() => setPlanExpenses(planExpenses.filter((_, i) => i !== index))}>
                        حذف
                      </Button>
                    )}
                  </div>
                )
              })}
              {!planExpenses.length && <div className="state">لم تُحدَّد مصروفات لهذا الطلب</div>}
              <div className="grid grid--3" style={{ marginTop: 8 }}>
                <Stat label="إجمالي مصروفات الطلب" value={fmtMoney(planExpenses.reduce((sum, line) => sum + toMinor(line.amount), 0))} />
              </div>
              {configEditable && (
                <div className="row-actions" style={{ marginTop: 8 }}>
                  <Button variant="secondary" size="sm" onClick={() => setPlanExpenses([...planExpenses, { ...emptyExpense }])}>+ إضافة مصروف</Button>
                  <Button onClick={() => void saveConfig('expenses')}>حفظ المصروفات</Button>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {(can(P.production.returnMaterial) || can(P.orders.viewActualCost)) && (
        <Card title="مرتجعات المواد">
          <DataTable
            rows={materialReturns.data?.returns ?? []}
            rowKey={(row) => row.id}
            empty="لا توجد مرتجعات مواد فعّالة"
            columns={[
              { key: 'material', header: 'المادة', render: (row) => row.materialName },
              {
                key: 'qty',
                header: 'الكمية المرتجعة',
                numeric: true,
                render: (row) => fmtQty(row.quantityMicro, row.unit)
              },
              ...(can(P.orders.viewActualCost)
                ? [
                    {
                      key: 'value',
                      header: 'قيمة المرتجع',
                      numeric: true,
                      render: (row: MaterialReturnRow) => fmtMoney(row.returnedCostMinor ?? 0)
                    }
                  ]
                : []),
              { key: 'date', header: 'التاريخ', render: (row) => fmtDateTime(row.createdAt) },
              { key: 'user', header: 'المستخدم', render: (row) => row.username ?? '—' },
              { key: 'notes', header: 'ملاحظات', render: (row) => row.notes ?? '—' },
              {
                key: 'actions',
                header: '',
                width: '76px',
                render: (row) =>
                  can(P.production.returnMaterial) ? (
                    <div className="row-actions">
                      <button type="button" className="icon-btn" title="تعديل المرتجع" aria-label="تعديل المرتجع" disabled={returnBusy} onClick={() => openEditReturn(row)}>
                        <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn--danger"
                        title="حذف المرتجع"
                        aria-label="حذف المرتجع"
                        disabled={returnBusy}
                        onClick={() => {
                          setDeleteReturn(row)
                          setDeleteReturnRequestKey(crypto.randomUUID())
                          setReturnError(undefined)
                        }}
                      >
                        <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                      </button>
                    </div>
                  ) : null
              }
            ]}
          />
        </Card>
      )}

      {can(P.purchases.view) && (
        <Card title="مشتريات الطلب">
          <div className="grid grid--3" style={{ marginBottom: 12 }}>
            <Stat label="إجمالي مشتريات الطلب" value={fmtMoney(orderPurchases.data?.totalMinor ?? 0)} />
          </div>
          <DataTable
            loading={orderPurchases.loading}
            rows={orderPurchases.data?.purchases ?? []}
            rowKey={(row) => row.id}
            empty="لا توجد فواتير شراء مرتبطة بهذا الطلب"
            columns={[
              { key: 'number', header: 'فاتورة الشراء', render: (row) => row.documentNumber },
              { key: 'supplier', header: 'المورد', render: (row) => row.supplierName },
              { key: 'date', header: 'التاريخ', render: (row) => fmtDate(row.purchaseDate) },
              {
                key: 'total',
                header: 'الإجمالي',
                numeric: true,
                render: (row) => fmtMoney(row.totalMinor)
              },
              {
                key: 'payment',
                header: 'حالة السداد',
                render: (row) => <Badge tone={PAYMENT_STATUS[row.paymentStatus]?.tone ?? 'neutral'}>{PAYMENT_STATUS[row.paymentStatus]?.label ?? row.paymentStatus}</Badge>
              },
              {
                key: 'actions',
                header: '',
                render: (row) => (
                  <Button variant="ghost" size="sm" onClick={() => navigate(`/purchases?open=${row.id}`)}>
                    فتح الفاتورة
                  </Button>
                )
              }
            ]}
          />
        </Card>
      )}

      <div className="grid grid--2">
        <Card title="الدفعات">
          <DataTable
            rows={detail.data?.payments ?? []}
            rowKey={(row) => row.rowKey}
            empty="لا توجد دفعات"
            columns={[
              {
                key: 'type',
                header: 'النوع',
                render: (row) => (row.entryType === 'refund' ? 'استرداد دفعة' : 'دفعة عميل')
              },
              { key: 'date', header: 'اليوم الفعلي', render: (row) => fmtDate(row.effectiveBusinessDay) },
              { key: 'execution', header: 'وقت التسجيل (UTC)', render: (row) => fmtDateTime(row.executionAt) },
              {
                key: 'amount',
                header: 'المبلغ',
                numeric: true,
                render: (row) => fmtMoney(row.amountMinor)
              },
              { key: 'notes', header: 'ملاحظات', render: (row) => row.notes ?? '—' }
            ]}
          />
        </Card>
        <Card title="المستندات">
          <DataTable
            rows={[
              ...worksheets.items.map((row) => ({
                id: `w${row.id}`,
                num: row.documentNumber,
                kind: row.status === 'reversed' ? 'أمر تصنيع — تم التراجع' : 'أمر تصنيع',
                at: row.issuedAt,
                docKind: 'work_sheet',
                docId: row.id,
                sheetId: row.id
              })),
              ...releases.items.map((row) => ({
                id: `r${row.id}`,
                num: row.documentNumber,
                kind: `${EXIT_PERMIT_LABEL[row.kind]}${row.status === 'reversed' ? ' — تم التراجع' : ''}`,
                at: row.authorizedAt,
                docKind: permitIncludesInstallation(row.kind) ? 'installation_release' : 'delivery_release',
                docId: row.id,
                sheetId: undefined as number | undefined
              }))
            ]}
            rowKey={(row) => row.id}
            empty="لم تُصدر مستندات بعد"
            columns={[
              { key: 'num', header: 'المستند', render: (row) => row.num },
              { key: 'kind', header: 'النوع', render: (row) => row.kind },
              { key: 'at', header: 'التاريخ', render: (row) => fmtDateTime(row.at) },
              {
                key: 'actions',
                header: '',
                render: (row) => (
                  <div className="row-actions">
                    {row.sheetId && (
                      <Button variant="secondary" size="sm" onClick={() => navigate(`/worksheets/${row.sheetId}`)}>
                        فتح أمر التصنيع
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => void printDoc(row.docKind, row.docId, 'print')}>
                      طباعة
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void printDoc(row.docKind, row.docId, 'exportPdf')}>
                      PDF
                    </Button>
                  </div>
                )
              }
            ]}
          />
          <LoadMore hasNext={worksheets.hasNext || releases.hasNext} loading={worksheets.loading || releases.loading} onClick={() => { if (worksheets.hasNext) void worksheets.next(); if (releases.hasNext) void releases.next() }} />
        </Card>
      </div>

      {/* ---------- Dialogs ---------- */}
      <Modal
        open={Boolean(returnDialog)}
        title={returnDialog?.mode === 'edit' ? 'تعديل مرتجع مادة خام' : 'مرتجع مادة خام'}
        onClose={() => {
          if (!returnBusy) {
            setReturnDialog(undefined)
            setReturnError(undefined)
          }
        }}
        footer={
          <>
            <Button disabled={returnBusy || !returnDialog?.materialId} onClick={() => void saveMaterialReturn()}>
              {returnBusy ? 'جارٍ الحفظ…' : 'حفظ المرتجع'}
            </Button>
            <Button variant="secondary" disabled={returnBusy} onClick={() => setReturnDialog(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{returnError}</ErrorNote>
        <Field label="المادة" required>
          <Select
            value={returnDialog?.materialId ?? ''}
            disabled={returnDialog?.mode === 'edit' || returnBusy}
            onChange={(event) =>
              setReturnDialog(
                returnDialog
                  ? {
                      ...returnDialog,
                      materialId: event.target.value,
                      quantity: ''
                    }
                  : undefined
              )
            }
          >
            <option value="">— اختر مادة مصروفة —</option>
            {(materialReturns.data?.materials ?? [])
              .filter((item) => item.returnableQtyMicro > 0)
              .map((item) => (
                <option key={item.materialId} value={item.materialId}>
                  {item.materialName} ({item.unit})
                </option>
              ))}
            {editedReturn && !(materialReturns.data?.materials ?? []).some((item) => item.materialId === editedReturn.materialId && item.returnableQtyMicro > 0) && (
              <option value={editedReturn.materialId}>
                {editedReturn.materialName} ({editedReturn.unit})
              </option>
            )}
          </Select>
        </Field>
        <div className="grid grid--2">
          <Field label="الكمية المصروفة">
            <Input value={selectedReturnMaterial ? fmtQty(selectedReturnMaterial.issuedQtyMicro, selectedReturnMaterial.unit) : '—'} readOnly />
          </Field>
          <Field label="المرتجع سابقاً">
            <Input value={selectedReturnMaterial ? fmtQty(selectedReturnMaterial.returnedQtyMicro, selectedReturnMaterial.unit) : '—'} readOnly />
          </Field>
          <Field label="المتاح للإرجاع">
            <Input value={selectedReturnMaterial ? fmtQty(maxReturnQtyMicro, selectedReturnMaterial.unit) : '—'} readOnly />
          </Field>
          <Field label="الكمية المراد إرجاعها" required>
            <Input
              type="number"
              min="0.000001"
              max={maxReturnQtyMicro / 1_000_000}
              step="0.001"
              disabled={returnBusy}
              value={returnDialog?.quantity ?? ''}
              onChange={(event) => setReturnDialog(returnDialog ? { ...returnDialog, quantity: event.target.value } : undefined)}
            />
          </Field>
        </div>
        <Field label="ملاحظات (اختياري)">
          <Textarea disabled={returnBusy} value={returnDialog?.notes ?? ''} onChange={(event) => setReturnDialog(returnDialog ? { ...returnDialog, notes: event.target.value } : undefined)} />
        </Field>
        <p className="muted">تُحتسب قيمة المرتجع من تكلفة الصرف التاريخية، وليس من سعر المادة الحالي.</p>
      </Modal>

      <Modal
        open={Boolean(deleteReturn)}
        title="حذف المرتجع"
        onClose={() => {
          if (!returnBusy) {
            setDeleteReturn(undefined)
            setReturnError(undefined)
          }
        }}
        footer={
          <>
            <Button variant="destructive" disabled={returnBusy} onClick={() => void confirmDeleteReturn()}>
              {returnBusy ? 'جارٍ العكس…' : 'حذف المرتجع'}
            </Button>
            <Button variant="secondary" disabled={returnBusy} onClick={() => setDeleteReturn(undefined)}>
              تراجع
            </Button>
          </>
        }
      >
        <ErrorNote>{returnError}</ErrorNote>
        <p>
          هل تريد حذف مرتجع مادة {deleteReturn?.materialName} بكمية {deleteReturn ? fmtQty(deleteReturn.quantityMicro, deleteReturn.unit) : ''}؟
        </p>
        <p className="muted">سيُعكس أثره من المخزون والتكلفة مع بقاء سجله التاريخي والتدقيق.</p>
      </Modal>

      <Modal
        open={dialog === 'payment'}
        title="تسجيل دفعة"
        onClose={() => setDialog(undefined)}
        footer={
          <>
            <Button
              onClick={() =>
                void run(
                  () =>
                    financialCall(
                      'orders',
                      'recordPayment',
                      {
                        orderId,
                        amountMinor: Math.round(Number(form.amount || 0) * 1000),
                        cashAccountId: form.accountId ? Number(form.accountId) : undefined
                      },
                      `orders.recordPayment:${orderId}`
                    ),
                  'تم تسجيل الدفعة'
                )
              }
            >
              حفظ
            </Button>
            <Button variant="secondary" onClick={() => setDialog(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">
          المتبقي: {fmtMoney(order.remainingMinor)} — المطلوب للمقدمة: {fmtMoney(Math.max(0, order.depositRequiredMinor - order.paidMinor))}
        </p>
        <Field label="المبلغ (د.ل)" required>
          <Input type="number" step="0.01" value={form.amount ?? ''} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label="الحساب النقدي">
          <Select value={form.accountId ?? ''} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
            <option value="">— بدون —</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>

      <Modal
        open={dialog === 'refund'}
        title="استرداد دفعة"
        onClose={() => {
          if (!processing) setDialog(undefined)
        }}
        footer={
          <>
            <Button
              variant="destructive"
              disabled={processing}
              onClick={() =>
                void run(
                  () =>
                    financialCall(
                      'orders',
                      'refundPayment',
                      {
                        orderId,
                        amountMinor: toMinor(form.amount || '0'),
                        cashAccountId: Number(form.accountId)
                      },
                      `orders.refundPayment:${orderId}`
                    ),
                  'تم استرداد الدفعة'
                )
              }
            >
              {processing ? 'جارٍ الاسترداد…' : 'تأكيد الاسترداد'}
            </Button>
            <Button variant="secondary" disabled={processing} onClick={() => setDialog(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <div className="grid grid--3">
          <Stat label="إجمالي الطلب" value={fmtMoney(order.totalMinor)} />
          <Stat label="المدفوع الحالي" value={fmtMoney(order.paidMinor)} />
          <Stat label="المبلغ القابل للاسترداد" value={fmtMoney(detail.data!.actions.refundableMinor)} />
        </div>
        <Field label="مبلغ الاسترداد (د.ل)" required>
          <Input type="number" step="0.001" min="0.001" max={detail.data!.actions.refundableMinor / 1000} value={form.amount ?? ''} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label="الحساب/الصندوق" required>
          <Select value={form.accountId ?? ''} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
            <option value="">— اختر الحساب —</option>
            {(accounts.data ?? [])
              .filter((a) => a.active)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
        </Field>
        <p className="muted">سيبقى سجل الدفعة الأصلية محفوظاً، ويُسجل الاسترداد كحركة مالية مستقلة.</p>
      </Modal>

      <Modal
        open={dialog === 'worksheet'}
        title="إصدار أمر تصنيع"
        onClose={() => {
          if (!processing) setDialog(undefined)
        }}
        footer={
          <>
            <Button
              disabled={processing}
              onClick={() =>
                void run(
                  () =>
                    call('production', 'issueWorkSheet', {
                      orderId,
                      workerIds: form.workerId ? [Number(form.workerId)] : [],
                      notes: form.notes || undefined
                    }),
                  'تم إصدار أمر التصنيع وصرف مواد التجهيز من المخزون'
                )
              }
            >
              {processing ? 'جارٍ الإصدار…' : 'إصدار'}
            </Button>
            <Button variant="secondary" disabled={processing} onClick={() => setDialog(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        {!depositMet && (
          <div className="error-note">
            <strong>{order.paidMinor === 0 ? 'لم يتم دفع العربون.' : 'لم يكتمل دفع العربون.'}</strong>
            <br />
            المطلوب: {fmtMoney(order.depositRequiredMinor)} — المدفوع: {fmtMoney(order.paidMinor)}
          </div>
        )}
        <Field label="العامل المكلّف">
          <Select value={form.workerId ?? ''} onChange={(e) => setForm({ ...form, workerId: e.target.value })}>
            <option value="">— بدون —</option>
            {(workers.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ملاحظات التصنيع">
          <Textarea value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={dialog === 'release'}
        title="إصدار إذن خروج"
        onClose={() => {
          if (!processing) setDialog(undefined)
        }}
        footer={
          <>
            <Button
              disabled={processing}
              onClick={() =>
                void run(
                  () =>
                    call('production', 'issueRelease', {
                      orderId,
                      kind: form.kind,
                      workerIds: releaseWorkerIds,
                      showPaidExitSentence: form.showPaidExitSentence !== 'false'
                    }),
                  'تم إصدار إذن الخروج'
                )
              }
            >
              {processing ? 'جارٍ الإصدار…' : 'إصدار'}
            </Button>
            <Button variant="secondary" disabled={processing} onClick={() => setDialog(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        {!fullyPaid && (
          <div className="error-note">
            <strong>الطلب غير مسدد بالكامل.</strong>
            <br />
            المبلغ المتبقي: {fmtMoney(order.remainingMinor)}
          </div>
        )}
        <Field label="نوع الإذن" required>
          <Select
            value={form.kind ?? 'installation'}
            onChange={(e) =>
              setForm({
                ...form,
                kind: e.target.value
              })
            }
          >
            {EXIT_PERMIT_KINDS.map((value) => (
              <option key={value} value={value}>
                {EXIT_PERMIT_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>
        {fullyPaid && permitIncludesInstallation(form.kind as ExitPermitKind) && (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.showPaidExitSentence !== 'false'}
              onChange={(e) =>
                setForm({
                  ...form,
                  showPaidExitSentence: e.target.checked ? 'true' : 'false'
                })
              }
            />
            <span>إظهار عبارة سداد كامل قيمة الطلب</span>
          </label>
        )}
        {/* فريق التركيب (item 6): a proper multi-select — pick a worker
            to add, remove any of them individually, never a duplicate. */}
        <Field label="المكلّف (فريق التركيب/التسليم)">
          <Select
            value=""
            onChange={(e) => {
              const workerId = Number(e.target.value)
              if (workerId && !releaseWorkerIds.includes(workerId)) {
                setReleaseWorkerIds([...releaseWorkerIds, workerId])
              }
            }}
          >
            <option value="">— إضافة عامل —</option>
            {(workers.data ?? [])
              .filter((w) => !releaseWorkerIds.includes(w.id))
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </Select>
          {releaseWorkerIds.length > 0 && (
            <div className="pill-row" style={{ marginTop: 6 }}>
              {releaseWorkerIds.map((workerId) => {
                const worker = workers.data?.find((w) => w.id === workerId)
                return (
                  <span key={workerId} className="badge badge--neutral" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {worker?.name ?? `#${workerId}`}
                    <button
                      type="button"
                      aria-label={`إزالة ${worker?.name ?? ''}`}
                      onClick={() => setReleaseWorkerIds(releaseWorkerIds.filter((id) => id !== workerId))}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                        lineHeight: 1,
                        color: 'inherit',
                        fontSize: 13
                      }}
                    >
                      ×
                    </button>
                  </span>
                )
              })}
            </div>
          )}
        </Field>
      </Modal>

      <Modal
        open={dialog === 'delivery'}
        title={COMPLETION_ACTION_LABEL[(form.kind as CompletionKind) || 'handover']}
        onClose={() => {
          if (!processing) setDialog(undefined)
        }}
        footer={
          <>
            <Button
              disabled={processing}
              onClick={() =>
                void run(
                  () =>
                    call('production', 'recordDelivery', {
                      orderId,
                      kind: form.kind,
                      releaseId: Number(form.releaseId),
                      workerIds: completionWorkerIds,
                      address: form.address || undefined,
                      actualCostMinor: form.cost ? Math.round(Number(form.cost) * 1000) : undefined,
                      notes: form.notes || undefined
                    }),
                  `تم ${COMPLETION_LABEL[form.kind as CompletionKind]}`
                )
              }
            >
              تسجيل
            </Button>
            <Button variant="secondary" disabled={processing} onClick={() => setDialog(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">العملية محددة بواسطة {requiredCompletion ? EXIT_PERMIT_LABEL[requiredCompletion.permitKind] : 'إذن الخروج'}، وستُحفظ كسجل واحد في قسم التسليم والتركيب.</p>
        <Field label="الفريق الفعلي">
          <Select
            value=""
            onChange={(e) => {
              const workerId = Number(e.target.value)
              if (workerId && !completionWorkerIds.includes(workerId)) {
                setCompletionWorkerIds([...completionWorkerIds, workerId])
              }
            }}
          >
            <option value="">— إضافة عامل —</option>
            {(workers.data ?? [])
              .filter((worker) => !completionWorkerIds.includes(worker.id))
              .map((worker) => (
                <option key={worker.id} value={worker.id}>
                  {worker.name}
                </option>
              ))}
          </Select>
          {completionWorkerIds.length > 0 && (
            <div className="pill-row" style={{ marginTop: 6 }}>
              {completionWorkerIds.map((workerId) => {
                const worker = workers.data?.find((candidate) => candidate.id === workerId)
                return (
                  <span key={workerId} className="badge badge--neutral" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {worker?.name ?? `#${workerId}`}
                    <button
                      type="button"
                      aria-label={`إزالة ${worker?.name ?? ''}`}
                      onClick={() => setCompletionWorkerIds(completionWorkerIds.filter((id) => id !== workerId))}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                        lineHeight: 1,
                        color: 'inherit',
                        fontSize: 13
                      }}
                    >
                      ×
                    </button>
                  </span>
                )
              })}
            </div>
          )}
        </Field>
        {form.kind !== 'handover' && (
          <Field label={form.kind === 'installation' ? 'موقع التركيب' : 'عنوان التوصيل'}>
            <Input value={form.address ?? ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
        )}
        <Field label={COMPLETION_COST_LABEL[(form.kind as CompletionKind) || 'handover']} hint="داخلية — منفصلة عمّا يُحاسب عليه العميل">
          <Input type="number" step="0.01" value={form.cost ?? ''} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
        </Field>
        <Field label="ملاحظات">
          <Input value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={dialog === 'editOrder'}
        title="تعديل بيانات الطلب"
        onClose={() => setDialog(undefined)}
        footer={
          <>
            <Button
              onClick={() =>
                void run(
                  () =>
                    call('orders', 'update', {
                      id: orderId,
                      address: form.address || undefined,
                      notes: form.notes || undefined
                    }),
                  'تم تحديث بيانات الطلب'
                )
              }
            >
              حفظ
            </Button>
            <Button variant="secondary" onClick={() => setDialog(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">الأسعار والبنود والمبالغ مجمّدة منذ تحويل الطلب ولا يمكن تعديلها هنا — فقط عنوان التسليم والملاحظات.</p>
        <p className="muted">لتصحيح البيانات التجارية: تراجع عن آخر عملية من وحدتها، ثم إذن الخروج، ثم أمر التصنيع، ثم «إلغاء الاعتماد» من الفاتورة المعتمدة. عدّل نفس الفاتورة واعتمدها مجدداً.</p>
        <Field label="العنوان">
          <Input value={form.address ?? ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <Field label="ملاحظات">
          <Textarea value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={dialog === 'cancel'}
        title="إلغاء الطلب"
        onClose={() => setDialog(undefined)}
        footer={
          <>
            <Button variant="destructive" onClick={() => void run(() => call('orders', 'cancel', { orderId, reason: form.reason }), 'تم إلغاء الطلب')}>
              تأكيد الإلغاء
            </Button>
            <Button variant="secondary" onClick={() => setDialog(undefined)}>
              تراجع
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">الدفعة المقدمة غير مستردة وتبقى مسجّلة، وكذلك كل التكاليف المتكبدة والمواد المصروفة.</p>
        <Field label="سبب الإلغاء" required>
          <Textarea value={form.reason ?? ''} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
      </Modal>
    </>
  )
}
