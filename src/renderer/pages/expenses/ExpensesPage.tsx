import { useRef, useState, type ReactElement } from 'react'
import { CalendarClock, ClipboardList, Coins, Pencil, Receipt, Trash2 } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Pager, Select, Stat, Toolbar } from '@renderer/components/ui'
import { fmtMoney, fmtDate, fmtDateSlash } from '@renderer/lib/format'
import { useSelectedDate } from '@renderer/state/selected-date.store'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { SearchableOrderSelect } from '@renderer/components/orders/SearchableOrderSelect'

interface Expense {
  id: number
  categoryId: number | null
  categoryName: string | null
  kind: string
  amountMinor: number
  orderId: number | null
  cashAccountId: number | null
  description: string
  spentAt: string
  source: string
  reversedAt: string | null
}
interface Category {
  id: number
  name: string
  kind: string
  active: boolean
}
interface RecurringExpense {
  id: number
  categoryId: number | null
  categoryName: string | null
  description: string
  cashAccountId: number | null
  startDate: string
  endDate: string | null
  active: boolean
  currentAmountMinor: number
}
/**
 * The final spec's "Recurring Fixed Expenses" section shows BOTH
 * sources side by side — a manual definition (real recurring_expenses
 * row, fully editable) and, appended at render time only, one
 * system-derived payroll row for the selected month. Payroll never
 * becomes a row of `manual` — this type exists purely to let one
 * table render two different row shapes with source-appropriate
 * actions.
 */
/** Authoritative totals for a complete filtered expense set, from main. */
interface ExpenseSummary {
  totalCount: number
  linkedMinor: number
  fixedNonSalaryMinor: number
  variableMinor: number
}
type RecurringRow = { source: 'manual'; manual: RecurringExpense } | { source: 'payroll'; amountMinor: number }

