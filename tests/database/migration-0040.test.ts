import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrationsFromFolder } from '@main/migrations/migration-runner'

const folder = 'drizzle/migrations/'
describe('0040 Uncollected Product resumption migration', () => {
  it('upgrades a persisted 0039 database without changing original order, payment, manufacturing, material columns or product state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-migration-'))
    const oldFolder = join(dir, 'migrations')
    mkdirSync(join(oldFolder, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(folder+'meta/_journal.json', 'utf8'))
    const previous = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 40) }
    writeFileSync(join(oldFolder, 'meta/_journal.json'), JSON.stringify(previous))
    for (const file of readdirSync(folder).filter(file => file.endsWith('.sql') && file < '0040')) copyFileSync(folder+file, join(oldFolder, file))
    const raw = new Database(join(dir, 'upgrade.db'))
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, oldFolder)
      raw.exec(`INSERT INTO customers (id,name) VALUES (1,'Original customer');
        INSERT INTO orders (id,document_number,customer_id,status,total_minor,paid_minor,remaining_minor,created_at) VALUES (42,'SO-42',1,'cancelled',9000000,5400000,3600000,'2026-01-01');
        INSERT INTO order_lines (id,order_id,line_kind,description,quantity_micro,unit_price_minor,line_total_minor) VALUES (43,42,'custom','Product',1000000,9000000,9000000);
        INSERT INTO customer_payments (order_id,customer_id,amount_minor,paid_at) VALUES (42,1,5400000,'2026-01-01');
        INSERT INTO work_sheets (id,document_number,order_id,status,issued_at) VALUES (44,'MO-44',42,'completed','2026-01-01');
        INSERT INTO uncollected_products (id,source_order_id,source_order_number,source_order_line_id,source_work_sheet_id,name,cost_basis_method,transferred_at) VALUES (45,42,'SO-42',43,44,'Product','sole_manufactured_item','2026-01-02');`)
      const tables = ['orders', 'order_lines', 'customer_payments', 'work_sheets']
      const rows = () => tables.map(table => raw.prepare(`SELECT * FROM ${table}`).all())
      const before = rows(), materialColumns = raw.pragma('table_info(materials)')
      runMigrationsFromFolder(raw, folder)
      expect(rows()).toEqual(before)
      expect((raw.pragma('table_info(materials)') as Array<{ name: string }>).map((column) => column.name))
        .toEqual((materialColumns as Array<{ name: string }>).map((column) => column.name))
      expect(raw.prepare('SELECT status, resumed_at, resumed_by, resume_request_key FROM uncollected_products WHERE id = 45').get()).toEqual({ status: 'available', resumed_at: null, resumed_by: null, resume_request_key: null })
      expect(raw.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get()).toEqual({ c: journal.entries.length })
      expect(raw.pragma('foreign_key_check')).toEqual([])
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally { raw.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('records only resumption fields/index and preserves the prior schema snapshot', () => {
    const old = JSON.parse(readFileSync(folder+'meta/0039_snapshot.json', 'utf8'))
    const current = JSON.parse(readFileSync(folder+'meta/0040_snapshot.json', 'utf8'))
    expect(current.prevId).toBe(old.id)
    for (const name of Object.keys(old.tables).filter(name => name !== 'uncollected_products')) expect(current.tables[name]).toEqual(old.tables[name])
    expect(current.tables.uncollected_products.indexes.uncollected_products_resume_request_uq.isUnique).toBe(true)
    const journal = JSON.parse(readFileSync(folder+'meta/_journal.json', 'utf8'))
    const entry = journal.entries.find((item: { idx: number }) => item.idx === 40)
    const previous = journal.entries.find((item: { idx: number }) => item.idx === 39)
    expect(entry).toMatchObject({ idx: 40, tag: '0040_uncollected_order_resume' })
    expect(entry.when).toBeGreaterThan(previous.when)
    expect(readFileSync(folder+'0040_uncollected_order_resume.sql', 'utf8')).not.toMatch(/DROP|DELETE|UPDATE/i)
  })
})
