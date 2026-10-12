import { useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, Printer, FileDown } from 'lucide-react'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import {
  Badge, Card, DataTable, Field, Input, PageHeader, Pager, Select, Toolbar
} from '@renderer/components/ui'
import { fmtDateTime, fmtQty } from '@renderer/lib/format'
import { PRODUCTION_STATUS } from './ProductionOrderPage'
import { ManufacturingReversalButton } from '@renderer/components/orders/ManufacturingReversalButton'

interface WorkSheet {
  id: number; documentNumber: string; orderId: number | null; orderNumber: string | null
  orderArchivedAt: string | null
  productId: number | null; productName: string | null; quantityMicro: number
  status: string; statusLabel: string; issuedAt: string; startedAt: string | null
  completedAt: string | null; notes: string | null
}

/**
 * "أوامر التصنيع" — the production order register. Customer production
 * arrives here from a customer order. Historical stock worksheets stay visible;
 * new Standard stock production starts from the Product Components BOM tab.
 */
export function WorkSheetsPage(): ReactElement {
  const toast = useToast()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')

  const pageSize = 25
  const list = usePagedQuery<WorkSheet, { totalCount: number }>('production', 'listOperationalWorkSheets', {
    search,
    status: status || undefined
  }, { limit: pageSize })

  async function printDoc(id: number, mode: 'print' | 'exportPdf'): Promise<void> {
    try {
      const result = await call<{ path?: string }>('documents', mode, { kind: 'work_sheet', id })
      toast.show(mode === 'print' ? 'تم إرسال أمر التصنيع للطباعة' : `تم حفظ الملف: ${result.path}`, 'success')
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر إخراج المستند', 'error') }
  }

  return (
    <>
      <PageHeader
        title="أوامر التصنيع"
        subtitle="أوامر تصنيع طلبات العملاء؛ إنتاج المخزون القياسي من قائمة مكونات المنتج عبر صرف من المخزون"
      />
      <Card>
        <Toolbar>
          <Field label="بحث"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="رقم أمر التصنيع" /></Field>
          <Field label="الحالة">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">الكل</option>
              {Object.entries(PRODUCTION_STATUS).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}
            </Select>
          </Field>
        </Toolbar>
        <DataTable
          loading={list.loading}
          rows={list.items}
          rowKey={(row) => row.id}
          empty="لا توجد أوامر تصنيع"
          onRowClick={(row) => navigate(`/worksheets/${row.id}`)}
          columns={[
            { key: 'num', header: 'رقم الأمر', render: (row) => row.documentNumber },
            { key: 'target', header: 'الطلب / المنتج', render: (row) => row.orderNumber ?? (row.productName ? `${row.productName} (مخزون)` : '—') },
            { key: 'qty', header: 'الكمية', numeric: true, render: (row) => (row.quantityMicro ? fmtQty(row.quantityMicro) : '—') },
            { key: 'status', header: 'الحالة', render: (row) => <Badge tone={PRODUCTION_STATUS[row.status]?.tone ?? 'neutral'}>{PRODUCTION_STATUS[row.status]?.label ?? row.status}</Badge> },
            { key: 'at', header: 'تاريخ الإصدار', render: (row) => fmtDateTime(row.issuedAt) },
            { key: 'done', header: 'الاكتمال', render: (row) => (row.completedAt ? fmtDateTime(row.completedAt) : '—') },
            {
              key: 'actions', header: '', render: (row) => (
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="icon-btn" title="فتح أمر التصنيع" aria-label="فتح أمر التصنيع" onClick={() => navigate(`/worksheets/${row.id}`)}>
                    <Eye size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-btn" title="طباعة" aria-label="طباعة" onClick={() => void printDoc(row.id, 'print')}>
                    <Printer size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-btn" title="تصدير PDF" aria-label="تصدير PDF" onClick={() => void printDoc(row.id, 'exportPdf')}>
                    <FileDown size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                  {row.orderId && row.status !== 'reversed' && <ManufacturingReversalButton id={row.id} sheet={row} sourceOrderArchived={Boolean(row.orderArchivedAt)} onReversed={async () => { await list.reload() }} />}
                </div>
              )
            }
          ]}
        />
        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} totalCount={list.summary?.totalCount ?? 0} pageSize={pageSize} noun="أمر" />
      </Card>

    </>
  )
}
