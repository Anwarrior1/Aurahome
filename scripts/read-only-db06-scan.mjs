import Database from 'better-sqlite3'

const path = process.argv[2]
if (!path) throw new Error('Explicit database path required')
const db = new Database(path, { readonly: true, fileMustExist: true })
try {
  const issues = []
  let columnsScanned = 0
  const isBusinessInteger = (name) => /_(minor|micro|bp)$/.test(name) || name === 'discount_value'
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'").all()
  for (const table of tables) {
    const quote = (name) => `"${name.replaceAll('"', '""')}"`
    for (const column of db.pragma(`table_info(${quote(table.name)})`).filter((c) => c.type.toUpperCase() === 'INTEGER' && isBusinessInteger(c.name))) {
      columnsScanned++
      const name = quote(column.name)
      const count = db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table.name)} WHERE ${name} IS NOT NULL AND (typeof(${name}) <> 'integer' OR ${name} < -9007199254740991 OR ${name} > 9007199254740991)`).get().count
      if (count) issues.push({ table: table.name, column: column.name, count })
    }
  }
  console.log(JSON.stringify({ tablesScanned: tables.length, columnsScanned, issues,
    integrity: db.pragma('integrity_check'), foreignKeyViolations: db.pragma('foreign_key_check').length,
    lastMigration: db.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() }))
} finally {
  db.close()
}
