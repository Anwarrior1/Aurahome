import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrationsFromFolder } from '@main/migrations/migration-runner'

const folder = 'drizzle/migrations/'

function previousMigrationFolder(dir: string): string {
  const oldFolder = join(dir, 'migrations')
  mkdirSync(join(oldFolder, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(`${folder}meta/_journal.json`, 'utf8'))
  writeFileSync(
    join(oldFolder, 'meta/_journal.json'),
    JSON.stringify({
      ...journal,
      entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 43)
    })
  )
  for (const file of readdirSync(folder).filter((file) => file.endsWith('.sql') && file < '0043')) {
    copyFileSync(`${folder}${file}`, join(oldFolder, file))
  }
  return oldFolder
}

describe('0043 DB-05 durable financial-command requests migration', () => {
  it('upgrades 0042 without changing or assigning identity to historical financial rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db05-migration-'))
    const oldFolder = previousMigrationFolder(dir)
    const raw = new Database(join(dir, 'upgrade.db'))
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, oldFolder)
      raw.exec(`
        INSERT INTO roles (id, name, is_admin) VALUES (101, 'Historical role', 1);
        INSERT INTO users (id, username, password_hash, full_name, role_id)
          VALUES (101, 'db05-history', 'hash', 'Historical actor', 101);
        INSERT INTO customers (id, name, created_at)
          VALUES (101, 'Historical customer', '2025-01-02T03:04:05.006Z');
        INSERT INTO orders
          (id, document_number, customer_id, status, total_minor, paid_minor, remaining_minor,
           payment_status, created_by, created_at)
          VALUES (101, 'SO-DB05-HISTORY', 101, 'confirmed', 500000, 100000, 400000,
                  'deposit_met', 101, '2025-01-03T03:04:05.006Z');
        INSERT INTO cash_accounts
          (id, name, kind, opening_balance_minor, created_at)
          VALUES (101, 'Historical cash', 'cash', 1000000, '2025-01-01T03:04:05.006Z');
        INSERT INTO customer_payments
          (id, order_id, customer_id, amount_minor, cash_account_id, paid_at, created_by, created_at)
          VALUES (101, 101, 101, 100000, 101, '2025-01-03', 101, '2025-01-03T03:04:05.006Z');
        INSERT INTO cash_transactions
          (id, account_id, direction, amount_minor, kind, ref_table, ref_id, occurred_at, created_by, created_at)
          VALUES (101, 101, 'in', 100000, 'customer_payment', 'customer_payments', 101,
                  '2025-01-03', 101, '2025-01-03T03:04:05.006Z');
        INSERT INTO expense_categories (id, name) VALUES (101, 'Historical expense');
        INSERT INTO expenses
          (id, category_id, kind, amount_minor, cash_account_id, description, spent_at, created_by, created_at)
          VALUES (101, 101, 'variable', 25000, 101, 'Historical expense', '2025-01-04', 101,
                  '2025-01-04T03:04:05.006Z');
      `)

      const historical = {
        orders: raw.prepare('SELECT * FROM orders WHERE id = 101').get(),
        payments: raw.prepare('SELECT * FROM customer_payments WHERE id = 101').get(),
        cash: raw.prepare('SELECT * FROM cash_transactions WHERE id = 101').get(),
        expenses: raw.prepare('SELECT * FROM expenses WHERE id = 101').get()
      }
      const materialColumns = raw.pragma('table_info(materials)')

      runMigrationsFromFolder(raw, folder)

      expect(raw.prepare('SELECT * FROM orders WHERE id = 101').get()).toEqual(historical.orders)
      expect(raw.prepare('SELECT * FROM customer_payments WHERE id = 101').get()).toEqual(
        historical.payments
      )
      expect(raw.prepare('SELECT * FROM cash_transactions WHERE id = 101').get()).toEqual(
        historical.cash
      )
      // 0052 (BL-03) appends one nullable link; the historical row is otherwise unchanged.
      expect(raw.prepare('SELECT * FROM expenses WHERE id = 101').get()).toEqual(
        { ...historical.expenses, uncollected_product_id: null }
      )
      expect(raw.pragma('table_info(materials)')).toEqual(materialColumns)
      expect(raw.prepare('SELECT COUNT(*) AS count FROM financial_command_requests').get()).toEqual(
        { count: 0 }
      )
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='financial_command_requests_scope_key_uq'"
          )
          .get()
      ).toEqual({ name: 'financial_command_requests_scope_key_uq' })
      expect(() =>
        raw
          .prepare(
            `
        INSERT INTO financial_command_requests
          (command_scope, request_key, payload_hash, result_json, created_by, created_at, completed_at)
        VALUES ('test', 'db05-test-key', 'hash', '{}', 101, 'CURRENT_TIMESTAMP', '2026-01-01T00:00:00.000Z')
      `
          )
          .run()
      ).toThrow(/DB-05 invalid literal timestamp/)
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(raw.pragma('foreign_key_check')).toEqual([])
    } finally {
      raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is an additive schema change with monotonic migration identity', () => {
    const previous = JSON.parse(readFileSync(`${folder}meta/0042_snapshot.json`, 'utf8'))
    const current = JSON.parse(readFileSync(`${folder}meta/0043_snapshot.json`, 'utf8'))
    expect(current.prevId).toBe(previous.id)
    for (const [name, table] of Object.entries(previous.tables)) {
      expect(current.tables[name]).toEqual(table)
    }
    expect(current.tables.financial_command_requests).toBeTruthy()

    const journal = JSON.parse(readFileSync(`${folder}meta/_journal.json`, 'utf8'))
    const entry = journal.entries.find((item: { idx: number }) => item.idx === 43)
    const prior = journal.entries.find((item: { idx: number }) => item.idx === 42)
    expect(entry).toMatchObject({ idx: 43, tag: '0043_db05_financial_command_requests' })
    expect(entry.when).toBeGreaterThan(prior.when)
    expect(readFileSync(`${folder}0043_db05_financial_command_requests.sql`, 'utf8')).not.toMatch(
      /(^|\n)\s*(?:DROP|DELETE|UPDATE|ALTER)\b/i
    )
  })
})
