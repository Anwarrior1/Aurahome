import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computeDocumentTotals } from '@main/services/sales/document-totals'
import { fmtMoney, toMicro } from '@renderer/lib/format'
import { setupTestDatabase } from '../../helpers/test-db'
import { getRawConnection } from '@main/db/connection'
import type { IpcMainInvokeEvent } from 'electron'
import { previewMultiplyDivideRounded, multiplyDivideRounded } from '@shared/money/cost'

const harness = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, call: vi.fn(), defaultBp: 6000, formatted: [] as number[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => {
  const i = harness.cursor++
  if (!(i in harness.states)) harness.states[i] = initial
  return [harness.states[i], (next: unknown) => { harness.states[i] = typeof next === 'function' ? (next as (v: unknown) => unknown)(harness.states[i]) : next }]
} }))
vi.mock('@renderer/lib/format', async (original) => { const actual = await original<typeof import('@renderer/lib/format')>(); return { ...actual, fmtMoney: (n: number) => { harness.formatted.push(n); return actual.fmtMoney(n) } } })
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@renderer/lib/useQuery', () => ({ useQuery: (_g: string, method: string) => ({ data: method === 'depositDefault' ? { depositPercentBp: harness.defaultBp } : [], loading: false, reload: vi.fn() }) }))
vi.mock('@renderer/lib/usePagedQuery', () => ({ usePagedQuery: () => ({ items: [], loading: false, reload: vi.fn() }) }))
vi.mock('@renderer/state/session.store', () => ({ useSession: () => ({ can: () => true }) }))
vi.mock('@renderer/lib/toast', () => ({ useToast: () => ({ show: vi.fn() }) }))
vi.mock('@renderer/lib/api', () => ({ call: (...args: unknown[]) => harness.call(...args), ApiError: class extends Error {} }))
vi.mock('@renderer/components/invoices/usePrintVisibility', () => ({ usePrintVisibility: () => ({ toggle: () => ({}), payload: () => ({}), reset: vi.fn(), load: vi.fn() }) }))
import { QuotationsPage } from '@renderer/pages/quotations/QuotationsPage'
import { FinalInvoicesPage } from '@renderer/pages/invoices/FinalInvoicesPage'
import { Field, Button } from '@renderer/components/ui'

function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const el = node as ReactElement<Record<string, unknown>>
  return [el, ...nodes(el.props.children as ReactNode), ...nodes(el.props.footer as ReactNode)]
}
function editor(page: () => ReactElement, qty = '0.145', price = '0.10') {
  harness.cursor = 0; page()
  const form = harness.states.findIndex(v => !!v && typeof v === 'object' && 'customerId' in v)
  const lines = harness.states.findIndex(v => Array.isArray(v) && !!v[0] && typeof v[0] === 'object' && 'qty' in v[0])
  harness.states[form] = { ...harness.states[form] as object, customerId: '1' }
  const template = (harness.states[lines] as object[])[0]
  harness.states[lines] = [{ ...template, description: 'Fictional rounding line', qty, unitPrice: price }]
  return {
    render: () => { harness.cursor = 0; return nodes(page()) },
    form: (changes: object) => { harness.states[form] = { ...harness.states[form] as object, ...changes } },
    lines: (inputs: Array<{ qty: string; unitPrice: string }>) => { harness.states[lines] = inputs.map(input => ({ ...template, description: 'Fictional rounding line', ...input })) }
  }
}
function field(tree: ReturnType<typeof nodes>, label: string) {
  const node = tree.find(el => el.type === Field && String(el.props.label).startsWith(label === 'سعر البيع النهائي' && tree.some(n => n.type === Field && n.props.label === 'الإجمالي') ? 'الإجمالي' : label))!
  return nodes(node.props.children as ReactNode)[0]
}
beforeEach(() => { harness.states = []; harness.cursor = 0; harness.formatted = []; harness.defaultBp = 6000; harness.call.mockReset(); harness.call.mockResolvedValue({ id: 1 }) })

