import { useState, type ReactElement } from 'react'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { Badge, Button, Card, ErrorNote, Modal, PageHeader } from '@renderer/components/ui'
import { fmtDateTime, fmtNumber } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

interface Validation {
  valid: boolean
  reason?: string
  manifest?: { appVersion: string; schemaVersion: number; createdAt: string; machineName: string; recordCounts: Record<string, number> }
}

export function BackupPage(): ReactElement {
  const { can, logout } = useSession()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [restore, setRestore] = useState<{ path: string; validation: Validation } | undefined>()
  const [error, setError] = useState<string>()

  async function backupNow(): Promise<void> {
    setBusy(true)
    try {
      const picked = await call<{ path?: string }>('backup', 'pickSavePath')
      if (!picked.path) return
      const result = await call<{ path: string }>('backup', 'create', { destinationFilePath: picked.path })
      toast.show(`تم إنشاء النسخة الاحتياطية: ${result.path}`, 'success')
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر إنشاء النسخة', 'error') }
    finally { setBusy(false) }
  }

  async function chooseRestore(): Promise<void> {
    setError(undefined)
    try {
      const picked = await call<{ path?: string }>('backup', 'pickFile')
      const target = picked.path
      if (!target) return
      const validation = await call<Validation>('backup', 'validate', { path: target })
      setRestore({ path: target, validation })
    } catch (err) { toast.show(err instanceof ApiError ? err.message : 'تعذر قراءة الملف', 'error') }
  }

  async function confirmRestore(): Promise<void> {
    if (!restore) return
    setBusy(true)
    try {
      await call('backup', 'restore', { backupFilePath: restore.path })
      await logout()
      toast.show('تمت الاستعادة بنجاح. سجّل الدخول من جديد إلى قاعدة البيانات المستعادة.', 'success')
      setRestore(undefined)
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذرت الاستعادة') }
    finally { setBusy(false) }
  }

  return (
    <>
      <PageHeader
        title="النسخ الاحتياطي والاستعادة"
        subtitle="نسخ محلية بالكامل — إلى مجلد محلي أو ذاكرة USB أو قرص خارجي، دون أي اعتماد على الإنترنت"
        actions={<>
          {can(P.backup.create) && <Button disabled={busy} onClick={() => void backupNow()}>إنشاء نسخة احتياطية الآن</Button>}
          {can(P.backup.restore) && <Button variant="secondary" disabled={busy} onClick={() => void chooseRestore()}>استعادة من ملف…</Button>}
        </>}
      />

      <Card title="كيف تعمل الاستعادة">
        <ul style={{ margin: 0, paddingRight: 18, fontSize: 12.5, lineHeight: 2 }}>
          <li>يتم التحقق من بصمة SHA-256 للملف أولاً، وتُرفض أي نسخة تالفة.</li>
          <li>يتم فحص سلامة قاعدة البيانات داخل النسخة قبل المساس بالبيانات الحالية.</li>
          <li>تُرفض النسخ الأحدث من إصدار التطبيق حمايةً للبيانات.</li>
          <li>تُحفظ نسخة أمان من قاعدة البيانات الحالية قبل استبدالها، ويمكن الرجوع إليها تلقائياً عند أي فشل.</li>
        </ul>
      </Card>

      <Modal open={Boolean(restore)} title="تأكيد الاستعادة" onClose={() => setRestore(undefined)}
        footer={restore?.validation.valid ? <>
          <Button variant="destructive" disabled={busy} onClick={() => void confirmRestore()}>استعادة واستبدال البيانات الحالية</Button>
          <Button variant="secondary" onClick={() => setRestore(undefined)}>إلغاء</Button>
        </> : <Button variant="secondary" onClick={() => setRestore(undefined)}>إغلاق</Button>}>
        <ErrorNote>{error}</ErrorNote>
        {restore && !restore.validation.valid && (
          <div className="error-note">نسخة غير صالحة: {restore.validation.reason}</div>
        )}
        {restore?.validation.valid && (
          <>
            <div className="notice-ok">تم التحقق من سلامة النسخة بنجاح.</div>
            <p><strong>الملف:</strong> {restore.path}</p>
            <p><strong>تاريخ النسخة:</strong> {fmtDateTime(restore.validation.manifest?.createdAt)}</p>
            <p><strong>الجهاز:</strong> {restore.validation.manifest?.machineName}</p>
            <p><strong>إصدار البنية:</strong> {restore.validation.manifest?.schemaVersion}</p>
            <p className="muted">محتويات النسخة:</p>
            <div className="pill-row">
              {Object.entries(restore.validation.manifest?.recordCounts ?? {}).map(([table, count]) => (
                <Badge key={table} tone="neutral">{table}: {fmtNumber(count)}</Badge>
              ))}
            </div>
            <div className="error-note" style={{ marginTop: 12 }}>
              ستُستبدل قاعدة البيانات الحالية. تُحفظ نسخة أمان تلقائياً قبل الاستبدال.
            </div>
          </>
        )}
      </Modal>
    </>
  )
}
