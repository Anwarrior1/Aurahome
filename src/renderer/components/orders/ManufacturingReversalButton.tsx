import { useState, type ReactElement } from 'react'
import { RotateCcw } from 'lucide-react'
import { call, ApiError } from '@renderer/lib/api'
import { useSession } from '@renderer/state/session.store'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { fmtMoney, fmtQty } from '@renderer/lib/format'
import { Button, ErrorNote, Field, Input, Modal, Textarea } from '../ui'
import { manufacturingStarted, type ManufacturingLifecycleState } from '@shared/production/manufacturing-lifecycle'

interface Preview {
  sheet: { documentNumber: string; status: string }
  reversalToken: string
  materialLines: Array<{ id: number; materialName: string; physicalQtyMicro: number; actualCostMinor?: number; status: string }>
  machineUsage: Array<{ id: number }>
  assignments: Array<{ id: number }>
}

/** One domain-owned undo, with the same typed confirmation convention as sensitive deletion. */
export function ManufacturingReversalButton({ id, sheet, sourceOrderArchived = false, onReversed }: { id: number; sheet: ManufacturingLifecycleState; sourceOrderArchived?: boolean; onReversed: () => Promise<void> }): ReactElement | null {
  const { can } = useSession()
  const [preview, setPreview] = useState<Preview>()
  const [confirmation, setConfirmation] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  if (sourceOrderArchived || manufacturingStarted(sheet) || !can(P.worksheets.reverse)) return null
  async function inspect(): Promise<void> {
    setBusy(true); setError(undefined)
    try {
      setPreview(await call<Preview>('production', 'getWorkSheet', { id }))
      setConfirmation(''); setReason('')
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذرت معاينة أمر التصنيع') }
    finally { setBusy(false) }
  }
  async function reverse(): Promise<void> {
    if (!preview || busy) return
    setBusy(true); setError(undefined)
    try {
      await call('production', 'reverseWorkSheet', { id, expectedToken: preview.reversalToken, confirmation, reason })
      setPreview(undefined)
      await onReversed()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر التراجع؛ لم تتغير أي بيانات'); setConfirmation('') }
    finally { setBusy(false) }
  }
  return <>
    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void inspect()}><RotateCcw size={15} /> تراجع عن أمر التصنيع</Button>
    {!preview && <ErrorNote>{error}</ErrorNote>}
    <Modal open={Boolean(preview)} wide title="التراجع عن أمر التصنيع" onClose={() => { if (!busy) setPreview(undefined) }} footer={<>
      <Button variant="destructive" disabled={busy || confirmation.trim() !== preview?.sheet.documentNumber || !reason.trim()} onClick={() => void reverse()}>تأكيد التراجع</Button>
      <Button variant="secondary" disabled={busy} onClick={() => void inspect()}>تحديث المعاينة</Button>
      <Button variant="secondary" disabled={busy} onClick={() => setPreview(undefined)}>إلغاء</Button>
    </>}>
      <ErrorNote>{error}</ErrorNote>
      <p>سيُعكس أمر التصنيع نفسه واستخدامه الفعلي فقط. يجب التراجع عن التسليم والتركيب وإذن الخروج أولاً؛ لن يعكس النظام أي خطوة لاحقة تلقائياً.</p>
      <ul>{preview?.materialLines.filter((r) => r.status === 'active').map((line) => <li key={line.id}>استعادة {line.materialName}: {fmtQty(line.physicalQtyMicro)}{line.actualCostMinor !== undefined ? ` — ${fmtMoney(line.actualCostMinor)}` : ''}</li>)}</ul>
      <p>استخدام الآلات: {preview?.machineUsage.length ?? 0} — تعيينات العمال: {preview?.assignments.length ?? 0}</p>
      <p>تجهيز الإنتاج ودفعات العميل وفواتير الشراء لن تُحذف.</p>
      <Field label="سبب التراجع" required><Textarea disabled={busy} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Field label={`اكتب رقم أمر التصنيع ${preview?.sheet.documentNumber ?? ''}`} required><Input disabled={busy} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></Field>
    </Modal>
  </>
}
