import { useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { Archive, ArchiveRestore, Eye, Printer, FileDown, Trash2 } from 'lucide-react'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorNote,
  Field,
  Input,
  Modal,
  PageHeader,
  Pager,
  Select,
  Toolbar
} from '@renderer/components/ui'
import { fmtMoney, fmtDate } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface Order {
  id: number
  documentNumber: string
  customerName: string
  status: string
  totalMinor: number
  depositRequiredMinor: number
  paidMinor: number
  remainingMinor: number
  canCancel: boolean
  canDeleteCancel: boolean
  canArchive: boolean
  paymentStatus: string
  requiresInstallation: boolean
  completedAt: string | null
  createdAt: string
}
interface FullDeletePreview {
  orderId: number
  documentNumber: string
  dependencies: Array<{ key: string; label: string; count: number }>
  blockers: string[]
}

export const PAYMENT_STATUS: Record<
  string,
  { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }
> = {
  unpaid: { label: 'غير مدفوع', tone: 'danger' },
  partial: { label: 'دفعة جزئية', tone: 'warning' },
  deposit_met: { label: 'المقدمة مكتملة', tone: 'info' },
  paid: { label: 'مدفوع بالكامل', tone: 'success' }
}
export const ORDER_STATUS: Record<
  string,
  { label: string; tone: 'neutral' | 'success' | 'danger' | 'info' }
> = {
  confirmed: { label: 'مؤكد', tone: 'info' },
  completed: { label: 'مكتمل', tone: 'success' },
  awaiting_approval: { label: 'بانتظار إعادة اعتماد الفاتورة', tone: 'info' },
  cancelled: { label: 'ملغى', tone: 'danger' }
}

