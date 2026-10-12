import { useState, type FormEvent, type ReactElement } from 'react'
import { Moon, Sun } from 'lucide-react'
import { BRAND_LOGO_URL } from '@renderer/assets/branding'
import { useSession } from '@renderer/state/session.store'
import { useTheme } from '@renderer/theme/ThemeProvider'
import { Button, ErrorNote, Field, Input } from '@renderer/components/ui'
import { ApiError } from '@renderer/lib/api'

export function LoginPage(): ReactElement {
  const { login, needsSetup, setup } = useSession()
  const { theme, toggle } = useTheme()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      if (needsSetup) await setup({ username, password, fullName })
      else await login(username, password, rememberMe)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تسجيل الدخول')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-layout">
      <button
        type="button"
        className="icon-btn auth-theme-toggle"
        onClick={toggle}
        aria-label={theme === 'light' ? 'تبديل إلى المظهر الداكن' : 'تبديل إلى المظهر الفاتح'}
        title={theme === 'light' ? 'المظهر الداكن' : 'المظهر الفاتح'}
      >
        {theme === 'light' ? (
          <Moon size={18} strokeWidth={2.25} aria-hidden="true" />
        ) : (
          <Sun size={18} strokeWidth={2.25} aria-hidden="true" />
        )}
      </button>

      <form className="auth-card" onSubmit={submit}>
        <img className="auth-logo" src={BRAND_LOGO_URL} alt="AURA home" />
        <h1 className="auth-title">{needsSetup ? 'إعداد النظام' : 'تسجيل الدخول'}</h1>
        {needsSetup && <p className="auth-sub">أنشئ حساب مدير النظام للبدء</p>}

        <ErrorNote>{error}</ErrorNote>

        {needsSetup && (
          <Field label="الاسم الكامل" required>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          </Field>
        )}
        <Field label="اسم المستخدم" required>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </Field>
        <Field label="كلمة المرور" required hint={needsSetup ? '6 أحرف على الأقل' : undefined}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>

        {!needsSetup && (
          <label className="checkbox-row">
            <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
            <span>تذكرني</span>
          </label>
        )}

        <Button type="submit" disabled={busy} style={{ width: '100%', marginTop: 6 }}>
          {busy ? 'جارٍ…' : needsSetup ? 'إنشاء الحساب والدخول' : 'دخول'}
        </Button>
      </form>
    </div>
  )
}
