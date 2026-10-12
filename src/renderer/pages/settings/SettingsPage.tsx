import { useEffect, useState, type ReactElement } from 'react'
import { useQuery } from '@renderer/lib/useQuery'
import { call, ApiError } from '@renderer/lib/api'
import { useToast } from '@renderer/lib/toast'
import { useSession } from '@renderer/state/session.store'
import { useTheme } from '@renderer/theme/ThemeProvider'
import { Button, Card, ErrorNote, Field, Input, PageHeader, Textarea } from '@renderer/components/ui'
import { basisPointsSchema, percentageSchema, safePositiveIntegerSchema } from '@shared/schemas/common.schema'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'

// BL-08: `savings.rate_bp` is deliberately absent — the savings rate is
// owned by the Savings module and is edited there, through
// `profit:setSavingsRate` under `savings.manage`. General Settings
// (`settings.manage`) can no longer change it.
const KEYS = {
  depositPercentBp: 'orders.deposit_percent_bp',
  quotationValidityHours: 'quotations.validity_hours',
  terms: 'documents.terms',
  companyName: 'company.name',
  companyPhone: 'company.phone',
  companyAddress: 'company.address'
}

function generalDraft(values: Record<string, unknown>): Record<string, string> {
  return {
    depositPercent: String(Number(values[KEYS.depositPercentBp] ?? 6000) / 100),
    validityHours: String(values[KEYS.quotationValidityHours] ?? 48),
    companyName: String(values[KEYS.companyName] ?? 'AURA home'),
    companyPhone: String(values[KEYS.companyPhone] ?? ''),
    companyAddress: String(values[KEYS.companyAddress] ?? '')
  }
}

