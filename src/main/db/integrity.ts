import { getRawConnection } from './connection'
import { logger } from '../utils/logger'
import { AppError } from '../utils/errors'

/**
 * Run at every startup, before any window opens (Step 2 §6). Refuses
 * to proceed on a corrupt database rather than risk operating on it —
 * the caller should offer restore-from-backup instead (see
 * src/main/restore).
 */
export function runIntegrityCheck(): void {
  const raw = getRawConnection()

  const integrity = raw.pragma('integrity_check') as Array<{ integrity_check: string }>
  const ok = integrity.length === 1 && integrity[0]?.integrity_check === 'ok'
  if (!ok) {
    logger.error('SQLite integrity_check failed', integrity)
    throw new AppError('INTERNAL_ERROR', 'قاعدة البيانات تالفة. الرجاء استعادة نسخة احتياطية')
  }

  const violations = raw.pragma('foreign_key_check') as unknown[]
  if (violations.length > 0) {
    logger.error('SQLite foreign_key_check failed', violations)
    throw new AppError('INTERNAL_ERROR', 'تناقض في بيانات قاعدة البيانات. الرجاء استعادة نسخة احتياطية')
  }
}
