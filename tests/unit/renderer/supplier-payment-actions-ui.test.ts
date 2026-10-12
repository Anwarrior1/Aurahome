import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const page = readFileSync('src/renderer/pages/suppliers/SuppliersPage.tsx', 'utf8')

describe('Supplier Payment edit/delete UI', () => {
  it('shows compact icon-only Pencil and Trash actions with exact Arabic tooltips', () => {
    expect(page).toContain("import { Eye, Pencil, Trash2 } from 'lucide-react'")
    expect(page).toContain('title="تعديل الدفعة" aria-label="تعديل الدفعة"')
    expect(page).toContain('<Pencil size={15}')
    expect(page).toContain('title="حذف الدفعة" aria-label="حذف الدفعة"')
    expect(page).toContain('<Trash2 size={15}')
  })

  it('prefills and submits the authoritative payment fields through backend IPC', () => {
    expect(page).toContain('amount: String(payment.amountMinor / 1000)')
    expect(page).toContain('paidAt: payment.paidAt.slice(0, 10)')
    expect(page).toContain("cashAccountId: payment.cashAccountId ? String(payment.cashAccountId) : ''")
    expect(page).toContain("call('purchases', 'updateSupplierPayment'")
    expect(page).toContain('amountMinor: toMinor(paymentForm.amount)')
    expect(page).toContain('notes: paymentForm.notes || null')
  })

  it('confirms delete with supplier, amount and date and refreshes authoritative balances/history', () => {
    expect(page).toContain('هل تريد حذف هذه الدفعة؟')
    expect(page).toContain('المورد: ${supplierName}')
    expect(page).toContain('المبلغ: ${fmtMoney(payment.amountMinor)}')
    expect(page).toContain('التاريخ: ${fmtDate(payment.paidAt)}')
    expect(page).toContain("call('purchases', 'deleteSupplierPayment'")
    expect(page).toContain('Promise.all([balances.reload(), refreshStatement()])')
  })
})
