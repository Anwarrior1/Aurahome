import { useState, type ReactElement } from 'react'
import { Trash2 } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Select, Textarea, Toolbar } from '@renderer/components/ui'
import { fmtMoney, fmtQty, toMicro } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { standardProductAvailability } from '@shared/production/standard-availability'

interface Product { id: number; code: string; name: string; description: string | null; defaultPriceMinor: number; active: boolean }
interface FullDeletePreview {
  productId: number
  code: string
  name: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}
interface BomLine {
  id: number; materialId: number; materialName: string; qtyMicro: number; unit: string
  dimensions: string | null; componentName: string | null
  unitPriceMicro: number | null; materialPriceMicro: number
}
interface MachineLine { id: number; machineId: number; machineName: string; costingUnit: string; usageQtyMicro: number; rateMicro: number | null; defaultRateMicro: number; notes: string | null }
interface CommissionLine { id: number; workerId: number | null; workerName: string | null; amountMinor: number; notes: string | null }
interface ProductCost { materialCostMinor: number; machineCostMinor: number; commissionCostMinor: number; manufacturingCostMinor: number }
interface Material { id: number; name: string; unit: string; currentMarketPriceMicro: number }
interface Machine { id: number; name: string; costingUnit: string; defaultRateMicro: number }
interface WorkerOption { id: number; name: string }
interface BomDraft { materialId: string; qty: string; unit: string; dimensions: string; componentName: string; price: string }
interface MachineDraft { machineId: string; usageQty: string; rate: string; notes: string }
interface CommissionDraft { workerId: string; amount: string; notes: string }

type ConfigTab = 'materials' | 'machines' | 'commission' | 'cost'
interface StockIssuePreview {
  productName: string; quantityMicro: number; canIssue: boolean; readyMicro: number; readyAfterMicro: number
  lines: Array<{ materialId: number; materialName: string; unit: string; qtyMicro: number; availableMicro: number; shortageMicro: number }>
}

