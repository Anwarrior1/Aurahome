import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync('src/renderer/pages/employees/EmployeesPage.tsx', 'utf8')

describe('former employee settlement UI', () => {
  it('loads the backend-filtered outstanding queue instead of filtering all inactive employees locally', () => {
    expect(page).toContain("useQuery<Employee[]>('employees', 'listFormerSettlements'")
    expect(page).toContain('const formerRows = formerEmployees.data ?? []')
    expect(page).not.toContain("(formerEmployees.data ?? []).filter((employee) => !employee.active)")
  })

  it('shows statement and repayment controls on outstanding rows without a delete icon', () => {
    const table = page.slice(page.indexOf('rows={formerRows}'), page.indexOf('{settledFormerEmployee &&'))
    expect(table).toContain('>كشف</Button>')
    expect(table).toContain('>سداد سلفة قائمة</Button>')
    expect(table).not.toContain('<Trash2')
  })

  it('shows a compact delete icon only in the zero-balance settled transition and refreshes authoritative data', () => {
    expect(page).toContain('const refreshed = await call<Statement>')
    expect(page).toContain('refreshed.balanceMinor === 0')
    expect(page).toContain('await Promise.all([list.reload(), formerEmployees.reload(), advances.reload(), statement.reload()])')
    expect(page).toContain('settledFormerEmployee && (')
    expect(page).toContain('title="حذف" aria-label="حذف"')
    expect(page).toContain("call('employees', 'dismissFormerSettlement'")
  })
})
