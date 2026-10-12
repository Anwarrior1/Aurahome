import { useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { useSession } from '@renderer/state/session.store'
import {
  Badge,
  Card,
  DataTable,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Stat,
  Toolbar,
  Button,
  Pager
} from '@renderer/components/ui'
import { fmtDate, fmtDateTime, fmtMoney, fmtQty } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'

interface Row {
  id: number
  name: string
  sourceOrderId: number
  sourceOrderNumber: string
  dimensions: string | null
  quantityMicro: number
  status: string
  canResume: boolean
  resumeProducts: Array<{ id: number; name: string }>
  transferredAt: string
  /** Absent entirely for a session without `uncollectedProducts.viewCost`. */
  costBasisMinor?: number
  soldInvoiceId: number | null
  soldOrderId: number | null
  soldAt: string | null
  soldPriceMinor?: number | null
}

interface MaterialSelection {
  materialId: number | null
  name: string
  colors?: Array<{ colorId: number | null; code: string; name: string | null }>
}

interface Detail extends Row {
  description: string | null
  specifications: string | null
  sourceWorkSheetNumber: string | null
  resumedAt: string | null
  cancelReason: string | null
  notes: string | null
  costBasisMethod?: string
  costBasisOrderTotalMinor?: number
  costBasisMaterialMinor?: number
  costBasisMachineMinor?: number
  costBasisWorkerMinor?: number
  costBasisDeliveryMinor?: number
  costBasisExpenseMinor?: number
  originalLineTotalMinor?: number
  selectedMaterials: MaterialSelection[]
  selectedColors: Array<{ colorId: number | null; code: string; name: string | null }>
  selectedAccessories: Array<{ materialId: number | null; name: string }>
  soldInvoice?: { id: number; documentNumber: string }
  soldOrder?: { id: number; documentNumber: string }
  /** BL-03, cost viewers only. */
  economics?: {
    actualCostMinor: number
    customerCoveredMinor: number
    factoryBorneMinor: number
    preparationCostMinor: number
    known: boolean
  }
  preparationCosts?: Array<{ id: number; amountMinor: number; description: string; spentAt: string }>
  resaleProfitMinor?: number | null
}

const STATUS: Record<string, { label: string; tone: 'success' | 'info' | 'neutral' }> = {
  available: { label: 'متاح للبيع', tone: 'success' },
  reserved: { label: 'محجوز على فاتورة', tone: 'info' },
  sold: { label: 'تم البيع', tone: 'neutral' },
  resumed: { label: 'استؤنف إلى الطلب الأصلي', tone: 'info' }
}

/** How the internal cost figure was derived — shown so the number is
 *  never mistaken for an arbitrary split. */
const COST_METHOD: Record<string, string> = {
  sole_manufactured_item: 'المنتج الوحيد المصنّع في الطلب — التكلفة الفعلية كاملة',
  relative_sales_value: 'موزّعة حسب نصيب المنتج من القيمة البيعية للأصناف المصنّعة',
  unattributable: 'غير قابلة للتوزيع على هذا المنتج — لم تُنسب أي تكلفة'
}

export function UncollectedProductsPage(): ReactElement {
  const navigate = useNavigate()
  const { can } = useSession()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [openId, setOpenId] = useState<number>()
  const [resume, setResume] = useState<{ row: Row; requestKey: string }>()
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState('')
  const pageSize = 25

  // Bounded by design: the renderer never holds the whole history, it
  // asks for one page and the server caps what a page may be.
  const list = usePagedQuery<Row, { totalCount: number }>('uncollectedProducts', 'list', {
    search: search || undefined,
    status: status || undefined
  }, { limit: pageSize })
  const detail = useQuery<Detail>('uncollectedProducts', 'get', { id: openId }, { enabled: Boolean(openId) })

  const rows = list.items
  const showCost = can(P.uncollectedProducts.viewCost)
  const item = detail.data
  const accounts = useQuery<Array<{ id: number; name: string }>>('cash', 'accounts', undefined, { enabled: Boolean(openId) })
  const [prep, setPrep] = useState({ amount: '', description: '', accountId: '' })
  const [prepError, setPrepError] = useState('')
  const canAddPreparation = showCost && can(P.expenses.manage) &&
    (item?.status === 'available' || item?.status === 'reserved')

  async function addPreparationCost(): Promise<void> {
    if (!item) return
    setPrepError('')
    try {
      await financialCall('expenses', 'create', {
        uncollectedProductId: item.id,
        amountMinor: Math.round(Number(prep.amount) * 1000),
        description: prep.description || `تجهيز لإعادة بيع ${item.name}`,
        cashAccountId: prep.accountId ? Number(prep.accountId) : undefined
      }, 'expenses.create')
      setPrep({ amount: '', description: '', accountId: '' })
      await detail.reload()
      toast.show('تم تسجيل تكلفة التجهيز', 'success')
    } catch (err) {
      setPrepError(err instanceof ApiError ? err.message : 'تعذر تسجيل التكلفة')
    }
  }

  function openResume(row: Row): void {
    if (!row.canResume || !can(P.uncollectedProducts.resume)) return
    setResumeError('')
    setResume({ row, requestKey: crypto.randomUUID() })
  }

  async function confirmResume(): Promise<void> {
    if (!resume || resuming) return
    setResuming(true)
    setResumeError('')
    try {
      const result = await call<{ orderId: number; resumedProductIds: number[] }>('uncollectedProducts', 'resume', {
        id: resume.row.id, confirmation: resume.row.sourceOrderNumber, requestKey: resume.requestKey,
        expectedProductIds: resume.row.resumeProducts.map(product => product.id)
      })
      setResume(undefined)
      setOpenId(undefined)
      await list.reload()
      toast.show('تم استئناف الطلب الأصلي وجميع منتجاته', 'success')
      if (can(P.orders.view)) navigate(`/orders/${result.orderId}`)
    } catch (err) {
      setResumeError(err instanceof ApiError ? err.message : 'تعذر استئناف الطلب')
    } finally { setResuming(false) }
  }

  return (
    <>
      <PageHeader
        title="المنتجات غير المستلمة"
        subtitle="منتجات صُنّعت فعلياً لطلبات عملاء أُلغيت قبل التسليم — متاحة للبيع كما هي"
      />
      <Card>
        <Toolbar>
          <Field label="بحث">
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
              }}
              placeholder="اسم المنتج أو رقم الطلب"
            />
          </Field>
          <Field label="الحالة">
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
              }}
            >
              <option value="">كل الحالات</option>
              <option value="available">متاح للبيع</option>
              <option value="reserved">محجوز على فاتورة</option>
              <option value="sold">تم البيع</option>
              <option value="resumed">استؤنف إلى الطلب الأصلي</option>
            </Select>
          </Field>
        </Toolbar>
        <DataTable
          loading={list.loading}
          rows={rows}
          rowKey={(row) => row.id}
          empty="لا توجد منتجات غير مستلمة"
          columns={[
            { key: 'name', header: 'المنتج', render: (row) => row.name },
            {
              key: 'source',
              header: 'الطلب الأصلي',
              render: (row) => (
                <Button variant="secondary" onClick={() => navigate(`/orders/${row.sourceOrderId}`)}>
                  {row.sourceOrderNumber}
                </Button>
              )
            },
            { key: 'dimensions', header: 'الأبعاد', render: (row) => row.dimensions ?? '—' },
            { key: 'qty', header: 'الكمية', render: (row) => fmtQty(row.quantityMicro) },
            {
              key: 'status',
              header: 'الحالة',
              render: (row) => (
                <Badge tone={STATUS[row.status]?.tone ?? 'neutral'}>
                  {STATUS[row.status]?.label ?? row.status}
                </Badge>
              )
            },
            { key: 'transferred', header: 'تاريخ التحويل', render: (row) => fmtDate(row.transferredAt) },
            // The cost column is built only when main actually sent the
            // figure — its presence in the payload IS the authorisation.
            ...(showCost
              ? [
                  {
                    key: 'cost',
                    header: 'التكلفة الفعلية',
                    render: (row: Row) => fmtMoney(row.costBasisMinor)
                  },
                  {
                    key: 'soldPrice',
                    header: 'سعر البيع',
                    render: (row: Row) => (row.soldPriceMinor ? fmtMoney(row.soldPriceMinor) : '—')
                  }
                ]
              : []),
            {
              key: 'open',
              header: '',
              render: (row) => (
                <>
                <Button variant="secondary" onClick={() => setOpenId(row.id)}>
                  التفاصيل
                </Button>
                {row.canResume && can(P.uncollectedProducts.resume) && (
                  <Button variant="secondary" onClick={() => openResume(row)}>استئناف الطلب</Button>
                )}
                </>
              )
            }
          ]}
        />
        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} totalCount={list.summary?.totalCount ?? 0} pageSize={pageSize} noun="منتج" />
      </Card>

      <Modal open={Boolean(openId)} wide title="تفاصيل المنتج غير المستلم" onClose={() => setOpenId(undefined)}>
        {detail.loading && <div className="state">جارٍ التحميل…</div>}
        {item && (
          <>
            <PageHeader
              title={item.name}
              subtitle={`مصدره الطلب ${item.sourceOrderNumber}${
                item.sourceWorkSheetNumber ? ` — أمر التصنيع ${item.sourceWorkSheetNumber}` : ''
              } — حُوّل في ${fmtDateTime(item.transferredAt)}`}
            />

            {/* The frozen specification: what was physically built, as it
                read at transfer. A later rename in the Material or Colour
                catalogue never rewrites any of this. */}
            <Card title="المواصفات المصنّعة">
              <Field label="الوصف"><div>{item.description ?? '—'}</div></Field>
              <Field label="المواصفات"><div>{item.specifications ?? '—'}</div></Field>
              <Field label="الأبعاد"><div>{item.dimensions ?? '—'}</div></Field>
              <Field label="الكمية"><div>{fmtQty(item.quantityMicro)}</div></Field>
            </Card>

            <Card title="الخامات والألوان">
              {item.selectedMaterials.length === 0 ? (
                <div className="state">لا توجد خامات مسجّلة</div>
              ) : (
                item.selectedMaterials.map((material, index) => (
                  <Field key={`${material.materialId ?? 'x'}-${index}`} label={material.name}>
                    <div className="pill-row">
                      {material.colors && material.colors.length > 0 ? (
                        material.colors.map((color, colorIndex) => (
                          <Badge key={`${color.colorId ?? 'x'}-${colorIndex}`} tone="neutral">
                            {color.code}
                            {color.name ? ` — ${color.name}` : ''}
                          </Badge>
                        ))
                      ) : (
                        <span className="muted">بدون لون محدد</span>
                      )}
                    </div>
                  </Field>
                ))
              )}
            </Card>

            <Card title="الإكسسوارات">
              {item.selectedAccessories.length === 0 ? (
                <div className="state">لا توجد إكسسوارات</div>
              ) : (
                <div className="pill-row">
                  {item.selectedAccessories.map((accessory, index) => (
                    <Badge key={`${accessory.materialId ?? 'x'}-${index}`} tone="neutral">
                      {accessory.name}
                    </Badge>
                  ))}
                </div>
              )}
            </Card>

            {/* Internal figures only — never part of any customer document. */}
            {showCost && (
              <Card title="التكلفة الفعلية (داخلي)">
                <div className="grid grid--4">
                  <Stat label="التكلفة المنسوبة لهذا المنتج" value={fmtMoney(item.costBasisMinor)} />
                  <Stat label="إجمالي تكلفة الطلب الأصلي" value={fmtMoney(item.costBasisOrderTotalMinor)} />
                  <Stat label="قيمة البند على الفاتورة الأصلية" value={fmtMoney(item.originalLineTotalMinor)} />
                  <Stat label="سعر البيع" value={item.soldPriceMinor ? fmtMoney(item.soldPriceMinor) : '—'} />
                  <Stat label="خامات" value={fmtMoney(item.costBasisMaterialMinor)} />
                  <Stat label="آلات" value={fmtMoney(item.costBasisMachineMinor)} />
                  <Stat label="عمالة" value={fmtMoney(item.costBasisWorkerMinor)} />
                  <Stat label="توصيل" value={fmtMoney(item.costBasisDeliveryMinor)} />
                  <Stat label="مصروفات" value={fmtMoney(item.costBasisExpenseMinor)} />
                </div>
                <p className="muted">
                  طريقة نسب التكلفة: {COST_METHOD[item.costBasisMethod ?? ''] ?? item.costBasisMethod ?? '—'}
                </p>
              </Card>
            )}

            {showCost && item.economics && (
              <Card title="اقتصاديات إعادة البيع (داخلي)">
                {item.economics.known ? (
                  <div className="grid grid--3">
                    <Stat label="التكلفة الفعلية للتصنيع" value={fmtMoney(item.economics.actualCostMinor)} />
                    <Stat label="مغطى من الزبون" value={fmtMoney(item.economics.customerCoveredMinor)} />
                    <Stat label="متحملها المصنع" value={fmtMoney(item.economics.factoryBorneMinor)} />
                    <Stat label="تكلفة إضافية قبل إعادة البيع" value={fmtMoney(item.economics.preparationCostMinor)} />
                    <Stat label="سعر إعادة البيع" value={item.soldPriceMinor != null ? fmtMoney(item.soldPriceMinor) : '—'} />
                    <Stat label="ربح إعادة البيع" value={item.resaleProfitMinor != null ? fmtMoney(item.resaleProfitMinor) : '—'} />
                  </div>
                ) : (
                  <div className="state">تكلفة تصنيع هذا المنتج غير قابلة للنسب إليه — لا يمكن حساب تغطيتها أو بيعه</div>
                )}
                {(item.preparationCosts?.length ?? 0) > 0 && (
                  <ul>
                    {item.preparationCosts!.map((cost) => (
                      <li key={cost.id}>{fmtDate(cost.spentAt)} — {cost.description}: {fmtMoney(cost.amountMinor)}</li>
                    ))}
                  </ul>
                )}
                {canAddPreparation && (
                  <div className="grid grid--4">
                    <Field label="تكلفة إضافية قبل إعادة البيع (د.ل)">
                      <Input type="number" step="0.01" value={prep.amount} onChange={(e) => setPrep({ ...prep, amount: e.target.value })} />
                    </Field>
                    <Field label="البيان">
                      <Input value={prep.description} onChange={(e) => setPrep({ ...prep, description: e.target.value })} />
                    </Field>
                    <Field label="الحساب النقدي">
                      <Select value={prep.accountId} onChange={(e) => setPrep({ ...prep, accountId: e.target.value })}>
                        <option value="">— بدون حركة نقدية —</option>
                        {(accounts.data ?? []).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                      </Select>
                    </Field>
                    <Field label=" ">
                      <Button disabled={!(Number(prep.amount) > 0)} onClick={() => void addPreparationCost()}>إضافة التكلفة</Button>
                    </Field>
                  </div>
                )}
                {prepError && <div className="error-note">{prepError}</div>}
              </Card>
            )}

            <Card title="التتبّع">
              {item.canResume && can(P.uncollectedProducts.resume) && (
                <Button variant="secondary" onClick={() => openResume(item)}>استئناف الطلب</Button>
              )}
              <Field label="سبب إلغاء الطلب الأصلي"><div>{item.cancelReason ?? '—'}</div></Field>
              <Field label="الحالة">
                <div>
                  <Badge tone={STATUS[item.status]?.tone ?? 'neutral'}>
                    {STATUS[item.status]?.label ?? item.status}
                  </Badge>
                </div>
              </Field>
              <Field label="الطلب الأصلي">
                <div>
                  <Button variant="secondary" onClick={() => navigate(`/orders/${item.sourceOrderId}`)}>
                    {item.sourceOrderNumber}
                  </Button>
                </div>
              </Field>
              {item.soldInvoice && (
                <Field label="بيع على الفاتورة"><div>{item.soldInvoice.documentNumber}</div></Field>
              )}
              {item.soldOrder && (
                <Field label="طلب العميل الجديد">
                  <div>
                    <Button variant="secondary" onClick={() => navigate(`/orders/${item.soldOrder!.id}`)}>
                      {item.soldOrder.documentNumber}
                    </Button>
                  </div>
                </Field>
              )}
              {item.resumedAt && <Field label="تاريخ استئناف الطلب"><div>{fmtDateTime(item.resumedAt)}</div></Field>}
              {item.soldAt && <Field label="تاريخ البيع"><div>{fmtDateTime(item.soldAt)}</div></Field>}
            </Card>
          </>
        )}
      </Modal>
      <Modal open={Boolean(resume)} title="تأكيد استئناف الطلب" onClose={() => { if (!resuming) setResume(undefined) }}
        footer={<>
          <Button disabled={resuming} onClick={() => void confirmResume()}>تأكيد استئناف الطلب</Button>
          <Button variant="secondary" disabled={resuming} onClick={() => setResume(undefined)}>إغلاق</Button>
        </>}>
        <p>سيتم استئناف الطلب الأصلي <strong>{resume?.row.sourceOrderNumber}</strong> بالكامل للعميل الأصلي وإعادة جميع المنتجات التالية إليه:</p>
        <ul>{resume?.row.resumeProducts.map(product => <li key={product.id}>{product.name}</li>)}</ul>
        <p>ستصبح جميع هذه المنتجات غير متاحة للبيع لعميل آخر. سيتم الحفاظ على التصنيع والدفعات السابقة، ومتابعة إجراءات إذن الخروج والتسليم للطلب بالكامل.</p>
        {resumeError && <div className="error-note">{resumeError}</div>}
      </Modal>
    </>
  )
}