export function OrdersPage(): ReactElement {
  const navigate = useNavigate()
  const { can } = useSession()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState(false)
  const pageSize = 50
  const [archivingId, setArchivingId] = useState<number>()
  const [status, setStatus] = useState('')
  const [paymentStatus, setPaymentStatus] = useState('')
  const [deleteDialog, setDeleteDialog] = useState<{
    row: Order
    preview: FullDeletePreview
    confirmation: string
    error?: string
  }>()
  const list = usePagedQuery<Order>('orders', 'list', {
    search,
    archived,
    status: status || undefined,
    paymentStatus: paymentStatus || undefined
  }, { limit: pageSize })

  async function archiveOrRestore(row: Order): Promise<void> {
    if (
      !window.confirm(
        archived
          ? `استعادة الطلب ${row.documentNumber} إلى القائمة النشطة؟`
          : `أرشفة الطلب ${row.documentNumber}؟ لن تتغير أي سجلات مالية أو مخزنية.`
      )
    )
      return
    setArchivingId(row.id)
    try {
      await call('orders', archived ? 'restore' : 'archive', { id: row.id })
      toast.show(archived ? 'تمت استعادة نفس الطلب' : 'تمت أرشفة الطلب دون تغيير تاريخه', 'success')
      await list.reload()
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر تغيير الأرشفة', 'error')
    } finally {
      setArchivingId(undefined)
    }
  }

  /**
   * The final invoice is its own issued document now (production
   * workflow, item 30): printing from the order list resolves the
   * invoice that was issued for it, and says so plainly when none has
   * been — the order alone is no longer a billable document.
   */
  async function printFinalInvoice(orderId: number, mode: 'print' | 'exportPdf'): Promise<void> {
    try {
      const { invoice } = await call<{ invoice: { id: number } | null }>(
        'finalInvoices',
        'forOrder',
        { orderId }
      )
      if (!invoice) {
        toast.show(
          'لم تُصدر فاتورة معتمدة لهذا الطلب بعد — أصدرها من صفحة الطلب أو من "الفواتير المعتمدة"',
          'error'
        )
        return
      }
      const result = await call<{ path?: string }>('documents', mode, {
        kind: 'final_invoice',
        id: invoice.id
      })
      toast.show(
        mode === 'print' ? 'تم إرسال الفاتورة المعتمدة للطباعة' : `تم حفظ الملف: ${result.path}`,
        'success'
      )
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر إخراج المستند', 'error')
    }
  }

  /** The Trash action is exclusively the privileged permanent-delete
   * workflow. Main supplies the dependency preview and revalidates every
   * guard plus the exact order number again when deletion is submitted. */
  async function removeOrder(row: Order): Promise<void> {
    if (!row.canDeleteCancel) return
    try {
      const preview = await call<FullDeletePreview>('orders', 'fullDeletePreview', { id: row.id })
      setDeleteDialog({ row, preview, confirmation: '' })
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر فحص الطلب', 'error')
    }
  }

  async function fullDeleteFromDialog(): Promise<void> {
    if (!deleteDialog) return
    if (deleteDialog.confirmation !== deleteDialog.row.documentNumber) {
      setDeleteDialog({
        ...deleteDialog,
        error: `اكتب رقم الطلب ${deleteDialog.row.documentNumber} للتأكيد النهائي`
      })
      return
    }
    try {
      await call('orders', 'fullDelete', {
        id: deleteDialog.row.id,
        confirmation: deleteDialog.confirmation
      })
      toast.show('تم حذف الطلب نهائياً وإرجاع آثاره', 'success')
      setDeleteDialog(undefined)
      await list.reload()
    } catch (err) {
      setDeleteDialog({
        ...deleteDialog,
        error: err instanceof ApiError ? err.message : 'تعذر حذف الطلب نهائياً'
      })
    }
  }

  return (
    <>
      <PageHeader
        title="طلبات العملاء"
        subtitle="الاتفاق التجاري المؤكد مع العميل، ونقطة تجهيز الإنتاج — يُنشأ باعتماد فاتورة معتمدة"
        actions={
          can(P.orders.manage) && (
            <Button onClick={() => navigate('/final-invoices')}>
              + طلب جديد (من فاتورة معتمدة)
            </Button>
          )
        }
      />
      <Card>
        <Toolbar>
          <Field label="عرض الطلبات">
            <Select
              value={archived ? 'archived' : 'active'}
              onChange={(e) => {
                setArchived(e.target.value === 'archived')
              }}
            >
              <option value="active">الطلبات النشطة</option>
              <option value="archived">الطلبات المؤرشفة</option>
            </Select>
          </Field>
          <Field label="بحث">
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
              }}
              placeholder="رقم الطلب أو العميل"
            />
          </Field>
          <Field label="حالة الطلب">
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
              }}
            >
              <option value="">الكل</option>
              {Object.entries(ORDER_STATUS).map(([value, info]) => (
                <option key={value} value={value}>
                  {info.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="حالة السداد">
            <Select
              value={paymentStatus}
              onChange={(e) => {
                setPaymentStatus(e.target.value)
              }}
            >
              <option value="">الكل</option>
              {Object.entries(PAYMENT_STATUS).map(([value, info]) => (
                <option key={value} value={value}>
                  {info.label}
                </option>
              ))}
            </Select>
          </Field>
        </Toolbar>
        <DataTable
          loading={list.loading}
          rows={list.items}
          rowKey={(row) => row.id}
          empty="لا توجد طلبات"
          onRowClick={(row) => navigate(`/orders/${row.id}`)}
          columns={[
            { key: 'num', header: 'رقم الطلب', render: (row) => row.documentNumber },
            { key: 'customer', header: 'العميل', render: (row) => row.customerName },
            { key: 'date', header: 'التاريخ', render: (row) => fmtDate(row.createdAt) },
            {
              key: 'total',
              header: 'الإجمالي',
              numeric: true,
              render: (row) => fmtMoney(row.totalMinor)
            },
            {
              key: 'deposit',
              header: 'المقدمة المطلوبة',
              numeric: true,
              render: (row) => fmtMoney(row.depositRequiredMinor)
            },
            {
              key: 'paid',
              header: 'المدفوع',
              numeric: true,
              render: (row) => fmtMoney(row.paidMinor)
            },
            {
              key: 'rem',
              header: 'المتبقي',
              numeric: true,
              render: (row) => fmtMoney(row.remainingMinor)
            },
            {
              key: 'pay',
              header: 'السداد',
              render: (row) => (
                <Badge tone={PAYMENT_STATUS[row.paymentStatus]?.tone ?? 'neutral'}>
                  {PAYMENT_STATUS[row.paymentStatus]?.label ?? row.paymentStatus}
                </Badge>
              )
            },
            {
              key: 'status',
              header: 'الحالة',
              render: (row) => (
                <Badge tone={ORDER_STATUS[row.status]?.tone ?? 'neutral'}>
                  {ORDER_STATUS[row.status]?.label ?? row.status}
                </Badge>
              )
            },
            {
              key: 'actions',
              header: 'الفاتورة المعتمدة',
              render: (row) => (
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="icon-btn"
                    title="عرض"
                    aria-label="عرض"
                    onClick={() => navigate(`/orders/${row.id}`)}
                  >
                    <Eye size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                  {can(P.orders.archive) && (archived || row.canArchive) && (
                    <button
                      type="button"
                      disabled={archivingId !== undefined}
                      className="icon-btn"
                      title={archived ? 'استعادة الطلب' : 'أرشفة الطلب'}
                      aria-label={archived ? 'استعادة الطلب' : 'أرشفة الطلب'}
                      onClick={() => void archiveOrRestore(row)}
                    >
                      {archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    title="طباعة الفاتورة المعتمدة"
                    aria-label="طباعة الفاتورة المعتمدة"
                    onClick={() => void printFinalInvoice(row.id, 'print')}
                  >
                    <Printer size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="تصدير PDF"
                    aria-label="تصدير PDF"
                    onClick={() => void printFinalInvoice(row.id, 'exportPdf')}
                  >
                    <FileDown size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                  {row.canDeleteCancel && can(P.orders.fullDelete) && (
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger"
                      title="حذف"
                      aria-label="حذف"
                      onClick={() => void removeOrder(row)}
                    >
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
        title="تأكيد حذف الطلب نهائياً"
        onClose={() => setDeleteDialog(undefined)}
        footer={
          <>
            <Button
              variant="destructive"
              disabled={
                Boolean(deleteDialog?.preview.blockers.length) ||
                deleteDialog?.confirmation !== deleteDialog?.row.documentNumber
              }
              onClick={() => void fullDeleteFromDialog()}
            >
              حذف الطلب نهائياً
            </Button>
            <Button variant="secondary" onClick={() => setDeleteDialog(undefined)}>
              إغلاق
            </Button>
          </>
        }
      >
        <ErrorNote>{deleteDialog?.error}</ErrorNote>
        <p>
          سيتم حذف طلب العميل {deleteDialog?.row.documentNumber ?? ''} نهائياً وفق ضوابط الحذف الآمن،
          مع إزالة السجلات التالية وإرجاع آثارها المالية والمخزنية حيث يسمح النظام. لا يمكن التراجع عن ذلك.
        </p>
        <ul>
          {(deleteDialog?.preview.dependencies ?? []).map((item) => (
            <li key={item.key}>
              {item.label}: {item.count}
            </li>
          ))}
        </ul>
        {(deleteDialog?.preview.blockers.length ?? 0) > 0 && (
          <div className="error-note">
            لا يمكن حذف الطلب نهائياً حالياً: {deleteDialog!.preview.blockers.join('، ')}
          </div>
        )}
        {deleteDialog && (
          <Field label={`اكتب رقم الطلب ${deleteDialog.row.documentNumber} للتأكيد`} required>
            <Input
              value={deleteDialog.confirmation}
              onChange={(e) =>
                setDeleteDialog({ ...deleteDialog, confirmation: e.target.value, error: undefined })
              }
            />
          </Field>
        )}
      </Modal>
    </>
  )
}