describe.each([['preliminary invoice', QuotationsPage], ['final invoice', FinalInvoicesPage]] as const)('E2E-01 actual %s editor', (_name, page) => {
  it('original midpoint preview, visible total and unchanged submit match the authoritative owner', async () => {
    const view = editor(page)
    const owner = computeDocumentTotals([{ quantityMicro: 145000, unitPriceMinor: 100 }], 'none', 0, 6000)
    expect(owner.totalMinor).toBe(15)
    harness.formatted = []
    expect(field(view.render(), 'سعر البيع النهائي').props.value).toBe(fmtMoney(owner.totalMinor))
    expect(harness.formatted.slice(0, -1)).toContain(15)
    const save = view.render().find(el => el.type === Button && el.props.children === 'حفظ كمسودة')!
    ;(save.props.onClick as () => void)()
    await Promise.resolve()
    const payload = harness.call.mock.calls[0][2]
    expect(payload.lines[0]).toMatchObject({ quantityMicro: 145000, unitPriceMinor: 100 })
    expect(computeDocumentTotals(payload.lines, payload.discountKind, payload.discountValue, payload.depositPercentBp ?? 6000).totalMinor).toBe(15)
  })
  it.each([['0.144', '0.10', 14], ['0.145', '0.10', 15], ['0.146', '0.10', 15], ['1', '0.10', 100], ['1.0', '0.100000', 100], ['0.005', '0.10', 1], ['0.29', '0.10', 29], ['0.145000', '0', 0], ['1', '9007199254740.99', 9007199254740990]])('exact scaled preview for %s × %s = %i minor', (qty, price, total) => {
    const view = editor(page, qty, price)
    const authoritative = computeDocumentTotals([{ quantityMicro: toMicro(qty), unitPriceMinor: Math.round(Number(price) * 1000) }], 'none', 0, 6000)
    expect(authoritative.totalMinor).toBe(total)
    expect(field(view.render(), 'سعر البيع النهائي').props.value).toBe(fmtMoney(total))
  })
  it('rounds each line before aggregation: two half-minor lines yield 2, not 1 minor', () => {
    const view = editor(page)
    view.lines([{ qty: '0.005', unitPrice: '0.10' }, { qty: '0.005', unitPrice: '0.10' }])
    harness.formatted = []
    expect(field(view.render(), 'إجمالي المنتجات').props.value).toBe(fmtMoney(2))
    expect(harness.formatted.slice(0, -1)).toContain(2)
    expect(field(view.render(), 'سعر البيع النهائي').props.value).toBe(fmtMoney(2))
  })
  it.each([['amount', '0.005'], ['amount', '9'], ['percent', '10'], ['percent', '50'], ['percent', '33.333']])('charges then %s discount %s then normalized deposit', (kind, discount) => {
    const view = editor(page, '0.145', kind === 'percent' ? '10000' : '0.10')
    view.form({ discountKind: kind, discountValue: discount, installationPrice: '0.010', deliveryPrice: '0.005', meterPrice: '999', depositPercent: '33.333' })
    const owner = computeDocumentTotals([{ quantityMicro: 145000, unitPriceMinor: kind === 'percent' ? 10000000 : 100 }], kind as 'amount' | 'percent', Math.round(Number(discount) * (kind === 'percent' ? 100 : 1000)), 3333, { installationPriceMinor: 10, deliveryPriceMinor: 5 })
    expect(field(view.render(), 'الخصم').props.value).toBe(fmtMoney(owner.discountMinor))
    expect(field(view.render(), 'سعر البيع النهائي').props.value).toBe(fmtMoney(owner.totalMinor))
    expect(field(view.render(), 'الدفعة المقدمة').props.value).toBe(fmtMoney(owner.depositRequiredMinor))
  })
  it('actual input handlers immediately recalculate after quantity and price changes', () => {
    const view = editor(page, '1', '1')
    ;(field(view.render(), 'الكمية').props.onChange as (e: unknown) => void)({ target: { value: '0.145' } })
    ;(field(view.render(), 'سعر الوحدة').props.onChange as (e: unknown) => void)({ target: { value: '0.10' } })
    expect(field(view.render(), 'سعر البيع النهائي').props.value).toBe(fmtMoney(15))
  })
})


describe('E2E-01 shared preview safety uses the unchanged exact primitive', () => {
  it.each([[100, 144000, 1000000, 14], [100, 145000, 1000000, 15], [100, 146000, 1000000, 15], [100, 5000, 1000000, 1], [Number.MAX_SAFE_INTEGER, 1000000, 1000000, Number.MAX_SAFE_INTEGER]])('exact %i × %i / %i = %i', (a, b, denominator, expected) => {
    expect(previewMultiplyDivideRounded(a, b, denominator)).toBe(expected)
    expect(multiplyDivideRounded(a, b, denominator)).toBe(expected)
  })
  it.each([[NaN, 1, 1000000], [Infinity, 1, 1000000], [Number.MAX_SAFE_INTEGER + 1, 1, 1000000], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1000000]])('incomplete/unsafe %s × %s stays invalid without crashing a render', (a, b, denominator) => {
    expect(previewMultiplyDivideRounded(a, b, denominator)).toBeNaN()
    expect(() => multiplyDivideRounded(a, b, denominator)).toThrow()
  })
})

