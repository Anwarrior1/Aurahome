import { useState, type ReactElement } from 'react'
import { Pencil, Percent, PiggyBank, Trash2, TrendingUp } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, DataTable, ErrorNote, Field, Modal, PageHeader, Select, Stat } from '@renderer/components/ui'
import { fmtMoney, fmtDateTime, fmtPercent } from '@renderer/lib/format'
import { useSelectedDate } from '@renderer/state/selected-date.store'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { RATE_OPTIONS, isSavingsRateBp, parseSavingsRateDraft, savingsRateOptions, savingsRateLabel } from './savings-rate'

interface Overview {
  year: number
  month: number
  netProfitMinor: number
  savingsRateBp: number
  allocatedMinor: number
  confirmedMinor: number
  allocationConfirmed: boolean
  fundBalanceMinor: number
}
interface Allocation {
  id: number
  periodYear: number
  periodMonth: number
  netProfitMinor: number
  rateBp: number
  amountMinor: number
  confirmedAt: string
}
interface History {
  allocations: Allocation[]
  /** First bounded page only; the screen shows allocations and the fund balance. */
  transactions: {
    items: Array<{
      id: number
      kind: string
      amountMinor: number
      notes: string | null
      occurredAt: string
    }>
  }
  balanceMinor: number
}

