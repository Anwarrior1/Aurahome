import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { DropdownPanel } from './DropdownPanel'
import { useSingleOpenDropdown } from './dropdownCoordinator'

export interface ColorOption {
  id: number
  code: string
  name: string
}

function norm(value: string): string {
  return value.trim().toLocaleLowerCase()
}

/**
 * Pure filter, matching a color/finish by its code OR its name — the
 * same two fields the option row already shows. Directly
 * unit-testable without a DOM, and a pure narrowing of its own input.
 */
export function filterColorOptions(colors: ColorOption[], query: string): ColorOption[] {
  const q = norm(query)
  if (!q) return colors
  return colors.filter((c) => norm(c.code).includes(q) || norm(c.name).includes(q))
}

export function colorOptionValue(color: ColorOption, valueMode: 'code' | 'id' = 'code'): string {
  return valueMode === 'id' ? String(color.id) : color.code
}

/** Sentinel id for the pinned "بدون" row — never a real color id. */
const NONE_ID = -1

/**
 * The "كود اللون/التشطيب" picker for Preliminary/Approved Invoice item
 * rows. Unlike SearchableMaterialSelect this is keyed by the color's
 * CODE (a string), not a numeric id — colorCode has always been
 * stored as the plain code string on the line, with no separate
 * reference+snapshot resolution needed, so `value`/`onChange` carry
 * that code directly.
 *
 * Structurally this is the same proven pattern as
 * SearchableCustomerSelect/SearchableMaterialSelect (query/
 * active-index state, autofocus, keyboard nav, and
 * event.stopPropagation() on every handled key so Escape closes only
 * this dropdown and never the surrounding invoice Modal too), sharing
 * the same CSS (.customer-select* in global.css) so all three pickers
 * read as one consistent component family.
 *
 * Open/close state and positioning are delegated, not reimplemented
 * here: `useSingleOpenDropdown` (dropdownCoordinator.ts) guarantees
 * this is never open at the same time as a sibling نوع المادة/كود
 * اللون/الإكسسوارات dropdown anywhere in the form, and `DropdownPanel`
 * portals+positions the actual panel so it opens below (or, flipped,
 * above) THIS field specifically, sized to it — never spilling into a
 * neighboring field's column the way an unpositioned popover would.
 *
 * The "— بدون —" row is always pinned at the top (unaffected by
 * search), exactly reproducing the native <select>'s always-present
 * first option. Inventory-leaf creation reuses this component in
 * stable-id mode; invoice callers keep the default code mode.
 */
export function SearchableColorSelect({
  colors,
  value,
  onChange,
  disabled,
  noneLabel,
  historicalValueLabel,
  valueMode = 'code'
}: {
  colors: ColorOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** The exact "بدون" wording this call site already used on its
   *  native <select> — kept per-caller since the two invoice pages
   *  currently word it slightly differently ("— بدون —" vs "—"). */
  noneLabel: string
  /** Optional snapshot label for historical consumers whose saved code
   *  no longer appears in the active catalog. Invoice callers omit this,
   *  so their existing behaviour is unchanged. */
  historicalValueLabel?: string
  /** Invoices persist a historical code string; inventory leaves persist
   * the authoritative Color Catalog id. */
  valueMode?: 'code' | 'id'
}): ReactElement {
  const { isOpen: open, close, toggle } = useSingleOpenDropdown()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const optionValue = (color: ColorOption): string => colorOptionValue(color, valueMode)
  const selectedColor = colors.find((color) => optionValue(color) === value)
  const triggerLabel = selectedColor
    ? `${selectedColor.code} — ${selectedColor.name}`
    : value
      ? historicalValueLabel
      : undefined

  const filtered = useMemo(() => filterColorOptions(colors, query), [colors, query])
  const results = useMemo(
    () => [{ id: NONE_ID, code: '', name: noneLabel }, ...filtered],
    [filtered, noneLabel]
  )

  useEffect(() => {
    setActiveIndex((current) => (results.length === 0 ? 0 : Math.min(current, results.length - 1)))
  }, [results.length])

  function closeAndReset(): void {
    close()
    setQuery('') // temporary UI state only — never persisted, never sent anywhere
  }

  function select(color: ColorOption): void {
    onChange(color.id === NONE_ID ? '' : optionValue(color))
    closeAndReset()
  }

  useEffect(() => {
    // Autofocus is owned by DropdownPanel (see `initialFocusRef` below)
    // — it alone knows when the portaled search input actually exists.
    if (!open) setQuery('') // covers every close path, including one forced by a sibling dropdown opening
  }, [open])

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.stopPropagation()
      setActiveIndex((i) => (results.length ? (i + 1) % results.length : 0))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      setActiveIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      const pick = results[activeIndex]
      if (pick) select(pick)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeAndReset()
    } else if (event.key === 'Tab') {
      closeAndReset()
    }
  }

  return (
    <div className="customer-select" ref={containerRef}>
      <button
        type="button"
        className="customer-select__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (disabled) return
          toggle()
        }}
      >
        <span className={triggerLabel ? '' : 'muted'}>{triggerLabel ?? noneLabel}</span>
        <ChevronDown
          size={15}
          strokeWidth={2.25}
          aria-hidden="true"
          className="customer-select__chevron"
        />
      </button>

      <DropdownPanel
        anchorRef={containerRef}
        open={open}
        onClose={closeAndReset}
        className="customer-select__dropdown"
        initialFocusRef={searchRef}
      >
        <div className="customer-select__search">
          <Search size={14} strokeWidth={2.25} aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="بحث عن كود لون أو تشطيب..."
            aria-label="بحث عن كود لون أو تشطيب"
          />
        </div>
        <ul className="customer-select__list" role="listbox">
          {results.map((c, index) => (
            <li
              key={c.id}
              role="option"
              aria-selected={c.id === NONE_ID ? value === '' : optionValue(c) === value}
            >
              <button
                type="button"
                className={`customer-select__option ${index === activeIndex ? 'customer-select__option--active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(c)}
              >
                <span className="customer-select__name">{c.name}</span>
                {c.id !== NONE_ID && <span className="customer-select__phone">{c.code}</span>}
              </button>
            </li>
          ))}
        </ul>
        {/* The pinned "بدون" row means the list is never truly empty,
            so this covers the "no match" case without ever hiding
            that row — the user can always fall back to بدون. */}
        {filtered.length === 0 && (
          <p className="customer-select__empty">لا يوجد كود لون/تشطيب مطابق</p>
        )}
      </DropdownPanel>
    </div>
  )
}
