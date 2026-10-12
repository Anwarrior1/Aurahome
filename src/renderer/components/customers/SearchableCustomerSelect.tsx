import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { ChevronDown, Search } from 'lucide-react'

export interface CustomerOption {
  id: number
  name: string
  phone?: string | null
}

/**
 * A normalized comparison key: case-folded (Latin text) and trimmed,
 * so "  Anwar" / "anwar" / "ANWAR" all match the same query. Arabic
 * has no case to fold, so Arabic text passes through unchanged and
 * still matches correctly via plain substring search.
 */
function norm(value: string): string {
  return value.trim().toLocaleLowerCase()
}

/**
 * The actual filter, factored out as a pure function so it is directly
 * unit-testable without a DOM: given the caller's already-loaded (and
 * already RBAC/active-scoped) customer list and the current search
 * text, returns the subset to display. An empty/whitespace-only query
 * returns the full list unchanged — this is a pure narrowing of its
 * input, never a data source of its own, so it can never surface a
 * customer the caller didn't already pass in.
 */
export function filterCustomerOptions(customers: CustomerOption[], query: string): CustomerOption[] {
  const q = norm(query)
  if (!q) return customers
  return customers.filter((c) => norm(c.name).includes(q) || (c.phone != null && norm(c.phone).includes(q)))
}

/**
 * The customer picker for Preliminary/Approved Invoice forms — a
 * dropdown identical in role to the plain `<Select>` it replaces
 * (same value/onChange contract: a stringified customer id, or ''),
 * but with a small search field that appears INSIDE the dropdown once
 * opened, filtering the ALREADY-LOADED customer list the caller
 * passes in.
 *
 * The component itself never queries: it narrows the array the caller
 * passes in, so it can never show a customer the caller didn't load.
 * Customers grow with sales, so callers load a bounded, server-searched
 * page (`customers.list` with `activeOnly` and `search`) and receive the
 * typed query through `onSearchChange`; `selectedLabel` names a chosen
 * customer that is no longer part of the current result page.
 */
export function SearchableCustomerSelect({
  customers,
  value,
  onChange,
  disabled,
  placeholder = '— اختر —',
  onSearchChange,
  selectedLabel
}: {
  customers: CustomerOption[]
  value: string
  onChange: (id: string, customer?: CustomerOption) => void
  disabled?: boolean
  placeholder?: string
  onSearchChange?: (query: string) => void
  selectedLabel?: string
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selected = customers.find((c) => String(c.id) === value)
  const label = selected?.name ?? (value ? selectedLabel : undefined)

  useEffect(() => {
    onSearchChange?.(query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const results = useMemo(() => filterCustomerOptions(customers, query), [customers, query])

  // Re-clamped on every filter change so a stale index from a longer
  // list never points past the end of a shorter, freshly-filtered one.
  useEffect(() => {
    setActiveIndex((current) => (results.length === 0 ? 0 : Math.min(current, results.length - 1)))
  }, [results.length])

  function closeAndReset(): void {
    setOpen(false)
    setQuery('') // temporary UI state only — never persisted, never sent anywhere
  }

  function select(customer: CustomerOption): void {
    onChange(String(customer.id), customer)
    closeAndReset()
  }

  useEffect(() => {
    if (!open) return
    // Autofocus the search field the moment the dropdown opens.
    searchRef.current?.focus()
    function onOutsideClick(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) closeAndReset()
    }
    document.addEventListener('mousedown', onOutsideClick)
    return () => document.removeEventListener('mousedown', onOutsideClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    // Every key handled here is fully consumed by the dropdown, so it
    // must never bubble past this input — without stopPropagation,
    // Escape in particular also reaches the surrounding invoice
    // Modal's own global Escape-closes-the-modal listener, silently
    // discarding the whole in-progress invoice just for backing out
    // of a customer search.
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
      // Let focus move on naturally — just stop carrying stale search
      // state into the next time the dropdown opens.
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
          setOpen((current) => !current)
          if (open) setQuery('')
        }}
      >
        <span className={label ? '' : 'muted'}>{label ?? placeholder}</span>
        <ChevronDown size={15} strokeWidth={2.25} aria-hidden="true" className="customer-select__chevron" />
      </button>

      {open && (
        <div className="customer-select__dropdown">
          <div className="customer-select__search">
            <Search size={14} strokeWidth={2.25} aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActiveIndex(0) }}
              onKeyDown={onSearchKeyDown}
              placeholder="بحث عن عميل..."
              aria-label="بحث عن عميل"
            />
          </div>
          {results.length === 0 ? (
            <p className="customer-select__empty">لا يوجد عميل مطابق</p>
          ) : (
            <ul className="customer-select__list" role="listbox">
              {results.map((c, index) => (
                <li key={c.id} role="option" aria-selected={String(c.id) === value}>
                  <button
                    type="button"
                    className={`customer-select__option ${index === activeIndex ? 'customer-select__option--active' : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => select(c)}
                  >
                    <span className="customer-select__name">{c.name}</span>
                    {c.phone && <span className="customer-select__phone">{c.phone}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
