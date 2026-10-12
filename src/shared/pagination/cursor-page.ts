/**
 * DB-10 bounded read contract for histories that grow with the business.
 *
 * `items` is one server-bounded page in the endpoint's documented order.
 * Cursors are opaque, bound to the endpoint and its filters, and must be
 * passed back unchanged. `summary`, when present, always describes the
 * complete filtered set and never the visible page.
 */
export interface CursorPage<T, S = undefined> {
  items: T[]
  nextCursor: string | null
  prevCursor: string | null
  hasMore: boolean
  summary: S
}

/**
 * Measured on the DB-10 fixtures: the widest operational rows (exit permits
 * with teams and reversal tokens) serialize to ~650 bytes, so the maximum page
 * stays below ~70 KiB over IPC. Existing paged screens already used 25/50/100.
 */
export const PAGE_SIZE = {
  default: 50,
  max: 100,
  statement: 25
} as const

export const CURSOR_MAX_LENGTH = 512
export const SEARCH_MAX_LENGTH = 200
