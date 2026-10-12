/**
 * Persisted Exit Permit semantics.
 *
 * `delivery` historically meant the delivery/handover permit (تسليم),
 * while `installation` meant installation. Keep that persisted meaning:
 * the new `transport` value represents توصيل and
 * `delivery_installation` represents توصيل وتركيب. `handover` is retained
 * as a read-compatible alias for permits created by an earlier build.
 */
export const EXIT_PERMIT_KINDS = [
  'delivery',
  'installation',
  'transport',
  'delivery_installation'
] as const

export type IssuableExitPermitKind = (typeof EXIT_PERMIT_KINDS)[number]
export type ExitPermitKind = IssuableExitPermitKind | 'handover'

export const COMPLETION_KINDS = [
  'handover',
  'installation',
  'delivery',
  'delivery_installation'
] as const

export type CompletionKind = (typeof COMPLETION_KINDS)[number]

export const EXIT_PERMIT_LABEL: Record<ExitPermitKind, string> = {
  delivery: 'إذن تسليم',
  handover: 'إذن تسليم',
  installation: 'إذن تركيب',
  transport: 'إذن توصيل',
  delivery_installation: 'إذن توصيل وتركيب'
}

export const COMPLETION_LABEL: Record<CompletionKind, string> = {
  handover: 'تسليم',
  installation: 'تركيب',
  delivery: 'توصيل',
  delivery_installation: 'توصيل وتركيب'
}

export const COMPLETION_ACTION_LABEL: Record<CompletionKind, string> = {
  handover: 'تسجيل تسليم',
  installation: 'تسجيل تركيب',
  delivery: 'تسجيل توصيل',
  delivery_installation: 'تسجيل توصيل وتركيب'
}

export const COMPLETION_COST_LABEL: Record<CompletionKind, string> = {
  handover: 'التكلفة الفعلية للتسليم (د.ل)',
  installation: 'التكلفة الفعلية للتركيب (د.ل)',
  delivery: 'التكلفة الفعلية للتوصيل (د.ل)',
  delivery_installation: 'التكلفة الفعلية للتوصيل والتركيب (د.ل)'
}

const COMPLETION_FOR_PERMIT: Record<ExitPermitKind, CompletionKind> = {
  delivery: 'handover',
  handover: 'handover',
  installation: 'installation',
  transport: 'delivery',
  delivery_installation: 'delivery_installation'
}

export function completionKindForPermit(kind: ExitPermitKind): CompletionKind {
  return COMPLETION_FOR_PERMIT[kind]
}

export function isExitPermitKind(value: string): value is ExitPermitKind {
  return value === 'handover' || (EXIT_PERMIT_KINDS as readonly string[]).includes(value)
}

/**
 * Before completion events were linked to permits, the historical
 * `delivery` permit was completed by an unlinked `delivery` row. This
 * alias is read only: new registrations must use the exact resolver.
 */
export function legacyUnlinkedCompletionKindForPermit(
  kind: ExitPermitKind
): CompletionKind | null {
  return kind === 'delivery' ? 'delivery' : null
}

export function permitIncludesInstallation(kind: ExitPermitKind): boolean {
  return kind === 'installation' || kind === 'delivery_installation'
}
