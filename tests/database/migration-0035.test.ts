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

describe('0035 payroll history visibility', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('upgrades a 0034 database without changing existing payroll or financial values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-migration-0035-'))
    dirs.push(dir)
    const db = new Database(join(dir, 'db.sqlite'))
    for (const file of readdirSync(folder)
      .filter((file) => /^\d{4}.*\.sql$/.test(file) && file < '0035')
      .sort())
      apply(db, file)
    db.exec(
      "INSERT INTO employees (id,name,monthly_salary_minor,active,created_at) VALUES (1,'موظف',1500000,1,'2026-09-01')"
    )
    db.exec(
      "INSERT INTO employee_transactions (id,employee_id,kind,amount_minor,paid_amount_minor,period_year,period_month,reversed_at,created_at) VALUES (1,1,'salary_payment',600000,600000,2026,9,'2026-09-11','2026-09-10')"
    )

    apply(db, '0035_payroll_history_visibility.sql')

    expect(
      db
        .prepare(
          'SELECT amount_minor, paid_amount_minor, reversed_at, history_hidden_at, history_hidden_by FROM employee_transactions WHERE id=1'
        )
        .get()
    ).toEqual({
      amount_minor: 600_000,
      paid_amount_minor: 600_000,
      reversed_at: '2026-09-11',
      history_hidden_at: null,
      history_hidden_by: null
    })
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('keeps its monotonic journal position', () => {
    const journal = JSON.parse(readFileSync(folder + 'meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    const current = journal.entries.find((entry) => entry.idx === 35)!
    const previous = journal.entries.find((entry) => entry.idx === 34)!
    expect(current).toMatchObject({ idx: 35, tag: '0035_payroll_history_visibility' })
    expect(current.when).toBeGreaterThan(previous.when)
  })
})
