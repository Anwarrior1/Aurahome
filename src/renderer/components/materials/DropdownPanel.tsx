import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

const VIEWPORT_MARGIN = 8
const TRIGGER_OFFSET = 4
const MIN_USABLE_HEIGHT = 160

// Above the invoice Modal's own backdrop (z-index 50, see .modal-backdrop
// in global.css) so an open dropdown is never rendered behind it once
// portaled out of the modal's DOM subtree — but still below toasts
// (z-index 100), which must stay on top of everything, this included.
const PANEL_Z_INDEX = 60

/**
 * Measures `anchor` against the viewport and returns inline styles for
 * a `position: fixed` panel anchored to it: below by default, flipped
 * above when there isn't reasonable room below and there's more room
 * above; capped in height so it always fits the side it was placed on.
 *
 * Width and horizontal position are taken directly from the anchor —
 * this is the equivalent, for a hand-built popover, of a library's
 * "match trigger width" mechanism (e.g. Radix's
 * `--radix-popover-trigger-width`): the panel is exactly as wide as
 * its own field and aligned to both its edges, never wider and never
 * drifting into a neighboring field or the Sidebar, regardless of how
 * long its result text is. The `Math.min(anchor.width, ...)` and the
 * edge clamps below are a last-resort safety net only (an anchor
 * literally wider than the viewport never happens in this form) — not
 * the mechanism that decides the panel's width.
 *
 * `position: fixed` here — not `absolute` — is what lets the panel,
 * once portaled to `document.body`, escape the invoice Modal's own
 * `overflow-y: auto` body (which would otherwise clip or force a
 * scrollbar around a panel near the bottom of a long form).
 *
 * Always positions with `top` (never `bottom`) — including when
 * flipped above the trigger. That case needs the panel's own
 * (not-yet-known-on-first-render) height to pin its bottom edge just
 * above the trigger, so `measuredHeight` is undefined on the first,
 * provisional pass and supplied by the caller's ResizeObserver once
 * the panel actually exists in the DOM (see the component below).
 */
function computeStyle(anchor: DOMRect, measuredHeight: number | undefined): CSSProperties {
  const vw = window.innerWidth
  const vh = window.innerHeight

  const width = Math.min(anchor.width, vw - VIEWPORT_MARGIN * 2)
  let left = anchor.left
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN
  if (left + width > vw - VIEWPORT_MARGIN) left = vw - VIEWPORT_MARGIN - width

  const spaceBelow = vh - anchor.bottom - TRIGGER_OFFSET - VIEWPORT_MARGIN
  const spaceAbove = anchor.top - TRIGGER_OFFSET - VIEWPORT_MARGIN
  const placeBelow = spaceBelow >= MIN_USABLE_HEIGHT || spaceBelow >= spaceAbove

  // The shared .customer-select__dropdown class (also used, untouched,
  // by the Customer selector) still carries `min-width: 240px` for
  // that selector's own always-wide field. Pinning minWidth/maxWidth
  // here too — not just width — overrides that per the normal CSS
  // rule that inline styles win over a stylesheet, without editing
  // the shared class (and therefore without touching Customer at all).
  //
  // That same shared class also still sets `inset-inline-start: 0` —
  // a LOGICAL property, which in this RTL app (`<html dir="rtl">`)
  // resolves to a physical `right: 0`. Left unaddressed, that clashes
  // with the physical `left` this panel sets: per the CSS2.1 rule for
  // an over-constrained absolutely/fixed-positioned box in a
  // right-to-left context, the browser discards `left` and solves the
  // position from `right` + `width` instead — which is exactly why
  // the panel was rendering flush against the far right of the
  // viewport (over the Sidebar) regardless of the trigger's own
  // position. Resetting the SAME logical property inline is what
  // actually neutralizes it — an inline physical `right` would be a
  // different property in the cascade and wouldn't reliably win.
  const base = { insetInlineStart: 'auto' } as const
  if (placeBelow) {
    return {
      ...base,
      position: 'fixed', zIndex: PANEL_Z_INDEX,
      top: anchor.bottom + TRIGGER_OFFSET, left, width, minWidth: width, maxWidth: width,
      maxHeight: Math.max(spaceBelow, MIN_USABLE_HEIGHT)
    }
  }

  const height = measuredHeight ?? spaceAbove
  const top = Math.max(VIEWPORT_MARGIN, anchor.top - TRIGGER_OFFSET - height)
  return {
    ...base,
    position: 'fixed', zIndex: PANEL_Z_INDEX,
    top, left, width, minWidth: width, maxWidth: width,
    maxHeight: Math.max(spaceAbove, MIN_USABLE_HEIGHT)
  }
}

