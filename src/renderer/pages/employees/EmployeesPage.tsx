import { useState, type ReactElement } from 'react'
import { Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import type { CursorPage } from '@shared/pagination/cursor-page'
import { call, financialCall, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, DataTable, ErrorNote, Field, Input, LoadMore, Modal, PageHeader, Pager, Select, Textarea, Toolbar } from '@renderer/components/ui'
import { fmtMoney, fmtDateTime } from '@renderer/lib/format'
import { useSelectedDate } from '@renderer/state/selected-date.store'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface Employee {
  id: number
  name: string
  position: string | null
  phone: string | null
  monthlySalaryMinor: number
  active: boolean
  notes: string | null
  balanceMinor: number
}
interface Payroll {
  employeeId: number
  name: string
  monthlySalaryMinor: number
  paidMinor: number
  deductionMinor: number
  advanceMinor: number
  remainingSalaryMinor: number
  status: 'paid' | 'partial' | 'unpaid'
}
interface Statement {
  employee: Employee
  balanceMinor: number
  salaryHistory: Array<{ id: number; monthlySalaryMinor: number; effectiveFrom: string }>
  transactions: CursorPage<StatementTransaction>
}
interface StatementTransaction {
  id: number
  kind: string
  amountMinor: number
  periodYear: number | null
  periodMonth: number | null
  notes: string | null
  createdAt: string
}
interface EmployeeDeletePreview {
  employeeId: number
  name: string
  dependencies: Array<{ key: string; label: string; count: number }>
  hasBusinessHistory: boolean
}
interface DeductionRow {
  id: number
  employeeId: number
  employeeName: string
  amountMinor: number
  periodYear: number
  periodMonth: number
  notes: string | null
  createdAt: string
}
interface AdvanceRow {
  id: number
  employeeId: number
  employeeName: string
  kind: 'advance' | 'repayment'
  amountMinor: number
  periodYear: number | null
  periodMonth: number | null
  notes: string | null
  createdAt: string
  recordedByName: string | null
}
interface SalaryPaymentRow {
  id: number
  employeeId: number
  employeeName: string
  amountMinor: number
  periodYear: number
  periodMonth: number
  paidAt: string
  cashAccountId: number | null
  cashAccountName: string | null
  expenseId: number | null
  status: 'posted' | 'reversed'
  reversedAt: string | null
  createdByName: string | null
  reversedByName: string | null
}

const TX: Record<string, string> = {
  salary_payment: 'صرف راتب',
  advance: 'سلفة',
  deduction: 'خصم',
  repayment: 'مرتجع سلفة'
}

/** Icon-only edit/delete actions for the two new history sections (item 7). */
function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }): ReactElement {
  return (
    <div className="row-actions">
      <button type="button" className="icon-btn" title="تعديل" aria-label="تعديل" onClick={onEdit}>
        <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
      </button>
      <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={onDelete}>
        <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
      </button>
    </div>
  )
}

