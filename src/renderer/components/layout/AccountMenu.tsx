import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Pencil, Trash2, UserRound } from 'lucide-react'
import { useSession } from '@renderer/state/session.store'
import { useToast } from '@renderer/lib/toast'
import { call, ApiError } from '@renderer/lib/api'
import { ProfilePhotoCropDialog } from './ProfilePhotoCropDialog'

/**
 * The Top Bar's existing "مرحباً، <name> / <role>" area, now also the
 * account/profile-photo trigger — clicking it (or the avatar within
 * it) opens a small, ICON-ONLY popover: an edit icon (always shown —
 * doubles as "add" when there is no photo yet) and a delete icon
 * (shown only when a custom photo actually exists). Neither action is
 * ever rendered as visible text; both carry the Arabic phrase only as
 * title/aria-label.
 *
 * The photo itself is fetched fresh from main (profile.service.ts)
 * as a data: URI — never cached to localStorage or kept beyond this
 * component's own state, and always for the CURRENT session's user
 * only (there is no id parameter anywhere here a manipulated request
 * could redirect to someone else's photo).
 *
 * Picking a new photo never saves it directly — the picked file is
 * read back as a preview data: URI (profile.readImageForCrop) and
 * handed to ProfilePhotoCropDialog; only that dialog's own "حفظ"
 * actually persists anything (profile.setPhoto).
 */
export function AccountMenu(): ReactElement {
  const { session } = useSession()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [photo, setPhoto] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingImage, setPendingImage] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  async function loadPhoto(): Promise<void> {
    try {
      const result = await call<{ dataUrl: string | null }>('profile', 'getMyPhoto')
      setPhoto(result.dataUrl)
    } catch {
      setPhoto(null)
    }
  }

  // Fetched once per session (login, resumed "remember me" session,
  // or a plain app restart while already signed in) and again right
  // after a successful change/removal — never persisted client-side.
  useEffect(() => {
    if (session) void loadPhoto()
    else setPhoto(null)
    // Deliberately keyed on the user id alone, not the whole session
    // object — a permissions refresh creates a new session reference
    // for the same user and must not re-fetch the photo needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id])

  useEffect(() => {
    if (!open) return
    function onOutsideClick(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutsideClick)
    return () => document.removeEventListener('mousedown', onOutsideClick)
  }, [open])

  async function startChangePhoto(): Promise<void> {
    setOpen(false)
    try {
      const picked = await call<{ path?: string }>('profile', 'pickImage')
      if (!picked.path) return // user cancelled the native dialog
      setBusy(true)
      const read = await call<{ dataUrl: string }>('profile', 'readImageForCrop', { path: picked.path })
      setPendingImage(read.dataUrl) // opens the crop dialog — nothing saved yet
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر قراءة الصورة المحددة', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function removePhoto(): Promise<void> {
    setOpen(false)
    if (!window.confirm('هل تريد حذف الصورة الشخصية؟')) return
    setBusy(true)
    try {
      await call('profile', 'removePhoto')
      await loadPhoto()
      toast.show('تم حذف الصورة الشخصية', 'success')
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : 'تعذر حذف الصورة الشخصية', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="account-menu" ref={containerRef}>
      <button
        type="button"
        className="account-menu__trigger"
        onClick={() => setOpen((current) => !current)}
        disabled={busy}
        aria-label="حساب المستخدم وصورة الملف الشخصي"
        title="حساب المستخدم"
      >
        <span className="account-menu__avatar">
          {photo ? <img src={photo} alt="" /> : <UserRound size={18} strokeWidth={2} aria-hidden="true" />}
        </span>
        {/* Name only in the Top Bar. The role is deliberately not shown
            here any more — it is presentation only: session.user.roleName
            still exists and RBAC/permissions are untouched, and the role
            is still displayed in the sidebar footer. */}
        <span className="headbar__greeting">
          <strong>مرحباً، {session?.user.fullName}</strong>
        </span>
      </button>

      {open && (
        <div className="account-menu__dropdown account-menu__dropdown--icons" role="menu">
          <button
            type="button"
            role="menuitem"
            className="icon-btn"
            title="تغيير الصورة"
            aria-label="تغيير الصورة"
            onClick={() => void startChangePhoto()}
          >
            <Pencil size={15} strokeWidth={2.25} aria-hidden="true" />
          </button>
          {photo && (
            <button
              type="button"
              role="menuitem"
              className="icon-btn icon-btn--danger"
              title="حذف الصورة"
              aria-label="حذف الصورة"
              onClick={() => void removePhoto()}
            >
              <Trash2 size={15} strokeWidth={2.25} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {pendingImage && (
        <ProfilePhotoCropDialog
          imageDataUrl={pendingImage}
          onCancel={() => setPendingImage(null)}
          onSaved={() => {
            setPendingImage(null)
            void loadPhoto()
            toast.show('تم تحديث الصورة الشخصية', 'success')
          }}
        />
      )}
    </div>
  )
}
