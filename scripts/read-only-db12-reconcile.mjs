// DB-12 read-only reconciliation of an explicit database file (Node >= 23.6).
// Usage: node scripts/read-only-db12-reconcile.mjs /absolute/path/erp.db [sampleLimit]
import Database from 'better-sqlite3'
import { reconcileDatabase } from '../src/main/db/reconciliation.ts'

const path = process.argv[2]
if (!path) throw new Error('Explicit database path required')
const db = new Database(path, { readonly: true, fileMustExist: true })
try {
  const started = performance.now()
  const report = reconcileDatabase(db, { sampleLimit: Number(process.argv[3] ?? 20) })
  const elapsedMs = Math.round(performance.now() - started)
  const migrations = db.prepare('SELECT COUNT(*) AS count, MAX(created_at) AS head FROM __drizzle_migrations').get()
  console.log(JSON.stringify({
    path,
    readonly: db.readonly,
    migrations,
    integrity: db.pragma('integrity_check'),
    foreignKeyViolations: db.pragma('foreign_key_check').length,
    elapsedMs,
    ...report
  }, null, 2))
} finally {
  db.close()
}
