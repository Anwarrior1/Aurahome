/**
 * Generic shape for the operational reports in BR-25/BR-100. Row
 * content is filtered by the service according to the requesting
 * role before it ever reaches a template (BR-104).
 */
export interface ReportDTO<TRow> {
  title: string
  period?: { from: string; to: string }
  columns: string[]
  rows: TRow[]
  totals?: Record<string, string>
}
