import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Sun, Moon, LogOut, ChevronRight, ChevronLeft, ChevronDown, CalendarDays, RotateCcw } from 'lucide-react'
import { NAV, canAccessNavItem } from '@renderer/routes/nav'
import { sectionForPath } from '@renderer/routes/nav-active'
import { NAV_ICONS } from '@renderer/components/icons/nav-icons'
import { NotificationBell } from '@renderer/components/layout/NotificationBell'
import { AccountMenu } from '@renderer/components/layout/AccountMenu'
import { useSession } from '@renderer/state/session.store'
import { useTheme } from '@renderer/theme/ThemeProvider'
import { useSelectedDate } from '@renderer/state/selected-date.store'
import { fmtDateLong, fmtWeekday } from '@renderer/lib/format'
import { PERMISSION_KEYS as P } from '@shared/permissions/permission-keys'
import { AURA_WORDMARK, HOME_WORDMARK, type WordmarkGlyph } from '@renderer/assets/aura-wordmark'
import { BRAND_LOGO_URL } from '@renderer/assets/branding'

/**
 * Renders a logo wordmark as INDEPENDENT glyph elements — one span per
 * letter, each masked by that letter's own pixels from logo/logo.jpeg
 * and painted in `currentColor`, so the Top Bar's existing
 * --text-headbar drives the colour in both themes. Static — no glow,
 * no animation.
 */
function Wordmark({
  glyphs,
  label,
  modifier
}: {
  glyphs: readonly WordmarkGlyph[]
  label: string
  modifier?: string
}): ReactElement {
  return (
    <span className={`headbar__brand-word ${modifier ?? ''}`} role="img" aria-label={label}>
      {glyphs.map((glyph) => (
        <span
          key={glyph.key}
          className="brand-glyph"
          style={
            {
              aspectRatio: glyph.ratio,
              // Handed to CSS as a custom property (which inherits into
              // ::before) rather than set as mask-image here directly.
              '--glyph': `url("${glyph.src}")`
            } as CSSProperties
          }
        />
      ))}
    </span>
  )
}

