import { sqliteTable, integer, text, unique } from 'drizzle-orm/sqlite-core'

/**
 * Backs BR-57 (prefix + year + sequence numbering, e.g. QT-2026-0001).
 * Shared by every document type across all 30 modules, so it lives in
 * the foundation rather than inside any single module's schema. The
 * sequence is allocated inside the same transaction that creates the
 * document (src/main/db/transactions.ts), never guessed client-side.
 */
export const documentSequences = sqliteTable(
  'document_sequences',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentType: text('document_type').notNull(), // e.g. 'QT', 'SO', 'MO'
    year: integer('year').notNull(),
    lastSequence: integer('last_sequence').notNull().default(0)
  },
  (table) => ({
    uniquePerTypeYear: unique().on(table.documentType, table.year)
  })
)
