/**
 * Per-field PDF visibility for the two customer-facing commercial
 * documents (Preliminary Invoice, Approved Invoice).
 *
 * A visibility flag answers exactly one question: "may this field be
 * RENDERED on the customer's PDF?". It is deliberately NOT a data
 * switch — the value itself stays stored, editable and, where it is a
 * money field, fully part of the invoice's arithmetic. Hiding سعر
 * التوصيل from the printout never changes what the customer owes.
 *
 * The set of keys is closed and typed: `parsePrintVisibility` drops
 * anything it does not recognise, so a renderer (or a hand-edited
 * document row) can never smuggle arbitrary JSON keys into a document.
 */

/**
 * Every field a user may choose to keep off the printed document.
 *
 * Internal/technical values are deliberately absent — ids, timestamps,
 * permission state and costing have no entry here and therefore cannot
 * be toggled into a customer document at all.
 */
export const PRINT_VISIBILITY_KEYS = [
  // Customer block
  'customerPhone',
  'customerAddress',
  'validUntil',
  // Item rows
  'description',
  'quantity',
  'unitPrice',
  'lineTotal',
  'specifications',
  'dimensions',
  'materialType',
  'colorCode',
  'accessories',
  // Commercial figures
  'meterPrice',
  'installationPrice',
  'deliveryPrice',
  'subtotal',
  'discount',
  'depositRequired',
  'remainingBalance',
  // Fulfilment statements ("يشمل التركيب" / "يشمل التوصيل")
  'includesInstallation',
  'includesDelivery',
  // Free text
  'notes',
  'termsAndConditions'
] as const

export type PrintVisibilityKey = (typeof PRINT_VISIBILITY_KEYS)[number]

/** A complete, resolved visibility map — every known key answered. */
export type PrintVisibility = Record<PrintVisibilityKey, boolean>

/** What a document stores: only the keys someone actually decided on. */
export type PrintVisibilityInput = Partial<Record<PrintVisibilityKey, boolean>>

/**
 * The defaults, chosen to reproduce the documents EXACTLY as they
 * printed before this feature existed, so that a legacy invoice (which
 * has no stored configuration at all) keeps rendering the way it
 * always did:
 *
 *  • `accessories` and `notes` are false because neither template ever
 *    printed them — turning them on is a new, opt-in choice;
 *  • everything the templates already printed is true;
 *  • the three new money fields are true, since a breakdown the user
 *    just entered is meant to be shown unless they say otherwise;
 *  • the two fulfilment statements are true, but they are additionally
 *    gated on the document's own `requiresInstallation` /
 *    `requiresDelivery` business booleans — visibility can only ever
 *    SUPPRESS the statement, never assert something untrue.
 */
export const DEFAULT_PRINT_VISIBILITY: PrintVisibility = {
  customerPhone: true,
  customerAddress: true,
  validUntil: true,
  description: true,
  quantity: true,
  unitPrice: true,
  lineTotal: true,
  specifications: true,
  dimensions: true,
  materialType: true,
  colorCode: true,
  accessories: false,
  meterPrice: true,
  installationPrice: true,
  deliveryPrice: true,
  subtotal: true,
  discount: true,
  depositRequired: true,
  remainingBalance: true,
  includesInstallation: true,
  includesDelivery: true,
  notes: false,
  termsAndConditions: true
}

const KEY_SET = new Set<string>(PRINT_VISIBILITY_KEYS)

export function isPrintVisibilityKey(key: string): key is PrintVisibilityKey {
  return KEY_SET.has(key)
}

/**
 * Narrows arbitrary input down to the known keys with boolean values.
 * Used at the service boundary so nothing unknown is ever persisted —
 * the renderer's state shape is never trusted as-is.
 */
export function sanitizePrintVisibility(input: unknown): PrintVisibilityInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out: PrintVisibilityInput = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isPrintVisibilityKey(key) && typeof value === 'boolean') out[key] = value
  }
  return out
}

/**
 * Resolves what a document actually stored into a complete map.
 *
 * `null`/`undefined`/unparseable — i.e. every document written before
 * this feature — resolves to the defaults above, which is what makes
 * legacy documents keep their original printed appearance.
 */
export function parsePrintVisibility(stored: string | null | undefined): PrintVisibility {
  if (!stored) return { ...DEFAULT_PRINT_VISIBILITY }
  let raw: unknown
  try {
    raw = JSON.parse(stored)
  } catch {
    return { ...DEFAULT_PRINT_VISIBILITY }
  }
  return { ...DEFAULT_PRINT_VISIBILITY, ...sanitizePrintVisibility(raw) }
}

/**
 * The one visibility question the document builders ask, so the rule
 * lives in a single place instead of being re-derived per template.
 */
export function shouldPrint(visibility: PrintVisibility, key: PrintVisibilityKey): boolean {
  return visibility[key]
}

/** Serialises a choice for storage; `{}` is stored as an empty object,
 *  which is meaningfully different from NULL (= never configured). */
export function serializePrintVisibility(input: PrintVisibilityInput): string {
  return JSON.stringify(sanitizePrintVisibility(input))
}
