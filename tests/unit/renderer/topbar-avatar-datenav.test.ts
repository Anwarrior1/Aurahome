import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(path, 'utf8')

/**
 * Top Bar profile avatar + modernized date navigator — presentation/
 * data-plumbing pins. No jsdom/React Testing Library is configured
 * for this renderer (see vitest.config.ts), so these follow every
 * other renderer test in this project: source-text assertions over
 * the real component/CSS, not rendered-DOM assertions. The real
 * photo storage/ownership behavior is covered in
 * tests/integration/profile-photo.test.ts.
 */
describe('account menu — avatar, own-photo actions, existing greeting preserved', () => {
  const menu = read('src/renderer/components/layout/AccountMenu.tsx')
  const layout = read('src/renderer/layouts/AppLayout.tsx')
  const css = read('src/renderer/styles/global.css')

  it('replaces the old static greeting block with the new AccountMenu, in the same grid slot', () => {
    expect(layout).toContain("import { AccountMenu } from '@renderer/components/layout/AccountMenu'")
    expect(layout).toContain('<AccountMenu />')
    expect(layout).not.toMatch(/<div className="headbar__greeting">\s*<strong>مرحباً/)
  })

  it('keeps the username in the Top Bar but no longer prints the role there', () => {
    expect(menu).toContain('مرحباً، {session?.user.fullName}')
    expect(menu).toContain('className="headbar__greeting"')
    // Presentation only: the role label is gone from the Top Bar...
    expect(menu).not.toContain('className="headbar__role"')
    expect(menu).not.toContain('{session?.user.roleName}')
    // ...while the role itself is untouched and still shown in the sidebar.
    expect(layout).toContain('<div className="sidebar__brand-sub">{session?.user.roleName}</div>')
  })

  it('shows the default fallback icon when there is no photo, and the real image with object-fit: cover when there is', () => {
    expect(menu).toContain("import { Pencil, Trash2, UserRound } from 'lucide-react'")
    expect(menu).toContain('{photo ? <img src={photo} alt="" /> : <UserRound')
    expect(css).toMatch(/\.account-menu__avatar img\s*\{[^}]*object-fit:\s*cover/)
    expect(css).toMatch(/\.account-menu__avatar\s*\{[^}]*border-radius:\s*999px/)
  })

  it('uses ICON-ONLY actions — "تغيير الصورة"/"حذف الصورة" appear only as title/aria-label, never as visible button text', () => {
    expect(menu).toContain("import { Pencil, Trash2, UserRound } from 'lucide-react'")
    expect(menu).toMatch(/title="تغيير الصورة"[\s\S]{0,80}aria-label="تغيير الصورة"/)
    expect(menu).toMatch(/title="حذف الصورة"[\s\S]{0,80}aria-label="حذف الصورة"/)
    expect(menu).toContain('<Pencil size={15}')
    expect(menu).toContain('<Trash2 size={15}')
    // Neither Arabic phrase is ever a button's own text child.
    expect(menu).not.toMatch(/>\s*تغيير الصورة\s*<\/button>/)
    expect(menu).not.toMatch(/>\s*حذف الصورة\s*<\/button>/)
  })

  it('shows the delete icon only when a photo actually exists, reuses the app\'s existing icon-btn/danger chrome', () => {
    expect(menu).toMatch(/\{photo && \(\s*<button[\s\S]{0,300}icon-btn icon-btn--danger/)
    expect(menu).toContain('className="icon-btn"')
  })

  it('never touches another user\'s photo — no user id is ever passed to the profile IPC calls', () => {
    expect(menu).toContain("'profile', 'pickImage'")
    expect(menu).toContain("'profile', 'readImageForCrop', { path: picked.path }")
    expect(menu).toContain("'profile', 'removePhoto'")
    expect(menu).not.toMatch(/'profile',\s*'\w+',\s*\{[^}]*userId/)
  })

  it('does not save immediately after picking — opens the crop dialog instead, which alone calls setPhoto', () => {
    const changeBlock = menu.slice(menu.indexOf('async function startChangePhoto'), menu.indexOf('async function removePhoto'))
    expect(changeBlock).not.toContain("'setPhoto'")
    expect(changeBlock).toContain('setPendingImage(read.dataUrl)')
    const cropDialog = read('src/renderer/components/layout/ProfilePhotoCropDialog.tsx')
    expect(cropDialog).toContain("'profile', 'setPhoto', { dataUrl: outputDataUrl }")
  })

  it('confirms before removing the photo, matching the app\'s existing destructive-action confirmation pattern', () => {
    const removeBlock = menu.slice(menu.indexOf('async function removePhoto'))
    expect(removeBlock).toMatch(/window\.confirm\(/)
  })

  it('refreshes the avatar immediately after a change or removal', () => {
    const removeBlock = menu.slice(menu.indexOf('async function removePhoto'))
    expect(removeBlock).toContain('await loadPhoto()')
    expect(menu).toContain('void loadPhoto()')
  })

  it('is theme-aware via existing tokens — dropdown reuses the same card surface as every other popover', () => {
    expect(css).toMatch(/\.account-menu__dropdown\s*\{[^}]*background:\s*var\(--bg-card\)/)
    expect(css).toMatch(/\.icon-btn--danger:hover\s*\{[^}]*color:\s*var\(--color-danger\)/)
  })

  it('positions the dropdown so it cannot run off the RTL-right edge', () => {
    expect(css).toMatch(/\.account-menu__dropdown\s*\{[^}]*inset-inline-start:\s*0/)
  })
})

describe('date navigator — modernized presentation, same underlying date state/logic', () => {
  const layout = read('src/renderer/layouts/AppLayout.tsx')
  const css = read('src/renderer/styles/global.css')
  const format = read('src/renderer/lib/format.ts')

  it('reuses useSelectedDate() untouched — no new/duplicated date state', () => {
    expect(layout).toContain('useSelectedDate()')
    expect(layout).toContain('goPreviousDay')
    expect(layout).toContain('goNextDay')
    expect(layout).toContain('setSelectedDateIso')
  })

  it('shows the main date and the weekday as clearly separate, differently-weighted elements', () => {
    expect(layout).toContain('className="date-nav__main"')
    expect(layout).toContain('{fmtDateLong(selectedDateIso)}')
    expect(layout).toContain('className="date-nav__sub"')
    expect(layout).toContain('{fmtWeekday(selectedDateIso)}')
    expect(css).toMatch(/\.date-nav__main\s*\{[^}]*font-weight:\s*700/)
    expect(css).toMatch(/\.date-nav__sub\s*\{[^}]*font-size:\s*10\.5px/)
  })

  it('formats the Arabic long date/weekday with the same UTC-anchored parsing as the existing date helpers — no timezone regression', () => {
    expect(format).toMatch(/fmtDateLong[\s\S]{0,200}timeZone:\s*'UTC'/)
    expect(format).toMatch(/fmtWeekday[\s\S]{0,200}timeZone:\s*'UTC'/)
  })

  it('shows the "اليوم" badge only when the selected date is actually today', () => {
    expect(layout).toMatch(/\{isToday && <span className="date-nav__today-badge">اليوم<\/span>\}/)
    expect(layout).not.toContain('(اليوم)')
  })

  it('keeps the previous/next chevrons wired to the exact same existing handlers, in the same relative order (no reversed RTL logic)', () => {
    const prevIdx = layout.indexOf('onClick={goPreviousDay}')
    const dateIdx = layout.indexOf('className="date-nav__display"')
    const nextIdx = layout.indexOf('onClick={goNextDay}')
    expect(prevIdx).toBeGreaterThan(-1)
    expect(nextIdx).toBeGreaterThan(-1)
    expect(prevIdx).toBeLessThan(dateIdx)
    expect(dateIdx).toBeLessThan(nextIdx)
    expect(layout).toContain('<ChevronRight size={17}')
    expect(layout).toContain('<ChevronLeft size={17}')
  })

  it('moves the calendar icon into its own standalone button that opens the SAME existing native date input — no second picker', () => {
    expect(layout).toContain('date-nav__btn date-nav__btn--calendar')
    expect(layout).toContain('dateInputRef.current?.showPicker?.()')
    // Only one <input type="date"> in the whole date navigator.
    expect(layout.match(/type="date"/g)).toHaveLength(1)
  })

  it('removes the old always-on heavy background pill — the display area is transparent until hovered', () => {
    expect(css).not.toContain('.date-nav__label')
    expect(css).toMatch(/\.date-nav__display\s*\{[^}]*background:\s*transparent/)
    expect(css).toMatch(/\.date-nav__display:hover\s*\{[^}]*background:\s*rgba/)
  })

  it('keeps the previous outer AURA/HOME-flanking structure intact', () => {
    // The two wordmarks still flank the date navigator in the same slots;
    // they are now rendered from the logo's own letterforms rather than
    // as typed text, so the pin is on the branding elements themselves.
    expect(layout).toContain('<Wordmark glyphs={HOME_WORDMARK}')
    expect(layout).toContain('<Wordmark glyphs={AURA_WORDMARK}')
    expect(layout).toContain('className={`headbar__brand-word ${modifier ?? \'\'}`}')
    expect(css).toMatch(/\.date-nav\s*\{[^}]*justify-self:\s*center/)
  })

  it('renders every brand letter as its own element, masked by the real logo pixels', () => {
    const glyphs = read('src/renderer/assets/aura-wordmark.ts')
    // four AURA + four home glyphs, each a data: URI cut from logo/logo.jpeg
    expect(glyphs.match(/src: 'data:image\/png;base64,/g)).toHaveLength(8)
    expect(glyphs).toContain('export const AURA_WORDMARK')
    expect(glyphs).toContain('export const HOME_WORDMARK')
    expect(layout).toContain('className="brand-glyph"')
    // painted in currentColor so the inverting headbar drives the colour
    expect(css).toMatch(/\.brand-glyph::before\s*\{[^}]*background:\s*currentColor/)
    expect(css).toMatch(/\.brand-glyph::before\s*\{[^}]*mask-image:\s*var\(--glyph\)/)
    const glyphRule = css.slice(css.indexOf('.brand-glyph {'), css.indexOf('.brand-glyph::before'))
    expect(glyphRule).not.toMatch(/mask-image/)
  })

  it('AURA/HOME are completely static — no glow, filter, drop-shadow or animation of any kind', () => {
    expect(css).not.toMatch(/brand-sweep/)
    expect(css).not.toMatch(/--brand-glow/)
    expect(css).not.toMatch(/--brand-lit/)
    expect(css).not.toMatch(/--brand-weight/)
    expect(css).not.toContain('--sweep-i')
    expect(layout).not.toContain('--sweep-i')
    expect(layout).not.toContain('sweepFrom')
    const glyphRule = css.slice(css.indexOf('.brand-glyph {'), css.indexOf('.brand-glyph::before'))
    expect(glyphRule).not.toMatch(/filter|animation|drop-shadow|text-shadow/)
    // The sizing that keeps AURA/HOME's current on-screen size and
    // HOME's bolder look (from its own source letterform) is untouched.
    expect(css).toMatch(/\.headbar__brand-word\s*\{[^}]*--brand-h:\s*19px/)
    expect(css).toMatch(/\.headbar__brand-word--home\s*\{[^}]*--brand-h:\s*17px/)
  })
})

describe('profile photo crop/position editor — reuses an existing dependency, existing Modal chrome, theme tokens', () => {
  const cropDialog = read('src/renderer/components/layout/ProfilePhotoCropDialog.tsx')
  const css = read('src/renderer/styles/global.css')
  const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> }

  it('reuses react-easy-crop (already installed) rather than a hand-rolled crop implementation', () => {
    expect(pkg.dependencies?.['react-easy-crop']).toBeTruthy()
    expect(cropDialog).toContain("import Cropper, { type Area, type Point } from 'react-easy-crop'")
    expect(cropDialog).toContain("import 'react-easy-crop/react-easy-crop.css'")
  })

  it('reuses the existing Modal component for dialog chrome instead of building new markup', () => {
    expect(cropDialog).toContain("import { Button, ErrorNote, Modal } from '@renderer/components/ui'")
    expect(cropDialog).toContain('<Modal')
    expect(cropDialog).not.toContain('modal-backdrop')
  })

  it('shows a large circular preview that dims the outside area, via cropShape="round"', () => {
    expect(cropDialog).toContain('cropShape="round"')
    expect(cropDialog).toContain('aspect={1}')
  })

  it('supports drag-to-reposition and zoom in/out without stretching (uniform scale, not width/height)', () => {
    expect(cropDialog).toContain('onCropChange={setCrop}')
    expect(cropDialog).toContain('onZoomChange={setZoom}')
    expect(cropDialog).toMatch(/type="range"[\s\S]{0,150}onChange=\{\(e\) => setZoom\(Number\(e\.target\.value\)\)\}/)
  })

  it('offers "إعادة ضبط" / "إلغاء" / "حفظ" as the three dialog actions', () => {
    expect(cropDialog).toContain('إعادة ضبط')
    expect(cropDialog).toContain('إلغاء')
    expect(cropDialog).toContain('حفظ')
  })

  it('reset restores the initial crop/zoom without touching anything already saved', () => {
    const resetFn = cropDialog.slice(cropDialog.indexOf('function reset'), cropDialog.indexOf('async function save'))
    expect(resetFn).toContain('setCrop(INITIAL_CROP)')
    expect(resetFn).toContain('setZoom(INITIAL_ZOOM)')
    expect(resetFn).not.toContain("call(")
  })

  it('cancel never calls setPhoto and never mutates the existing photo', () => {
    expect(cropDialog).toContain('onClose={onCancel}')
    // onCancel is passed straight through — the dialog itself defines no save-on-cancel path.
    expect(cropDialog).not.toMatch(/onCancel\(\)[\s\S]{0,40}setPhoto/)
  })

  it('save draws only the cropped region (never the full image) onto a canvas sized to a 512 cap, without upscaling small crops', () => {
    expect(cropDialog).toContain('const OUTPUT_SIZE = 512')
    expect(cropDialog).toContain('Math.min(OUTPUT_SIZE, Math.round(area.width))')
    expect(cropDialog).toMatch(/ctx\.drawImage\(image, area\.x, area\.y, area\.width, area\.height, 0, 0, outputSize, outputSize\)/)
  })

  it('save persists only through setMyPhoto\'s IPC channel, and only after the user confirms — never on pick alone', () => {
    expect(cropDialog).toContain("await call('profile', 'setPhoto', { dataUrl: outputDataUrl })")
  })

  it('the crop stage and zoom control are styled from existing theme tokens, not new hardcoded colours', () => {
    expect(css).toMatch(/\.crop-dialog__stage\s*\{[^}]*background:\s*var\(--bg-app\)/)
    expect(css).toMatch(/\.crop-dialog__zoom input\[type='range'\]\s*\{[^}]*accent-color:\s*var\(--color-brand-600\)/)
  })
})
