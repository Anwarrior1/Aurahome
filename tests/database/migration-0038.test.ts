import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

const folder = 'drizzle/migrations/'
function apply(db: Database.Database, file: string): void {
  for (const statement of readFileSync(folder + file, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }
}

/** Every migration up to and including 0038, against real legacy rows. */
function migratedDatabase(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const file of readdirSync(folder)
    .filter((f) => /^\d{4}.*\.sql$/.test(f) && f < '0038')
    .sort())
    apply(db, file)

  // Historical data that pre-dates the feature entirely.
  db.exec(`
    INSERT INTO customers (id,name) VALUES (1,'عميل قديم');
    INSERT INTO orders (id,document_number,customer_id,status,total_minor,paid_minor,remaining_minor,created_at)
      VALUES (42,'SO-HIST-42',1,'cancelled',10000000,3000000,7000000,'2025-01-01');
    INSERT INTO order_lines (id,order_id,line_kind,description,quantity_micro,unit_price_minor,line_total_minor)
      VALUES (90,42,'custom','خزانة قديمة',1000000,10000000,10000000);
    INSERT INTO final_invoices (id,document_number,customer_id,order_id,status,created_at)
      VALUES (17,'FI-HIST-17',1,42,'approved','2025-01-01');
    INSERT INTO final_invoice_lines (id,final_invoice_id,line_kind,description,quantity_micro,unit_price_minor,line_total_minor)
      VALUES (70,17,'custom','خزانة قديمة',1000000,10000000,10000000);
  `)
  apply(db, '0038_uncollected_products.sql')
  return db
}

describe('0038 uncollected products migration', () => {
  it('adds the feature without touching a single historical row', () => {
    const db = migratedDatabase()

    // Untouched history: the cancelled order, its item, its invoice.
    expect(db.prepare('SELECT * FROM orders WHERE id = 42').get()).toMatchObject({
      status: 'cancelled',
      total_minor: 10000000,
      paid_minor: 3000000,
      remaining_minor: 7000000
    })
    // The new columns exist and are NULL on every historical row — no
    // state is guessed for orders cancelled before the feature existed.
    expect(db.prepare('SELECT uncollected_product_id FROM order_lines WHERE id = 90').get()).toEqual({
      uncollected_product_id: null
    })
    expect(
      db.prepare('SELECT uncollected_product_id FROM final_invoice_lines WHERE id = 70').get()
    ).toEqual({ uncollected_product_id: null })
    // And nothing was back-filled into the new table.
    expect(db.prepare('SELECT COUNT(*) AS c FROM uncollected_products').get()).toEqual({ c: 0 })

    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('the database itself makes a duplicate transfer and a double sale impossible', () => {
    const db = migratedDatabase()
    const insert = `INSERT INTO uncollected_products
        (source_order_id,source_order_number,source_order_line_id,name,cost_basis_method,transferred_at)
      VALUES (42,'SO-HIST-42',90,'خزانة','sole_manufactured_item','2026-01-01')`

    db.exec(insert)
    // One physical manufactured item transfers exactly once, however
    // often cancellation is retried, replayed or double-clicked.
    expect(() => db.exec(insert)).toThrow(/UNIQUE/i)

    // And one physical product can be sold on at most one invoice line.
    db.exec('UPDATE final_invoice_lines SET uncollected_product_id = 1 WHERE id = 70')
    expect(() =>
      db.exec(
        `INSERT INTO final_invoice_lines (final_invoice_id,line_kind,description,quantity_micro,unit_price_minor,line_total_minor,uncollected_product_id)
         VALUES (17,'custom','بيع ثانٍ',1000000,5000000,5000000,1)`
      )
    ).toThrow(/UNIQUE/i)
    // The partial index still lets any number of ordinary lines exist.
    db.exec(
      `INSERT INTO final_invoice_lines (final_invoice_id,line_kind,description,quantity_micro,unit_price_minor,line_total_minor)
       VALUES (17,'custom','صنف عادي',1000000,1000,1000),
              (17,'custom','صنف عادي آخر',1000000,1000,1000)`
    )

    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  })

  it('has a new, strictly monotonic journal entry and a chained snapshot', () => {
    const journal = JSON.parse(readFileSync(folder + 'meta/_journal.json', 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    expect(journal.entries.find((entry) => entry.idx === 38)).toMatchObject({
      tag: '0038_uncollected_products'
    })
    // Strictly increasing, or the migrator silently skips the migration.
    journal.entries.forEach((entry, index) => {
      if (index) expect(entry.when).toBeGreaterThan(journal.entries[index - 1]!.when)
    })

    const previous = JSON.parse(readFileSync(folder + 'meta/0037_snapshot.json', 'utf8'))
    const current = JSON.parse(readFileSync(folder + 'meta/0038_snapshot.json', 'utf8'))
    expect(current.prevId).toBe(previous.id)
    expect(current.tables.uncollected_products).toBeDefined()
    expect(
      current.tables.uncollected_products.indexes.uncollected_products_source_line_uq.isUnique
    ).toBe(true)
    // The snapshot records ONLY this feature: no unrelated column was
    // quietly marked as already dropped.
    expect(Object.keys(current.tables.materials.columns).sort()).toEqual(
      Object.keys(previous.tables.materials.columns).sort()
    )
  })

  it('previously applied migrations were not edited', () => {
    // 0038 is additive: every earlier file must still be exactly the
    // file the already-migrated databases in the field have run.
    const earlier = readdirSync(folder).filter((f) => /^\d{4}.*\.sql$/.test(f) && f < '0038')
    expect(earlier).toHaveLength(38)
    for (const file of earlier) {
      expect(readFileSync(folder + file, 'utf8')).not.toContain('uncollected_product')
    }
  })
})
