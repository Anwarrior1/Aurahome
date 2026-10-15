import { useState, type ReactElement } from 'react'
import { useQuery } from '@renderer/lib/useQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, DataTable, ErrorNote, Field, Input, Modal, PageHeader, Textarea } from '@renderer/components/ui'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { Pencil, Trash2 } from 'lucide-react'

interface Color { id: number; code: string; name: string; relatedMaterialId: number | null; relatedMaterialType: string | null; baseMaterialNames: string[]; unresolvedMaterialIds: number[]; legacyAssociationConflict: boolean; notes: string | null; active: boolean }

export function ColorsPage(): ReactElement {
  const { can } = useSession()
  const toast = useToast()
  const [editing, setEditing] = useState<Partial<Color> | undefined>()
  const [error, setError] = useState<string>()
  const list = useQuery<Color[]>('colors', 'list', {})

  async function save(): Promise<void> {
    if (!editing?.code?.trim() || !editing?.name?.trim()) { setError('كود واسم اللون مطلوبان'); return }
    try {
      const payload = {
        code: editing.code, name: editing.name,
        notes: editing.notes ?? undefined
      }
      if (editing.id) await call('colors', 'update', { id: editing.id, ...payload, active: editing.active })
      else await call('colors', 'create', payload)
      toast.show('تم حفظ اللون', 'success')
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('catalog-changed'))
      setEditing(undefined); setError(undefined)
      await list.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  async function remove(row: Color): Promise<void> {
    if (!window.confirm(`هل تريد حذف اللون/التشطيب ${row.code}؟ إذا كان مستخدماً فسيتم أرشفته مع الحفاظ على المستندات التاريخية.`)) return
    try {
      const result = await call<{ deleted: boolean; archived: boolean }>('colors', 'remove', { id: row.id })
      toast.show(result.deleted ? 'تم حذف اللون غير المستخدم' : 'اللون مستخدم تاريخياً، لذلك تم تعطيله بدلاً من حذفه', 'success')
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('catalog-changed'))
      await list.reload()
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر حذف اللون', 'error')
    }
  }

  return (
    <>
      <PageHeader
        title="كتالوج الألوان والتشطيبات"
        subtitle="أكواد الألوان التي يختار منها العميل، وتنتقل مع الطلب إلى أمر التصنيع"
        actions={can(P.colors.manage) && <Button onClick={() => { setEditing({ active: true }); setError(undefined) }}>+ لون جديد</Button>}
      />
      <Card>
        <DataTable
          loading={list.loading}
          rows={list.data ?? []}
          rowKey={(row) => row.id}
          empty="لا توجد ألوان في الكتالوج"
          columns={[
            { key: 'code', header: 'الكود', render: (row) => <strong>{row.code}</strong> },
            { key: 'name', header: 'الاسم', render: (row) => row.name },
            { key: 'type', header: 'المواد المرتبطة', render: (row) => `${row.baseMaterialNames.join('، ') || '—'}${row.unresolvedMaterialIds.length ? ' ⚠ أساس غير محدد' : ''}${row.legacyAssociationConflict ? ' ⚠ ارتباط قديم متعارض' : ''}` },
            { key: 'notes', header: 'ملاحظات', render: (row) => row.notes ?? '—' },
            { key: 'active', header: 'الحالة', render: (row) => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'مفعّل' : 'غير مفعّل'}</Badge> },
            {
              key: 'actions', header: '', render: (row) =>
                can(P.colors.manage) ? (
                  <div className="row-actions">
                    <button type="button" className="icon-btn" title="تعديل" aria-label="تعديل" onClick={() => { setEditing(row); setError(undefined) }}>
                      <Pencil size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                    <button type="button" className="icon-btn icon-btn--danger" title="حذف" aria-label="حذف" onClick={() => void remove(row)}>
                      <Trash2 size={16} strokeWidth={2.25} aria-hidden="true" />
                    </button>
                  </div>
                ) : null
            }
          ]}
        />
      </Card>

      <Modal open={Boolean(editing)} title={editing?.id ? 'تعديل لون' : 'لون جديد'} onClose={() => setEditing(undefined)}
        footer={<><Button onClick={() => void save()}>حفظ</Button><Button variant="secondary" onClick={() => setEditing(undefined)}>إلغاء</Button></>}>
        <ErrorNote>{error}</ErrorNote>
        <Field label="كود اللون" required hint="مثال: 101"><Input value={editing?.code ?? ''} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
        <Field label="اسم اللون" required><Input value={editing?.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
        <Field label="المواد المرتبطة">
          <div>{editing?.baseMaterialNames?.join('، ') || '—'}</div>
          {Boolean(editing?.unresolvedMaterialIds?.length) && <ErrorNote>تعذر تحديد التصنيف الأساسي للمواد ذات المعرّفات: {editing?.unresolvedMaterialIds?.join('، ')}.</ErrorNote>}
          <p className="muted">تُحدَّد من حقل لون الصنف في نموذج المادة.</p>
          {editing?.legacyAssociationConflict && <ErrorNote>ارتباط قديم يحتاج مراجعة: {editing.relatedMaterialType || 'مادة محفوظة'}{editing.relatedMaterialId ? ` (#${editing.relatedMaterialId})` : ''}. لم تُحذف البيانات القديمة.</ErrorNote>}
        </Field>
        <Field label="ملاحظات"><Textarea value={editing?.notes ?? ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
        {editing?.id && (
          <label className="checkbox-row">
            <input type="checkbox" checked={editing.active ?? true} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
            <span>مفعّل</span>
          </label>
        )}
      </Modal>
    </>
  )
}
