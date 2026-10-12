import {getRawConnection} from '@main/db/connection'

// Independent Contract C oracle: native Date calendar/instant arithmetic,
// not the production SQL keys. Unzoned retained event forms are UTC.
function instant(value: string): number {
  if(!/^\d{4}-\d{2}-\d{2}[T ]/.test(value))return Number.NEGATIVE_INFINITY
  const normalized=value.replace(' ','T')
  return new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)?normalized:normalized+'Z').getTime()
}
export function paymentHistoryReference(customerId: number): string[] {
  const rows=getRawConnection().prepare(`
    SELECT id,'payment' AS type,paid_at AS effective,created_at AS execution FROM customer_payments WHERE customer_id=?
    UNION ALL
    SELECT id,'refund',refunded_at,created_at FROM customer_payment_refunds WHERE customer_id=?
  `).all(customerId,customerId) as Array<{id:number;type:string;effective:string;execution:string}>
  return rows.map(row=>{
    const d=new Date(instant(row.effective))
    const day=/^\d{4}-\d{2}-\d{2}$/.test(row.effective)?row.effective:
      Number.isNaN(d.getTime())?'':`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    return {...row,day,time:instant(row.execution)}
  }).sort((a,b)=>(a.day===b.day?0:a.day<b.day?1:-1)||
    (a.time===b.time?0:b.time-a.time)||b.id-a.id||(a.type===b.type?0:a.type<b.type?1:-1))
    .map(row=>`${row.type}-${row.id}`)
}
