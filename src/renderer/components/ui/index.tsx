import {
  useEffect,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'

/**
 * The AURA home design-system primitives. All colour, spacing and
 * typography comes from the tokens in theme/tokens.css (Step 2 §11) —
 * no component hard-codes a brand colour, so light/dark and any future
 * palette change flow through automatically.
 */

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive'
  size?: 'sm' | 'md'
}): ReactElement {
  return <button className={`btn btn--${variant} btn--${size} ${className ?? ''}`} {...props} />
}

export function Card({
  children,
  title,
  actions,
  className
}: PropsWithChildren<{ title?: ReactNode; actions?: ReactNode; className?: string }>): ReactElement {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card__head">
          {title && <h2 className="card__title">{title}</h2>}
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: ReactNode
  subtitle?: string
  actions?: ReactNode
}): ReactElement {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="page-head__sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </header>
  )
}

/**
 * The small "print this field on the PDF" switch that sits beside a
 * field's label on the two customer-facing invoice forms.
 *
 * It controls PRESENTATION ONLY: the field it belongs to stays
 * editable, stays saved, and — for money — stays part of the invoice's
 * arithmetic whether or not it is printed. Deliberately tiny and
 * label-adjacent so a form row gains a control, not a sentence; the
 * meaning is carried by `title`/`aria-label` instead of visible text.
 */
export function PrintToggle({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}): ReactElement {
  return (
    <input
      type="checkbox"
      className="print-toggle"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      title="إظهار في PDF"
      aria-label="إظهار في PDF"
    />
  )
}

export function Field({
  label,
  hint,
  error,
  children,
  required,
  print
}: PropsWithChildren<{
  label: string
  hint?: string
  error?: string
  required?: boolean
  /** When given, renders a PrintToggle beside the label. */
  print?: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }
}>): ReactElement {
  const body = (
    <>
      <span className="field__label">
        {label}
        {required && <span className="field__req"> *</span>}
        {print && (
          <PrintToggle checked={print.checked} onChange={print.onChange} disabled={print.disabled} />
        )}
      </span>
      {children}
      {hint && !error && <span className="field__hint">{hint}</span>}
      {error && <span className="field__error">{error}</span>}
    </>
  )
  // A <label> implicitly targets its FIRST labelable descendant, which
  // with a print toggle present would be the toggle rather than the
  // field's own control — clicking the caption would then flip the
  // print switch. Rows that carry a toggle therefore render as a plain
  // <div>; every other field keeps the exact <label> it has always had.
  return print ? <div className="field">{body}</div> : <label className="field">{body}</label>
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>): ReactElement {
  // Numeric inputs stay LTR so digits and separators read correctly
  // inside the RTL layout, while still using Western digits (BR-27).
  const numeric = props.type === 'number'
  return <input className={`input ${numeric ? 'input--num' : ''} ${className ?? ''}`} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactElement {
  return <textarea className={`input input--area ${className ?? ''}`} {...props} />
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  return (
    <select className={`input ${className ?? ''}`} {...props}>
      {children}
    </select>
  )
}

export type Column<T> = {
  key: string
  header: string
  render: (row: T) => ReactNode
  numeric?: boolean
  width?: string
}

export function DataTable<T>({
  columns,
  rows,
  empty = 'لا توجد بيانات',
  loading,
  onRowClick,
  rowKey
}: {
  columns: Array<Column<T>>
  rows: T[]
  empty?: string
  loading?: boolean
  onRowClick?: (row: T) => void
  rowKey: (row: T, index: number) => string | number
}): ReactElement {
  if (loading) return <div className="state">جارٍ التحميل…</div>
  if (!rows.length) return <div className="state">{empty}</div>
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.numeric ? 'numeric' : ''} style={{ width: column.width }}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? 'clickable' : ''}
            >
              {columns.map((column) => (
                <td key={column.key} className={column.numeric ? 'numeric' : ''}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide
}: PropsWithChildren<{
  open: boolean
  title: string
  onClose: () => void
  footer?: ReactNode
  wide?: boolean
}>): ReactElement | null {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={`modal ${wide ? 'modal--wide' : ''}`}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal__head">
          <h2>{title}</h2>
          <button className="modal__close" onClick={onClose} aria-label="إغلاق">
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function Badge({
  children,
  tone = 'neutral'
}: PropsWithChildren<{ tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }>): ReactElement {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export function Toolbar({ children }: PropsWithChildren): ReactElement {
  return <div className="toolbar">{children}</div>
}

/**
 * KPI card. `icon` is optional presentation only — when given it
 * renders in the soft rounded icon container above the figure (the
 * Soft UI treatment used across the app); when omitted the card
 * simply starts at the value, so every existing call site keeps
 * working unchanged. The figure leads and the label follows it, so
 * the number is the loudest thing in the card.
 */
export function Stat({
  label,
  value,
  tone,
  hint,
  icon
}: {
  label: string
  value: ReactNode
  tone?: 'success' | 'danger' | 'brand'
  hint?: string
  icon?: ReactNode
}): ReactElement {
  return (
    <div className={`stat ${tone ? `stat--${tone}` : ''}`}>
      {icon && <span className="stat__icon" aria-hidden="true">{icon}</span>}
      <div className="stat__value money">{value}</div>
      <div className="stat__label">{label}</div>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  )
}

export function ErrorNote({ children }: PropsWithChildren): ReactElement | null {
  if (!children) return null
  return <div className="error-note">{children}</div>
}

/**
 * Previous/next navigation for a server-bounded history page. The count is
 * the server's authoritative filtered total when the endpoint provides one.
 */
export function Pager({
  pageIndex,
  hasPrev,
  hasNext,
  loading,
  onPrev,
  onNext,
  totalCount,
  pageSize,
  noun
}: {
  pageIndex: number
  hasPrev: boolean
  hasNext: boolean
  loading?: boolean
  onPrev: () => void
  onNext: () => void
  totalCount?: number
  pageSize?: number
  noun?: string
}): ReactElement | null {
  if (!hasPrev && !hasNext && totalCount === undefined) return null
  const pages = totalCount !== undefined && pageSize ? Math.max(Math.ceil(totalCount / pageSize), 1) : undefined
  return (
    <Toolbar>
      <Button variant="secondary" disabled={!hasPrev || loading} onClick={onPrev}>
        السابق
      </Button>
      <span>
        صفحة {pageIndex + 1}
        {pages !== undefined ? ` من ${pages}` : ''}
        {totalCount !== undefined ? ` — ${totalCount}${noun ? ` ${noun}` : ''}` : ''}
      </span>
      <Button variant="secondary" disabled={!hasNext || loading} onClick={onNext}>
        التالي
      </Button>
    </Toolbar>
  )
}

/** "Load more" for append-mode histories; hidden once the server reports the end. */
export function LoadMore({ hasNext, loading, onClick }: { hasNext: boolean; loading?: boolean; onClick: () => void }): ReactElement | null {
  if (!hasNext) return null
  return (
    <Toolbar>
      <Button variant="secondary" disabled={loading} onClick={onClick}>
        {loading ? 'جارٍ التحميل…' : 'عرض المزيد'}
      </Button>
    </Toolbar>
  )
}