export function SavingsPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const { selectedDateIso } = useSelectedDate()
  const [rateDraft, setRateDraft] = useState<string>()
  // Editing an approved allocation only ever changes its rate — the
  // amount is always re-derived server-side (netProfitMinor × rate),
  // and the period/net-profit it was confirmed against are frozen.
  const [allocationEditing, setAllocationEditing] = useState<{ id: number; rate: string; period: string } | undefined>()
  const [error, setError] = useState<string>()

  // الادخار follows the global operational date: net profit is a monthly
  // figure, so browsing to another day shows that day's month.
  const period = {
    year: Number(selectedDateIso.slice(0, 4)),
    month: Number(selectedDateIso.slice(5, 7))
  }
  const overview = useQuery<Overview>('profit', 'savingsOverview', period)
  const history = useQuery<History>('profit', 'savingsHistory')
  const data = overview.data
  const draftRateBp = parseSavingsRateDraft(rateDraft)

  async function saveRate(): Promise<void> {
    if (draftRateBp === undefined) return
    try {
      await call('profit', 'setSavingsRate', { rateBp: draftRateBp })
      toast.show('تم حفظ نسبة الادخار', 'success')
      setRateDraft(undefined)
      setError(undefined)
      await overview.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ النسبة')
    }
  }

  async function confirmAllocation(): Promise<void> {
    try {
      const result = await financialCall<{ amountMinor: number }>('profit', 'confirmAllocation', period, `profit.confirmAllocation:${period.year}:${period.month}`)
      toast.show(`تم اعتماد مخصص الادخار: ${fmtMoney(result.amountMinor)}`, 'success')
      await Promise.all([overview.reload(), history.reload()])
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر الاعتماد', 'error')
    }
  }

  /** Item 4: the server recalculates amountMinor = netProfitMinor × the
   *  new rate — never sent from here, so it can never disagree. */
  async function saveAllocation(): Promise<void> {
    if (!allocationEditing) return
    try {
      await call('profit', 'updateAllocation', {
        id: allocationEditing.id,
        rateBp: Number(allocationEditing.rate)
      })
      toast.show('تم تعديل المخصص وإعادة احتساب مبلغه', 'success')
      setAllocationEditing(undefined)
      setError(undefined)
      await Promise.all([overview.reload(), history.reload()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تعديل المخصص')
    }
  }

  /** One confirmation naming the exact allocation, then the paired
   *  savings_transactions row is removed with it — there is no cash
   *  movement to reverse (an allocation never posts one). */
  async function removeAllocation(row: Allocation): Promise<void> {
    if (!window.confirm(`هل تريد حذف مخصص الادخار عن ${row.periodMonth}/${row.periodYear} بمبلغ ${fmtMoney(row.amountMinor)}؟`)) return
    try {
      await call('profit', 'removeAllocation', { id: row.id })
      toast.show('تم حذف المخصص وتحديث رصيد صندوق الادخار', 'success')
      await Promise.all([overview.reload(), history.reload()])
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر حذف المخصص', 'error')
    }
  }

  return (
    <>
      <PageHeader
        title="الادخار"
        subtitle={`نسبة من صافي الربح تُحسب تلقائياً — الفترة ${period.month}/${period.year}`}
        actions={
          can(P.savings.manage) && (
            <>
              {!data?.allocationConfirmed && (data?.allocatedMinor ?? 0) > 0 && <Button onClick={() => void confirmAllocation()}>اعتماد مخصص هذه الفترة</Button>}
              <Button
                variant="secondary"
                disabled={overview.loading || !isSavingsRateBp(data?.savingsRateBp)}
                onClick={() => {
                  if (!isSavingsRateBp(data?.savingsRateBp)) return
                  setRateDraft(String(data.savingsRateBp))
                  setError(undefined)
                }}
              >
                تعديل نسبة الادخار
              </Button>
            </>
          )
        }
      />
      <ErrorNote>{overview.error ?? (data && !isSavingsRateBp(data.savingsRateBp) ? 'نسبة الادخار المحفوظة غير صالحة' : undefined)}</ErrorNote>

      {/* The whole section in three figures: profit × rate = savings. */}
      <div className="grid grid--3" style={{ marginBottom: 14 }}>
        <Stat
          label="صافي الربح"
          value={fmtMoney(data?.netProfitMinor ?? 0)}
          tone={(data?.netProfitMinor ?? 0) >= 0 ? 'success' : 'danger'}
          hint={`الفترة ${period.month}/${period.year}`}
          icon={<TrendingUp size={20} strokeWidth={2.25} />}
        />
        <Stat label="نسبة الادخار" value={fmtPercent(data?.savingsRateBp ?? 0)} icon={<Percent size={20} strokeWidth={2.25} />} />
        <Stat
          label="المبلغ المخصص للادخار"
          value={fmtMoney(data?.allocatedMinor ?? 0)}
          tone="brand"
          hint={data?.allocationConfirmed ? `معتمد — ${fmtMoney(data.confirmedMinor)}` : 'يُحسب تلقائياً ولا يُدخل يدوياً'}
          icon={<PiggyBank size={20} strokeWidth={2.25} />}
        />
      </div>

      <Card title="سجل المخصصات المعتمدة">
        <DataTable
          loading={history.loading}
          rows={history.data?.allocations ?? []}
          rowKey={(row) => row.id}
          empty="لا توجد مخصصات معتمدة بعد"
          columns={[
            {
              key: 'period',
              header: 'الشهر',
              render: (row) => `${row.periodMonth}/${row.periodYear}`
            },
            {
              key: 'profit',
              header: 'صافي الربح',
              numeric: true,
              render: (row) => fmtMoney(row.netProfitMinor)
            },
            {
              key: 'rate',
              header: 'النسبة',
              render: (row) => <Badge tone="info">{fmtPercent(row.rateBp)}</Badge>
            },
            {
              key: 'amount',
              header: 'المخصص',
              numeric: true,
              render: (row) => fmtMoney(row.amountMinor)
            },
            { key: 'at', header: 'تاريخ الاعتماد', render: (row) => fmtDateTime(row.confirmedAt) },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                can(P.savings.manage) ? (
                  <div className="row-actions">
                     <button
                       type="button"
                       className="icon-btn"
                       title="تعديل" aria-label="تعديل"
                      onClick={() => {
                        setAllocationEditing({
                          id: row.id,
                          rate: String(row.rateBp),
                          period: `${row.periodMonth}/${row.periodYear}`
                        })
                        setError(undefined)
                      }}
                    >
                      <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void removeAllocation(row)}>
                      <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </div>
                ) : null
            }
          ]}
        />
        <p className="muted" style={{ marginTop: 8 }}>
          تُحفظ النسبة المستخدمة مع كل مخصص، فتغيير النسبة لاحقاً لا يُعدّل المخصصات السابقة.
        </p>
      </Card>

      <Modal
        open={rateDraft !== undefined}
        title="نسبة الادخار"
        onClose={() => setRateDraft(undefined)}
        footer={
          <>
            <Button disabled={draftRateBp === undefined} onClick={() => void saveRate()}>حفظ</Button>
            <Button variant="secondary" onClick={() => setRateDraft(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">النسبة تُحفظ في إعدادات النظام وتبقى بعد إغلاق البرنامج وإعادة تشغيله.</p>
        <Field label="النسبة" required>
          <Select value={draftRateBp === undefined ? '' : String(draftRateBp)} onChange={(e) => setRateDraft(e.target.value)}>
            <option value="" disabled>اختر نسبة صحيحة</option>
            {savingsRateOptions(data?.savingsRateBp, draftRateBp).map((bp) => (
              <option key={bp} value={bp}>
                {savingsRateLabel(bp)}
              </option>
            ))}
          </Select>
        </Field>
        <p className="muted">المبلغ المخصص = صافي الربح × النسبة، ويُحسب تلقائياً لكل فترة.</p>
      </Modal>

      <Modal
        open={Boolean(allocationEditing)}
        title={`تعديل مخصص ${allocationEditing?.period ?? ''}`}
        onClose={() => setAllocationEditing(undefined)}
        footer={
          <>
            <Button onClick={() => void saveAllocation()}>حفظ</Button>
            <Button variant="secondary" onClick={() => setAllocationEditing(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">صافي ربح هذه الفترة محفوظ كما اعتُمد — لا يتغيّر. المبلغ المخصص يُعاد احتسابه تلقائياً حسب النسبة الجديدة.</p>
        <Field label="نسبة الادخار" required>
          <Select value={allocationEditing?.rate ?? ''} onChange={(e) => setAllocationEditing({ ...allocationEditing!, rate: e.target.value })}>
            {RATE_OPTIONS.map((bp) => (
              <option key={bp} value={bp}>
                {fmtPercent(bp)}
              </option>
            ))}
          </Select>
        </Field>
      </Modal>
    </>
  )
}