export function ProductsPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Partial<Product> | undefined>()
  const [configFor, setConfigFor] = useState<Product | undefined>()
  const [tab, setTab] = useState<ConfigTab>('materials')
  const [bom, setBom] = useState<BomDraft[]>([])
  const [machineLines, setMachineLines] = useState<MachineDraft[]>([])
  const [commissionLines, setCommissionLines] = useState<CommissionDraft[]>([])
  const [error, setError] = useState<string>()
  const [deleteDialog, setDeleteDialog] = useState<{ row: Product; preview: FullDeletePreview; confirmation: string; error?: string }>()
  // BL-04 «صرف من المخزون»: the backend command is authoritative; the preview is advisory only.
  const [stockIssue, setStockIssue] = useState<{ units: string; preview?: StockIssuePreview; error?: string; busy?: boolean }>()

  const list = useQuery<Product[]>('products', 'list', { search })
  const ready = useQuery<Array<{ id: number; onHandMicro: number }>>('production', 'finishedGoods', {})
  const readyMicro = (id: number): number => ready.data?.find((row) => row.id === id)?.onHandMicro ?? 0
  const materials = useQuery<Material[]>('materials', 'list', {})
  const machineOptions = useQuery<Machine[]>('machines', 'list', { activeOnly: true })
  const workerOptions = useQuery<WorkerOption[]>('workers', 'list', { activeOnly: true })
  const detail = useQuery<{ product: Product; bom: BomLine[]; machines: MachineLine[]; commission: CommissionLine[]; cost: ProductCost }>(
    'products', 'get', { id: configFor?.id ?? 0 }, { enabled: Boolean(configFor) }
  )

  async function save(): Promise<void> {
    if (!editing?.code?.trim() || !editing?.name?.trim()) { setError('الكود والاسم مطلوبان'); return }
    try {
      const payload = {
        code: editing.code, name: editing.name,
        description: editing.description ?? undefined,
        defaultPriceMinor: editing.defaultPriceMinor ?? 0
      }
      if (editing.id) await call('products', 'update', { id: editing.id, ...payload, active: editing.active })
      else await call('products', 'create', payload)
      toast.show('تم حفظ المنتج', 'success')
      setEditing(undefined); setError(undefined)
      await list.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  /**
   * Permanent delete only — a Standard Product has no separate plain
   * "remove" action (item 8: it is always either fully deleted or left
   * alone; every historical quotation/order/approved-invoice line that
   * named it holds its own frozen copy and only loses the live link,
   * see products.service.ts). The preview is fetched first so the
   * confirmation dialog can show real dependency counts and any real
   * blocker before anything is asked to type a single character.
   */
  async function openDeleteDialog(row: Product): Promise<void> {
    try {
      const preview = await call<FullDeletePreview>('products', 'fullDeletePreview', { id: row.id })
      setDeleteDialog({ row, preview, confirmation: '' })
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر فحص المنتج', 'error')
    }
  }

  async function fullDeleteFromDialog(): Promise<void> {
    if (!deleteDialog) return
    if (deleteDialog.confirmation.trim() !== deleteDialog.row.code.trim()) {
      setDeleteDialog({ ...deleteDialog, error: `اكتب كود المنتج "${deleteDialog.row.code}" للتأكيد النهائي` })
      return
    }
    try {
      await call('products', 'fullDelete', { id: deleteDialog.row.id, confirmation: deleteDialog.confirmation })
      toast.show('تم حذف المنتج نهائياً من المنتجات القياسية', 'success')
      setDeleteDialog(undefined)
      await list.reload()
    } catch (err) {
      setDeleteDialog({ ...deleteDialog, error: err instanceof ApiError ? err.message : 'تعذر حذف المنتج نهائياً' })
    }
  }

  function openConfig(product: Product): void {
    setConfigFor(product)
    setTab('materials')
    setError(undefined)
    setBom([]); setMachineLines([]); setCommissionLines([])
  }

  function closeConfig(): void {
    setConfigFor(undefined)
    setBom([]); setMachineLines([]); setCommissionLines([])
  }

  const currentBom: BomDraft[] = bom.length
    ? bom
    : (detail.data?.bom ?? []).map((line) => ({
        materialId: String(line.materialId), qty: String(line.qtyMicro / 1_000_000),
        unit: line.unit, dimensions: line.dimensions ?? '', componentName: line.componentName ?? '',
        price: line.unitPriceMicro !== null ? String(line.unitPriceMicro / 1_000_000) : ''
      }))

  const currentMachines: MachineDraft[] = machineLines.length
    ? machineLines
    : (detail.data?.machines ?? []).map((line) => ({
        machineId: String(line.machineId), usageQty: String(line.usageQtyMicro / 1_000_000),
        rate: line.rateMicro !== null ? String(line.rateMicro / 1_000_000) : '',
        notes: line.notes ?? ''
      }))

  const currentCommission: CommissionDraft[] = commissionLines.length
    ? commissionLines
    : (detail.data?.commission ?? []).map((line) => ({
        workerId: line.workerId !== null ? String(line.workerId) : '', amount: String(line.amountMinor / 1000),
        notes: line.notes ?? ''
      }))

  async function saveBom(): Promise<void> {
    if (!configFor) return
    try {
      await call('products', 'setBom', {
        productId: configFor.id,
        lines: currentBom.filter((line) => line.materialId && Number(line.qty) > 0).map((line) => ({
          materialId: Number(line.materialId), qtyMicro: toMicro(line.qty), unit: line.unit || 'وحدة',
          dimensions: line.dimensions || null, componentName: line.componentName || null,
          unitPriceMicro: line.price ? Math.round(Number(line.price) * 1_000_000) : null
        }))
      })
      toast.show('تم حفظ قائمة المواد', 'success')
      setBom([])
      await detail.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  async function saveMachines(): Promise<void> {
    if (!configFor) return
    try {
      await call('products', 'setMachines', {
        productId: configFor.id,
        lines: currentMachines.filter((line) => line.machineId && Number(line.usageQty) > 0).map((line) => ({
          machineId: Number(line.machineId), usageQtyMicro: toMicro(line.usageQty),
          rateMicro: line.rate ? Math.round(Number(line.rate) * 1_000_000) : null,
          notes: line.notes || null
        }))
      })
      toast.show('تم حفظ قائمة الآلات', 'success')
      setMachineLines([])
      await detail.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  async function saveCommission(): Promise<void> {
    if (!configFor) return
    try {
      await call('products', 'setCommission', {
        productId: configFor.id,
        lines: currentCommission.filter((line) => Number(line.amount) > 0).map((line) => ({
          workerId: line.workerId ? Number(line.workerId) : null,
          amountMinor: Math.round(Number(line.amount) * 1000),
          notes: line.notes || null
        }))
      })
      toast.show('تم حفظ عمولة العامل', 'success')
      setCommissionLines([])
      await detail.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  async function saveCurrentTab(): Promise<void> {
    if (tab === 'materials') await saveBom()
    else if (tab === 'machines') await saveMachines()
    else await saveCommission()
  }

  const cost = detail.data?.cost

  async function previewStockIssue(units: string): Promise<void> {
    if (!configFor) return
    const count = Number(units)
    if (!Number.isInteger(count) || count <= 0) { setStockIssue({ units, error: 'الكمية المصنّعة يجب أن تكون عدداً صحيحاً أكبر من صفر' }); return }
    try {
      const preview = await call<StockIssuePreview>('products', 'stockIssuePreview', { productId: configFor.id, quantityMicro: toMicro(units) })
      setStockIssue({ units, preview })
    } catch (err) { setStockIssue({ units, error: err instanceof ApiError ? err.message : 'تعذر حساب المعاينة' }) }
  }

  async function confirmStockIssue(): Promise<void> {
    if (!configFor || !stockIssue?.preview) return
    setStockIssue({ ...stockIssue, busy: true, error: undefined })
    try {
      await financialCall('products', 'issueStockFromBom', { productId: configFor.id, quantityMicro: stockIssue.preview.quantityMicro }, `products.issueStockFromBom.${configFor.id}`)
      toast.show('تم صرف المواد وإضافة الكمية إلى المخزون الجاهز', 'success')
      setStockIssue(undefined)
      await Promise.all([ready.reload(), materials.reload(), detail.reload()])
    } catch (err) { setStockIssue({ ...stockIssue, busy: false, error: err instanceof ApiError ? err.message : 'تعذر تنفيذ الصرف' }) }
  }

  return (
    <>
      <PageHeader
        title="المنتجات القياسية"
        subtitle="تعديل قائمة المكونات آمن دائماً — الطلبات السابقة تحتفظ بنسخة مجمّدة منها"
        actions={can(P.products.manage) && <Button onClick={() => { setEditing({}); setError(undefined) }}>+ منتج جديد</Button>}
      />
      <Card>
        <Toolbar><Field label="بحث"><Input value={search} onChange={(e) => setSearch(e.target.value)} /></Field></Toolbar>
        <DataTable
          loading={list.loading}
          rows={list.data ?? []}
          rowKey={(row) => row.id}
          empty="لا توجد منتجات"
          columns={[
            { key: 'code', header: 'الكود', render: (row) => row.code },
            { key: 'name', header: 'المنتج', render: (row) => row.name },
            { key: 'price', header: 'السعر الافتراضي', numeric: true, render: (row) => fmtMoney(row.defaultPriceMinor) },
            { key: 'ready', header: 'الكمية الجاهزة', numeric: true, render: (row) => fmtQty(readyMicro(row.id)) },
            { key: 'availability', header: 'التوفر', render: (row) => standardProductAvailability(readyMicro(row.id)) },
            {
              key: 'actions', header: '', render: (row) => (
                <div className="row-actions">
                  <Button variant="secondary" size="sm" onClick={() => openConfig(row)}>قائمة المكونات</Button>
                  {can(P.products.manage) && <Button variant="ghost" size="sm" onClick={() => { setEditing(row); setError(undefined) }}>تعديل</Button>}
                  {can(P.products.fullDelete) && (
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void openDeleteDialog(row)}>
                      <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )
            }
          ]}
        />
      </Card>

      <Modal open={Boolean(editing)} title={editing?.id ? 'تعديل منتج' : 'منتج جديد'} onClose={() => setEditing(undefined)}
        footer={<><Button onClick={() => void save()}>حفظ</Button><Button variant="secondary" onClick={() => setEditing(undefined)}>إلغاء</Button></>}>
        <ErrorNote>{error}</ErrorNote>
        <Field label="كود المنتج" required><Input value={editing?.code ?? ''} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
        <Field label="اسم المنتج" required><Input value={editing?.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
        <Field label="الوصف"><Textarea value={editing?.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
        <Field label="السعر الافتراضي (د.ل)" hint="مرجعي فقط — السعر النهائي يحدده المستخدم في عرض السعر">
          <Input type="number" step="0.01" value={editing?.defaultPriceMinor ? editing.defaultPriceMinor / 1000 : ''}
            onChange={(e) => setEditing({ ...editing, defaultPriceMinor: Math.round(Number(e.target.value) * 1000) })} />
        </Field>
      </Modal>

      {/*
        Item 3/12: the same product-configuration window, expanded into
        four clearly separated sections — المواد (inventory materials,
        unchanged), الآلات (standard machine usage — never inventory),
        عمولة العامل (a standard commission RULE only; it pays nobody
        and posts nothing by itself — see products.service.ts), and
        التكلفة الإنتاجية, a read-only calculated summary of the other
        three — never a fourth, independently-editable cost source.
      */}
      <Modal open={Boolean(configFor)} wide title={`قائمة مكونات المنتج: ${configFor?.name ?? ''}`} onClose={closeConfig}
        footer={can(P.products.manage) && tab !== 'cost' ? <>
          <Button onClick={() => void saveCurrentTab()}>حفظ</Button>
          <Button variant="secondary" onClick={closeConfig}>إغلاق</Button>
        </> : <Button variant="secondary" onClick={closeConfig}>إغلاق</Button>}>
        <ErrorNote>{error}</ErrorNote>

        <div className="tabs" style={{ marginBottom: 12 }}>
          <Button variant={tab === 'materials' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('materials')}>المواد</Button>
          <Button variant={tab === 'machines' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('machines')}>الآلات</Button>
          <Button variant={tab === 'commission' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('commission')}>عمولة العامل</Button>
          <Button variant={tab === 'cost' ? 'secondary' : 'ghost'} size="sm" onClick={() => setTab('cost')}>التكلفة الإنتاجية</Button>
        </div>

        {tab === 'cost' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              التكلفة الإنتاجية القياسية لوحدة واحدة من هذا المنتج، محسوبة تلقائياً من إعداداته الحالية — للعرض فقط ولا تُعدَّل يدوياً هنا.
              هذا تقدير حسب الإعداد القياسي، وليس بالضرورة التكلفة الفعلية لأمر تصنيع محدد.
            </p>
            <div className="grid grid--4">
              <Field label="إجمالي تكلفة المواد"><p className="muted">{fmtMoney(cost?.materialCostMinor ?? 0)}</p></Field>
              <Field label="إجمالي تكلفة الآلات"><p className="muted">{fmtMoney(cost?.machineCostMinor ?? 0)}</p></Field>
              <Field label="إجمالي عمولات العمال"><p className="muted">{fmtMoney(cost?.commissionCostMinor ?? 0)}</p></Field>
              <Field label="الإجمالي"><p><strong>{fmtMoney(cost?.manufacturingCostMinor ?? 0)}</strong></p></Field>
            </div>
          </>
        )}

        {tab === 'materials' && (
          <>
            {currentBom.map((line, index) => {
              const material = materials.data?.find((m) => m.id === Number(line.materialId))
              return (
                <div key={index} className="grid grid--5" style={{ alignItems: 'end' }}>
                  <Field label="المادة">
                    <Select value={line.materialId} onChange={(e) => {
                      const next = [...currentBom]; next[index] = { ...line, materialId: e.target.value }
                      const selected = materials.data?.find((m) => m.id === Number(e.target.value))
                      if (selected && !line.unit) next[index]!.unit = selected.unit
                      setBom(next)
                    }}>
                      <option value="">— اختر —</option>
                      {(materials.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="الكمية">
                    <Input type="number" step="0.001" value={line.qty} onChange={(e) => {
                      const next = [...currentBom]; next[index] = { ...line, qty: e.target.value }; setBom(next)
                    }} />
                  </Field>
                  <Field label="الوحدة">
                    <Input value={line.unit} onChange={(e) => {
                      const next = [...currentBom]; next[index] = { ...line, unit: e.target.value }; setBom(next)
                    }} />
                  </Field>
                  <Field label="المقاس / الطول">
                    <Input value={line.dimensions} onChange={(e) => {
                      const next = [...currentBom]; next[index] = { ...line, dimensions: e.target.value }; setBom(next)
                    }} />
                  </Field>
                  <Field label="السعر (د.ل)" hint="اتركه فارغاً لاستخدام السعر المرجعي للمادة">
                    <Input
                      type="number" step="0.000001" value={line.price}
                      placeholder={material ? String(material.currentMarketPriceMicro / 1_000_000) : ''}
                      onChange={(e) => {
                        const next = [...currentBom]; next[index] = { ...line, price: e.target.value }; setBom(next)
                      }}
                    />
                  </Field>
                </div>
              )
            })}
            {can(P.products.manage) && (
              <div className="row-actions">
                <Button variant="secondary" size="sm" onClick={() => setBom([...currentBom, { materialId: '', qty: '', unit: '', dimensions: '', componentName: '', price: '' }])}>+ مادة</Button>
                {currentBom.length > 0 && <Button variant="ghost" size="sm" onClick={() => setBom(currentBom.slice(0, -1))}>حذف الأخير</Button>}
              </div>
            )}
            {!currentBom.length && <div className="state">لا توجد مواد — أضف المواد المطلوبة لتصنيع هذا المنتج</div>}
            {can(P.products.manage) && can(P.inventory.consume) && (detail.data?.bom.length ?? 0) > 0 && (
              <div className="row-actions" style={{ marginTop: 10 }}>
                <Button variant="secondary" size="sm" disabled={bom.length > 0} title={bom.length > 0 ? 'احفظ تعديلات قائمة المواد أولاً' : undefined} onClick={() => setStockIssue({ units: '' })}>صرف من المخزون</Button>
              </div>
            )}
          </>
        )}

        {tab === 'machines' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              الآلات ليست مادة مخزون ولا تُخصم منه — تكلفتها معيارية لتقدير تكلفة تصنيع الوحدة فقط. التكلفة الفعلية تُسجَّل لاحقاً أثناء التصنيع الحقيقي.
            </p>
            {currentMachines.map((line, index) => (
              <div key={index} className="grid grid--3" style={{ alignItems: 'end' }}>
                <Field label="الآلة">
                  <Select value={line.machineId} onChange={(e) => {
                    const next = [...currentMachines]; next[index] = { ...line, machineId: e.target.value }
                    setMachineLines(next)
                  }}>
                    <option value="">— اختر —</option>
                    {(machineOptions.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name} ({m.costingUnit})</option>)}
                  </Select>
                </Field>
                <Field label="الاستخدام المعياري">
                  <Input type="number" step="0.001" value={line.usageQty} onChange={(e) => {
                    const next = [...currentMachines]; next[index] = { ...line, usageQty: e.target.value }; setMachineLines(next)
                  }} />
                </Field>
                <Field label="سعر الوحدة (د.ل)" hint="اتركه فارغاً لاستخدام السعر الافتراضي للآلة">
                  <Input type="number" step="0.000001" value={line.rate} onChange={(e) => {
                    const next = [...currentMachines]; next[index] = { ...line, rate: e.target.value }; setMachineLines(next)
                  }} />
                </Field>
              </div>
            ))}
            {can(P.products.manage) && (
              <div className="row-actions">
                <Button variant="secondary" size="sm" onClick={() => setMachineLines([...currentMachines, { machineId: '', usageQty: '', rate: '', notes: '' }])}>+ آلة</Button>
                {currentMachines.length > 0 && <Button variant="ghost" size="sm" onClick={() => setMachineLines(currentMachines.slice(0, -1))}>حذف الأخير</Button>}
              </div>
            )}
            {!currentMachines.length && <div className="state">لا توجد آلات معرّفة لهذا المنتج</div>}
          </>
        )}

        {tab === 'commission' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              اختر عاملاً لكل عمولة. تُحتسب العمولة الفعلية وتصبح مستحقة عند إكمال تصنيع المنتج القياسي.
            </p>
            {currentCommission.map((line, index) => (
              <div key={index} className="grid grid--3" style={{ alignItems: 'end' }}>
                <Field label="العامل">
                  <Select value={line.workerId} onChange={(e) => {
                    const next = [...currentCommission]; next[index] = { ...line, workerId: e.target.value }
                    setCommissionLines(next)
                  }}>
                    <option value="">— اختر العامل —</option>
                    {(workerOptions.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </Select>
                </Field>
                <Field label="قيمة العمولة (د.ل)">
                  <Input type="number" step="0.001" value={line.amount} onChange={(e) => {
                    const next = [...currentCommission]; next[index] = { ...line, amount: e.target.value }; setCommissionLines(next)
                  }} />
                </Field>
                <Field label="ملاحظات">
                  <Input value={line.notes} onChange={(e) => {
                    const next = [...currentCommission]; next[index] = { ...line, notes: e.target.value }; setCommissionLines(next)
                  }} />
                </Field>
              </div>
            ))}
            {can(P.products.manage) && (
              <div className="row-actions">
                <Button variant="secondary" size="sm" onClick={() => setCommissionLines([...currentCommission, { workerId: '', amount: '', notes: '' }])}>+ عمولة</Button>
                {currentCommission.length > 0 && <Button variant="ghost" size="sm" onClick={() => setCommissionLines(currentCommission.slice(0, -1))}>حذف الأخير</Button>}
              </div>
            )}
            {!currentCommission.length && <div className="state">لا توجد عمولة معيارية معرّفة لهذا المنتج</div>}
          </>
        )}

        {tab === 'materials' && detail.data?.bom.length ? (
          <p className="muted" style={{ marginTop: 10, fontSize: 11.5 }}>
            الكمية الحالية: {detail.data.bom.map((line) => `${line.materialName} ${fmtQty(line.qtyMicro, line.unit)}`).join('، ')}
          </p>
        ) : null}
      </Modal>

      <Modal open={Boolean(stockIssue)} wide title={`صرف من المخزون: ${configFor?.name ?? ''}`} onClose={() => { if (!stockIssue?.busy) setStockIssue(undefined) }}
        footer={<>
          <Button disabled={!stockIssue?.preview?.canIssue || stockIssue?.busy} onClick={() => void confirmStockIssue()}>{stockIssue?.busy ? 'جارٍ الصرف…' : 'تأكيد'}</Button>
          <Button variant="secondary" disabled={stockIssue?.busy} onClick={() => setStockIssue(undefined)}>إلغاء</Button>
        </>}>
        <ErrorNote>{stockIssue?.error}</ErrorNote>
        <p className="muted" style={{ marginTop: 0 }}>تُصرف مواد قائمة المكونات × الكمية المصنّعة من المخزون، وتُضاف الكمية نفسها إلى المخزون الجاهز — عملية واحدة كاملة أو لا شيء.</p>
        <Field label="الكمية المصنّعة" required>
          <Input type="number" min="1" step="1" value={stockIssue?.units ?? ''} onChange={(e) => void previewStockIssue(e.target.value)} />
        </Field>
        {stockIssue?.preview && (
          <>
            <DataTable
              rows={stockIssue.preview.lines}
              rowKey={(line) => line.materialId}
              empty="لا توجد مواد"
              columns={[
                { key: 'material', header: 'المادة', render: (line) => line.materialName },
                { key: 'required', header: 'المطلوب', numeric: true, render: (line) => fmtQty(line.qtyMicro, line.unit) },
                { key: 'available', header: 'المتاح', numeric: true, render: (line) => fmtQty(line.availableMicro, line.unit) },
                { key: 'shortage', header: 'النقص', numeric: true, render: (line) => line.shortageMicro > 0 ? <span className="error-note">{fmtQty(line.shortageMicro, line.unit)}</span> : '—' }
              ]}
            />
            <p>
              الكمية الجاهزة: {fmtQty(stockIssue.preview.readyMicro)} ← بعد الصرف: <strong>{fmtQty(stockIssue.preview.readyAfterMicro)}</strong>
            </p>
            {!stockIssue.preview.canIssue && <div className="error-note">المواد غير كافية لتصنيع الكمية كاملة — لن يُصرف أي شيء.</div>}
          </>
        )}
      </Modal>

      <Modal
        open={Boolean(deleteDialog)}
        wide
        title="حذف المنتج نهائياً"
        onClose={() => setDeleteDialog(undefined)}
        footer={<>
          <Button
            variant="destructive"
            disabled={Boolean(deleteDialog?.preview.blockers.length)}
            onClick={() => void fullDeleteFromDialog()}
          >
            حذف نهائي
          </Button>
          <Button variant="secondary" onClick={() => setDeleteDialog(undefined)}>إلغاء</Button>
        </>}
      >
        <ErrorNote>{deleteDialog?.error}</ErrorNote>
        <p>أنت على وشك حذف المنتج «{deleteDialog?.row.name}» من قائمة المنتجات القياسية.</p>
        <p>
          سيُحذف مع قائمة مكوناته الحالية (المواد والآلات وعمولة العامل). المستندات السابقة التي استخدمت هذا المنتج —
          فواتير مبدئية ومعتمدة وطلبات عملاء وأوامر تصنيع — تبقى محفوظة كما هي بكامل بياناتها المجمّدة (الاسم والوصف
          والمواصفات والسعر ومكونات التصنيع وقت إصدارها)، ولن يعود بالإمكان اختيار هذا المنتج في مستندات جديدة.
        </p>
        {(deleteDialog?.preview.dependencies.length ?? 0) > 0 && (
          <>
            <p style={{ fontWeight: 600, fontSize: 12.5 }}>سيتأثر:</p>
            <ul>
              {(deleteDialog?.preview.dependencies ?? []).map((item) => <li key={item.key}>{item.label}: {item.count}</li>)}
            </ul>
          </>
        )}
        {(deleteDialog?.preview.blockers.length ?? 0) > 0 && (
          <div className="error-note">لا يمكن الحذف حالياً: {deleteDialog!.preview.blockers.join('، ')}</div>
        )}
        <p className="muted">هذا الإجراء نهائي ولا يمكن التراجع عنه.</p>
        <Field label={`للتأكيد اكتب: ${deleteDialog?.row.code ?? ''}`} required>
          <Input value={deleteDialog?.confirmation ?? ''} onChange={(e) => setDeleteDialog(deleteDialog ? { ...deleteDialog, confirmation: e.target.value, error: undefined } : undefined)} />
        </Field>
      </Modal>
    </>
  )
}
