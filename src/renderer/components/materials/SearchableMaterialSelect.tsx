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

export interface MaterialTypeOption {
  id: number
  sku: string
  name: string
  hierarchyPath?: string
}

function norm(value: string): string {
  return value.trim().toLocaleLowerCase()
}

/**
 * Pure filter, factored out exactly like `filterCustomerOptions` in
 * SearchableCustomerSelect — directly unit-testable without a DOM, and
 * a pure narrowing of its own input (so it can never surface a
 * material the caller didn't already load/permit).
 */
export function filterMaterialTypeOptions(
  materials: MaterialTypeOption[],
  query: string
): MaterialTypeOption[] {
  const q = norm(query)
  if (!q) return materials
  return materials.filter(
    (m) =>
      norm(m.name).includes(q) || norm(m.sku).includes(q) || norm(m.hierarchyPath ?? '').includes(q)
  )
}

/** Sentinel id for the pinned "no selection" row — never a real
 *  material id (those are DB auto-increment positive integers). */
const NONE_ID = -1

/**
 * The "نوع المادة" / "الإكسسوارات" picker for Preliminary/Approved
 * Invoice item rows — same role as the plain <Select> it replaces
 * (value/onChange contract: a stringified material id, or ''), with a
 * small search field that appears INSIDE the dropdown once opened.
 * Both fields share this one component because both already query the
 * exact same option shape ({id, sku, name}); `noneLabel`/`legacyLabel`
 * exist ONLY because accessories additionally needs an explicit
 * "— بدون —" clear option and a legacy-text display the native
 * <select> it replaces already had — passing neither (as نوع المادة's
 * call site does) reproduces its exact previous behavior unchanged.
 *
 * Structurally this is SearchableCustomerSelect's proven pattern
 * (query/active-index state, autofocus, keyboard nav, and —
 * critically — event.stopPropagation() on every handled key so
 * Escape closes only this dropdown and never also triggers the
 * surrounding invoice Modal's own global Escape-closes-the-modal
 * listener) reapplied to a different option shape, sharing its CSS
 * (see .customer-select* rules in global.css, written once and used
 * by every picker in this family).
 *
 * Open/close state and positioning are delegated, not reimplemented
 * here: `useSingleOpenDropdown` (dropdownCoordinator.ts) guarantees
 * this is never open at the same time as a sibling نوع المادة/كود
 * اللون/الإكسسوارات dropdown anywhere in the form, and `DropdownPanel`
 * portals+positions the actual panel so it opens below (or, flipped,
 * above) THIS field specifically, sized to it — never spilling into a
 * neighboring field's column the way an unpositioned popover would.
 *
 * Deliberately local-only filtering — the caller already loaded the
 * full active Raw Materials catalog via `materials.types` or
 * `materials.accessories` (both permission-gated the same lightweight
 * way), and this component only narrows that in-memory array.
 */
export function SearchableMaterialSelect({
  materials,
  value,
  onChange,
  disabled,
  placeholder = '— اختر —',
  searchPlaceholder = 'بحث عن مادة...',
  emptyText = 'لا توجد مادة مطابقة',
  noneLabel,
  legacyLabel
}: {
  materials: MaterialTypeOption[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** When set, pins a "no selection" row at the top of the dropdown
   *  — unaffected by search — that clears the field back to ''. Omit
   *  (نوع المادة's call site does) to keep no such row, exactly as
   *  before this correction. */
  noneLabel?: string
  /** Shows the saved label when its ID is absent from current options,
   *  including legacy free text and historical inactive associations. */
  legacyLabel?: string | null
}): ReactElement {
  const { isOpen: open, close, toggle } = useSingleOpenDropdown()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selectedMaterial = materials.find((m) => String(m.id) === value)
  const triggerLabel = selectedMaterial?.name ?? legacyLabel ?? undefined

  const filtered = useMemo(() => filterMaterialTypeOptions(materials, query), [materials, query])
  const results = useMemo(
    () => (noneLabel ? [{ id: NONE_ID, sku: '', name: noneLabel }, ...filtered] : filtered),
    [filtered, noneLabel]
  )

  useEffect(() => {
    setActiveIndex((current) => (results.length === 0 ? 0 : Math.min(current, results.length - 1)))
  }, [results.length])

  function closeAndReset(): void {
    close()
    setQuery('') // temporary UI state only — never persisted, never sent anywhere
  }

  function select(material: MaterialTypeOption): void {
    onChange(material.id === NONE_ID ? '' : String(material.id))
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
        <span className={triggerLabel ? '' : 'muted'}>{triggerLabel ?? placeholder}</span>
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
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
        </div>
        {results.length === 0 ? (
          <p className="customer-select__empty">{emptyText}</p>
        ) : (
          <ul className="customer-select__list" role="listbox">
            {results.map((m, index) => (
              <li
                key={m.id}
                role="option"
                aria-selected={m.id === NONE_ID ? value === '' : String(m.id) === value}
              >
                <button
                  type="button"
                  className={`customer-select__option ${index === activeIndex ? 'customer-select__option--active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(m)}
                >
                  <span className="customer-select__name">{m.name}</span>
                  {m.id !== NONE_ID && (
                    <span className="customer-select__phone">
                      {m.hierarchyPath?.split(' ← ').join(' › ') ?? m.sku}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* The pinned "بدون" row (when present) means `results` is
            never truly empty, so the branch above alone would never
            show "no match" while the user is searching. This covers
            that case without ever hiding the "بدون" row itself. */}
        {noneLabel && filtered.length === 0 && results.length > 0 && (
          <p className="customer-select__empty">{emptyText}</p>
        )}
      </DropdownPanel>
    </div>
  )
}
