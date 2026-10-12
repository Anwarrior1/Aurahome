import { useCallback, useState } from 'react'
import {
  DEFAULT_PRINT_VISIBILITY,
  parsePrintVisibility,
  type PrintVisibility,
  type PrintVisibilityInput,
  type PrintVisibilityKey
} from '@shared/documents/print-visibility'

/**
 * Per-field "إظهار في PDF" state for the two invoice forms.
 *
 * Shared so the Preliminary and Approved Invoice can never drift apart
 * on what the toggles mean, what they default to, or how they are sent
 * to the service. The state here is only the EDITING copy — the saved
 * document carries its own stored configuration, which `load()` puts
 * back when a document is reopened, so a choice survives save/close.
 */
export function usePrintVisibility(): {
  visibility: PrintVisibility
  /** Ready-made props for `<Field print={...}>`. */
  toggle: (key: PrintVisibilityKey) => { checked: boolean; onChange: (next: boolean) => void }
  /** What to send to the service on save. */
  payload: () => PrintVisibilityInput
  /** Restore a reopened document's saved choices (null ⇒ defaults). */
  load: (stored: string | null | undefined) => void
  reset: () => void
} {
  const [visibility, setVisibility] = useState<PrintVisibility>({ ...DEFAULT_PRINT_VISIBILITY })

  const toggle = useCallback(
    (key: PrintVisibilityKey) => ({
      checked: visibility[key],
      onChange: (next: boolean): void => setVisibility((current) => ({ ...current, [key]: next }))
    }),
    [visibility]
  )

  return {
    visibility,
    toggle,
    // Sent in full: an explicit map records what the user decided,
    // including every deliberate "off", rather than leaving the
    // document to fall back to defaults it never chose.
    payload: () => ({ ...visibility }),
    load: (stored) => setVisibility(parsePrintVisibility(stored)),
    reset: () => setVisibility({ ...DEFAULT_PRINT_VISIBILITY })
  }
}
