import { useState, type ReactElement } from 'react'
import { Trash2 } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Textarea } from '@renderer/components/ui'
import { fmtMoney } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface Machine { id: number; name: string; costingUnit: string; defaultRateMicro: number; active: boolean; notes: string | null }

export function MachinesPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [editing, setEditing] = useState<{ id?: number; name: string; costingUnit: string; rate: string; notes: string; active: boolean } | undefined>()
  const [error, setError] = useState<string>()
  const list = useQuery<Machine[]>('machines', 'list', {})

  async function save(): Promise<void> {
    if (!editing?.name.trim() || !editing.costingUnit.trim()) { setError('الاسم ووحدة التكلفة مطلوبان'); return }
    try {
      const payload = {
        name: editing.name, costingUnit: editing.costingUnit,
        defaultRateMicro: Math.round(Number(editing.rate || 0) * 1_000_000),
        notes: editing.notes || undefined
      }
      if (editing.id) await call('machines', 'update', { id: editing.id, ...payload, active: editing.active })
      else await call('machines', 'create', payload)
      toast.show('تم حفظ الآلة', 'success')
      setEditing(undefined); setError(undefined)
      await list.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  /** Item 8: blocked with a clear message while usage exists against an order. */
  async function remove(id: number): Promise<void> {
    if (!window.confirm('هل تريد حذف هذه الآلة؟')) return
    try {
      await call('machines', 'remove', { id })
      toast.show('تم حذف الآلة', 'success')
      await list.reload()
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر الحذف', 'error') }
  }

  return (
    <>
      <PageHeader
        title="الآلات"
        subtitle="لكل آلة وحدة تكلفة خاصة بها — قص، لوح، متر، ساعة، أو أي وحدة يحددها المستخدم"
        actions={can(P.machines.manage) && (
          <Button onClick={() => { setEditing({ name: '', costingUnit: '', rate: '', notes: '', active: true }); setError(undefined) }}>
            + آلة جديدة
          </Button>
        )}
      />
      <Card>
        <DataTable
          loading={list.loading}
          rows={list.data ?? []}
          rowKey={(row) => row.id}
          empty="لا توجد آلات"
          columns={[
            { key: 'name', header: 'الآلة', render: (row) => row.name },
            { key: 'unit', header: 'وحدة التكلفة', render: (row) => <Badge tone="info">{row.costingUnit}</Badge> },
            { key: 'rate', header: 'التكلفة لكل وحدة', numeric: true, render: (row) => fmtMoney(Math.round(row.defaultRateMicro / 1000)) },
            { key: 'active', header: 'الحالة', render: (row) => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'مفعّلة' : 'متوقفة'}</Badge> },
            { key: 'notes', header: 'ملاحظات', render: (row) => row.notes ?? '—' },
            {
              key: 'actions', header: '', render: (row) => can(P.machines.manage) ? (
                <div className="row-actions">
                  <Button variant="ghost" size="sm" onClick={() => {
                    setEditing({ id: row.id, name: row.name, costingUnit: row.costingUnit, rate: String(row.defaultRateMicro / 1_000_000), notes: row.notes ?? '', active: row.active })
                    setError(undefined)
                  }}>تعديل</Button>
                  <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void remove(row.id)}>
                    <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
                  </button>
                </div>
              ) : null
            }
          ]}
        />
      </Card>

      <Modal open={Boolean(editing)} title={editing?.id ? 'تعديل آلة' : 'آلة جديدة'} onClose={() => setEditing(undefined)}
        footer={<><Button onClick={() => void save()}>حفظ</Button><Button variant="secondary" onClick={() => setEditing(undefined)}>إلغاء</Button></>}>
        <ErrorNote>{error}</ErrorNote>
        <Field label="اسم الآلة" required><Input value={editing?.name ?? ''} onChange={(e) => setEditing({ ...editing!, name: e.target.value })} /></Field>
        <Field label="وحدة التكلفة" required hint="مثال: قص، لوح، متر، متر مربع، قطعة، ساعة">
          <Input value={editing?.costingUnit ?? ''} onChange={(e) => setEditing({ ...editing!, costingUnit: e.target.value })} />
        </Field>
        <Field label="التكلفة لكل وحدة (د.ل)" required hint="مثال: 30 د.ل لكل لوح">
          <Input type="number" step="0.000001" value={editing?.rate ?? ''} onChange={(e) => setEditing({ ...editing!, rate: e.target.value })} />
        </Field>
        <Field label="ملاحظات"><Textarea value={editing?.notes ?? ''} onChange={(e) => setEditing({ ...editing!, notes: e.target.value })} /></Field>
        {editing?.id && (
          <label className="checkbox-row">
            <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
            <span>مفعّلة</span>
          </label>
        )}
      </Modal>
    </>
  )
}
