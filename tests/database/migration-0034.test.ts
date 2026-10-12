import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const folder = 'drizzle/migrations/'
const apply = (db: Database.Database, file: string) => {
  for (const statement of readFileSync(folder + file, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }
}

describe('0034 payroll payment reversal state', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('upgrades a 0033 database without rewriting existing payroll values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-migration-0034-')); dirs.push(dir)
    const db = new Database(join(dir, 'db.sqlite'))
    for (const file of readdirSync(folder).filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0034').sort()) apply(db, file)
    db.exec("INSERT INTO employees (id,name,monthly_salary_minor,active,created_at) VALUES (1,'موظف',1500000,1,'2026-09-01')")
    db.exec("INSERT INTO employee_transactions (id,employee_id,kind,amount_minor,period_year,period_month,created_at) VALUES (1,1,'salary_payment',1000000,2026,9,'2026-09-10')")

    apply(db, '0034_payroll_payment_reversal.sql')

    const row = db.prepare('SELECT amount_minor, paid_amount_minor, reversed_at, reversed_by FROM employee_transactions WHERE id=1').get()
    expect(row).toEqual({ amount_minor: 1_000_000, paid_amount_minor: null, reversed_at: null, reversed_by: null })
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('is a monotonic journal entry', () => {
    const journal = JSON.parse(readFileSync(folder + 'meta/_journal.json', 'utf8')) as { entries: Array<{ idx: number; when: number; tag: string }> }
    const entry = journal.entries.find((item) => item.idx === 34)!
    const previous = journal.entries.find((item) => item.idx === 33)!
    expect(entry).toMatchObject({ idx: 34, tag: '0034_payroll_payment_reversal' })
    expect(entry.when).toBeGreaterThan(previous.when)
  })
})