/**
 * Shared floating panel for the نوع المادة / كود اللون/التشطيب /
 * الإكسسوارات searchable dropdowns (SearchableMaterialSelect,
 * SearchableColorSelect). Portals into `document.body` and
 * self-positions with `computeStyle` above, so it always renders
 * below (or, flipped, above) its own trigger, sized to that trigger,
 * never clipped by the Modal and never spilling into a neighboring
 * field's column.
 *
 * Also owns outside-click detection: with the panel portaled away
 * from the trigger's own DOM subtree, a plain `containerRef.contains`
 * check would wrongly treat a click on an option as "outside" — this
 * checks both the trigger's container and the portaled panel itself.
 */
export function DropdownPanel({
  anchorRef,
  open,
  onClose,
  className,
  children,
  initialFocusRef
}: {
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  className: string
  children: ReactNode
  /** Focused once the portaled panel actually exists in the DOM. A
   *  caller can't safely focus its own search input the moment `open`
   *  becomes true — on that very first render this panel still
   *  returns null (position isn't measured yet), so the input doesn't
   *  exist yet either. Owning the focus call here, timed off `style`
   *  actually being set, is what makes it land reliably. */
  initialFocusRef?: RefObject<HTMLElement | null>
}): ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>()

  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined)
      return
    }
    const reposition = (): void => {
      const anchor = anchorRef.current
      if (anchor) setStyle(computeStyle(anchor.getBoundingClientRect(), panelRef.current?.offsetHeight))
    }
    reposition()
    // The modal body scrolls (`.modal__body { overflow-y: auto }`),
    // and the window can resize — both move the trigger relative to
    // the viewport that this fixed-position panel is measured against.
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, anchorRef])

  // Corrects the provisional "flipped above" guess (computeStyle's
  // first pass has no way to know the panel's own height, since it
  // doesn't exist in the DOM yet) once it actually mounts, and keeps
  // correcting it if the content's height changes afterward — typing
  // a search narrows the option list, which can shrink the panel
  // while it's still open. Also covers the (`below`) case: pinning
  // its width already came from the anchor, so a same-value
  // recomputation there is a harmless no-op.
  useLayoutEffect(() => {
    if (!open || !style) return
    const panel = panelRef.current
    const anchor = anchorRef.current
    if (!panel || !anchor) return
    const observer = new ResizeObserver(() => {
      setStyle(computeStyle(anchor.getBoundingClientRect(), panel.offsetHeight))
    })
    observer.observe(panel)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, Boolean(style), anchorRef])

  // Fires once `style` actually lands — which is also the render
  // where the portal's children (the search input included) are
  // first committed to the DOM — rather than off `open` directly.
  useEffect(() => {
    if (open && style) initialFocusRef?.current?.focus()
  }, [open, style, initialFocusRef])

  useEffect(() => {
    if (!open) return
    function onOutsideClick(event: MouseEvent): void {
      const target = event.target as Node
      if (anchorRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      onClose()
    }
    // Capture phase, deliberately: the invoke Modal's own dialog box
    // calls event.stopPropagation() on ITS mousedown handler for any
    // click landing inside it (that's what stops a click on the form
    // from bubbling out to the backdrop and closing the whole Modal) —
    // which would also silently swallow a bubble-phase listener here
    // before it ever saw a click on, say, a neighboring field. Capture
    // fires on the way down, before that stopPropagation runs, so this
    // still sees every outside click regardless of it.
    document.addEventListener('mousedown', onOutsideClick, true)
    return () => document.removeEventListener('mousedown', onOutsideClick, true)
  }, [open, anchorRef, onClose])

  if (!open || !style) return null
  return createPortal(
    <div ref={panelRef} className={className} style={style}>{children}</div>,
    document.body
  )
}