export function EmployeesPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const { selectedDateIso } = useSelectedDate()
  const [search, setSearch] = useState('')
  // Payroll is a monthly concept, so the period follows the global
  // operational date: browsing to another day shows that day's month.
  const year = Number(selectedDateIso.slice(0, 4))
  const month = Number(selectedDateIso.slice(5, 7))

  const [editing, setEditing] = useState<{ id?: number; name: string; position: string; phone: string; salary: string; notes: string } | undefined>()
  const [pay, setPay] = useState<{ employeeId: number; name: string; amount: string; deduction: string; accountId: string } | undefined>()
  const [deduction, setDeduction] = useState<
    | {
        id?: number
        employeeId: number
        employeeName: string
        amount: string
        date: string
        year: number
        month: number
        notes: string
      }
    | undefined
  >()
  const [advance, setAdvance] = useState<
    | {
        id?: number
        employeeId: number
        employeeName: string
        kind: 'advance' | 'repayment'
        amount: string
        date: string
        accountId: string
        notes: string
      }
    | undefined
  >()
  const [reversingPayment, setReversingPayment] = useState<SalaryPaymentRow | undefined>()
  const [deletingPaymentHistory, setDeletingPaymentHistory] = useState<SalaryPaymentRow | undefined>()
  const [statementFor, setStatementFor] = useState<Employee | undefined>()
  const [settledFormerEmployee, setSettledFormerEmployee] = useState<Employee | undefined>()
  const [deleteDialog, setDeleteDialog] = useState<{
    row: Employee
    preview: EmployeeDeletePreview
    confirmation: string
    error?: string
  }>()
  const [error, setError] = useState<string>()

  const list = useQuery<Employee[]>('employees', 'list', { search, activeOnly: true })
  const formerEmployees = useQuery<Employee[]>('employees', 'listFormerSettlements', {}, { enabled: can(P.employees.finance) })
  const payroll = useQuery<Payroll[]>('employees', 'payroll', { year, month }, { enabled: can(P.employees.finance) })
  const deductions = usePagedQuery<DeductionRow>('employees', 'listDeductions', { year, month }, { enabled: can(P.employees.finance) })
  const advances = usePagedQuery<AdvanceRow>('employees', 'listAdvances', {}, { enabled: can(P.employees.finance) })
  const salaryPayments = usePagedQuery<SalaryPaymentRow>('employees', 'listSalaryPayments', { year, month }, { limit: 100, enabled: can(P.employees.finance) })
  const accounts = useQuery<Array<{ id: number; name: string }>>('cash', 'accounts')
  const statement = usePagedQuery<StatementTransaction, undefined, Statement>('employees', 'statement', { id: statementFor?.id ?? 0 }, { mode: 'append', enabled: Boolean(statementFor), pageOf: (response) => response.transactions })
  const payrollById = new Map(payroll.data?.map((row) => [row.employeeId, row]))
  const formerRows = formerEmployees.data ?? []
  const advanceOwner = advance ? ((list.data ?? []).find((employee) => employee.id === advance.employeeId) ?? formerRows.find((employee) => employee.id === advance.employeeId)) : undefined

  async function reloadPayrollData(): Promise<void> {
    await Promise.all([list.reload(), formerEmployees.reload(), payroll.reload(), deductions.reload(), advances.reload(), salaryPayments.reload(), accounts.reload()])
  }

  async function save(): Promise<void> {
    if (!editing?.name.trim()) {
      setError('اسم الموظف مطلوب')
      return
    }
    try {
      const payload = {
        name: editing.name,
        position: editing.position || undefined,
        phone: editing.phone || undefined,
        monthlySalaryMinor: Math.round(Number(editing.salary || 0) * 1000),
        notes: editing.notes || undefined
      }
      if (editing.id) await call('employees', 'update', { id: editing.id, ...payload })
      else await call('employees', 'create', payload)
      toast.show('تم حفظ بيانات الموظف', 'success')
      setEditing(undefined)
      setError(undefined)
      await reloadPayrollData()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  async function submitSalary(): Promise<void> {
    if (!pay) return
    try {
      await financialCall(
        'employees',
        'paySalary',
        {
          employeeId: pay.employeeId,
          amountMinor: Math.round(Number(pay.amount || 0) * 1000),
          periodYear: year,
          periodMonth: month,
          deductionMinor: pay.deduction ? Math.round(Number(pay.deduction) * 1000) : undefined,
          cashAccountId: pay.accountId ? Number(pay.accountId) : undefined
        },
        `employees.paySalary:${pay.employeeId}:${year}:${month}`
      )
      toast.show('تم صرف الراتب وتسجيله كمصروف ثابت للشهر', 'success')
      setPay(undefined)
      setError(undefined)
      await reloadPayrollData()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الصرف')
    }
  }

  async function reversePayment(): Promise<void> {
    if (!reversingPayment) return
    try {
      await call('employees', 'reverseSalaryPayment', { id: reversingPayment.id })
      toast.show('تم عكس صرف الراتب وإعادة أثره المالي', 'success')
      setReversingPayment(undefined)
      setError(undefined)
      await reloadPayrollData()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر عكس صرف الراتب')
    }
  }

  async function deletePaymentHistory(): Promise<void> {
    if (!deletingPaymentHistory) return
    try {
      await call('employees', 'deleteSalaryPaymentHistory', { id: deletingPaymentHistory.id })
      toast.show('تم حذف الصرف المعكوس من سجل صرف الرواتب', 'success')
      setDeletingPaymentHistory(undefined)
      setError(undefined)
      await salaryPayments.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حذف الصرف من السجل')
    }
  }

  // ---- خصم (deduction) — completely separate action from سلفة (advance) ----
  async function submitDeduction(): Promise<void> {
    if (!deduction) return
    try {
      const amountMinor = Math.round(Number(deduction.amount || 0) * 1000)
      if (deduction.id) {
        await call('employees', 'updateTransaction', {
          id: deduction.id,
          amountMinor,
          occurredAt: deduction.date,
          periodYear: deduction.year,
          periodMonth: deduction.month,
          notes: deduction.notes || undefined
        })
      } else {
        await financialCall(
          'employees',
          'transaction',
          {
            employeeId: deduction.employeeId,
            kind: 'deduction',
            amountMinor,
            occurredAt: deduction.date,
            periodYear: deduction.year,
            periodMonth: deduction.month,
            notes: deduction.notes || undefined
          },
          `employees.deduction:${deduction.employeeId}`
        )
      }
      toast.show('تم حفظ الخصم', 'success')
      setDeduction(undefined)
      setError(undefined)
      await reloadPayrollData()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  async function deleteDeduction(id: number): Promise<void> {
    try {
      await call('employees', 'deleteTransaction', { id })
      toast.show('تم حذف الخصم', 'success')
      await reloadPayrollData()
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error')
    }
  }

  // ---- سلفة / سداد سلفة (advance / repayment) — never mixed with خصم ----
  async function submitAdvance(): Promise<void> {
    if (!advance) return
    const settlingEmployee = advance.kind === 'repayment' && !advanceOwner?.active ? advanceOwner : undefined
    try {
      const amountMinor = Math.round(Number(advance.amount || 0) * 1000)
      if (advance.id) {
        await call('employees', 'updateTransaction', {
          id: advance.id,
          amountMinor,
          occurredAt: advance.date,
          cashAccountId: advance.accountId ? Number(advance.accountId) : undefined,
          notes: advance.notes || undefined
        })
      } else {
        await financialCall(
          'employees',
          'transaction',
          {
            employeeId: advance.employeeId,
            kind: advance.kind,
            amountMinor,
            occurredAt: advance.date,
            cashAccountId: advance.accountId ? Number(advance.accountId) : undefined,
            notes: advance.notes || undefined
          },
          `employees.${advance.kind}:${advance.employeeId}`
        )
      }
      if (settlingEmployee) {
        const refreshed = await call<Statement>('employees', 'statement', {
          id: settlingEmployee.id
        })
        setSettledFormerEmployee(refreshed.balanceMinor === 0 ? { ...settlingEmployee, balanceMinor: 0 } : undefined)
      }
      toast.show('تم حفظ السلفة', 'success')
      setAdvance(undefined)
      setError(undefined)
      await Promise.all([list.reload(), formerEmployees.reload(), advances.reload(), statement.reload()])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر الحفظ')
    }
  }

  async function dismissFormerSettlement(row: Employee): Promise<void> {
    if (!window.confirm(`إزالة «${row.name}» من حالة التسوية المكتملة؟\n\nستبقى جميع السجلات المالية والتاريخية محفوظة.`)) return
    try {
      await call('employees', 'dismissFormerSettlement', { id: row.id })
      setSettledFormerEmployee(undefined)
      toast.show('تمت إزالة حالة التسوية مع الاحتفاظ بجميع السجلات', 'success')
      await formerEmployees.reload()
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر إزالة حالة التسوية', 'error')
    }
  }

  async function deleteAdvance(id: number): Promise<void> {
    try {
      await call('employees', 'deleteTransaction', { id })
      toast.show('تم حذف الحركة', 'success')
      await Promise.all([list.reload(), advances.reload(), statement.reload()])
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error')
    }
  }

  /** Every removal uses the same typed-name lifecycle confirmation. */
  async function removeEmployee(row: Employee): Promise<void> {
    try {
      const preview = await call<EmployeeDeletePreview>('employees', 'deletePreview', {
        id: row.id
      })
      setDeleteDialog({ row, preview, confirmation: '' })
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error')
    }
  }

  async function confirmEmployeeRemoval(): Promise<void> {
    if (!deleteDialog) return
    if (deleteDialog.confirmation.trim() !== deleteDialog.row.name.trim()) {
      setDeleteDialog({
        ...deleteDialog,
        error: `اكتب اسم الموظف "${deleteDialog.row.name}" لتأكيد حذف الموظف`
      })
      return
    }
    try {
      const result = await call<{ physicallyDeleted: boolean; historyPreserved: boolean }>('employees', 'remove', {
        id: deleteDialog.row.id,
        confirmation: deleteDialog.confirmation
      })
      toast.show(result.physicallyDeleted ? 'تم حذف الموظف لعدم وجود سجلات مرتبطة به' : 'تم حذف الموظف من القائمة الحالية مع الحفاظ على جميع سجلاته المالية', 'success')
      setDeleteDialog(undefined)
      await reloadPayrollData()
    } catch (err) {
      setDeleteDialog({
        ...deleteDialog,
        error: err instanceof ApiError ? err.message : 'تعذر حذف الموظف'
      })
    }
  }

  return (
    <>
      <PageHeader
        title="الموظفون والرواتب"
        subtitle="موظفون بالراتب — منفصلون عن عمال الإنتاج. السلف والخصومات مفهومان منفصلان تماماً"
        actions={
          can(P.employees.manage) && (
            <Button
              onClick={() => {
                setEditing({ name: '', position: '', phone: '', salary: '', notes: '' })
                setError(undefined)
              }}
            >
              + موظف جديد
            </Button>
          )
        }
      />
      <Card>
        <Toolbar>
          <Field label="بحث">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          {/* The payroll period comes from the top-bar operational date —
              one global date state, not a second one on this page. */}
          <Field label="فترة الرواتب" hint="تتبع تاريخ العمل في الشريط العلوي">
            <Input value={`${month}/${year}`} disabled />
          </Field>
        </Toolbar>
        <DataTable
          loading={list.loading}
          rows={list.data ?? []}
          rowKey={(row) => row.id}
          empty="لا يوجد موظفون"
          columns={[
            { key: 'name', header: 'الموظف', render: (row) => row.name },
            { key: 'position', header: 'الوظيفة', render: (row) => row.position ?? '—' },
            {
              key: 'salary',
              header: 'الراتب الشهري',
              numeric: true,
              render: (row) => fmtMoney(row.monthlySalaryMinor)
            },
            {
              key: 'remaining',
              header: 'الراتب المتبقي',
              numeric: true,
              render: (row) => {
                const payrollRow = payrollById.get(row.id)
                return payrollRow ? fmtMoney(payrollRow.remainingSalaryMinor) : '—'
              }
            },
            {
              key: 'paid',
              header: 'المدفوع',
              numeric: true,
              render: (row) => {
                const payrollRow = payrollById.get(row.id)
                return payrollRow ? fmtMoney(payrollRow.paidMinor) : '—'
              }
            },
            {
              key: 'advances',
              header: 'السلف',
              numeric: true,
              render: (row) => fmtMoney(row.balanceMinor)
            },
            {
              key: 'deduction',
              header: 'الخصم',
              numeric: true,
              render: (row) => {
                const payrollRow = payrollById.get(row.id)
                return payrollRow ? fmtMoney(payrollRow.deductionMinor) : '—'
              }
            },
            {
              key: 'status',
              header: 'الحالة',
              render: (row) => {
                const status = payrollById.get(row.id)?.status
                if (!status) return <>—</>
                return <Badge tone={status === 'paid' ? 'success' : 'warning'}>{status === 'paid' ? 'مدفوع' : status === 'partial' ? 'مدفوع جزئياً' : 'غير مدفوع'}</Badge>
              }
            },
            {
              key: 'actions',
              header: '',
              render: (row) => (
                <div className="row-actions">
                  {can(P.employees.finance) && (payrollById.get(row.id)?.remainingSalaryMinor ?? 0) > 0 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const remaining = payrollById.get(row.id)!.remainingSalaryMinor
                        setPay({
                          employeeId: row.id,
                          name: row.name,
                          amount: String(remaining / 1000),
                          deduction: '',
                          accountId: ''
                        })
                        setError(undefined)
                      }}
                    >
                      صرف راتب
                    </Button>
                  )}
                  {can(P.employees.finance) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDeduction({
                          employeeId: row.id,
                          employeeName: row.name,
                          amount: '',
                          date: selectedDateIso,
                          year,
                          month,
                          notes: ''
                        })
                        setError(undefined)
                      }}
                    >
                      خصم
                    </Button>
                  )}
                  {can(P.employees.finance) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setAdvance({
                          employeeId: row.id,
                          employeeName: row.name,
                          kind: 'advance',
                          amount: '',
                          date: selectedDateIso,
                          accountId: '',
                          notes: ''
                        })
                        setError(undefined)
                      }}
                    >
                      سلفة
                    </Button>
                  )}
                  {can(P.employees.finance) && row.balanceMinor > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setAdvance({
                          employeeId: row.id,
                          employeeName: row.name,
                          kind: 'repayment',
                          amount: '',
                          date: selectedDateIso,
                          accountId: '',
                          notes: ''
                        })
                        setError(undefined)
                      }}
                    >
                      مرتجع سلفة
                    </Button>
                  )}
                  {can(P.employees.finance) && (
                    <Button variant="ghost" size="sm" onClick={() => setStatementFor(row)}>كشف</Button>
                  )}
                  {can(P.employees.manage) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing({
                          id: row.id,
                          name: row.name,
                          position: row.position ?? '',
                          phone: row.phone ?? '',
                          salary: String(row.monthlySalaryMinor / 1000),
                          notes: row.notes ?? ''
                        })
                        setError(undefined)
                      }}
                    >
                      تعديل
                    </Button>
                  )}
                  {can(P.employees.manage) && (
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف الموظف" aria-label="حذف الموظف" onClick={() => void removeEmployee(row)}>
                      <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )
            }
          ]}
        />
      </Card>

      {can(P.employees.finance) && (
        <Card title="الموظفون السابقون — السجلات والتسويات">
          <p className="muted">للعرض وتسوية السلف القائمة فقط. لا يمكن إنشاء راتب أو خصم أو سلفة جديدة لموظف سابق.</p>
          <DataTable
            loading={formerEmployees.loading}
            rows={formerRows}
            rowKey={(row) => row.id}
            empty="لا يوجد موظفون سابقون"
            columns={[
              { key: 'name', header: 'الموظف', render: (row) => row.name },
              { key: 'position', header: 'الوظيفة', render: (row) => row.position ?? '—' },
              {
                key: 'outstanding',
                header: 'السلفة القائمة',
                numeric: true,
                render: (row) => fmtMoney(row.balanceMinor)
              },
              {
                key: 'actions',
                header: '',
                render: (row) => (
                  <div className="row-actions">
                    <Button variant="ghost" size="sm" onClick={() => setStatementFor(row)}>كشف</Button>
                    {row.balanceMinor > 0 && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setAdvance({
                            employeeId: row.id,
                            employeeName: row.name,
                            kind: 'repayment',
                            amount: '',
                            date: selectedDateIso,
                            accountId: '',
                            notes: ''
                          })
                          setError(undefined)
                        }}
                      >سداد سلفة قائمة</Button>
                    )}
                  </div>
                )
              }
            ]}
          />
          {settledFormerEmployee && (
            <div className="row-actions" style={{ marginTop: 10 }}>
              <span>{settledFormerEmployee.name} — تم سداد السلفة بالكامل</span>
              {can(P.employees.manage) && (
                <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void dismissFormerSettlement(settledFormerEmployee)}>
                  <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </Card>
      )}

      <Card title="سجل صرف الرواتب">
        <DataTable
          loading={salaryPayments.loading}
          rows={salaryPayments.items}
          rowKey={(row) => row.id}
          empty={`لا توجد رواتب مصروفة لشهر ${month}/${year}`}
          columns={[
            { key: 'employee', header: 'الموظف', render: (row) => row.employeeName },
            {
              key: 'period',
              header: 'الشهر/السنة',
              render: (row) => `${row.periodMonth}/${row.periodYear}`
            },
            {
              key: 'amount',
              header: 'المبلغ المدفوع',
              numeric: true,
              render: (row) => fmtMoney(row.amountMinor)
            },
            { key: 'date', header: 'تاريخ الصرف', render: (row) => fmtDateTime(row.paidAt) },
            { key: 'account', header: 'الحساب', render: (row) => row.cashAccountName ?? '—' },
            { key: 'user', header: 'المستخدم', render: (row) => row.createdByName ?? '—' },
            {
              key: 'status',
              header: 'الحالة',
              render: (row) => <Badge tone={row.status === 'posted' ? 'success' : 'neutral'}>{row.status === 'posted' ? 'مصروف' : 'معكوس'}</Badge>
            },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                can(P.employees.finance) ? (
                  row.status === 'posted' ? (
                    <button
                      type="button"
                      className="icon-btn"
                      title="عكس صرف الراتب"
                      aria-label="عكس صرف الراتب"
                      onClick={() => {
                        setReversingPayment(row)
                        setError(undefined)
                      }}
                    >
                      <RotateCcw size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger"
                      title="حذف من سجل صرف الرواتب"
                      aria-label="حذف من سجل صرف الرواتب"
                      onClick={() => {
                        setDeletingPaymentHistory(row)
                        setError(undefined)
                      }}
                    >
                      <Trash2 size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  )
                ) : null
            }
          ]}
        />
        <Pager pageIndex={salaryPayments.pageIndex} hasPrev={salaryPayments.hasPrev} hasNext={salaryPayments.hasNext} loading={salaryPayments.loading} onPrev={() => void salaryPayments.prev()} onNext={() => void salaryPayments.next()} />
      </Card>

      <Card title="سجل الخصومات">
        <DataTable
          loading={deductions.loading}
          rows={deductions.items}
          rowKey={(row) => row.id}
          empty={`لا توجد خصومات مسجّلة لشهر ${month}/${year}`}
          columns={[
            { key: 'employee', header: 'الموظف', render: (row) => row.employeeName },
            {
              key: 'amount',
              header: 'المبلغ',
              numeric: true,
              render: (row) => fmtMoney(row.amountMinor)
            },
            {
              key: 'period',
              header: 'الشهر/السنة',
              render: (row) => `${row.periodMonth}/${row.periodYear}`
            },
            { key: 'date', header: 'التاريخ', render: (row) => fmtDateTime(row.createdAt) },
            { key: 'notes', header: 'ملاحظات', render: (row) => row.notes ?? '—' },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                can(P.employees.finance) ? (
                  <RowActions
                    onEdit={() => {
                      setDeduction({
                        id: row.id,
                        employeeId: row.employeeId,
                        employeeName: row.employeeName,
                        amount: String(row.amountMinor / 1000),
                        date: row.createdAt.slice(0, 10),
                        year: row.periodYear,
                        month: row.periodMonth,
                        notes: row.notes ?? ''
                      })
                      setError(undefined)
                    }}
                    onDelete={() => void deleteDeduction(row.id)}
                  />
                ) : null
            }
          ]}
        />
        <Pager pageIndex={deductions.pageIndex} hasPrev={deductions.hasPrev} hasNext={deductions.hasNext} loading={deductions.loading} onPrev={() => void deductions.prev()} onNext={() => void deductions.next()} />
      </Card>

      <Card title="سجل السلف">
        <DataTable
          loading={advances.loading}
          rows={advances.items}
          rowKey={(row) => row.id}
          empty="لا توجد سلف مسجّلة"
          columns={[
            { key: 'employee', header: 'الموظف', render: (row) => row.employeeName },
            {
              key: 'kind',
              header: 'النوع',
              render: (row) => <Badge tone={row.kind === 'advance' ? 'warning' : 'info'}>{row.kind === 'advance' ? 'سلفة' : 'مرتجع سلفة'}</Badge>
            },
            {
              key: 'amount',
              header: 'المبلغ',
              numeric: true,
              render: (row) => fmtMoney(row.amountMinor)
            },
            { key: 'date', header: 'التاريخ', render: (row) => fmtDateTime(row.createdAt) },
            {
              key: 'period',
              header: 'الشهر/السنة',
              render: (row) => (row.periodMonth ? `${row.periodMonth}/${row.periodYear}` : '—')
            },
            { key: 'notes', header: 'ملاحظات', render: (row) => row.notes ?? '—' },
            { key: 'recordedBy', header: 'المستخدم', render: (row) => row.recordedByName ?? '—' },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                can(P.employees.finance) ? (
                  <RowActions
                    onEdit={() => {
                      setAdvance({
                        id: row.id,
                        employeeId: row.employeeId,
                        employeeName: row.employeeName,
                        kind: row.kind,
                        amount: String(row.amountMinor / 1000),
                        date: row.createdAt.slice(0, 10),
                        accountId: '',
                        notes: row.notes ?? ''
                      })
                      setError(undefined)
                    }}
                    onDelete={() => void deleteAdvance(row.id)}
                  />
                ) : null
            }
          ]}
        />
        <Pager pageIndex={advances.pageIndex} hasPrev={advances.hasPrev} hasNext={advances.hasNext} loading={advances.loading} onPrev={() => void advances.prev()} onNext={() => void advances.next()} />
      </Card>

      <Modal
        open={Boolean(deleteDialog)}
        title={`حذف الموظف: ${deleteDialog?.row.name ?? ''}`}
        onClose={() => setDeleteDialog(undefined)}
        footer={
          <>
            <Button variant="destructive" disabled={deleteDialog?.confirmation.trim() !== deleteDialog?.row.name.trim()} onClick={() => void confirmEmployeeRemoval()}>
              حذف الموظف
            </Button>
            <Button variant="secondary" onClick={() => setDeleteDialog(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{deleteDialog?.error}</ErrorNote>
        {deleteDialog?.preview.hasBusinessHistory ? (
          <>
            <p>سيُحذف الموظف من قائمة الموظفين الحاليين فقط. ستبقى جميع سجلات الرواتب والخصومات والسلف والمصروفات والحركات النقدية السابقة محفوظة كما هي، ويمكن لاحقاً تسوية الأرصدة التاريخية القائمة.</p>
            <ul>
              {(deleteDialog.preview.dependencies ?? []).map((item) => (
                <li key={item.key}>
                  {item.label}: {item.count}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>لا توجد سجلات أعمال أو سجلات مالية مرتبطة بهذا الموظف، لذلك سيُحذف سجل الموظف نفسه بأمان.</p>
        )}
        <Field label={`اكتب اسم الموظف "${deleteDialog?.row.name ?? ''}" لتأكيد حذف الموظف`} required>
          <Input value={deleteDialog?.confirmation ?? ''} onChange={(e) => setDeleteDialog(deleteDialog ? { ...deleteDialog, confirmation: e.target.value, error: undefined } : undefined)} />
        </Field>
      </Modal>

      <Modal
        open={Boolean(editing)}
        title={editing?.id ? 'تعديل موظف' : 'موظف جديد'}
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
        <Field label="اسم الموظف" required>
          <Input value={editing?.name ?? ''} onChange={(e) => setEditing({ ...editing!, name: e.target.value })} />
        </Field>
        <Field label="الوظيفة">
          <Input value={editing?.position ?? ''} onChange={(e) => setEditing({ ...editing!, position: e.target.value })} />
        </Field>
        <Field label="رقم الهاتف">
          <Input value={editing?.phone ?? ''} onChange={(e) => setEditing({ ...editing!, phone: e.target.value })} />
        </Field>
        <Field label="الراتب الشهري (د.ل)" required hint="تغيير الراتب يُحفظ في السجل التاريخي">
          <Input type="number" step="0.01" value={editing?.salary ?? ''} onChange={(e) => setEditing({ ...editing!, salary: e.target.value })} />
        </Field>
        <Field label="ملاحظات">
          <Textarea value={editing?.notes ?? ''} onChange={(e) => setEditing({ ...editing!, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={Boolean(pay)}
        title={`صرف راتب: ${pay?.name ?? ''} — ${month}/${year}`}
        onClose={() => setPay(undefined)}
        footer={
          <>
            <Button disabled={Number(pay?.amount ?? 0) - Number(pay?.deduction ?? 0) <= 0} onClick={() => void submitSalary()}>
              صرف الراتب
            </Button>
            <Button variant="secondary" onClick={() => setPay(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">يُصرف الراتب المتبقي لهذه الفترة فقط، ويُسجَّل المصروف والحركة النقدية بالمبلغ الفعلي.</p>
        <Field label="الراتب المتبقي (د.ل)" required>
          <Input type="number" step="0.01" value={pay?.amount ?? ''} disabled />
        </Field>
        <Field label="خصم إضافي عند الصرف (د.ل)" hint="اختياري — بالإضافة لأي خصومات مسجّلة مسبقاً لهذا الشهر">
          <Input type="number" step="0.01" value={pay?.deduction ?? ''} onChange={(e) => setPay({ ...pay!, deduction: e.target.value })} />
        </Field>
        <p>
          <strong>المبلغ الفعلي للصرف: {fmtMoney(Math.max(Math.round((Number(pay?.amount ?? 0) - Number(pay?.deduction ?? 0)) * 1000), 0))}</strong>
        </p>
        <Field label="الحساب النقدي" hint="يُصرف الصافي بعد الخصم">
          <Select value={pay?.accountId ?? ''} onChange={(e) => setPay({ ...pay!, accountId: e.target.value })}>
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
        open={Boolean(reversingPayment)}
        title="عكس صرف الراتب"
        onClose={() => setReversingPayment(undefined)}
        footer={
          <>
            <Button variant="destructive" onClick={() => void reversePayment()}>
              تأكيد العكس
            </Button>
            <Button variant="secondary" onClick={() => setReversingPayment(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p>
          هل تريد عكس صرف راتب «{reversingPayment?.employeeName ?? ''}» بقيمة {fmtMoney(reversingPayment?.amountMinor ?? 0)}؟ سيتم عكس أثر الصرف المالي وإعادة المبلغ إلى الراتب المتبقي.
        </p>
      </Modal>

      <Modal
        open={Boolean(deletingPaymentHistory)}
        title="حذف من سجل صرف الرواتب"
        onClose={() => setDeletingPaymentHistory(undefined)}
        footer={
          <>
            <Button variant="destructive" onClick={() => void deletePaymentHistory()}>
              حذف من السجل
            </Button>
            <Button variant="secondary" onClick={() => setDeletingPaymentHistory(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p>
          هل تريد حذف صرف راتب «{deletingPaymentHistory?.employeeName ?? ''}» المعكوس بقيمة {fmtMoney(deletingPaymentHistory?.amountMinor ?? 0)} من السجل الظاهر؟ لن يتغير الراتب أو المصروف أو الحساب المالي، وسيبقى سجل
          التدقيق محفوظاً.
        </p>
      </Modal>

      {/* خصم — completely independent from سلفة (item 2/4) */}
      <Modal
        open={Boolean(deduction)}
        title={`${deduction?.id ? 'تعديل خصم' : 'خصم جديد'}: ${deduction?.employeeName ?? ''}`}
        onClose={() => setDeduction(undefined)}
        footer={
          <>
            <Button onClick={() => void submitDeduction()}>حفظ</Button>
            <Button variant="secondary" onClick={() => setDeduction(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <p className="muted">الخصم يُنقص من راتب الشهر المحدد فقط، ولا علاقة له بالسلف.</p>
        <Field label="المبلغ (د.ل)" required>
          <Input type="number" step="0.01" value={deduction?.amount ?? ''} onChange={(e) => setDeduction({ ...deduction!, amount: e.target.value })} />
        </Field>
        <div className="grid grid--2">
          <Field label="السنة" required>
            <Input type="number" value={deduction?.year ?? year} onChange={(e) => setDeduction({ ...deduction!, year: Number(e.target.value) })} />
          </Field>
          <Field label="الشهر" required>
            <Select value={deduction?.month ?? month} onChange={(e) => setDeduction({ ...deduction!, month: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="التاريخ">
          <Input type="date" value={deduction?.date ?? ''} onChange={(e) => setDeduction({ ...deduction!, date: e.target.value })} />
        </Field>
        <Field label="السبب / ملاحظات">
          <Textarea value={deduction?.notes ?? ''} onChange={(e) => setDeduction({ ...deduction!, notes: e.target.value })} />
        </Field>
      </Modal>

      {/* سلفة / مرتجع سلفة — completely independent from خصم (item 5) */}
      <Modal
        open={Boolean(advance)}
        title={`${advance?.id ? 'تعديل حركة سلفة' : advance?.kind === 'repayment' ? 'مرتجع سلفة جديد' : 'سلفة جديدة'}: ${advance?.employeeName ?? ''}`}
        onClose={() => setAdvance(undefined)}
        footer={
          <>
            <Button onClick={() => void submitAdvance()}>حفظ</Button>
            <Button variant="secondary" onClick={() => setAdvance(undefined)}>
              إلغاء
            </Button>
          </>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        {advance && !advance.id && <p className="muted">السلفة القائمة الحالية على هذا الموظف: {advanceOwner ? fmtMoney(advanceOwner.balanceMinor) : '—'}</p>}
        <Field label="النوع" required>
          <Select value={advance?.kind ?? 'advance'} onChange={(e) => setAdvance({ ...advance!, kind: e.target.value as 'advance' | 'repayment' })} disabled={Boolean(advance?.id) || advanceOwner?.active === false}>
            {advanceOwner?.active !== false && <option value="advance">سلفة</option>}
            <option value="repayment">مرتجع سلفة</option>
          </Select>
        </Field>
        <Field label="المبلغ (د.ل)" required>
          <Input type="number" step="0.01" value={advance?.amount ?? ''} onChange={(e) => setAdvance({ ...advance!, amount: e.target.value })} />
        </Field>
        <Field label="التاريخ">
          <Input type="date" value={advance?.date ?? ''} onChange={(e) => setAdvance({ ...advance!, date: e.target.value })} />
        </Field>
        <Field label="الحساب النقدي">
          <Select value={advance?.accountId ?? ''} onChange={(e) => setAdvance({ ...advance!, accountId: e.target.value })}>
            <option value="">— بدون —</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ملاحظات">
          <Input value={advance?.notes ?? ''} onChange={(e) => setAdvance({ ...advance!, notes: e.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={Boolean(statementFor)}
        wide
        title={`كشف حساب: ${statementFor?.name ?? ''}`}
        onClose={() => setStatementFor(undefined)}
        footer={
          <Button variant="secondary" onClick={() => setStatementFor(undefined)}>
            إغلاق
          </Button>
        }
      >
        <p>
          <strong>سلف قائمة: {fmtMoney(statement.response?.balanceMinor ?? 0)}</strong>
        </p>
        <DataTable
          loading={statement.loading && statement.items.length === 0}
          rows={statement.items}
          rowKey={(row) => row.id}
          empty="لا توجد حركات"
          columns={[
            { key: 'date', header: 'التاريخ', render: (row) => fmtDateTime(row.createdAt) },
            { key: 'kind', header: 'النوع', render: (row) => TX[row.kind] ?? row.kind },
            {
              key: 'period',
              header: 'الفترة',
              render: (row) => (row.periodMonth ? `${row.periodMonth}/${row.periodYear}` : '—')
            },
            {
              key: 'amount',
              header: 'المبلغ',
              numeric: true,
              render: (row) => fmtMoney(row.amountMinor)
            },
            { key: 'notes', header: 'ملاحظات', render: (row) => row.notes ?? '—' }
          ]}
        />
        <LoadMore hasNext={statement.hasNext} loading={statement.loading} onClick={() => void statement.next()} />
      </Modal>
    </>
  )
}
