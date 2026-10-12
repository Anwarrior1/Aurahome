import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, AlertTriangle, Clock, Trash2 } from 'lucide-react'
import { useQuery } from '@renderer/lib/useQuery'
import { call } from '@renderer/lib/api'
import { fmtDateTime } from '@renderer/lib/format'
import { Button, Modal } from '@renderer/components/ui'

interface NotificationItem {
  key: string
  category: 'low_stock' | 'incomplete_order'
  title: string
  description: string
  occurredAt: string
  read: boolean
  route: string
}

const CATEGORY_ICON = { low_stock: AlertTriangle, incomplete_order: Clock } as const

/** Re-checks the live business conditions periodically so the badge
 *  never goes stale for long — this app has no push/event channel of
 *  its own, and a short poll is the simplest correct substitute. */
const POLL_MS = 60_000

/**
 * The Top Bar's notifications Bell — low-stock materials and
 * incomplete customer orders, both derived live from the ERP's own
 * existing data (notifications.service.ts), permission-filtered
 * server-side per category. Opening the dropdown clears the unread
 * badge without touching the underlying business condition; a
 * resolved condition simply stops appearing on the next refresh.
 */
export function NotificationBell(): ReactElement {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set())
  const [confirmClear, setConfirmClear] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const { data, reload } = useQuery<{ items: NotificationItem[]; unreadCount: number; totalCount: number }>('notifications', 'list')

  useEffect(() => {
    const interval = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(interval)
  }, [reload])

  useEffect(() => {
    if (!open) return
    function onOutsideClick(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutsideClick)
    return () => document.removeEventListener('mousedown', onOutsideClick)
  }, [open])

  async function toggle(): Promise<void> {
    const opening = !open
    setOpen(opening)
    if (opening && (data?.unreadCount ?? 0) > 0) {
      try {
        await call('notifications', 'markAllRead')
        await reload()
      } catch {
        /* the badge staying as-is is harmless — never blocks opening the panel */
      }
    }
  }

  function openItem(item: NotificationItem): void {
    setOpen(false)
    navigate(item.route)
  }

  async function dismissItem(event: ReactMouseEvent<HTMLButtonElement>, item: NotificationItem): Promise<void> {
    event.stopPropagation()
    setHiddenKeys((current) => new Set(current).add(item.key))
    try {
      await call('notifications', 'dismiss', { notificationKey: item.key })
      await reload()
      setHiddenKeys((current) => {
        const next = new Set(current)
        next.delete(item.key)
        return next
      })
    } catch {
      setHiddenKeys((current) => {
        const next = new Set(current)
        next.delete(item.key)
        return next
      })
    }
  }

  async function clearAll(): Promise<void> {
    const keys = items.map((item) => item.key)
    setConfirmClear(false)
    setHiddenKeys((current) => new Set([...current, ...keys]))
    try {
      await call('notifications', 'clearAll')
      await reload()
      setHiddenKeys(new Set())
    } catch {
      setHiddenKeys((current) => {
        const next = new Set(current)
        for (const key of keys) next.delete(key)
        return next
      })
    }
  }

  const items = (data?.items ?? []).filter((item) => !hiddenKeys.has(item.key))
  // The feed is bounded; main's counts describe every active alert.
  const hiddenUnread = (data?.items ?? []).filter((item) => hiddenKeys.has(item.key) && !item.read).length
  const unreadCount = Math.max((data?.unreadCount ?? 0) - hiddenUnread, 0)
  const notShownCount = Math.max((data?.totalCount ?? 0) - (data?.items.length ?? 0), 0)

  return (
    <div className="notif-bell" ref={containerRef}>
      <button
        type="button"
        className="headbar-icon-btn"
        onClick={() => void toggle()}
        aria-label={`الإشعارات${unreadCount > 0 ? ` (${unreadCount} غير مقروءة)` : ''}`}
        title="الإشعارات"
      >
        <Bell size={18} strokeWidth={2.25} aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="notif-bell__badge">{unreadCount > 99 ? '٩٩+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notif-dropdown" role="menu">
          <div className="notif-dropdown__head">
            <span>الإشعارات</span>
            {items.length > 0 && (
              <button type="button" className="notif-dropdown__clear" onClick={() => setConfirmClear(true)}>
                مسح الكل
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="notif-dropdown__empty">لا توجد إشعارات حالياً</p>
          ) : (
            <div className="notif-dropdown__list">
              {items.map((item) => {
                const Icon = CATEGORY_ICON[item.category]
                return (
                  <div
                    key={item.key}
                    role="menuitem"
                    tabIndex={0}
                    className={`notif-item ${!item.read ? 'notif-item--unread' : ''}`}
                    onClick={() => openItem(item)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return
                      if (event.key === 'Enter' || event.key === ' ') openItem(item)
                    }}
                  >
                    <span className="notif-item__icon"><Icon size={15} strokeWidth={2.25} aria-hidden="true" /></span>
                    <span className="notif-item__body">
                      <span className="notif-item__title">{item.title}</span>
                      <span className="notif-item__desc">{item.description}</span>
                      <span className="notif-item__date">{fmtDateTime(item.occurredAt)}</span>
                    </span>
                    {!item.read && <span className="notif-item__dot" aria-hidden="true" />}
                    <button
                      type="button"
                      className="notif-item__delete"
                      title="حذف الإشعار"
                      aria-label="حذف الإشعار"
                      onClick={(event) => void dismissItem(event, item)}
                    >
                      <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                )
              })}
              {notShownCount > 0 && (
                <p className="notif-dropdown__empty">و{notShownCount} إشعاراً أقدم غير معروض</p>
              )}
            </div>
          )}
        </div>
      )}

      <Modal
        open={confirmClear}
        title="مسح جميع الإشعارات"
        onClose={() => setConfirmClear(false)}
        footer={(
          <>
            <Button variant="destructive" size="sm" onClick={() => void clearAll()}>مسح الكل</Button>
            <Button variant="secondary" size="sm" onClick={() => setConfirmClear(false)}>إلغاء</Button>
          </>
        )}
      >
        <p>هل تريد مسح جميع الإشعارات؟</p>
      </Modal>
    </div>
  )
}
