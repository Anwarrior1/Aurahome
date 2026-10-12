/** Customer change 01: one rule for backend and UI. Timestamps survive a later cancel. */
export interface ManufacturingLifecycleState {
  status: string
  startedAt?: string | null
  completedAt?: string | null
}

export function manufacturingStarted(sheet: ManufacturingLifecycleState): boolean {
  return Boolean(sheet.startedAt || sheet.completedAt) || sheet.status === 'in_production' || sheet.status === 'completed'
}

/** The same predicate for set-based list queries over a `work_sheets` alias. Keep both in sync. */
export const manufacturingStartedSql = (alias: string): string =>
  `(${alias}.started_at IS NOT NULL OR ${alias}.completed_at IS NOT NULL OR ${alias}.status IN ('in_production', 'completed'))`

export const MANUFACTURING_STARTED_REVERSAL_MESSAGE = 'لا يمكن التراجع عن أمر التصنيع بعد بدء التصنيع'
export const PRODUCTION_PREP_LOCKED_MESSAGE = 'تجهيز الإنتاج مغلق بعد إنهاء التصنيع — البيانات للعرض فقط'