export function ExpensesPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const { selectedDateIso } = useSelectedDate()
  const [filters, setFilters] = useState({ search: '', from: '', to: '', linkedOnly: false })
  // Expenses are a day journal by default; "مخصص" is the only mode
  // that reads filters.from/to — leaving it clears the custom range's
  // effect immediately, never silently applying it under another mode.
  const [rangeMode, setRangeMode] = useState<'day' | 'all' | 'custom'>('day')
  const [editing, setEditing] = useState<Record<string, string> | undefined>()
  const [category, setCategory] = useState<{ id?: number; name: string; kind: string } | undefined>()
  // The Fixed Expense DEFINITION (item 1/2) — created once, never
  // re-entered every month; its amount is edited separately below so
  // a later raise never rewrites a month already past.
  const [recurringEditing, setRecurringEditing] = useState<Record<string, string> | undefined>()
  const [amountEditing, setAmountEditing] = useState<{ id: number; amount: string; effectiveFrom: string } | undefined>()
  const [error, setError] = useState<string>()
  const [recurringDeleting, setRecurringDeleting] = useState<RecurringExpense>()
  const [reversing, setReversing] = useState(false)
  const reversalInFlight = useRef(false)

  const list = usePagedQuery<Expense, ExpenseSummary>('expenses', 'list', {
    search: filters.search || undefined,
    from: rangeMode === 'day' ? selectedDateIso : rangeMode === 'custom' ? filters.from || undefined : undefined,
    to: rangeMode === 'day' ? selectedDateIso : rangeMode === 'custom' ? filters.to || undefined : undefined,
    linkedOnly: filters.linkedOnly || undefined
  })
  const categories = useQuery<Category[]>('expenses', 'categories', {})
  const recurring = useQuery<RecurringExpense[]>('expenses', 'listRecurring', {})
  const accounts = useQuery<Array<{ id: number; name: string }>>('cash', 'accounts')

  const rows = list.items
  // The whole filtered range, never just the rows on this page.
  const linkedTotal = list.summary?.linkedMinor ?? 0

  // The summary cards below are always "this month" — the selected
  // operational date's month — independent of whatever day/range the
  // table above is currently browsing, exactly like the Dashboard's
  // own profit figures (same selectedDateIso → year/month convention).
  const year = Number(selectedDateIso.slice(0, 4))
  const month = Number(selectedDateIso.slice(5, 7))
  const daysInMonth = new Date(year, month, 0).getDate()
  const monthFrom = `${selectedDateIso.slice(0, 7)}-01`
  const monthTo = `${selectedDateIso.slice(0, 7)}-${String(daysInMonth).padStart(2, '0')}`
  const monthSummary = useQuery<ExpenseSummary>('expenses', 'summary', { from: monthFrom, to: monthTo })
  // Payroll is the authoritative payroll PERIOD total (item 4/6/20) —
  // never re-derived from the salary-tagged expenses rows below, which
  // are dated by payment day and stay only as that transaction's own
  // record. Gated by the same permission the Payroll module itself
  // requires, so this page never shows salary figures to someone who
  // isn't authorized to see them.
  const payroll = useQuery<Array<{ paidMinor: number }>>('employees', 'payroll', { year, month }, { enabled: can(P.employees.finance) })
  const payrollTotal = can(P.employees.finance) ? (payroll.data ?? []).reduce((s, r) => s + r.paidMinor, 0) : undefined

  // Item 8/9: Fixed = user-managed recurring/manual fixed expenses
  // (never the salary-tagged rows — those are payroll's own record,
  // not a second fixed expense) + the payroll period total above.
  const fixedNonPayrollTotal = monthSummary.data?.fixedNonSalaryMinor ?? 0
  const fixedTotal = fixedNonPayrollTotal + (payrollTotal ?? 0)
  const variableTotal = monthSummary.data?.variableMinor ?? 0
  const totalExpenses = fixedTotal + variableTotal

  // Items 1/3/21 (final spec): manual recurring definitions and the
  // payroll period total sit in ONE section/list — payroll is never a
  // row of `recurring_expenses` (item 6), only appended here for
  // display, and only when this session can actually see it.
  const combinedRecurringRows: RecurringRow[] = [
    ...(recurring.data ?? []).map((r): RecurringRow => ({ source: 'manual', manual: r })),
    ...(payrollTotal !== undefined ? [{ source: 'payroll' as const, amountMinor: payrollTotal }] : [])
  ]

  async function save(): Promise<void> {
    if (!editing?.description?.trim() || !Number(editing.amount)) {
      setError('البيان والمبلغ مطلوبان')
      return
    }
    try {
      const payload = {
        categoryId: editing.categoryId ? Number(editing.categoryId) : null,
        amountMinor: Math.round(Number(editing.amount) * 1000),
        orderId: editing.orderId ? Number(editing.orderId) : null,
        cashAccountId: editing.accountId ? Number(editing.accountId) : null,
        description: editing.description,
        spentAt: editing.spentAt || selectedDateIso
      }
      if (editing.id) await call('expenses', 'update', { id: Number(editing.id), ...payload })
      else
        await financialCall(
          'expenses',
          'create',
          {
            ...payload,
            categoryId: payload.categoryId ?? undefined,
            orderId: payload.orderId ?? undefined,
            cashAccountId: payload.cashAccountId ?? undefined
          },
          'expenses.create'
        )
      toast.show(editing.id ? 'تم تعديل المصروف وآثاره المالية' : 'تم تسجيل المصروف', 'success')
      setEditing(undefined)
      setError(undefined)
      await Promise.all([list.reload(), monthSummary.reload()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  /**
   * One confirmation, never a reason, for every expense in this list —
   * including a salary-generated one, which the server undoes together
   * with the payroll payment behind it rather than sending the user off
   * to the Employees screen.
   */
  async function removeExpense(row: Expense): Promise<void> {
    const question =
      row.source === 'salary'
        ? `هل أنت متأكد من حذف هذا المصروف؟\n\n«${row.description}» مصروف راتب — سيتم أيضاً التراجع عن صرف الراتب المرتبط به وإرجاع الأثر النقدي، وتُحدَّث مستحقات الموظف.`
        : `هل أنت متأكد من حذف هذا المصروف؟\n\n«${row.description}» — سيتم إرجاع أثره النقدي.`
    if (!window.confirm(question)) return
    try {
      const result = await call<{ salaryPaymentReversed: boolean }>('expenses', 'remove', {
        id: row.id
      })
      toast.show(result.salaryPaymentReversed ? 'تم حذف مصروف الراتب والتراجع عن صرف الراتب المرتبط به' : 'تم حذف المصروف وإزالة أثره النقدي', 'success')
      await Promise.all([list.reload(), monthSummary.reload()])
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر حذف المصروف', 'error')
    }
  }

  async function saveCategory(): Promise<void> {
    if (!category?.name.trim()) {
      setError('اسم التصنيف مطلوب')
      return
    }
    try {
      if (category.id)
        await call('expenses', 'updateCategory', {
          id: category.id,
          name: category.name,
          kind: category.kind
        })
      else await call('expenses', 'createCategory', { name: category.name, kind: category.kind })
      toast.show('تم حفظ التصنيف', 'success')
      setCategory(undefined)
      setError(undefined)
      await categories.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  /** Item 8: blocked with a clear message while expenses reference this category. */
  async function removeCategory(id: number): Promise<void> {
    if (!window.confirm('هل تريد حذف هذا التصنيف؟')) return
    try {
      await call('expenses', 'removeCategory', { id })
      toast.show('تم حذف التصنيف', 'success')
      await categories.reload()
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error')
    }
  }

  async function saveRecurring(): Promise<void> {
    if (!recurringEditing?.description?.trim()) {
      setError('بيان المصروف الثابت مطلوب')
      return
    }
    try {
      if (recurringEditing.id) {
        await call('expenses', 'updateRecurring', {
          id: Number(recurringEditing.id),
          categoryId: recurringEditing.categoryId ? Number(recurringEditing.categoryId) : null,
          description: recurringEditing.description,
          cashAccountId: recurringEditing.accountId ? Number(recurringEditing.accountId) : null,
          endDate: recurringEditing.endDate || null,
          active: recurringEditing.active !== 'false'
        })
      } else {
        if (!Number(recurringEditing.amount) || !recurringEditing.startDate) {
          setError('المبلغ وتاريخ البدء مطلوبان')
          return
        }
        await financialCall(
          'expenses',
          'createRecurring',
          {
            categoryId: recurringEditing.categoryId ? Number(recurringEditing.categoryId) : undefined,
            description: recurringEditing.description,
            amountMinor: Math.round(Number(recurringEditing.amount) * 1000),
            cashAccountId: recurringEditing.accountId ? Number(recurringEditing.accountId) : undefined,
            startDate: recurringEditing.startDate
          },
          'expenses.createRecurring'
        )
      }
      toast.show(recurringEditing.id ? 'تم تعديل المصروف الثابت' : 'تم إنشاء المصروف الثابت المتكرر', 'success')
      setRecurringEditing(undefined)
      setError(undefined)
      await Promise.all([recurring.reload(), list.reload(), monthSummary.reload()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  /** Item 14: appends a new effective-dated amount — never rewrites a
   *  month already past or already materialized. */
  async function saveAmount(): Promise<void> {
    if (!amountEditing || !Number(amountEditing.amount) || !amountEditing.effectiveFrom) {
      setError('المبلغ وتاريخ السريان مطلوبان')
      return
    }
    try {
      await call('expenses', 'changeRecurringAmount', {
        id: amountEditing.id,
        amountMinor: Math.round(Number(amountEditing.amount) * 1000),
        effectiveFrom: amountEditing.effectiveFrom
      })
      toast.show('يسري المبلغ الجديد من الشهر المحدد دون التأثير على الأشهر السابقة', 'success')
      setAmountEditing(undefined)
      setError(undefined)
      await Promise.all([recurring.reload(), list.reload(), monthSummary.reload()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  async function removeRecurring(): Promise<void> {
    if (!recurringDeleting || reversalInFlight.current) return
    reversalInFlight.current = true
    setReversing(true)
    setError(undefined)
    try {
      const result = await call<{ deleted: boolean; deactivated: boolean }>(
        'expenses',
        'removeRecurring',
        { id: recurringDeleting.id }
      )
      setRecurringDeleting(undefined)
      toast.show(
        result.deactivated
          ? 'تم إيقاف المصروف الشهري مع حفظ جميع الأشهر والآثار المالية السابقة'
          : 'تم حذف إعداد المصروف الشهري غير المستخدم',
        'success'
      )
      window.dispatchEvent(new Event('recurring-expense-reversed'))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر عكس المصروف الشهري')
      if (err instanceof ApiError && err.code === 'NOT_FOUND') await recurring.reload()
    } finally {
      reversalInFlight.current = false
      setReversing(false)
    }
  }

  return (
    <>
      <PageHeader
        title="المصروفات"
        subtitle="مصروفات ثابتة ومتغيرة — المرتبط منها بطلب يصبح تكلفة مباشرة على ذلك الطلب"
        actions={
          can(P.expenses.manage) && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setCategory({ name: '', kind: 'variable' })
                  setError(undefined)
                }}
              >
                إدارة التصنيفات
              </Button>
            </>
          )
        }
      />

      {/* Item 8/9: always this month (recurring fixed expenses + the
          payroll period total), regardless of the table's own day/range
          filter below. */}
      <div className="grid grid--4" style={{ marginBottom: 14 }}>
        <Stat
          label="مصروفات ثابتة"
          value={fmtMoney(fixedTotal)}
          hint={payrollTotal !== undefined ? `منها رواتب: ${fmtMoney(payrollTotal)}` : 'الرواتب غير معروضة — تحتاج صلاحية الرواتب'}
          icon={<CalendarClock size={20} strokeWidth={2.25} />}
        />
        <Stat label="مصروفات متغيرة" value={fmtMoney(variableTotal)} icon={<Receipt size={20} strokeWidth={2.25} />} />
        <Stat label="إجمالي المصروفات" value={fmtMoney(totalExpenses)} tone="brand" icon={<Coins size={20} strokeWidth={2.25} />} />
        <Stat label="مرتبطة بطلبات (تكلفة مباشرة)" value={fmtMoney(linkedTotal)} icon={<ClipboardList size={20} strokeWidth={2.25} />} />
      </div>

      <Card
        actions={
          can(P.expenses.manage) && (
            <Button
              onClick={() => {
                setEditing({ spentAt: selectedDateIso })
                setError(undefined)
              }}
            >
              + مصروف متغير
            </Button>
          )
        }
      >
        <Toolbar>
          <Field label="بحث">
            <Input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
          </Field>
          <Field label="النطاق">
            <Select value={rangeMode} onChange={(e) => setRangeMode(e.target.value as typeof rangeMode)}>
              <option value="day">مصروفات {fmtDateSlash(selectedDateIso)}</option>
              <option value="all">كل المصروفات</option>
              <option value="custom">مخصص</option>
            </Select>
          </Field>
          {rangeMode === 'custom' && (
            <>
              <Field label="من">
                <Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
              </Field>
              <Field label="إلى">
                <Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
              </Field>
            </>
          )}
        </Toolbar>
        <DataTable
          loading={list.loading}
          rows={rows}
          rowKey={(row) => row.id}
          empty="لا توجد مصروفات"
          columns={[
            { key: 'date', header: 'التاريخ', render: (row) => fmtDate(row.spentAt) },
            { key: 'desc', header: 'البيان', render: (row) => row.description },
            {
              key: 'kind',
              header: 'النوع',
              render: (row) => <Badge tone={row.kind === 'fixed' ? 'info' : 'neutral'}>{row.kind === 'fixed' ? 'ثابت' : 'متغير'}</Badge>
            },
            { key: 'cat', header: 'التصنيف', render: (row) => row.categoryName ?? '—' },
            {
              key: 'order',
              header: 'مرتبط بطلب',
              render: (row) => (row.orderId ? `#${row.orderId}` : '—')
            },
            {
              key: 'source',
              header: 'المصدر',
              render: (row) =>
                row.reversedAt ? <Badge tone="neutral">معكوس</Badge> : row.source === 'salary' ? <Badge tone="warning">راتب</Badge> : row.source === 'recurring' ? <Badge tone="info">ثابت متكرر</Badge> : 'يدوي'
            },
            {
              key: 'amount',
              header: 'المبلغ',
              numeric: true,
              render: (row) => fmtMoney(row.amountMinor)
            },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                can(P.expenses.manage) && !row.reversedAt ? (
                  <div className="row-actions">
                    {/* A salary expense is still not editable by hand (BR-109:
                      one salary, one expense row) — but it IS deletable here,
                      which reverses the payment behind it. A recurring
                      occurrence is neither: edit the Fixed Expense itself
                      below, and "delete" only ever means deactivating it —
                      the button stays visible so the server's message
                      explains why. */}
                    {row.source !== 'salary' && row.source !== 'recurring' && (
                      <button
                        type="button"
                        className="icon-btn"
                        title="تعديل" aria-label="تعديل"
                        onClick={() => {
                          setEditing({
                            id: String(row.id),
                            categoryId: row.categoryId ? String(row.categoryId) : '',
                            amount: String(row.amountMinor / 1000),
                            orderId: row.orderId ? String(row.orderId) : '',
                            accountId: row.cashAccountId ? String(row.cashAccountId) : '',
                            description: row.description,
                            spentAt: row.spentAt.slice(0, 10)
                          })
                          setError(undefined)
                        }}
                      >
                        <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                      </button>
                    )}
                    {row.source !== 'salary' && (
                      <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void removeExpense(row)}>
                        <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                ) : null
            }
          ]}
        />
        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} totalCount={list.summary?.totalCount} pageSize={50} noun="مصروف" />
      </Card>

      {/* Item 1/2/4: the Fixed Expense DEFINITION — set up once, and its
          monthly occurrence then appears automatically in the table
          above for every month it applies to, with no re-entry. */}
      <Card
        title="المصروفات الثابتة المتكررة"
        actions={
          can(P.expenses.manage) && (
            <Button
              size="sm"
              onClick={() => {
                setRecurringEditing({
                  description: '',
                  categoryId: '',
                  amount: '',
                  accountId: '',
                  startDate: selectedDateIso
                })
                setError(undefined)
              }}
            >
              + مصروف ثابت متكرر
            </Button>
          )
        }
      >
        <p className="muted" style={{ marginTop: 0 }}>
          مصروفات ثابتة متكررة تُنشأ مرة واحدة، إلى جانب الرواتب الشهرية من الموظفين والرواتب — تُعرض هنا تلقائياً للشهر المحدد ولا تُدار إلا من مصدرها الأصلي.
        </p>
        <DataTable
          loading={recurring.loading || payroll.loading}
          rows={combinedRecurringRows}
          rowKey={(row) => (row.source === 'payroll' ? 'payroll' : row.manual.id)}
          empty="لا توجد مصروفات ثابتة متكررة لهذا الشهر"
          columns={[
            {
              key: 'desc',
              header: 'البيان',
              render: (row) => (row.source === 'payroll' ? 'الرواتب' : row.manual.description)
            },
            {
              key: 'source',
              header: 'المصدر',
              render: (row) => (row.source === 'payroll' ? <Badge tone="warning">من الرواتب — تلقائي</Badge> : 'يدوي')
            },
            {
              key: 'cat',
              header: 'التصنيف',
              render: (row) => (row.source === 'payroll' ? '—' : (row.manual.categoryName ?? '—'))
            },
            {
              key: 'amount',
              header: 'المبلغ الحالي',
              numeric: true,
              render: (row) => fmtMoney(row.source === 'payroll' ? row.amountMinor : row.manual.currentAmountMinor)
            },
            {
              key: 'start',
              header: 'تاريخ البدء',
              render: (row) => (row.source === 'payroll' ? '—' : fmtDate(row.manual.startDate))
            },
            {
              key: 'end',
              header: 'تاريخ الانتهاء',
              render: (row) => (row.source === 'payroll' ? '—' : row.manual.endDate ? fmtDate(row.manual.endDate) : '—')
            },
            {
              key: 'active',
              header: 'الحالة',
              render: (row) => (row.source === 'payroll' ? '—' : <Badge tone={row.manual.active ? 'success' : 'neutral'}>{row.manual.active ? 'نشط' : 'موقوف'}</Badge>)
            },
            {
              key: 'actions',
              header: '',
              render: (row) => {
                // Items 3/5/15/22: payroll is read-only from Expenses —
                // no Edit/Delete of any kind, ever, regardless of
                // permission. Salary changes go through Employees/Payroll.
                if (row.source === 'payroll') return <span className="muted">للقراءة فقط</span>
                if (!can(P.expenses.manage)) return null
                const manual = row.manual
                return (
                  <div className="row-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setAmountEditing({
                          id: manual.id,
                          amount: String(manual.currentAmountMinor / 1000),
                          effectiveFrom: selectedDateIso
                        })
                        setError(undefined)
                      }}
                    >
                      تعديل المبلغ
                    </Button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="تعديل" aria-label="تعديل"
                      onClick={() => {
                        setRecurringEditing({
                          id: String(manual.id),
                          description: manual.description,
                          categoryId: manual.categoryId ? String(manual.categoryId) : '',
                          accountId: manual.cashAccountId ? String(manual.cashAccountId) : '',
                          endDate: manual.endDate ?? '',
                          active: String(manual.active)
                        })
                        setError(undefined)
                      }}
                    >
                      <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger"
                      title="حذف"
                      aria-label="حذف"
                      disabled={reversing}
                      onClick={() => {
                        setRecurringDeleting(manual)
                        setError(undefined)
                      }}
                    >
                      <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </div>
                )
              }
            }
          ]}
        />
        {payrollTotal === undefined && (
          <p className="muted" style={{ marginTop: 8, fontSize: 11.5 }}>
            الرواتب غير معروضة هنا — تحتاج صلاحية الرواتب لعرضها ضمن هذا القسم.
          </p>
        )}
      </Card>

      <Modal
        open={Boolean(recurringDeleting)}
        title="حذف وعكس المصروف الشهري"
        onClose={() => {
          if (!reversing) setRecurringDeleting(undefined)
        }}
        footer={
          <>
            <Button variant="destructive" disabled={reversing} onClick={() => void removeRecurring()}>
              تأكيد الحذف والعكس
            </Button>
            <Button variant="secondary" disabled={reversing} onClick={() => setRecurringDeleting(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p>
          هل تريد حذف المصروف الشهري #{recurringDeleting?.id} «{recurringDeleting?.description}»؟
        </p>
        <p>سيتم حذف المصروف الشهري وعكس جميع المصروفات والحركات المالية الناتجة عنه في كل الفترات السابقة والمستقبلية، واستعادة مبالغها في الحسابات المتأثرة. لن يُولَّد منه أي مصروف مستقبلاً، وسيُحفظ سجل التدقيق.</p>
      </Modal>

      <Modal
        open={Boolean(recurringEditing)}
        title={recurringEditing?.id ? 'تعديل المصروف الثابت' : 'مصروف ثابت متكرر جديد'}
        onClose={() => setRecurringEditing(undefined)}
        footer={
          <>
            <Button onClick={() => void saveRecurring()}>حفظ</Button>
            <Button variant="secondary" onClick={() => setRecurringEditing(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <Field label="البيان" required>
          <Input value={recurringEditing?.description ?? ''} onChange={(e) => setRecurringEditing({ ...recurringEditing!, description: e.target.value })} />
        </Field>
        <div className="grid grid--2">
          <Field label="التصنيف">
            <Select value={recurringEditing?.categoryId ?? ''} onChange={(e) => setRecurringEditing({ ...recurringEditing!, categoryId: e.target.value })}>
              <option value="">— بدون —</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="الحساب النقدي">
            <Select value={recurringEditing?.accountId ?? ''} onChange={(e) => setRecurringEditing({ ...recurringEditing!, accountId: e.target.value })}>
              <option value="">— بدون —</option>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {!recurringEditing?.id ? (
          <div className="grid grid--2">
            <Field label="المبلغ الشهري (د.ل)" required>
              <Input type="number" step="0.01" value={recurringEditing?.amount ?? ''} onChange={(e) => setRecurringEditing({ ...recurringEditing!, amount: e.target.value })} />
            </Field>
            <Field label="تاريخ البدء" required hint="يُطبَّق من أول ذلك الشهر">
              <Input type="date" value={recurringEditing?.startDate ?? ''} onChange={(e) => setRecurringEditing({ ...recurringEditing!, startDate: e.target.value })} />
            </Field>
          </div>
        ) : (
          <div className="grid grid--2">
            <Field label="تاريخ الانتهاء (اختياري)" hint="اتركه فارغاً لاستمراره">
              <Input type="date" value={recurringEditing?.endDate ?? ''} onChange={(e) => setRecurringEditing({ ...recurringEditing!, endDate: e.target.value })} />
            </Field>
            <Field label="الحالة">
              <Select value={recurringEditing?.active ?? 'true'} onChange={(e) => setRecurringEditing({ ...recurringEditing!, active: e.target.value })}>
                <option value="true">نشط</option>
                <option value="false">موقوف</option>
              </Select>
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(amountEditing)}
        title="تعديل مبلغ المصروف الثابت"
        onClose={() => setAmountEditing(undefined)}
        footer={
          <>
            <Button onClick={() => void saveAmount()}>حفظ</Button>
            <Button variant="secondary" onClick={() => setAmountEditing(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted" style={{ marginTop: 0 }}>
          يسري المبلغ الجديد من بداية الشهر المحدد فصاعداً فقط — الأشهر السابقة تبقى كما احتُسبت بالضبط.
        </p>
        <div className="grid grid--2">
          <Field label="المبلغ الجديد (د.ل)" required>
            <Input type="number" step="0.01" value={amountEditing?.amount ?? ''} onChange={(e) => setAmountEditing({ ...amountEditing!, amount: e.target.value })} />
          </Field>
          <Field label="يسري من شهر" required>
            <Input type="date" value={amountEditing?.effectiveFrom ?? ''} onChange={(e) => setAmountEditing({ ...amountEditing!, effectiveFrom: e.target.value })} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={Boolean(editing)}
        title={editing?.id ? 'تعديل المصروف' : 'مصروف جديد'}
        onClose={() => setEditing(undefined)}
        footer={
          <>
            <Button onClick={() => void save()}>حفظ</Button>
            <Button variant="secondary" onClick={() => setEditing(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <Field label="البيان" required>
          <Input value={editing?.description ?? ''} onChange={(e) => setEditing({ ...editing!, description: e.target.value })} />
        </Field>
        {/* Item 10 (final spec): "مصروف جديد" is variable-only now — no
            type selector. A recurring FIXED cost is defined once from
            "+ مصروف ثابت متكرر" below instead. */}
        <Field label="التصنيف">
          <Select value={editing?.categoryId ?? ''} onChange={(e) => setEditing({ ...editing!, categoryId: e.target.value })}>
            <option value="">— بدون —</option>
            {(categories.data ?? [])
              .filter((c) => c.kind === 'variable')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
        <div className="grid grid--2">
          <Field label="المبلغ (د.ل)" required>
            <Input type="number" step="0.01" value={editing?.amount ?? ''} onChange={(e) => setEditing({ ...editing!, amount: e.target.value })} />
          </Field>
          <Field label="التاريخ">
            <Input type="date" value={editing?.spentAt ?? ''} onChange={(e) => setEditing({ ...editing!, spentAt: e.target.value })} />
          </Field>
        </div>
        <Field label="ربط بطلب (اختياري)" hint="إذا رُبط بطلب يصبح تكلفة مباشرة عليه بدل مصروف عام">
          <SearchableOrderSelect
            orders={[]}
            serverSearch
            emptyLabel="— مصروف تشغيلي عام —"
            value={editing?.orderId ?? ''}
            onChange={(orderId) => setEditing({ ...editing!, orderId })}
            disabled={!can(P.orders.view)}
            selectedLabel={editing?.orderId ? `طلب مرتبط #${editing.orderId}` : undefined}
          />
        </Field>
        <Field label="الحساب النقدي">
          <Select value={editing?.accountId ?? ''} onChange={(e) => setEditing({ ...editing!, accountId: e.target.value })}>
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
        open={Boolean(category)}
        title="تصنيفات المصروفات"
        onClose={() => setCategory(undefined)}
        footer={
          <>
            <Button onClick={() => void saveCategory()}>حفظ التصنيف</Button>
            <Button variant="secondary" onClick={() => setCategory(undefined)}>
              إغلاق
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <div className="grid grid--2">
          <Field label="اسم التصنيف" required>
            <Input value={category?.name ?? ''} onChange={(e) => setCategory({ ...category!, name: e.target.value })} />
          </Field>
          <Field label="النوع" required>
            <Select value={category?.kind ?? 'variable'} onChange={(e) => setCategory({ ...category!, kind: e.target.value })}>
              <option value="fixed">ثابت</option>
              <option value="variable">متغير</option>
            </Select>
          </Field>
        </div>
        <DataTable
          rows={categories.data ?? []}
          rowKey={(row) => row.id}
          empty="لا توجد تصنيفات"
          columns={[
            { key: 'name', header: 'التصنيف', render: (row) => row.name },
            {
              key: 'kind',
              header: 'النوع',
              render: (row) => (row.kind === 'fixed' ? 'ثابت' : 'متغير')
            },
            {
              key: 'actions',
              header: '',
              render: (row) => (
                <div className="row-actions">
                  <Button variant="ghost" size="sm" onClick={() => setCategory({ id: row.id, name: row.name, kind: row.kind })}>
                    تعديل
                  </Button>
                  <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void removeCategory(row.id)}>
                    <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                </div>
              )
            }
          ]}
        />
      </Modal>
    </>
  )
}
