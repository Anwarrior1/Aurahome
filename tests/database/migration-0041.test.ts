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

describe('0041 finished-goods valuation cutover migration', () => {
  it('adds only the prospective valuation structures and preserves historical rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finished-goods-migration-'))
    const oldFolder = join(dir, 'migrations')
    mkdirSync(join(oldFolder, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync(`${folder}meta/_journal.json`, 'utf8'))
    const previous = {
      ...journal,
      entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 41)
    }
    writeFileSync(join(oldFolder, 'meta/_journal.json'), JSON.stringify(previous))
    for (const file of readdirSync(folder).filter((file) => file.endsWith('.sql') && file < '0041')) {
      copyFileSync(`${folder}${file}`, join(oldFolder, file))
    }

    const raw = new Database(join(dir, 'upgrade.db'))
    raw.pragma('foreign_keys = ON')
    try {
      runMigrationsFromFolder(raw, oldFolder)
      raw.exec(`
        INSERT INTO products (id, code, name) VALUES (1, 'OLD-FG', 'Historical product');
        INSERT INTO customers (id, name) VALUES (1, 'Historical customer');
        INSERT INTO orders
          (id, document_number, customer_id, status, total_minor, paid_minor, remaining_minor, created_at)
        VALUES (1, 'SO-OLD', 1, 'completed', 300000, 0, 300000, '2026-01-01');
        INSERT INTO finished_goods_movements
          (id, product_id, kind, qty_micro, unit_cost_minor, total_cost_minor, created_at)
        VALUES (1, 1, 'production_in', 1000000, 10000, 10000, '2026-01-01');
        INSERT INTO finished_goods_movements
          (id, product_id, kind, qty_micro, unit_cost_minor, total_cost_minor, order_id, created_at)
        VALUES (2, 1, 'sale_out', 1000000, 10000, 10000, 1, '2026-01-02');
      `)
      const beforeRows = raw.prepare('SELECT * FROM finished_goods_movements ORDER BY id').all()
      const materialColumns = raw.pragma('table_info(materials)')

      runMigrationsFromFolder(raw, folder)

      expect(raw.prepare('SELECT id, product_id, kind, qty_micro, unit_cost_minor, total_cost_minor, work_sheet_id, order_id, notes, created_by, created_at FROM finished_goods_movements ORDER BY id').all())
        .toEqual(beforeRows)
      expect((raw.pragma('table_info(materials)') as Array<{ name: string }>).map((column) => column.name))
        .toEqual((materialColumns as Array<{ name: string }>).map((column) => column.name))
      expect(raw.pragma('table_info(finished_goods_movements)')).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'reversal_of_movement_id' })])
      )
      expect(
        raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='finished_goods_valuation_cutovers'").get()
      ).toEqual({ name: 'finished_goods_valuation_cutovers' })
      expect(
        raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='finished_goods_movements_reversal_unique'").get()
      ).toEqual({ name: 'finished_goods_movements_reversal_unique' })
      expect(raw.prepare('SELECT COUNT(*) AS c FROM finished_goods_valuation_cutovers').get()).toEqual({ c: 0 })
      expect(raw.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get()).toEqual({
        c: journal.entries.length
      })
      expect(raw.pragma('foreign_key_check')).toEqual([])
      expect(raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    } finally {
      raw.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves unrelated 0040 schema metadata and has monotonic journal identity', () => {
    const previous = JSON.parse(readFileSync(`${folder}meta/0040_snapshot.json`, 'utf8'))
    const current = JSON.parse(readFileSync(`${folder}meta/0041_snapshot.json`, 'utf8'))
    expect(current.prevId).toBe(previous.id)
    for (const name of Object.keys(previous.tables).filter((name) => name !== 'finished_goods_movements')) {
      if (name === 'finished_goods_valuation_cutovers') continue
      expect(current.tables[name]).toEqual(previous.tables[name])
    }
    expect(current.tables.finished_goods_valuation_cutovers).toBeTruthy()
    expect(current.tables.finished_goods_movements.columns.reversal_of_movement_id).toBeTruthy()
    const journal = JSON.parse(readFileSync(`${folder}meta/_journal.json`, 'utf8'))
    const entry = journal.entries.find((item: { idx: number }) => item.idx === 41)
    const priorEntry = journal.entries.find((item: { idx: number }) => item.idx === 40)
    expect(entry).toMatchObject({
      idx: 41,
      tag: '0041_bizarre_black_bolt'
    })
    expect(entry.when).toBeGreaterThan(priorEntry.when)
    expect(readFileSync(`${folder}0041_bizarre_black_bolt.sql`, 'utf8')).not.toMatch(
      /(^|\n)\s*(?:DROP|DELETE|UPDATE)\b/i
    )
  })
})
