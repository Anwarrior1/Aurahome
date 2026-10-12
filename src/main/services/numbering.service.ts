import { sql } from 'drizzle-orm'
import { getDatabase } from '../db/connection'

/**
 * BR-57: prefix + year + sequence (QT-2026-0001), unique per type per
 * year, never reused. Allocated with an atomic UPSERT inside the same
 * transaction that creates the document, so two documents can never
 * receive the same number.
 */
export function nextDocumentNumber(documentType: string, year = new Date().getFullYear()): string {
  const db = getDatabase()
  const row = db
    .get<{ last_sequence: number }>(
      sql`INSERT INTO document_sequences (document_type, year, last_sequence)
          VALUES (${documentType}, ${year}, 1)
          ON CONFLICT(document_type, year)
          DO UPDATE SET last_sequence = last_sequence + 1
          RETURNING last_sequence`
    )
  const seq = row?.last_sequence ?? 1
  return `${documentType}-${year}-${String(seq).padStart(4, '0')}`
}
