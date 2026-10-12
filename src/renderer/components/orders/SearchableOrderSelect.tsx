import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { DropdownPanel } from '../materials/DropdownPanel'
import { useSingleOpenDropdown } from '../materials/dropdownCoordinator'
import { useQuery } from '@renderer/lib/useQuery'
import { usePagedQuery } from '@renderer/lib/usePagedQuery'

export interface CustomerOrderOption {
  id: number
  documentNumber: string
  customerName: string
}

export function filterOrderOptions(orders: CustomerOrderOption[], query: string): CustomerOrderOption[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return orders
  return orders.filter((order) =>
    order.documentNumber.toLocaleLowerCase().includes(normalized) ||
    order.customerName.toLocaleLowerCase().includes(normalized)
  )
}

type SpecialOption = { value: string; label: string }

/** Existing picker; server mode keeps historical relationships searchable without loading history. */
export function SearchableOrderSelect({
  orders,
  value,
  onChange,
  mode = 'assignment',
  disabled,
  selectedLabel,
  serverSearch = false,
  emptyLabel
}: {
  orders: CustomerOrderOption[]
  value: string
  onChange: (value: string) => void
  mode?: 'assignment' | 'filter'
  disabled?: boolean
  selectedLabel?: string
  serverSearch?: boolean
  emptyLabel?: string
}): ReactElement {
  const { isOpen: open, close, toggle } = useSingleOpenDropdown()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const remote = usePagedQuery<CustomerOrderOption>('orders', 'list', { search: query, includeArchived: true }, { limit: 50, enabled: serverSearch && open && !disabled })
  const selected = useQuery<{ order: { id: number; documentNumber: string }; customer?: { name: string } }>('orders', 'get', { id: Number(value) }, { enabled: serverSearch && /^\d+$/.test(value) && !disabled })
  const localFiltered = useMemo(() => filterOrderOptions(orders, query), [orders, query])
  const filtered = serverSearch ? remote.items : localFiltered
  const special: SpecialOption[] = mode === 'filter'
    ? [{ value: 'all', label: 'كل الطلبات' }, { value: 'general', label: 'شراء عام' }]
    : [{ value: '', label: emptyLabel ?? 'شراء عام / بدون طلب' }]
  const results: Array<SpecialOption | CustomerOrderOption> = [...special, ...filtered]
  const selectedOrder = orders.find((order) => String(order.id) === value) ?? (selected.data?.order.id === Number(value) ? { documentNumber: selected.data.order.documentNumber, customerName: selected.data.customer?.name ?? '' } : undefined)
  const selectedSpecial = special.find((option) => option.value === value)
  const triggerLabel = selectedOrder
    ? `${selectedOrder.documentNumber} — ${selectedOrder.customerName}`
    : selectedSpecial?.label ?? selectedLabel ?? '— اختر —'

  useEffect(() => {
    setActiveIndex((current) => results.length ? Math.min(current, results.length - 1) : 0)
  }, [results.length])

  function closeAndReset(): void {
    close()
    setQuery('')
  }

  function select(option: SpecialOption | CustomerOrderOption): void {
    onChange('value' in option ? option.value : String(option.id))
    closeAndReset()
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault(); event.stopPropagation()
      setActiveIndex((index) => results.length ? (index + 1) % results.length : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation()
      setActiveIndex((index) => results.length ? (index - 1 + results.length) % results.length : 0)
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation()
      const option = results[activeIndex]
      if (option) select(option)
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); closeAndReset()
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
        onClick={() => { if (!disabled) toggle() }}
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={15} strokeWidth={2.25} aria-hidden="true" className="customer-select__chevron" />
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
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
            onKeyDown={onSearchKeyDown}
            placeholder="بحث برقم الطلب أو اسم العميل..."
            aria-label="بحث برقم الطلب أو اسم العميل"
          />
        </div>
        {serverSearch && remote.loading && <p className="customer-select__empty">جارٍ البحث...</p>}
        {serverSearch && remote.error && <p className="customer-select__empty" role="alert">{remote.error}</p>}
        <ul className="customer-select__list" role="listbox">
          {results.map((option, index) => {
            const optionValue = 'value' in option ? option.value : String(option.id)
            return (
              <li key={'value' in option ? option.value || 'general' : option.id} role="option" aria-selected={optionValue === value}>
                <button
                  type="button"
                  className={`customer-select__option ${index === activeIndex ? 'customer-select__option--active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(option)}
                >
                  {'value' in option ? (
                    <span className="customer-select__name">{option.label}</span>
                  ) : (
                    <>
                      <span className="customer-select__name">{option.documentNumber}</span>
                      <span className="customer-select__phone">{option.customerName}</span>
                    </>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
        {filtered.length === 0 && query.trim() && !remote.loading && (
          <p className="customer-select__empty">لا يوجد طلب مطابق</p>
        )}
      </DropdownPanel>
    </div>
  )
}
