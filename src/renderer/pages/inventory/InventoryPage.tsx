import { useState, type ReactElement } from 'react'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Pager, Select, Toolbar } from '@renderer/components/ui'
import { fmtMoney, fmtQty, fmtDateTime, toMicro } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { useSearchParams } from 'react-router-dom'

interface Stock { materialId: number; sku: string; name: string; unit: string; categoryName: string; qtyMicro: number; reorderLevelMicro: number }
interface Movement { id: number; materialId: number; kind: string; qtyMicro: number; orderId: number | null; actualCostMinor?: number; sourceKind: string | null; sourceRefId: number | null; balanceAfterMicro: number | null; reason: string | null; createdAt: string }

const KINDS: Record<string, { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' | 'info' }> = {
  purchase: { label: 'شراء', tone: 'success' },
  consumption: { label: 'صرف لطلب', tone: 'info' },
  sale: { label: 'بيع مباشر', tone: 'info' },
  waste: { label: 'هالك', tone: 'danger' },
  adjustment_in: { label: 'تسوية إضافة', tone: 'neutral' },
  adjustment_out: { label: 'تسوية خصم', tone: 'warning' },
  opening: { label: 'رصيد افتتاحي', tone: 'info' },
  consumption_reversal: { label: 'عكس صرف إنتاج', tone: 'success' },
  material_return: { label: 'مرتجع مادة خام', tone: 'success' },
  material_return_reversal: { label: 'عكس مرتجع مادة خام', tone: 'warning' }
}

const INCOMING_KINDS = new Set([
  'purchase', 'opening', 'adjustment_in', 'consumption_reversal', 'material_return'
])

