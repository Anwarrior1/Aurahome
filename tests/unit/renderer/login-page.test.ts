import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { BRAND_LOGO_URL } from '@renderer/assets/branding'

const read = (path: string): string => readFileSync(path, 'utf8')

/**
 * Login screen: "تذكرني", an outside-the-card theme toggle, and the
 * removed subtitle — all presentation/interaction only. The renderer
 * has no jsdom/React Testing Library configured (see vitest.config.ts),
 * so — matching every other renderer test in this project — these are
 * source-text pins, not rendered-DOM assertions.
 */
describe('login page — "تذكرني", outside-card theme toggle, subtitle removal', () => {
  const page = read('src/renderer/pages/login/LoginPage.tsx')
  const css = read('src/renderer/styles/global.css')

  it('adds a Remember Me checkbox using the existing checkbox-row pattern, RTL-consistent with the rest of the app', () => {
    expect(page).toContain('className="checkbox-row"')
    expect(page).toContain('type="checkbox"')
    expect(page).toContain('checked={rememberMe}')
    expect(page).toContain('تذكرني')
    // Never shown during initial admin setup — only for an actual login.
    expect(page).toMatch(/\{!needsSetup && \(\s*<label className="checkbox-row">/)
  })

  it('threads rememberMe through to the login call — never silently dropped', () => {
    expect(page).toContain('login(username, password, rememberMe)')
  })

  it('reuses the existing ThemeProvider — no separate theme implementation', () => {
    expect(page).toContain("from '@renderer/theme/ThemeProvider'")
    expect(page).toContain('useTheme()')
    expect(page).toContain('onClick={toggle}')
    // Moon in light mode, Sun in dark mode — same convention as the
    // header's own theme toggle (AppLayout.tsx).
    expect(page).toMatch(/theme === 'light' \?[\s\S]{0,40}<Moon/)
    expect(page).not.toContain('>Dark Mode<')
    expect(page).not.toContain('>Light Mode<')
    expect(page).not.toContain('المظهر الداكن<')
  })

  it('positions the toggle outside the card, unable to overlap it (fixed to the viewport corner)', () => {
    expect(page).toContain('className="icon-btn auth-theme-toggle"')
    // It is a sibling of .auth-card, not a descendant of the <form>.
    expect(page).toMatch(/auth-theme-toggle[\s\S]*<\/button>\s*\n\s*<form className="auth-card"/)
    expect(css).toMatch(/\.auth-theme-toggle\s*\{[^}]*position:\s*fixed/)
  })

  it('removes the "نظام إدارة مصنع AURA home" subtitle and does not replace it with another one', () => {
    expect(page).not.toContain('نظام إدارة مصنع AURA home')
    // The setup-flow's own instruction line is untouched and still
    // gated to setup only — this task never asked for that to change.
    expect(page).toContain('أنشئ حساب مدير النظام للبدء')
    expect(page).toMatch(/\{needsSetup && <p className="auth-sub">أنشئ حساب مدير النظام للبدء<\/p>\}/)
  })

  it('leaves the existing AURA logo asset untouched', () => {
    expect(page).toContain("import { BRAND_LOGO_URL } from '@renderer/assets/branding'")
    expect(page).toContain('<img className="auth-logo" src={BRAND_LOGO_URL} alt="AURA home" />')
    expect(BRAND_LOGO_URL).toBe('./brand/logo-full.jpeg')
    expect(new URL(BRAND_LOGO_URL, 'file:///fictional/renderer/index.html#/login').href).toBe(
      'file:///fictional/renderer/brand/logo-full.jpeg'
    )
  })
})
