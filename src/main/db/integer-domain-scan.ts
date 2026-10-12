import type Database from 'better-sqlite3'

export interface IntegerDomainIssue {
  table: string
  column: string
  count: number
}

export interface IntegerDomainColumn {
  table: string
  column: string
}

export function isAuthoritativeIntegerDomainColumn(column: string): boolean {
  return /_(minor|micro|bp)$/.test(column) || column === 'discount_value'
}

export function listIntegerDomainColumns(raw: Database.Database): IntegerDomainColumn[] {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name").all() as { name: string }[]
  return tables.flatMap(({ name: table }) => {
    const columns = raw.pragma(`table_info('${table.replaceAll("'", "''")}')`) as { name: string; type: string }[]
    return columns
      .filter((column) => column.type.toUpperCase() === 'INTEGER' && isAuthoritativeIntegerDomainColumn(column.name))
      .map((column) => ({ table, column: column.name }))
  })
}

/** Read-only diagnostic: SQLite affinity does not guarantee integer storage. */
export function scanIntegerDomainStorage(raw: Database.Database): IntegerDomainIssue[] {
  const issues: IntegerDomainIssue[] = []
  for (const { table, column } of listIntegerDomainColumns(raw)) {
    const quotedTable = `"${table.replaceAll('"', '""')}"`
    const quotedColumn = `"${column.replaceAll('"', '""')}"`
    const row = raw.prepare(`SELECT COUNT(*) AS count FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL AND (typeof(${quotedColumn}) <> 'integer' OR ${quotedColumn} < -9007199254740991 OR ${quotedColumn} > 9007199254740991)`).get() as { count: number }
    if (row.count) issues.push({ table, column, count: row.count })
  }
  return issues
}
