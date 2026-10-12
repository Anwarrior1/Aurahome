import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function applyFile(db: Database.Database, file: string): void {
  const source = readFileSync(join('drizzle/migrations', file), 'utf8')
  for (const statement of source.split('--> statement-breakpoint')) {
    const sql = statement.trim()
    if (sql) db.exec(sql)
  }
}

describe('Migration 0028 — normalized RBAC', () => {
  it('copies legacy effective access without granting sensitive permissions to future roles', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    const earlier = readdirSync('drizzle/migrations')
      .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0028')
      .sort()
    for (const file of earlier) applyFile(db, file)

    const roleId = Number(db.prepare("INSERT INTO roles (name) VALUES ('Legacy manager')").run().lastInsertRowid)
    for (const key of ['orders.view', 'orders.manage', 'costing.view', 'profit.view', 'purchases.manage', 'reports.view']) {
      db.prepare('INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)').run(roleId, key)
    }

    applyFile(db, '0028_normalized_rbac.sql')
    const grants = new Set((db.prepare(
      'SELECT permission_key AS key FROM role_permissions WHERE role_id = ?'
    ).all(roleId) as Array<{ key: string }>).map((row) => row.key))
    for (const key of [
      'dashboard.view', 'dashboard.viewOrders', 'dashboard.viewSales',
      'dashboard.viewCosts', 'dashboard.viewProfits',
      'orders.viewEstimatedCost', 'orders.viewExpectedProfit',
      'orders.viewActualCost', 'orders.viewActualProfit',
      'purchases.paySupplier', 'purchases.editSupplierPayment', 'purchases.deleteSupplierPayment',
      'deliveries.view', 'deliveries.register', 'deliveries.deleteOrReverse', 'reports.export'
    ]) expect(grants.has(key)).toBe(true)

    const newRoleId = Number(db.prepare("INSERT INTO roles (name) VALUES ('Future least privilege')").run().lastInsertRowid)
    expect(db.prepare('SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = ?').get(newRoleId))
      .toEqual({ c: 0 })
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })

  it('is the strictly increasing latest migration', () => {
    const journal = JSON.parse(readFileSync('drizzle/migrations/meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    const previous = journal.entries.find((entry) => entry.idx === 27)!
    const current = journal.entries.find((entry) => entry.idx === 28)!
    expect(current.when).toBeGreaterThan(previous.when)
    expect(current.tag).toBe('0028_normalized_rbac')
  })
})
