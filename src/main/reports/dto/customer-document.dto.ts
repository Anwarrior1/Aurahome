/**
 * BR-73/BR-63: the type itself is the enforcement — cost, machine,
 * labor, supplier and profit fields DO NOT EXIST here, so no template
 * bug can ever print them on a customer-facing document.
 */
export interface CustomerDocumentDTO {
  documentNumber: string
  issuedAt: string
  customer: { name: string; phone?: string; address?: string }
  lines: Array<{
    description: string
    specifications?: string
    materialGroups?: Array<{ material?: string; colors?: string }>
    unmappedColors?: string
    materialType?: string
    dimensions?: string
    colorCode?: string
    accessories?: string
    quantity: string // pre-formatted, Western digits
    unitPrice: string
    lineTotal: string
  }>
  /**
   * Which of the items table's own columns this document is allowed to
   * print, resolved directly from the document's print-visibility
   * configuration (never inferred from a line's formatted text being
   * empty — a line legitimately has no way to have an empty quantity
   * otherwise, but relying on that would be guessing at intent from a
   * side effect instead of stating it). The template builds the
   * `<thead>` and every row's cells from this map, so an unchecked
   * column is missing from the table entirely — no header, no cell, no
   * reserved width — rather than present with a blank value.
   */
  itemColumns: {
    description: boolean
    quantity: boolean
    unitPrice: boolean
    lineTotal: boolean
  }
  subtotal: string
  discount?: string
  /**
   * The commercial rate quoted per metre. Informational only — it is
   * never part of the arithmetic below, and is absent unless the
   * document both has one and is allowed to print it.
   */
  meterPrice?: string
  /**
   * Additional charges, each already counted exactly once inside
   * `totalAfterDiscount`. Absent when zero OR when the document's print
   * visibility hides the row — hiding a row never changes the total, so
   * a hidden charge stays silently inside the final figure.
   */
  installationPrice?: string
  deliveryPrice?: string
  totalAfterDiscount: string
  depositRequired?: string
  /** Amount collected so far — always from the payment ledger (item 33). */
  paidAmount?: string
  remainingBalance?: string
  /** Arabic payment-status label, e.g. "مدفوع بالكامل" (item 34). */
  paymentStatus?: string
  /** The customer order this final invoice bills (item 34). */
  orderReference?: string
  /** Delivery/installation reference, when the document should show it. */
  fulfillmentReference?: string
  validUntil?: string
  /** Document notes, when the document is allowed to print them. */
  notes?: string
  /**
   * Fulfilment statements. Present ONLY when the document's own
   * business boolean says so — print visibility can suppress the
   * statement but can never manufacture it (a PDF must never claim
   * installation is included when the invoice says it is not).
   */
  includesInstallation?: boolean
  includesDelivery?: boolean
  termsAndConditions?: string[]
}
