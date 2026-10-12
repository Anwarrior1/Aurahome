import { useState, type ReactElement } from 'react'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'
import { Card, DataTable, ErrorNote, Field, Input, PageHeader, Pager, Toolbar } from '@renderer/components/ui'
import { fmtDateTime } from '@renderer/lib/format'

interface Entry { id: number; userId: number | null; userName: string | null; action: string; entity: string; entityId: string | null; details: string | null; createdAt: string }

export function AuditPage(): ReactElement {
  const [action, setAction] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const list = usePagedQuery<Entry>('admin', 'audit', {
    action: action || undefined, from: from || undefined, to: to || undefined
  }, { limit: 100 })

  return (
    <>
      <PageHeader title="سجل العمليات" subtitle="سجل غير قابل للتعديل لكل العمليات الحساسة" />
      <Card>
        <Toolbar>
          <Field label="نوع العملية"><Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="مثال: orders.cancel" /></Field>
          <Field label="من"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="إلى"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </Toolbar>
        <ErrorNote>{list.error}</ErrorNote>
        <DataTable
          loading={list.loading}
          rows={list.items}
          rowKey={(row) => row.id}
          empty="لا توجد عمليات مسجّلة"
          columns={[
            { key: 'at', header: 'التاريخ', render: (row) => fmtDateTime(row.createdAt) },
            { key: 'user', header: 'المستخدم', render: (row) => row.userName ?? '—' },
            { key: 'action', header: 'العملية', render: (row) => row.action },
            { key: 'entity', header: 'السجل', render: (row) => `${row.entity}${row.entityId ? ` #${row.entityId}` : ''}` },
            {
              key: 'details', header: 'التفاصيل',
              render: (row) => <span className="muted" style={{ fontSize: 11.5 }}>{row.details ? row.details.slice(0, 90) : '—'}</span>
            }
          ]}
        />
        <Pager pageIndex={list.pageIndex} hasPrev={list.hasPrev} hasNext={list.hasNext} loading={list.loading} onPrev={() => void list.prev()} onNext={() => void list.next()} />
      </Card>
    </>
  )
}
