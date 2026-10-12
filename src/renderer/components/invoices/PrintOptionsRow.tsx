import type { ReactElement } from 'react'

/**
 * A compact strip of "إظهار في PDF" switches for printable details the
 * invoice form does not itself edit — the customer's phone and address
 * (which come from the customer card), the validity date (set at
 * issuing), the terms block.
 *
 * They need a print choice like every other printable field, but they
 * have no input of their own to sit beside, so they are grouped here
 * instead of being given placeholder inputs that would only pretend to
 * be editable.
 */
export function PrintOptionsRow({
  title,
  options
}: {
  title: string
  options: Array<{ label: string; checked: boolean; onChange: (next: boolean) => void }>
}): ReactElement {
  return (
    <div className="print-options">
      <span className="print-options__title">{title}</span>
      {options.map((option) => (
        <label key={option.label} className="print-options__item">
          <input
            type="checkbox"
            className="print-toggle"
            checked={option.checked}
            onChange={(event) => option.onChange(event.target.checked)}
            aria-label={`إظهار ${option.label} في PDF`}
            title={`إظهار ${option.label} في PDF`}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
}