export function AppLayout(): ReactElement {
  const { session, logout, can } = useSession()
  const { theme, toggle } = useTheme()
  const { selectedDateIso, isToday, goPreviousDay, goNextDay, goToday, setSelectedDateIso } = useSelectedDate()
  const dateInputRef = useRef<HTMLInputElement>(null)
  const location = useLocation()

  /**
   * Accordion state: which ONE collapsible section is open. Seeded
   * from the current route on first render (so a refresh/deep-link
   * into a nested page already shows its parent expanded), then left
   * entirely to the user's own clicks — EXCEPT when navigation moves
   * into a different section (a sidebar child click elsewhere, a
   * link from inside a page, or browser back/forward), which re-syncs
   * it the same way, exactly like the initial seed. Collapsing the
   * section you are currently on (without navigating away) is a pure
   * UI toggle and is never fought by this effect, since the route
   * itself has not changed.
   */
  const [openSection, setOpenSection] = useState<string | null>(() => sectionForPath(location.pathname))
  const lastRouteSectionRef = useRef(openSection)

  useEffect(() => {
    const current = sectionForPath(location.pathname)
    if (current !== lastRouteSectionRef.current) {
      lastRouteSectionRef.current = current
      setOpenSection(current)
    }
  }, [location.pathname])

  function toggleSection(label: string): void {
    setOpenSection((current) => (current === label ? null : label))
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <img src={BRAND_LOGO_URL} alt="AURA home" />
        </div>

        <nav className="sidebar__nav">
          {NAV.map((group) => {
            const items = group.items.filter((item) => canAccessNavItem(item, can))
            if (!items.length) return null

            // A single-item group (today, only "الرئيسية") is a plain
            // top-level link — nothing to expand or collapse.
            if (group.items.length <= 1) {
              // Guarded above by `if (!items.length) return null`, so this
              // is always present at runtime — the check is purely to
              // narrow the type, and changes no behaviour.
              const item = items[0]
              if (!item) return null
              const Icon = NAV_ICONS[item.icon]
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  className={({ isActive }) => `sidebar__link ${isActive ? 'active' : ''}`}
                >
                  <span className="sidebar__icon-wrap">
                    {Icon && <Icon className="sidebar__icon" strokeWidth={2.25} aria-hidden="true" />}
                  </span>
                  <span>{item.label}</span>
                </NavLink>
              )
            }

            const isOpen = openSection === group.label
            const GroupIcon = group.icon ? NAV_ICONS[group.icon] : undefined
            return (
              <div key={group.label} className={`sidebar__section ${isOpen ? 'sidebar__section--open' : ''}`}>
                <button
                  type="button"
                  className="sidebar__section-toggle"
                  aria-expanded={isOpen}
                  onClick={() => toggleSection(group.label)}
                >
                  <span className="sidebar__icon-wrap">
                    {GroupIcon && <GroupIcon className="sidebar__icon" strokeWidth={2.25} aria-hidden="true" />}
                  </span>
                  <span className="sidebar__section-label">{group.label}</span>
                  <ChevronDown
                    className={`sidebar__section-chevron ${isOpen ? 'sidebar__section-chevron--open' : ''}`}
                    size={15}
                    strokeWidth={2.25}
                    aria-hidden="true"
                  />
                </button>
                {isOpen && (
                  <div className="sidebar__section-children">
                    {items.map((item) => {
                      const Icon = NAV_ICONS[item.icon]
                      return (
                        <NavLink
                          key={item.path}
                          to={item.path}
                          className={({ isActive }) => `sidebar__link ${isActive ? 'active' : ''}`}
                        >
                          <span className="sidebar__icon-wrap">
                            {Icon && <Icon className="sidebar__icon" strokeWidth={2.25} aria-hidden="true" />}
                          </span>
                          <span>{item.label}</span>
                        </NavLink>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </nav>

        {/* Decorative brand watermark occupying whatever vertical space
            the navigation leaves free, between the nav above and the
            account area below. Each letter is the REAL AURA wordmark
            letterform cut from logo/logo.jpeg (see assets/aura-wordmark)
            — not a font, and never a redrawn approximation. Four
            INDEPENDENT upright images, not a rotated word and no
            writing-mode, so each highlights on its own hover. Each
            keeps its natural width from the image itself, so a glyph
            can never be stretched. Purely decorative: hidden from
            assistive tech and never focusable. */}
        <div className="sidebar__watermark" aria-hidden="true">
          {AURA_WORDMARK.map((glyph) => (
            <img key={glyph.key} className="sidebar__wm-letter" src={glyph.src} alt="" draggable={false} />
          ))}
        </div>

        <div className="sidebar__foot">
          <div className="sidebar__brand-sub">{session?.user.fullName}</div>
          <div className="sidebar__brand-sub">{session?.user.roleName}</div>
        </div>
      </aside>

      <div className="main-area">
        <header className="headbar">
          <AccountMenu />

          <Wordmark glyphs={HOME_WORDMARK} label="home" modifier="headbar__brand-word--home" />

          <div className="date-nav">
            {/* Standalone calendar trigger, separate from the date
                display itself — opens the SAME native date input as
                before (dateInputRef/showPicker), never a second picker. */}
            <button
              type="button"
              className="date-nav__btn date-nav__btn--calendar"
              title="اختيار تاريخ"
              aria-label="اختيار تاريخ العمل"
              onClick={() => dateInputRef.current?.showPicker?.()}
            >
              <CalendarDays size={15} strokeWidth={2.25} aria-hidden="true" />
              <input
                ref={dateInputRef}
                type="date"
                lang="en-GB"
                value={selectedDateIso}
                onChange={(e) => { if (e.target.value) setSelectedDateIso(e.target.value) }}
                aria-hidden="true"
                tabIndex={-1}
              />
            </button>
            <button type="button" className="date-nav__btn" title="اليوم السابق" aria-label="اليوم السابق" onClick={goPreviousDay}>
              <ChevronRight size={17} strokeWidth={2.25} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="date-nav__display"
              title="اختيار تاريخ"
              aria-label={`التاريخ المحدد: ${fmtDateLong(selectedDateIso)}`}
              onClick={() => dateInputRef.current?.showPicker?.()}
            >
              <span className="date-nav__main">{fmtDateLong(selectedDateIso)}</span>
              <span className="date-nav__sub">
                <span>{fmtWeekday(selectedDateIso)}</span>
                {isToday && <span className="date-nav__today-badge">اليوم</span>}
              </span>
            </button>
            <button type="button" className="date-nav__btn" title="اليوم التالي" aria-label="اليوم التالي" onClick={goNextDay}>
              <ChevronLeft size={17} strokeWidth={2.25} aria-hidden="true" />
            </button>
            {/* Back to the real system date from any historical day. */}
            {!isToday && (
              <button type="button" className="date-nav__btn" title="اليوم" aria-label="العودة إلى اليوم" onClick={goToday}>
                <RotateCcw size={15} strokeWidth={2.25} aria-hidden="true" />
              </button>
            )}
          </div>

          <Wordmark glyphs={AURA_WORDMARK} label="AURA" />

          <div className="headbar__actions">
            {(can(P.inventory.view) || can(P.orders.view)) && <NotificationBell />}
            <button
              type="button"
              className="headbar-icon-btn"
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
            <button
              type="button"
              className="headbar-icon-btn"
              onClick={() => void logout()}
              aria-label="تسجيل الخروج"
              title="تسجيل الخروج"
            >
              <LogOut size={18} strokeWidth={2.25} aria-hidden="true" />
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
