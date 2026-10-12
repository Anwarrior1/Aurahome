import type { ExitPermitKind } from '@shared/production/exit-permit'

/**
 * BR-83/BR-112: all four Exit Permit operations share this shape.
 * The service must never build this DTO
 * Financial truth comes from the immutable issuance snapshot for new
 * permits. `legacy` means no new snapshot existed and preserves the
 * pre-migration read behaviour without inventing an unpaid override.
 */
export interface InternalReleaseDTO {
  reversed?: boolean
  kind: ExitPermitKind
  documentNumber: string
  orderNumber: string
  customerName: string
  items: string[]
  dimensions?: string
  materialType?: string
  colorCode?: string
  address?: string
  assignedWorkers: string[]
  notes?: string
  authorizationType: 'fully_paid' | 'unpaid' | 'unpaid_override' | 'legacy'
  balanceConfirmedPaid: boolean
  showPaidExitSentence: boolean
  orderTotalAtIssue?: string
  paidAtIssue?: string
  remainingAtIssue?: string
  authorizedAt: string
}
