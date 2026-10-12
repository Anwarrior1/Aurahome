import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const employeesPage = readFileSync('src/renderer/pages/employees/EmployeesPage.tsx', 'utf8')
const expensesPage = readFileSync('src/renderer/pages/expenses/ExpensesPage.tsx', 'utf8')

describe('payroll payment and reversal UI', () => {
  it('offers salary payment from authoritative remaining salary, including after a partial payment', () => {
    expect(employeesPage).toContain('(payrollById.get(row.id)?.remainingSalaryMinor ?? 0) > 0')
    expect(employeesPage).not.toContain('remainingSalaryMinor ?? row.monthlySalaryMinor')
    expect(employeesPage).toContain('الراتب المتبقي (د.ل)')
    expect(employeesPage).toContain('value={pay?.amount ?? \'\'} disabled')
  })

  it('uses one removal action and exposes former employees only for statements and settlement', () => {
    expect(employeesPage).toContain("{ search, activeOnly: true }")
    expect(employeesPage).toContain('الموظفون السابقون — السجلات والتسويات')
    expect(employeesPage).toContain('سداد سلفة قائمة')
    expect(employeesPage).toContain('اكتب اسم الموظف')
    expect(employeesPage).not.toContain('أرشفة الموظف')
    expect(employeesPage).not.toContain('حذف نهائي مع كل السجلات')
    expect(employeesPage).not.toContain("call('employees', 'fullDelete'")
  })

  it('shows payroll-owned payment history and a permission-gated reversal action', () => {
    expect(employeesPage).toContain('title="سجل صرف الرواتب"')
    expect(employeesPage).toContain("call('employees', 'reverseSalaryPayment'")
    expect(employeesPage).toContain('title="عكس صرف الراتب"')
    expect(employeesPage).toContain("row.status === 'posted' ? (")
    expect(employeesPage).toContain('هل تريد عكس صرف راتب')
    expect(employeesPage).toContain("call('employees', 'deleteSalaryPaymentHistory'")
    expect(employeesPage).toContain('title="حذف من سجل صرف الرواتب"')
    expect(employeesPage).toContain('لن يتغير الراتب أو المصروف أو الحساب المالي')
  })

  it('keeps salary-generated expenses read-only on the general Expenses page', () => {
    expect(expensesPage).toContain("row.source !== 'salary' && (")
    expect(expensesPage).toContain('row.reversedAt ? <Badge tone="neutral">معكوس</Badge>')
  })
})
