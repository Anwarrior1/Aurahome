import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {setupTestDatabase, type TestEnv} from '../helpers/test-db'
import {approveToOrder} from '../helpers/sales-flow'
import {getRawConnection} from '@main/db/connection'
import {reconcileDatabase} from '@main/db/reconciliation'
import {createCustomer, customerBalances, customerStatement} from '@main/services/parties/parties.service'
import {createFinalInvoice, getFinalInvoice} from '@main/services/sales/final-invoices.service'
import {getOrder, recordPayment, refundPayment, reverseCustomerPayment} from '@main/services/sales/orders.service'
import {createAccount, accountBalance} from '@main/services/finance/cash.service'
import {issueWorkSheet, startProduction} from '@main/services/production/production.service'
import {encodeCursor} from '@main/services/base/pagination'
import {moneyFromMajor as m} from '@shared/money/money'
import {quantityFromDisplay as q} from '@shared/quantity/quantity'

// Select TZ before Vitest startup. Expected calendars use native Date fields,
// not the production business-date helper or SQL history-key implementation.
const zone=process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
const calendar=(d: Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
let env: TestEnv
beforeEach(()=>{
  vi.useFakeTimers({toFake:['Date']})
  vi.setSystemTime(new Date(2026,9,1,0,5))
  env=setupTestDatabase()
})
afterEach(()=>{
  try {expect(getRawConnection().pragma('integrity_check')).toEqual([{integrity_check:'ok'}]);expect(getRawConnection().pragma('foreign_key_check')).toEqual([])}
  finally {env.cleanup();vi.useRealTimers()}
})
const raw=()=>getRawConnection()
function snapshot() {
  return raw().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r)=>{
    const {name}=r as {name:string};return [name,raw().prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]
  })
}
function fixture(paidAt?: string) {
  const customerId=createCustomer({name:'Composite customer'},env.ctx)
  const accountId=createAccount({name:'Composite cash',kind:'cash'},env.ctx)
  const invoice=createFinalInvoice({customerId,paidAmountMinor:paidAt===undefined?m(5400):0,initialCashAccountId:accountId,
    lines:[{lineKind:'custom',description:'Order',quantityMicro:q(1),unitPriceMinor:m(9000)}]},env.ctx)
  const order=approveToOrder(invoice.id,env.ctx)
  if(paidAt!==undefined)recordPayment({orderId:order.id,amountMinor:m(5400),cashAccountId:accountId,paidAt},env.ctx)
  return {customerId,accountId,orderId:order.id,invoiceId:invoice.id}
}
function refund(f: ReturnType<typeof fixture>,refundedAt?: string,amount=2000,key=crypto.randomUUID()) {
  return refundPayment({orderId:f.orderId,cashAccountId:f.accountId,amountMinor:m(amount),requestKey:key,refundedAt},env.ctx)
}
function traversal(f: ReturnType<typeof fixture>) {
  const keys: string[]=[],pages: ReturnType<typeof customerStatement>['payments'][]=[]
  let cursor: string|undefined
  do {
    const page=customerStatement(f.customerId,env.ctx,{sections:['payments'],payments:{limit:1,cursor}}).payments
    expect(page.items).toHaveLength(1);pages.push(page);keys.push(...page.items.map(r=>r.rowKey))
    cursor=page.nextCursor??undefined;expect(pages.length).toBeLessThan(30)
  }while(cursor)
  const backwards: string[]=[];let page=pages.at(-1)!
  backwards.unshift(...page.items.map(r=>r.rowKey))
  while(page.prevCursor) {
    page=customerStatement(f.customerId,env.ctx,{sections:['payments'],payments:{limit:1,cursor:page.prevCursor}}).payments
    backwards.unshift(...page.items.map(r=>r.rowKey))
  }
  expect(backwards).toEqual(keys);expect(new Set(keys).size).toBe(keys.length)
  return keys
}
function check(f: ReturnType<typeof fixture>,keys: string[],paid=3400) {
  const before=snapshot()
  const rows=getOrder(f.orderId).payments
  expect(rows.map(r=>r.rowKey)).toEqual(keys)
  expect(customerStatement(f.customerId,env.ctx,{sections:['payments']}).payments.items.map(r=>r.rowKey)).toEqual(keys)
  expect(traversal(f)).toEqual(keys);expect(traversal(f)).toEqual(keys)
  expect(getOrder(f.orderId).order).toMatchObject({paidMinor:m(paid),remainingMinor:m(9000-paid)})
  expect(customerBalances(undefined,f.customerId)[0]).toMatchObject({paidMinor:m(paid),remainingMinor:m(9000-paid)})
  expect(getFinalInvoice(f.invoiceId).payment).toMatchObject({paidMinor:m(paid),remainingMinor:m(9000-paid)})
  expect(accountBalance(f.accountId)).toBe(m(paid))
  expect(snapshot()).toEqual(before)
  expect(reconcileDatabase(raw())).toMatchObject({errorCount:0,warningCount:0,findings:[]})
  return rows
}
describe(`owner-approved payment/refund Contract C (${zone})`,()=>{
  it('defaults after local midnight: later refund is newer within the same effective factory day',()=>{
    const f=fixture();const payment=raw().prepare('SELECT * FROM customer_payments').get() as {paid_at:string;created_at:string}
    vi.setSystemTime(new Date(2026,9,1,0,10));refund(f)
    const rows=check(f,['refund-1','payment-1'])
    expect(payment.paid_at).toBe('2026-10-01');expect(payment.created_at).toBe(new Date(2026,9,1,0,5).toISOString())
    expect(rows.map(r=>r.effectiveBusinessDay)).toEqual(['2026-10-01','2026-10-01'])
    expect(rows.map(r=>r.executionAt)).toEqual([new Date(2026,9,1,0,10).toISOString(),payment.created_at])
    expect(raw().prepare('SELECT direction, amount_minor, ref_table, ref_id, occurred_at FROM cash_transactions ORDER BY id').all()).toEqual([
      {direction:'in',amount_minor:m(5400),ref_table:'customer_payments',ref_id:1,occurred_at:'2026-10-01'},
      {direction:'out',amount_minor:m(2000),ref_table:'customer_payment_refunds',ref_id:1,occurred_at:new Date(2026,9,1,0,10).toISOString()}
    ])
    expect(raw().prepare("SELECT action,created_at FROM audit_log WHERE action IN ('orders.payment','orders.payment.refund') ORDER BY id").all()).toEqual([
      {action:'orders.payment',created_at:payment.created_at},{action:'orders.payment.refund',created_at:new Date(2026,9,1,0,10).toISOString()}
    ])
  })
  it('backdated effective payment stays on the selected day, not its execution day',()=>{
    const f=fixture('2026-09-29');vi.setSystemTime(new Date(2026,9,1,0,10));refund(f)
    expect(check(f,['refund-1','payment-1']).map(r=>r.effectiveBusinessDay)).toEqual(['2026-10-01','2026-09-29'])
  })
  it('future effective payment remains primary even though the refund executed later',()=>{
    const f=fixture('2026-10-02');vi.setSystemTime(new Date(2026,9,1,0,10));refund(f)
    expect(check(f,['payment-1','refund-1']).map(r=>r.effectiveBusinessDay)).toEqual(['2026-10-02','2026-10-01'])
  })
  it('instant payment and date-only refund share the literal/local day without invented effective time',()=>{
    const at=new Date(2026,9,1,0,5).toISOString();const f=fixture(at)
    vi.setSystemTime(new Date(2026,9,1,0,10));refund(f,'2026-10-01')
    const rows=check(f,['refund-1','payment-1'])
    expect(rows.map(r=>r.effectiveBusinessDay)).toEqual(['2026-10-01','2026-10-01'])
    expect(rows.map(r=>r.paidAt)).toEqual(['2026-10-01',at])
  })
  it.each([
    ['2026-10-01T10:00:00Z','2026-10-01T10:00:00.000Z'],
    ['2026-10-01T12:00:00+02:00','2026-10-01T10:00:00.000Z'],
    ['2026-10-01 10:00:00','2026-10-01T10:00:00.000Z']
  ])('equivalent effective instants %s and %s classify identically; creation determines order',(paidAt,refundedAt)=>{
    const f=fixture(paidAt);vi.setSystemTime(new Date(2026,9,1,0,10));refund(f,refundedAt)
    expect(check(f,['refund-1','payment-1']).map(r=>r.effectiveBusinessDay)).toEqual([calendar(new Date('2026-10-01T10:00:00Z')),calendar(new Date('2026-10-01T10:00:00Z'))])
  })
  it('a fixed UTC instant keeps its independently determined local day, including the New York prior-day crossover',()=>{
    const instant='2026-10-01T00:10:00.000Z'
    const expectedDay=calendar(new Date(instant))
    if(zone==='America/New_York')expect(expectedDay).toBe('2026-09-30')
    if(['Africa/Tripoli','Africa/Cairo','UTC'].includes(zone))expect(expectedDay).toBe('2026-10-01')
    const f=fixture(instant);vi.setSystemTime(new Date(2026,9,1,0,10));refund(f,instant)
    expect(check(f,['refund-1','payment-1']).map(r=>r.effectiveBusinessDay)).toEqual([expectedDay,expectedDay])
  })
  it('same-day mixed events traverse page-size-one forward/back repeatedly with exact financial/source identities',()=>{
    const f=fixture();vi.setSystemTime(new Date(2026,9,1,0,6))
    recordPayment({orderId:f.orderId,amountMinor:m(1000),cashAccountId:f.accountId},env.ctx)
    vi.setSystemTime(new Date(2026,9,1,0,10));const key=crypto.randomUUID();refund(f,undefined,2000,key)
    const after=snapshot();expect(refund(f,undefined,2000,key).idempotent).toBe(true);expect(snapshot()).toEqual(after)
    vi.setSystemTime(new Date(2026,9,1,0,11));refund(f,undefined,500)
    check(f,['refund-2','refund-1','payment-2','payment-1'],3900)
    expect(raw().prepare('SELECT refund_id,payment_id,amount_minor FROM customer_payment_refund_allocations ORDER BY id').all()).toEqual([
      {refund_id:1,payment_id:1,amount_minor:m(2000)},{refund_id:2,payment_id:1,amount_minor:m(500)}
    ])
    expect(raw().prepare('SELECT amount_minor FROM customer_payments ORDER BY id').all()).toEqual([{amount_minor:m(5400)},{amount_minor:m(1000)}])
  })
  it('identical day and creation instant use the established ID/type tie consistently across tables',()=>{
    const f=fixture('2026-10-01');refund(f,'2026-10-01')
    const rows=check(f,['refund-1','payment-1'])
    expect(rows[0]!.executionAt).toBe(rows[1]!.executionAt)
  })
  it('retained creation instants compare chronologically; unknown date-only creation does not invent a time',()=>{
    const f=fixture('2026-10-01');refund(f,'2026-10-01')
    raw().prepare("UPDATE customer_payments SET created_at='2026-09-30 22:05:00'").run()
    raw().prepare("UPDATE customer_payment_refunds SET created_at='2026-09-30T22:10:00.000Z'").run()
    expect(check(f,['refund-1','payment-1']).map(r=>r.executionAt)).toEqual(['2026-09-30T22:10:00.000Z','2026-09-30T22:05:00.000Z'])
    raw().prepare("UPDATE customer_payment_refunds SET created_at='2026-10-01'").run()
    expect(check(f,['payment-1','refund-1'])[1]!.executionAt).toBe('')
  })
  it('preserves local factory days across timezone-database DST transitions',()=>{
    const dates=zone==='America/New_York'?[[2026,2,8],[2026,10,1]]: [[2026,3,24],[2026,9,29]]
    for(const [year,month,day] of dates) {
      const at=new Date(year!,month!,day!,0,5);vi.setSystemTime(at);const f=fixture()
      vi.setSystemTime(new Date(at.getTime()+300000));refund(f)
      const keys=getOrder(f.orderId).payments.map(r=>r.rowKey).sort((a,b)=>a.startsWith('refund')?-1:b.startsWith('refund')?1:0)
      expect(check(f,keys).map(r=>r.effectiveBusinessDay)).toEqual([calendar(at),calendar(at)])
    }
  })
  it('rejects old raw-field cursors instead of silently applying them to the new tuple',()=>{
    const f=fixture();refund(f)
    const cursor=encodeCursor('next',['2026-10-01',1,'payment'],'customers.statement.payments',{customerId:f.customerId})
    expect(()=>customerStatement(f.customerId,env.ctx,{sections:['payments'],payments:{limit:1,cursor}})).toThrow(/مؤشر الصفحة/)
  })
  it('does not loosen refund or source-reversal rejection after actual manufacturing starts',()=>{
    const f=fixture();const sheet=issueWorkSheet({orderId:f.orderId},env.ctx);startProduction(sheet.id,env.ctx)
    const before=snapshot();expect(()=>refund(f)).toThrow(/بدء التصنيع/)
    expect(()=>reverseCustomerPayment(1,env.ctx)).toThrow(/بدء التصنيع/);expect(snapshot()).toEqual(before)
    check(f,['payment-1'],5400)
  })
})
