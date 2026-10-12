import { and, asc, desc, eq, like, or, sql, type SQL } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { getDatabase } from '../../db/connection'

/**
 * A thin, typed persistence helper shared by the many master-data
 * tables (customers, suppliers, machines, workers, employees, …).
 *
 * It deliberately offers ONLY persistence concerns — insert, update,
 * fetch, filter. No business rule may be expressed through it; every
 * rule lives in the calling service, which is also what wraps these
 * calls in a transaction when more than one write is involved.
 */
export function createCrudRepository<TTable extends SQLiteTable & { id: never }>(table: TTable) {
  const t = table as unknown as SQLiteTable & Record<string, never>
  return {
    insert(values: Record<string, unknown>): number {
      const result = getDatabase()
        .insert(table)
        .values(values as never)
        .run()
      return Number(result.lastInsertRowid)
    },
    update(id: number, values: Record<string, unknown>): void {
      getDatabase()
        .update(table)
        .set(values as never)
        .where(eq(t['id'] as never, id))
        .run()
    },
    getById(id: number): Record<string, unknown> | undefined {
      return getDatabase()
        .select()
        .from(table)
        .where(eq(t['id'] as never, id))
        .get() as Record<string, unknown> | undefined
    },
    all(where?: SQL, orderByColumn?: string, direction: 'asc' | 'desc' = 'asc') {
      const column = orderByColumn ? (t[orderByColumn] as never) : undefined
      const query = getDatabase().select().from(table).where(where)
      const ordered = column
        ? query.orderBy(direction === 'asc' ? asc(column) : desc(column))
        : query
      return ordered.all() as Array<Record<string, unknown>>
    },
    deleteById(id: number): void {
      getDatabase()
        .delete(table)
        .where(eq(t['id'] as never, id))
        .run()
    },
    count(where?: SQL): number {
      const row = getDatabase()
        .get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM ${table} ${where ? sql`WHERE ${where}` : sql``}`)
      return row?.c ?? 0
    }
  }
}

/** Case-insensitive "contains" search across the given text columns. */
export function searchAcross(columns: unknown[], term?: string): SQL | undefined {
  if (!term?.trim()) return undefined
  const pattern = `%${term.trim()}%`
  const clauses = columns.map((c) => like(c as never, pattern))
  return clauses.length > 1 ? or(...clauses) : clauses[0]
}

export function allOf(...clauses: Array<SQL | undefined>): SQL | undefined {
  const present = clauses.filter((c): c is SQL => c !== undefined)
  if (present.length === 0) return undefined
  return present.length === 1 ? present[0] : and(...present)
}