export function InventoryPage(): ReactElement {
  const [searchParams] = useSearchParams()
  const { can } = useSession()
  const toast = useToast()
  const [kind, setKind] = useState('')
  const [materialId, setMaterialId] = useState(searchParams.get('materialId') ?? '')
  const [waste, setWaste] = useState(false)
  const [adjust, setAdjust] = useState(false)
  const [form, setForm] = useState({ materialId: '', qty: '', reason: '', direction: 'in' })
  const [error, setError] = useState<string>()

  const stock = useQuery<Stock[]>('inventory', 'stock', {})
  const movements = usePagedQuery<Movement>('inventory', 'movements', {
    kind: kind || undefined,
    materialId: materialId ? Number(materialId) : undefined
  })
  const materialName = new Map(stock.data?.map((row) => [row.materialId, `${row.name} (${row.unit})`]))

  async function submitWaste(): Promise<void> {
    try {
      await call('inventory', 'waste', {
        materialId: Number(form.materialId), qtyMicro: toMicro(form.qty), reason: form.reason
      })
      toast.show('تم تسجيل الهالك كخسارة تشغيلية عامة', 'success')
      setWaste(false); setForm({ materialId: '', qty: '', reason: '', direction: 'in' }); setError(undefined)
      await Promise.all([stock.reload(), movements.reload()])
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر التسجيل') }
  }

  async function submitAdjust(): Promise<void> {
    try {
      await call('inventory', 'adjust', {
        materialId: Number(form.materialId), qtyMicro: toMicro(form.qty),
        direction: form.direction, reason: form.reason
      })
      toast.show('تم تسجيل التسوية', 'success')
      setAdjust(false); setForm({ materialId: '', qty: '', reason: '', direction: 'in' }); setError(undefined)
      await Promise.all([stock.reload(), movements.reload()])
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر التسجيل') }
  }

  const lowStock = (stock.data ?? []).filter((row) => row.reorderLevelMicro > 0 && row.qtyMicro <= row.reorderLevelMicro)

  return (
    <>
      <PageHeader
        title={materialId ? 'سجل حركة المخزون للمادة' : 'حركة المخزون'}
        subtitle="سجل غير قابل للتعديل — كل تصحيح يُسجَّل كحركة جديدة"
        actions={<>
          {can(P.inventory.waste) && <Button variant="secondary" onClick={() => { setWaste(true); setError(undefined) }}>تسجيل هالك</Button>}
          {can(P.inventory.adjust) && <Button onClick={() => { setAdjust(true); setError(undefined) }}>تسوية مخزون</Button>}
        </>}
      />

      {lowStock.length > 0 && (
        <Card title={`مواد وصلت حد إعادة الطلب (${lowStock.length})`}>
          <div className="pill-row">
            {lowStock.map((row) => (
              <Badge key={row.materialId} tone="warning">{row.name}: {fmtQty(row.qtyMicro, row.unit)}</Badge>
            ))}
          </div>
        </Card>
      )}

      <Card title="الأرصدة الحالية">
        <DataTable
          loading={stock.loading}
          rows={stock.data ?? []}
          rowKey={(row) => row.materialId}
          empty="لا توجد مواد"
          columns={[
            { key: 'sku', header: 'الكود', render: (row) => row.sku },
            { key: 'name', header: 'المادة', render: (row) => row.name },
            { key: 'cat', header: 'التصنيف', render: (row) => row.categoryName },
            { key: 'qty', header: 'الرصيد', numeric: true, render: (row) => fmtQty(row.qtyMicro, row.unit) }
          ]}
        />
      </Card>

      <Card title="سجل الحركات">
        <Toolbar>
          <Field label="نوع الحركة">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">الكل</option>
              {Object.entries(KINDS).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}
            </Select>
          </Field>
          <Field label="المادة">
            <Select value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
              <option value="">كل المواد</option>
              {(stock.data ?? []).map((row) => <option key={row.materialId} value={row.materialId}>{row.name}</option>)}
            </Select>
          </Field>
        </Toolbar>
        <DataTable
          loading={movements.loading}
          rows={movements.items}
          rowKey={(row) => row.id}
          empty="لا توجد حركات"
          columns={[
            { key: 'date', header: 'التاريخ', render: (row) => fmtDateTime(row.createdAt) },
            { key: 'material', header: 'المادة', render: (row) => materialName.get(row.materialId) ?? `#${row.materialId}` },
            { key: 'kind', header: 'النوع', render: (row) => <Badge tone={KINDS[row.kind]?.tone ?? 'neutral'}>{KINDS[row.kind]?.label ?? row.kind}</Badge> },
            { key: 'qty', header: 'داخل / خارج', numeric: true, render: (row) => `${INCOMING_KINDS.has(row.kind) ? '+' : '−'}${fmtQty(row.qtyMicro)}` },
            ...(can(P.inventory.valuation) ? [{ key: 'cost', header: 'التكلفة الفعلية', numeric: true, render: (row: Movement) => fmtMoney(row.actualCostMinor ?? 0) }] : []),
            { key: 'balance', header: 'الرصيد بعد الحركة', numeric: true, render: (row) => row.balanceAfterMicro === null ? '—' : fmtQty(row.balanceAfterMicro) },
            { key: 'source', header: 'المصدر / المرجع', render: (row) => row.orderId ? `طلب #${row.orderId}` : row.sourceKind && row.sourceRefId ? `${row.sourceKind} #${row.sourceRefId}` : row.sourceKind ?? '—' },
            { key: 'reason', header: 'السبب', render: (row) => row.reason ?? '—' }
          ]}
        />
        <Pager pageIndex={movements.pageIndex} hasPrev={movements.hasPrev} hasNext={movements.hasNext} loading={movements.loading} onPrev={() => void movements.prev()} onNext={() => void movements.next()} />
      </Card>

      <Modal open={waste} title="تسجيل هالك" onClose={() => setWaste(false)}
        footer={<><Button variant="destructive" onClick={() => void submitWaste()}>تسجيل الهالك</Button><Button variant="secondary" onClick={() => setWaste(false)}>إلغاء</Button></>}>
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">الهالك خسارة تشغيلية عامة ولا يُحمَّل على أي طلب عميل. البواقي القابلة لإعادة الاستخدام ليست هالكاً.</p>
        <Field label="المادة" required>
          <Select value={form.materialId} onChange={(e) => setForm({ ...form, materialId: e.target.value })}>
            <option value="">— اختر —</option>
            {(stock.data ?? []).map((row) => <option key={row.materialId} value={row.materialId}>{row.name} ({fmtQty(row.qtyMicro, row.unit)})</option>)}
          </Select>
        </Field>
        <Field label="الكمية" required><Input type="number" step="0.001" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></Field>
        <Field label="السبب" required><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
      </Modal>

      <Modal open={adjust} title="تسوية مخزون" onClose={() => setAdjust(false)}
        footer={<><Button onClick={() => void submitAdjust()}>تسجيل التسوية</Button><Button variant="secondary" onClick={() => setAdjust(false)}>إلغاء</Button></>}>
        <ErrorNote>{error}</ErrorNote>
        <Field label="المادة" required>
          <Select value={form.materialId} onChange={(e) => setForm({ ...form, materialId: e.target.value })}>
            <option value="">— اختر —</option>
            {(stock.data ?? []).map((row) => <option key={row.materialId} value={row.materialId}>{row.name} ({fmtQty(row.qtyMicro, row.unit)})</option>)}
          </Select>
        </Field>
        <Field label="نوع التسوية" required>
          <Select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
            <option value="in">إضافة للمخزون</option>
            <option value="out">خصم من المخزون</option>
          </Select>
        </Field>
        <Field label="الكمية" required><Input type="number" step="0.001" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></Field>
        <Field label="سبب التسوية" required><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
      </Modal>
    </>
  )
}
