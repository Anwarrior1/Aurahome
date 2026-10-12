import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync('src/renderer/pages/workers/WorkersPage.tsx', 'utf8')

describe('Worker Financial Transaction UI', () => {
  it('offers only withdrawal and repayment in the new transaction dropdown', () => {
    const select = page.slice(page.indexOf('<Field label="نوع الحركة"'), page.indexOf('<Field label="المبلغ'))
    expect(select).toContain('<option value="withdrawal">سحب</option>')
    expect(select).toContain('<option value="repayment">إرجاع</option>')
    expect(select).not.toContain('value="adjustment"')
    expect(select).not.toContain('تسوية')
  })

  it('shows compact Pencil and Trash actions only when the backend marks the row manual', () => {
    expect(page).toContain("import { Pencil, Trash2 } from 'lucide-react'")
    expect(page).toContain("row.manual && can(P.workers.finance)")
    expect(page).toContain('className="icon-btn" title="تعديل" aria-label="تعديل"')
    expect(page).toContain('<Pencil size={15}')
    expect(page).toContain('className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف"')
    expect(page).toContain('<Trash2 size={15}')
  })

  it('fixes type during edit, confirms deletion, and refreshes statement and worker balance', () => {
    expect(page).toContain('<Select disabled={Boolean(tx?.id)}')
    expect(page).toContain("call('workers', 'updateTransaction'")
    expect(page).toContain("call('workers', 'deleteTransaction'")
    expect(page).toContain('window.confirm(')
    expect(page).toContain('Promise.all([list.reload(), statement.reload()])')
  })
})