describe.each([['quotations', QuotationsPage, 'quotations', 'quotation_lines', 'quotation'], ['finalInvoices', FinalInvoicesPage, 'final_invoices', 'final_invoice_lines', 'invoice']] as const)('E2E-01 %s actual editor Save → registered IPC → SQLite', (group, page, table, lineTable, dtoKey) => {
  it('preserves submitted scales, persisted totals, read-back, one audit and read-only side effects; audit failure rolls back', async () => {
    const env = setupTestDatabase()
    const electron = await import('electron')
    const handlers = new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<{ ok: boolean; data?: unknown; error?: unknown }>>()
    const registration = vi.spyOn(electron.ipcMain, 'handle').mockImplementation(((channel: string, handler: never) => { handlers.set(channel, handler) }) as never)
    try {
      const { registerIpcRouter } = await import('@main/ipc/router')
      registerIpcRouter(); registration.mockRestore()
      const event = { sender: { id: 1 } } as IpcMainInvokeEvent
      const invoke = (g: string, m: string, p: unknown) => handlers.get(g + ':' + m)!(event, p)
      const customer = await invoke('customers', 'create', { name: 'E2E01 fictional customer' })
      expect(customer.ok).toBe(true)
      const customerId = (customer.data as { id: number }).id
      const db = getRawConnection()
      const unchanged = () => ['cash_transactions', 'inventory_movements', 'fifo_layers', 'fifo_allocations', 'orders', 'work_sheets'].map(t => [t, db.prepare('SELECT * FROM ' + t).all()])
      const before = unchanged()
      const view = editor(page); view.form({ customerId: String(customerId) })
      expect(field(view.render(), 'سعر البيع النهائي').props.value).toBe(fmtMoney(15))
      harness.call.mockImplementation(async (g, m, p) => { const result = await invoke(g, m, p); if (!result.ok) throw new Error('registered IPC rejected'); return result.data })
      const save = view.render().find(el => el.type === Button && el.props.children === 'حفظ كمسودة')!
      ;(save.props.onClick as () => void)()
      await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get()).toEqual({ n: 1 }))
      const payload = harness.call.mock.calls[0][2]
      expect(payload.lines[0]).toMatchObject({ quantityMicro: 145000, unitPriceMinor: 100 })
      const stored = db.prepare('SELECT * FROM ' + table).get() as { id: number; total_minor: number }
      expect(stored.total_minor).toBe(15)
      expect(db.prepare('SELECT quantity_micro, unit_price_minor, line_total_minor FROM ' + lineTable).get()).toEqual({ quantity_micro: 145000, unit_price_minor: 100, line_total_minor: 15 })
      const read = await invoke(group, 'get', { id: stored.id })
      expect(read.ok).toBe(true)
      expect((read.data as Record<string, { totalMinor: number }>)[dtoKey].totalMinor).toBe(15)
      expect(db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action=?').get(group + '.create')).toEqual({ n: 1 })
      expect(unchanged()).toEqual(before)
      const printed = await invoke('documents', 'preview', { kind: group === 'quotations' ? 'preliminary_invoice' : 'final_invoice', id: stored.id })
      expect(printed.ok).toBe(true)
      expect((printed.data as { html: string }).html).toContain(fmtMoney(15))
      expect(unchanged()).toEqual(before)
      db.exec("CREATE TRIGGER e2e01_audit_fault BEFORE INSERT ON audit_log WHEN NEW.action='" + group + ".create' BEGIN SELECT RAISE(ABORT,'E2E01 disposable audit fault'); END")
      const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => { const name = (row as { name: string }).name; return [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()] })
      const old = snapshot()
      const failure = await invoke(group, 'create', payload)
      expect(failure).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } })
      expect(snapshot()).toEqual(old)
      db.exec('DROP TRIGGER e2e01_audit_fault')
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(db.pragma('foreign_key_check')).toEqual([])
    } finally { registration.mockRestore(); env.cleanup() }
  })
})