export function SettingsPage(): ReactElement {
  const { can } = useSession()
  const { theme, toggle } = useTheme()
  const toast = useToast()
  const settings = useQuery<Record<string, unknown>>('settings', 'getAll')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [terms, setTerms] = useState<string[]>([])
  const [error, setError] = useState<string>()
  const [savingGeneral, setSavingGeneral] = useState(false)

  useEffect(() => {
    if (!settings.data) return
    setDraft(generalDraft(settings.data))
    setTerms((settings.data[KEYS.terms] as string[]) ?? [])
  }, [settings.data])

  const editable = can(P.settings.manage)

  async function save(key: string, value: unknown, message: string): Promise<void> {
    try {
      await call('settings', 'set', { key, value })
      toast.show(message, 'success')
      setError(undefined)
      await settings.reload()
    } catch (err) { setError(err instanceof ApiError ? err.message : 'تعذر الحفظ') }
  }

  async function saveGeneral(): Promise<void> {
    if (savingGeneral) return
    const percent = Number(draft.depositPercent)
    const depositBp = Math.round(percent * 100)
    if (!draft.depositPercent?.trim() || !percentageSchema.safeParse(percent).success || !basisPointsSchema.safeParse(depositBp).success) {
      setError('نسبة الدفعة المقدمة يجب أن تكون بين 0% و100%')
      return
    }
    const hours = Number(draft.validityHours)
    if (!draft.validityHours?.trim() || !safePositiveIntegerSchema.safeParse(hours).success) {
      setError('مدة صلاحية عرض السعر يجب أن تكون عدداً صحيحاً موجباً وآمناً')
      return
    }
    if (!draft.companyName) {
      setError('اسم الشركة مطلوب')
      return
    }
    const changes = [
      { field: 'depositPercent', key: KEYS.depositPercentBp, value: depositBp, label: 'نسبة الدفعة المقدمة' },
      { field: 'validityHours', key: KEYS.quotationValidityHours, value: hours, label: 'مدة صلاحية عرض السعر' },
      { field: 'companyName', key: KEYS.companyName, value: draft.companyName, label: 'اسم الشركة' },
      { field: 'companyPhone', key: KEYS.companyPhone, value: draft.companyPhone, label: 'هاتف الشركة' },
      { field: 'companyAddress', key: KEYS.companyAddress, value: draft.companyAddress, label: 'عنوان الشركة' }
    ]
    setSavingGeneral(true)
    setError(undefined)
    try {
      const results = await Promise.allSettled(changes.map(({ key, value }) => call('settings', 'set', { key, value })))
      const saved = changes.filter((_, index) => results[index]?.status === 'fulfilled')
      const failed = changes.filter((_, index) => results[index]?.status === 'rejected')
      const failures = results.flatMap((result, index) => result.status === 'rejected'
        ? [`${changes[index]!.label}: ${result.reason instanceof ApiError ? result.reason.message : 'تعذر تأكيد الحفظ'}`]
        : [])
      const outcome = failed.length === 0 ? 'تم حفظ الإعدادات'
        : saved.length > 0 ? `تم حفظ بعض الإعدادات فقط (${saved.map(change => change.label).join('، ')}). لم يتأكد حفظ: ${failures.join('؛ ')}`
          : `لم يتأكد حفظ أي إعداد: ${failures.join('؛ ')}`
      try {
        const persisted = await call<Record<string, unknown>>('settings', 'getAll')
        // Reconcile confirmed writes with the owner read; retain unconfirmed
        // user inputs for correction/retry, identified explicitly in the result.
        setDraft({ ...generalDraft(persisted), ...Object.fromEntries(failed.map(change => [change.field, draft[change.field] ?? ''])) })
      } catch {
        setError(`${outcome}. تعذر إعادة تحميل القيم المحفوظة؛ أعد فتح الصفحة للتحقق قبل المحاولة مجدداً.`)
        return
      }
      if (failed.length > 0) setError(`${outcome}. بقيت المدخلات غير المؤكدة للمراجعة والمحاولة مجدداً.`)
      else toast.show(outcome, 'success')
    } finally {
      setSavingGeneral(false)
    }
  }

  return (
    <>
      <PageHeader title="الإعدادات" subtitle="إعدادات النظام والمستندات — البيانات الحساسة لا تُحفظ في ملفات نصية" />
      <ErrorNote>{error}</ErrorNote>

      <Card title="المظهر">
        <p className="muted">الوضع الحالي: {theme === 'light' ? 'فاتح' : 'داكن'} — يُحفظ التفضيل لكل مستخدم. المستندات المطبوعة تُطبع دائماً بالوضع الفاتح.</p>
        <Button variant="secondary" onClick={toggle}>تبديل إلى {theme === 'light' ? 'الداكن' : 'الفاتح'}</Button>
      </Card>

      <Card title="بيانات الشركة والمستندات">
        <div className="grid grid--3">
          <Field label="اسم الشركة"><Input disabled={!editable || savingGeneral} value={draft.companyName ?? ''} onChange={(e) => setDraft({ ...draft, companyName: e.target.value })} /></Field>
          <Field label="هاتف الشركة"><Input disabled={!editable || savingGeneral} value={draft.companyPhone ?? ''} onChange={(e) => setDraft({ ...draft, companyPhone: e.target.value })} /></Field>
          <Field label="عنوان الشركة"><Input disabled={!editable || savingGeneral} value={draft.companyAddress ?? ''} onChange={(e) => setDraft({ ...draft, companyAddress: e.target.value })} /></Field>
        </div>
      </Card>

      <Card title="القواعد المالية">
        <div className="grid grid--2">
          <Field label="نسبة الدفعة المقدمة الافتراضية %" hint="قابلة للتعديل لكل طلب على حدة">
            <Input type="number" step="1" disabled={!editable || savingGeneral} value={draft.depositPercent ?? ''} onChange={(e) => setDraft({ ...draft, depositPercent: e.target.value })} />
          </Field>
          <Field label="مدة صلاحية عرض السعر (ساعة)">
            <Input type="number" step="1" disabled={!editable || savingGeneral} value={draft.validityHours ?? ''} onChange={(e) => setDraft({ ...draft, validityHours: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card title="الشروط والأحكام المطبوعة على الفاتورة المبدئية"
        actions={editable && <Button size="sm" onClick={() => void save(KEYS.terms, terms, 'تم حفظ الشروط والأحكام')}>حفظ الشروط</Button>}>
        <p className="muted">تُطبع هذه الشروط على كل فاتورة مبدئية، وتُحفظ نسخة مجمّدة منها مع كل عرض معتمد — فتعديلها لاحقاً لا يغيّر المستندات الصادرة.</p>
        {terms.map((term, index) => (
          <Field key={index} label={`البند ${index + 1}`}>
            <Textarea disabled={!editable} value={term} onChange={(e) => {
              const next = [...terms]; next[index] = e.target.value; setTerms(next)
            }} />
          </Field>
        ))}
        {editable && (
          <div className="row-actions">
            <Button variant="secondary" size="sm" onClick={() => setTerms([...terms, ''])}>+ بند</Button>
            {terms.length > 0 && <Button variant="ghost" size="sm" onClick={() => setTerms(terms.slice(0, -1))}>حذف الأخير</Button>}
          </div>
        )}
      </Card>

      {editable && (
        <div style={{ marginBottom: 30 }}>
          <Button disabled={savingGeneral} onClick={() => void saveGeneral()}>{savingGeneral ? 'جارٍ حفظ الإعدادات…' : 'حفظ كل الإعدادات'}</Button>
        </div>
      )}
    </>
  )
}
